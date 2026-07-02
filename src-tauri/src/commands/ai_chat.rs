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
use omnipanel_ai::types::ChatMessage;
use omnipanel_ai::RenamedProvider;
use omnipanel_mcp::ToolRegistry;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{ipc::Channel, AppHandle, State};
use tokio::sync::{oneshot, Mutex};

use crate::agent::agent_kind_label;
use crate::commands::acp::build_mcp_servers;
use crate::commands::agents::{agent_kind_key, detect_all_agents_sync};
use crate::state::AppState;

struct RegistryToolExecutor {
    mcp_manager: omnipanel_mcp::SharedMcpManager,
    conversation_id: String,
    pending_internal: Arc<Mutex<HashMap<String, oneshot::Sender<(String, bool)>>>>,
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
            // 克隆 storage 句柄后立即释放 McpManager 锁。
            let storage = {
                let manager = self.mcp_manager.lock().await;
                manager.tool_registry.storage_handle()
            };
            return match ToolRegistry::execute_isolated(storage, name, args).await {
                Ok(pair) => pair,
                Err(err) => (format!("Error: {err}"), false),
            };
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
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiContextBundleDto {
    pub cwd: Option<String>,
    pub workspace_id: Option<String>,
    pub terminal_session_id: Option<String>,
    pub env_tag: Option<String>,
    pub resource_id: Option<String>,
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
                env_tag: dto.context.env_tag,
                resource_id: dto.context.resource_id,
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
        })
    }
}

async fn build_http_provider(
    state: &AppState,
    snapshot: &HttpProviderSnapshot,
) -> Result<Box<dyn AiProvider>, String> {
    let proxy_config = state.proxy_config.lock().await.clone();
    let client = crate::commands::proxy::build_proxy_client(&proxy_config);
    let provider_id = snapshot.provider_id.trim();
    if provider_id.is_empty() {
        return Err("http_provider.provider_id 不能为空".to_string());
    }

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
    let internal = InternalChatRequest::try_from(request)?;
    let conversation_id = internal.conversation_id.clone();

    let parsed = omnipanel_ai::routing::parse_backend_id(&internal.backend_id)?;

    if parsed.kind == BackendKind::Acp {
        return run_acp_internal_turn(
            &app,
            &state,
            &internal,
            &conversation_id,
            &parsed.provider_id,
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
                .tool_registry
                .to_tool_defs(filter)
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
            record_internal_trace(&state, &conversation_id, &internal.backend_id, &evt);
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

async fn run_acp_internal_turn(
    app: &AppHandle,
    state: &AppState,
    internal: &InternalChatRequest,
    conversation_id: &str,
    agent_kind: &str,
    on_event: Channel<StreamEvent>,
) -> Result<(), String> {
    let cwd = internal
        .context
        .cwd
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(crate::commands::acp::default_cwd);

    let manager = state
        .agent_registry
        .get_or_connect(app, state, agent_kind)
        .await?;

    let mcp_servers = build_mcp_servers(state).await;
    let session_id = manager
        .ensure_session(conversation_id, &cwd, mcp_servers)
        .await
        .map_err(|e| e.to_string())?;

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let user_text = internal.user_text.clone();
    let prompt_handle = tokio::spawn(async move {
        manager
            .prompt(&session_id, &user_text, tx)
            .await
            .map_err(|e| e.to_string())
    });

    while let Some(event) = rx.recv().await {
        let is_terminal = matches!(&event, StreamEvent::Done { .. } | StreamEvent::Error { .. });
        let _ = on_event.send(event);
        if is_terminal {
            break;
        }
    }

    prompt_handle
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e)?;
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

    for agent in detect_all_agents_sync() {
        let kind = agent_kind_key(agent.kind);
        backends.push(BackendInfo {
            id: format!("acp:{kind}"),
            label: agent_kind_label(kind),
            kind: "acp".to_string(),
            installed: agent.installed,
        });
    }

    Ok(backends)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn record_internal_trace(state: &AppState, session_id: &str, backend_id: &str, event: &StreamEvent) {
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
        let _ = storage.ai_trace_append(&session_id, 0, &event_type, &payload, ts);
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
) -> Result<(), String> {
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
    let handle = omnipanel_gateway::spawn_gateway(
        omnipanel_gateway::GatewayConfig {
            bind_addr: bind,
            api_key: api_key.filter(|k| !k.trim().is_empty()),
        },
        state.ai_registry.clone(),
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
