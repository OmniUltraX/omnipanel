//! 云厂商 Host 分发：按 pluginId 路由到具体 Driver。

use omnipanel_cloud_aliyun::{AliyunCloudDriver, AliyunCredentials, CloudProviderDriver};
use omnipanel_cloud_tencent::TencentCloudDriver;
use omnipanel_error::OmniError;
use reqwest::Client;

pub use omnipanel_cloud_aliyun::{
    is_write_action, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudLogPage,
    CloudLogQuery, CloudMetricQuery, CloudMetricSeries, CloudRegion, CloudResourceDetail,
    CloudResourceFilter, CloudResourceRow, PLUGIN_ID_ALIYUN,
};
pub use omnipanel_cloud_tencent::{PLUGIN_ID_TENCENT, DEFAULT_REGION as TENCENT_DEFAULT_REGION};

pub fn resolve_plugin_id(raw: &str) -> Result<String, OmniError> {
    let value = raw.trim();
    if value.is_empty()
        || value.eq_ignore_ascii_case("aliyun")
        || value.eq_ignore_ascii_case(PLUGIN_ID_ALIYUN)
    {
        return Ok(PLUGIN_ID_ALIYUN.to_string());
    }
    if value.eq_ignore_ascii_case("tencent")
        || value.eq_ignore_ascii_case("qcloud")
        || value.eq_ignore_ascii_case(PLUGIN_ID_TENCENT)
    {
        return Ok(PLUGIN_ID_TENCENT.to_string());
    }
    if value.contains('.') && !value.contains(char::is_whitespace) {
        return Ok(value.to_string());
    }
    Err(OmniError::invalid_input(format!("未知云厂商插件: {raw}")))
}

pub fn is_first_party_cloud(plugin_id: &str) -> bool {
    plugin_id == PLUGIN_ID_ALIYUN || plugin_id == PLUGIN_ID_TENCENT
}

pub fn default_region(plugin_id: &str) -> &'static str {
    if plugin_id == PLUGIN_ID_TENCENT {
        omnipanel_cloud_tencent::DEFAULT_REGION
    } else {
        "cn-hangzhou"
    }
}

pub fn http_probe_url(plugin_id: &str) -> &'static str {
    if plugin_id == PLUGIN_ID_TENCENT {
        "https://cvm.tencentcloudapi.com/"
    } else {
        "https://ecs.aliyuncs.com/"
    }
}

pub fn is_tencent(plugin_id: &str) -> bool {
    plugin_id == PLUGIN_ID_TENCENT
}

fn native_or_l2(plugin_id: &str) -> Result<String, OmniError> {
    let id = resolve_plugin_id(plugin_id)?;
    if is_first_party_cloud(&id) {
        return Ok(id);
    }
    Err(OmniError::invalid_input(format!(
        "云厂商 {id} 由插件 L2 承接"
    )))
}

pub async fn test_account(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<String, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver.test_account(creds, http).await
    } else {
        AliyunCloudDriver.test_account(creds, http).await
    }
}

pub async fn list_regions(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    configured: &[String],
) -> Result<Vec<CloudRegion>, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver
            .list_regions(creds, http, configured)
            .await
    } else {
        AliyunCloudDriver
            .list_regions(creds, http, configured)
            .await
    }
}

pub async fn get_account(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<CloudAccountSnapshot, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver.get_account(creds, http).await
    } else {
        AliyunCloudDriver.get_account(creds, http).await
    }
}

pub async fn list_resources(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    capability: &str,
    filter: &CloudResourceFilter,
) -> Result<Vec<CloudResourceRow>, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver
            .list_resources(creds, http, capability, filter)
            .await
    } else {
        AliyunCloudDriver
            .list_resources(creds, http, capability, filter)
            .await
    }
}

pub async fn get_resource(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    capability: &str,
    resource_id: &str,
    region_id: &str,
) -> Result<CloudResourceDetail, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver
            .get_resource(creds, http, capability, resource_id, region_id)
            .await
    } else {
        AliyunCloudDriver
            .get_resource(creds, http, capability, resource_id, region_id)
            .await
    }
}

pub async fn invoke_action(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
) -> Result<CloudActionResult, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver.invoke_action(creds, http, action).await
    } else {
        AliyunCloudDriver.invoke_action(creds, http, action).await
    }
}

pub async fn get_metrics(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    capability: &str,
    resource_id: &str,
    region_id: &str,
    query: &CloudMetricQuery,
) -> Result<Vec<CloudMetricSeries>, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver
            .get_metrics(creds, http, capability, resource_id, region_id, query)
            .await
    } else {
        AliyunCloudDriver
            .get_metrics(creds, http, capability, resource_id, region_id, query)
            .await
    }
}

pub async fn query_logs(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    capability: &str,
    resource_id: &str,
    region_id: &str,
    query: &CloudLogQuery,
) -> Result<CloudLogPage, OmniError> {
    if native_or_l2(plugin_id)? == PLUGIN_ID_TENCENT {
        TencentCloudDriver
            .query_logs(creds, http, capability, resource_id, region_id, query)
            .await
    } else {
        AliyunCloudDriver
            .query_logs(creds, http, capability, resource_id, region_id, query)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_both_vendors() {
        assert_eq!(resolve_plugin_id("").unwrap(), PLUGIN_ID_ALIYUN);
        assert_eq!(resolve_plugin_id("aliyun").unwrap(), PLUGIN_ID_ALIYUN);
        assert_eq!(resolve_plugin_id("tencent").unwrap(), PLUGIN_ID_TENCENT);
        assert_eq!(resolve_plugin_id("qcloud").unwrap(), PLUGIN_ID_TENCENT);
        assert_eq!(
            resolve_plugin_id("omni.cloud.tencent").unwrap(),
            PLUGIN_ID_TENCENT
        );
        assert_eq!(
            resolve_plugin_id("omni.cloud.aws").unwrap(),
            "omni.cloud.aws"
        );
        assert!(!is_first_party_cloud("omni.cloud.aws"));
        assert!(is_first_party_cloud(PLUGIN_ID_ALIYUN));
    }
}
