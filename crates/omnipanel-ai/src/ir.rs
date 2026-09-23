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
    /// OpenCode `question.asked` / `form.created`：结构化澄清，需前端 reply/reject。
    QuestionAsk {
        request_id: String,
        session_id: String,
        /// JSON 数组：`[{ question, header, options:[{label,description}], multiple?, custom? }]`
        /// form 场景由 turn 层把 `Form.Field[]` 映射成同一形状（id=field.key）。
        questions_json: String,
        /// `"question"`（旧 API）| `"form"`（V2 `/api/session/.../form/.../reply`）
        #[serde(default = "default_question_ask_kind")]
        kind: String,
        /// form 标题（可选）；question 场景可为空
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// OpenCode `permission.asked`（string id `per_*`），与 ACP 的 u64 request_id 分离。
    OpenCodePermissionAsk {
        request_id: String,
        session_id: String,
        title: String,
        raw_input: String,
    },
}

fn default_question_ask_kind() -> String {
    "question".into()
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
