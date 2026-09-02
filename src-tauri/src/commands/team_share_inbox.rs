//! 团队分享收件箱：SSE 等待 `team.share.created` 通知并转发给前端。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use omnipanel_error::{ErrorCode, OmniError};
use serde::Deserialize;
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use crate::commands::assistant_chat::build_auth_long;
use crate::commands::auth::auth_device_identity;
use crate::state::AppState;

/// 前端 `listen("team-share-inbound")` 的 payload。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamShareInboundEvent {
    pub team_id: f64,
    pub share_id: String,
    #[serde(default)]
    pub object_key: String,
}

/// `/api/notify/wait` 下发的通知信封；字段兼容 camelCase / snake_case。
#[derive(Debug, Deserialize)]
struct NotifyEnvelope {
    #[serde(default)]
    #[allow(dead_code)]
    event: String,
    #[serde(default)]
    payload: serde_json::Value,
}

fn payload_field_str(payload: &serde_json::Value, camel: &str, snake: &str) -> String {
    payload
        .get(camel)
        .or_else(|| payload.get(snake))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 兼容 camelCase / snake_case 的 payload 反序列化。
fn parse_share_notify(data: &str) -> Option<TeamShareInboundEvent> {
    let env: NotifyEnvelope = serde_json::from_str(data).ok()?;
    if env.payload.is_null() {
        return None;
    }
    let payload = &env.payload;
    let share_id = payload_field_str(payload, "shareId", "share_id");
    if share_id.trim().is_empty() {
        return None;
    }
    let team_id = payload
        .get("teamId")
        .or_else(|| payload.get("team_id"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    Some(TeamShareInboundEvent {
        team_id,
        share_id,
        object_key: payload_field_str(payload, "objectKey", "object_key"),
    })
}

struct ShareInboxRuntime {
    stop: Arc<AtomicBool>,
}

static SHARE_INBOX: Mutex<Option<ShareInboxRuntime>> = Mutex::new(None);

fn is_benign_sse_disconnect(cause: &str) -> bool {
    let lower = cause.to_ascii_lowercase();
    lower.contains("decoding response body")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("broken pipe")
        || lower.contains("unexpected eof")
        || lower.contains("error sending request")
}

/// 启动团队分享收件箱：SSE 等待 `team.share.created`，新分享经 App Event 推送前端。
#[tauri::command]
#[specta::specta]
pub async fn team_share_inbox_start(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut guard = SHARE_INBOX
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "分享收件箱锁失败"))?;
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
        *guard = Some(ShareInboxRuntime {
            stop: Arc::clone(&stop),
        });
    }

    let identity = auth_device_identity().await?;
    let device_id = identity.device_id.clone();
    let proxy_config = state.proxy_config.lock().await.clone();

    tauri::async_runtime::spawn(async move {
        run_share_inbox_loop(app, proxy_config, token, device_id, stop).await;
    });

    Ok(())
}

/// 停止团队分享收件箱 SSE 循环。
#[tauri::command]
#[specta::specta]
pub async fn team_share_inbox_stop() -> Result<(), OmniError> {
    if let Ok(mut guard) = SHARE_INBOX.lock() {
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

async fn run_share_inbox_loop(
    app: AppHandle,
    proxy: crate::state::ProxyConfig,
    token: String,
    device_id: String,
    stop: Arc<AtomicBool>,
) {
    let mut backoff_ms: u64 = 1_000;

    while !stop.load(Ordering::SeqCst) {
        let auth = match build_auth_long(&proxy, &token, &device_id).await {
            Ok(a) => a,
            Err(err) => {
                tracing::warn!(error = %err, "分享收件箱鉴权客户端创建失败");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
                continue;
            }
        };

        match listen_share_sse(&app, &auth, &stop).await {
            Ok(()) => {
                backoff_ms = 1_000;
            }
            Err(err) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(error = %err, "分享收件箱 SSE 断开，将重连");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
            }
        }
    }
}

async fn listen_share_sse(
    app: &AppHandle,
    auth: &omnipanel_assistant::AuthContext,
    stop: &AtomicBool,
) -> Result<(), OmniError> {
    let url = format!(
        "{}/api/notify/wait?events=team.share.created",
        auth.api_base.trim_end_matches('/'),
    );
    tracing::info!(%url, "分享收件箱 SSE 连接中");
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
                OmniError::new(ErrorCode::Timeout, "分享等待通道已断开")
            } else {
                OmniError::new(ErrorCode::Connection, "连接分享等待通道失败").with_cause(cause)
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("分享等待失败 (HTTP {status})"),
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
                OmniError::new(ErrorCode::Timeout, "分享等待通道已断开")
            } else {
                OmniError::new(ErrorCode::Io, "读取分享等待流失败").with_cause(cause)
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
                                "分享等待通道失败".to_string()
                            } else {
                                data
                            },
                        ));
                    }
                    "notify" | "message" => {
                        if data.trim().is_empty() {
                            continue;
                        }
                        match parse_share_notify(&data) {
                            Some(event) => {
                                tracing::info!(
                                    team_id = event.team_id,
                                    share_id = %event.share_id,
                                    "收到团队分享通知"
                                );
                                let _ = app.emit("team-share-inbound", event);
                            }
                            None => {
                                tracing::warn!(data = %data, "跳过无法解析的团队分享通知");
                            }
                        }
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

    Err(OmniError::new(ErrorCode::Timeout, "分享等待通道已结束"))
}
