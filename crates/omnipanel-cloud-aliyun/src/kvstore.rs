//! 云数据库 Redis / Tair。

use std::collections::BTreeMap;

use chrono::{TimeZone, Utc};
use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::{json_list, json_total_count, str_field, AliyunCredentials};
use crate::types::{
    clamp_aliyun_slow_log_page_size, clamp_aliyun_slow_log_window, CloudAction, CloudLogEntry,
    CloudLogPage, CloudLogQuery,
    CloudNetworkRule,
};

#[derive(Debug, Clone, Default)]
pub struct CloudKvInstance {
    pub instance_id: String,
    pub name: String,
    pub status: String,
    pub engine: String,
    pub engine_version: String,
    pub instance_class: String,
    pub region_id: String,
    pub zone: String,
    pub connection_string: String,
    pub port: String,
    pub vpc_id: String,
    pub charge_type: String,
    pub expired_time: String,
    pub capacity: String,
}

fn parse_kv_slow_ts(raw: &str) -> i64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%SZ")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%MZ"))
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S"))
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0)
}

fn endpoint(region: &str) -> Result<String, OmniError> {
    let region = region.trim();
    if region.is_empty() {
        return Err(OmniError::invalid_input("请先配置 Region"));
    }
    Ok(format!("https://r-kvstore.{region}.aliyuncs.com/"))
}

fn parse_kv(item: &Value, region: &str) -> CloudKvInstance {
    CloudKvInstance {
        instance_id: str_field(item, &["InstanceId"]),
        name: str_field(item, &["InstanceName", "InstanceId"]),
        status: str_field(item, &["InstanceStatus"]),
        engine: str_field(item, &["InstanceType", "ArchitectureType"]),
        engine_version: str_field(item, &["EngineVersion"]),
        instance_class: str_field(item, &["InstanceClass"]),
        region_id: {
            let id = str_field(item, &["RegionId"]);
            if id.is_empty() {
                region.to_string()
            } else {
                id
            }
        },
        zone: str_field(item, &["ZoneId"]),
        connection_string: str_field(item, &["ConnectionDomain"]),
        port: str_field(item, &["Port"]),
        vpc_id: str_field(item, &["VpcId"]),
        charge_type: str_field(item, &["ChargeType"]),
        expired_time: str_field(item, &["EndTime"]),
        capacity: str_field(item, &["Capacity"]),
    }
}

fn parse_whitelist(body: &Value) -> Vec<CloudNetworkRule> {
    json_list(body, "SecurityIpGroups", "SecurityIpGroup")
        .iter()
        .flat_map(|item| {
            let group = str_field(item, &["SecurityIpGroupName"]);
            str_field(item, &["SecurityIpList"])
                .split(',')
                .map(|ip| ip.trim().to_string())
                .filter(|ip| !ip.is_empty())
                .map(|ip| CloudNetworkRule {
                    id: format!("{group}:{ip}"),
                    direction: "ingress".into(),
                    protocol: "all".into(),
                    port_range: "ALL".into(),
                    cidr: ip,
                    source_group_id: String::new(),
                    policy: "accept".into(),
                    priority: String::new(),
                    nic_type: group.clone(),
                    description: group.clone(),
                })
                .collect::<Vec<_>>()
        })
        .collect()
}

impl AliyunCredentials {
    pub async fn list_kv_instances(&self, http: &Client) -> Result<Vec<CloudKvInstance>, OmniError> {
        let region = self.region.trim();
        let endpoint = endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "50".into());
            let body = self
                .rpc_call(http, &endpoint, "2015-01-01", "DescribeInstances", params)
                .await?;
            let items = json_list(&body, "Instances", "KVStoreInstance");
            let count = items.len();
            out.extend(items.iter().map(|item| parse_kv(item, region)));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn get_kv_instance(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<CloudKvInstance, OmniError> {
        let region = self.region.trim();
        let endpoint = endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("InstanceId".into(), instance_id.trim().to_string());
        let body = self
            .rpc_call(http, &endpoint, "2015-01-01", "DescribeInstanceAttribute", params)
            .await?;
        let items = json_list(&body, "Instances", "DBInstanceAttribute");
        let fallback = json_list(&body, "Instances", "KVStoreInstance");
        items
            .first()
            .or(fallback.first())
            .map(|item| parse_kv(item, region))
            .ok_or_else(|| OmniError::not_found(format!("未找到 Redis: {instance_id}")))
    }

    pub async fn list_kv_whitelist(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudNetworkRule>, OmniError> {
        let region = self.region.trim();
        let endpoint = endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("InstanceId".into(), instance_id.trim().to_string());
        let body = self
            .rpc_call(http, &endpoint, "2015-01-01", "DescribeSecurityIps", params)
            .await?;
        Ok(parse_whitelist(&body))
    }

    pub async fn kv_instance_action(
        &self,
        http: &Client,
        action: &str,
        instance_id: &str,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("InstanceId".into(), instance_id.trim().to_string());
        let _ = self
            .rpc_call(http, &endpoint, "2015-01-01", action, params)
            .await?;
        Ok(())
    }

    pub async fn modify_kv_whitelist(
        &self,
        http: &Client,
        action: &CloudAction,
        mode: &str,
    ) -> Result<(), OmniError> {
        let cidr = action.param("cidr");
        if cidr.is_empty() {
            return Err(OmniError::invalid_input("请填写 CIDR / IP"));
        }
        let region = self.region.trim();
        let endpoint = endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("InstanceId".into(), action.resource_id.trim().to_string());
        params.insert(
            "SecurityIpGroupName".into(),
            if action.param("nicType").is_empty() {
                "default".into()
            } else {
                action.param("nicType")
            },
        );
        params.insert("SecurityIps".into(), cidr);
        params.insert("ModifyMode".into(), mode.to_string());
        let _ = self
            .rpc_call(http, &endpoint, "2015-01-01", "ModifySecurityIps", params)
            .await?;
        Ok(())
    }

    pub async fn query_kv_slow_logs(
        &self,
        http: &Client,
        instance_id: &str,
        query: &CloudLogQuery,
    ) -> Result<CloudLogPage, OmniError> {
        let region = self.region.trim();
        let endpoint = endpoint(region)?;
        let now = Utc::now().timestamp_millis();
        let (start_ms, end_ms) = clamp_aliyun_slow_log_window(query.start_ms, query.end_ms, now);
        let page = if query.page > 0 { query.page } else { 1 };
        let page_size = clamp_aliyun_slow_log_page_size(query.page_size);
        let mut params = BTreeMap::new();
        params.insert("InstanceId".into(), instance_id.trim().to_string());
        params.insert(
            "StartTime".into(),
            Utc.timestamp_millis_opt(start_ms)
                .single()
                .map(|dt| dt.format("%Y-%m-%dT%H:%MZ").to_string())
                .unwrap_or_default(),
        );
        params.insert(
            "EndTime".into(),
            Utc.timestamp_millis_opt(end_ms)
                .single()
                .map(|dt| dt.format("%Y-%m-%dT%H:%MZ").to_string())
                .unwrap_or_default(),
        );
        params.insert("PageNumber".into(), page.to_string());
        params.insert("PageSize".into(), page_size.to_string());
        if let Some(db) = query.trimmed_db_name() {
            params.insert("DBName".into(), db.to_string());
        }
        if let Some(keyword) = query.trimmed_keyword() {
            params.insert("QueryKeyword".into(), keyword.to_string());
        }
        params.insert("OrderBy".into(), query.redis_order_by().into());
        params.insert("OrderType".into(), query.redis_order_type().into());
        let body = self
            .rpc_call(http, &endpoint, "2015-01-01", "DescribeSlowLogRecords", params)
            .await?;
        let entries = json_list(&body, "Items", "Log")
            .into_iter()
            .enumerate()
            .map(|(index, item)| {
                let exec = str_field(&item, &["ExecuteTime", "StartTime"]);
                let node = str_field(&item, &["NodeId"]);
                CloudLogEntry {
                    id: format!("{node}:{exec}:{index}"),
                    ts_ms: parse_kv_slow_ts(&exec),
                    severity: "slow".into(),
                    summary: str_field(&item, &["Command"]),
                    fields: [
                        ("queryTimes", str_field(&item, &["ElapsedTime"])),
                        ("host", str_field(&item, &["Account", "IPAddress"])),
                        ("sql", str_field(&item, &["Command"])),
                        ("db", str_field(&item, &["DBName", "DataBaseName"])),
                    ]
                    .into_iter()
                    .filter(|(_, v)| !v.is_empty())
                    .map(|(k, v)| (k.to_string(), v))
                    .collect(),
                }
            })
            .collect();
        Ok(CloudLogPage {
            kind: "slow".into(),
            total: json_total_count(&body) as i64,
            page,
            entries,
        })
    }
}
