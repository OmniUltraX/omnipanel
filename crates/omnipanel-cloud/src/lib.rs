//! 云厂商 Host 辅助：pluginId 解析、默认区域。
//! 全部厂商经插件 L2（`plugin_invoke` / `cloud_*` → `invoke_cloud_plugin`）承接。

use omnipanel_error::OmniError;

pub use omnipanel_cloud_aliyun::{
    AliyunCredentials, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudCertificateItem,
    CloudDomainItem, CloudEcsInstance, CloudLogPage, CloudLogQuery, CloudMetricQuery,
    CloudMetricSeries, CloudOssBucket, CloudRegion, CloudResourceDetail, CloudResourceFilter,
    CloudResourceRow, CloudSwasInstance, PLUGIN_ID_ALIYUN, is_write_action,
};

pub const PLUGIN_ID_TENCENT: &str = "omni.cloud.tencent";
pub const PLUGIN_ID_HUAWEI: &str = "omni.cloud.huawei";
pub const PLUGIN_ID_AWS: &str = "omni.cloud.aws";
pub const PLUGIN_ID_AZURE: &str = "omni.cloud.azure";
pub const PLUGIN_ID_DIGITALOCEAN: &str = "omni.cloud.digitalocean";
pub const PLUGIN_ID_GCP: &str = "omni.cloud.gcp";
pub const PLUGIN_ID_BANDWAGON: &str = "omni.cloud.bandwagon";
pub const TENCENT_DEFAULT_REGION: &str = "ap-guangzhou";
pub const HUAWEI_DEFAULT_REGION: &str = "cn-north-4";
pub const AWS_DEFAULT_REGION: &str = "us-east-1";
pub const AZURE_DEFAULT_REGION: &str = "eastus";
pub const DIGITALOCEAN_DEFAULT_REGION: &str = "nyc1";
pub const GCP_DEFAULT_REGION: &str = "us-central1";
pub const BANDWAGON_DEFAULT_REGION: &str = "losangeles";

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
    if value.eq_ignore_ascii_case("aws") || value.eq_ignore_ascii_case(PLUGIN_ID_AWS) {
        return Ok(PLUGIN_ID_AWS.to_string());
    }
    if value.eq_ignore_ascii_case("azure") || value.eq_ignore_ascii_case(PLUGIN_ID_AZURE) {
        return Ok(PLUGIN_ID_AZURE.to_string());
    }
    if value.eq_ignore_ascii_case("digitalocean")
        || value.eq_ignore_ascii_case("do")
        || value.eq_ignore_ascii_case(PLUGIN_ID_DIGITALOCEAN)
    {
        return Ok(PLUGIN_ID_DIGITALOCEAN.to_string());
    }
    if value.eq_ignore_ascii_case("gcp")
        || value.eq_ignore_ascii_case("google")
        || value.eq_ignore_ascii_case("googlecloud")
        || value.eq_ignore_ascii_case(PLUGIN_ID_GCP)
    {
        return Ok(PLUGIN_ID_GCP.to_string());
    }
    if value.eq_ignore_ascii_case("bandwagon")
        || value.eq_ignore_ascii_case("bwh")
        || value.eq_ignore_ascii_case("banwagong")
        || value.eq_ignore_ascii_case(PLUGIN_ID_BANDWAGON)
    {
        return Ok(PLUGIN_ID_BANDWAGON.to_string());
    }
    if value.contains('.') && !value.contains(char::is_whitespace) {
        return Ok(value.to_string());
    }
    Err(OmniError::invalid_input(format!("未知云厂商插件: {raw}")))
}

/// 历史：仅阿里云走原生 crate。现全部 L2，恒为 false。
pub fn is_first_party_cloud(_plugin_id: &str) -> bool {
    false
}

pub fn default_region(plugin_id: &str) -> &'static str {
    if plugin_id == PLUGIN_ID_TENCENT {
        TENCENT_DEFAULT_REGION
    } else if plugin_id == PLUGIN_ID_HUAWEI {
        HUAWEI_DEFAULT_REGION
    } else if plugin_id == PLUGIN_ID_AWS {
        AWS_DEFAULT_REGION
    } else if plugin_id == PLUGIN_ID_AZURE {
        AZURE_DEFAULT_REGION
    } else if plugin_id == PLUGIN_ID_DIGITALOCEAN {
        DIGITALOCEAN_DEFAULT_REGION
    } else if plugin_id == PLUGIN_ID_GCP {
        GCP_DEFAULT_REGION
    } else if plugin_id == PLUGIN_ID_BANDWAGON {
        BANDWAGON_DEFAULT_REGION
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_aliases() {
        assert_eq!(resolve_plugin_id("aliyun").unwrap(), PLUGIN_ID_ALIYUN);
        assert_eq!(resolve_plugin_id("tencent").unwrap(), PLUGIN_ID_TENCENT);
        assert_eq!(resolve_plugin_id("qcloud").unwrap(), PLUGIN_ID_TENCENT);
        assert_eq!(
            resolve_plugin_id(PLUGIN_ID_TENCENT).unwrap(),
            PLUGIN_ID_TENCENT
        );
        assert_eq!(resolve_plugin_id("huawei").unwrap(), PLUGIN_ID_HUAWEI);
        assert!(!is_first_party_cloud("omni.cloud.aws"));
        assert!(!is_first_party_cloud(PLUGIN_ID_TENCENT));
        assert!(!is_first_party_cloud(PLUGIN_ID_HUAWEI));
        assert!(!is_first_party_cloud(PLUGIN_ID_ALIYUN));
    }
}
