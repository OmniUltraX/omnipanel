use crate::ir::{StreamEvent, ToolStatus};
use crate::providers::acp::types::SessionUpdateNotification;

/// Translate an ACP `session/update` notification into IR StreamEvents (SDK v1).
pub fn translate_session_update(params: &SessionUpdateNotification) -> Vec<StreamEvent> {
    translate_update_value(&params.update)
}

pub fn translate_update_value(update: &serde_json::Value) -> Vec<StreamEvent> {
    let kind = update
        .get("sessionUpdate")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match kind {
        "agent_message_chunk" | "user_message_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentDelta { text }]
            }
        }
        "agent_thought_chunk" => {
            let text = extract_content_text(update.get("content"));
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ReasoningDelta { text }]
            }
        }
        "tool_call" => {
            let tool_call_id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let title = update
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let raw_input = update.get("rawInput").cloned().unwrap_or(serde_json::Value::Null);
            let arguments = serde_json::to_string(&raw_input).unwrap_or_else(|_| "{}".to_string());
            vec![StreamEvent::ToolCall {
                id: tool_call_id,
                name: title,
                arguments,
            }]
        }
        "tool_call_update" => {
            let id = update
                .get("toolCallId")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let status = update
                .get("status")
                .and_then(|v| v.as_str())
                .map(parse_tool_status)
                .unwrap_or(ToolStatus::Running);
            let result = update.get("rawOutput").map(|v| {
                if v.is_string() {
                    v.as_str().unwrap_or("").to_string()
                } else {
                    serde_json::to_string(v).unwrap_or_default()
                }
            });
            vec![StreamEvent::ToolCallUpdate {
                id,
                status,
                result,
            }]
        }
        "plan" => {
            let text = extract_plan_text(update);
            if text.is_empty() {
                vec![]
            } else {
                vec![StreamEvent::ContentDelta {
                    text: format!("📝 **Plan:**\n{text}\n"),
                }]
            }
        }
        _ => vec![],
    }
}

fn extract_content_text(content: Option<&serde_json::Value>) -> String {
    match content {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Object(obj)) => {
            if let Some(serde_json::Value::String(text)) = obj.get("text") {
                return text.clone();
            }
            if let Some(serde_json::Value::Array(blocks)) = obj.get("content") {
                return blocks
                    .iter()
                    .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
                    .collect::<Vec<_>>()
                    .join("");
            }
            String::new()
        }
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|v| v.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn extract_plan_text(update: &serde_json::Value) -> String {
    if let Some(entries) = update.get("entries").and_then(|v| v.as_array()) {
        return entries
            .iter()
            .filter_map(|e| e.get("content").and_then(|c| c.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
    }
    extract_content_text(update.get("content"))
}

fn parse_tool_status(s: &str) -> ToolStatus {
    match s {
        "pending" => ToolStatus::Pending,
        "in_progress" | "running" => ToolStatus::Running,
        "completed" | "done" | "success" => ToolStatus::Completed,
        "failed" | "error" => ToolStatus::Failed,
        _ => ToolStatus::Running,
    }
}
