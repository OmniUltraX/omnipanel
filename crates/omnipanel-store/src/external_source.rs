//! 连接 config 中的外部血缘：`externalSource`，兼容旧 `cloudSource`。

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// 导入、云「加入终端」、发现扫描共用的血缘字段。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSource {
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub remote_id: String,
    pub remote_kind: String,
}

/// 历史阿里云「加入」字段。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyCloudSource {
    account_id: String,
    kind: String,
    resource_id: String,
}

const DEFAULT_CLOUD_PLUGIN_ID: &str = "omni.cloud.aliyun";

impl ExternalSource {
    fn from_legacy_cloud(src: &LegacyCloudSource) -> Self {
        Self {
            plugin_id: DEFAULT_CLOUD_PLUGIN_ID.into(),
            account_id: Some(src.account_id.clone()),
            remote_id: src.resource_id.clone(),
            remote_kind: src.kind.clone(),
        }
    }

    pub fn dedupe_key(&self) -> (String, String, String) {
        (
            self.plugin_id.clone(),
            self.account_id.clone().unwrap_or_default(),
            self.remote_id.clone(),
        )
    }
}

/// 从连接 `config` JSON 读取血缘：优先 `externalSource`，否则迁移 `cloudSource`。
pub fn parse_external_source(config_json: &str) -> Option<ExternalSource> {
    let value: Value = serde_json::from_str(config_json).ok()?;
    parse_external_source_value(&value)
}

pub fn parse_external_source_value(value: &Value) -> Option<ExternalSource> {
    if let Some(src) = value.get("externalSource") {
        if let Ok(parsed) = serde_json::from_value::<ExternalSource>(src.clone()) {
            if !parsed.plugin_id.is_empty() && !parsed.remote_id.is_empty() {
                return Some(parsed);
            }
        }
    }
    value
        .get("cloudSource")
        .and_then(|v| serde_json::from_value::<LegacyCloudSource>(v.clone()).ok())
        .map(|legacy| ExternalSource::from_legacy_cloud(&legacy))
}

/// 将旧 `cloudSource` 提升为 `externalSource`（保留旧字段以便旧前端读取）。
pub fn migrate_cloud_source_in_config(config_json: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(config_json) else {
        return config_json.to_string();
    };
    let Some(obj) = value.as_object_mut() else {
        return config_json.to_string();
    };
    if obj.contains_key("externalSource") {
        return config_json.to_string();
    }
    let Some(legacy) = obj
        .get("cloudSource")
        .cloned()
        .and_then(|v| serde_json::from_value::<LegacyCloudSource>(v).ok())
    else {
        return config_json.to_string();
    };
    if let Ok(src) = serde_json::to_value(ExternalSource::from_legacy_cloud(&legacy)) {
        obj.insert("externalSource".into(), src);
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_new_field() {
        let json = r#"{"host":"1.2.3.4","externalSource":{"pluginId":"omni.cloud.aliyun","accountId":"a1","remoteId":"i-1","remoteKind":"ecs"}}"#;
        let src = parse_external_source(json).unwrap();
        assert_eq!(src.plugin_id, "omni.cloud.aliyun");
        assert_eq!(src.account_id.as_deref(), Some("a1"));
        assert_eq!(src.remote_id, "i-1");
        assert_eq!(src.remote_kind, "ecs");
    }

    #[test]
    fn migrates_legacy_cloud_source() {
        let json = r#"{"host":"1.2.3.4","cloudSource":{"accountId":"acc","kind":"oss","resourceId":"bucket-1"}}"#;
        let src = parse_external_source(json).unwrap();
        assert_eq!(src.plugin_id, "omni.cloud.aliyun");
        assert_eq!(src.account_id.as_deref(), Some("acc"));
        assert_eq!(src.remote_id, "bucket-1");
        assert_eq!(src.remote_kind, "oss");

        let migrated = migrate_cloud_source_in_config(json);
        let value: Value = serde_json::from_str(&migrated).unwrap();
        assert!(value.get("externalSource").is_some());
        assert!(value.get("cloudSource").is_some());
        let again = parse_external_source(&migrated).unwrap();
        assert_eq!(again, src);
    }
}
