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
