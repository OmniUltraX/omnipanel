use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_error::OmniError;
use reqwest::Client;
use tokio::sync::Semaphore;

use crate::client::AliyunCredentials;
use crate::mapping::{
    cert_to_detail, domain_to_detail, ecs_to_detail, map_cert_row, map_domain_row, map_ecs_row,
    map_oss_row, map_region, map_swas_row, oss_to_detail, swas_to_detail,
};
use crate::types::{
    is_global_capability, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudRegion,
    CloudResourceDetail, CloudResourceFilter, CloudResourceRow, ACTION_REBOOT, ACTION_START,
    ACTION_STOP, CAP_CERTS, CAP_COMPUTE, CAP_COMPUTE_LITE, CAP_DOMAINS, CAP_OBJECT_STORAGE,
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
            CAP_DOMAINS => creds
                .list_domains(http)
                .await?
                .iter()
                .map(map_domain_row)
                .collect(),
            CAP_CERTS => creds
                .list_certificates(http)
                .await?
                .iter()
                .map(map_cert_row)
                .collect(),
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
                Ok(ecs_to_detail(&item))
            }
            CAP_COMPUTE_LITE => {
                let scoped = with_region(creds, region);
                let item = scoped.get_swas_instance(http, id).await?;
                Ok(swas_to_detail(&item))
            }
            CAP_OBJECT_STORAGE => {
                let buckets = creds.list_oss_buckets(http).await?;
                let item = buckets
                    .iter()
                    .find(|b| b.name == id)
                    .ok_or_else(|| OmniError::not_found(format!("未找到 Bucket: {id}")))?;
                Ok(oss_to_detail(item))
            }
            CAP_DOMAINS => {
                let items = creds.list_domains(http).await?;
                let item = items
                    .iter()
                    .find(|d| d.domain_name == id || d.instance_id == id)
                    .ok_or_else(|| OmniError::not_found(format!("未找到域名: {id}")))?;
                Ok(domain_to_detail(item))
            }
            CAP_CERTS => {
                let items = creds.list_certificates(http).await?;
                let item = items
                    .iter()
                    .find(|c| c.order_id == id || c.domain == id)
                    .ok_or_else(|| OmniError::not_found(format!("未找到证书: {id}")))?;
                Ok(cert_to_detail(item))
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
            (CAP_COMPUTE_LITE, ACTION_START) => {
                scoped.swas_instance_action(http, "StartInstance", id).await?
            }
            (CAP_COMPUTE_LITE, ACTION_STOP) => {
                scoped.swas_instance_action(http, "StopInstance", id).await?
            }
            (CAP_COMPUTE_LITE, ACTION_REBOOT) => {
                scoped.swas_instance_action(http, "RebootInstance", id).await?
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
