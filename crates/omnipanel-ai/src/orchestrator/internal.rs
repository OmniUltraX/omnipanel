use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures::StreamExt;

use crate::ir::{StopReason, StreamEvent, ToolStatus};
use crate::prompts::tool_routing_policy;
use crate::provider::AiProvider;
use crate::routing::{parse_backend_id, BackendKind};
use crate::types::{ChatMessage, ChatRequest, FunctionCall, Role, ToolCall, ToolDef};

use super::tools::ToolExecutor;
use super::types::{AiContextBundle, InternalChatRequest};

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
        let has_ask_user = tools
            .as_ref()
            .is_some_and(|defs| defs.iter().any(|d| d.function.name == "omni_ask_user"));

        loop {
            if cancel.load(Ordering::Relaxed) {
                on_event(StreamEvent::Done {
                    stop_reason: StopReason::Cancelled,
                });
                return Ok(());
            }

            let (enable_thinking, reasoning_effort) =
                resolve_thinking_options(request.pure_text, request.reasoning_effort.as_deref());

            let chat_request = ChatRequest {
                model: model.to_string(),
                messages: messages.clone(),
                stream: true,
                tools: tools.clone(),
                temperature: None,
                max_tokens: None,
                enable_thinking,
                reasoning_effort,
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

                let called_ask_user = tool_calls.iter().any(|tc| tc.function.name == "omni_ask_user");

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

                // HTTP 工具续轮：与 ACP client_tools 续写对齐——有 omni_ask_user 时禁止正文列选项。
                if has_ask_user && !called_ask_user {
                    messages.push(ChatMessage {
                        role: Role::User,
                        content: "[System — 工具已执行完毕]\n\
                             上方工具输出里已有真实结果。若已足够回答用户，用自然语言直接给出结论；\
                             若仍需继续调查/执行，再次调用工具；\
                             若需要用户选择下一步/主机/范围等，必须调用 omni_ask_user，\
                             禁止用正文纯文本列选项（A/B/C 或 1/2/3）提问。"
                            .to_string(),
                        tool_call_id: None,
                        tool_calls: None,
                        name: None,
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

pub(crate) fn build_system_message(context: &AiContextBundle, system_append: Option<&str>) -> Option<ChatMessage> {
    let mut lines = Vec::new();

    lines.push(tool_routing_policy());

    if let Some(ctx) = context
        .terminal_context_append
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        lines.push(String::new());
        lines.push(ctx.to_string());
    }

    // 模块级上下文（数据库连接 / SSH 主机等）：紧随终端上下文之后，让 AI 感知当前活跃模块状态。
    if let Some(module_ctx) = context
        .module_context_append
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        lines.push(String::new());
        lines.push(module_ctx.to_string());
    }

    let terminal_ctx = context
        .terminal_context_append
        .as_deref()
        .unwrap_or("");
    let cwd_already_in_terminal = terminal_ctx.contains("Working directory:");
    if !cwd_already_in_terminal {
        if let Some(cwd) = context.cwd.as_deref().filter(|s| !s.trim().is_empty()) {
            lines.push(format!("Current working directory: {cwd}"));
        }
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
    let is_remote = context
        .terminal_session_type
        .as_deref()
        .is_some_and(|t| t == "remote");
    if is_remote {
        if let Some(resource) = context
            .resource_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            lines.push(format!(
                "Active SSH connection id (omni_ssh_* only; never pass to omni_terminal_exec): {resource}"
            ));
        }
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

fn resolve_thinking_options(
    pure_text: bool,
    reasoning_effort: Option<&str>,
) -> (Option<bool>, Option<String>) {
    if pure_text {
        return (Some(false), None);
    }
    let effort = reasoning_effort
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default");
    match effort {
        "low" | "medium" | "high" => (Some(true), Some(effort.to_string())),
        _ => (None, None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orchestrator::types::AiContextBundle;

    fn empty_ctx() -> AiContextBundle {
        AiContextBundle {
            cwd: None,
            workspace_id: None,
            terminal_session_id: None,
            terminal_session_type: None,
            env_tag: None,
            resource_id: None,
            terminal_context_append: None,
            module_context_append: None,
        }
    }

    #[test]
    fn system_message_has_no_local_datetime() {
        let mut context = empty_ctx();
        context.cwd = Some("/tmp".into());
        let msg = build_system_message(&context, None).unwrap();
        assert!(!msg.content.contains("Current local date-time"));
        assert!(!msg.content.contains("date-time"));
        assert!(msg.content.contains("omni_terminal_exec"));
    }

    #[test]
    fn system_message_skips_cwd_when_terminal_context_has_it() {
        let mut context = empty_ctx();
        context.cwd = Some("C:\\\\Users\\\\me".into());
        context.terminal_context_append = Some(
            "[Terminal Context]\n- Working directory: /remote/app\n".into(),
        );
        let msg = build_system_message(&context, None).unwrap();
        assert!(msg.content.contains("Working directory: /remote/app"));
        assert!(!msg.content.contains("Current working directory"));
    }

    #[test]
    fn system_message_labels_ssh_resource_only_when_remote() {
        let mut local = empty_ctx();
        local.resource_id = Some("ssh-1".into());
        local.terminal_session_type = Some("local".into());
        let local_msg = build_system_message(&local, None).unwrap();
        assert!(!local_msg.content.contains("ssh-1"));

        let mut remote = empty_ctx();
        remote.resource_id = Some("ssh-1".into());
        remote.terminal_session_type = Some("remote".into());
        let remote_msg = build_system_message(&remote, None).unwrap();
        assert!(remote_msg.content.contains("omni_ssh_* only"));
        assert!(remote_msg.content.contains("ssh-1"));
        assert!(remote_msg
            .content
            .contains("never pass to omni_terminal_exec"));
    }
}
