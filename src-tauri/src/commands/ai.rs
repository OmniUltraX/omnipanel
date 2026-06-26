use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;
use tauri::{ipc::Channel, State};

use crate::state::AppState;
use futures::StreamExt;
use omnipanel_ai::ir::{StopReason, StreamEvent, ToolStatus};
use omnipanel_ai::types::{
    ChatMessage, ChatRequest, FunctionCall, FunctionDef, ModelInfo, Role, ToolCall, ToolDef,
};

#[derive(Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub models: Vec<ModelInfo>,
}

/// Maximum number of tool-calling iterations to prevent infinite loops.
const MAX_TOOL_ITERATIONS: usize = 10;

/// Build the default set of tools available to the AI.
/// Includes knowledge search, terminal execution, file I/O, and HTTP requests.
fn build_default_tools() -> Vec<ToolDef> {
    vec![
        ToolDef {
            tool_type: "function".to_string(),
            function: FunctionDef {
                name: "search_knowledge".to_string(),
                description: "Search the knowledge base for relevant information including code snippets, troubleshooting cases, and documented procedures. Use this when the user asks about stored knowledge, debugging solutions, configuration examples, or any documented best practices.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "The search query to find relevant knowledge entries"
                        },
                        "kind": {
                            "type": "string",
                            "enum": ["snippet", "case", "ai"],
                            "description": "Optional filter by knowledge entry type: snippet (code), case (troubleshooting), ai (AI-generated)"
                        }
                    },
                    "required": ["query"]
                }),
            },
        },
        ToolDef {
            tool_type: "function".to_string(),
            function: FunctionDef {
                name: "execute_terminal".to_string(),
                description: "Execute a shell command on the local system and return stdout+stderr. Use for running scripts, checking system state, installing packages, etc. Output is truncated to 4096 chars.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "command": {
                            "type": "string",
                            "description": "The shell command to execute"
                        },
                        "workdir": {
                            "type": "string",
                            "description": "Optional working directory for the command"
                        }
                    },
                    "required": ["command"]
                }),
            },
        },
        ToolDef {
            tool_type: "function".to_string(),
            function: FunctionDef {
                name: "read_file".to_string(),
                description: "Read the contents of a file at the given path. Returns the file text, truncated to 8192 characters. Supports optional offset and limit for large files.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Absolute or relative path to the file"
                        },
                        "offset": {
                            "type": "number",
                            "description": "Optional line number to start reading from (1-indexed)"
                        },
                        "limit": {
                            "type": "number",
                            "description": "Optional maximum number of lines to read"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDef {
            tool_type: "function".to_string(),
            function: FunctionDef {
                name: "list_files".to_string(),
                description: "List files and directories at the given path. Returns a JSON array of entries with name, type (file/dir), and size.".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "Directory path to list"
                        }
                    },
                    "required": ["path"]
                }),
            },
        },
        ToolDef {
            tool_type: "function".to_string(),
            function: FunctionDef {
                name: "http_request".to_string(),
                description: "Send an HTTP request and return the response. Useful for testing APIs, fetching data, or checking endpoints. Returns status code and body (truncated to 4096 chars).".to_string(),
                parameters: serde_json::json!({
                    "type": "object",
                    "properties": {
                        "method": {
                            "type": "string",
                            "enum": ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"],
                            "description": "HTTP method"
                        },
                        "url": {
                            "type": "string",
                            "description": "Request URL"
                        },
                        "headers": {
                            "type": "object",
                            "description": "Optional request headers as key-value pairs"
                        },
                        "body": {
                            "type": "string",
                            "description": "Optional request body"
                        }
                    },
                    "required": ["method", "url"]
                }),
            },
        },
    ]
}

/// Execute a tool by name and return the result as a string.
async fn execute_tool(state: &AppState, name: &str, arguments: &str) -> (String, bool) {
    match name {
        "search_knowledge" => {
            let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
            let query = args
                .get("query")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let kind = args
                .get("kind")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            if query.trim().is_empty() {
                return ("Error: query parameter is required".to_string(), false);
            }

            let storage = state.storage.lock().await;
            match storage.search_knowledge(&query, kind.as_deref()) {
                Ok(results) => {
                    if results.is_empty() {
                        ("No matching knowledge entries found.".to_string(), true)
                    } else {
                        let formatted: Vec<serde_json::Value> = results
                            .iter()
                            .take(5)
                            .map(|r| {
                                serde_json::json!({
                                    "id": r.entry.id,
                                    "title": r.entry.title,
                                    "kind": r.entry.kind,
                                    "snippet": r.snippet,
                                    "tags": r.entry.tags,
                                    "risk_level": r.entry.risk_level,
                                    "env_tag": r.entry.env_tag,
                                })
                            })
                            .collect();
                        (
                            serde_json::to_string_pretty(&formatted).unwrap_or_default(),
                            true,
                        )
                    }
                }
                Err(e) => (format!("Knowledge search error: {}", e), false),
            }
        }
        "execute_terminal" => {
            let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            let workdir = args.get("workdir").and_then(|v| v.as_str());

            if command.trim().is_empty() {
                return ("Error: command parameter is required".to_string(), false);
            }

            let mut cmd = if cfg!(target_os = "windows") {
                let mut c = tokio::process::Command::new("cmd");
                c.arg("/C").arg(command);
                c
            } else {
                let mut c = tokio::process::Command::new("sh");
                c.arg("-c").arg(command);
                c
            };

            if let Some(dir) = workdir {
                cmd.current_dir(dir);
            }

            match tokio::time::timeout(std::time::Duration::from_secs(30), cmd.output()).await {
                Ok(Ok(output)) => {
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let mut result = String::new();
                    if !stdout.is_empty() {
                        result.push_str(&stdout);
                    }
                    if !stderr.is_empty() {
                        if !result.is_empty() {
                            result.push_str("\n--- stderr ---\n");
                        }
                        result.push_str(&stderr);
                    }
                    if result.is_empty() {
                        result = format!(
                            "Command exited with code: {}",
                            output.status.code().unwrap_or(-1)
                        );
                    }
                    // Truncate to 4096 chars
                    if result.len() > 4096 {
                        result.truncate(4092);
                        result.push_str("...");
                    }
                    (result, true)
                }
                Ok(Err(e)) => (format!("Command execution error: {}", e), false),
                Err(_) => (
                    "Error: command timed out after 30 seconds".to_string(),
                    false,
                ),
            }
        }
        "read_file" => {
            let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(1) as usize;
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(200) as usize;

            if path.trim().is_empty() {
                return ("Error: path parameter is required".to_string(), false);
            }

            match std::fs::read_to_string(path) {
                Ok(content) => {
                    let lines: Vec<&str> = content.lines().collect();
                    let start = if offset > 0 { offset - 1 } else { 0 };
                    let end = std::cmp::min(start + limit, lines.len());
                    if start >= lines.len() {
                        return ("Error: offset exceeds file length".to_string(), false);
                    }
                    let mut result = lines[start..end].join("\n");
                    if result.len() > 8192 {
                        result.truncate(8188);
                        result.push_str("...");
                    }
                    (result, true)
                }
                Err(e) => (format!("File read error: {}", e), false),
            }
        }
        "list_files" => {
            let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or(".");

            match std::fs::read_dir(path) {
                Ok(entries) => {
                    let mut files: Vec<serde_json::Value> = Vec::new();
                    for entry in entries.flatten() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        let file_type = if entry.path().is_dir() { "dir" } else { "file" };
                        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                        files.push(serde_json::json!({
                            "name": name,
                            "type": file_type,
                            "size": size,
                        }));
                    }
                    let result = serde_json::to_string_pretty(&files).unwrap_or_default();
                    let truncated = if result.len() > 4096 {
                        format!("{}...", &result[..4092])
                    } else {
                        result
                    };
                    (truncated, true)
                }
                Err(e) => (format!("Directory listing error: {}", e), false),
            }
        }
        "http_request" => {
            let args: serde_json::Value = serde_json::from_str(arguments).unwrap_or_default();
            let method = args.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let headers = args.get("headers").and_then(|v| v.as_object());
            let body = args.get("body").and_then(|v| v.as_str());

            if url.trim().is_empty() {
                return ("Error: url parameter is required".to_string(), false);
            }

            let proxy_config = state.proxy_config.lock().await.clone();
            let client = crate::commands::proxy::build_proxy_client(&proxy_config);
            let mut req = match method.to_uppercase().as_str() {
                "GET" => client.get(url),
                "POST" => client.post(url),
                "PUT" => client.put(url),
                "DELETE" => client.delete(url),
                "PATCH" => client.patch(url),
                "HEAD" => client.head(url),
                _ => return (format!("Unsupported method: {}", method), false),
            };

            if let Some(hdrs) = headers {
                for (k, v) in hdrs {
                    if let Some(val) = v.as_str() {
                        req = req.header(k.as_str(), val);
                    }
                }
            }

            if let Some(b) = body {
                req = req.body(b.to_string());
            }

            match tokio::time::timeout(std::time::Duration::from_secs(30), req.send()).await {
                Ok(Ok(resp)) => {
                    let status = resp.status().as_u16();
                    let resp_headers: std::collections::HashMap<String, String> = resp
                        .headers()
                        .iter()
                        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                        .collect();
                    let resp_body = resp.text().await.unwrap_or_default();
                    let truncated_body = if resp_body.len() > 4096 {
                        format!("{}...", &resp_body[..4092])
                    } else {
                        resp_body
                    };
                    let result = serde_json::json!({
                        "status": status,
                        "headers": resp_headers,
                        "body": truncated_body,
                    });
                    (
                        serde_json::to_string_pretty(&result).unwrap_or_default(),
                        true,
                    )
                }
                Ok(Err(e)) => (format!("HTTP request error: {}", e), false),
                Err(_) => (
                    "Error: HTTP request timed out after 30 seconds".to_string(),
                    false,
                ),
            }
        }
        _ => (format!("Unknown tool: {}", name), false),
    }
}

/// Send a message to the current AI provider and stream back events.
///
/// Implements a tool-calling loop: when the AI requests tool calls, the backend
/// executes them (e.g. `search_knowledge`) and feeds results back to the AI
/// for the next response turn. This continues until the AI produces a final
/// text response or the maximum iteration limit is reached.
///
/// When `history` is provided, those messages are prepended to the request so the
/// LLM sees the full multi-turn conversation.  If `history` is `None` (or empty)
/// the request falls back to a single-message payload (backward compatible).
#[tauri::command]
pub async fn ai_send_message(
    state: State<'_, AppState>,
    _conversation_id: String,
    content: String,
    on_event: Channel<StreamEvent>,
    history: Option<Vec<ChatMessage>>,
) -> Result<(), String> {
    let provider_name = state
        .current_provider
        .lock()
        .await
        .clone()
        .ok_or("No AI provider selected")?;

    let model = state
        .current_model
        .lock()
        .await
        .clone()
        .ok_or("No AI model selected")?;

    let registry = state.ai_registry.lock().await;
    let provider = registry
        .get(&provider_name)
        .ok_or_else(|| format!("Provider '{}' not found", provider_name))?;

    // Build available tools (currently only search_knowledge)
    let tools = build_default_tools();

    // Build the message list: conversation history (if any) + the new user message
    let mut messages: Vec<ChatMessage> = history.unwrap_or_default();
    messages.push(ChatMessage {
        role: Role::User,
        content,
        tool_call_id: None,
        tool_calls: None,
        name: None,
    });

    // Tool calling loop: keep executing tools until the AI gives a final response
    for _iteration in 0..MAX_TOOL_ITERATIONS {
        let request = ChatRequest {
            model: model.clone(),
            messages: messages.clone(),
            stream: true,
            tools: Some(tools.clone()),
            temperature: None,
            max_tokens: None,
        };

        let mut stream = provider
            .chat_stream(request)
            .await
            .map_err(|e| e.to_string())?;

        // Collect tool calls and content from this streaming turn
        let mut accumulated_tool_calls: Vec<(String, String, String)> = Vec::new(); // (id, name, args)
        let mut stop_reason = StopReason::EndTurn;
        let mut assistant_content = String::new();
        let mut pending_done: Option<StreamEvent> = None;

        use futures::StreamExt;
        while let Some(event) = stream.next().await {
            match event {
                Ok(evt) => {
                    match &evt {
                        StreamEvent::ToolCall {
                            id,
                            name,
                            arguments,
                        } => {
                            if !name.is_empty() {
                                // New tool call
                                accumulated_tool_calls.push((
                                    id.clone(),
                                    name.clone(),
                                    arguments.clone(),
                                ));
                            } else if !arguments.is_empty() {
                                // Argument continuation for the last tool call
                                if let Some(last) = accumulated_tool_calls.last_mut() {
                                    last.2.push_str(arguments);
                                }
                            }
                            // Forward to frontend
                            let _ = on_event.send(evt);
                        }
                        StreamEvent::Done { stop_reason: sr } => {
                            stop_reason = sr.clone();
                            // Buffer the done event; only forward if it's the final one
                            pending_done = Some(evt);
                        }
                        StreamEvent::ContentDelta { text } => {
                            assistant_content.push_str(text);
                            let _ = on_event.send(evt);
                        }
                        _ => {
                            let _ = on_event.send(evt);
                        }
                    }
                }
                Err(e) => {
                    let _ = on_event.send(StreamEvent::Error {
                        message: e.to_string(),
                    });
                    break;
                }
            }
        }

        // If the AI wants to use tools, execute them and loop
        if stop_reason == StopReason::ToolUse && !accumulated_tool_calls.is_empty() {
            // Add assistant message with tool_calls to history
            let tool_calls: Vec<ToolCall> = accumulated_tool_calls
                .iter()
                .map(|(id, name, args)| ToolCall {
                    id: id.clone(),
                    call_type: "function".to_string(),
                    function: FunctionCall {
                        name: name.clone(),
                        arguments: args.clone(),
                    },
                })
                .collect();

            messages.push(ChatMessage {
                role: Role::Assistant,
                content: assistant_content.clone(),
                tool_call_id: None,
                tool_calls: Some(tool_calls.clone()),
                name: None,
            });

            // Execute each tool and add results
            for tc in &tool_calls {
                let (result, success) =
                    execute_tool(&state, &tc.function.name, &tc.function.arguments).await;

                // Send tool call update with result to frontend
                let _ = on_event.send(StreamEvent::ToolCallUpdate {
                    id: tc.id.clone(),
                    status: if success {
                        ToolStatus::Completed
                    } else {
                        ToolStatus::Failed
                    },
                    result: Some(result.clone()),
                });

                // Add tool result message for the AI
                messages.push(ChatMessage {
                    role: Role::Tool,
                    content: result,
                    tool_call_id: Some(tc.id.clone()),
                    tool_calls: None,
                    name: Some(tc.function.name.clone()),
                });
            }

            // Clear for the next iteration
            assistant_content.clear();
            continue;
        }

        // Normal end — forward the buffered Done event and break
        if let Some(done_evt) = pending_done {
            let _ = on_event.send(done_evt);
        }
        break;
    }

    Ok(())
}

/// List all available models from all registered providers.
#[tauri::command]
pub async fn ai_list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let registry = state.ai_registry.lock().await;
    Ok(registry.all_models())
}

/// Set the active AI provider and model.
#[tauri::command]
pub async fn ai_set_provider(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
) -> Result<(), String> {
    let registry = state.ai_registry.lock().await;
    if registry.get(&provider_id).is_none() {
        return Err(format!("Provider '{}' not found", provider_id));
    }
    drop(registry);

    *state.current_provider.lock().await = Some(provider_id);
    *state.current_model.lock().await = Some(model_id);
    Ok(())
}

/// List all registered providers with their models.
#[tauri::command]
pub async fn ai_list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderInfo>, String> {
    let registry = state.ai_registry.lock().await;
    let providers: Vec<ProviderInfo> = registry
        .list()
        .into_iter()
        .map(|name| ProviderInfo {
            id: name.to_string(),
            name: name.to_string(),
            models: registry.get(name).map(|p| p.models()).unwrap_or_default(),
        })
        .collect();
    Ok(providers)
}

/// Add an ACP CLI agent as a provider.
#[tauri::command]
pub async fn ai_add_acp_agent(
    state: State<'_, AppState>,
    binary_path: String,
    name: String,
) -> Result<(), String> {
    use omnipanel_ai::providers::acp::AcpProvider;
    use omnipanel_ai::providers::acp::types::AcpProfile;

    let mut provider = AcpProvider::new(&name, &binary_path, vec![], AcpProfile::ClientTools, None);

    provider
        .initialize()
        .await
        .map_err(|e| format!("Failed to initialize ACP agent: {}", e))?;

    let mut registry = state.ai_registry.lock().await;
    registry.register(Box::new(provider));

    Ok(())
}

/// Get the current active provider and model.
#[tauri::command]
pub async fn ai_get_active(state: State<'_, AppState>) -> Result<Option<(String, String)>, String> {
    let provider = state.current_provider.lock().await.clone();
    let model = state.current_model.lock().await.clone();
    match (provider, model) {
        (Some(p), Some(m)) => Ok(Some((p, m))),
        _ => Ok(None),
    }
}

/// Add a custom OpenAI-compatible provider at runtime.
///
/// The provider is registered in the AI registry and immediately available
/// for `ai_set_provider` / `ai_send_message`.
#[tauri::command]
pub async fn ai_add_custom_provider(
    state: State<'_, AppState>,
    name: String,
    api_key: Option<String>,
    base_url: String,
    models: Option<Vec<ModelInfo>>,
) -> Result<(), String> {
    use omnipanel_ai::providers::openai::OpenAiProvider;

    let api_key = api_key.unwrap_or_else(|| "sk-none".to_string());
    let models = models.unwrap_or_else(|| Vec::new());

    let proxy_config = state.proxy_config.lock().await.clone();
    let client = crate::commands::proxy::build_proxy_client(&proxy_config);
    let provider = OpenAiProvider::with_client(&name, &api_key, &base_url, models, Some(client));
    let mut registry = state.ai_registry.lock().await;
    registry.register(Box::new(provider));
    Ok(())
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AiHttpStreamEvent {
    Chunk { data: String },
    Error { message: String },
    Done { status: u16 },
}

/// 桌面端 AI 聊天流式 HTTP 代理：由 Rust reqwest 发起请求并逐块回传 SSE 正文。
#[tauri::command]
pub async fn ai_http_stream_post(
    state: State<'_, AppState>,
    url: String,
    headers: HashMap<String, String>,
    body: String,
    timeout_ms: Option<u64>,
    on_event: Channel<AiHttpStreamEvent>,
) -> Result<(), String> {
    let proxy_config = state.proxy_config.lock().await.clone();
    let mut client_builder = reqwest::Client::builder()
        .timeout(Duration::from_millis(timeout_ms.unwrap_or(120_000)))
        .redirect(reqwest::redirect::Policy::limited(10));

    if proxy_config.enabled && !proxy_config.host.is_empty() {
        let proxy_url = format!(
            "{}://{}:{}",
            proxy_config.protocol, proxy_config.host, proxy_config.port
        );
        if let Ok(proxy) = reqwest::Proxy::all(&proxy_url) {
            let proxy = if !proxy_config.username.is_empty() {
                proxy.basic_auth(&proxy_config.username, &proxy_config.password)
            } else {
                proxy
            };
            client_builder = client_builder.proxy(proxy);
        }
    }

    let client = client_builder
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut req = client.post(&url);
    for (key, value) in headers {
        req = req.header(key.as_str(), value.as_str());
    }
    req = req.body(body);

    let resp = req
        .send()
        .await
        .map_err(|e| format!("HTTP 请求失败: {e}"))?;

    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        let message = if text.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {text}")
        };
        let _ = on_event.send(AiHttpStreamEvent::Error {
            message: message.clone(),
        });
        return Err(message);
    }

    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let data = String::from_utf8_lossy(&bytes).into_owned();
                if on_event
                    .send(AiHttpStreamEvent::Chunk { data })
                    .is_err()
                {
                    break;
                }
            }
            Err(e) => {
                let message = format!("读取响应流失败: {e}");
                let _ = on_event.send(AiHttpStreamEvent::Error {
                    message: message.clone(),
                });
                return Err(message);
            }
        }
    }

    let _ = on_event.send(AiHttpStreamEvent::Done { status });
    Ok(())
}
