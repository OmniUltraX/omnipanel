//! 1Panel 容器交互终端：WebSocket `/api/v2/hosts/terminal/container`。
//!
//! 协议与 1Panel 前端 `components/terminal/index.vue` 一致：
//! - 上行：`{"type":"cmd","data":"<base64>"}` / `{"type":"resize","cols":N,"rows":N}`
//! - 下行：`{"type":"cmd","data":"<base64>"}` / `{"type":"heartbeat",...}`

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::{SinkExt, StreamExt};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async_tls_with_config;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;

use crate::local::DockerExecOutput;
use crate::onepanel::OnePanelClient;

/// 1Panel WebSocket 容器终端会话。
pub struct OnePanelExecSession {
    write_tx: mpsc::UnboundedSender<String>,
    close_tx: mpsc::UnboundedSender<()>,
}

impl OnePanelExecSession {
    pub async fn write(&self, data: &[u8]) -> OmniResult<()> {
        let payload = serde_json::json!({
            "type": "cmd",
            "data": BASE64.encode(data),
        });
        self.write_tx.send(payload.to_string()).map_err(|_| {
            OmniError::new(ErrorCode::Internal, "1Panel 容器终端已断开")
        })
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        let payload = serde_json::json!({
            "type": "resize",
            "cols": cols,
            "rows": rows,
        });
        self.write_tx.send(payload.to_string()).map_err(|_| {
            OmniError::new(ErrorCode::Internal, "1Panel 容器终端已断开")
        })
    }

    pub async fn close(self) -> OmniResult<()> {
        let _ = self.close_tx.send(());
        Ok(())
    }
}

/// 建立 1Panel 容器 WebSocket 终端。
pub async fn create_container_exec(
    client: &OnePanelClient,
    container_id: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> OmniResult<(OnePanelExecSession, DockerExecOutput)> {
    let ws_url = client.container_terminal_ws_url(container_id, shell, cols, rows)?;
    let mut request = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| OmniError::new(ErrorCode::Connection, "构造 1Panel 终端 WebSocket 请求失败").with_cause(e.to_string()))?;

    for (key, value) in client.auth_headers() {
        let header_name = key.parse::<tokio_tungstenite::tungstenite::http::HeaderName>().map_err(|e| {
            OmniError::new(ErrorCode::Internal, "无效的 1Panel 请求头").with_cause(e.to_string())
        })?;
        let header_value = value
            .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "无效的 1Panel 请求头值").with_cause(e.to_string())
            })?;
        request.headers_mut().insert(header_name, header_value);
    }

    let (ws_stream, _) = connect_async_tls_with_config(
        request,
        None,
        false,
        client.ws_connector(),
    )
    .await
    .map_err(|e| {
        OmniError::new(ErrorCode::Connection, "连接 1Panel 容器终端失败")
            .with_cause(format!("{ws_url}: {e}"))
    })?;

    let (mut ws_write, mut ws_read) = ws_stream.split();
    let (out_tx, out_rx) = mpsc::unbounded_channel::<OmniResult<Vec<u8>>>();
    let (write_tx, mut write_rx) = mpsc::unbounded_channel::<String>();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<()>();

    let session = OnePanelExecSession { write_tx, close_tx };

    tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(std::time::Duration::from_secs(10));
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = close_rx.recv() => break,
                Some(payload) = write_rx.recv() => {
                    if ws_write.send(Message::Text(payload.into())).await.is_err() {
                        break;
                    }
                }
                _ = heartbeat.tick() => {
                    let ping = serde_json::json!({
                        "type": "heartbeat",
                        "timestamp": chrono::Utc::now().timestamp_millis().to_string(),
                    });
                    if ws_write.send(Message::Text(ping.to_string().into())).await.is_err() {
                        break;
                    }
                }
                item = ws_read.next() => {
                    match item {
                        Some(Ok(Message::Text(text))) => {
                            push_terminal_output(&text, &out_tx);
                        }
                        Some(Ok(Message::Binary(bin))) => {
                            if let Ok(text) = String::from_utf8(bin.to_vec()) {
                                push_terminal_output(&text, &out_tx);
                            } else {
                                let _ = out_tx.send(Ok(bin.to_vec()));
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => break,
                        Some(Err(_)) => break,
                        _ => {}
                    }
                }
            }
        }
        let _ = ws_write.close().await;
    });

    let output: DockerExecOutput = Box::pin(async_stream::stream! {
        let mut rx = out_rx;
        while let Some(item) = rx.recv().await {
            yield item;
        }
    });

    Ok((session, output))
}

fn push_terminal_output(text: &str, out_tx: &mpsc::UnboundedSender<OmniResult<Vec<u8>>>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    let Some(msg_type) = value.get("type").and_then(|v| v.as_str()) else {
        return;
    };
    if msg_type != "cmd" {
        return;
    }
    let Some(data) = value.get("data").and_then(|v| v.as_str()) else {
        return;
    };
    if data.is_empty() {
        return;
    }
    match BASE64.decode(data) {
        Ok(bytes) => {
            let _ = out_tx.send(Ok(bytes));
        }
        Err(err) => {
            let _ = out_tx.send(Err(
                OmniError::new(ErrorCode::Internal, "解析 1Panel 终端输出失败")
                    .with_cause(err.to_string()),
            ));
        }
    }
}
