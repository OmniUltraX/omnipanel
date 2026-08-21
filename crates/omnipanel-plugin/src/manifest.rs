use serde::{Deserialize, Serialize};
use specta::Type;

use crate::contribution::PluginContributes;
use crate::error::PluginError;
use crate::kind::PluginKind;
use crate::permission::PluginPermission;
use crate::platform::PluginPlatform;

/// 插件装载合同。第一方与后续磁盘/WASM 包共用。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    pub kind: PluginKind,
    #[serde(default)]
    pub contributes: PluginContributes,
    #[serde(default)]
    pub permissions: Vec<PluginPermission>,
    /// 缺省 = 全平台；当前 OS 不在列表中则不 activate。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platforms: Option<Vec<PluginPlatform>>,
}

impl PluginManifest {
    pub fn from_json(raw: &str) -> Result<Self, PluginError> {
        let value: serde_json::Value = serde_json::from_str(raw).map_err(|e| {
            PluginError::InvalidManifest(format!("清单 JSON 无法解析: {e}"))
        })?;
        Self::from_value(value)
    }

    pub fn from_value(value: serde_json::Value) -> Result<Self, PluginError> {
        if let Some(kind) = value.get("kind").and_then(|v| v.as_str()) {
            PluginKind::parse(kind).map_err(PluginError::UnknownKind)?;
        } else {
            return Err(PluginError::InvalidManifest("清单缺少 kind".into()));
        }
        serde_json::from_value(value).map_err(|e| PluginError::InvalidManifest(e.to_string()))
    }

    pub fn validate(&self) -> Result<(), PluginError> {
        if self.id.trim().is_empty() {
            return Err(PluginError::InvalidManifest("清单 id 不能为空".into()));
        }
        if self.version.trim().is_empty() {
            return Err(PluginError::InvalidManifest("清单 version 不能为空".into()));
        }
        if self.kind == PluginKind::Theme && !self.permissions.is_empty() {
            return Err(PluginError::InvalidManifest(
                "theme 插件 permissions 必须为空".into(),
            ));
        }
        Ok(())
    }

    pub fn supports_platform(&self, os: PluginPlatform) -> bool {
        match &self.platforms {
            None => true,
            Some(list) if list.is_empty() => true,
            Some(list) => list.contains(&os),
        }
    }
}
