use serde::{Deserialize, Serialize};

use crate::types::ChatMessage;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AiContextBundle {
    pub cwd: Option<String>,
    pub workspace_id: Option<String>,
    pub terminal_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_session_type: Option<String>,
    pub env_tag: Option<String>,
    pub resource_id: Option<String>,
    /// 终端环境描述（shell/OS/主机等），注入 ACP client-tools prompt。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_context_append: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HttpProviderSnapshot {
    pub provider_id: String,
    pub api_standard: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InternalToolsMode {
    None,
    DirectInject {
        module_filter: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalChatRequest {
    pub conversation_id: String,
    pub user_text: String,
    pub backend_id: String,
    pub context: AiContextBundle,
    pub history: Option<Vec<ChatMessage>>,
    pub tools_mode: InternalToolsMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_provider: Option<HttpProviderSnapshot>,
    /// 追加到系统提示的文本（如 Skills 目录）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_append: Option<String>,
}
