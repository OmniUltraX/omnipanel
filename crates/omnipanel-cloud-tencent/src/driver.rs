use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_cloud_aliyun::{
    AliyunCredentials, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudLogPage,
    CloudLogQuery, CloudMetricQuery, CloudMetricSeries, CloudProviderDriver, CloudRegion,
    CloudResourceDetail, CloudResourceFilter, CloudResourceRow, ACTION_ADD_RECORD, ACTION_ATTACH,
    ACTION_AUTHORIZE_RULE, ACTION_CREATE_SNAPSHOT, ACTION_DELETE_RECORD, ACTION_DETACH,
    ACTION_MODIFY_BANDWIDTH, ACTION_REBOOT, ACTION_REVOKE_RULE, ACTION_START, ACTION_STOP,
    ACTION_UPDATE_RECORD, CAP_CERTS, CAP_COMPUTE, CAP_COMPUTE_LITE, CAP_DATABASE,
    CAP_DATABASE_CACHE, CAP_DNS, CAP_DOMAINS, CAP_LOAD_BALANCER, CAP_NETWORK_EIP,
    CAP_OBJECT_STORAGE, CAP_SECURITY_GROUP, CAP_STORAGE_DISK,
};
use omnipanel_error::OmniError;
use reqwest::Client;
use tokio::sync::Semaphore;

use crate::client::{
    associate_address, associate_cvm_security_groups, attach_disks, cdb_instance_action,
    create_snapshot, cvm_instance_action, describe_account_balance, describe_addresses,
    describe_cdb_instances, describe_cdb_security_groups, describe_cdb_slow_logs,
    describe_certificates, describe_clb_listeners, describe_clb_targets, describe_cvm_instances,
    describe_disks, describe_dnspod_domains, describe_dnspod_records,
    describe_lighthouse_firewall_rules, describe_lighthouse_instances, describe_load_balancers,
    describe_redis_instances, describe_redis_slow_log, describe_regions,
    describe_registered_domains, describe_security_group_policies, describe_security_groups,
    describe_snapshots, get_monitor_data, get_user_app_id, lighthouse_instance_action, list_cos_buckets,
    modify_address_bandwidth, modify_cdb_security_groups, modify_lighthouse_firewall,
    modify_security_group_policies, mutate_dnspod_record, redis_restart, region_or_default, jstr,
};
use crate::mapping::{
    attach_instance_disks, attach_snapshots, cdb_to_detail, cert_to_detail, cos_to_detail,
    cvm_to_detail, default_metric_ids, disk_to_detail, domain_detail, eip_to_detail,
    lb_to_detail, lighthouse_to_detail, map_account_balance_fields, map_cdb_row, map_cdb_sg_rule,
    map_cert_row, map_cos_row, map_cvm_row, map_disk_row, map_dns_record, map_eip_row,
    map_firewall_rule, map_lb_row, map_lighthouse_row, map_redis_row, map_region_row, map_sg_row,
    map_snapshot_child, merge_domain_rows, monitor_dimension, monitor_namespace, monitor_series,
    parse_slow_log_page, redis_to_detail, sg_policies_from_set, sg_to_detail, tencent_metric_name,
};
use crate::DEFAULT_REGION;

#[derive(Debug, Clone, Copy, Default)]
pub struct TencentCloudDriver;

fn apply_row_filter(mut rows: Vec<CloudResourceRow>, filter: &CloudResourceFilter) -> Vec<CloudResourceRow> {
    if let Some(status) = filter.status.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        rows.retain(|row| row.status.eq_ignore_ascii_case(status));
    }
    if let Some(query) = filter.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let q = query.to_ascii_lowercase();
        rows.retain(|row| {
            row.name.to_ascii_lowercase().contains(&q)
                || row.id.to_ascii_lowercase().contains(&q)
                || row
                    .fields
                    .values()
                    .any(|v| v.to_ascii_lowercase().contains(&q))
        });
    }
    rows
}

fn unique_regions(ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for id in ids {
        let id = id.trim().to_string();
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        out.push(id);
    }
    out
}

fn regions_to_scan(creds: &AliyunCredentials, filter: &CloudResourceFilter) -> Vec<String> {
    let listed = unique_regions(filter.regions.iter().cloned());
    if !listed.is_empty() {
        return listed;
    }
    let configured = unique_regions(creds.regions.iter().cloned());
    if !configured.is_empty() {
        return configured;
    }
    let fallback = creds.region.trim();
    if fallback.is_empty() {
        vec![DEFAULT_REGION.into()]
    } else {
        vec![fallback.to_string()]
    }
}

fn with_region(creds: &AliyunCredentials, region: &str) -> AliyunCredentials {
    let mut next = creds.clone();
    next.region = region.to_string();
    next
}

async fn list_regional_rows<F, Fut, M>(
    creds: &AliyunCredentials,
    filter: &CloudResourceFilter,
    fetch: F,
    map_row: M,
) -> Result<Vec<CloudResourceRow>, OmniError>
where
    F: Fn(AliyunCredentials) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Result<Vec<serde_json::Value>, OmniError>> + Send,
    M: Fn(&serde_json::Value, &str) -> CloudResourceRow + Send + Sync,
{
    let regions = regions_to_scan(creds, filter);
    if regions.is_empty() {
        return Ok(Vec::new());
    }
    let fetch = Arc::new(fetch);
    let sem = Arc::new(Semaphore::new(8));
    let fetches = regions.into_iter().map(|region| {
        let scoped = with_region(creds, &region);
        let sem = sem.clone();
        let fetch = fetch.clone();
        async move {
            let _permit = sem.acquire().await.ok();
            match fetch(scoped).await {
                Ok(items) => Ok((region, items)),
                Err(err) => Err(err),
            }
        }
    });
    let results = futures::future::join_all(fetches).await;
    let mut out = Vec::new();
    let mut last_err: Option<OmniError> = None;
    let mut ok_count = 0usize;
    for result in results {
        match result {
            Ok((region, items)) => {
                ok_count += 1;
                out.extend(items.iter().map(|item| map_row(item, &region)));
            }
            Err(err) => last_err = Some(err),
        }
    }
    if ok_count == 0 {
        if let Some(err) = last_err {
            return Err(err);
        }
    }
    Ok(out)
}

async fn list_merged_domains(
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<Vec<CloudResourceRow>, OmniError> {
    let regs = describe_registered_domains(creds, http).await;
    let zones = describe_dnspod_domains(creds, http).await;
    match (regs, zones) {
        (Ok(regs), Ok(zones)) => Ok(merge_domain_rows(&regs, &zones)),
        (Ok(regs), Err(_)) => Ok(merge_domain_rows(&regs, &[])),
        (Err(_), Ok(zones)) => Ok(merge_domain_rows(&[], &zones)),
        (Err(reg_err), Err(_)) => Err(reg_err),
    }
}

async fn get_merged_domain(
    creds: &AliyunCredentials,
    http: &Client,
    id: &str,
) -> Result<CloudResourceDetail, OmniError> {
    let mut last_err: Option<OmniError> = None;
    let regs = match describe_registered_domains(creds, http).await {
        Ok(items) => items,
        Err(err) => {
            last_err = Some(err);
            Vec::new()
        }
    };
    let zones = match describe_dnspod_domains(creds, http).await {
        Ok(items) => items,
        Err(err) => {
            last_err.get_or_insert(err);
            Vec::new()
        }
    };
    let reg = regs.iter().find(|item| {
        jstr(item, &["DomainName", "Domain", "Punycode"]).eq_ignore_ascii_case(id)
            || jstr(item, &["DomainId"]) == id
    });
    let zone = zones.iter().find(|item| {
        jstr(item, &["Name", "Domain", "Punycode"]).eq_ignore_ascii_case(id)
            || jstr(item, &["DomainId"]) == id
    });
    let zone_name = zone
        .map(|item| jstr(item, &["Name", "Domain", "Punycode"]))
        .or_else(|| reg.map(|item| jstr(item, &["DomainName", "Domain"])))
        .unwrap_or_else(|| id.to_string());
    let records = if zone_name.is_empty() {
        Vec::new()
    } else {
        describe_dnspod_records(creds, http, &zone_name)
            .await
            .unwrap_or_default()
            .iter()
            .map(map_dns_record)
            .collect()
    };
    domain_detail(reg, zone, records)
        .ok_or_else(|| last_err.unwrap_or_else(|| OmniError::not_found(format!("未找到域名: {id}"))))
}

fn first_or_not_found(
    items: Vec<serde_json::Value>,
    id: &str,
    label: &str,
) -> Result<serde_json::Value, OmniError> {
    items
        .into_iter()
        .next()
        .ok_or_else(|| OmniError::not_found(format!("未找到{label}: {id}")))
}

#[async_trait]
impl CloudProviderDriver for TencentCloudDriver {
    async fn test_account(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
    ) -> Result<String, OmniError> {
        let body = get_user_app_id(creds, http).await?;
        let app_id = jstr(&body, &["AppId"]);
        let uin = jstr(&body, &["Uin", "OwnerUin"]);
        if app_id.is_empty() && uin.is_empty() {
            return Ok("凭证有效".into());
        }
        if uin.is_empty() {
            return Ok(format!("AppId={app_id}"));
        }
        Ok(format!("AppId={app_id}; Uin={uin}"))
    }

    async fn list_regions(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        configured: &[String],
    ) -> Result<Vec<CloudRegion>, OmniError> {
        let raw = describe_regions(creds, http).await?;
        let mut regions: Vec<CloudRegion> = raw.iter().filter_map(map_region_row).collect();
        let wanted: Vec<String> = configured
            .iter()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        if !wanted.is_empty() {
            regions.retain(|r| wanted.iter().any(|w| w == &r.region_id));
            for id in &wanted {
                if !regions.iter().any(|r| &r.region_id == id) {
                    regions.push(CloudRegion {
                        region_id: id.clone(),
                        local_name: String::new(),
                        capabilities: Vec::new(),
                    });
                }
            }
        }
        Ok(regions)
    }

    async fn get_account(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
    ) -> Result<CloudAccountSnapshot, OmniError> {
        let ident = get_user_app_id(creds, http).await?;
        let mut snap = CloudAccountSnapshot {
            caller_id: jstr(&ident, &["Uin", "OwnerUin"]),
            arn: jstr(&ident, &["AppId"]),
            ..Default::default()
        };
        match describe_account_balance(creds, http).await {
            Ok(body) => {
                let (currency, available, cash, credit) = map_account_balance_fields(&body);
                snap.currency = currency;
                snap.available_amount = available;
                snap.cash_amount = cash;
                snap.credit_amount = credit;
            }
            Err(err) => {
                snap.balance_error = Some(err.user_message());
            }
        }
        Ok(snap)
    }

    async fn list_resources(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        filter: &CloudResourceFilter,
    ) -> Result<Vec<CloudResourceRow>, OmniError> {
        let cap = capability.trim();
        let rows = match cap {
            CAP_COMPUTE => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_cvm_instances(&scoped, &http, &[]).await }
                    },
                    map_cvm_row,
                )
                .await?
            }
            CAP_COMPUTE_LITE => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_lighthouse_instances(&scoped, &http, &[]).await }
                    },
                    map_lighthouse_row,
                )
                .await?
            }
            CAP_OBJECT_STORAGE => {
                let buckets = list_cos_buckets(creds, http).await?;
                let mut rows: Vec<_> = buckets.iter().map(map_cos_row).collect();
                let wanted: Vec<String> = filter
                    .regions
                    .iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !wanted.is_empty() {
                    rows.retain(|row| wanted.iter().any(|r| r == &row.region_id));
                }
                rows
            }
            CAP_DOMAINS | CAP_DNS => list_merged_domains(creds, http).await?,
            CAP_CERTS => describe_certificates(creds, http)
                .await?
                .iter()
                .map(map_cert_row)
                .collect(),
            CAP_SECURITY_GROUP => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_security_groups(&scoped, &http, &[]).await }
                    },
                    map_sg_row,
                )
                .await?
            }
            CAP_DATABASE => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_cdb_instances(&scoped, &http, &[]).await }
                    },
                    map_cdb_row,
                )
                .await?
            }
            CAP_DATABASE_CACHE => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_redis_instances(&scoped, &http, &[]).await }
                    },
                    map_redis_row,
                )
                .await?
            }
            CAP_NETWORK_EIP => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_addresses(&scoped, &http, &[]).await }
                    },
                    map_eip_row,
                )
                .await?
            }
            CAP_LOAD_BALANCER => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_load_balancers(&scoped, &http, &[]).await }
                    },
                    map_lb_row,
                )
                .await?
            }
            CAP_STORAGE_DISK => {
                let http = http.clone();
                list_regional_rows(
                    creds,
                    filter,
                    move |scoped| {
                        let http = http.clone();
                        async move { describe_disks(&scoped, &http, &[], None).await }
                    },
                    map_disk_row,
                )
                .await?
            }
            other => {
                return Err(OmniError::invalid_input(format!(
                    "腾讯云本期未实现能力: {other}"
                )));
            }
        };
        Ok(apply_row_filter(rows, filter))
    }

    async fn get_resource(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        resource_id: &str,
        region_id: &str,
    ) -> Result<CloudResourceDetail, OmniError> {
        let id = resource_id.trim();
        if id.is_empty() {
            return Err(OmniError::invalid_input("缺少资源 id"));
        }
        let region = if region_id.trim().is_empty() {
            region_or_default(creds)
        } else {
            region_id.trim().to_string()
        };
        let scoped = with_region(creds, &region);
        match capability.trim() {
            CAP_COMPUTE => {
                let item = first_or_not_found(
                    describe_cvm_instances(&scoped, http, &[id.to_string()]).await?,
                    id,
                    "CVM 实例",
                )?;
                let mut detail = cvm_to_detail(&item, &region);
                if let Ok(disks) = describe_disks(&scoped, http, &[], Some(id)).await {
                    attach_instance_disks(&mut detail, &disks);
                    if let Ok(snapshots) = describe_snapshots(&scoped, http, None, Some(id)).await {
                        attach_snapshots(
                            &mut detail,
                            snapshots.iter().map(map_snapshot_child).collect(),
                        );
                    }
                }
                Ok(detail)
            }
            CAP_COMPUTE_LITE => {
                let item = first_or_not_found(
                    describe_lighthouse_instances(&scoped, http, &[id.to_string()]).await?,
                    id,
                    "轻量实例",
                )?;
                let mut detail = lighthouse_to_detail(&item, &region);
                if let Ok(rules) = describe_lighthouse_firewall_rules(&scoped, http, id).await {
                    detail.rules = rules.iter().map(map_firewall_rule).collect();
                }
                Ok(detail)
            }
            CAP_OBJECT_STORAGE => {
                let buckets = list_cos_buckets(creds, http).await?;
                let item = buckets
                    .iter()
                    .find(|b| jstr(b, &["Name"]) == id)
                    .ok_or_else(|| OmniError::not_found(format!("未找到 Bucket: {id}")))?;
                Ok(cos_to_detail(item))
            }
            CAP_DOMAINS | CAP_DNS => get_merged_domain(creds, http, id).await,
            CAP_CERTS => {
                let items = describe_certificates(creds, http).await?;
                let item = items
                    .iter()
                    .find(|c| jstr(c, &["CertificateId", "Id", "Domain"]) == id)
                    .ok_or_else(|| OmniError::not_found(format!("未找到证书: {id}")))?;
                Ok(cert_to_detail(item))
            }
            CAP_SECURITY_GROUP => {
                let item = first_or_not_found(
                    describe_security_groups(&scoped, http, &[id.to_string()]).await?,
                    id,
                    "安全组",
                )?;
                let rules = describe_security_group_policies(&scoped, http, id)
                    .await
                    .map(|body| sg_policies_from_set(&body))
                    .unwrap_or_default();
                Ok(sg_to_detail(&item, &region, rules))
            }
            CAP_DATABASE => {
                let item = first_or_not_found(
                    describe_cdb_instances(&scoped, http, &[id.to_string()]).await?,
                    id,
                    "CDB 实例",
                )?;
                let mut detail = cdb_to_detail(&item, &region);
                if let Ok(groups) = describe_cdb_security_groups(&scoped, http, id).await {
                    detail.rules = groups.iter().map(map_cdb_sg_rule).collect();
                }
                Ok(detail)
            }
            CAP_DATABASE_CACHE => {
                let item = first_or_not_found(
                    describe_redis_instances(&scoped, http, &[id.to_string()]).await?,
                    id,
                    "Redis 实例",
                )?;
                Ok(redis_to_detail(&item, &region))
            }
            CAP_NETWORK_EIP => {
                let item = first_or_not_found(
                    describe_addresses(&scoped, http, &[id.to_string()]).await?,
                    id,
                    "EIP",
                )?;
                Ok(eip_to_detail(&item, &region))
            }
            CAP_LOAD_BALANCER => {
                let item = first_or_not_found(
                    describe_load_balancers(&scoped, http, &[id.to_string()]).await?,
                    id,
                    "CLB",
                )?;
                let listeners = describe_clb_listeners(&scoped, http, id)
                    .await
                    .unwrap_or_default();
                let targets = describe_clb_targets(&scoped, http, id)
                    .await
                    .unwrap_or_default();
                Ok(lb_to_detail(&item, &region, &listeners, &targets))
            }
            CAP_STORAGE_DISK => {
                let item = first_or_not_found(
                    describe_disks(&scoped, http, &[id.to_string()], None).await?,
                    id,
                    "云盘",
                )?;
                let snapshots = describe_snapshots(&scoped, http, Some(id), None)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(map_snapshot_child)
                    .collect();
                Ok(disk_to_detail(&item, &region, snapshots))
            }
            other => Err(OmniError::invalid_input(format!(
                "腾讯云本期未实现能力: {other}"
            ))),
        }
    }

    async fn invoke_action(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        action: &CloudAction,
    ) -> Result<CloudActionResult, OmniError> {
        let name = action.name.trim().to_ascii_lowercase();
        let id = action.resource_id.trim();
        if id.is_empty() {
            return Err(OmniError::invalid_input("缺少资源 id"));
        }
        let region = if action.region_id.trim().is_empty() {
            region_or_default(creds)
        } else {
            action.region_id.trim().to_string()
        };
        let scoped = with_region(creds, &region);
        let cap = action.capability.trim();
        match (cap, name.as_str()) {
            (CAP_COMPUTE, ACTION_START) => {
                cvm_instance_action(&scoped, http, "StartInstances", id).await?
            }
            (CAP_COMPUTE, ACTION_STOP) => {
                cvm_instance_action(&scoped, http, "StopInstances", id).await?
            }
            (CAP_COMPUTE, ACTION_REBOOT) => {
                cvm_instance_action(&scoped, http, "RebootInstances", id).await?
            }
            (CAP_COMPUTE, ACTION_ATTACH) => {
                let group_id = action.param("securityGroupId");
                if group_id.is_empty() {
                    return Err(OmniError::invalid_input("缺少安全组 id"));
                }
                associate_cvm_security_groups(&scoped, http, id, &group_id, true).await?
            }
            (CAP_COMPUTE, ACTION_DETACH) => {
                let group_id = action.param("securityGroupId");
                if group_id.is_empty() {
                    return Err(OmniError::invalid_input("缺少安全组 id"));
                }
                associate_cvm_security_groups(&scoped, http, id, &group_id, false).await?
            }
            (CAP_COMPUTE_LITE, ACTION_START) => {
                lighthouse_instance_action(&scoped, http, "StartInstances", id).await?
            }
            (CAP_COMPUTE_LITE, ACTION_STOP) => {
                lighthouse_instance_action(&scoped, http, "StopInstances", id).await?
            }
            (CAP_COMPUTE_LITE, ACTION_REBOOT) => {
                lighthouse_instance_action(&scoped, http, "RebootInstances", id).await?
            }
            (CAP_SECURITY_GROUP, ACTION_AUTHORIZE_RULE) => {
                modify_security_group_policies(&scoped, http, action, true).await?
            }
            (CAP_SECURITY_GROUP, ACTION_REVOKE_RULE) => {
                modify_security_group_policies(&scoped, http, action, false).await?
            }
            (CAP_COMPUTE_LITE, ACTION_AUTHORIZE_RULE) => {
                modify_lighthouse_firewall(&scoped, http, action, true).await?
            }
            (CAP_COMPUTE_LITE, ACTION_REVOKE_RULE) => {
                modify_lighthouse_firewall(&scoped, http, action, false).await?
            }
            (CAP_DATABASE, ACTION_START) => {
                cdb_instance_action(&scoped, http, "StartDBInstances", id).await?
            }
            (CAP_DATABASE, ACTION_STOP) => {
                cdb_instance_action(&scoped, http, "StopDBInstances", id).await?
            }
            (CAP_DATABASE, ACTION_REBOOT) => {
                cdb_instance_action(&scoped, http, "RestartDBInstances", id).await?
            }
            (CAP_DATABASE, ACTION_AUTHORIZE_RULE) => {
                let group_id = action.param("securityGroupId");
                if group_id.is_empty() {
                    return Err(OmniError::invalid_input("缺少安全组 id"));
                }
                let mut ids: Vec<String> = describe_cdb_security_groups(&scoped, http, id)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(|g| jstr(g, &["SecurityGroupId"]))
                    .filter(|s| !s.is_empty())
                    .collect();
                if !ids.iter().any(|s| s == &group_id) {
                    ids.push(group_id);
                }
                modify_cdb_security_groups(&scoped, http, id, &ids).await?
            }
            (CAP_DATABASE, ACTION_REVOKE_RULE) => {
                let group_id = action.param("securityGroupId");
                if group_id.is_empty() {
                    return Err(OmniError::invalid_input("缺少安全组 id"));
                }
                let ids: Vec<String> = describe_cdb_security_groups(&scoped, http, id)
                    .await
                    .unwrap_or_default()
                    .iter()
                    .map(|g| jstr(g, &["SecurityGroupId"]))
                    .filter(|s| !s.is_empty() && s != &group_id)
                    .collect();
                modify_cdb_security_groups(&scoped, http, id, &ids).await?
            }
            (CAP_DOMAINS | CAP_DNS, ACTION_ADD_RECORD) => {
                mutate_dnspod_record(&scoped, http, action, "add").await?
            }
            (CAP_DOMAINS | CAP_DNS, ACTION_UPDATE_RECORD) => {
                mutate_dnspod_record(&scoped, http, action, "update").await?
            }
            (CAP_DOMAINS | CAP_DNS, ACTION_DELETE_RECORD) => {
                mutate_dnspod_record(&scoped, http, action, "delete").await?
            }
            (CAP_DATABASE_CACHE, ACTION_REBOOT | ACTION_START | ACTION_STOP) => {
                if name == ACTION_REBOOT {
                    redis_restart(&scoped, http, id).await?
                } else {
                    return Err(OmniError::invalid_input("Redis 仅支持重启"));
                }
            }
            (CAP_NETWORK_EIP, ACTION_ATTACH) => {
                associate_address(&scoped, http, action, true).await?
            }
            (CAP_NETWORK_EIP, ACTION_DETACH) => {
                associate_address(&scoped, http, action, false).await?
            }
            (CAP_NETWORK_EIP, ACTION_MODIFY_BANDWIDTH) => {
                modify_address_bandwidth(&scoped, http, action).await?
            }
            (CAP_LOAD_BALANCER, ACTION_START | ACTION_STOP) => {
                return Err(OmniError::invalid_input("CLB 不支持该操作"));
            }
            (CAP_STORAGE_DISK, ACTION_ATTACH) => attach_disks(&scoped, http, action, true).await?,
            (CAP_STORAGE_DISK, ACTION_DETACH) => attach_disks(&scoped, http, action, false).await?,
            (CAP_STORAGE_DISK | CAP_COMPUTE, ACTION_CREATE_SNAPSHOT) => {
                create_snapshot(&scoped, http, action).await?
            }
            _ => {
                return Err(OmniError::invalid_input(format!(
                    "不支持的动作: {cap}/{name}"
                )));
            }
        }
        Ok(CloudActionResult {
            ok: true,
            message: format!("{name} 已提交"),
        })
    }

    async fn get_metrics(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        resource_id: &str,
        region_id: &str,
        query: &CloudMetricQuery,
    ) -> Result<Vec<CloudMetricSeries>, OmniError> {
        let id = resource_id.trim();
        if id.is_empty() {
            return Err(OmniError::invalid_input("缺少资源 id"));
        }
        let namespace = monitor_namespace(capability).ok_or_else(|| {
            OmniError::invalid_input(format!("该能力不支持监控: {capability}"))
        })?;
        let region = if region_id.trim().is_empty() {
            region_or_default(creds)
        } else {
            region_id.trim().to_string()
        };
        let scoped = with_region(creds, &region);
        let now = chrono::Utc::now().timestamp_millis();
        let end_ms = if query.end_ms > 0 { query.end_ms } else { now };
        let start_ms = if query.start_ms > 0 {
            query.start_ms
        } else {
            end_ms - 3600_000
        };
        let period = if query.period_sec > 0 {
            query.period_sec
        } else {
            60
        };
        let ids: Vec<String> = if query.metric_ids.is_empty() {
            default_metric_ids(capability)
                .iter()
                .map(|s| (*s).to_string())
                .collect()
        } else {
            query.metric_ids.clone()
        };
        let dimension = monitor_dimension(capability);
        let futs = ids.into_iter().map(|metric_id| {
            let scoped = scoped.clone();
            let instance_id = id.to_string();
            async move {
                let Some(tc_name) = tencent_metric_name(capability, &metric_id) else {
                    return monitor_series(&metric_id, &serde_json::Value::Null);
                };
                let body = get_monitor_data(
                    &scoped,
                    http,
                    namespace,
                    tc_name,
                    &instance_id,
                    dimension,
                    start_ms,
                    end_ms,
                    period,
                )
                .await
                .unwrap_or(serde_json::Value::Null);
                monitor_series(&metric_id, &body)
            }
        });
        Ok(futures::future::join_all(futs).await)
    }

    async fn query_logs(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        resource_id: &str,
        region_id: &str,
        query: &CloudLogQuery,
    ) -> Result<CloudLogPage, OmniError> {
        let id = resource_id.trim();
        if id.is_empty() {
            return Err(OmniError::invalid_input("缺少资源 id"));
        }
        let region = if region_id.trim().is_empty() {
            region_or_default(creds)
        } else {
            region_id.trim().to_string()
        };
        let scoped = with_region(creds, &region);
        let page = if query.page > 0 { query.page } else { 1 };
        match capability.trim() {
            CAP_DATABASE => {
                let body = describe_cdb_slow_logs(&scoped, http, id, query).await?;
                Ok(parse_slow_log_page("slow", &body, page))
            }
            CAP_DATABASE_CACHE => {
                let body = describe_redis_slow_log(&scoped, http, id, query).await?;
                Ok(parse_slow_log_page("slow", &body, page))
            }
            other => Err(OmniError::invalid_input(format!(
                "该能力不支持日志查询: {other}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn creds(region: &str, regions: &[&str]) -> AliyunCredentials {
        AliyunCredentials {
            access_key_id: "ak".into(),
            access_key_secret: "sk".into(),
            region: region.into(),
            regions: regions.iter().map(|s| (*s).to_string()).collect(),
        }
    }

    #[test]
    fn empty_filter_scans_configured_then_default() {
        let ids = regions_to_scan(
            &creds("ap-guangzhou", &["ap-guangzhou", "ap-shanghai"]),
            &CloudResourceFilter::default(),
        );
        assert_eq!(ids, vec!["ap-guangzhou", "ap-shanghai"]);
        let fallback = regions_to_scan(&creds("", &[]), &CloudResourceFilter::default());
        assert_eq!(fallback, vec![DEFAULT_REGION]);
    }

    #[test]
    fn filter_regions_override_configured() {
        let ids = regions_to_scan(
            &creds("ap-guangzhou", &["ap-guangzhou", "ap-shanghai"]),
            &CloudResourceFilter {
                regions: vec!["ap-beijing".into()],
                status: None,
                query: None,
            },
        );
        assert_eq!(ids, vec!["ap-beijing"]);
    }
}
