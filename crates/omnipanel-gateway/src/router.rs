use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Response};
use futures::StreamExt;
use omnipanel_ai::ir::{StopReason, StreamEvent};
use omnipanel_ai::provider::AiProviderRegistry;
use omnipanel_ai::providers::acp::{
    build_client_tools_prompt, format_client_tool_result_prompt, looks_like_pending_tool_calls_json,
    parse_client_tool_calls, AcpRoundRunner,
};
use omnipanel_ai::routing::{parse_backend_id, BackendKind};
use omnipanel_ai::types::{ChatMessage, ChatRequest, Role, ToolCall, ToolDef};
use omnipanel_store::{AiSessionRecord, Storage};
use serde_json::json;
use tokio::sync::Mutex;
use tokio_stream::wrappers::ReceiverStream;

use crate::acp_resolver::AcpResolver;

pub struct GatewayRouter {
    ai_registry: Arc<Mutex<AiProviderRegistry>>,
    storage: Option<Arc<Mutex<Storage>>>,
    acp_resolver: Option<Arc<dyn AcpResolver>>,
    sessions: Mutex<HashMap<String, Vec<ChatMessage>>>,
}

impl GatewayRouter {
    pub fn new(
        ai_registry: Arc<Mutex<AiProviderRegistry>>,
        storage: Option<Arc<Mutex<Storage>>>,
        acp_resolver: Option<Arc<dyn AcpResolver>>,
    ) -> Self {
        Self {
            ai_registry,
            storage,
            acp_resolver,
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

        // CLI backends (Cursor / OpenCode / Qwen / OmniAgent)
        if let Some(resolver) = &self.acp_resolver {
            for backend in resolver.list_cli_backends() {
                for model in &backend.models {
                    out.push(json!({
                        "id": format!("cli:{}::{}", backend.provider_id, model),
                        "object": "model",
                        "owned_by": backend.display_name,
                    }));
                }
            }
        }

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

        // ---- CLI backend path (Cursor / OpenCode / Qwen / OmniAgent) ----
        if parsed.kind == BackendKind::Cli {
            return self
                .chat_completions_cli(&parsed.provider_id, &parsed.model_id, messages, tools, conversation_id, backend_id)
                .await;
        }

        if parsed.kind != BackendKind::Http {
            return Err(format!("Gateway 暂不支持非 HTTP/CLI model: {model}"));
        }

        // ---- HTTP backend path (original) ----
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

        let body = Body::from_stream(ReceiverStream::new(rx).map(Ok::<_, std::convert::Infallible>));

        Ok(Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(body)
            .unwrap())
    }

    /// CLI backend path: fold OpenAI messages into a single ACP prompt, run one
    /// round with `suppress_all_native=true`, and stream events back as OpenAI
    /// SSE chunks.
    ///
    /// When the external client (cline/aider) provides `tools`, we inject them
    /// via `build_client_tools_prompt` so the agent emits tool_calls JSON that
    /// we parse and forward as OpenAI `tool_calls` deltas. The agent's native
    /// tools are fully suppressed — it can only use the injected client tools.
    async fn chat_completions_cli(
        &self,
        provider_id: &str,
        model_id: &str,
        messages: Vec<serde_json::Value>,
        tools: Option<Vec<serde_json::Value>>,
        conversation_id: String,
        _backend_id: &str,
    ) -> Result<Response<Body>, String> {
        let resolver = self
            .acp_resolver
            .as_ref()
            .ok_or_else(|| "Gateway 未配置 CLI backend resolver".to_string())?
            .clone();

        // Parse external client's tool definitions (OpenAI function format)
        let tool_defs: Vec<ToolDef> = tools
            .unwrap_or_default()
            .into_iter()
            .filter_map(|t| serde_json::from_value(t).ok())
            .collect();
        let has_tools = !tool_defs.is_empty();

        // Fold messages into a single prompt text
        let (prompt_text, _is_tool_continuation) = fold_messages_to_cli_prompt(&messages, has_tools);

        // Resolve ACP manager + session
        let cwd = std::env::current_dir()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| ".".to_string());

        let (manager, session_id) = resolver
            .resolve(provider_id, &conversation_id, Some(model_id), &cwd)
            .await?;

        // Build client-tools prompt if external tools provided
        let full_prompt = if has_tools {
            build_client_tools_prompt(&prompt_text, None, &tool_defs)
        } else {
            prompt_text
        };

        // Start ACP round: suppress all native tools, hold content to prevent
        // half-JSON leakage
        let runner = AcpRoundRunner::new(manager, session_id);
        let content_buffer = AcpRoundRunner::maybe_content_buffer(true);
        let (mut rx, prompt_handle) = runner.start_round(
            &full_prompt,
            has_tools, // client_tools: enable content hold + translate path
            content_buffer.clone(),
            true, // suppress_all_native: gateway always suppresses
        );

        let response_model = format!("cli:{provider_id}::{model_id}");

        let (tx, rx_sse) = tokio::sync::mpsc::channel::<String>(64);
        let buffer_for_drain = content_buffer.clone();
        let model_for_done = response_model.clone();

        tokio::spawn(async move {
            let mut index = 0u64;
            let mut had_tool_calls = false;

            // Overall round timeout: 5 minutes. If the agent hangs without
            // producing any event for this duration, abort and return an error.
            let round_timeout = std::time::Duration::from_secs(300);
            let mut timeout_fut = Box::pin(tokio::time::sleep(round_timeout));

            // Phase 1: stream events from ACP round
            loop {
                let event = tokio::select! {
                    biased;
                    _ = &mut timeout_fut => {
                        let chunk = json!({
                            "id": format!("chatcmpl-{index}"),
                            "object": "chat.completion.chunk",
                            "model": model_for_done,
                            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
                        });
                        let _ = tx.send(format!("data: {chunk}\n\n")).await;
                        let err = json!({ "error": { "message": "ACP round timed out (300s)" } });
                        let _ = tx.send(format!("data: {err}\n\n")).await;
                        let _ = tx.send("data: [DONE]\n\n".to_string()).await;
                        return;
                    }
                    event = rx.recv() => match event {
                        Some(e) => e,
                        None => break,
                    }
                };

                let (delta, finish_reason): (serde_json::Value, Option<&str>) = match event {
                    StreamEvent::ContentDelta { text } => {
                        (json!({ "content": text }), None)
                    }
                    StreamEvent::ReasoningDelta { text } => {
                        (json!({ "reasoning_content": text }), None)
                    }
                    StreamEvent::ToolCall {
                        id,
                        name,
                        arguments,
                    } => {
                        had_tool_calls = true;
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
                    StreamEvent::Done { .. } => break,
                    StreamEvent::Error { message } => {
                        let chunk = json!({
                            "id": format!("chatcmpl-{index}"),
                            "object": "chat.completion.chunk",
                            "model": model_for_done,
                            "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }]
                        });
                        let _ = tx.send(format!("data: {chunk}\n\n")).await;
                        let error_chunk = json!({ "error": { "message": message } });
                        let _ = tx.send(format!("data: {error_chunk}\n\n")).await;
                        let _ = tx.send("data: [DONE]\n\n".to_string()).await;
                        return;
                    }
                    _ => continue,
                };

                let chunk = json!({
                    "id": format!("chatcmpl-{index}"),
                    "object": "chat.completion.chunk",
                    "model": model_for_done,
                    "choices": [{ "index": 0, "delta": delta, "finish_reason": finish_reason }]
                });
                if tx.send(format!("data: {chunk}\n\n")).await.is_err() {
                    break;
                }
                index += 1;
            }

            // Phase 2: drain held content buffer
            // If the agent emitted tool_calls JSON (not plain text), the content
            // gate never opened and the buffer holds the full JSON text.
            if !had_tool_calls {
                if let Some(buf) = &buffer_for_drain {
                    let held = buf.lock().map(|g| g.clone()).unwrap_or_default();
                    if !held.trim().is_empty() {
                        // Try parsing as client-tools tool_calls JSON
                        let parsed = parse_client_tool_calls(&held);
                        if !parsed.is_empty() {
                            for (tc_idx, tc) in parsed.iter().enumerate() {
                                let mut func = serde_json::Map::new();
                                if !tc.name.is_empty() {
                                    func.insert("name".to_string(), json!(tc.name));
                                }
                                func.insert("arguments".to_string(), json!(tc.arguments));
                                let mut call = serde_json::Map::new();
                                call.insert("index".to_string(), json!(tc_idx));
                                if !tc.id.is_empty() {
                                    call.insert("id".to_string(), json!(tc.id));
                                    call.insert("type".to_string(), json!("function"));
                                }
                                call.insert("function".to_string(), serde_json::Value::Object(func));
                                let chunk = json!({
                                    "id": format!("chatcmpl-{index}"),
                                    "object": "chat.completion.chunk",
                                    "model": model_for_done,
                                    "choices": [{
                                        "index": 0,
                                        "delta": { "tool_calls": [serde_json::Value::Object(call)] },
                                        "finish_reason": null
                                    }]
                                });
                                if tx.send(format!("data: {chunk}\n\n")).await.is_err() {
                                    return;
                                }
                                index += 1;
                            }
                            had_tool_calls = true;
                        } else if !looks_like_pending_tool_calls_json(&held) {
                            // Plain text that wasn't streamed (gate opened late or
                            // single-chunk response) — emit as content delta
                            let chunk = json!({
                                "id": format!("chatcmpl-{index}"),
                                "object": "chat.completion.chunk",
                                "model": model_for_done,
                                "choices": [{
                                    "index": 0,
                                    "delta": { "content": held },
                                    "finish_reason": null
                                }]
                            });
                            if tx.send(format!("data: {chunk}\n\n")).await.is_err() {
                                return;
                            }
                            index += 1;
                        }
                    }
                }
            }

            // Await prompt handle to check for errors
            if let Err(e) = prompt_handle.await {
                let chunk = json!({ "error": { "message": format!("ACP round failed: {e}") } });
                let _ = tx.send(format!("data: {chunk}\n\n")).await;
                let _ = tx.send("data: [DONE]\n\n".to_string()).await;
                return;
            }

            // Phase 3: emit Done chunk
            let finish = if had_tool_calls { "tool_calls" } else { "stop" };
            let chunk = json!({
                "id": format!("chatcmpl-{index}"),
                "object": "chat.completion.chunk",
                "model": model_for_done,
                "choices": [{ "index": 0, "delta": {}, "finish_reason": finish }]
            });
            let _ = tx.send(format!("data: {chunk}\n\n")).await;
            let _ = tx.send("data: [DONE]\n\n".to_string()).await;
        });

        let body = Body::from_stream(ReceiverStream::new(rx_sse).map(Ok::<_, std::convert::Infallible>));

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
        let role = item
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("user");
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
                    block.get("text").and_then(|v| v.as_str()).map(|s| s.to_string())
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

/// Fold OpenAI messages into a single ACP prompt text for the CLI backend path.
///
/// This preserves conversation order so the ACP agent has full context even
/// when the external client (cline/aider) sends the entire message history.
///
/// Returns `(prompt_text, is_tool_continuation)`.
fn fold_messages_to_cli_prompt(
    messages: &[serde_json::Value],
    has_tools: bool,
) -> (String, bool) {
    let mut blocks = Vec::new();
    let mut is_tool_continuation = false;

    for msg in messages {
        let role = msg
            .get("role")
            .and_then(|v| v.as_str())
            .unwrap_or("user");

        match role {
            "system" => {
                // System messages become part of the prompt context
                let content = extract_message_content(msg);
                if !content.trim().is_empty() {
                    blocks.push(format!("[System Context]\n{content}"));
                }
            }
            "user" => {
                let content = extract_message_content(msg);
                if !content.trim().is_empty() {
                    blocks.push(format!("[User]\n{content}"));
                }
            }
            "assistant" => {
                let content = extract_message_content(msg);
                let tool_calls_json = msg.get("tool_calls").and_then(|v| v.as_array());

                if let Some(tc) = tool_calls_json {
                    // Serialize assistant tool_calls for context
                    let tc_text: Vec<String> = tc
                        .iter()
                        .filter_map(|c| {
                            let name = c
                                .pointer("/function/name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("unknown");
                            let args = c
                                .pointer("/function/arguments")
                                .and_then(|v| v.as_str())
                                .unwrap_or("{}");
                            Some(format!(
                                "  - {name}({args})"
                            ))
                        })
                        .collect();
                    if !tc_text.is_empty() {
                        blocks.push(format!(
                            "[Assistant — tool_calls]\n{}",
                            tc_text.join("\n")
                        ));
                    }
                }

                if !content.trim().is_empty() {
                    blocks.push(format!("[Assistant]\n{content}"));
                }
            }
            "tool" => {
                // Tool result messages → [Tool Result] blocks
                let content = extract_message_content(msg);
                let name = msg
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool");
                is_tool_continuation = true;
                blocks.push(format_client_tool_result_prompt(name, &content, true));
            }
            _ => {}
        }
    }

    let prompt_text = if has_tools {
        // When tools are provided, build_client_tools_prompt will add the
        // preamble + [Available Functions] section. We just need the message
        // blocks.
        blocks.join("\n\n")
    } else {
        // No tools: simple user prompt
        blocks.join("\n\n")
    };

    (prompt_text, is_tool_continuation)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
