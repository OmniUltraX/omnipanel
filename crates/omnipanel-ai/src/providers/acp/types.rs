use serde::{Deserialize, Serialize};

// ─── ACP JSON-RPC base types ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: String,
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: String,
    pub id: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

// ─── ACP Protocol Messages ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeParams {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "clientInfo")]
    pub client_info: ClientInfo,
    pub capabilities: ClientCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientCapabilities {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitializeResult {
    #[serde(rename = "protocolVersion")]
    pub protocol_version: u32,
    #[serde(rename = "agentInfo")]
    pub agent_info: AgentInfo,
    #[serde(rename = "authMethods")]
    pub auth_methods: Option<Vec<AuthMethod>>,
    #[serde(rename = "agentCapabilities")]
    pub agent_capabilities: AgentCapabilities,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthMethod {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub auth_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCapabilities {
    #[serde(default)]
    pub models: Option<Vec<String>>,
    #[serde(default)]
    pub tools: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticateParams {
    #[serde(rename = "methodId")]
    pub method_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionNewParams {
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionNewResult {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "configOptions")]
    pub config_options: Option<Vec<ConfigOption>>,
    pub models: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigOption {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub option_type: String,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSetConfigOptionParams {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "optionId")]
    pub option_id: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSetModelParams {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPromptParams {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptResult {
    #[serde(rename = "stopReason")]
    pub stop_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionLoadParams {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub prompt: String,
}

// ─── session/update notification ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionUpdateParams {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    #[serde(rename = "sessionUpdate")]
    pub session_update: SessionUpdate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SessionUpdate {
    UserMessageChunk {
        content: serde_json::Value,
    },
    AgentMessageChunk {
        content: serde_json::Value,
    },
    AgentThoughtChunk {
        content: serde_json::Value,
    },
    ToolCall {
        content: serde_json::Value,
    },
    ToolCallUpdate {
        content: serde_json::Value,
    },
    Plan {
        content: serde_json::Value,
    },
    AvailableCommandsUpdate {
        content: serde_json::Value,
    },
    CurrentModeUpdate {
        content: serde_json::Value,
    },
}

// ─── session/request_permission ───

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestPermissionParams {
    #[serde(rename = "sessionId")]
    pub session_id: String,
    pub permission: PermissionRequest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    pub tool: String,
    pub description: String,
    pub arguments: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionResponse {
    pub outcome: PermissionOutcome,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionOutcome {
    AllowOnce,
    DenyOnce,
    AllowAlways,
    DenyAlways,
}

// ─── ACP Profile (controls permission behavior) ───

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpProfile {
    /// Auto-approve all tool calls; agent executes tools itself
    Agentic,
    /// Reject native tools, translate to client tool_calls
    ClientTools,
    /// Reject all tools, read-only / planning mode
    Plan,
}

impl AcpProfile {
    /// Determine the permission response for this profile
    pub fn decide_permission(&self) -> (PermissionOutcome, bool) {
        match self {
            AcpProfile::Agentic => (PermissionOutcome::AllowOnce, false),
            AcpProfile::ClientTools => (PermissionOutcome::DenyOnce, true),
            AcpProfile::Plan => (PermissionOutcome::DenyOnce, false),
        }
    }
}
