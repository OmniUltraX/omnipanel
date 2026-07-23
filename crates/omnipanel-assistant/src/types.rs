use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SNAPSHOT_SCHEMA_VERSION: u32 = 1;

/// 完整快照（上传到 OSS 的 JSON 根对象）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSnapshot {
    pub schema_version: u32,
    pub generated_at: String,
    pub client_device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bind_id: Option<String>,
    pub modules: AssistantSnapshotModules,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantSnapshotModules {
    pub terminal: ModuleSection,
    pub database: ModuleSection,
    pub docker: ModuleSection,
    pub files: ModuleSection,
    pub server: ModuleSection,
    pub knowledge: ModuleSection,
    pub protocol: ModuleSection,
    pub tasks: ModuleSection,
}

/// 单模块载荷：正常为 items；采集失败时带 error。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleSection {
    #[serde(default)]
    pub items: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Default for ModuleSection {
    fn default() -> Self {
        Self {
            items: Vec::new(),
            error: None,
        }
    }
}

impl ModuleSection {
    pub fn from_items(items: Vec<Value>) -> Self {
        Self { items, error: None }
    }

    pub fn from_error(message: impl Into<String>) -> Self {
        Self {
            items: Vec::new(),
            error: Some(message.into()),
        }
    }
}
