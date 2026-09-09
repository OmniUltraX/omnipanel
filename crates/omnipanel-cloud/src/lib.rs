//! 云厂商 Host 分发：按 pluginId 路由到具体 Driver。
//! 阿里云仍走原生 crate；腾讯云、华为云与其它厂商走插件 L2（`plugin_invoke`）。

use omnipanel_cloud_aliyun::{AliyunCloudDriver, AliyunCredentials, CloudProviderDriver};
use omnipanel_error::OmniError;
use reqwest::Client;

pub use omnipanel_cloud_aliyun::{
    is_write_action, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudLogPage,
    CloudLogQuery, CloudMetricQuery, CloudMetricSeries, CloudRegion, CloudResourceDetail,
    CloudResourceFilter, CloudResourceRow, PLUGIN_ID_ALIYUN,
};

pub const PLUGIN_ID_TENCENT: &str = "omni.cloud.tencent";
pub const PLUGIN_ID_HUAWEI: &str = "omni.cloud.huawei";
pub const TENCENT_DEFAULT_REGION: &str = "ap-guangzhou";
pub const HUAWEI_DEFAULT_REGION: &str = "cn-north-4";

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
    if value.eq_ignore_ascii_case("huawei")
        || value.eq_ignore_ascii_case("hwc")
        || value.eq_ignore_ascii_case("hwcloud")
        || value.eq_ignore_ascii_case(PLUGIN_ID_HUAWEI)
    {
        return Ok(PLUGIN_ID_HUAWEI.to_string());
    }
    if value.contains('.') && !value.contains(char::is_whitespace) {
        return Ok(value.to_string());
    }
    Err(OmniError::invalid_input(format!("未知云厂商插件: {raw}")))
}

pub fn is_first_party_cloud(plugin_id: &str) -> bool {
    plugin_id == PLUGIN_ID_ALIYUN
}

pub fn default_region(plugin_id: &str) -> &'static str {
    if plugin_id == PLUGIN_ID_TENCENT {
        TENCENT_DEFAULT_REGION
    } else if plugin_id == PLUGIN_ID_HUAWEI {
        HUAWEI_DEFAULT_REGION
    } else {
        "cn-hangzhou"
    }
}

pub fn http_probe_url(plugin_id: &str) -> &'static str {
    if plugin_id == PLUGIN_ID_TENCENT {
        "https://cvm.tencentcloudapi.com/"
    } else if plugin_id == PLUGIN_ID_HUAWEI {
        "https://iam.myhuaweicloud.com/"
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
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver.test_account(creds, http).await
}

pub async fn list_regions(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    configured: &[String],
) -> Result<Vec<CloudRegion>, OmniError> {
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver
        .list_regions(creds, http, configured)
        .await
}

pub async fn get_account(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
) -> Result<CloudAccountSnapshot, OmniError> {
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver.get_account(creds, http).await
}

pub async fn list_resources(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    capability: &str,
    filter: &CloudResourceFilter,
) -> Result<Vec<CloudResourceRow>, OmniError> {
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver
        .list_resources(creds, http, capability, filter)
        .await
}

pub async fn get_resource(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    capability: &str,
    resource_id: &str,
    region_id: &str,
) -> Result<CloudResourceDetail, OmniError> {
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver
        .get_resource(creds, http, capability, resource_id, region_id)
        .await
}

pub async fn invoke_action(
    plugin_id: &str,
    creds: &AliyunCredentials,
    http: &Client,
    action: &CloudAction,
) -> Result<CloudActionResult, OmniError> {
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver.invoke_action(creds, http, action).await
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
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver
        .get_metrics(creds, http, capability, resource_id, region_id, query)
        .await
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
    let _ = native_or_l2(plugin_id)?;
    AliyunCloudDriver
        .query_logs(creds, http, capability, resource_id, region_id, query)
        .await
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
        assert_eq!(resolve_plugin_id("huawei").unwrap(), PLUGIN_ID_HUAWEI);
        assert_eq!(resolve_plugin_id("hwc").unwrap(), PLUGIN_ID_HUAWEI);
        assert_eq!(
            resolve_plugin_id("omni.cloud.huawei").unwrap(),
            PLUGIN_ID_HUAWEI
        );
        assert_eq!(
            resolve_plugin_id("omni.cloud.aws").unwrap(),
            "omni.cloud.aws"
        );
        assert!(!is_first_party_cloud("omni.cloud.aws"));
        assert!(!is_first_party_cloud(PLUGIN_ID_TENCENT));
        assert!(!is_first_party_cloud(PLUGIN_ID_HUAWEI));
        assert!(is_first_party_cloud(PLUGIN_ID_ALIYUN));
    }
}
