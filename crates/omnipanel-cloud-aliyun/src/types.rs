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
pub const CAP_SECURITY_GROUP: &str = "network.securityGroup";
pub const CAP_DATABASE: &str = "database";
pub const CAP_DATABASE_CACHE: &str = "database.cache";
pub const CAP_NETWORK_EIP: &str = "network.eip";
pub const CAP_LOAD_BALANCER: &str = "network.loadBalancer";
pub const CAP_STORAGE_DISK: &str = "storage.disk";

pub const ACTION_START: &str = "start";
pub const ACTION_STOP: &str = "stop";
pub const ACTION_REBOOT: &str = "reboot";
pub const ACTION_AUTHORIZE_RULE: &str = "authorizeRule";
pub const ACTION_REVOKE_RULE: &str = "revokeRule";
pub const ACTION_MODIFY_RULE: &str = "modifyRule";
pub const ACTION_ATTACH: &str = "attach";
pub const ACTION_DETACH: &str = "detach";
pub const ACTION_ADD_RECORD: &str = "addRecord";
pub const ACTION_DELETE_RECORD: &str = "deleteRecord";
pub const ACTION_UPDATE_RECORD: &str = "updateRecord";
pub const ACTION_MODIFY_BANDWIDTH: &str = "modifyBandwidth";
pub const ACTION_CREATE_SNAPSHOT: &str = "createSnapshot";

/// 写操作：生产环境必须 presence token 才允许打厂商 API。
pub fn is_write_action(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "start"
            | "stop"
            | "reboot"
            | "authorizerule"
            | "revokerule"
            | "modifyrule"
            | "attach"
            | "detach"
            | "addrecord"
            | "deleterecord"
            | "updaterecord"
            | "modifybandwidth"
            | "createsnapshot"
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

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudRelatedRef {
    pub capability: String,
    pub resource_id: String,
    #[serde(default)]
    pub name: String,
    /// 如 `securityGroup` / `vpc` / `disk`。
    #[serde(default)]
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudNetworkRule {
    #[serde(default)]
    pub id: String,
    /// `ingress` / `egress`。
    #[serde(default)]
    pub direction: String,
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub port_range: String,
    #[serde(default)]
    pub cidr: String,
    #[serde(default)]
    pub source_group_id: String,
    /// `accept` / `drop`。
    #[serde(default)]
    pub policy: String,
    #[serde(default)]
    pub priority: String,
    #[serde(default)]
    pub nic_type: String,
    #[serde(default)]
    pub description: String,
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
    #[serde(default)]
    pub related: Vec<CloudRelatedRef>,
    #[serde(default)]
    pub rules: Vec<CloudNetworkRule>,
    /// 该资源默认可拉的监控指标 id（空则详情不展示监控 Tab）。
    #[serde(default)]
    pub metric_ids: Vec<String>,
    /// 如 `slow` / `error` / `access`。
    #[serde(default)]
    pub log_kinds: Vec<String>,
    /// 嵌套对象：解析记录、监听、后端、账号、备份、快照、参数。
    #[serde(default)]
    pub children: Vec<CloudChildRow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CloudChildRow {
    #[serde(default)]
    pub id: String,
    /// `dnsRecord` / `listener` / `backend` / `account` / `backup` / `parameter` / `snapshot` / `disk`。
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

impl CloudResourceDetail {
    pub fn from_row(row: CloudResourceRow, console_url: Option<String>) -> Self {
        Self {
            id: row.id,
            name: row.name,
            capability: row.capability,
            region_id: row.region_id,
            status: row.status,
            fields: row.fields,
            extra: serde_json::Value::Null,
            console_url,
            related: Vec::new(),
            rules: Vec::new(),
            metric_ids: Vec::new(),
            log_kinds: Vec::new(),
            children: Vec::new(),
        }
    }
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
    /// 规则编辑等附加字段（protocol / portRange / cidr / ruleId …）。
    #[serde(default)]
    pub params: BTreeMap<String, String>,
}

impl CloudAction {
    pub fn param(&self, key: &str) -> String {
        self.params
            .get(key)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudMetricQuery {
    #[serde(default)]
    pub metric_ids: Vec<String>,
    #[serde(default)]
    pub start_ms: i64,
    #[serde(default)]
    pub end_ms: i64,
    #[serde(default)]
    pub period_sec: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CloudMetricPoint {
    pub ts_ms: i64,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudMetricSeries {
    pub id: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub unit: String,
    #[serde(default)]
    pub points: Vec<CloudMetricPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudLogQuery {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub start_ms: i64,
    #[serde(default)]
    pub end_ms: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub page_size: i64,
    #[serde(default)]
    pub db_name: String,
    /// `time` | `duration`
    #[serde(default)]
    pub sort_key: String,
    /// `asc` | `desc`
    #[serde(default)]
    pub sort_dir: String,
    #[serde(default)]
    pub keyword: String,
}

impl CloudLogQuery {
    pub fn trimmed_db_name(&self) -> Option<&str> {
        let value = self.db_name.trim();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    pub fn trimmed_keyword(&self) -> Option<&str> {
        let value = self.keyword.trim();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    }

    pub fn redis_order_by(&self) -> &'static str {
        if self.sort_key.trim().eq_ignore_ascii_case("duration") {
            "latency"
        } else {
            "execution_time"
        }
    }

    pub fn redis_order_type(&self) -> &'static str {
        if self.sort_dir.trim().eq_ignore_ascii_case("asc") {
            "ASC"
        } else {
            "DESC"
        }
    }
}

/// `DescribeSlowLogRecords` 查询跨度上限（阿里云文档：小于 31 天）。
pub const ALIYUN_SLOW_LOG_MAX_SPAN_MS: i64 = 31 * 24 * 3600_000;

fn normalize_epoch_ms(ts: i64) -> i64 {
    if ts > 0 && ts < 1_000_000_000_000 {
        ts.saturating_mul(1000)
    } else {
        ts
    }
}

/// 归一化慢日志起止时间：秒级时间戳升毫秒、截到 now、跨度不超过 31 天。
pub fn clamp_aliyun_slow_log_window(start_ms: i64, end_ms: i64, now_ms: i64) -> (i64, i64) {
    let now = now_ms.max(0);
    let mut end = normalize_epoch_ms(end_ms);
    if end <= 0 {
        end = now;
    }
    if now > 0 && end > now {
        end = now;
    }
    let mut start = normalize_epoch_ms(start_ms);
    if start <= 0 {
        start = end.saturating_sub(24 * 3600_000);
    }
    if start >= end {
        start = end.saturating_sub(3600_000);
    }
    if end.saturating_sub(start) > ALIYUN_SLOW_LOG_MAX_SPAN_MS {
        start = end.saturating_sub(ALIYUN_SLOW_LOG_MAX_SPAN_MS);
    }
    (start, end)
}

/// RDS / Redis `DescribeSlowLogRecords` 只接受 30 / 50 / 100。
pub fn clamp_aliyun_slow_log_page_size(page_size: i64) -> i64 {
    if page_size <= 30 {
        30
    } else if page_size <= 50 {
        50
    } else {
        100
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudLogEntry {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub ts_ms: i64,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub fields: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CloudLogPage {
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub total: i64,
    #[serde(default)]
    pub page: i64,
    #[serde(default)]
    pub entries: Vec<CloudLogEntry>,
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
        assert!(is_write_action("authorizeRule"));
        assert!(is_write_action("revokeRule"));
        assert!(is_write_action("attach"));
        assert!(is_write_action("addRecord"));
        assert!(is_write_action("createSnapshot"));
        assert!(!is_write_action("openConsole"));
        assert!(!is_write_action("addSsh"));
        assert!(is_global_capability(CAP_DNS));
    }

    #[test]
    fn global_capabilities() {
        assert!(is_global_capability(CAP_DOMAINS));
        assert!(is_global_capability(CAP_CERTS));
        assert!(!is_global_capability(CAP_COMPUTE));
        assert!(!is_global_capability(CAP_OBJECT_STORAGE));
    }
}
