//! AI 对话流（Web 端）：`ai_chat_stream` / `ai_http_stream_post`。
//!
//! ## 传输语义（与桌面端对齐）
//! - `ai_chat_stream` 请求体：`{ request: <InternalChatRequestDto>, onEvent: <channelId> }`
//!   （Channel 序列化为自增 id 字符串，与 `frontend/src/shims/tauri/core-web.ts` 一致）。
//! - `ai_http_stream_post` 请求体：`{ url, headers, body, timeoutMs, onEvent: <channelId> }`。
//!
//! ## 范围说明
//! - 产品推理仅保留 CLI 智能体；Web 端无本地 Agent 进程，`ai_chat_stream` 明确拒绝。
//! - `ai_http_stream_post` 仍可作通用 HTTP 代理（非对话编排路径）。

use std::sync::atomic::Ordering;

use omnipanel_ai::{AiContextBundle, HttpProviderSnapshot, InternalChatRequest, InternalToolsMode};
use serde::Deserialize;

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

/// `ai_chat_stream`：流式对话，事件经 Channel 帧回传。
pub async fn ai_chat_stream(state: &ServerState, args: AiChatStreamArgs) -> Result<(), String> {
    let channel_id = args
        .channel_id
        .clone()
        .ok_or_else(|| "缺少 onEvent（Channel 未序列化）".to_string())?;

    let skill_ids = args.request.skill_ids.clone().unwrap_or_default();
    let internal = to_internal(args.request)?;
    let conversation_id = internal.conversation_id.clone();

    // 产品推理仅保留本地智能体（cli / opencode）；Web 端无本地进程，明确拒绝。
    let _ = skill_ids;
    let _ = state;
    let _ = channel_id;
    let _ = conversation_id;
    let parsed = omnipanel_ai::routing::parse_backend_id(&internal.backend_id)?;
    match parsed.kind {
        omnipanel_ai::routing::BackendKind::Cli => {
            let _ = omnipanel_ai::routing::normalize_cli_backend(&parsed)?;
            Err("Web 端暂不支持本地智能体（cli）；请使用桌面端 OmniPanel".to_string())
        }
        omnipanel_ai::routing::BackendKind::OpenCode => {
            let _ = omnipanel_ai::routing::normalize_opencode_backend(&parsed)?;
            Err("Web 端暂不支持 OpenCode HTTP；请使用桌面端 OmniPanel".to_string())
        }
    }
}

/// `ai_chat_cancel`：置位取消标志。
pub async fn ai_chat_cancel(state: &ServerState, conversation_id: String) -> Result<(), String> {
    let flags = state.ai_chat_cancel_flags.lock().await;
    if let Some(flag) = flags.get(&conversation_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// `ai_chat_tool_result`：回传工具执行结果（等价桌面端 Tauri 命令）。
///
/// P5 起 Web 端外部 MCP 工具开启审批时，`ServerToolExecutor` 会把 pending 通道注册进
/// `state.pending_internal_tool_results`，本命令从该表取出 oneshot 并把
/// `(result, approved)` 回传给等待中的执行器。
///
/// 注意：Web 端外部 MCP 审批通过后由**服务端自执**（浏览器只负责确认，不传回执行结果），
/// 因此 `result` 仅用于记录，实际以 `approved` 为准。若没有挂起的通道（自执模式/未知工具），
/// 返回错误但不影响调用方（兼容前端 `reportToolResultWithRetry` 的重试回退）。
pub async fn ai_chat_tool_result(
    state: &ServerState,
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
        .timeout(std::time::Duration::from_millis(
            req.timeout_ms.unwrap_or(120_000),
        ))
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
    bus.emit_channel(
        &channel_id,
        serde_json::json!({ "kind": "done", "status": status }),
    );
    Ok(())
}

/// 与桌面端 `BackendInfo` 同形（前端 `aiListBackends`）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendInfo {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub installed: bool,
}

/// 列出可用后端：仅 CLI 智能体；Web 端无本地进程，返回空列表。
pub async fn ai_list_backends() -> Result<Vec<BackendInfo>, String> {
    let _ = crate::store_bridge::ai_models_load().await;
    Ok(Vec::new())
}

/// Web 端无嵌入式 Agent Router 进程：只同步 MCP 外部审批开关，其余参数忽略。
pub async fn ai_gateway_configure(
    state: &ServerState,
    _enabled: bool,
    _port: u16,
    _api_key: Option<String>,
    _bind_lan: bool,
    mcp_external_require_approval: bool,
) -> Result<(), String> {
    crate::mcp::mcp_set_external_require_approval(state, mcp_external_require_approval).await
}
