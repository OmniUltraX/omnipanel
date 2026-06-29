use anyhow::{Result, bail};
use serde::Deserialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{Mutex, mpsc, oneshot};

use crate::providers::acp::types::*;

pub type NotificationHandler = Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync + 'static>;

pub type ServerRequestHandler =
    Arc<dyn Fn(u64, &str, &serde_json::Value) -> Option<serde_json::Value> + Send + Sync + 'static>;

struct AcpClientInner {
    child: Option<Child>,
    stdin_tx: Option<mpsc::Sender<String>>,
}

/// Long-lived ACP subprocess client (JSON-RPC 2.0 over stdio, ACP v1).
pub struct AcpClient {
    binary_path: String,
    args: Vec<String>,
    spawn_env: HashMap<String, String>,
    spawn_cwd: Option<String>,
    inner: Mutex<AcpClientInner>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    notification_handler: Arc<Mutex<Option<NotificationHandler>>>,
    server_request_handler: Arc<Mutex<Option<ServerRequestHandler>>>,
}

impl AcpClient {
    pub fn new(
        binary_path: &str,
        args: Vec<String>,
        spawn_env: HashMap<String, String>,
        spawn_cwd: Option<String>,
    ) -> Self {
        Self {
            binary_path: binary_path.to_string(),
            args,
            spawn_env,
            spawn_cwd,
            inner: Mutex::new(AcpClientInner {
                child: None,
                stdin_tx: None,
            }),
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notification_handler: Arc::new(Mutex::new(None)),
            server_request_handler: Arc::new(Mutex::new(None)),
        }
    }

    pub async fn set_notification_handler(&self, handler: NotificationHandler) {
        *self.notification_handler.lock().await = Some(handler);
    }

    pub async fn set_server_request_handler(&self, handler: ServerRequestHandler) {
        *self.server_request_handler.lock().await = Some(handler);
    }

    pub async fn clear_handlers(&self) {
        *self.notification_handler.lock().await = None;
        *self.server_request_handler.lock().await = None;
    }

    pub async fn ensure_running(&self) -> Result<()> {
        let mut inner = self.inner.lock().await;
        if inner.child.is_some() {
            if let Some(ref mut child) = inner.child {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        inner.child = None;
                        inner.stdin_tx = None;
                    }
                    Ok(None) => return Ok(()),
                    Err(e) => bail!("Failed to check process status: {e}"),
                }
            }
        }

        let mut cmd = Command::new(&self.binary_path);
        cmd.args(&self.args);
        if let Some(ref cwd) = self.spawn_cwd {
            cmd.current_dir(cwd);
        }
        for (key, value) in &self.spawn_env {
            cmd.env(key, value);
        }
        configure_agent_stdio(&mut cmd);

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!("Failed to spawn ACP agent '{}': {e}", self.binary_path)
        })?;

        let stderr = child.stderr.take();
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        if let Ok(Some(status)) = child.try_wait() {
            let mut err_text = String::new();
            if let Some(mut stderr) = stderr {
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf).await;
                err_text = String::from_utf8_lossy(&buf).trim().to_string();
            }
            if err_text.is_empty() {
                bail!(
                    "ACP agent process exited before initialize (code {:?})",
                    status.code()
                );
            }
            bail!("ACP agent process exited before initialize: {err_text}");
        }

        if let Some(stderr) = stderr {
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::warn!(target: "acp_agent_stderr", "{line}");
                }
            });
        }

        let stdin = child.stdin.take().expect("stdin should be piped");
        let stdout = child.stdout.take().expect("stdout should be piped");

        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
        let writer = Arc::new(Mutex::new(Some(stdin_tx.clone())));

        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err() {
                    break;
                }
                if stdin.write_all(b"\n").await.is_err() {
                    break;
                }
            }
        });

        let pending = self.pending.clone();
        let notif_handler = self.notification_handler.clone();
        let req_handler = self.server_request_handler.clone();

        tokio::spawn(async move {
            let reader = BufReader::new(stdout);
            let mut lines = reader.lines();

            while let Ok(Some(line)) = lines.next_line().await {
                let line = line.trim().to_string();
                if line.is_empty() {
                    continue;
                }

                if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(&line) {
                    let mut pending_map = pending.lock().await;
                    if let Some(tx) = pending_map.remove(&resp.id) {
                        let _ = tx.send(resp);
                    }
                    continue;
                }

                if let Ok(notif) = serde_json::from_str::<JsonRpcNotification>(&line) {
                    if let Some(id) = extract_server_request_id(&line) {
                        let handler = req_handler.lock().await;
                        if let Some(ref h) = *handler {
                            let params = notif
                                .params
                                .as_ref()
                                .unwrap_or(&serde_json::Value::Null);
                            if let Some(result) = h(id, &notif.method, params) {
                                let response = JsonRpcResponse {
                                    jsonrpc: "2.0".to_string(),
                                    id,
                                    result: Some(result),
                                    error: None,
                                };
                                if let Ok(encoded) = serde_json::to_string(&response) {
                                    if let Some(ref tx) = *writer.lock().await {
                                        let _ = tx.send(encoded).await;
                                    }
                                }
                            }
                        }
                    } else {
                        let handler = notif_handler.lock().await;
                        if let Some(ref h) = *handler {
                            h(
                                &notif.method,
                                notif.params.as_ref().unwrap_or(&serde_json::Value::Null),
                            );
                        }
                    }
                }
            }
        });

        inner.stdin_tx = Some(stdin_tx);
        inner.child = Some(child);
        Ok(())
    }

    pub async fn request(
        &self,
        method: &str,
        params: Option<serde_json::Value>,
    ) -> Result<serde_json::Value> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let request = JsonRpcRequest {
            jsonrpc: "2.0".to_string(),
            id,
            method: method.to_string(),
            params,
        };

        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().await;
            pending.insert(id, tx);
        }

        let line = serde_json::to_string(&request)?;
        self.send_line(line).await?;

        let response = rx
            .await
            .map_err(|_| anyhow::anyhow!("Response channel dropped"))?;

        if let Some(error) = response.error {
            let detail = error
                .data
                .as_ref()
                .and_then(|data| {
                    data.get("details")
                        .and_then(|value| value.as_str())
                        .or_else(|| data.as_str())
                        .map(str::to_string)
                })
                .unwrap_or_default();
            if detail.is_empty() {
                bail!("ACP error {}: {}", error.code, error.message);
            } else {
                bail!("ACP error {}: {} — {}", error.code, error.message, detail);
            }
        }

        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }

    pub async fn notify(&self, method: &str, params: Option<serde_json::Value>) -> Result<()> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&notification)?;
        self.send_line(line).await
    }

    pub async fn write_response(&self, response: JsonRpcResponse) -> Result<()> {
        let line = serde_json::to_string(&response)?;
        self.send_line(line).await
    }

    async fn send_line(&self, line: String) -> Result<()> {
        let inner = self.inner.lock().await;
        if let Some(ref stdin_tx) = inner.stdin_tx {
            stdin_tx
                .send(line)
                .await
                .map_err(|_| anyhow::anyhow!("Failed to send to ACP stdin"))?;
        } else {
            bail!("ACP client not started");
        }
        Ok(())
    }

    pub async fn kill(&self) {
        let mut inner = self.inner.lock().await;
        if let Some(ref mut child) = inner.child {
            let _ = child.kill().await;
        }
        inner.child = None;
        inner.stdin_tx = None;
    }

    pub async fn is_running(&self) -> bool {
        self.inner.lock().await.child.is_some()
    }
}

#[cfg(windows)]
fn configure_agent_stdio(cmd: &mut Command) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_agent_stdio(cmd: &mut Command) {
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
}

fn extract_server_request_id(json_str: &str) -> Option<u64> {
    #[derive(Deserialize)]
    struct HasId {
        id: Option<u64>,
    }
    serde_json::from_str::<HasId>(json_str)
        .ok()
        .and_then(|h| h.id)
}
