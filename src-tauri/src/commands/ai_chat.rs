use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use omnipanel_ai::RenamedProvider;
use omnipanel_ai::ir::StreamEvent;
use omnipanel_ai::orchestrator::{
    AiContextBundle, HttpProviderSnapshot, InternalChatRequest, InternalOrchestrator,
    InternalToolsMode, ToolExecutor,
};
use omnipanel_ai::provider::AiProvider;
use omnipanel_ai::providers::anthropic::AnthropicProvider;
use omnipanel_ai::providers::openai::OpenAiProvider;
use omnipanel_ai::types::{ChatMessage, ToolDef};
use omnipanel_mcp::{ToolRegistry, external};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{State, ipc::Channel};
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

struct RegistryToolExecutor {
    mcp_manager: omnipanel_mcp::SharedMcpManager,
    conversation_id: String,
    pending_internal: Arc<Mutex<HashMap<String, oneshot::Sender<(String, bool)>>>>,
    mcp_external_require_approval: Arc<std::sync::atomic::AtomicBool>,
    proxy_config: Arc<Mutex<crate::state::ProxyConfig>>,
    /// 与本次请求 `tools_mode.module_filter` 一致；执行期二次校验，防止模型幻觉越权调用。
    module_filter: Option<String>,
}

#[async_trait::async_trait]
impl ToolExecutor for RegistryToolExecutor {
    async fn execute(&self, tool_call_id: &str, name: &str, arguments: &str) -> (String, bool) {
        if let Err(err) = ensure_tool_allowed_by_module_filter(name, self.module_filter.as_deref())
        {
            return (format!("Error: {err}"), false);
        }

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
                    has_password: !p.password.is_empty(),
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
    model_id: &str,
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

    let api_key = crate::commands::ai_models::resolve_ai_provider_api_key(
        &snapshot.provider_id,
        &snapshot.api_key,
    );
    let api_key = if api_key.trim().is_empty() {
        "sk-none".to_string()
    } else {
        api_key
    };

    match omnipanel_ai::routing::resolve_http_inference_api(&snapshot.api_standard, model_id) {
        omnipanel_ai::routing::HttpInferenceApi::AnthropicMessages => {
            let anthropic_base =
                omnipanel_ai::routing::resolve_anthropic_messages_base_url(base_url);
            let inner = AnthropicProvider::with_client(
                &api_key,
                Some(&anthropic_base),
                Vec::new(),
                Some(client),
            );
            Ok(Box::new(RenamedProvider::new(provider_id, inner)))
        }
        omnipanel_ai::routing::HttpInferenceApi::OpenAiChatCompletions => Ok(Box::new(
            OpenAiProvider::with_client(provider_id, &api_key, base_url, Vec::new(), Some(client)),
        )),
    }
}

async fn ensure_http_provider_registered(
    state: &AppState,
    snapshot: &HttpProviderSnapshot,
    model_id: &str,
) -> Result<(), String> {
    let provider_id = snapshot.provider_id.trim();
    {
        let registry = state.ai_registry.lock().await;
        if registry.get(provider_id).is_some() {
            return Ok(());
        }
    }
    let provider = build_http_provider(state, snapshot, model_id).await?;
    state.ai_registry.lock().await.register(provider);
    Ok(())
}

#[tauri::command]
pub async fn ai_chat_stream(
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

    let (_provider_id, model_id) = InternalOrchestrator::resolve_http_model(&internal.backend_id)?;
    let provider = if let Some(provider) =
        crate::commands::agent_source::open_agent_provider(&state, &parsed.provider_id, &model_id)
            .await?
    {
        provider
    } else {
        let snapshot = internal
            .http_provider
            .as_ref()
            .ok_or_else(|| "缺少 http_provider，无法发起 HTTP 推理".to_string())?;
        ensure_http_provider_registered(&state, snapshot, &model_id).await?;
        build_http_provider(&state, snapshot, &model_id).await?
    };

    let (tools, _) = match &internal.tools_mode {
        InternalToolsMode::DirectInject {
            module_filter,
            tool_allowlist,
        } => {
            let manager = state.mcp_manager.lock().await;
            let filter = module_filter.as_deref();
            let tool_defs = manager
                .to_internal_tool_defs(filter)
                .await
                .map_err(|e| e.to_string())?;
            let tool_defs = prioritize_cross_module_tools(apply_tool_allowlist(
                tool_defs,
                tool_allowlist.as_deref(),
            ));
            log_injected_tools(&conversation_id, filter, &tool_defs);
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
        module_filter: match &internal.tools_mode {
            InternalToolsMode::DirectInject { module_filter, .. } => module_filter.clone(),
            InternalToolsMode::None => None,
        },
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

    let handle = omnipanel_gateway::spawn_gateway(
        omnipanel_gateway::GatewayConfig {
            bind_addr: bind,
            api_key: api_key.filter(|k| !k.trim().is_empty()),
        },
        state.ai_registry.clone(),
        Some(state.storage.clone()),
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
