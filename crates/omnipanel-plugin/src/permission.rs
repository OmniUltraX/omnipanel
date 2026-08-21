use serde::{Deserialize, Serialize};
use specta::Type;

use crate::error::PluginError;

/// 清单声明的 Host API 权限。缺权调用 MUST 失败。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Type)]
pub enum PluginPermission {
    #[serde(rename = "vault:read")]
    VaultRead,
    #[serde(rename = "connections:write")]
    ConnectionsWrite,
    #[serde(rename = "net:connect")]
    NetConnect,
    #[serde(rename = "ssh:exec")]
    SshExec,
    #[serde(rename = "ui:selection")]
    UiSelection,
    #[serde(rename = "ui:sidebar")]
    UiSidebar,
    #[serde(rename = "ai:tools")]
    AiTools,
    #[serde(rename = "fs:read")]
    FsRead,
}

impl PluginPermission {
    pub fn parse(raw: &str) -> Result<Self, PluginError> {
        match raw.trim() {
            "vault:read" => Ok(Self::VaultRead),
            "connections:write" => Ok(Self::ConnectionsWrite),
            "net:connect" => Ok(Self::NetConnect),
            "ssh:exec" => Ok(Self::SshExec),
            "ui:selection" => Ok(Self::UiSelection),
            "ui:sidebar" => Ok(Self::UiSidebar),
            "ai:tools" => Ok(Self::AiTools),
            "fs:read" => Ok(Self::FsRead),
            other => Err(PluginError::InvalidManifest(format!("未知权限: {other}"))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::VaultRead => "vault:read",
            Self::ConnectionsWrite => "connections:write",
            Self::NetConnect => "net:connect",
            Self::SshExec => "ssh:exec",
            Self::UiSelection => "ui:selection",
            Self::UiSidebar => "ui:sidebar",
            Self::AiTools => "ai:tools",
            Self::FsRead => "fs:read",
        }
    }
}
