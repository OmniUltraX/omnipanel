//! 云数据库 RDS：实例、白名单、慢日志。

use std::collections::BTreeMap;

use chrono::{TimeZone, Utc};
use omnipanel_error::OmniError;
use reqwest::Client;
use serde_json::Value;

use crate::client::{json_list, json_total_count, str_field, AliyunCredentials};
use crate::types::{
    clamp_aliyun_slow_log_page_size, clamp_aliyun_slow_log_window, CloudAction, CloudChildRow,
    CloudLogEntry, CloudLogPage,
    CloudLogQuery, CloudNetworkRule,
};

#[derive(Debug, Clone, Default)]
pub struct CloudRdsInstance {
    pub instance_id: String,
    pub name: String,
    pub status: String,
    pub engine: String,
    pub engine_version: String,
    pub instance_class: String,
    pub storage: String,
    pub region_id: String,
    pub zone: String,
    pub connection_string: String,
    pub port: String,
    pub vpc_id: String,
    pub charge_type: String,
    pub expired_time: String,
    pub network_type: String,
}

fn rds_endpoint(region: &str) -> Result<String, OmniError> {
    let region = region.trim();
    if region.is_empty() {
        return Err(OmniError::invalid_input("请先配置 Region"));
    }
    Ok(format!("https://rds.{region}.aliyuncs.com/"))
}

fn parse_rds(item: &Value, region: &str) -> CloudRdsInstance {
    CloudRdsInstance {
        instance_id: str_field(item, &["DBInstanceId"]),
        name: str_field(item, &["DBInstanceDescription", "DBInstanceId"]),
        status: str_field(item, &["DBInstanceStatus"]),
        engine: str_field(item, &["Engine"]),
        engine_version: str_field(item, &["EngineVersion"]),
        instance_class: str_field(item, &["DBInstanceClass"]),
        storage: str_field(item, &["DBInstanceStorage"]),
        region_id: {
            let id = str_field(item, &["RegionId"]);
            if id.is_empty() {
                region.to_string()
            } else {
                id
            }
        },
        zone: str_field(item, &["ZoneId"]),
        connection_string: str_field(item, &["ConnectionString"]),
        port: str_field(item, &["Port"]),
        vpc_id: str_field(item, &["VpcId"]),
        charge_type: str_field(item, &["PayType", "DBInstanceChargeType"]),
        expired_time: str_field(item, &["ExpireTime"]),
        network_type: str_field(item, &["InstanceNetworkType"]),
    }
}

fn parse_whitelist_rules(body: &Value) -> Vec<CloudNetworkRule> {
    json_list(body, "Items", "DBInstanceIPArray")
        .iter()
        .flat_map(|item| {
            let group = str_field(item, &["DBInstanceIPArrayName"]);
            let ips = str_field(item, &["SecurityIPList"]);
            ips.split(',')
                .map(|ip| ip.trim())
                .filter(|ip| !ip.is_empty())
                .map(|ip| CloudNetworkRule {
                    id: format!("{group}:{ip}"),
                    direction: "ingress".into(),
                    protocol: "all".into(),
                    port_range: "ALL".into(),
                    cidr: ip.to_string(),
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

/// `DescribeSlowLogRecords` 要求 UTC `yyyy-MM-ddTHH:mmZ`。
/// `yyyy-MM-ddZ` 是按日汇总的 `DescribeSlowLogs`，拿来查明细会 InvalidStartTime.Malformed。
fn format_rds_slow_log_time(ms: i64) -> String {
    Utc.timestamp_millis_opt(ms)
        .single()
        .map(|dt| dt.format("%Y-%m-%dT%H:%MZ").to_string())
        .unwrap_or_else(|| "1970-01-01T00:00Z".into())
}

fn parse_slow_ts(raw: &str) -> i64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%SZ")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S"))
        .ok()
        .map(|dt| dt.and_utc().timestamp_millis())
        .unwrap_or(0)
}

impl AliyunCredentials {
    pub async fn list_rds_instances(&self, http: &Client) -> Result<Vec<CloudRdsInstance>, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut out = Vec::new();
        let mut page: u32 = 1;
        loop {
            let mut params = BTreeMap::new();
            params.insert("RegionId".into(), region.to_string());
            params.insert("PageNumber".into(), page.to_string());
            params.insert("PageSize".into(), "100".into());
            let body = self
                .rpc_call(http, &endpoint, "2014-08-15", "DescribeDBInstances", params)
                .await?;
            let items = json_list(&body, "Items", "DBInstance");
            let count = items.len();
            out.extend(items.iter().map(|item| parse_rds(item, region)));
            let total = json_total_count(&body);
            if count == 0 || (total > 0 && out.len() as u64 >= total) || page >= 20 {
                break;
            }
            page += 1;
        }
        Ok(out)
    }

    pub async fn get_rds_instance(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<CloudRdsInstance, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("RegionId".into(), region.to_string());
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        let body = self
            .rpc_call(
                http,
                &endpoint,
                "2014-08-15",
                "DescribeDBInstanceAttribute",
                params,
            )
            .await?;
        let items = json_list(&body, "Items", "DBInstanceAttribute");
        let fallback = json_list(&body, "Items", "DBInstance");
        items
            .first()
            .or(fallback.first())
            .map(|item| parse_rds(item, region))
            .ok_or_else(|| OmniError::not_found(format!("未找到 RDS: {instance_id}")))
    }

    pub async fn list_rds_whitelist(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudNetworkRule>, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        let body = self
            .rpc_call(
                http,
                &endpoint,
                "2014-08-15",
                "DescribeDBInstanceIPArrayList",
                params,
            )
            .await?;
        Ok(parse_whitelist_rules(&body))
    }

    pub async fn rds_instance_action(
        &self,
        http: &Client,
        action: &str,
        instance_id: &str,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        let _ = self
            .rpc_call(http, &endpoint, "2014-08-15", action, params)
            .await?;
        Ok(())
    }

    pub async fn authorize_rds_whitelist(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let cidr = action.param("cidr");
        if cidr.is_empty() {
            return Err(OmniError::invalid_input("请填写 CIDR / IP"));
        }
        self.modify_rds_whitelist(http, &action.resource_id, &action.param("nicType"), "Append", &cidr)
            .await
    }

    pub async fn revoke_rds_whitelist(
        &self,
        http: &Client,
        action: &CloudAction,
    ) -> Result<(), OmniError> {
        let cidr = action.param("cidr");
        if cidr.is_empty() {
            return Err(OmniError::invalid_input("缺少要删除的 IP"));
        }
        self.modify_rds_whitelist(http, &action.resource_id, &action.param("nicType"), "Delete", &cidr)
            .await
    }

    async fn modify_rds_whitelist(
        &self,
        http: &Client,
        instance_id: &str,
        group: &str,
        modify_mode: &str,
        ips: &str,
    ) -> Result<(), OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        params.insert(
            "DBInstanceIPArrayName".into(),
            if group.trim().is_empty() {
                "default".into()
            } else {
                group.trim().to_string()
            },
        );
        params.insert("SecurityIps".into(), ips.trim().to_string());
        params.insert("ModifyMode".into(), modify_mode.to_string());
        let _ = self
            .rpc_call(http, &endpoint, "2014-08-15", "ModifySecurityIps", params)
            .await?;
        Ok(())
    }

    pub async fn query_rds_slow_logs(
        &self,
        http: &Client,
        instance_id: &str,
        query: &CloudLogQuery,
    ) -> Result<CloudLogPage, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let now = Utc::now().timestamp_millis();
        let (start_ms, end_ms) = clamp_aliyun_slow_log_window(query.start_ms, query.end_ms, now);
        let page = if query.page > 0 { query.page } else { 1 };
        let page_size = clamp_aliyun_slow_log_page_size(query.page_size);
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        params.insert("StartTime".into(), format_rds_slow_log_time(start_ms));
        params.insert("EndTime".into(), format_rds_slow_log_time(end_ms));
        params.insert("PageNumber".into(), page.to_string());
        params.insert("PageSize".into(), page_size.to_string());
        if let Some(db) = query.trimmed_db_name() {
            params.insert("DBName".into(), db.to_string());
        }
        let body = self
            .rpc_call(http, &endpoint, "2014-08-15", "DescribeSlowLogRecords", params)
            .await?;
        let items = json_list(&body, "Items", "SQLSlowRecord");
        let entries = items
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let sql = str_field(item, &["SQLText"]);
                let exec = str_field(item, &["ExecutionStartTime"]);
                let hash = str_field(item, &["SQLHASH", "SQLHash"]);
                CloudLogEntry {
                    id: format!("{hash}:{exec}:{index}"),
                    ts_ms: parse_slow_ts(&exec),
                    severity: "slow".into(),
                    summary: sql.chars().take(240).collect(),
                    fields: [
                        ("host", str_field(item, &["HostAddress"])),
                        ("db", str_field(item, &["DBName"])),
                        ("queryTimes", str_field(item, &["QueryTimes"])),
                        ("lockTimes", str_field(item, &["LockTimes"])),
                        ("returnRows", str_field(item, &["ReturnRowCounts"])),
                        ("parseRows", str_field(item, &["ParseRowCounts"])),
                        ("sql", sql),
                    ]
                    .into_iter()
                    .filter(|(_, v)| !v.is_empty())
                    .map(|(k, v)| (k.to_string(), v))
                    .collect(),
                }
            })
            .collect();
        let total = json_total_count(&body) as i64;
        Ok(CloudLogPage {
            kind: "slow".into(),
            total,
            page,
            entries,
        })
    }

    pub async fn list_rds_children(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let mut out = Vec::new();
        if let Ok(rows) = self.list_rds_databases(http, instance_id).await {
            out.extend(rows);
        }
        if let Ok(rows) = self.list_rds_accounts(http, instance_id).await {
            out.extend(rows);
        }
        if let Ok(rows) = self.list_rds_parameters(http, instance_id).await {
            out.extend(rows);
        }
        if let Ok(rows) = self.list_rds_backups(http, instance_id).await {
            out.extend(rows);
        }
        Ok(out)
    }

    async fn list_rds_databases(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        params.insert("PageSize".into(), "100".into());
        let body = self
            .rpc_call(http, &endpoint, "2014-08-15", "DescribeDatabases", params)
            .await?;
        Ok(json_list(&body, "Databases", "Database")
            .iter()
            .map(|item| CloudChildRow {
                id: str_field(item, &["DBName"]),
                kind: "database".into(),
                name: str_field(item, &["DBName"]),
                status: str_field(item, &["DBStatus"]),
                fields: child_fields(&[
                    ("engine", str_field(item, &["Engine"])),
                    ("charset", str_field(item, &["CharacterSetName"])),
                ]),
            })
            .filter(|row| !row.id.trim().is_empty())
            .collect())
    }

    async fn list_rds_accounts(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        params.insert("PageSize".into(), "50".into());
        let body = self
            .rpc_call(http, &endpoint, "2014-08-15", "DescribeAccounts", params)
            .await?;
        Ok(json_list(&body, "Accounts", "DBInstanceAccount")
            .iter()
            .map(|item| CloudChildRow {
                id: str_field(item, &["AccountName"]),
                kind: "account".into(),
                name: str_field(item, &["AccountName"]),
                status: str_field(item, &["AccountStatus"]),
                fields: child_fields(&[
                    ("type", str_field(item, &["AccountType"])),
                    ("description", str_field(item, &["AccountDescription"])),
                    ("priv", str_field(item, &["PrivExceeded"])),
                ]),
            })
            .collect())
    }

    async fn list_rds_parameters(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        let body = self
            .rpc_call(http, &endpoint, "2014-08-15", "DescribeParameters", params)
            .await?;
        let running = json_list(&body, "RunningParameters", "DBInstanceParameter");
        let config = json_list(&body, "ConfigParameters", "DBInstanceParameter");
        Ok(running
            .iter()
            .chain(config.iter())
            .take(80)
            .map(|item| CloudChildRow {
                id: str_field(item, &["ParameterName"]),
                kind: "parameter".into(),
                name: str_field(item, &["ParameterName"]),
                status: str_field(item, &["ParameterValue"]),
                fields: child_fields(&[
                    ("value", str_field(item, &["ParameterValue"])),
                    ("default", str_field(item, &["ParameterDefaultValue", "DefaultValue"])),
                    ("description", str_field(item, &["ParameterDescription"])),
                ]),
            })
            .collect())
    }

    async fn list_rds_backups(
        &self,
        http: &Client,
        instance_id: &str,
    ) -> Result<Vec<CloudChildRow>, OmniError> {
        let region = self.region.trim();
        let endpoint = rds_endpoint(region)?;
        let mut params = BTreeMap::new();
        params.insert("DBInstanceId".into(), instance_id.trim().to_string());
        params.insert("PageSize".into(), "30".into());
        let body = self
            .rpc_call(http, &endpoint, "2014-08-15", "DescribeBackups", params)
            .await?;
        Ok(json_list(&body, "Items", "Backup")
            .iter()
            .map(|item| CloudChildRow {
                id: str_field(item, &["BackupId"]),
                kind: "backup".into(),
                name: str_field(item, &["BackupId"]),
                status: str_field(item, &["BackupStatus"]),
                fields: child_fields(&[
                    ("type", str_field(item, &["BackupType"])),
                    ("method", str_field(item, &["BackupMethod"])),
                    ("startTime", str_field(item, &["BackupStartTime"])),
                    ("endTime", str_field(item, &["BackupEndTime"])),
                    ("size", str_field(item, &["BackupSize"])),
                ]),
            })
            .collect())
    }
}

fn child_fields(pairs: &[(&str, String)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .filter(|(_, v)| !v.trim().is_empty())
        .map(|(k, v)| ((*k).to_string(), v.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn whitelist_splits_ips() {
        let body = json!({
            "Items": {
                "DBInstanceIPArray": [{
                    "DBInstanceIPArrayName": "default",
                    "SecurityIPList": "127.0.0.1,192.168.1.0/24"
                }]
            }
        });
        let rules = parse_whitelist_rules(&body);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[1].cidr, "192.168.1.0/24");
        assert_eq!(rules[0].nic_type, "default");
    }

    #[test]
    fn redis_sort_maps_duration_to_latency() {
        let query = CloudLogQuery {
            sort_key: "duration".into(),
            sort_dir: "asc".into(),
            ..CloudLogQuery::default()
        };
        assert_eq!(query.redis_order_by(), "latency");
        assert_eq!(query.redis_order_type(), "ASC");
    }

    #[test]
    fn slow_log_window_clamps_span_and_seconds() {
        let now = 1_725_278_400_000;
        let (start, end) =
            clamp_aliyun_slow_log_window(now - 40 * 24 * 3600_000, now + 60_000, now);
        assert_eq!(end, now);
        assert_eq!(end - start, crate::types::ALIYUN_SLOW_LOG_MAX_SPAN_MS);
        let (from_sec, _) = clamp_aliyun_slow_log_window(1_725_278_400, now, now);
        assert_eq!(from_sec, now - 3600_000);
    }

    #[test]
    fn slow_log_time_uses_utc_minute_iso() {
        assert_eq!(
            format_rds_slow_log_time(1_725_278_400_000),
            "2024-09-02T12:00Z"
        );
        assert!(!format_rds_slow_log_time(1_725_278_400_000).ends_with("dZ"));
    }

    #[test]
    fn slow_log_page_size_snaps_to_aliyun() {
        assert_eq!(clamp_aliyun_slow_log_page_size(0), 30);
        assert_eq!(clamp_aliyun_slow_log_page_size(20), 30);
        assert_eq!(clamp_aliyun_slow_log_page_size(30), 30);
        assert_eq!(clamp_aliyun_slow_log_page_size(50), 50);
        assert_eq!(clamp_aliyun_slow_log_page_size(100), 100);
        assert_eq!(clamp_aliyun_slow_log_page_size(200), 100);
    }
}
