use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::StreamExt;

use crate::ir::{StopReason, StreamEvent, ToolStatus};
use crate::provider::AiProvider;
use crate::routing::{parse_backend_id, BackendKind};
use crate::types::{ChatMessage, ChatRequest, FunctionCall, Role, ToolCall, ToolDef};

use super::tools::ToolExecutor;
use super::types::{AiContextBundle, InternalChatRequest};

const MAX_TOOL_ITERATIONS: usize = 10;

pub struct InternalOrchestrator;

impl InternalOrchestrator {
    /// Run one user turn: build messages, optional tool loop, stream from provider.
    pub async fn run_turn(
        provider: &dyn AiProvider,
        model: &str,
        request: &InternalChatRequest,
        tools: Option<Vec<ToolDef>>,
        tool_executor: Option<&dyn ToolExecutor>,
        on_event: impl Fn(StreamEvent) + Send,
        cancel: Arc<AtomicBool>,
    ) -> Result<(), String> {
        let mut messages = build_messages(
            &request.context,
            request.history.as_deref(),
            request.system_append.as_deref(),
        );
        messages.push(ChatMessage {
            role: Role::User,
            content: request.user_text.clone(),
            tool_call_id: None,
            tool_calls: None,
            name: None,
        });

        let tools_enabled = tools.is_some() && tool_executor.is_some();
        let tools = if tools_enabled {
            tools
        } else {
            None
        };

        for _iteration in 0..MAX_TOOL_ITERATIONS {
            if cancel.load(Ordering::Relaxed) {
                on_event(StreamEvent::Done {
                    stop_reason: StopReason::Cancelled,
                });
                return Ok(());
            }

            let chat_request = ChatRequest {
                model: model.to_string(),
                messages: messages.clone(),
                stream: true,
                tools: tools.clone(),
                temperature: None,
                max_tokens: None,
            };

            let mut stream = provider
                .chat_stream(chat_request)
                .await
                .map_err(|e| e.to_string())?;

            let mut accumulated_tool_calls: Vec<(String, String, String)> = Vec::new();
            let mut assistant_content = String::new();
            let mut pending_done: Option<StreamEvent> = None;

            while let Some(event) = stream.next().await {
                if cancel.load(Ordering::Relaxed) {
                    on_event(StreamEvent::Done {
                        stop_reason: StopReason::Cancelled,
                    });
                    return Ok(());
                }

                match event {
                    Ok(evt) => match &evt {
                        StreamEvent::ToolCall {
                            id,
                            name,
                            arguments,
                        } => {
                            if !name.is_empty() {
                                accumulated_tool_calls
                                    .push((id.clone(), name.clone(), arguments.clone()));
                                on_event(evt);
                            } else if !arguments.is_empty() {
                                if let Some(last) = accumulated_tool_calls.last_mut() {
                                    last.2.push_str(arguments);
                                }
                            }
                        }
                        StreamEvent::Done { .. } => {
                            pending_done = Some(evt);
                        }
                        StreamEvent::ContentDelta { text } => {
                            assistant_content.push_str(text);
                            on_event(evt);
                        }
                        _ => on_event(evt),
                    },
                    Err(e) => {
                        on_event(StreamEvent::Error {
                            message: e.to_string(),
                        });
                        return Err(e.to_string());
                    }
                }
            }

            if !accumulated_tool_calls.is_empty() {
                let executor = tool_executor.ok_or_else(|| "缺少 ToolExecutor".to_string())?;

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

                for tc in &tool_calls {
                    // 重新广播完整 arguments：流式分片可能被后端累积而未逐片转发，
                    // 前端据此拿到完整命令用于内联审批 dock。
                    on_event(StreamEvent::ToolCall {
                        id: tc.id.clone(),
                        name: tc.function.name.clone(),
                        arguments: tc.function.arguments.clone(),
                    });
                    on_event(StreamEvent::ToolCallUpdate {
                        id: tc.id.clone(),
                        status: ToolStatus::Pending,
                        result: None,
                    });

                    let (result, success) = executor
                        .execute(&tc.id, &tc.function.name, &tc.function.arguments)
                        .await;

                    on_event(StreamEvent::ToolCallUpdate {
                        id: tc.id.clone(),
                        status: if success {
                            ToolStatus::Completed
                        } else {
                            ToolStatus::Failed
                        },
                        result: Some(result.clone()),
                    });

                    messages.push(ChatMessage {
                        role: Role::Tool,
                        content: result,
                        tool_call_id: Some(tc.id.clone()),
                        tool_calls: None,
                        name: Some(tc.function.name.clone()),
                    });
                }

                assistant_content.clear();
                continue;
            }

            if let Some(done_evt) = pending_done {
                on_event(done_evt);
            } else {
                on_event(StreamEvent::Done {
                    stop_reason: StopReason::EndTurn,
                });
            }
            return Ok(());
        }

        on_event(StreamEvent::Error {
            message: format!("超过最大工具调用次数 ({MAX_TOOL_ITERATIONS})"),
        });
        Err(format!("超过最大工具调用次数 ({MAX_TOOL_ITERATIONS})"))
    }

    pub fn resolve_http_model(backend_id: &str) -> Result<(String, String), String> {
        let parsed = parse_backend_id(backend_id)?;
        if parsed.kind != BackendKind::Http {
            return Err(format!(
                "backend_id 不是 HTTP 类型: {backend_id}（Phase 1 接入 ACP）"
            ));
        }
        Ok((parsed.provider_id, parsed.model_id))
    }
}

fn build_messages(
    context: &AiContextBundle,
    history: Option<&[ChatMessage]>,
    system_append: Option<&str>,
) -> Vec<ChatMessage> {
    let mut messages = Vec::new();

    if let Some(system) = build_system_message(context, system_append) {
        messages.push(system);
    }

    if let Some(hist) = history {
        messages.extend(hist.iter().cloned());
    }

    messages
}

fn build_system_message(context: &AiContextBundle, system_append: Option<&str>) -> Option<ChatMessage> {
    let mut lines = Vec::new();

    if let Some(cwd) = context.cwd.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("Current working directory: {cwd}"));
    }
    if let Some(env) = context.env_tag.as_deref().filter(|s| !s.trim().is_empty()) {
        lines.push(format!("Environment tag: {env}"));
    }
    if let Some(session) = context
        .terminal_session_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        lines.push(format!("Active terminal session id: {session}"));
    }
    if let Some(workspace) = context
        .workspace_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        lines.push(format!("Workspace id: {workspace}"));
    }
    if let Some(resource) = context
        .resource_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        lines.push(format!("Resource id: {resource}"));
    }

    if let Some(extra) = system_append.filter(|s| !s.trim().is_empty()) {
        if !lines.is_empty() {
            lines.push(String::new());
        }
        lines.push(extra.to_string());
    }

    if lines.is_empty() {
        return None;
    }

    Some(ChatMessage {
        role: Role::System,
        content: lines.join("\n"),
        tool_call_id: None,
        tool_calls: None,
        name: None,
    })
}
