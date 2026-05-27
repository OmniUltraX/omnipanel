use crate::ir::{StreamEvent, ToolStatus};
use crate::providers::acp::types::SessionUpdate;

/// Translate an ACP `session/update` notification into one or more IR StreamEvents.
///
/// This is the core of the ACP → standard chat translation layer,
/// mirroring cli-agent-gateway's `TranslateSessionUpdate`.
pub fn translate_session_update(update: &SessionUpdate) -> Vec<StreamEvent> {
    match update {
        SessionUpdate::AgentMessageChunk { content } => {
            let text = extract_text(content);
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentDelta { text }]
            }
        }
        SessionUpdate::AgentThoughtChunk { content } => {
            let text = extract_text(content);
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ReasoningDelta { text }]
            }
        }
        SessionUpdate::ToolCall { content } => {
            let (name, arguments) = extract_tool_call(content);
            vec![StreamEvent::ToolCall {
                id: format!("acp_call_{}", uuid_simple()),
                name,
                arguments,
            }]
        }
        SessionUpdate::ToolCallUpdate { content } => {
            let id = content
                .get("toolCallId")
                .or_else(|| content.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let status = content
                .get("status")
                .and_then(|v| v.as_str())
                .map(parse_tool_status)
                .unwrap_or(ToolStatus::Running);
            vec![StreamEvent::ToolCallUpdate { id, status }]
        }
        SessionUpdate::Plan { content } => {
            let text = extract_text(content);
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentDelta {
                    text: format!("📝 **Plan:**\n{}\n", text),
                }]
            }
        }
        // User message chunks and other updates are trace-only
        SessionUpdate::UserMessageChunk { .. }
        | SessionUpdate::AvailableCommandsUpdate { .. }
        | SessionUpdate::CurrentModeUpdate { .. } => vec![],
    }
}

/// Extract text from an ACP content field.
/// The content can be a string or an object with a "text" field,
/// or an array of content blocks.
fn extract_text(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Object(obj) => {
            if let Some(serde_json::Value::String(text)) = obj.get("text") {
                return text.clone();
            }
            // Try to extract from content array
            if let Some(serde_json::Value::Array(blocks)) = obj.get("content") {
                return blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
            }
            String::new()
        }
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Extract tool name and arguments from an ACP tool_call content.
fn extract_tool_call(content: &serde_json::Value) -> (String, String) {
    let name = content
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let arguments = content
        .get("arguments")
        .map(|v| {
            if v.is_string() {
                v.as_str().unwrap_or("{}").to_string()
            } else {
                serde_json::to_string(v).unwrap_or_else(|_| "{}".to_string())
            }
        })
        .unwrap_or_else(|| "{}".to_string());

    (name, arguments)
}

fn parse_tool_status(s: &str) -> ToolStatus {
    match s {
        "pending" => ToolStatus::Pending,
        "running" => ToolStatus::Running,
        "completed" | "done" | "success" => ToolStatus::Completed,
        "failed" | "error" => ToolStatus::Failed,
        _ => ToolStatus::Running,
    }
}

/// Simple UUID-like random ID (no external dependency)
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:x}", t)
}
