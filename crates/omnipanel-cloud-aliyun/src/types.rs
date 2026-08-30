use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use specta::Type;

pub const PLUGIN_ID_ALIYUN: &str = "omni.cloud.aliyun";

pub const CAP_COMPUTE: &str = "compute";
pub const CAP_COMPUTE_LITE: &str = "compute.lite";
pub const CAP_OBJECT_STORAGE: &str = "objectStorage";
pub const CAP_DOMAINS: &str = "domains";
pub const CAP_DNS: &str = "dns";
pub const CAP_CERTS: &str = "certs";
pub const CAP_CDN: &str = "cdn";

pub const ACTION_START: &str = "start";
pub const ACTION_STOP: &str = "stop";
pub const ACTION_REBOOT: &str = "reboot";

/// 写操作：生产环境必须 `confirmed` 才允许打厂商 API。
pub fn is_write_action(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        ACTION_START | ACTION_STOP | ACTION_REBOOT
    )
}

pub fn is_global_capability(capability: &str) -> bool {
    matches!(
        capability.trim(),
        CAP_DOMAINS | CAP_DNS | CAP_CERTS | CAP_CDN
    )
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRegion {
    pub region_id: String,
    pub local_name: String,
    /// 该地域已探测到的能力 id（如 `compute` / `compute.lite`）。
    #[serde(default)]
    pub capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudResourceFilter {
    #[serde(default)]
    pub regions: Vec<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub query: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudResourceRow {
    pub id: String,
    pub name: String,
    pub capability: String,
    #[serde(default)]
    pub region_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudResourceDetail {
    pub id: String,
    pub name: String,
    pub capability: String,
    #[serde(default)]
    pub region_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
    /// 原始厂商 JSON；不走 specta（裸 Value 会把 bindings 导出撑爆）。
    #[serde(default)]
    #[specta(skip)]
    pub extra: serde_json::Value,
    #[serde(default)]
    pub console_url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudAction {
    pub name: String,
    #[serde(default)]
    pub resource_id: String,
    #[serde(default)]
    pub capability: String,
    #[serde(default)]
    pub region_id: String,
    /// 已废弃：写操作改走 `presence_token`，前端不得再靠此字段放行。
    #[serde(default)]
    pub confirmed: bool,
    /// 写操作短命在场 token（一次性消费）。
    #[serde(default)]
    pub presence_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudActionResult {
    pub ok: bool,
    #[serde(default)]
    pub message: String,
}

/// 账户身份与余额（余额接口无权限时仍返回身份，`balanceError` 说明原因）。
#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudAccountSnapshot {
    #[serde(default)]
    pub caller_id: String,
    #[serde(default)]
    pub arn: String,
    #[serde(default)]
    pub currency: String,
    #[serde(default)]
    pub available_amount: String,
    #[serde(default)]
    pub cash_amount: String,
    #[serde(default)]
    pub credit_amount: String,
    #[serde(default)]
    pub balance_error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_actions_are_gated() {
        assert!(is_write_action("start"));
        assert!(is_write_action("STOP"));
        assert!(is_write_action("reboot"));
        assert!(!is_write_action("openConsole"));
        assert!(!is_write_action("addSsh"));
    }

    #[test]
    fn global_capabilities() {
        assert!(is_global_capability(CAP_DOMAINS));
        assert!(is_global_capability(CAP_CERTS));
        assert!(!is_global_capability(CAP_COMPUTE));
        assert!(!is_global_capability(CAP_OBJECT_STORAGE));
    }
}
