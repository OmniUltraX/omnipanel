//! 1Panel 交互终端：WebSocket `/api/v2/hosts/terminal/...`。
//!
//! 端点按面板版本动态路由（见 [`crate::onepanel_version`]）：
//! - 容器：v2.2+ `/hosts/terminal/container`；v2.0–v2.1 `/api/v2/containers/exec`；v1 `/api/v1/containers/exec`
//! - 宿主机：v2.2+ `/hosts/terminal/local`；旧版 `/hosts/terminal`
//! - 版本探测失败时按全链顺序回退，保证未知/定制面板可用
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
use crate::onepanel::{ContainerTerminalEndpoint, OnePanelClient};
use crate::onepanel_version::OnePanelVersion;

/// 1Panel WebSocket 终端会话（容器 / 宿主机共用）。
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
        self.write_tx
            .send(payload.to_string())
            .map_err(|_| OmniError::new(ErrorCode::Internal, "1Panel 终端已断开"))
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        let payload = serde_json::json!({
            "type": "resize",
            "cols": cols,
            "rows": rows,
        });
        self.write_tx
            .send(payload.to_string())
            .map_err(|_| OmniError::new(ErrorCode::Internal, "1Panel 终端已断开"))
    }

    pub async fn close(self) -> OmniResult<()> {
        let _ = self.close_tx.send(());
        Ok(())
    }
}

/// 按面板版本给出容器终端端点优先级。
/// 版本未知时按 v2.2+ → v2.0/v2.1 → v1 全链顺序盲试，保证未知/定制面板可用。
pub(crate) fn container_terminal_endpoint_order(
    version: Option<OnePanelVersion>,
) -> Vec<ContainerTerminalEndpoint> {
    match version {
        Some(v) if v.is_at_least(2, 2) => vec![
            ContainerTerminalEndpoint::HostsTerminal,
            ContainerTerminalEndpoint::ContainersExecV2,
            ContainerTerminalEndpoint::ContainersExecV1,
        ],
        Some(v) if v.major >= 2 => vec![
            ContainerTerminalEndpoint::ContainersExecV2,
            ContainerTerminalEndpoint::ContainersExecV1,
            ContainerTerminalEndpoint::HostsTerminal,
        ],
        Some(_) => vec![
            ContainerTerminalEndpoint::ContainersExecV1,
            ContainerTerminalEndpoint::ContainersExecV2,
            ContainerTerminalEndpoint::HostsTerminal,
        ],
        None => vec![
            ContainerTerminalEndpoint::HostsTerminal,
            ContainerTerminalEndpoint::ContainersExecV2,
            ContainerTerminalEndpoint::ContainersExecV1,
        ],
    }
}

/// 建立 1Panel 容器 WebSocket 终端。
/// 先探测面板版本决定端点优先级，再依次尝试；三端点共用 cmd/resize/heartbeat 消息协议。
pub async fn create_container_exec(
    client: &OnePanelClient,
    container_id: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> OmniResult<(OnePanelExecSession, DockerExecOutput)> {
    const CONNECT_ERROR: &str = "连接 1Panel 容器终端失败";

    let version = client.detect_version().await;
    let endpoints = container_terminal_endpoint_order(version);
    let mut urls = Vec::with_capacity(endpoints.len());
    for endpoint in endpoints {
        urls.push(client.container_terminal_ws_url(container_id, shell, cols, rows, endpoint)?);
    }

    let mut errors: Vec<String> = Vec::new();
    for url in urls {
        match connect_terminal_ws(client, &url, CONNECT_ERROR).await {
            Ok(pair) => return Ok(pair),
            Err(err) => errors.push(err.user_message()),
        }
    }
    Err(OmniError::new(ErrorCode::Connection, CONNECT_ERROR).with_cause(errors.join(" | ")))
}

/// 建立 1Panel 宿主机本地终端（`WsSSH` / local host）。
/// v2.2+ 面板优先 `/hosts/terminal/local`，旧版优先 `/hosts/terminal`，失败互换重试。
pub async fn create_host_shell(
    client: &OnePanelClient,
    cols: u16,
    rows: u16,
) -> OmniResult<(OnePanelExecSession, DockerExecOutput)> {
    let prefer_local = client
        .detect_version()
        .await
        .map(|v| v.is_at_least(2, 2))
        .unwrap_or(false);
    let primary = client.host_terminal_ws_url(cols, rows, "", prefer_local)?;
    match connect_terminal_ws(client, &primary, "连接 1Panel 宿主机终端失败").await {
        Ok(pair) => Ok(pair),
        Err(primary_err) => {
            let fallback = client.host_terminal_ws_url(cols, rows, "", !prefer_local)?;
            if fallback == primary {
                return Err(primary_err);
            }
            connect_terminal_ws(client, &fallback, "连接 1Panel 宿主机终端失败")
                .await
                .map_err(|fallback_err| {
                    OmniError::new(ErrorCode::Connection, "连接 1Panel 宿主机终端失败").with_cause(
                        format!(
                            "primary: {}; fallback: {}",
                            primary_err.user_message(),
                            fallback_err.user_message()
                        ),
                    )
                })
        }
    }
}

async fn connect_terminal_ws(
    client: &OnePanelClient,
    ws_url: &str,
    connect_error: &str,
) -> OmniResult<(OnePanelExecSession, DockerExecOutput)> {
    let mut request = ws_url.into_client_request().map_err(|e| {
        OmniError::new(ErrorCode::Connection, "构造 1Panel 终端 WebSocket 请求失败")
            .with_cause(e.to_string())
    })?;

    for (key, value) in client.auth_headers() {
        let header_name = key
            .parse::<tokio_tungstenite::tungstenite::http::HeaderName>()
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "无效的 1Panel 请求头")
                    .with_cause(e.to_string())
            })?;
        let header_value = value
            .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "无效的 1Panel 请求头值")
                    .with_cause(e.to_string())
            })?;
        request.headers_mut().insert(header_name, header_value);
    }

    let (ws_stream, _) = connect_async_tls_with_config(request, None, false, client.ws_connector())
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, connect_error)
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
            let _ = out_tx.send(Err(OmniError::new(
                ErrorCode::Internal,
                "解析 1Panel 终端输出失败",
            )
            .with_cause(err.to_string())));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(major: u32, minor: u32, patch: u32) -> OnePanelVersion {
        OnePanelVersion::new(major, minor, patch)
    }

    #[test]
    fn endpoint_order_prefers_v22_hosts_terminal() {
        assert_eq!(
            container_terminal_endpoint_order(Some(v(2, 2, 0))),
            vec![
                ContainerTerminalEndpoint::HostsTerminal,
                ContainerTerminalEndpoint::ContainersExecV2,
                ContainerTerminalEndpoint::ContainersExecV1,
            ]
        );
    }

    #[test]
    fn endpoint_order_prefers_containers_exec_on_v20_v21() {
        assert_eq!(
            container_terminal_endpoint_order(Some(v(2, 0, 5))),
            vec![
                ContainerTerminalEndpoint::ContainersExecV2,
                ContainerTerminalEndpoint::ContainersExecV1,
                ContainerTerminalEndpoint::HostsTerminal,
            ]
        );
        assert_eq!(
            container_terminal_endpoint_order(Some(v(2, 1, 3))),
            vec![
                ContainerTerminalEndpoint::ContainersExecV2,
                ContainerTerminalEndpoint::ContainersExecV1,
                ContainerTerminalEndpoint::HostsTerminal,
            ]
        );
    }

    #[test]
    fn endpoint_order_prefers_v1_exec_on_v1_panels() {
        assert_eq!(
            container_terminal_endpoint_order(Some(v(1, 10, 32))),
            vec![
                ContainerTerminalEndpoint::ContainersExecV1,
                ContainerTerminalEndpoint::ContainersExecV2,
                ContainerTerminalEndpoint::HostsTerminal,
            ]
        );
    }

    #[test]
    fn endpoint_order_unknown_version_falls_back_full_chain() {
        assert_eq!(
            container_terminal_endpoint_order(None),
            vec![
                ContainerTerminalEndpoint::HostsTerminal,
                ContainerTerminalEndpoint::ContainersExecV2,
                ContainerTerminalEndpoint::ContainersExecV1,
            ]
        );
    }

    #[test]
    fn container_terminal_url_matches_endpoint_generation() {
        let client = OnePanelClient::new("http://127.0.0.1:9999", "key", true);
        let hosts = client
            .container_terminal_ws_url(
                "cid",
                "/bin/sh",
                80,
                24,
                ContainerTerminalEndpoint::HostsTerminal,
            )
            .unwrap();
        assert!(hosts.starts_with("ws://127.0.0.1:9999/api/v2/hosts/terminal/container?"));
        assert!(hosts.contains("operateNode=local"));

        let exec_v2 = client
            .container_terminal_ws_url(
                "cid",
                "/bin/sh",
                80,
                24,
                ContainerTerminalEndpoint::ContainersExecV2,
            )
            .unwrap();
        assert!(exec_v2.starts_with("ws://127.0.0.1:9999/api/v2/containers/exec?"));
        assert!(!exec_v2.contains("operateNode="));

        let exec_v1 = client
            .container_terminal_ws_url(
                "cid",
                "/bin/sh",
                80,
                24,
                ContainerTerminalEndpoint::ContainersExecV1,
            )
            .unwrap();
        assert!(exec_v1.starts_with("ws://127.0.0.1:9999/api/v1/containers/exec?"));
    }
}
