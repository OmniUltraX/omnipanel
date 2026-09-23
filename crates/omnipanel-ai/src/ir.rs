use serde::{Deserialize, Serialize};

/// Intermediate Representation — protocol-agnostic streaming events.
/// All providers (OpenAI, Anthropic, ACP) translate their native events
/// into this unified format before emitting to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEvent {
    ContentDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
    ToolCallUpdate {
        id: String,
        status: ToolStatus,
        #[serde(skip_serializing_if = "Option::is_none")]
        result: Option<String>,
    },
    Usage {
        input_tokens: u32,
        output_tokens: u32,
        /// 推理 token（OpenCode 等）；缺省 0
        #[serde(default)]
        reasoning_tokens: u32,
        /// 缓存读（OpenCode `cache.read`）；缺省 0
        #[serde(default)]
        cached_input_tokens: u32,
        /// 缓存写（OpenCode `cache.write`）；缺省 0
        #[serde(default)]
        cache_write_tokens: u32,
        /// 已算好的上下文总量（OpenCode：input+output+reasoning+cache）；缺省由前端汇总
        #[serde(default, skip_serializing_if = "Option::is_none")]
        total_tokens: Option<u32>,
    },
    Done {
        stop_reason: StopReason,
    },
    Error {
        message: String,
    },
    /// Agent requests user approval before running a tool (ACP session/request_permission).
    PermissionRequest {
        request_id: u64,
        tool_call_id: String,
        title: String,
        raw_input: String,
        options: Vec<(String, String)>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StopReason {
    EndTurn,
    ToolUse,
    MaxTokens,
    Error,
    Cancelled,
    Refusal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    Pending,
    Running,
    Completed,
    Failed,
}
