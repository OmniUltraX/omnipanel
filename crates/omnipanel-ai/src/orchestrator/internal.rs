use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use futures::StreamExt;

use crate::ir::{StopReason, StreamEvent, ToolStatus};
use crate::prompts::tool_routing_policy;
use crate::provider::AiProvider;
use crate::routing::parse_backend_id;
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
        let tools = if tools_enabled { tools } else { None };
        let has_ask_user = tools
            .as_ref()
            .is_some_and(|defs| defs.iter().any(|d| d.function.name == "omni_ask_user"));
        let mut succeeded_calls: Vec<(String, String)> = Vec::new();
        let mut plan_open = false;

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
                                // 同名调用已经成功过时，先别把卡片推给前端。
                                // 参数要等流结束才完整；提前推送会让直通终端在 Done 时强制执行。
                                let withhold = succeeded_calls
                                    .iter()
                                    .any(|(done_name, _)| done_name == name);
                                accumulated_tool_calls.push((
                                    id.clone(),
                                    name.clone(),
                                    arguments.clone(),
                                ));
                                if !withhold {
                                    on_event(evt);
                                }
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
                        // 错误已经写进流。再把 Result 返回给命令层，前端会再画一遍。
                        on_event(StreamEvent::Error {
                            message: e.to_string(),
                        });
                        return Ok(());
                    }
                }
            }

            if !accumulated_tool_calls.is_empty() {
                let executor = tool_executor.ok_or_else(|| "缺少 ToolExecutor".to_string())?;
                let all_repeat = accumulated_tool_calls
                    .iter()
                    .all(|(_, name, args)| call_already_succeeded(&succeeded_calls, name, args));
                if all_repeat {
                    // 模型在已经看到输出后仍原样调用。不再执行，直接结束本轮。
                    if let Some(done_evt) = pending_done {
                        on_event(done_evt);
                    } else {
                        on_event(StreamEvent::Done {
                            stop_reason: StopReason::EndTurn,
                        });
                    }
                    return Ok(());
                }

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

                let called_ask_user = tool_calls
                    .iter()
                    .any(|tc| tc.function.name == "omni_ask_user");

                for tc in &tool_calls {
                    if call_already_succeeded(
                        &succeeded_calls,
                        &tc.function.name,
                        &tc.function.arguments,
                    ) {
                        messages.push(ChatMessage {
                            role: Role::Tool,
                            content: "该调用刚刚已经成功，输出见上方同名结果。不要再调用同一参数，直接回答用户。"
                                .to_string(),
                            tool_call_id: Some(tc.id.clone()),
                            tool_calls: None,
                            name: Some(tc.function.name.clone()),
                        });
                        continue;
                    }
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

                    if success {
                        succeeded_calls
                            .push((tc.function.name.clone(), tc.function.arguments.clone()));
                        if is_plan_tool(&tc.function.name) {
                            plan_open = true;
                        }
                    }

                    messages.push(ChatMessage {
                        role: Role::Tool,
                        content: result,
                        tool_call_id: Some(tc.id.clone()),
                        tool_calls: None,
                        name: Some(tc.function.name.clone()),
                    });
                }

                // 续轮必须明确：结果已经在上下文里，禁止把同一条成功命令再跑一遍。
                if !called_ask_user {
                    messages.push(ChatMessage {
                        role: Role::User,
                        content: tool_round_followup(has_ask_user, plan_open),
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
        Ok((parsed.provider_id, parsed.model_id))
    }
}

fn call_already_succeeded(done: &[(String, String)], name: &str, arguments: &str) -> bool {
    done.iter()
        .any(|(done_name, done_args)| same_tool_call(done_name, done_args, name, arguments))
}

fn same_tool_call(name_a: &str, args_a: &str, name_b: &str, args_b: &str) -> bool {
    if name_a != name_b {
        return false;
    }
    if args_a.trim() == args_b.trim() {
        return true;
    }
    match (
        serde_json::from_str::<serde_json::Value>(args_a),
        serde_json::from_str::<serde_json::Value>(args_b),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn is_plan_tool(name: &str) -> bool {
    matches!(
        name,
        "omni_plan_create" | "omni_plan_add_step" | "omni_plan_update_step"
    )
}

fn tool_round_followup(has_ask_user: bool, plan_open: bool) -> String {
    let mut text = if plan_open {
        "\
[System — 计划仍在执行]\n\
本回合已经创建或更新了会话计划。在每一步都标记为 completed 或 skipped 之前，不要把这一轮当成最终回答。\n\
下一步继续调用工具：把当前步骤标成 in_progress，做这一步真正要做的事，再用 omni_plan_update_step 写成 completed 或 failed。\n\
step_id 只能用 omni_plan_create 返回的值。禁止重复参数相同的已成功调用。\n\
只有全部步骤都结束后，才用自然语言给出结论，并且不要再调用工具。\
禁止把工具名、JSON 或「[工具 …]」内部记录写给用户。"
            .to_string()
    } else {
        "\
[System — 工具已执行完毕]\n\
上方工具输出里已有真实结果。若已足够回答用户，用一两句自然语言直接给出结论，不要再调用工具。\
禁止把工具名、JSON 或「[工具 …]」内部记录写给用户。\
禁止重复刚才已经成功、参数相同的调用。\
只有结果不够、且需要不同命令或不同参数时才继续调用。"
            .to_string()
    };
    if has_ask_user {
        text.push_str(
            "若需要用户选择下一步/主机/范围等，必须调用 omni_ask_user，\
             禁止用正文纯文本列选项（A/B/C 或 1/2/3）提问。",
        );
    }
    text
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

pub(crate) fn build_system_message(
    context: &AiContextBundle,
    system_append: Option<&str>,
) -> Option<ChatMessage> {
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

    let terminal_ctx = context.terminal_context_append.as_deref().unwrap_or("");
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
        context.terminal_context_append =
            Some("[Terminal Context]\n- Working directory: /remote/app\n".into());
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
        assert!(
            remote_msg
                .content
                .contains("never pass to omni_terminal_exec")
        );
    }

    #[test]
    fn plan_followup_does_not_tell_the_model_to_stop() {
        let open = tool_round_followup(false, true);
        assert!(open.contains("计划仍在执行"));
        assert!(open.contains("omni_plan_update_step"));
        assert!(!open.contains("若已足够回答用户"));
        let idle = tool_round_followup(false, false);
        assert!(idle.contains("若已足够回答用户"));
        assert!(!idle.contains("计划仍在执行"));
    }

    #[test]
    fn same_tool_call_ignores_json_whitespace() {
        assert!(same_tool_call(
            "omni_terminal_exec",
            r#"{"command":"Get-Date"}"#,
            "omni_terminal_exec",
            "{\n  \"command\": \"Get-Date\"\n}",
        ));
        assert!(!same_tool_call(
            "omni_terminal_exec",
            r#"{"command":"Get-Date"}"#,
            "omni_terminal_exec",
            r#"{"command":"date"}"#,
        ));
    }

    struct ScriptedProvider {
        scripts: std::sync::Mutex<Vec<Vec<StreamEvent>>>,
        seen: std::sync::Mutex<Vec<Vec<ChatMessage>>>,
    }

    #[async_trait::async_trait]
    impl crate::provider::AiProvider for ScriptedProvider {
        fn name(&self) -> &str {
            "scripted"
        }

        fn models(&self) -> Vec<crate::types::ModelInfo> {
            Vec::new()
        }

        async fn chat(&self, _request: ChatRequest) -> anyhow::Result<crate::types::ChatResponse> {
            anyhow::bail!("unused")
        }

        async fn chat_stream(
            &self,
            request: ChatRequest,
        ) -> anyhow::Result<
            std::pin::Pin<Box<dyn futures::Stream<Item = anyhow::Result<StreamEvent>> + Send>>,
        > {
            self.seen.lock().expect("seen").push(request.messages);
            let events = self
                .scripts
                .lock()
                .expect("scripts")
                .pop()
                .expect("脚本轮次不够，工具循环没有停");
            Ok(Box::pin(futures::stream::iter(events.into_iter().map(Ok))))
        }
    }

    struct CountingExec {
        hits: std::sync::atomic::AtomicUsize,
    }

    #[async_trait::async_trait]
    impl ToolExecutor for CountingExec {
        async fn execute(&self, _id: &str, _name: &str, _arguments: &str) -> (String, bool) {
            self.hits.fetch_add(1, Ordering::SeqCst);
            ("2026-10-08 17:45:06".into(), true)
        }
    }

    fn date_call(id: &str) -> StreamEvent {
        StreamEvent::ToolCall {
            id: id.into(),
            name: "omni_terminal_exec".into(),
            arguments: r#"{"command":"Get-Date -Format 'yyyy-MM-dd HH:mm:ss (dddd)'"}"#.into(),
        }
    }

    #[tokio::test]
    async fn repeated_identical_terminal_command_runs_once() {
        let provider = ScriptedProvider {
            scripts: std::sync::Mutex::new(vec![
                vec![
                    date_call("call-2"),
                    StreamEvent::Done {
                        stop_reason: StopReason::EndTurn,
                    },
                ],
                vec![
                    date_call("call-1"),
                    StreamEvent::Done {
                        stop_reason: StopReason::EndTurn,
                    },
                ],
            ]),
            seen: std::sync::Mutex::new(Vec::new()),
        };
        let exec = CountingExec {
            hits: std::sync::atomic::AtomicUsize::new(0),
        };
        let events = std::sync::Mutex::new(Vec::new());
        let request = InternalChatRequest {
            conversation_id: "c".into(),
            user_text: "现在的时间".into(),
            backend_id: "http:cursor::composer".into(),
            context: empty_ctx(),
            history: None,
            tools_mode: crate::orchestrator::types::InternalToolsMode::None,
            http_provider: None,
            system_append: None,
            pure_text: false,
            reasoning_effort: None,
            agent_id: Some("terminal".into()),
        };
        let tools = vec![
            ToolDef {
                tool_type: "function".into(),
                function: crate::types::FunctionDef {
                    name: "omni_terminal_exec".into(),
                    description: "当前终端".into(),
                    parameters: serde_json::json!({"type": "object"}),
                },
            },
            ToolDef {
                tool_type: "function".into(),
                function: crate::types::FunctionDef {
                    name: "omni_ask_user".into(),
                    description: "询问用户".into(),
                    parameters: serde_json::json!({"type": "object"}),
                },
            },
        ];

        InternalOrchestrator::run_turn(
            &provider,
            "composer",
            &request,
            Some(tools),
            Some(&exec),
            |event| events.lock().expect("events").push(event),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .expect("run");

        assert_eq!(exec.hits.load(Ordering::SeqCst), 1);
        let seen = provider.seen.lock().expect("seen");
        assert_eq!(seen.len(), 2);
        let follow = &seen[1];
        assert!(
            follow
                .iter()
                .any(|message| message.role == Role::Tool && message.content.contains("2026-10-08"))
        );
        assert!(
            follow
                .iter()
                .any(|message| message.content.contains("禁止重复刚才已经成功"))
        );
        let events = events.lock().expect("events");
        let pending = events
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    StreamEvent::ToolCallUpdate {
                        status: ToolStatus::Pending,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(pending, 1);
        assert!(events.iter().any(|event| matches!(
            event,
            StreamEvent::Done {
                stop_reason: StopReason::EndTurn
            }
        )));
    }
}
