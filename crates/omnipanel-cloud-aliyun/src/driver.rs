use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_error::OmniError;
use reqwest::Client;
use tokio::sync::Semaphore;

use crate::client::AliyunCredentials;
use crate::mapping::{
    attach_instance_disks, attach_instance_snapshots, cert_to_detail, disk_to_detail, ecs_to_detail,
    eip_to_detail, kv_to_detail, lb_to_detail,
    map_cert_row, map_disk_row, map_ecs_row, map_eip_row, map_kv_row, map_lb_row, map_oss_row,
    map_rds_row, map_region, map_sg_row, map_swas_row, merge_domain_rows, merged_domain_detail,
    oss_to_detail, rds_to_detail, sg_to_detail, swas_to_detail,
};
use crate::types::{
    is_global_capability, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudLogPage,
    CloudLogQuery, CloudMetricQuery, CloudMetricSeries, CloudRegion, CloudRelatedRef,
    CloudResourceDetail, CloudResourceFilter, CloudResourceRow, ACTION_ADD_RECORD, ACTION_ATTACH,
    ACTION_AUTHORIZE_RULE,
    ACTION_CREATE_SNAPSHOT, ACTION_DELETE_RECORD, ACTION_DETACH, ACTION_MODIFY_BANDWIDTH,
    ACTION_REBOOT, ACTION_REVOKE_RULE, ACTION_START, ACTION_STOP, ACTION_UPDATE_RECORD, CAP_CERTS,
    CAP_COMPUTE, CAP_COMPUTE_LITE, CAP_DATABASE, CAP_DATABASE_CACHE, CAP_DNS, CAP_DOMAINS,
    CAP_LOAD_BALANCER, CAP_NETWORK_EIP, CAP_OBJECT_STORAGE, CAP_SECURITY_GROUP, CAP_STORAGE_DISK,
};

#[async_trait]
pub trait CloudProviderDriver: Send + Sync {
    async fn test_account(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
    ) -> Result<String, OmniError>;

    async fn list_regions(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        configured: &[String],
    ) -> Result<Vec<CloudRegion>, OmniError>;

    async fn get_account(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
    ) -> Result<CloudAccountSnapshot, OmniError>;

    async fn list_resources(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        filter: &CloudResourceFilter,
    ) -> Result<Vec<CloudResourceRow>, OmniError>;

    async fn get_resource(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        resource_id: &str,
        region_id: &str,
    ) -> Result<CloudResourceDetail, OmniError>;

    async fn invoke_action(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        action: &CloudAction,
    ) -> Result<CloudActionResult, OmniError>;

    async fn get_metrics(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        resource_id: &str,
        region_id: &str,
        query: &CloudMetricQuery,
    ) -> Result<Vec<CloudMetricSeries>, OmniError>;

    async fn query_logs(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        capability: &str,
        resource_id: &str,
        region_id: &str,
        query: &CloudLogQuery,
    ) -> Result<CloudLogPage, OmniError>;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct AliyunCloudDriver;

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
        vec!["cn-hangzhou".into()]
    } else {
        vec![fallback.to_string()]
    }
}

async fn list_regional_rows<T, F, Fut, M>(
    creds: &AliyunCredentials,
    filter: &CloudResourceFilter,
    fetch: F,
    map_row: M,
) -> Result<Vec<CloudResourceRow>, OmniError>
where
    T: Send,
    F: Fn(AliyunCredentials) -> Fut + Send + Sync,
    Fut: std::future::Future<Output = Result<Vec<T>, OmniError>> + Send,
    M: Fn(&T) -> CloudResourceRow + Send + Sync,
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
            fetch(scoped).await
        }
    });
    let results = futures::future::join_all(fetches).await;
    let mut out = Vec::new();
    let mut last_err: Option<OmniError> = None;
    let mut ok_count = 0usize;
    for result in results {
        match result {
            Ok(items) => {
                ok_count += 1;
                out.extend(items.iter().map(&map_row));
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
    let regs = creds.list_domains(http).await;
    let zones = creds.list_dns_zones(http).await;
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
    let mut reg = match creds.get_registered_domain(http, id).await {
        Ok(item) => item,
        Err(err) => {
            last_err = Some(err);
            None
        }
    };
    let zone_hint = reg
        .as_ref()
        .map(|item| item.domain_name.as_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(id);
    let mut zone = match creds.get_dns_zone(http, zone_hint).await {
        Ok(item) => item,
        Err(err) => {
            last_err = Some(err);
            None
        }
    };
    if reg.is_none() && zone.is_none() {
        let regs = match creds.list_domains(http).await {
            Ok(items) => items,
            Err(err) => {
                last_err.get_or_insert(err);
                Vec::new()
            }
        };
        let zones = match creds.list_dns_zones(http).await {
            Ok(items) => items,
            Err(err) => {
                last_err.get_or_insert(err);
                Vec::new()
            }
        };
        reg = regs
            .into_iter()
            .find(|item| item.domain_name.eq_ignore_ascii_case(id) || item.instance_id == id);
        zone = zones
            .into_iter()
            .find(|item| item.domain_name.eq_ignore_ascii_case(id));
    }
    let mut detail = merged_domain_detail(reg.as_ref(), zone.as_ref()).ok_or_else(|| {
        last_err.unwrap_or_else(|| OmniError::not_found(format!("未找到域名: {id}")))
    })?;
    let zone_name = zone
        .as_ref()
        .map(|item| item.domain_name.as_str())
        .or_else(|| reg.as_ref().map(|item| item.domain_name.as_str()))
        .unwrap_or(id);
    if let Ok(records) = creds.list_dns_records(http, zone_name).await {
        detail.children = records;
    }
    Ok(detail)
}

fn with_region(creds: &AliyunCredentials, region: &str) -> AliyunCredentials {
    let mut next = creds.clone();
    next.region = region.to_string();
    next
}

#[async_trait]
impl CloudProviderDriver for AliyunCloudDriver {
    async fn test_account(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
    ) -> Result<String, OmniError> {
        creds.test_credentials(http).await
    }

    async fn list_regions(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
        configured: &[String],
    ) -> Result<Vec<CloudRegion>, OmniError> {
        let raw = creds.discover_regions(http, configured).await?;
        Ok(raw.iter().map(map_region).collect())
    }

    async fn get_account(
        &self,
        creds: &AliyunCredentials,
        http: &Client,
    ) -> Result<CloudAccountSnapshot, OmniError> {
        creds.account_snapshot(http).await
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
                        async move { scoped.list_ecs_instances(&http).await }
                    },
                    map_ecs_row,
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
                        async move { scoped.list_swas_instances(&http).await }
                    },
                    map_swas_row,
                )
                .await?
            }
            CAP_OBJECT_STORAGE => {
                let buckets = creds.list_oss_buckets(http).await?;
                let mut rows: Vec<_> = buckets.iter().map(map_oss_row).collect();
                let wanted: Vec<String> = filter
                    .regions
                    .iter()
                    .map(|s| s.trim().trim_start_matches("oss-").to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !wanted.is_empty() {
                    rows.retain(|row| wanted.iter().any(|r| r == &row.region_id));
                }
                rows
            }
            CAP_DOMAINS | CAP_DNS => list_merged_domains(creds, http).await?,
            CAP_CERTS => creds
                .list_certificates(http)
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
                        async move { scoped.list_security_groups(&http).await }
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
                        async move { scoped.list_rds_instances(&http).await }
                    },
                    map_rds_row,
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
                        async move { scoped.list_kv_instances(&http).await }
                    },
                    map_kv_row,
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
                        async move { scoped.list_eips(&http).await }
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
                        async move { scoped.list_load_balancers(&http).await }
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
                        async move { scoped.list_disks(&http).await }
                    },
                    map_disk_row,
                )
                .await?
            }
            other => {
                return Err(OmniError::invalid_input(format!(
                    "阿里云本期未实现能力: {other}"
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
            creds.region.as_str()
        } else {
            region_id.trim()
        };
        match capability.trim() {
            CAP_COMPUTE => {
                let scoped = with_region(creds, region);
                let item = scoped.get_ecs_instance(http, id).await?;
                let mut detail = ecs_to_detail(&item);
                if let Ok(disks) = scoped.list_instance_disks(http, id).await {
                    attach_instance_disks(&mut detail, &disks);
                }
                if let Ok(snapshots) = scoped.list_instance_snapshots(http, id).await {
                    attach_instance_snapshots(&mut detail, snapshots);
                }
                Ok(detail)
            }
            CAP_COMPUTE_LITE => {
                let scoped = with_region(creds, region);
                let item = scoped.get_swas_instance(http, id).await?;
                let mut detail = swas_to_detail(&item);
                if let Ok(rules) = scoped.list_swas_firewall_rules(http, id).await {
                    detail.rules = rules;
                }
                if let Ok(disks) = scoped.list_swas_disks(http, id).await {
                    attach_instance_disks(&mut detail, &disks);
                }
                if let Ok(snapshots) = scoped.list_swas_snapshots(http, id).await {
                    attach_instance_snapshots(&mut detail, snapshots);
                }
                Ok(detail)
            }
            CAP_OBJECT_STORAGE => {
                let buckets = creds.list_oss_buckets(http).await?;
                let item = buckets
                    .iter()
                    .find(|b| b.name == id)
                    .ok_or_else(|| OmniError::not_found(format!("未找到 Bucket: {id}")))?;
                Ok(oss_to_detail(item))
            }
            CAP_DOMAINS | CAP_DNS => get_merged_domain(creds, http, id).await,
            CAP_CERTS => {
                let items = creds.list_certificates(http).await?;
                let item = items
                    .iter()
                    .find(|c| c.order_id == id || c.domain == id)
                    .ok_or_else(|| OmniError::not_found(format!("未找到证书: {id}")))?;
                Ok(cert_to_detail(item))
            }
            CAP_SECURITY_GROUP => {
                let scoped = with_region(creds, region);
                let item = scoped.get_security_group(http, id).await?;
                let mut detail = sg_to_detail(&item);
                if let Ok(instances) = scoped.list_security_group_instances(http, id).await {
                    if !instances.is_empty() {
                        detail
                            .fields
                            .insert("instanceCount".into(), instances.len().to_string());
                    }
                    for (iid, name) in instances {
                        detail.related.push(CloudRelatedRef {
                            capability: CAP_COMPUTE.into(),
                            resource_id: iid.clone(),
                            name: if name.trim().is_empty() { iid } else { name },
                            role: "instance".into(),
                        });
                    }
                }
                Ok(detail)
            }
            CAP_DATABASE => {
                let scoped = with_region(creds, region);
                let item = scoped.get_rds_instance(http, id).await?;
                let mut detail = rds_to_detail(&item);
                if let Ok(rules) = scoped.list_rds_whitelist(http, id).await {
                    detail.rules = rules;
                }
                if let Ok(children) = scoped.list_rds_children(http, id).await {
                    detail.children = children;
                }
                Ok(detail)
            }
            CAP_DATABASE_CACHE => {
                let scoped = with_region(creds, region);
                let item = scoped.get_kv_instance(http, id).await?;
                let mut detail = kv_to_detail(&item);
                if let Ok(rules) = scoped.list_kv_whitelist(http, id).await {
                    detail.rules = rules;
                }
                Ok(detail)
            }
            CAP_NETWORK_EIP => {
                let scoped = with_region(creds, region);
                let item = scoped.get_eip(http, id).await?;
                Ok(eip_to_detail(&item))
            }
            CAP_LOAD_BALANCER => {
                let scoped = with_region(creds, region);
                let item = scoped.get_load_balancer(http, id).await?;
                Ok(lb_to_detail(&item))
            }
            CAP_STORAGE_DISK => {
                let scoped = with_region(creds, region);
                let mut item = scoped.get_disk(http, id).await?;
                if let Ok(snapshots) = scoped.list_disk_snapshots(http, id).await {
                    item.snapshots = snapshots;
                }
                Ok(disk_to_detail(&item))
            }
            other => Err(OmniError::invalid_input(format!(
                "阿里云本期未实现能力: {other}"
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
            creds.region.as_str()
        } else {
            action.region_id.trim()
        };
        let scoped = with_region(creds, region);
        let cap = action.capability.trim();
        match (cap, name.as_str()) {
            (CAP_COMPUTE, ACTION_START) => scoped.ecs_instance_action(http, "StartInstance", id).await?,
            (CAP_COMPUTE, ACTION_STOP) => scoped.ecs_instance_action(http, "StopInstance", id).await?,
            (CAP_COMPUTE, ACTION_REBOOT) => {
                scoped.ecs_instance_action(http, "RebootInstance", id).await?
            }
            (CAP_COMPUTE, ACTION_ATTACH) => scoped.join_security_group(http, action).await?,
            (CAP_COMPUTE, ACTION_DETACH) => scoped.leave_security_group(http, action).await?,
            (CAP_COMPUTE_LITE, ACTION_START) => {
                scoped.swas_instance_action(http, "StartInstance", id).await?
            }
            (CAP_COMPUTE_LITE, ACTION_STOP) => {
                scoped.swas_instance_action(http, "StopInstance", id).await?
            }
            (CAP_COMPUTE_LITE, ACTION_REBOOT) => {
                scoped.swas_instance_action(http, "RebootInstance", id).await?
            }
            (CAP_SECURITY_GROUP, ACTION_AUTHORIZE_RULE) => {
                scoped.authorize_security_group_rule(http, action).await?
            }
            (CAP_SECURITY_GROUP, ACTION_REVOKE_RULE) => {
                scoped.revoke_security_group_rule(http, action).await?
            }
            (CAP_COMPUTE_LITE, ACTION_AUTHORIZE_RULE) => {
                scoped.authorize_swas_firewall_rule(http, action).await?
            }
            (CAP_COMPUTE_LITE, ACTION_REVOKE_RULE) => {
                scoped.revoke_swas_firewall_rule(http, action).await?
            }
            (CAP_DATABASE, ACTION_START) => {
                scoped.rds_instance_action(http, "StartDBInstance", id).await?
            }
            (CAP_DATABASE, ACTION_STOP) => {
                scoped.rds_instance_action(http, "StopDBInstance", id).await?
            }
            (CAP_DATABASE, ACTION_REBOOT) => {
                scoped
                    .rds_instance_action(http, "RestartDBInstance", id)
                    .await?
            }
            (CAP_DATABASE, ACTION_AUTHORIZE_RULE) => {
                scoped.authorize_rds_whitelist(http, action).await?
            }
            (CAP_DATABASE, ACTION_REVOKE_RULE) => scoped.revoke_rds_whitelist(http, action).await?,
            (CAP_DOMAINS | CAP_DNS, ACTION_ADD_RECORD) => scoped.add_dns_record(http, action).await?,
            (CAP_DOMAINS | CAP_DNS, ACTION_UPDATE_RECORD) => scoped.update_dns_record(http, action).await?,
            (CAP_DOMAINS | CAP_DNS, ACTION_DELETE_RECORD) => scoped.delete_dns_record(http, action).await?,
            (CAP_DATABASE_CACHE, ACTION_START) => {
                scoped
                    .kv_instance_action(http, "StartInstance", id)
                    .await?
            }
            (CAP_DATABASE_CACHE, ACTION_STOP) => {
                scoped.kv_instance_action(http, "StopInstance", id).await?
            }
            (CAP_DATABASE_CACHE, ACTION_REBOOT) => {
                scoped
                    .kv_instance_action(http, "RestartInstance", id)
                    .await?
            }
            (CAP_DATABASE_CACHE, ACTION_AUTHORIZE_RULE) => {
                scoped.modify_kv_whitelist(http, action, "Append").await?
            }
            (CAP_DATABASE_CACHE, ACTION_REVOKE_RULE) => {
                scoped.modify_kv_whitelist(http, action, "Delete").await?
            }
            (CAP_NETWORK_EIP, ACTION_ATTACH) => scoped.associate_eip(http, action).await?,
            (CAP_NETWORK_EIP, ACTION_DETACH) => scoped.unassociate_eip(http, action).await?,
            (CAP_NETWORK_EIP, ACTION_MODIFY_BANDWIDTH) => {
                scoped.modify_eip_bandwidth(http, action).await?
            }
            (CAP_LOAD_BALANCER, ACTION_START) => {
                if action.param("port").is_empty() {
                    scoped.set_load_balancer_status(http, id, "active").await?
                } else {
                    scoped.set_listener_status(http, action, true).await?
                }
            }
            (CAP_LOAD_BALANCER, ACTION_STOP) => {
                if action.param("port").is_empty() {
                    scoped.set_load_balancer_status(http, id, "inactive").await?
                } else {
                    scoped.set_listener_status(http, action, false).await?
                }
            }
            (CAP_STORAGE_DISK, ACTION_ATTACH) => scoped.attach_disk(http, action).await?,
            (CAP_STORAGE_DISK, ACTION_DETACH) => scoped.detach_disk(http, action).await?,
            (CAP_STORAGE_DISK | CAP_COMPUTE, ACTION_CREATE_SNAPSHOT) => {
                scoped.create_disk_snapshot(http, action).await?
            }
            (CAP_COMPUTE_LITE, ACTION_CREATE_SNAPSHOT) => {
                scoped.create_swas_snapshot(http, action).await?
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
        let region = if region_id.trim().is_empty() {
            creds.region.as_str()
        } else {
            region_id.trim()
        };
        let scoped = with_region(creds, region);
        scoped.get_metrics(http, capability, id, query).await
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
            creds.region.as_str()
        } else {
            region_id.trim()
        };
        let scoped = with_region(creds, region);
        match capability.trim() {
            CAP_DATABASE => scoped.query_rds_slow_logs(http, id, query).await,
            CAP_DATABASE_CACHE => scoped.query_kv_slow_logs(http, id, query).await,
            other => Err(OmniError::invalid_input(format!(
                "该能力不支持日志查询: {other}"
            ))),
        }
    }
}

/// 供网关 / 命令层判断能力是否走地域扫描。
pub fn capability_is_global(capability: &str) -> bool {
    is_global_capability(capability)
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
    fn empty_filter_scans_all_configured_regions() {
        let ids = regions_to_scan(
            &creds("cn-hangzhou", &["cn-hangzhou", "cn-heyuan"]),
            &CloudResourceFilter::default(),
        );
        assert_eq!(ids, vec!["cn-hangzhou", "cn-heyuan"]);
    }

    #[test]
    fn filter_regions_override_configured() {
        let ids = regions_to_scan(
            &creds("cn-hangzhou", &["cn-hangzhou", "cn-heyuan"]),
            &CloudResourceFilter {
                regions: vec!["cn-shanghai".into()],
                status: None,
                query: None,
            },
        );
        assert_eq!(ids, vec!["cn-shanghai"]);
    }

    #[tokio::test]
    async fn empty_success_ignores_other_region_connect_error() {
        let creds = creds("cn-hangzhou", &["cn-hangzhou", "cn-wuhan"]);
        let rows = list_regional_rows(
            &creds,
            &CloudResourceFilter::default(),
            |scoped| async move {
                if scoped.region == "cn-wuhan" {
                    Err(OmniError::connection("connect"))
                } else {
                    Ok(Vec::<()>::new())
                }
            },
            |_| CloudResourceRow {
                id: "x".into(),
                name: "x".into(),
                capability: CAP_COMPUTE.into(),
                region_id: String::new(),
                status: String::new(),
                fields: Default::default(),
            },
        )
        .await
        .expect("有地域成功时不应因其他地域连不上失败");
        assert!(rows.is_empty());
    }
}
