pub mod client;
pub mod client_tools;
pub mod native_tools;
pub mod translate;
pub mod types;

use anyhow::{Result, bail};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex as StdMutex;
use tokio::sync::Mutex;

use crate::ir::{StopReason, StreamEvent};
use crate::providers::acp::client::AcpClient;
use crate::providers::acp::translate::{TranslateOptions, translate_update_value};
use crate::providers::acp::types::*;

/// ACP prompt 选项（对齐 cursor-gateway client-tools 模式）。
#[derive(Clone)]
pub struct PromptOptions {
    /// 终端 client-tools：拒绝 ACP 内置 shell 执行，映射为客户端终端工具。
    pub client_tools: bool,
    /// 是否在 turn 结束时发送 `Done`（多步 tool loop 时由调用方控制）。
    pub emit_done: bool,
    /// 缓冲 ContentDelta 到 `content_buffer`，不立即发往前端（避免泄露半截 tool_calls JSON）。
    pub content_hold: bool,
    /// 与 `content_hold` 配合使用；prompt 结束后由调用方读取并处理。
    pub content_buffer: Option<Arc<StdMutex<String>>>,
}

impl Default for PromptOptions {
    fn default() -> Self {
        Self {
            client_tools: false,
            emit_done: true,
            content_hold: false,
            content_buffer: None,
        }
    }
}

/// Manages a long-lived ACP agent subprocess and conversation sessions.
pub struct AcpManager {
    client: Arc<AcpClient>,
    initialized: AtomicBool,
    agent_name: Mutex<Option<String>>,
    conversation_sessions: Mutex<HashMap<String, String>>,
    /// 已发送过首轮完整 client-tools prompt 的 conversation_id。
    prompted_conversations: Mutex<HashSet<String>>,
}

impl AcpManager {
    pub fn new(
        binary_path: &str,
        args: Vec<String>,
        spawn_env: HashMap<String, String>,
        spawn_cwd: Option<String>,
    ) -> Self {
        Self {
            client: Arc::new(AcpClient::new(
                binary_path,
                args,
                spawn_env,
                spawn_cwd,
            )),
            initialized: AtomicBool::new(false),
            agent_name: Mutex::new(None),
            conversation_sessions: Mutex::new(HashMap::new()),
            prompted_conversations: Mutex::new(HashSet::new()),
        }
    }

    pub async fn agent_name(&self) -> Option<String> {
        self.agent_name.lock().await.clone()
    }

    pub fn is_connected(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    /// 连接健康检查：不仅看 initialized 标志，还确认底层子进程仍存活。
    /// 子进程崩溃后 `initialized` 仍为 true，仅凭它会把请求发往已死的管道。
    pub async fn is_healthy(&self) -> bool {
        self.initialized.load(Ordering::SeqCst) && self.client.is_alive().await
    }

    pub async fn connect(self: &Arc<Self>) -> Result<()> {
        self.client.ensure_running().await?;

        let init_params = InitializeParams {
            protocol_version: 1,
            client_info: ClientInfo {
                name: "omnipanel".to_string(),
                version: "0.1.0".to_string(),
            },
            capabilities: ClientCapabilities {},
        };

        let result = self
            .client
            .request(
                "initialize",
                Some(serde_json::to_value(&init_params)?),
            )
            .await?;

        let init_result: InitializeResult = serde_json::from_value(result)?;
        let agent_name = if init_result.agent_info.name.is_empty() {
            "acp-agent".to_string()
        } else {
            init_result.agent_info.name.clone()
        };
        *self.agent_name.lock().await = Some(agent_name.clone());
        self.initialized.store(true, Ordering::SeqCst);

        if !init_result.auth_methods.is_empty() && !should_skip_acp_authenticate() {
            let method_id = init_result.auth_methods[0].id.clone();
            if let Err(e) = self
                .client
                .request(
                    "authenticate",
                    Some(serde_json::to_value(&AuthenticateParams { method_id })?),
                )
                .await
            {
                tracing::warn!("ACP authenticate 失败（将继续尝试会话）: {e}");
            }
        }

        tracing::info!(
            "ACP agent '{}' initialized (protocol v{})",
            agent_name,
            init_result.agent_info.version
        );

        Ok(())
    }

    pub async fn disconnect(self: &Arc<Self>) -> Result<()> {
        self.client.kill().await;
        self.initialized.store(false, Ordering::SeqCst);
        *self.agent_name.lock().await = None;
        self.conversation_sessions.lock().await.clear();
        self.prompted_conversations.lock().await.clear();
        Ok(())
    }

    /// 标记 conversation 已发送首轮完整 prompt；返回 `true` 表示本次为首次。
    pub async fn mark_first_prompt_sent(&self, conversation_id: &str) -> bool {
        self.prompted_conversations
            .lock()
            .await
            .insert(conversation_id.to_string())
    }

    pub async fn ensure_session(
        &self,
        conversation_id: &str,
        cwd: &str,
        mcp_servers: Vec<serde_json::Value>,
        model: Option<&str>,
    ) -> Result<String> {
        {
            let sessions = self.conversation_sessions.lock().await;
            if let Some(sid) = sessions.get(conversation_id) {
                return Ok(sid.clone());
            }
        }

        let params = SessionNewParams {
            cwd: cwd.to_string(),
            mcp_servers,
        };

        let result = self
            .client
            .request(
                "session/new",
                Some(serde_json::to_value(&params)?),
            )
            .await?;

        let new_result: SessionNewResult = serde_json::from_value(result)?;
        if let Some(requested) = model.filter(|m| !m.trim().is_empty() && *m != "auto") {
            apply_session_model(&self.client, &new_result, requested).await;
        }
        self.conversation_sessions
            .lock()
            .await
            .insert(conversation_id.to_string(), new_result.session_id.clone());
        Ok(new_result.session_id)
    }

    pub async fn cancel_prompt(&self, conversation_id: &str) -> Result<()> {
        let session_id = self
            .conversation_sessions
            .lock()
            .await
            .get(conversation_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("No ACP session for conversation"))?;

        self.client
            .notify(
                "session/cancel",
                Some(serde_json::to_value(&SessionCancelParams { session_id })?),
            )
            .await
    }

    pub async fn respond_permission(&self, request_id: u64, option_id: &str) -> Result<()> {
        let response = JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: request_id,
            result: Some(serde_json::json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id,
                }
            })),
            error: None,
        };
        self.client.write_response(response).await
    }

    /// Run a prompt turn, forwarding ACP events to `event_tx`.
    pub async fn prompt(
        &self,
        session_id: &str,
        user_text: &str,
        event_tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
        options: PromptOptions,
    ) -> Result<StopReason> {
        if !self.initialized.load(Ordering::SeqCst) {
            bail!("ACP agent not connected");
        }

        let prompt = vec![ContentBlock {
            block_type: "text".to_string(),
            text: Some(user_text.to_string()),
        }];

        let client = self.client.clone();
        let translate_options = TranslateOptions::new(options.client_tools);
        let client_tools = options.client_tools;
        let content_hold = options.content_hold;
        let content_buffer = options.content_buffer.clone();

        {
            let event_tx_updates = event_tx.clone();
            let translate_options = translate_options.clone();
            // 智能流式闸门：内容一旦确认为纯文本立即开闸（几乎无延迟地流式），
            // 疑似 tool_calls JSON 则全程 hold 到 buffer，由调用方在 turn 结束后解析，
            // 从根本上杜绝“半截/完整 tool_calls JSON 当正文泄露到前端”。
            let content_gate_open = Arc::new(AtomicBool::new(false));
            self.client
                .set_notification_handler(Arc::new(move |method, params| {
                    if method != "session/update" {
                        return;
                    }
                    if let Ok(notif) =
                        serde_json::from_value::<SessionUpdateNotification>(params.clone())
                    {
                        for event in
                            translate_session_update_from_notif(&notif, &translate_options)
                        {
                            if content_hold {
                                if let StreamEvent::ContentDelta { text } = &event {
                                    // 已开闸：后续文本直通流式
                                    if content_gate_open.load(Ordering::Relaxed) {
                                        if event_tx_updates.send(event).is_err() {
                                            break;
                                        }
                                        continue;
                                    }
                                    // 未开闸：累积并判定是否为纯文本
                                    let flush_text = if let Some(buf) = &content_buffer {
                                        if let Ok(mut guard) = buf.lock() {
                                            guard.push_str(text);
                                            if content_starts_as_plain_text(&guard) {
                                                let flushed = guard.clone();
                                                guard.clear();
                                                Some(flushed)
                                            } else {
                                                None
                                            }
                                        } else {
                                            None
                                        }
                                    } else {
                                        None
                                    };
                                    if let Some(flushed) = flush_text {
                                        content_gate_open.store(true, Ordering::Relaxed);
                                        if event_tx_updates
                                            .send(StreamEvent::ContentDelta { text: flushed })
                                            .is_err()
                                        {
                                            break;
                                        }
                                    }
                                    continue;
                                }
                            }
                            if event_tx_updates.send(event).is_err() {
                                break;
                            }
                        }
                    }
                }))
                .await;

            let event_tx_perm = event_tx.clone();
            self.client
                .set_server_request_handler(Arc::new(move |id, method, params| {
                    if method != "session/request_permission" {
                        return None;
                    }
                    let Ok(perm) =
                        serde_json::from_value::<RequestPermissionParams>(params.clone())
                    else {
                        return None;
                    };
                    let tool_call_id = perm
                        .tool_call
                        .get("toolCallId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let title = perm
                        .tool_call
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let raw_input = perm
                        .tool_call
                        .get("rawInput")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_else(|| "{}".to_string());
                    let perm_options: Vec<(String, String)> = perm
                        .options
                        .iter()
                        .map(|o| (o.option_id.clone(), o.name.clone()))
                        .collect();

                    // client-tools：同步拒绝 ACP 内置执行（对齐 cursor-gateway toolloop.DecidePermission）
                    if client_tools {
                        let reject_id = pick_reject_once_option(&perm_options);
                        return Some(serde_json::json!({
                            "outcome": {
                                "outcome": "selected",
                                "optionId": reject_id,
                            }
                        }));
                    }

                    let _ = event_tx_perm.send(StreamEvent::PermissionRequest {
                        request_id: id,
                        tool_call_id,
                        title,
                        raw_input,
                        options: perm_options,
                    });
                    None
                }))
                .await;
        }

        let sid = session_id.to_string();
        let client_bg = client.clone();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<StopReason>>();

        tokio::spawn(async move {
            let result = async {
                let val = client_bg
                    .request(
                        "session/prompt",
                        Some(serde_json::to_value(&SessionPromptParams {
                            session_id: sid,
                            prompt,
                        })?),
                    )
                    .await?;
                let prompt_result: PromptResult = serde_json::from_value(val)?;
                Ok(parse_stop_reason(prompt_result.stop_reason.as_deref()))
            }
            .await;

            let _ = done_tx.send(result);
        });

        match done_rx.await {
            Ok(Ok(stop)) => {
                if options.emit_done {
                    let _ = event_tx.send(StreamEvent::Done {
                        stop_reason: stop.clone(),
                    });
                }
                self.client.clear_handlers().await;
                Ok(stop)
            }
            Ok(Err(e)) => {
                let _ = event_tx.send(StreamEvent::Error {
                    message: e.to_string(),
                });
                self.client.clear_handlers().await;
                Err(e)
            }
            Err(_) => {
                self.client.clear_handlers().await;
                bail!("ACP prompt task dropped")
            }
        }
    }
}

fn translate_session_update_from_notif(
    notif: &SessionUpdateNotification,
    options: &TranslateOptions,
) -> Vec<StreamEvent> {
    translate_update_value(&notif.update, options)
}

/// 判断累积内容是否已可确认为“纯文本”（可安全流式），而非 tool_calls JSON。
/// 首个非空白字符若是 `{` / `[` / 反引号（可能是 JSON 或 markdown 代码块），
/// 则保持 hold；否则视为普通文本，立即开闸。
fn content_starts_as_plain_text(buf: &str) -> bool {
    let trimmed = buf.trim_start();
    match trimmed.chars().next() {
        None => false,
        Some('{') | Some('[') | Some('`') => false,
        Some(_) => true,
    }
}

fn pick_reject_once_option(options: &[(String, String)]) -> &str {
    for (id, _) in options {
        if id.contains("reject") {
            return id;
        }
    }
    "reject-once"
}

/// 将客户端工具执行结果格式化为 ACP 后续 prompt。
pub fn format_client_tool_result_prompt(tool_name: &str, result: &str, approved: bool) -> String {
    use crate::providers::acp::client_tools::parse_tool_result_exit_code;

    let body = if approved {
        result.to_string()
    } else {
        "用户拒绝执行".to_string()
    };

    if !approved {
        return format!(
            "[Tool Result — {tool_name}]\n{body}\n\n[System — 工具已执行完毕]\n\
             用户拒绝了命令执行。请用自然语言说明并询问是否需要其他方式。\n\
             不要再次输出 tool_calls JSON。\n"
        );
    }

    if let Some(code) = parse_tool_result_exit_code(result) {
        if code != 0 {
            return format!(
                "[Tool Result — {tool_name}]\n{body}\n\n[System — 命令执行失败]\n\
                 上方命令未成功（exitCode={code}）。请根据 [Terminal Context] 中的 shell/OS \
                 选择正确的命令，通过 tool_calls JSON 再试一次；不要使用错误平台的命令。\n"
            );
        }
    }

    format!(
        "[Tool Result — {tool_name}]\n{body}\n\n[System — 工具已执行完毕]\n\
         上方工具输出里已有真实结果。请用自然语言直接回答用户。\n\
         不要再次输出 tool_calls JSON。\n"
    )
}

/// 合并多个客户端工具结果为单个续轮 prompt（模型一轮并行调用多个工具时）。
/// 单个结果时等价于 `format_client_tool_result_prompt`，保持失败/拒绝语义。
pub fn format_client_tool_results_prompt(results: &[(String, String, bool)]) -> String {
    use crate::providers::acp::client_tools::parse_tool_result_exit_code;

    if results.len() == 1 {
        let (name, result, approved) = &results[0];
        return format_client_tool_result_prompt(name, result, *approved);
    }

    let mut blocks = String::new();
    let mut any_rejected = false;
    let mut any_failed = false;
    for (name, result, approved) in results {
        if !approved {
            any_rejected = true;
            blocks.push_str(&format!("[Tool Result — {name}]\n用户拒绝执行\n\n"));
            continue;
        }
        if let Some(code) = parse_tool_result_exit_code(result) {
            if code != 0 {
                any_failed = true;
            }
        }
        blocks.push_str(&format!("[Tool Result — {name}]\n{result}\n\n"));
    }

    let system = if any_rejected {
        "[System — 部分工具被拒绝]\n用户拒绝了部分命令执行。请用自然语言说明并询问是否需要其他方式。\n不要再次输出 tool_calls JSON。\n"
    } else if any_failed {
        "[System — 命令执行失败]\n上方部分命令未成功。请根据 [Terminal Context] 中的 shell/OS 选择正确的命令，通过 tool_calls JSON 再试一次；不要使用错误平台的命令。\n"
    } else {
        "[System — 工具已执行完毕]\n上方工具输出里已有真实结果。请用自然语言直接回答用户。\n不要再次输出 tool_calls JSON。\n"
    };
    format!("{blocks}{system}")
}

pub use client_tools::{
    ParsedToolCall, build_client_tools_prompt, build_incremental_client_tools_prompt,
    build_incremental_prompt, looks_like_pending_tool_calls_json, parse_client_tool_calls,
    pick_terminal_tool_call, prompt_expects_tool_retry, prompt_has_tool_results,
};
pub use native_tools::TERMINAL_CLIENT_TOOL as ACP_TERMINAL_CLIENT_TOOL;

fn parse_stop_reason(raw: Option<&str>) -> StopReason {
    match raw {
        Some("cancelled") => StopReason::Cancelled,
        Some("refusal") => StopReason::Refusal,
        Some("max_tokens") => StopReason::MaxTokens,
        Some("error") => StopReason::Error,
        _ => StopReason::EndTurn,
    }
}

fn should_skip_acp_authenticate() -> bool {
    for key in ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "ANTHROPIC_API_KEY"] {
        if std::env::var(key)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        {
            return true;
        }
    }
    false
}

async fn apply_session_model(
    client: &Arc<AcpClient>,
    session: &SessionNewResult,
    requested: &str,
) {
    let session_id = session.session_id.clone();
    if try_set_config_option(client, &session_id, "model", requested, &session.config_options).await
    {
        return;
    }
    if client
        .request(
            "session/set_model",
            Some(serde_json::to_value(&SetModelParams {
                session_id,
                model_id: requested.to_string(),
            }).unwrap_or_default()),
        )
        .await
        .is_ok()
    {
        return;
    }
    tracing::warn!("ACP 未能设置模型 {requested}，将使用 Agent 默认模型");
}

async fn try_set_config_option(
    client: &Arc<AcpClient>,
    session_id: &str,
    config_id: &str,
    requested: &str,
    options: &[ConfigOption],
) -> bool {
    let Some(option) = options.iter().find(|o| o.id == config_id) else {
        return false;
    };
    let mut value_id = String::new();
    let mut value = String::new();
    for candidate in &option.options {
        if candidate.value_id == requested || candidate.value == requested {
            value_id = candidate.value_id.clone();
            value = candidate.value.clone();
            break;
        }
    }
    if value_id.is_empty() && value.is_empty() {
        value = requested.to_string();
    }
    if !value_id.is_empty() {
        if client
            .request(
                "session/set_config_option",
                Some(
                    serde_json::to_value(&SetConfigOptionParams {
                        session_id: session_id.to_string(),
                        config_id: config_id.to_string(),
                        value: String::new(),
                        value_id,
                    })
                    .unwrap_or_default(),
                ),
            )
            .await
            .is_ok()
        {
            return true;
        }
    }
    if !value.is_empty() {
        return client
            .request(
                "session/set_config_option",
                Some(
                    serde_json::to_value(&SetConfigOptionParams {
                        session_id: session_id.to_string(),
                        config_id: config_id.to_string(),
                        value,
                        value_id: String::new(),
                    })
                    .unwrap_or_default(),
                ),
            )
            .await
            .is_ok();
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_opens_gate_but_json_holds() {
        // 普通文本（含中文/字母）→ 立即开闸
        assert!(content_starts_as_plain_text("当前时间是"));
        assert!(content_starts_as_plain_text("The time is"));
        assert!(content_starts_as_plain_text("  \n已完成"));
        // JSON / 数组 / markdown 代码块 → 保持 hold
        assert!(!content_starts_as_plain_text("{\"tool_calls\""));
        assert!(!content_starts_as_plain_text("  {"));
        assert!(!content_starts_as_plain_text("[{"));
        assert!(!content_starts_as_plain_text("```json"));
        // 空白 → 尚不能判定，保持 hold
        assert!(!content_starts_as_plain_text("   "));
    }

    #[test]
    fn multi_results_all_success() {
        let results = vec![
            (
                "omni_terminal_run_terminal_command".to_string(),
                "{\"command\":\"a\",\"exitCode\":0}".to_string(),
                true,
            ),
            (
                "omni_terminal_run_terminal_command".to_string(),
                "{\"command\":\"b\",\"exitCode\":0}".to_string(),
                true,
            ),
        ];
        let p = format_client_tool_results_prompt(&results);
        assert_eq!(p.matches("[Tool Result — ").count(), 2);
        assert!(p.contains("[System — 工具已执行完毕]"));
        assert!(p.contains("不要再次输出 tool_calls JSON"));
    }

    #[test]
    fn multi_results_with_rejection() {
        let results = vec![
            (
                "omni_terminal_run_terminal_command".to_string(),
                "{\"command\":\"a\",\"exitCode\":0}".to_string(),
                true,
            ),
            (
                "omni_terminal_run_terminal_command".to_string(),
                String::new(),
                false,
            ),
        ];
        let p = format_client_tool_results_prompt(&results);
        assert!(p.contains("用户拒绝执行"));
        assert!(p.contains("[System — 部分工具被拒绝]"));
    }

    #[test]
    fn single_result_delegates_to_single_formatter() {
        let results = vec![(
            "omni_terminal_run_terminal_command".to_string(),
            "{\"command\":\"date\",\"exitCode\":0}".to_string(),
            true,
        )];
        let p = format_client_tool_results_prompt(&results);
        assert!(p.contains("[Tool Result — omni_terminal_run_terminal_command]"));
        assert!(p.contains("请用自然语言直接回答用户"));
    }
}
