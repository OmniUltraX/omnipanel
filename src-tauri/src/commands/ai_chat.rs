use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use omnipanel_ai::ir::StreamEvent;
use omnipanel_ai::orchestrator::{
    AiContextBundle, HttpProviderSnapshot, InternalChatRequest, InternalOrchestrator,
    InternalToolsMode, ToolExecutor,
};
use omnipanel_ai::provider::AiProvider;
use omnipanel_ai::providers::anthropic::AnthropicProvider;
use omnipanel_ai::providers::openai::OpenAiProvider;
use omnipanel_ai::routing::BackendKind;
use omnipanel_ai::types::{ChatMessage, ToolDef};
use omnipanel_ai::RenamedProvider;
use omnipanel_mcp::{external, ToolRegistry};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{ipc::Channel, AppHandle, State};
use tokio::sync::{oneshot, Mutex};

use crate::state::AppState;
use crate::commands::knowledge_vector::{EmbeddingProviderConfig, fetch_provider_embeddings};

struct RegistryToolExecutor {
    mcp_manager: omnipanel_mcp::SharedMcpManager,
    conversation_id: String,
    pending_internal: Arc<Mutex<HashMap<String, oneshot::Sender<(String, bool)>>>>,
    mcp_external_require_approval: Arc<std::sync::atomic::AtomicBool>,
    proxy_config: Arc<Mutex<crate::state::ProxyConfig>>,
}

#[async_trait::async_trait]
impl ToolExecutor for RegistryToolExecutor {
    async fn execute(&self, tool_call_id: &str, name: &str, arguments: &str) -> (String, bool) {
        // 统一通道：
        // - Native 工具（知识库等）后端直接执行；
        // - 其余全部 UiDelegated（终端 / 数据库等）挂起等待前端 dispatchTool 回传
        //   （前端根据工具名分派：终端→内联审批 dock，其它→对应 handler）。
        if ToolRegistry::is_native_tool(name) {
            let args: serde_json::Value =
                serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
            // load_skill 与其他 Native 工具一样走标准 ToolRegistry::execute_isolated 路径，
            // 不再硬编码短路：统一由 omnipanel_store::load_skill_body 实现（含 enabled 检查）。
            // 克隆 storage 句柄后立即释放 McpManager 锁。
            let storage = {
                let manager = self.mcp_manager.lock().await;
                manager.tool_registry.storage_handle()
            };
            let proxy = {
                let p = self.proxy_config.lock().await;
                omnipanel_store::HttpProxyConfig {
                    enabled: p.enabled,
                    protocol: p.protocol.clone(),
                    host: p.host.clone(),
                    port: p.port,
                    username: p.username.clone(),
                    password: p.password.clone(),
                }
            };
            return match ToolRegistry::execute_isolated(storage, name, args, Some(proxy)).await {
                Ok(pair) => pair,
                Err(err) => (format!("Error: {err}"), false),
            };
        }

        if let Some((service_id, tool_name)) = external::parse_registry_tool_name(name) {
            if !self
                .mcp_external_require_approval
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                let args: serde_json::Value =
                    serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));
                let start = std::time::Instant::now();
                let manager = self.mcp_manager.lock().await;
                let storage = manager.tool_registry.storage_handle();
                let audit_name = format!("{service_id}::{tool_name}");
                let outcome = manager
                    .call_service_tool(&service_id, &tool_name, args)
                    .await;
                drop(manager);
                let elapsed = start.elapsed().as_millis() as i64;
                let ts = now_ms();
                let (content, success) = match &outcome {
                    Ok(result) => (result.content.clone(), !result.is_error),
                    Err(err) => (format!("Error: {err}"), false),
                };
                let _ = storage.lock().await.builtin_tool_audit_append(
                    "mcp_external",
                    &audit_name,
                    elapsed,
                    success,
                    "",
                    ts,
                );
                return (content, success);
            }
            // 需审批时走 UiDelegated pending 通道（与终端/数据库工具一致）
        }

        let key = format!("{}:{}", self.conversation_id, tool_call_id);
        let (tx, rx) = oneshot::channel();
        self.pending_internal.lock().await.insert(key.clone(), tx);
        match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => ("工具响应通道已关闭".to_string(), false),
            Err(_) => {
                self.pending_internal.lock().await.remove(&key);
                ("工具执行超时（300s）".to_string(), false)
            }
        }
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
    DirectInject {
        module_filter: Option<String>,
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
                InternalToolsModeDto::DirectInject { module_filter } => {
                    InternalToolsMode::DirectInject { module_filter }
                }
            },
            http_provider: dto.http_provider.map(|p| HttpProviderSnapshot {
                provider_id: p.provider_id,
                api_standard: p.api_standard,
                base_url: p.base_url,
                api_key: p.api_key,
            }),
            system_append: None,
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

async fn build_http_provider(
    state: &AppState,
    snapshot: &HttpProviderSnapshot,
) -> Result<Box<dyn AiProvider>, String> {
    let proxy_config = state.proxy_config.lock().await.clone();
    let provider_id = snapshot.provider_id.trim();
    if provider_id.is_empty() {
        return Err("http_provider.provider_id 不能为空".to_string());
    }

    let base_url = snapshot.base_url.trim();
    if base_url.is_empty() {
        return Err("http_provider.base_url 不能为空".to_string());
    }

    let client = crate::commands::proxy::build_http_client_for_url(
        base_url,
        &proxy_config,
        Duration::from_secs(300),
    )?;

    let api_key = if snapshot.api_key.trim().is_empty() {
        "sk-none".to_string()
    } else {
        snapshot.api_key.clone()
    };

    let standard = snapshot.api_standard.to_lowercase();
    if standard == "anthropic" {
        let inner = AnthropicProvider::with_client(
            &api_key,
            Some(snapshot.base_url.as_str()),
            Vec::new(),
            Some(client),
        );
        Ok(Box::new(RenamedProvider::new(provider_id, inner)))
    } else {
        Ok(Box::new(OpenAiProvider::with_client(
            provider_id,
            &api_key,
            &snapshot.base_url,
            Vec::new(),
            Some(client),
        )))
    }
}

async fn ensure_http_provider_registered(
    state: &AppState,
    snapshot: &HttpProviderSnapshot,
) -> Result<(), String> {
    let provider_id = snapshot.provider_id.trim();
    {
        let registry = state.ai_registry.lock().await;
        if registry.get(provider_id).is_some() {
            return Ok(());
        }
    }
    let provider = build_http_provider(state, snapshot).await?;
    state.ai_registry.lock().await.register(provider);
    Ok(())
}

#[tauri::command]
pub async fn ai_chat_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request: InternalChatRequestDto,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    // 在 move 进 TryFrom 前提取 embedding provider，供 RAG 注入使用。
    let mut request = request;
    let embedding_provider = request.embedding_provider.take();
    let user_text_for_rag = request.user_text.clone();
    let mut internal = InternalChatRequest::try_from(request)?;
    if matches!(
        internal.tools_mode,
        InternalToolsMode::DirectInject { .. }
    ) {
        let mut append_parts: Vec<String> = Vec::new();

        // 1. Skills 摘要（渐进式披露）
        if let Ok(skills_text) = omnipanel_store::build_skills_system_append() {
            if !skills_text.is_empty() {
                append_parts.push(skills_text);
            }
        }

        // 2. 知识库 RAG 自动注入：top-3 语义检索
        if let Some(provider) = embedding_provider.as_ref() {
            if let Ok(rag_text) = build_knowledge_rag_append(
                &state,
                provider,
                &user_text_for_rag,
                3,
                0.35,
            )
            .await
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

    if parsed.kind == BackendKind::Acp || parsed.kind == BackendKind::Cli {
        let agent_kind = if parsed.kind == BackendKind::Cli {
            omnipanel_ai::routing::normalize_cli_backend(&parsed)?.0
        } else {
            parsed.provider_id.clone()
        };
        return run_acp_internal_turn(
            &app,
            &state,
            &internal,
            &conversation_id,
            &agent_kind,
            if parsed.kind == BackendKind::Cli {
                Some(parsed.model_id.clone())
            } else {
                None
            },
            on_event,
        )
        .await;
    }

    if parsed.kind != BackendKind::Http {
        return Err(format!("不支持的 backend: {}", internal.backend_id));
    }

    let snapshot = internal
        .http_provider
        .as_ref()
        .ok_or_else(|| "缺少 http_provider，无法发起 HTTP 推理".to_string())?;
    ensure_http_provider_registered(&state, snapshot).await?;

    let (_provider_id, model_id) = InternalOrchestrator::resolve_http_model(&internal.backend_id)?;
    let provider = build_http_provider(&state, snapshot).await?;

    let (tools, _) = match &internal.tools_mode {
        InternalToolsMode::DirectInject { module_filter } => {
            let manager = state.mcp_manager.lock().await;
            let filter = module_filter.as_deref().or(Some("master"));
            let tool_defs = manager
                .to_internal_tool_defs(filter)
                .await
                .map_err(|e| e.to_string())?;
            (Some(tool_defs), ())
        }
        InternalToolsMode::None => (None, ()),
    };

    let cancel_flag = {
        let mut flags = state.internal_chat_cancel_flags.lock().await;
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(conversation_id.clone(), flag.clone());
        flag
    };

    let tool_executor = RegistryToolExecutor {
        mcp_manager: state.mcp_manager.clone(),
        conversation_id: conversation_id.clone(),
        pending_internal: state.pending_internal_tool_results.clone(),
        mcp_external_require_approval: state.mcp_external_require_approval.clone(),
        proxy_config: state.proxy_config.clone(),
    };
    let exec_ref: Option<&dyn ToolExecutor> = match &internal.tools_mode {
        InternalToolsMode::DirectInject { .. } => Some(&tool_executor),
        InternalToolsMode::None => None,
    };

    let result = InternalOrchestrator::run_turn(
        provider.as_ref(),
        &model_id,
        &internal,
        tools,
        exec_ref,
        |evt| {
            record_internal_trace(&state, &conversation_id, &internal.backend_id, 0, &evt);
            let _ = on_event.send(evt);
        },
        cancel_flag.clone(),
    )
    .await;

    state
        .internal_chat_cancel_flags
        .lock()
        .await
        .remove(&conversation_id);

    result
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
    let sender = state.pending_internal_tool_results.lock().await.remove(&key);
    match sender {
        Some(tx) => {
            let _ = tx.send((result, approved));
            Ok(())
        }
        None => Err(format!("未找到待处理的工具调用: {key}")),
    }
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
    use omnipanel_ai::providers::acp::{
        AcpRoundRunner, build_client_tools_prompt, build_incremental_client_tools_prompt,
        format_client_tool_result_prompt, parse_client_tool_calls, pick_terminal_tool_call,
        prompt_expects_tool_retry, prompt_has_tool_results,
    };
    use omnipanel_ai::providers::acp::native_tools::TERMINAL_CLIENT_TOOL;
    use omnipanel_ai::ToolStatus;

    let backend_id = internal.backend_id.clone();

    let cwd = resolve_acp_session_cwd(&internal.context);

    let manager = state
        .agent_registry
        .get_or_connect(app, state, agent_kind)
        .await?;

    let mcp_servers: Vec<serde_json::Value> = Vec::new();
    let session_id = manager
        .ensure_session(
            conversation_id,
            &cwd,
            mcp_servers,
            model_id.as_deref(),
        )
        .await
        .map_err(|e| e.to_string())?;

    let runner = AcpRoundRunner::new(manager.clone(), session_id.clone());

    let terminal_context = internal
        .context
        .terminal_context_append
        .as_deref()
        .filter(|s| !s.trim().is_empty());

    // 对齐 cursor-gateway：有客户端 tools 才进入 client_tools 模式。
    // CLI/ACP 路径即使用户端未传 DirectInject，也默认拉 master 工具清单，避免 Cursor 裸跑原生工具。
    let client_tool_defs: Vec<ToolDef> = {
        let mcp = state.mcp_manager.lock().await;
        let filter = match &internal.tools_mode {
            InternalToolsMode::DirectInject { module_filter } => {
                module_filter.as_deref().or(Some("master"))
            }
            InternalToolsMode::None => Some("master"),
        };
        mcp.to_internal_tool_defs(filter)
            .await
            .map_err(|e| e.to_string())?
    };
    let client_tools = !client_tool_defs.is_empty();

    let is_first_user_prompt = if client_tools {
        manager.mark_first_prompt_sent(conversation_id).await
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
        internal.user_text.clone()
    };

    const MAX_ACP_TOOL_ROUNDS: usize = 8;
    let mut turn_index: i32 = 0;

    for round in 0..MAX_ACP_TOOL_ROUNDS {
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
        let content_buffer = AcpRoundRunner::maybe_content_buffer(
            AcpRoundRunner::should_hold_content(
                client_tools,
                is_tool_continuation,
                expects_tool_retry,
            ),
        );

        let pending_tool: Arc<Mutex<Option<tokio::sync::oneshot::Receiver<(String, bool)>>>> =
            Arc::new(Mutex::new(None));
        let pending_tool_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let pending_tool_name: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        // Native 工具（WebSearch/WebFetch）后端直执结果：(tool_name, result, approved)
        let mut native_tool_result: Option<(String, String, bool)> = None;

        let (mut rx, prompt_handle) = runner.start_round(
            &prompt_text,
            client_tools,
            content_buffer.clone(),
            // 对齐 gateway：抑制 Cursor 原生工具，强制走注入的 omni_* tool_calls JSON
            client_tools,
        );

        while let Some(event) = rx.recv().await {
            if client_tools {
                if let StreamEvent::ToolCall { id, name, arguments } = &event {
                    if ToolRegistry::is_native_tool(name)
                        && name != TERMINAL_CLIENT_TOOL
                    {
                        let (result, success) =
                            execute_acp_web_tool(state, name, arguments).await;
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
                record_internal_trace(
                    state,
                    conversation_id,
                    &backend_id,
                    turn_index,
                    &event,
                );
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

        let done = StreamEvent::Done {
            stop_reason: stop,
        };
        record_internal_trace(state, conversation_id, &backend_id, turn_index, &done);
        let _ = on_event.send(done);
        return Ok(());
    }

    let err = StreamEvent::Error {
        message: "ACP 工具调用轮次超过上限".to_string(),
    };
    record_internal_trace(
        state,
        conversation_id,
        &backend_id,
        turn_index,
        &err,
    );
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
    let mut backends = Vec::new();

    let registry = state.ai_registry.lock().await;
    for provider_name in registry.list() {
        if let Some(provider) = registry.get(provider_name) {
            for model in provider.models() {
                backends.push(BackendInfo {
                    id: format!("http:{provider_name}::{}", model.id),
                    label: format!("{} / {}", provider_name, model.name),
                    kind: "http".to_string(),
                    installed: true,
                });
            }
        }
    }
    drop(registry);

    for provider in crate::commands::providers::cli_provider_list()? {
        if !provider.enabled {
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
                installed: provider.binary.as_deref().is_some_and(|b| !b.trim().is_empty()),
            });
        }
    }

    Ok(backends)
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
    storage
        .append_audit(&entry)
        .map_err(|e| e.to_string())
}

/// 应用前端 Agent Router（Gateway）配置：停旧实例并按开关/端口/Key/LAN 重启。
/// 前端在启动时与设置变更时调用，使 :8765 相关设置真正生效。
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
    state
        .mcp_external_require_approval
        .store(mcp_external_require_approval, std::sync::atomic::Ordering::Relaxed);
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
    let port = if port == 0 { 8765 } else { port };
    let bind = format!("{host}:{port}");

    // Build the ACP resolver so the gateway can serve CLI backends
    // (Cursor / OpenCode / Qwen / OmniAgent) via /v1/chat/completions.
    let acp_resolver: Arc<dyn omnipanel_gateway::AcpResolver> = Arc::new(
        crate::agent::GatewayAcpResolver::new(
            state.app_handle.clone(),
            state.agent_registry.clone(),
            state.acp_state.clone(),
        ),
    );

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

    let port = if port == 0 { 8765 } else { port };
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
        .get("http://127.0.0.1:12756/mcp")
        .send()
        .await
        .is_ok();

    Ok(AiServicesHealth { gateway, mcp })
}
