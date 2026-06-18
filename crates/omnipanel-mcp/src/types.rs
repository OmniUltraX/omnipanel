use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

pub const BUILTIN_SERVICE_ID: &str = "omnimcp-builtin";
pub const BUILTIN_SERVICE_NAME: &str = "OmniMCP";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpTransportKind {
    Stdio,
    Sse,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpStdioTransport {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpSseTransport {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum McpTransport {
    Stdio { config: McpStdioTransport },
    Sse { config: McpSseTransport },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServiceConfig {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
    pub transport: McpTransport,
    #[specta(type = f64)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum McpServiceRuntimeStatus {
    Running,
    Stopped,
    Starting,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpServiceView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub builtin: bool,
    pub transport: McpTransport,
    #[specta(type = f64)]
    pub created_at: i64,
    pub status: McpServiceRuntimeStatus,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct McpToolCallResult {
    pub content: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServicesFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub services: Vec<McpServiceConfig>,
}

fn default_version() -> u32 {
    1
}

impl McpServiceConfig {
    pub fn builtin_omnimcp() -> Self {
        Self {
            id: BUILTIN_SERVICE_ID.to_string(),
            name: BUILTIN_SERVICE_NAME.to_string(),
            enabled: true,
            builtin: true,
            transport: McpTransport::Sse {
                config: McpSseTransport {
                    url: String::new(),
                },
            },
            created_at: 0,
        }
    }
}
