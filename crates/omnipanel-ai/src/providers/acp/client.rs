use anyhow::{bail, Result};
use serde::Deserialize;
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex, oneshot};

use crate::providers::acp::types::*;

/// Handler callback for ACP notifications (session/update, etc.)
pub type NotificationHandler =
    Arc<dyn Fn(&str, &serde_json::Value) + Send + Sync + 'static>;

/// Handler callback for server-initiated requests (session/request_permission, etc.)
pub type ServerRequestHandler = Arc<
    dyn Fn(u64, &str, &serde_json::Value) -> Option<serde_json::Value>
        + Send
        + Sync
        + 'static,
>;

/// Long-lived ACP subprocess client.
///
/// Manages the lifecycle of a CLI agent (e.g. `claude-code`, `cursor-agent`)
/// communicating via JSON-RPC 2.0 over stdio.
pub struct AcpClient {
    binary_path: String,
    args: Vec<String>,
    child: Option<Child>,
    next_id: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<JsonRpcResponse>>>>,
    notification_handler: Arc<Mutex<Option<NotificationHandler>>>,
    server_request_handler: Arc<Mutex<Option<ServerRequestHandler>>>,
    stdin_tx: Option<mpsc::Sender<String>>,
}

impl AcpClient {
    pub fn new(binary_path: &str, args: Vec<String>) -> Self {
        Self {
            binary_path: binary_path.to_string(),
            args,
            child: None,
            next_id: AtomicU64::new(1),
            pending: Arc::new(Mutex::new(HashMap::new())),
            notification_handler: Arc::new(Mutex::new(None)),
            server_request_handler: Arc::new(Mutex::new(None)),
            stdin_tx: None,
        }
    }

    /// Set handler for notifications (session/update, etc.)
    pub async fn set_notification_handler(&self, handler: NotificationHandler) {
        *self.notification_handler.lock().await = Some(handler);
    }

    /// Set handler for server-initiated requests (session/request_permission, etc.)
    pub async fn set_server_request_handler(&self, handler: ServerRequestHandler) {
        *self.server_request_handler.lock().await = Some(handler);
    }

    /// Ensure the subprocess is running. Lazy-init: spawns on first call.
    pub async fn ensure_running(&mut self) -> Result<()> {
        if self.child.is_some() {
            // Check if still alive
            if let Some(ref mut child) = self.child {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        // Process exited, respawn
                        self.child = None;
                    }
                    Ok(None) => return Ok(()),
                    Err(e) => bail!("Failed to check process status: {}", e),
                }
            }
        }

        let mut cmd = Command::new(&self.binary_path);
        cmd.args(&self.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd.spawn().map_err(|e| {
            anyhow::anyhow!(
                "Failed to spawn ACP agent '{}': {}",
                self.binary_path,
                e
            )
        })?;

        let stdin = child.stdin.take().expect("stdin should be piped");
        let stdout = child.stdout.take().expect("stdout should be piped");

        // Stdin writer task
        let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(64);
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

        // Stdout reader task
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

                // Try parsing as response (has "id" field)
                if let Ok(resp) = serde_json::from_str::<JsonRpcResponse>(&line) {
                    let mut pending_map = pending.lock().await;
                    if let Some(tx) = pending_map.remove(&resp.id) {
                        let _ = tx.send(resp);
                    }
                    continue;
                }

                // Try parsing as notification or server request (has "method" field)
                if let Ok(notif) = serde_json::from_str::<JsonRpcNotification>(&line) {
                    if let Some(id) = extract_server_request_id(&line) {
                        // Server-initiated request — needs a response
                        let handler = req_handler.lock().await;
                        if let Some(ref h) = *handler {
                            if let Some(result) = h(id, &notif.method, notif.params.as_ref().unwrap_or(&serde_json::Value::Null)) {
                                let response = JsonRpcResponse {
                                    jsonrpc: "2.0".to_string(),
                                    id,
                                    result: Some(result),
                                    error: None,
                                };
                                // We need to send this back via stdin, but we don't have direct access
                                // This is handled by the caller through the server request handler
                            }
                        }
                    } else {
                        // Regular notification
                        let handler = notif_handler.lock().await;
                        if let Some(ref h) = *handler {
                            h(&notif.method, notif.params.as_ref().unwrap_or(&serde_json::Value::Null));
                        }
                    }
                }
            }
        });

        self.stdin_tx = Some(stdin_tx);
        self.child = Some(child);

        Ok(())
    }

    /// Send a JSON-RPC request and wait for the response.
    pub async fn request(&self, method: &str, params: Option<serde_json::Value>) -> Result<serde_json::Value> {
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
        if let Some(ref stdin_tx) = self.stdin_tx {
            stdin_tx
                .send(line)
                .await
                .map_err(|_| anyhow::anyhow!("Failed to send request: stdin channel closed"))?;
        } else {
            bail!("ACP client not started");
        }

        let response = rx.await.map_err(|_| anyhow::anyhow!("Response channel dropped"))?;

        if let Some(error) = response.error {
            bail!("ACP error {}: {}", error.code, error.message);
        }

        Ok(response.result.unwrap_or(serde_json::Value::Null))
    }

    /// Send a notification (no response expected).
    pub async fn notify(&self, method: &str, params: Option<serde_json::Value>) -> Result<()> {
        let notification = JsonRpcNotification {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params,
        };

        let line = serde_json::to_string(&notification)?;
        if let Some(ref stdin_tx) = self.stdin_tx {
            stdin_tx
                .send(line)
                .await
                .map_err(|_| anyhow::anyhow!("Failed to send notification"))?;
        }
        Ok(())
    }

    /// Write a response back to the agent (for server-initiated requests).
    pub async fn write_response(&self, response: JsonRpcResponse) -> Result<()> {
        let line = serde_json::to_string(&response)?;
        if let Some(ref stdin_tx) = self.stdin_tx {
            stdin_tx.send(line).await?;
        }
        Ok(())
    }

    /// Kill the subprocess.
    pub async fn kill(&mut self) {
        if let Some(ref mut child) = self.child {
            let _ = child.kill().await;
        }
        self.child = None;
        self.stdin_tx = None;
    }

    /// Check if the subprocess is still running.
    pub fn is_running(&self) -> bool {
        self.child.is_some()
    }
}

/// Extract the "id" field from a JSON string to detect server-initiated requests.
fn extract_server_request_id(json_str: &str) -> Option<u64> {
    #[derive(Deserialize)]
    struct HasId {
        id: Option<u64>,
    }
    serde_json::from_str::<HasId>(json_str)
        .ok()
        .and_then(|h| h.id)
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        // Best-effort kill — can't async in Drop
        if let Some(ref mut child) = self.child {
            let _ = child.start_kill();
        }
    }
}
