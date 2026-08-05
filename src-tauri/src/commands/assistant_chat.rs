//! 助手 → 客户端聊天收件箱：latest 拉取 + SSE 等待 + OSS 读对象。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use omnipanel_assistant::{
    fetch_chat_latest, fetch_oss_sts, get_object_bytes, parse_inbound_chat_message, AuthContext,
    ChatLatestIndex,
};
use omnipanel_error::{ErrorCode, OmniError};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use crate::commands::assistant::build_auth_context;
use crate::commands::auth::auth_device_identity;
use crate::commands::proxy::build_http_client_for_url;
use crate::state::AppState;

const AUTH_API_BASE: &str = "https://mp.99.protected.fun";
const CLIENT_APP_ID: &str = "omni-client";
/// SSE 长连接：避免 reqwest 默认超时打断 wait。
const SSE_HTTP_TIMEOUT: Duration = Duration::from_secs(6 * 3600);

/// 前端 `listen(ASSISTANT_CHAT_INBOUND)` 的 payload。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantChatInboundEvent {
    pub message_id: String,
    pub object_key: String,
    pub created_at: String,
    pub text: String,
    /// 助手端当前选中的会话 id；空则回退客户端当前 Dock 会话。
    #[serde(default)]
    pub session_id: String,
}

struct ChatInboxRuntime {
    stop: Arc<AtomicBool>,
}

static CHAT_INBOX: Mutex<Option<ChatInboxRuntime>> = Mutex::new(None);

fn is_benign_sse_disconnect(cause: &str) -> bool {
    let lower = cause.to_ascii_lowercase();
    lower.contains("decoding response body")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("broken pipe")
        || lower.contains("unexpected eof")
        || lower.contains("error sending request")
}

/// 读取最近一条聊天索引（无则 `null`）。
#[tauri::command]
#[specta::specta]
pub async fn assistant_chat_latest(
    state: State<'_, AppState>,
    token: String,
) -> Result<Option<ChatLatestIndex>, OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    fetch_chat_latest(&auth).await
}

/// 按 object key 拉取 OSS 正文并解析为可展示文本。
#[tauri::command]
#[specta::specta]
pub async fn assistant_chat_fetch_object(
    state: State<'_, AppState>,
    token: String,
    object_key: String,
) -> Result<AssistantChatInboundEvent, OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }
    if object_key.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "object_key 不能为空"));
    }
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    load_inbound_from_key(&auth, object_key.trim(), "", "", "").await
}

/// 启动收件箱：先拉 latest，再挂 SSE `/api/assistant/chat/wait`；新消息经 App Event 推送。
#[tauri::command]
#[specta::specta]
pub async fn assistant_chat_inbox_start(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut guard = CHAT_INBOX
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "聊天收件箱锁失败"))?;
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
        *guard = Some(ChatInboxRuntime {
            stop: Arc::clone(&stop),
        });
    }

    let identity = auth_device_identity().await?;
    let device_id = identity.device_id.clone();
    let proxy_config = state.proxy_config.lock().await.clone();

    tauri::async_runtime::spawn(async move {
        run_chat_inbox_loop(app, proxy_config, token, device_id, stop).await;
    });

    Ok(())
}

/// 停止收件箱 SSE 循环。
#[tauri::command]
#[specta::specta]
pub async fn assistant_chat_inbox_stop() -> Result<(), OmniError> {
    if let Ok(mut guard) = CHAT_INBOX.lock() {
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

async fn build_auth_long(
    proxy: &crate::state::ProxyConfig,
    token: &str,
    device_id: &str,
) -> Result<AuthContext, OmniError> {
    let http = build_http_client_for_url(AUTH_API_BASE, proxy, SSE_HTTP_TIMEOUT).map_err(|e| {
        OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e)
    })?;
    Ok(AuthContext {
        api_base: AUTH_API_BASE.to_string(),
        access_token: token.to_string(),
        app_id: CLIENT_APP_ID.to_string(),
        device_id: device_id.to_string(),
        device_public_key: String::new(),
        http,
    })
}

async fn load_inbound_from_key(
    auth: &AuthContext,
    object_key: &str,
    message_id: &str,
    created_at: &str,
    session_id_hint: &str,
) -> Result<AssistantChatInboundEvent, OmniError> {
    let sts = fetch_oss_sts(auth).await?;
    let bytes = get_object_bytes(&auth.http, &sts, object_key).await?;
    let raw = String::from_utf8_lossy(&bytes);
    let parsed = parse_inbound_chat_message(&raw);
    let session_id = if !parsed.session_id.trim().is_empty() {
        parsed.session_id
    } else {
        session_id_hint.trim().to_string()
    };
    Ok(AssistantChatInboundEvent {
        message_id: if message_id.is_empty() {
            object_key.to_string()
        } else {
            message_id.to_string()
        },
        object_key: object_key.to_string(),
        created_at: created_at.to_string(),
        text: parsed.text,
        session_id,
    })
}

async fn emit_inbound(app: &AppHandle, event: AssistantChatInboundEvent) {
    if event.text.trim().is_empty() {
        tracing::warn!(
            object_key = %event.object_key,
            "助手聊天 OSS 对象无可展示文本，跳过"
        );
        return;
    }
    let _ = app.emit("assistant-chat-inbound", event);
}

async fn handle_index(app: &AppHandle, auth: &AuthContext, index: ChatLatestIndex) {
    match load_inbound_from_key(
        auth,
        &index.object_key,
        &index.message_id,
        &index.created_at,
        &index.session_id,
    )
    .await
    {
        Ok(event) => emit_inbound(app, event).await,
        Err(err) => {
            tracing::warn!(
                object_key = %index.object_key,
                error = %err,
                "拉取助手聊天 OSS 对象失败"
            );
        }
    }
}

async fn run_chat_inbox_loop(
    app: AppHandle,
    proxy: crate::state::ProxyConfig,
    token: String,
    device_id: String,
    stop: Arc<AtomicBool>,
) {
    let mut backoff_ms: u64 = 1_000;
    let mut last_dedupe = String::new();

    // 启动时先拉 latest，避免错过 SSE 连接前的消息
    if let Ok(auth) = build_auth_long(&proxy, &token, &device_id).await {
        match fetch_chat_latest(&auth).await {
            Ok(Some(index)) => {
                last_dedupe = index.dedupe_key();
                handle_index(&app, &auth, index).await;
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(error = %err, "启动时读取聊天 latest 失败");
            }
        }
    }

    while !stop.load(Ordering::SeqCst) {
        let auth = match build_auth_long(&proxy, &token, &device_id).await {
            Ok(a) => a,
            Err(err) => {
                tracing::warn!(error = %err, "聊天收件箱鉴权客户端创建失败");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
                continue;
            }
        };

        match listen_chat_sse(&app, &auth, &stop, &mut last_dedupe).await {
            Ok(()) => {
                backoff_ms = 1_000;
            }
            Err(err) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(error = %err, "聊天收件箱 SSE 断开，将重连");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
            }
        }
    }
}

async fn listen_chat_sse(
    app: &AppHandle,
    auth: &AuthContext,
    stop: &AtomicBool,
    last_dedupe: &mut String,
) -> Result<(), OmniError> {
    let url = format!(
        "{}/api/assistant/chat/wait",
        auth.api_base.trim_end_matches('/')
    );
    tracing::info!(%url, "聊天收件箱 SSE 连接中");
    let resp = auth
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .header("X-Device-Public-Key", &auth.device_public_key)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(|e| {
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "聊天等待通道已断开")
            } else {
                OmniError::new(ErrorCode::Connection, "连接聊天等待通道失败").with_cause(cause)
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("聊天等待失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let bytes = chunk.map_err(|e| {
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "聊天等待通道已断开")
            } else {
                OmniError::new(ErrorCode::Io, "读取聊天等待流失败").with_cause(cause)
            }
        })?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buffer.find('\n') {
            let mut line = buffer[..idx].to_string();
            buffer.drain(..=idx);
            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() {
                let data = data_lines.join("\n");
                let name = if event_name.is_empty() {
                    "message".to_string()
                } else {
                    std::mem::take(&mut event_name)
                };
                data_lines.clear();

                match name.as_str() {
                    "ping" => {}
                    "fail" => {
                        return Err(OmniError::new(
                            ErrorCode::Connection,
                            if data.is_empty() {
                                "聊天等待通道失败".to_string()
                            } else {
                                data
                            },
                        ));
                    }
                    "message" => {
                        if data.trim().is_empty() {
                            continue;
                        }
                        let index: ChatLatestIndex = match ChatLatestIndex::parse_json(&data) {
                            Ok(v) => v,
                            Err(e) => {
                                // 单条坏事件不拆掉整条 SSE（此前 numeric userId 会整链失败）
                                tracing::warn!(
                                    error = %e,
                                    data = %data,
                                    "跳过无法解析的聊天 message 事件"
                                );
                                continue;
                            }
                        };
                        let key = index.dedupe_key();
                        if !key.is_empty() && key == *last_dedupe {
                            continue;
                        }
                        if !key.is_empty() {
                            *last_dedupe = key;
                        }
                        tracing::info!(
                            message_id = %index.message_id,
                            object_key = %index.object_key,
                            "收到助手聊天通知，开始拉 OSS"
                        );
                        handle_index(app, auth, index).await;
                    }
                    _ => {}
                }
                continue;
            }

            if let Some(rest) = line.strip_prefix("event:") {
                event_name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }
    }

    Err(OmniError::new(ErrorCode::Timeout, "聊天等待通道已结束"))
}
