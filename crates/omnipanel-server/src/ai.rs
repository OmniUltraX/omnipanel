//! P2 AI 对话流（Web 端）：`ai_chat_stream` / `ai_http_stream_post` 等价实现。
//!
//! 复用 `omnipanel-ai::InternalOrchestrator`（与桌面端同一套推理编排），
//! 事件经 Channel 帧（`@channel`）回传前端，等价桌面端 `Channel<StreamEvent>`。
//!
//! ## 传输语义（与桌面端对齐）
//! - `ai_chat_stream` 请求体：`{ request: <InternalChatRequestDto>, onEvent: <channelId> }`
//!   （Channel 序列化为自增 id 字符串，与 `frontend/src/shims/tauri/core-web.ts` 一致）。
//! - `ai_http_stream_post` 请求体：`{ url, headers, body, timeoutMs, onEvent: <channelId> }`。
//!
//! ## 范围说明（诚实边界）
//! - 支持 HTTP 后端（OpenAI / Anthropic 兼容）流式对话；`pure_text` oneshot 直通。
//! - ACP / CLI 后端（依赖本地 Agent 进程）在 Web 端返回明确错误。
//! - MCP 工具执行依赖桌面端 `ToolExecutor`，Web 端暂不注入工具（`tools_mode` 被忽略，
//!   以 `pure_text` 语义直接推理），工具面能力在后续版本接入。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use omnipanel_ai::{
    AiContextBundle, HttpProviderSnapshot, InternalChatRequest, InternalOrchestrator,
    InternalToolsMode, RenamedProvider, StreamEvent, ToolExecutor,
};
use serde::Deserialize;

use crate::ai_tools::{ServerToolExecutor, filter_web_tools};
use crate::state::ServerState;

/// `ai_chat_stream` 外层请求体（对齐桌面端 Tauri 参数：`request` + `onEvent`）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatStreamArgs {
    pub request: InternalChatRequestDto,
    #[serde(default, rename = "onEvent")]
    pub channel_id: Option<String>,
}

/// `InternalChatRequestDto`（与桌面端同形，camelCase）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InternalChatRequestDto {
    pub conversation_id: String,
    pub user_text: String,
    pub backend_id: String,
    #[serde(default)]
    pub context: AiContextBundleDto,
    #[serde(default)]
    pub history_json: Option<String>,
    #[serde(default)]
    pub tools_mode: Option<InternalToolsModeDto>,
    #[serde(default)]
    pub http_provider: Option<HttpProviderSnapshotDto>,
    #[serde(default)]
    pub embedding_provider: Option<serde_json::Value>,
    #[serde(default)]
    pub pure_text: bool,
    #[serde(default)]
    pub skill_ids: Option<Vec<String>>,
    #[serde(default)]
    pub reasoning_effort: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub agent_system_role: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiContextBundleDto {
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub terminal_session_id: Option<String>,
    #[serde(default)]
    pub terminal_session_type: Option<String>,
    #[serde(default)]
    pub env_tag: Option<String>,
    #[serde(default)]
    pub resource_id: Option<String>,
    #[serde(default)]
    pub terminal_context_append: Option<String>,
    #[serde(default)]
    pub module_context_append: Option<String>,
}

impl Default for AiContextBundleDto {
    fn default() -> Self {
        Self {
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
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpProviderSnapshotDto {
    pub provider_id: String,
    pub api_standard: String,
    pub base_url: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InternalToolsModeDto {
    None,
    DirectInject {
        #[serde(default)]
        module_filter: Option<String>,
        #[serde(default)]
        tool_allowlist: Option<Vec<String>>,
    },
}

/// 把 DTO 转换为 `InternalChatRequest`（与桌面端 `TryFrom` 等价）。
fn to_internal(req: InternalChatRequestDto) -> Result<InternalChatRequest, String> {
    let history = match req.history_json {
        Some(json) if !json.trim().is_empty() => Some(
            serde_json::from_str::<Vec<omnipanel_ai::types::ChatMessage>>(&json)
                .map_err(|e| format!("history_json 解析失败: {e}"))?,
        ),
        _ => None,
    };

    let tools_mode = match req.tools_mode.unwrap_or(InternalToolsModeDto::None) {
        InternalToolsModeDto::None => InternalToolsMode::None,
        InternalToolsModeDto::DirectInject {
            module_filter,
            tool_allowlist,
        } => {
            let module_filter = if req.agent_id.as_deref() == Some("plan") {
                Some("web".to_string())
            } else {
                module_filter
            };
            InternalToolsMode::DirectInject {
                module_filter,
                tool_allowlist,
            }
        }
    };

    Ok(InternalChatRequest {
        conversation_id: req.conversation_id,
        user_text: req.user_text,
        backend_id: req.backend_id,
        context: AiContextBundle {
            cwd: req.context.cwd,
            workspace_id: req.context.workspace_id,
            terminal_session_id: req.context.terminal_session_id,
            terminal_session_type: req.context.terminal_session_type,
            env_tag: req.context.env_tag,
            resource_id: req.context.resource_id,
            terminal_context_append: req.context.terminal_context_append,
            module_context_append: req.context.module_context_append,
        },
        history,
        tools_mode,
        http_provider: req.http_provider.map(|p| HttpProviderSnapshot {
            provider_id: p.provider_id,
            api_standard: p.api_standard,
            base_url: p.base_url,
            api_key: p.api_key,
        }),
        system_append: None,
        pure_text: req.pure_text,
        reasoning_effort: req.reasoning_effort,
        agent_id: req.agent_id,
    })
}

/// 构造 HTTP Provider（复用 `omnipanel-ai` 的 OpenAI / Anthropic 实现）。
fn build_http_provider(
    snapshot: &HttpProviderSnapshot,
) -> Result<Box<dyn omnipanel_ai::AiProvider>, String> {
    let provider_id = snapshot.provider_id.trim();
    if provider_id.is_empty() {
        return Err("http_provider.provider_id 不能为空".to_string());
    }
    let base_url = snapshot.base_url.trim();
    if base_url.is_empty() {
        return Err("http_provider.base_url 不能为空".to_string());
    }
    let api_key = if snapshot.api_key.trim().is_empty() {
        omnipanel_store::Vault::get(&omnipanel_store::ai_provider_key_ref(provider_id))
            .unwrap_or_default()
    } else {
        snapshot.api_key.clone()
    };
    let api_key = if api_key.trim().is_empty() {
        "sk-none".to_string()
    } else {
        api_key
    };

    let standard = snapshot.api_standard.to_lowercase();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    if standard == "anthropic" {
        let inner = omnipanel_ai::providers::anthropic::AnthropicProvider::with_client(
            &api_key,
            Some(base_url),
            Vec::new(),
            Some(client),
        );
        Ok(Box::new(RenamedProvider::new(provider_id, inner)))
    } else {
        Ok(Box::new(
            omnipanel_ai::providers::openai::OpenAiProvider::with_client(
                provider_id,
                &api_key,
                base_url,
                Vec::new(),
                Some(client),
            ),
        ))
    }
}

/// `ai_chat_stream`：流式对话，事件经 Channel 帧回传。
pub async fn ai_chat_stream(
    state: &ServerState,
    args: AiChatStreamArgs,
) -> Result<(), String> {
    let channel_id = args
        .channel_id
        .clone()
        .ok_or_else(|| "缺少 onEvent（Channel 未序列化）".to_string())?;

    let mut internal = to_internal(args.request)?;
    let conversation_id = internal.conversation_id.clone();

    // 解析 backend：仅支持 HTTP（ACP/CLI 依赖本地进程，Web 端不支持）。
    let parsed = omnipanel_ai::routing::parse_backend_id(&internal.backend_id)?;
    if parsed.kind != omnipanel_ai::routing::BackendKind::Http {
        return Err(format!(
            "Web 端暂不支持 backend: {}（ACP/CLI 后端依赖本地 Agent 进程）",
            internal.backend_id
        ));
    }

    let snapshot = internal
        .http_provider
        .as_ref()
        .ok_or_else(|| "缺少 http_provider，无法发起 HTTP 推理".to_string())?;
    let (_provider_id, model_id) = InternalOrchestrator::resolve_http_model(&internal.backend_id)?;
    let provider = build_http_provider(snapshot)?;

    // 非 pure_text 时的 Skills / Agent 角色注入
    if !internal.pure_text {
        let mut append_parts: Vec<String> = Vec::new();
        if let Some(role) = internal
            .agent_id
            .as_deref()
            .map(omnipanel_store::agent_prompt)
            .filter(|s| !s.trim().is_empty())
        {
            append_parts.push(format!("[Agent]\n{role}"));
        }
        if let Ok(skills_text) = omnipanel_store::build_skills_system_append() {
            if !skills_text.is_empty() {
                append_parts.push(skills_text);
            }
        }
        if !append_parts.is_empty() {
            internal.system_append = Some(append_parts.join("\n\n---\n\n"));
        }
    }

    // 取消标志（`ai_chat_cancel` 置位）
    let cancel_flag = {
        let mut flags = state.ai_chat_cancel_flags.lock().await;
        let flag = Arc::new(AtomicBool::new(false));
        flags.insert(conversation_id.clone(), flag.clone());
        flag
    };

    // P3：Web 端工具面下沉。DirectInject 时从存储的 ToolRegistry 拉取工具定义，
    // 过滤纯 UI 依赖工具后注入；执行器为服务端自执 `ServerToolExecutor`。
    let (tools, executor) = match &internal.tools_mode {
        InternalToolsMode::DirectInject {
            module_filter,
            tool_allowlist,
        } => {
            let filter = module_filter.as_deref();
            let mut defs = omnipanel_mcp::ToolRegistry::new(state.storage.clone())
                .to_tool_defs(filter)
                .await
                .map_err(|e| e.to_string())?;
            // P4：并入启用中的外部 MCP 工具（与桌面端 `McpManager::to_internal_tool_defs` 一致）。
            // 模块隔离下（非 master/web）不混入外部 MCP。
            if matches!(filter, None | Some("master") | Some("web")) {
                let external = crate::mcp::merge_external_tool_defs(state, filter).await?;
                defs.extend(external);
            }
            // 若工具清单含纯 UI 工具则过滤（Web 端无浏览器回传）
            if let Some(tool_allowlist) = tool_allowlist {
                if !tool_allowlist.is_empty() {
                    let allowed: std::collections::HashSet<&str> =
                        tool_allowlist.iter().map(String::as_str).collect();
                    defs.retain(|d| allowed.contains(d.function.name.as_str()));
                }
            }
            let (tools, dropped) = filter_web_tools(defs);
            if !dropped.is_empty() {
                tracing::info!(
                    conversation_id = %conversation_id,
                    dropped = ?dropped,
                    "Web 端过滤纯 UI 工具"
                );
            }
            let executor = ServerToolExecutor::new(state, module_filter.clone());
            (Some(tools), Some(executor))
        }
        InternalToolsMode::None => (None, None),
    };
    let exec_ref: Option<&dyn ToolExecutor> = executor.as_ref().map(|e| e as &dyn ToolExecutor);

    let bus = state.bus.clone();
    let result = InternalOrchestrator::run_turn(
        provider.as_ref(),
        &model_id,
        &internal,
        tools,
        exec_ref,
        move |evt: StreamEvent| {
            let payload = match serde_json::to_value(&evt) {
                Ok(v) => v,
                Err(_) => return,
            };
            bus.emit_channel(&channel_id, payload);
        },
        cancel_flag.clone(),
    )
    .await;

    state
        .ai_chat_cancel_flags
        .lock()
        .await
        .remove(&conversation_id);

    result
}

/// `ai_chat_cancel`：置位取消标志。
pub async fn ai_chat_cancel(
    state: &ServerState,
    conversation_id: String,
) -> Result<(), String> {
    let flags = state.ai_chat_cancel_flags.lock().await;
    if let Some(flag) = flags.get(&conversation_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// `ai_chat_tool_result`：回传工具执行结果（等价桌面端 Tauri 命令）。
///
/// Web 端 P3 之前 `ServerToolExecutor` 全部自执、不挂起；本命令保留桌面语义，
/// 供后续把 `omni_ask_user` / `omni_plan_*` 等 UI 依赖工具接入审批/表单时使用，
/// 同时兼容前端 `reportToolResultWithRetry` 在 Web 模式下对未知命令的回退。
pub async fn ai_chat_tool_result(
    state: &ServerState,
    conversation_id: String,
    tool_call_id: String,
    result: String,
    approved: bool,
) -> Result<(), String> {
    let _ = (&state, &conversation_id, &tool_call_id, &result, &approved);
    // Web 端自执模式没有挂起的 UiDelegated 工具，直接返回成功（无操作）。
    Ok(())
}

/// `ai_http_stream_post`：Web 端流式 HTTP 代理（等价桌面端，绕过浏览器 CORS）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiHttpStreamRequest {
    pub url: String,
    #[serde(default)]
    pub headers: std::collections::HashMap<String, String>,
    pub body: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
    #[serde(default, rename = "onEvent")]
    pub channel_id: Option<String>,
}

pub async fn ai_http_stream_post(
    state: &ServerState,
    req: AiHttpStreamRequest,
) -> Result<(), String> {
    use futures_util::StreamExt;

    let channel_id = req
        .channel_id
        .clone()
        .ok_or_else(|| "缺少 onEvent".to_string())?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(req.timeout_ms.unwrap_or(120_000)))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let mut r = client.post(&req.url);
    for (k, v) in req.headers {
        r = r.header(k.as_str(), v.as_str());
    }
    r = r.body(req.body);

    let resp = r.send().await.map_err(|e| format!("HTTP 请求失败: {e}"))?;
    let status = resp.status().as_u16();
    if !resp.status().is_success() {
        let text = resp.text().await.unwrap_or_default();
        let message = if text.is_empty() {
            format!("HTTP {status}")
        } else {
            format!("HTTP {status}: {text}")
        };
        return Err(message);
    }

    // 事件经 ServerState 的 EventBus 广播（WS 订阅同一实例）。
    let bus = state.bus.clone();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(bytes) => {
                let data = String::from_utf8_lossy(&bytes).into_owned();
                bus.emit_channel(
                    &channel_id,
                    serde_json::json!({ "kind": "chunk", "data": data }),
                );
            }
            Err(e) => {
                bus.emit_channel(
                    &channel_id,
                    serde_json::json!({ "kind": "error", "message": format!("读取响应流失败: {e}") }),
                );
                return Err(format!("读取响应流失败: {e}"));
            }
        }
    }
    bus.emit_channel(&channel_id, serde_json::json!({ "kind": "done", "status": status }));
    Ok(())
}
