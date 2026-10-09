use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{Response, header};
use futures::StreamExt;
use omnipanel_ai::ir::{StopReason, StreamEvent};
use omnipanel_ai::provider::AiProviderRegistry;
use omnipanel_ai::routing::parse_backend_id;
use omnipanel_ai::types::{ChatMessage, ChatRequest, Role, ToolCall};
use omnipanel_store::{AiSessionRecord, Storage};
use serde_json::json;
use tokio::sync::Mutex;
use tokio_stream::wrappers::ReceiverStream;

pub struct GatewayRouter {
    ai_registry: Arc<Mutex<AiProviderRegistry>>,
    storage: Option<Arc<Mutex<Storage>>>,
    sessions: Mutex<HashMap<String, Vec<ChatMessage>>>,
}

impl GatewayRouter {
    pub fn new(
        ai_registry: Arc<Mutex<AiProviderRegistry>>,
        storage: Option<Arc<Mutex<Storage>>>,
    ) -> Self {
        Self {
            ai_registry,
            storage,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn list_models(&self) -> Result<Vec<serde_json::Value>, String> {
        let mut out = Vec::new();

        // HTTP backends
        let registry = self.ai_registry.lock().await;
        for name in registry.list() {
            if let Some(provider) = registry.get(name) {
                for model in provider.models() {
                    out.push(json!({
                        "id": format!("http:{name}::{}", model.id),
                        "object": "model",
                        "owned_by": name,
                    }));
                }
            }
        }
        drop(registry);

        Ok(out)
    }

    pub async fn chat_completions(
        &self,
        model: String,
        messages: Vec<serde_json::Value>,
        stream: bool,
        tools: Option<Vec<serde_json::Value>>,
        conversation_id: String,
    ) -> Result<Response<Body>, String> {
        if !stream {
            return Err("当前仅支持 stream=true".to_string());
        }

        let fallback_id = format!("http:openai-compat::{model}");
        let backend_id = if model.contains("::") {
            model.as_str()
        } else {
            fallback_id.as_str()
        };
        let parsed = parse_backend_id(backend_id)?;

        let ts = now_ms();
        if let Some(storage) = &self.storage {
            let session = AiSessionRecord {
                id: conversation_id.clone(),
                backend_id: backend_id.to_string(),
                source: "gateway".to_string(),
                workspace_id: None,
                terminal_session_id: None,
                env_tag: None,
                title: None,
                created_at: ts,
                updated_at: ts,
            };
            let _ = storage.lock().await.ai_session_upsert(&session);
            let _ = storage.lock().await.ai_trace_append(
                &conversation_id,
                0,
                "gateway_request",
                &serde_json::json!({ "model": model, "backend_id": backend_id }).to_string(),
                ts,
            );
        }

        // ---- HTTP backend path ----
        let chat_messages = parse_openai_messages(messages)?;
        {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(conversation_id, chat_messages.clone());
        }

        let registry = self.ai_registry.lock().await;
        let provider = registry
            .get(&parsed.provider_id)
            .ok_or_else(|| format!("Provider '{}' 未注册", parsed.provider_id))?;

        let tool_defs = tools.map(|items| {
            items
                .into_iter()
                .filter_map(|t| serde_json::from_value(t).ok())
                .collect()
        });

        let request = ChatRequest {
            model: parsed.model_id.clone(),
            messages: chat_messages,
            stream: true,
            tools: tool_defs,
            temperature: None,
            max_tokens: None,
            enable_thinking: None,
            reasoning_effort: None,
        };

        let mut event_stream = provider
            .chat_stream(request)
            .await
            .map_err(|e| e.to_string())?;
        drop(registry);

        let (tx, rx) = tokio::sync::mpsc::channel::<String>(64);
        let response_model = model.clone();
        tokio::spawn(async move {
            let mut index = 0u64;
            while let Some(item) = event_stream.next().await {
                let (delta, finish_reason): (serde_json::Value, Option<&str>) = match item {
                    Ok(StreamEvent::ContentDelta { text }) => (json!({ "content": text }), None),
                    Ok(StreamEvent::ReasoningDelta { text }) => {
                        (json!({ "reasoning_content": text }), None)
                    }
                    Ok(StreamEvent::ToolCall {
                        id,
                        name,
                        arguments,
                    }) => {
                        let mut func = serde_json::Map::new();
                        if !name.is_empty() {
                            func.insert("name".to_string(), json!(name));
                        }
                        func.insert("arguments".to_string(), json!(arguments));
                        let mut call = serde_json::Map::new();
                        call.insert("index".to_string(), json!(0));
                        if !id.is_empty() {
                            call.insert("id".to_string(), json!(id));
                            call.insert("type".to_string(), json!("function"));
                        }
                        call.insert("function".to_string(), serde_json::Value::Object(func));
                        (
                            json!({ "tool_calls": [serde_json::Value::Object(call)] }),
                            None,
                        )
                    }
                    Ok(StreamEvent::Done { stop_reason }) => {
                        let finish = match stop_reason {
                            StopReason::ToolUse => "tool_calls",
                            StopReason::MaxTokens => "length",
                            StopReason::Refusal => "content_filter",
                            _ => "stop",
                        };
                        let chunk = json!({
                            "id": format!("chatcmpl-{index}"),
                            "object": "chat.completion.chunk",
                            "model": response_model,
                            "choices": [{ "index": 0, "delta": {}, "finish_reason": finish }]
                        });
                        let _ = tx.send(format!("data: {chunk}\n\n")).await;
                        let _ = tx.send("data: [DONE]\n\n".to_string()).await;
                        break;
                    }
                    Ok(StreamEvent::Error { message }) => {
                        let chunk = json!({ "error": { "message": message } });
                        let _ = tx.send(format!("data: {chunk}\n\n")).await;
                        break;
                    }
                    _ => continue,
                };

                let chunk = json!({
                    "id": format!("chatcmpl-{index}"),
                    "object": "chat.completion.chunk",
                    "model": response_model,
                    "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }]
                });
                if tx.send(format!("data: {chunk}\n\n")).await.is_err() {
                    break;
                }
                index += 1;
            }
        });

        let body =
            Body::from_stream(ReceiverStream::new(rx).map(Ok::<_, std::convert::Infallible>));

        Ok(Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(body)
            .unwrap())
    }

}

/// Parse OpenAI-format messages into `ChatMessage`s, preserving `tool_calls`,
/// `tool_call_id`, `name`, and handling array-form `content`.
fn parse_openai_messages(raw: Vec<serde_json::Value>) -> Result<Vec<ChatMessage>, String> {
    let mut out = Vec::new();
    for item in raw {
        let role = item.get("role").and_then(|v| v.as_str()).unwrap_or("user");
        let content = extract_message_content(&item);
        let tool_call_id = item
            .get("tool_call_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let tool_calls = item
            .get("tool_calls")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                let parsed: Vec<ToolCall> = arr
                    .iter()
                    .filter_map(|c| serde_json::from_value(c.clone()).ok())
                    .collect();
                if parsed.is_empty() {
                    None
                } else {
                    Some(parsed)
                }
            });

        let role = match role {
            "system" => Role::System,
            "assistant" => Role::Assistant,
            "tool" => Role::Tool,
            _ => Role::User,
        };
        out.push(ChatMessage {
            role,
            content,
            tool_call_id,
            tool_calls,
            name,
        });
    }
    Ok(out)
}

/// Extract text content from an OpenAI message, handling both string and
/// array-form `content` (e.g. `[{"type":"text","text":"hello"}]`).
fn extract_message_content(item: &serde_json::Value) -> String {
    match item.get("content") {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|block| {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    block
                        .get("text")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<_>>()
            .join(""),
        Some(serde_json::Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}


fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
