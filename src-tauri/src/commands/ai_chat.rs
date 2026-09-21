use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use omnipanel_ai::ir::StreamEvent;
use omnipanel_ai::orchestrator::{
    AiContextBundle, HttpProviderSnapshot, InternalChatRequest, InternalToolsMode,
};
use omnipanel_ai::types::{ChatMessage, ToolDef};
use omnipanel_mcp::ToolRegistry;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, State, ipc::Channel};
use tokio::sync::{Mutex, oneshot};

use crate::commands::knowledge_vector::{EmbeddingProviderConfig, fetch_provider_embeddings};
use crate::state::AppState;

fn apply_tool_allowlist(mut defs: Vec<ToolDef>, allowlist: Option<&[String]>) -> Vec<ToolDef> {
    let Some(names) = allowlist else {
        return defs;
    };
    if names.is_empty() {
        return defs;
    }
    let set: std::collections::HashSet<&str> = names.iter().map(String::as_str).collect();
    defs.retain(|d| set.contains(d.function.name.as_str()));
    defs
}

/// 把跨模块澄清/计划工具提到列表前部，降低长工具列表下被模型忽略的概率。
fn prioritize_cross_module_tools(mut defs: Vec<ToolDef>) -> Vec<ToolDef> {
    defs.sort_by_key(|d| {
        if d.function.name == "omni_ask_user" {
            0u8
        } else if omnipanel_store::builtin_tool_is_cross_module(&d.function.name) {
            1u8
        } else {
            2u8
        }
    });
    defs
}

fn log_injected_tools(conversation_id: &str, filter: Option<&str>, defs: &[ToolDef]) {
    let has_ask_user = defs.iter().any(|d| d.function.name == "omni_ask_user");
    let names: Vec<&str> = defs.iter().map(|d| d.function.name.as_str()).collect();
    tracing::info!(
        conversation_id = %conversation_id,
        module_filter = ?filter,
        tool_count = defs.len(),
        has_omni_ask_user = has_ask_user,
        tools = ?names,
        "ai_chat: injected tools"
    );
}

/// 模块隔离：指定 filter（非 master）时，工具必须属于该 module_key。
fn ensure_tool_allowed_by_module_filter(
    tool_name: &str,
    module_filter: Option<&str>,
) -> Result<(), String> {
    let Some(filter) = module_filter.filter(|f| !f.is_empty() && *f != "master") else {
        return Ok(());
    };
    if omnipanel_store::builtin_tool_is_cross_module(tool_name) {
        return Ok(());
    }
    match omnipanel_store::builtin_tool_module_key(tool_name) {
        Some(key) if key == filter => Ok(()),
        Some(key) => Err(format!(
            "工具 {tool_name} 属于模块 {key}，当前 Agent 仅允许模块 {filter}"
        )),
        None => Err(format!(
            "工具 {tool_name} 不在当前模块 ({filter}) 的允许范围内"
        )),
    }
}

pub type InternalChatCancelFlags = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct InternalChatRequestDto {
    pub conversation_id: String,
    pub user_text: String,
    pub backend_id: String,
    pub context: AiContextBundleDto,
    /// JSON-encoded `ChatMessage[]` for multi-turn history.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_json: Option<String>,
    pub tools_mode: InternalToolsModeDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_provider: Option<HttpProviderSnapshotDto>,
    /// 知识库 RAG 自动注入用的 embedding provider 配置。
    /// 仅在 DirectInject 模式下生效；为 None 时跳过 RAG 注入。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub embedding_provider: Option<EmbeddingProviderConfig>,
    /// 纯文本补全模式（oneshot：会话命名、历史摘要等）。
    /// 为 true 时跳过工具注入 / RAG / Skills / 多轮循环，prompt_text 直接用 user_text。
    #[serde(default)]
    pub pure_text: bool,
    /// 会话中用户勾选的 Skill id；非空时除摘要目录外再注入完整正文。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skill_ids: Option<Vec<String>>,
    /// 推理强度：`default` | `low` | `medium` | `high`。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// 逻辑 Agent 标识（chat / terminal / database …）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    /// Agent 身份说明，注入 system_append 顶部。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_system_role: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiContextBundleDto {
    pub cwd: Option<String>,
    pub workspace_id: Option<String>,
    pub terminal_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_session_type: Option<String>,
    pub env_tag: Option<String>,
    pub resource_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_context_append: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub module_context_append: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpProviderSnapshotDto {
    pub provider_id: String,
    pub api_standard: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum InternalToolsModeDto {
    None,
    /// 变体字段也必须 camelCase：枚举级 `rename_all` 只改变体名，不改 struct 字段名。
    /// 否则前端传入的 `moduleFilter` 会被忽略，过滤失效、注入全量工具。
    #[serde(rename_all = "camelCase")]
    DirectInject {
        #[serde(default)]
        module_filter: Option<String>,
        #[serde(default)]
        tool_allowlist: Option<Vec<String>>,
    },
}

impl TryFrom<InternalChatRequestDto> for InternalChatRequest {
    type Error = String;

    fn try_from(dto: InternalChatRequestDto) -> Result<Self, Self::Error> {
        let history = match dto.history_json {
            Some(json) if !json.trim().is_empty() => Some(
                serde_json::from_str::<Vec<ChatMessage>>(&json)
                    .map_err(|e| format!("history_json 解析失败: {e}"))?,
            ),
            _ => None,
        };

        Ok(InternalChatRequest {
            conversation_id: dto.conversation_id,
            user_text: dto.user_text,
            backend_id: dto.backend_id,
            context: AiContextBundle {
                cwd: dto.context.cwd,
                workspace_id: dto.context.workspace_id,
                terminal_session_id: dto.context.terminal_session_id,
                terminal_session_type: dto.context.terminal_session_type,
                env_tag: dto.context.env_tag,
                resource_id: dto.context.resource_id,
                terminal_context_append: dto.context.terminal_context_append,
                module_context_append: dto.context.module_context_append,
            },
            history,
            tools_mode: match dto.tools_mode {
                InternalToolsModeDto::None => InternalToolsMode::None,
                InternalToolsModeDto::DirectInject {
                    module_filter,
                    tool_allowlist,
                } => {
                    // 防御：plan Agent 无论前端传什么 filter，一律锁定全局工具面（web）。
                    let module_filter = if dto.agent_id.as_deref() == Some("plan") {
                        Some("web".to_string())
                    } else {
                        module_filter
                    };
                    InternalToolsMode::DirectInject {
                        module_filter,
                        tool_allowlist,
                    }
                }
            },
            http_provider: dto.http_provider.map(|p| HttpProviderSnapshot {
                provider_id: p.provider_id,
                api_standard: p.api_standard,
                base_url: p.base_url,
                api_key: p.api_key,
            }),
            system_append: None,
            pure_text: dto.pure_text,
            reasoning_effort: dto.reasoning_effort,
            agent_id: dto.agent_id,
        })
    }
}

/// 本地 ACP Agent 进程的工作目录。远程终端场景禁止把远程路径当作本地 cwd。
fn resolve_acp_session_cwd(context: &AiContextBundle) -> String {
    let is_remote_terminal = context
        .terminal_session_type
        .as_deref()
        .is_some_and(|t| t.eq_ignore_ascii_case("remote"));

    if is_remote_terminal {
        return crate::commands::acp::default_cwd();
    }

    context
        .cwd
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(crate::commands::acp::default_cwd)
}

/// 构建知识库 RAG 自动注入文本。
///
/// 流程：
/// 1. 用 embedding provider 把 `user_text` 转成向量
/// 2. 全库 top_n 向量检索
/// 3. 过滤 score < min_score 的低质量命中
/// 4. 对命中条目异步 increment_usage（Task 1.4 接通）
/// 5. 格式化为 "## Knowledge Context" 段落
///
/// 任何步骤失败都返回 Err，调用方静默跳过（不阻塞 AI 请求）。
async fn build_knowledge_rag_append(
    state: &AppState,
    provider: &EmbeddingProviderConfig,
    user_text: &str,
    top_n: usize,
    min_score: f64,
) -> Result<String, String> {
    let query_text = user_text.trim();
    if query_text.is_empty() || query_text.len() < 2 {
        return Err("query too short".to_string());
    }

    // 1. 生成 query embedding
    let query_vectors = fetch_provider_embeddings(provider, &[query_text.to_string()]).await?;
    let query_embedding = query_vectors
        .into_iter()
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "query embedding 为空".to_string())?;

    // 2. 向量检索 + 补 title
    let storage = state.storage.lock().await;
    let hits = storage
        .search_knowledge_vectors(&query_embedding, top_n)
        .map_err(|e| e.to_string())?;

    // 3. 过滤低分命中 + 补 title
    let mut filtered: Vec<(String, String, String, f64)> = Vec::new();
    for hit in hits {
        if hit.score < min_score {
            continue;
        }
        let title = match storage.get_knowledge(&hit.entry_id) {
            Ok(Some(e)) => e.title,
            _ => hit.entry_id.clone(),
        };
        filtered.push((hit.entry_id.clone(), title, hit.content.clone(), hit.score));

        // 4. Task 1.4：自动 increment_usage（命中即记一次使用）
        let _ = storage.increment_usage(&hit.entry_id);
    }
    drop(storage);

    if filtered.is_empty() {
        return Ok(String::new());
    }

    // 5. 格式化为 system prompt 段落
    let mut lines = vec![
        "## Knowledge Context".to_string(),
        "以下是从知识库检索到的相关文档片段（按相似度降序），可结合用户问题参考：".to_string(),
    ];
    for (idx, (entry_id, title, content, score)) in filtered.iter().enumerate() {
        let truncated = truncate_content(content, 600);
        lines.push(format!(
            "\n### [{idx}] {title}\n- 文档 ID: {entry_id}\n- 相似度: {score:.3}\n- 内容:\n{truncated}"
        ));
    }
    Ok(lines.join("\n"))
}

fn truncate_content(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        return s.to_string();
    }
    let mut result: String = s.chars().take(max_chars).collect();
    result.push_str("\n...(已截断)");
    result
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request: InternalChatRequestDto,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    // 在 move 进 TryFrom 前提取 embedding provider / skill_ids / agent 角色，供注入使用。
    let mut request = request;
    let embedding_provider = request.embedding_provider.take();
    let skill_ids = request.skill_ids.take().unwrap_or_default();
    let client_agent_role = request
        .agent_system_role
        .take()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let user_text_for_rag = request.user_text.clone();
    let mut internal = InternalChatRequest::try_from(request)?;
    // pure_text 模式跳过 RAG / Skills / Agent 角色注入。
    // 注意：Skills/RAG 与工具解耦——plan Agent（tools_mode=None）仍可注入上下文。
    if !internal.pure_text {
        let mut append_parts: Vec<String> = Vec::new();

        // 优先读设置页配置的模块 Agent 提示词；否则回退前端传入的 systemRole。
        let role = internal
            .agent_id
            .as_deref()
            .map(omnipanel_store::agent_prompt)
            .filter(|s| !s.trim().is_empty())
            .or(client_agent_role);
        if let Some(role) = role {
            append_parts.push(format!("[Agent]\n{role}"));
        }

        let load_skill_available = match &internal.tools_mode {
            InternalToolsMode::None => false,
            InternalToolsMode::DirectInject { tool_allowlist, .. } => tool_allowlist
                .as_ref()
                .map(|list| list.iter().any(|n| n == "load_skill"))
                .unwrap_or(true),
        };
        // 1. Skills 摘要（渐进式披露；勾选中的 Skill 只走 Active Skills）
        if let Ok(skills_text) =
            omnipanel_store::build_skills_system_append_filtered(load_skill_available, &skill_ids)
        {
            if !skills_text.is_empty() {
                append_parts.push(skills_text);
            }
        }

        // 1b. 用户在 Composer 勾选的 Skill 全文
        if !skill_ids.is_empty() {
            if let Ok(selected) = omnipanel_store::build_selected_skills_bodies_append(&skill_ids) {
                if !selected.is_empty() {
                    append_parts.push(selected);
                }
            }
        }

        // 2. 知识库 RAG 自动注入：top-3 语义检索
        if let Some(provider) = embedding_provider.as_ref() {
            if let Ok(rag_text) =
                build_knowledge_rag_append(&state, provider, &user_text_for_rag, 3, 0.35).await
            {
                if !rag_text.is_empty() {
                    append_parts.push(rag_text);
                }
            }
        }

        if !append_parts.is_empty() {
            internal.system_append = Some(append_parts.join("\n\n---\n\n"));
        }
    }

    let conversation_id = internal.conversation_id.clone();

    let parsed = omnipanel_ai::routing::parse_backend_id(&internal.backend_id)?;
    match parsed.kind {
        omnipanel_ai::routing::BackendKind::OpenCode => {
            let (provider_id, model_id) =
                omnipanel_ai::routing::normalize_opencode_backend(&parsed)?;
            run_opencode_http_internal_turn(
                &state,
                &internal,
                &conversation_id,
                &provider_id,
                &model_id,
                on_event,
            )
            .await
        }
        omnipanel_ai::routing::BackendKind::Cli => {
            let (agent_kind, model_id) = omnipanel_ai::routing::normalize_cli_backend(&parsed)?;
            run_acp_internal_turn(
                &app,
                &state,
                &internal,
                &conversation_id,
                &agent_kind,
                Some(model_id),
                on_event,
            )
            .await
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ai_chat_cancel(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let flags = state.internal_chat_cancel_flags.lock().await;
    if let Some(flag) = flags.get(&conversation_id) {
        flag.store(true, Ordering::Relaxed);
    }
    drop(flags);

    let prefix = format!("{conversation_id}:");
    let mut pending = state.pending_internal_tool_results.lock().await;
    let keys: Vec<String> = pending
        .keys()
        .filter(|k| k.starts_with(&prefix))
        .cloned()
        .collect();
    for key in keys {
        if let Some(tx) = pending.remove(&key) {
            let _ = tx.send(("用户已取消".to_string(), false));
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn ai_chat_tool_result(
    state: State<'_, AppState>,
    conversation_id: String,
    tool_call_id: String,
    result: String,
    approved: bool,
) -> Result<(), String> {
    let key = format!("{conversation_id}:{tool_call_id}");
    let sender = state
        .pending_internal_tool_results
        .lock()
        .await
        .remove(&key);
    match sender {
        Some(tx) => {
            let _ = tx.send((result, approved));
            Ok(())
        }
        None => Err(format!("未找到待处理的工具调用: {key}")),
    }
}

/// OpenCode HTTP 路径：ensure `opencode serve` → session/prompt/SSE → StreamEvent。
/// OpenCode 自带工具循环；此处不注入 OmniPanel client tools。
async fn run_opencode_http_internal_turn(
    state: &AppState,
    internal: &InternalChatRequest,
    conversation_id: &str,
    provider_id: &str,
    model_id: &str,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let backend_id = internal.backend_id.clone();
    let cwd = resolve_acp_session_cwd(&internal.context);

    let binary = crate::commands::providers::cli_provider_list()
        .ok()
        .and_then(|list| {
            list.into_iter()
                .find(|p| p.id == "opencode")
                .and_then(|p| p.binary)
        });
    let binary_path = binary.as_ref().map(std::path::PathBuf::from);

    let mut prompt_text = internal.user_text.clone();
    if let Some(append) = internal
        .system_append
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        prompt_text = format!("{append}\n\n---\n\n{prompt_text}");
    }

    record_prompt_sent_trace(state, conversation_id, &backend_id, 0, 0, &prompt_text);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<StreamEvent>(128);
    let conversation_for_turn = conversation_id.to_string();
    let cwd_owned = cwd.clone();
    let provider_owned = provider_id.to_string();
    let model_owned = model_id.to_string();
    let prompt_owned = prompt_text.clone();
    let turn_handle = tokio::spawn(async move {
        omnipanel_ai::providers::opencode::run_opencode_http_turn(
            binary_path.as_deref(),
            &conversation_for_turn,
            &cwd_owned,
            &provider_owned,
            &model_owned,
            &prompt_owned,
            tx,
        )
        .await
    });

    while let Some(event) = rx.recv().await {
        record_internal_trace(state, conversation_id, &backend_id, 0, &event);
        let _ = on_event.send(event);
    }

    turn_handle
        .await
        .map_err(|e| format!("OpenCode turn join 失败: {e}"))?
}

async fn execute_acp_web_tool(state: &AppState, name: &str, arguments: &str) -> (String, bool) {
    let storage = {
        let manager = state.mcp_manager.lock().await;
        manager.tool_registry.storage_handle()
    };
    let proxy = {
        let p = state.proxy_config.lock().await;
        omnipanel_store::HttpProxyConfig {
            enabled: p.enabled,
            protocol: p.protocol.clone(),
            host: p.host.clone(),
            port: p.port,
            username: p.username.clone(),
            password: p.password.clone(),
            has_password: !p.password.is_empty(),
        }
    };
    let args: serde_json::Value =
        serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
    match ToolRegistry::execute_isolated(storage, name, args, Some(proxy)).await {
        Ok(pair) => pair,
        Err(err) => (format!("Error: {err}"), false),
    }
}

async fn run_acp_internal_turn(
    app: &AppHandle,
    state: &AppState,
    internal: &InternalChatRequest,
    conversation_id: &str,
    agent_kind: &str,
    model_id: Option<String>,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    use omnipanel_ai::ToolStatus;
    use omnipanel_ai::providers::acp::native_tools::TERMINAL_CLIENT_TOOL;
    use omnipanel_ai::providers::acp::{
        AcpRoundRunner, build_client_tools_prompt, build_incremental_client_tools_prompt,
        format_client_tool_result_prompt, parse_client_tool_calls, pick_terminal_tool_call,
        prompt_expects_tool_retry, prompt_has_tool_results,
    };

    let backend_id = internal.backend_id.clone();

    let cwd = resolve_acp_session_cwd(&internal.context);

    let manager = state
        .agent_registry
        .get_or_connect(app, state, agent_kind)
        .await?;

    let mcp_servers: Vec<serde_json::Value> = Vec::new();
    let session_id = manager
        .ensure_session(conversation_id, &cwd, mcp_servers, model_id.as_deref())
        .await
        .map_err(|e| e.to_string())?;

    let runner = AcpRoundRunner::new(manager.clone(), session_id.clone());

    let terminal_context = internal
        .context
        .terminal_context_append
        .as_deref()
        .filter(|s| !s.trim().is_empty());

    // pure_text 模式：oneshot 纯文本补全（会话命名、历史摘要等）。
    // 跳过 CLIENT_TOOLS_PREAMBLE + master 工具清单注入，prompt_text 直接用 user_text，
    // 不进入工具调用循环（MAX_ACP_TOOL_ROUNDS = 1）。
    // 这是一条特殊路径：不需要工具、不需要多轮、不需要 preamble，只需要模型根据 prompt 直接输出文本。
    let is_pure_text = internal.pure_text;

    // 有客户端 tools 才进入 client_tools 模式。
    // tools_mode=None 与 pure_text 均不注入工具。
    // 模块 Agent 使用对应 module_filter；plan 等可用 tool_allowlist 收窄工具面。
    let client_tool_defs: Vec<ToolDef> = if is_pure_text {
        Vec::new()
    } else {
        match &internal.tools_mode {
            InternalToolsMode::DirectInject {
                module_filter,
                tool_allowlist,
            } => {
                let mcp = state.mcp_manager.lock().await;
                let filter = module_filter.as_deref();
                let defs = mcp
                    .to_internal_tool_defs(filter)
                    .await
                    .map_err(|e| e.to_string())?;
                let defs = prioritize_cross_module_tools(apply_tool_allowlist(
                    defs,
                    tool_allowlist.as_deref(),
                ));
                log_injected_tools(conversation_id, filter, &defs);
                defs
            }
            InternalToolsMode::None => Vec::new(),
        }
    };
    let client_tools = !client_tool_defs.is_empty();

    let is_first_user_prompt = if client_tools {
        let agent_key = internal.agent_id.as_deref().unwrap_or("");
        manager
            .mark_first_prompt_sent(conversation_id, agent_key)
            .await
    } else {
        true
    };

    let mut prompt_text = if client_tools {
        if is_first_user_prompt {
            build_client_tools_prompt(&internal.user_text, terminal_context, &client_tool_defs)
        } else {
            build_incremental_client_tools_prompt(&internal.user_text, terminal_context)
        }
    } else {
        // pure_text 或无工具时：直接用原始 user_text，不包裹 [User] 块 / preamble
        internal.user_text.clone()
    };

    // ACP/CLI 不走 HTTP system message；首轮将 Skills / RAG 等 append 拼进 prompt。
    // system_append 已被 !pure_text 守护（ai_chat_stream 命令层注入时检查），pure_text 时为 None，安全。
    if is_first_user_prompt {
        if let Some(append) = internal
            .system_append
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            prompt_text = format!("{append}\n\n---\n\n{prompt_text}");
        }
    }

    // pure_text 单轮完成；正常对话最多 8 轮工具调用
    const MAX_ACP_TOOL_ROUNDS_NORMAL: usize = 8;
    const MAX_ACP_TOOL_ROUNDS_PURE_TEXT: usize = 1;
    let max_rounds = if is_pure_text {
        MAX_ACP_TOOL_ROUNDS_PURE_TEXT
    } else {
        MAX_ACP_TOOL_ROUNDS_NORMAL
    };
    let mut turn_index: i32 = 0;

    for round in 0..max_rounds {
        record_prompt_sent_trace(
            state,
            conversation_id,
            &backend_id,
            turn_index,
            round,
            &prompt_text,
        );

        let is_tool_continuation = client_tools && prompt_has_tool_results(&prompt_text);
        let expects_tool_retry = client_tools && prompt_expects_tool_retry(&prompt_text);
        let content_buffer =
            AcpRoundRunner::maybe_content_buffer(AcpRoundRunner::should_hold_content(
                client_tools,
                is_tool_continuation,
                expects_tool_retry,
            ));

        let pending_tool: Arc<Mutex<Option<tokio::sync::oneshot::Receiver<(String, bool)>>>> =
            Arc::new(Mutex::new(None));
        let pending_tool_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let pending_tool_name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        // Native 工具（WebSearch/WebFetch）后端直执结果：(tool_name, result, approved)
        let mut native_tool_result: Option<(String, String, bool)> = None;

        let map_hints = omnipanel_ai::providers::acp::native_tools::NativeMapHints::from_tool_names(
            client_tool_defs.iter().map(|d| d.function.name.as_str()),
            omnipanel_ai::providers::acp::native_tools::NativeMapHints::powershell_from_terminal_context(
                terminal_context,
            ),
        );
        let (mut rx, prompt_handle) = runner.start_round_with_hints(
            &prompt_text,
            client_tools,
            content_buffer.clone(),
            // 桌面路径映射 ACP 原生 Read/Write/Shell（按本轮 files / shell）；
            // gateway 仍 suppress_all_native，因外部客户端无法执行 omni_*。
            false,
            map_hints,
        );

        while let Some(event) = rx.recv().await {
            if client_tools {
                if let StreamEvent::ToolCall {
                    id,
                    name,
                    arguments,
                } = &event
                {
                    if let Err(err) = ensure_tool_allowed_by_module_filter(
                        name,
                        match &internal.tools_mode {
                            InternalToolsMode::DirectInject { module_filter, .. } => {
                                module_filter.as_deref()
                            }
                            InternalToolsMode::None => None,
                        },
                    ) {
                        let update = StreamEvent::ToolCallUpdate {
                            id: id.clone(),
                            status: ToolStatus::Failed,
                            result: Some(format!("Error: {err}")),
                        };
                        record_internal_trace(
                            state,
                            conversation_id,
                            &backend_id,
                            turn_index,
                            &update,
                        );
                        let _ = on_event.send(update);
                        native_tool_result = Some((name.clone(), format!("Error: {err}"), false));
                        continue;
                    }
                    if ToolRegistry::is_native_tool(name) && name != TERMINAL_CLIENT_TOOL {
                        let (result, success) = execute_acp_web_tool(state, name, arguments).await;
                        native_tool_result = Some((name.clone(), result.clone(), success));
                        let update = StreamEvent::ToolCallUpdate {
                            id: id.clone(),
                            status: if success {
                                ToolStatus::Completed
                            } else {
                                ToolStatus::Failed
                            },
                            result: Some(result),
                        };
                        record_internal_trace(
                            state,
                            conversation_id,
                            &backend_id,
                            turn_index,
                            &update,
                        );
                        let _ = on_event.send(update);
                    } else {
                        // 终端 / UiDelegated：挂起等前端执行
                        let key = format!("{conversation_id}:{id}");
                        let (tool_tx, tool_rx) = tokio::sync::oneshot::channel();
                        state
                            .pending_internal_tool_results
                            .lock()
                            .await
                            .insert(key, tool_tx);
                        *pending_tool.lock().await = Some(tool_rx);
                        *pending_tool_id.lock().await = Some(id.clone());
                        *pending_tool_name.lock().await = Some(name.clone());
                        let _ = arguments;
                    }
                }
            }

            if matches!(&event, StreamEvent::Error { .. }) {
                record_internal_trace(state, conversation_id, &backend_id, turn_index, &event);
                let _ = on_event.send(event);
                break;
            }
            record_internal_trace(state, conversation_id, &backend_id, turn_index, &event);
            let _ = on_event.send(event);
        }

        let stop = prompt_handle
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e)?;

        // 路径 B：ACP 原生 tool_call 已被 translate 映射并在流中注册 pending
        if client_tools {
            // Native 工具（WebSearch/WebFetch）已在事件循环中后端直执，直接格式化结果续轮
            if let Some((tool_name, result, _success)) = native_tool_result.take() {
                prompt_text = format_client_tool_result_prompt(&tool_name, &result, true);
                turn_index += 1;
                continue;
            }

            if pending_tool.lock().await.is_none() {
                if let Some(buf) = &content_buffer {
                    let text = buf.lock().map(|g| g.clone()).unwrap_or_default();
                    let calls = parse_client_tool_calls(&text);
                    // 取第一个 tool_call（优先终端，否则任意 omni_*）
                    if let Some(tc) = pick_terminal_tool_call(&calls) {
                        let tool_id = tc.id.clone();
                        let tool_name = tc.name.clone();
                        let args = tc.arguments.clone();

                        if let Err(err) = ensure_tool_allowed_by_module_filter(
                            &tool_name,
                            match &internal.tools_mode {
                                InternalToolsMode::DirectInject { module_filter, .. } => {
                                    module_filter.as_deref()
                                }
                                InternalToolsMode::None => None,
                            },
                        ) {
                            let tool_call = StreamEvent::ToolCall {
                                id: tool_id.clone(),
                                name: tool_name.clone(),
                                arguments: args.clone(),
                            };
                            record_internal_trace(
                                state,
                                conversation_id,
                                &backend_id,
                                turn_index,
                                &tool_call,
                            );
                            let _ = on_event.send(tool_call);
                            let update = StreamEvent::ToolCallUpdate {
                                id: tool_id,
                                status: ToolStatus::Failed,
                                result: Some(format!("Error: {err}")),
                            };
                            record_internal_trace(
                                state,
                                conversation_id,
                                &backend_id,
                                turn_index,
                                &update,
                            );
                            let _ = on_event.send(update);
                            prompt_text = format_client_tool_result_prompt(
                                &tool_name,
                                &format!("Error: {err}"),
                                true,
                            );
                            turn_index += 1;
                            continue;
                        }

                        // Native 工具（web/zhihu/…）后端直执；终端与其它 UiDelegated 挂起前端
                        if ToolRegistry::is_native_tool(&tool_name)
                            && tool_name != TERMINAL_CLIENT_TOOL
                        {
                            let tool_call = StreamEvent::ToolCall {
                                id: tool_id.clone(),
                                name: tool_name.clone(),
                                arguments: args.clone(),
                            };
                            record_internal_trace(
                                state,
                                conversation_id,
                                &backend_id,
                                turn_index,
                                &tool_call,
                            );
                            let _ = on_event.send(tool_call);

                            let (result, success) =
                                execute_acp_web_tool(state, &tool_name, &args).await;
                            let update = StreamEvent::ToolCallUpdate {
                                id: tool_id,
                                status: if success {
                                    ToolStatus::Completed
                                } else {
                                    ToolStatus::Failed
                                },
                                result: Some(result.clone()),
                            };
                            record_internal_trace(
                                state,
                                conversation_id,
                                &backend_id,
                                turn_index,
                                &update,
                            );
                            let _ = on_event.send(update);
                            prompt_text =
                                format_client_tool_result_prompt(&tool_name, &result, success);
                            turn_index += 1;
                            continue;
                        }

                        // 终端 / 其它 UiDelegated：挂起等前端执行
                        let key = format!("{conversation_id}:{tool_id}");
                        let (tool_tx, tool_rx) = tokio::sync::oneshot::channel();
                        state
                            .pending_internal_tool_results
                            .lock()
                            .await
                            .insert(key, tool_tx);
                        *pending_tool.lock().await = Some(tool_rx);
                        *pending_tool_id.lock().await = Some(tool_id.clone());
                        *pending_tool_name.lock().await = Some(tool_name.clone());

                        let tool_call = StreamEvent::ToolCall {
                            id: tool_id.clone(),
                            name: tool_name,
                            arguments: args,
                        };
                        record_internal_trace(
                            state,
                            conversation_id,
                            &backend_id,
                            turn_index,
                            &tool_call,
                        );
                        let _ = on_event.send(tool_call);

                        let tool_pending = StreamEvent::ToolCallUpdate {
                            id: tool_id,
                            status: ToolStatus::Pending,
                            result: None,
                        };
                        record_internal_trace(
                            state,
                            conversation_id,
                            &backend_id,
                            turn_index,
                            &tool_pending,
                        );
                        let _ = on_event.send(tool_pending);
                    } else if let Some(plain) = AcpRoundRunner::drain_held_content(buf) {
                        // 纯文本回答：冲刷缓冲内容
                        let content = StreamEvent::ContentDelta { text: plain };
                        record_internal_trace(
                            state,
                            conversation_id,
                            &backend_id,
                            turn_index,
                            &content,
                        );
                        let _ = on_event.send(content);
                    }
                }
            } else if let Some(buf) = &content_buffer {
                // Path B 已注册 pending_tool：仍冲刷非 JSON 说明文字
                flush_held_content(
                    buf,
                    &on_event,
                    state,
                    conversation_id,
                    &backend_id,
                    turn_index,
                );
            }

            if let Some(tool_rx) = pending_tool.lock().await.take() {
                match tokio::time::timeout(std::time::Duration::from_secs(300), tool_rx).await {
                    Ok(Ok((result, approved))) => {
                        let tool_name = pending_tool_name
                            .lock()
                            .await
                            .take()
                            .unwrap_or_else(|| TERMINAL_CLIENT_TOOL.to_string());
                        prompt_text =
                            format_client_tool_result_prompt(&tool_name, &result, approved);
                        if let Some(tool_id) = pending_tool_id.lock().await.take() {
                            let update = StreamEvent::ToolCallUpdate {
                                id: tool_id,
                                status: ToolStatus::Completed,
                                result: Some(result),
                            };
                            record_internal_trace(
                                state,
                                conversation_id,
                                &backend_id,
                                turn_index,
                                &update,
                            );
                            let _ = on_event.send(update);
                        }
                        turn_index += 1;
                        continue;
                    }
                    Ok(Err(_)) => {
                        let err = StreamEvent::Error {
                            message: "工具响应通道已关闭".to_string(),
                        };
                        record_internal_trace(
                            state,
                            conversation_id,
                            &backend_id,
                            turn_index,
                            &err,
                        );
                        let _ = on_event.send(err);
                        return Ok(());
                    }
                    Err(_) => {
                        let err = StreamEvent::Error {
                            message: "工具执行超时（300s）".to_string(),
                        };
                        record_internal_trace(
                            state,
                            conversation_id,
                            &backend_id,
                            turn_index,
                            &err,
                        );
                        let _ = on_event.send(err);
                        return Ok(());
                    }
                }
            }
        }

        let done = StreamEvent::Done { stop_reason: stop };
        record_internal_trace(state, conversation_id, &backend_id, turn_index, &done);
        let _ = on_event.send(done);
        return Ok(());
    }

    let err = StreamEvent::Error {
        message: "ACP 工具调用轮次超过上限".to_string(),
    };
    record_internal_trace(state, conversation_id, &backend_id, turn_index, &err);
    let _ = on_event.send(err);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub installed: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn ai_list_backends(state: State<'_, AppState>) -> Result<Vec<BackendInfo>, String> {
    let _ = state;
    // OpenCode 模型发现走 HTTP，需在 async 上下文；其余 CLI 用 blocking 池。
    let mut backends = tokio::task::spawn_blocking(list_cli_backend_infos_except_opencode)
        .await
        .map_err(|e| format!("列举 CLI 后端失败: {e}"))?;

    if let Ok(Some(opencode)) = crate::commands::providers::cli_provider_list().map(|list| {
        list.into_iter().find(|p| p.id == "opencode" && p.enabled)
    }) {
        let binary = opencode.binary.as_ref().map(std::path::PathBuf::from);
        let installed = binary
            .as_ref()
            .is_some_and(|b| b.as_os_str().len() > 0);
        match omnipanel_ai::providers::opencode::list_opencode_models(binary.as_deref()).await {
            Ok(models) => {
                for entry in models {
                    let (key, name) =
                        omnipanel_ai::providers::opencode::OpenCodeModel::parse_cache_entry(
                            &entry,
                        );
                    if opencode.disabled_model_names.iter().any(|m| {
                        m == &entry
                            || m == &key
                            || omnipanel_ai::providers::opencode::OpenCodeModel::parse_cache_entry(
                                m,
                            )
                            .0 == key
                    }) {
                        continue;
                    }
                    let (provider_id, model_id) = match key.split_once('/') {
                        Some((p, m)) => (p.to_string(), m.to_string()),
                        None => ("opencode".to_string(), key.clone()),
                    };
                    backends.push(BackendInfo {
                        id: omnipanel_ai::routing::build_opencode_backend_id(
                            &provider_id,
                            &model_id,
                        ),
                        label: name,
                        kind: "opencode".to_string(),
                        installed,
                    });
                }
            }
            Err(err) => {
                tracing::warn!("列举 OpenCode 模型失败: {err}");
                if installed {
                    backends.push(BackendInfo {
                        id: "opencode:opencode/default".to_string(),
                        label: "OpenCode/default".to_string(),
                        kind: "opencode".to_string(),
                        installed: true,
                    });
                }
            }
        }
    }

    Ok(backends)
}

fn list_cli_backend_infos_except_opencode() -> Vec<BackendInfo> {
    let Ok(providers) = crate::commands::providers::cli_provider_list() else {
        return Vec::new();
    };
    let mut backends = Vec::new();
    for provider in providers {
        if !provider.enabled {
            continue;
        }
        // OpenCode 走独立 HTTP 路径，由 ai_list_backends 异步补全
        if provider.id == "opencode" {
            continue;
        }
        let models = crate::commands::providers::provider_list_models(&provider.id)
            .unwrap_or_else(|_| vec!["default".to_string()]);
        for model in models {
            if provider.disabled_model_names.iter().any(|m| m == &model) {
                continue;
            }
            backends.push(BackendInfo {
                id: format!("cli:{}::{}", provider.id, model),
                label: format!("{}/{}", provider.display_name, model),
                kind: "cli".to_string(),
                installed: provider
                    .binary
                    .as_deref()
                    .is_some_and(|b| !b.trim().is_empty()),
            });
        }
    }
    backends
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn record_internal_trace(
    state: &AppState,
    session_id: &str,
    backend_id: &str,
    turn_index: i32,
    event: &StreamEvent,
) {
    let ts = now_ms();
    let storage = state.storage.clone();
    let session_id = session_id.to_string();
    let backend_id = backend_id.to_string();
    let event_type = match event {
        StreamEvent::ContentDelta { .. } => "content_delta",
        StreamEvent::ReasoningDelta { .. } => "reasoning_delta",
        StreamEvent::ToolCall { .. } => "tool_call",
        StreamEvent::ToolCallUpdate { .. } => "tool_call_update",
        StreamEvent::Usage { .. } => "usage",
        StreamEvent::Done { .. } => "done",
        StreamEvent::Error { .. } => "error",
        StreamEvent::PermissionRequest { .. } => "permission_request",
    }
    .to_string();
    let payload = serde_json::to_string(event).unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let storage = storage.lock().await;
        let _ = storage.ai_session_upsert(&omnipanel_store::AiSessionRecord {
            id: session_id.clone(),
            backend_id,
            source: "internal".to_string(),
            workspace_id: None,
            terminal_session_id: None,
            env_tag: None,
            title: None,
            created_at: ts,
            updated_at: ts,
        });
        let _ = storage.ai_trace_append(&session_id, turn_index, &event_type, &payload, ts);
    });
}

fn record_prompt_sent_trace(
    state: &AppState,
    session_id: &str,
    backend_id: &str,
    turn_index: i32,
    round: usize,
    prompt: &str,
) {
    let ts = now_ms();
    let storage = state.storage.clone();
    let session_id = session_id.to_string();
    let backend_id = backend_id.to_string();
    let payload = serde_json::json!({
        "round": round,
        "prompt": prompt,
    })
    .to_string();
    tauri::async_runtime::spawn(async move {
        let storage = storage.lock().await;
        let _ = storage.ai_session_upsert(&omnipanel_store::AiSessionRecord {
            id: session_id.clone(),
            backend_id,
            source: "internal".to_string(),
            workspace_id: None,
            terminal_session_id: None,
            env_tag: None,
            title: None,
            created_at: ts,
            updated_at: ts,
        });
        let _ = storage.ai_trace_append(&session_id, turn_index, "prompt_sent", &payload, ts);
    });
}

fn flush_held_content(
    content_buffer: &Arc<std::sync::Mutex<String>>,
    on_event: &Channel<StreamEvent>,
    state: &AppState,
    conversation_id: &str,
    backend_id: &str,
    turn_index: i32,
) {
    use omnipanel_ai::providers::acp::AcpRoundRunner;

    if let Some(text) = AcpRoundRunner::drain_held_content(content_buffer) {
        let event = StreamEvent::ContentDelta { text };
        record_internal_trace(state, conversation_id, backend_id, turn_index, &event);
        let _ = on_event.send(event);
    }
}

#[tauri::command]
#[specta::specta]
pub async fn ai_list_sessions(
    state: State<'_, AppState>,
    source: Option<String>,
) -> Result<Vec<omnipanel_store::AiSessionRecord>, String> {
    let storage = state.storage.lock().await;
    storage
        .ai_session_list(source.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn ai_list_session_traces(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<omnipanel_store::AiTraceRecord>, String> {
    let storage = state.storage.lock().await;
    storage
        .ai_trace_list(&session_id)
        .map_err(|e| e.to_string())
}

/// 读取最近的内置工具审计记录（任务中心 History tab 使用）。
#[tauri::command]
#[specta::specta]
pub async fn builtin_tool_audit_list(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<omnipanel_store::BuiltinToolAuditRecord>, String> {
    let storage = state.storage.lock().await;
    storage
        .builtin_tool_audit_list(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// 读取最近的全局审计日志（任务中心 History tab 使用）。
#[tauri::command]
#[specta::specta]
pub async fn audit_log_recent(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<omnipanel_store::AuditEntry>, String> {
    let storage = state.storage.lock().await;
    storage
        .recent_audit(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

/// 追加一条全局审计日志（AI 工具审批通过后写入）。
#[tauri::command]
#[specta::specta]
pub async fn audit_log_append(
    state: State<'_, AppState>,
    entry: omnipanel_store::AuditEntry,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.append_audit(&entry).map_err(|e| e.to_string())
}

/// 应用前端 Agent Router（Gateway）配置：停旧实例并按开关/端口/Key/LAN 重启。
/// 前端在启动时与设置变更时调用；开发构建会将正式版默认端口错开到 :8766。
#[tauri::command]
#[specta::specta]
pub async fn ai_gateway_configure(
    state: State<'_, AppState>,
    enabled: bool,
    port: u16,
    api_key: Option<String>,
    bind_lan: bool,
    mcp_external_require_approval: bool,
) -> Result<(), String> {
    state.mcp_external_require_approval.store(
        mcp_external_require_approval,
        std::sync::atomic::Ordering::Relaxed,
    );
    // 先停掉旧实例并等待端口释放，避免重绑同端口时 EADDRINUSE。
    let old = state.gateway_handle.lock().await.take();
    if let Some(handle) = old {
        handle.shutdown().await;
    }

    if !enabled {
        tracing::info!("Agent Router 已按设置关闭");
        return Ok(());
    }

    let host = if bind_lan { "0.0.0.0" } else { "127.0.0.1" };
    let port = omnipanel_gateway::resolve_gateway_port(port);
    let bind = format!("{host}:{port}");

    // Build the ACP resolver so the gateway can serve CLI backends
    // (Cursor / OpenCode / Qwen / OmniAgent) via /v1/chat/completions.
    let acp_resolver: Arc<dyn omnipanel_gateway::AcpResolver> =
        Arc::new(crate::agent::GatewayAcpResolver::new(
            state.app_handle.clone(),
            state.agent_registry.clone(),
            state.acp_state.clone(),
        ));

    let handle = omnipanel_gateway::spawn_gateway(
        omnipanel_gateway::GatewayConfig {
            bind_addr: bind,
            api_key: api_key.filter(|k| !k.trim().is_empty()),
        },
        state.ai_registry.clone(),
        Some(state.storage.clone()),
        Some(acp_resolver),
    );
    *state.gateway_handle.lock().await = Some(handle);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiServicesHealth {
    pub gateway: bool,
    pub mcp: bool,
}

/// 由 Rust 后端探测 Agent Router / OmniMCP 是否可达，避免 WebView 直连 localhost 触发 CORS。
#[tauri::command]
#[specta::specta]
pub async fn ai_services_probe(enabled: bool, port: u16) -> Result<AiServicesHealth, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .build()
        .map_err(|e| e.to_string())?;

    let port = omnipanel_gateway::resolve_gateway_port(port);
    let gateway = if enabled {
        let url = format!("http://127.0.0.1:{port}/gateway/healthz");
        client
            .get(url)
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false)
    } else {
        false
    };

    // GET /mcp 可能返回 4xx，但只要 TCP/HTTP 有响应即表示 OmniMCP 在监听。
    let mcp = client
        .get(omnipanel_mcp::builtin_mcp_endpoint())
        .send()
        .await
        .is_ok();

    Ok(AiServicesHealth { gateway, mcp })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_mode_dto_deserializes_camel_case_module_filter() {
        let json = r#"{"directInject":{"moduleFilter":"web","toolAllowlist":null}}"#;
        let mode: InternalToolsModeDto = serde_json::from_str(json).expect("deserialize toolsMode");
        match mode {
            InternalToolsModeDto::DirectInject {
                module_filter,
                tool_allowlist,
            } => {
                assert_eq!(module_filter.as_deref(), Some("web"));
                assert!(tool_allowlist.is_none());
            }
            other => panic!("expected DirectInject, got {other:?}"),
        }
    }

    #[test]
    fn plan_agent_forces_web_module_filter() {
        let dto = InternalChatRequestDto {
            conversation_id: "c1".into(),
            user_text: "hi".into(),
            backend_id: "http:x::y".into(),
            context: AiContextBundleDto {
                cwd: None,
                workspace_id: None,
                terminal_session_id: None,
                terminal_session_type: None,
                env_tag: None,
                resource_id: None,
                terminal_context_append: None,
                module_context_append: None,
            },
            history_json: None,
            tools_mode: InternalToolsModeDto::DirectInject {
                // 模拟反序列化失败后的 None，或前端误传
                module_filter: None,
                tool_allowlist: None,
            },
            http_provider: None,
            embedding_provider: None,
            pure_text: false,
            skill_ids: None,
            reasoning_effort: None,
            agent_id: Some("plan".into()),
            agent_system_role: None,
        };
        let internal = InternalChatRequest::try_from(dto).expect("try_from");
        match internal.tools_mode {
            InternalToolsMode::DirectInject { module_filter, .. } => {
                assert_eq!(module_filter.as_deref(), Some("web"));
            }
            other => panic!("expected DirectInject, got {other:?}"),
        }
    }
}
