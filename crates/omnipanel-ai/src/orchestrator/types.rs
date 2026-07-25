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
    /// 模块级上下文（数据库连接 / SSH 主机 / Docker 等），由前端 ContextProvider 聚合后注入 system prompt。
    /// 与 terminal_context_append 互补：后者专给终端，本字段聚合其他模块的结构化上下文。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_context_append: Option<String>,
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
    /// 纯文本补全模式（oneshot 场景：会话命名、历史摘要等）。
    /// 为 true 时：
    /// - 跳过 CLIENT_TOOLS_PREAMBLE + master 工具清单注入
    /// - 跳过 RAG / Skills 注入
    /// - prompt_text 直接使用 user_text，不包裹 [User] 块
    /// - MAX_ACP_TOOL_ROUNDS = 1（单轮，不进入工具调用循环）
    /// 适用于不需要工具调用、不需要多轮、只需要模型根据 prompt 直接输出文本的场景。
    #[serde(default)]
    pub pure_text: bool,
    /// 推理强度：`default` | `low` | `medium` | `high`。
    /// 非 pure_text 时会映射为请求体的 `enable_thinking` / `reasoning_effort`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
}
