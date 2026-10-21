//! 同步密钥中继收件：SSE 等待 `client.sync.key.relay.pending` 并转发给前端。
//!
//! 持钥设备用这条通道给 mesh 够不着的新设备传密钥。没有密钥时前端不启动。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use omnipanel_error::{ErrorCode, OmniError};
use serde::Deserialize;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::assistant_chat::build_auth_long;
use crate::commands::auth::auth_device_identity;
use crate::state::AppState;

/// 前端 `listen("sync-key-relay-pending")` 的 payload。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncKeyRelayPendingEvent {
    request_id: String,
    team_id: f64,
    requester_device_id: String,
    ephemeral_pubkey: String,
    wrap_alg: String,
}

/// 前端 `listen("sync-key-relay-channel")`：通知流是否还连着。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncKeyRelayChannelEvent {
    up: bool,
}

#[derive(Debug, Deserialize)]
struct NotifyEnvelope {
    #[serde(default)]
    #[allow(dead_code)]
    event: String,
    #[serde(default)]
    payload: serde_json::Value,
}

fn payload_str(payload: &serde_json::Value, camel: &str, snake: &str) -> String {
    payload
        .get(camel)
        .or_else(|| payload.get(snake))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn payload_team_id(payload: &serde_json::Value) -> f64 {
    payload
        .get("teamId")
        .or_else(|| payload.get("team_id"))
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_i64().map(|n| n as f64))
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0.0)
}

fn parse_pending_notify(data: &str) -> Option<SyncKeyRelayPendingEvent> {
    let env: NotifyEnvelope = serde_json::from_str(data).ok()?;
    if env.payload.is_null() {
        return None;
    }
    let payload = &env.payload;
    let request_id = payload_str(payload, "requestId", "request_id");
    let ephemeral_pubkey = payload_str(payload, "ephemeralPubkey", "ephemeral_pubkey");
    let team_id = payload_team_id(payload);
    if request_id.is_empty() || ephemeral_pubkey.is_empty() || team_id <= 0.0 {
        return None;
    }
    Some(SyncKeyRelayPendingEvent {
        request_id,
        team_id,
        requester_device_id: payload_str(payload, "requesterDeviceId", "requester_device_id"),
        ephemeral_pubkey,
        wrap_alg: payload_str(payload, "wrapAlg", "wrap_alg"),
    })
}

struct RelayInboxRuntime {
    stop: Arc<AtomicBool>,
}

static RELAY_INBOX: Mutex<Option<RelayInboxRuntime>> = Mutex::new(None);

fn is_benign_sse_disconnect(cause: &str) -> bool {
    let lower = cause.to_ascii_lowercase();
    lower.contains("decoding response body")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("broken pipe")
        || lower.contains("unexpected eof")
        || lower.contains("error sending request")
        || lower.contains("tcp connect")
        || lower.contains("operation timed out")
}

fn emit_channel(app: &AppHandle, up: bool) {
    let _ = app.emit("sync-key-relay-channel", SyncKeyRelayChannelEvent { up });
}

/// 启动同步密钥中继收件：SSE 等待 `client.sync.key.relay.pending`。
#[tauri::command]
#[specta::specta]
pub async fn sync_key_relay_inbox_start(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut guard = RELAY_INBOX
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "同步密钥中继收件锁失败"))?;
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
        *guard = Some(RelayInboxRuntime {
            stop: Arc::clone(&stop),
        });
    }

    let identity = auth_device_identity().await?;
    let device_id = identity.device_id.clone();
    let proxy_config = state.proxy_config.lock().await.clone();

    tauri::async_runtime::spawn(async move {
        run_relay_inbox_loop(app, proxy_config, token, device_id, stop).await;
    });

    Ok(())
}

/// 停止同步密钥中继收件 SSE 循环。
#[tauri::command]
#[specta::specta]
pub async fn sync_key_relay_inbox_stop() -> Result<(), OmniError> {
    if let Ok(mut guard) = RELAY_INBOX.lock() {
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

async fn run_relay_inbox_loop(
    app: AppHandle,
    proxy: crate::state::ProxyConfig,
    token: String,
    device_id: String,
    stop: Arc<AtomicBool>,
) {
    let mut backoff_ms: u64 = 1_000;
    emit_channel(&app, false);

    while !stop.load(Ordering::SeqCst) {
        let auth = match build_auth_long(&proxy, &token, &device_id).await {
            Ok(a) => a,
            Err(err) => {
                tracing::warn!(error = %err, "同步密钥中继收件鉴权客户端创建失败");
                emit_channel(&app, false);
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
                continue;
            }
        };

        match listen_relay_sse(&app, &auth, &stop).await {
            Ok(()) => {
                backoff_ms = 1_000;
            }
            Err(err) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(error = %err, "同步密钥中继收件 SSE 断开，将重连");
                emit_channel(&app, false);
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
            }
        }
    }

    emit_channel(&app, false);
}

async fn listen_relay_sse(
    app: &AppHandle,
    auth: &omnipanel_assistant::AuthContext,
    stop: &AtomicBool,
) -> Result<(), OmniError> {
    let url = format!(
        "{}/api/notify/wait?events=client.sync.key.relay.pending",
        auth.api_base.trim_end_matches('/'),
    );
    tracing::info!(%url, "同步密钥中继收件 SSE 连接中");
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
                OmniError::new(ErrorCode::Timeout, "同步密钥中继通道已断开")
            } else {
                OmniError::new(ErrorCode::Connection, "连接同步密钥中继通道失败").with_cause(cause)
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("同步密钥中继等待失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    emit_channel(app, true);

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
                OmniError::new(ErrorCode::Timeout, "同步密钥中继通道已断开")
            } else {
                OmniError::new(ErrorCode::Io, "读取同步密钥中继流失败").with_cause(cause)
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
                                "同步密钥中继通道失败".to_string()
                            } else {
                                data
                            },
                        ));
                    }
                    "notify" | "message" => {
                        if data.trim().is_empty() {
                            continue;
                        }
                        match parse_pending_notify(&data) {
                            Some(event) => {
                                tracing::info!(
                                    team_id = event.team_id,
                                    request_id = %event.request_id,
                                    "收到同步密钥中继请求"
                                );
                                let _ = app.emit("sync-key-relay-pending", event);
                            }
                            None => {
                                tracing::warn!(data = %data, "跳过无法解析的同步密钥中继通知");
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

    Err(OmniError::new(ErrorCode::Timeout, "同步密钥中继通道已结束"))
}
