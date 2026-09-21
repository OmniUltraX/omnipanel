use std::collections::HashMap;
use std::sync::Mutex;

use futures::StreamExt;
use tokio::sync::mpsc;

use crate::ir::{StopReason, StreamEvent};

use super::client::OpenCodeClient;
use super::service::ensure_opencode_service;

/// conversation_id → OpenCode session_id
pub struct OpenCodeSessionStore {
    inner: Mutex<HashMap<String, String>>,
}

impl Default for OpenCodeSessionStore {
    fn default() -> Self {
        Self {
            inner: Mutex::new(HashMap::new()),
        }
    }
}

impl OpenCodeSessionStore {
    pub fn get(&self, conversation_id: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()?
            .get(conversation_id)
            .cloned()
    }

    pub fn insert(&self, conversation_id: &str, session_id: String) {
        if let Ok(mut g) = self.inner.lock() {
            g.insert(conversation_id.to_string(), session_id);
        }
    }
}

static SESSIONS: std::sync::OnceLock<OpenCodeSessionStore> = std::sync::OnceLock::new();

pub fn global_session_store() -> &'static OpenCodeSessionStore {
    SESSIONS.get_or_init(OpenCodeSessionStore::default)
}

/// 跑一轮 OpenCode HTTP turn：ensure serve → session → prompt → SSE → StreamEvent。
///
/// OpenCode 自带工具循环；本路径只做文本流映射（不注入 OmniPanel client tools）。
pub async fn run_opencode_http_turn(
    binary: Option<&std::path::Path>,
    conversation_id: &str,
    cwd: &str,
    provider_id: &str,
    model_id: &str,
    prompt_text: &str,
    event_tx: mpsc::Sender<StreamEvent>,
) -> Result<(), String> {
    let endpoint = ensure_opencode_service(binary).await?;
    let client = OpenCodeClient::new(endpoint);

    let store = global_session_store();
    let session_id = match store.get(conversation_id) {
        Some(id) => id,
        None => {
            let id = client
                .create_session(cwd, Some((provider_id, model_id)))
                .await?;
            store.insert(conversation_id, id.clone());
            id
        }
    };

    // 先挂 SSE，再发 prompt，避免丢早期事件
    let resp = client.open_event_stream().await?;
    if !resp.status().is_success() {
        return Err(format!("OpenCode SSE 状态异常: {}", resp.status()));
    }

    let mut byte_stream = resp.bytes_stream();
    let (sse_tx, mut sse_rx) = mpsc::channel::<String>(64);
    let session_filter = session_id.clone();

    let reader = tokio::spawn(async move {
        let mut buf = String::new();
        while let Some(chunk) = byte_stream.next().await {
            let Ok(bytes) = chunk else { break };
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf = buf[pos + 2..].to_string();
                for line in frame.lines() {
                    let line = line.trim();
                    if let Some(data) = line.strip_prefix("data:") {
                        let payload = data.trim();
                        if payload.is_empty() || payload == "[DONE]" {
                            continue;
                        }
                        // 粗滤：只转发含本 session 或全局 server 事件
                        if payload.contains(&session_filter)
                            || payload.contains("server.connected")
                            || payload.contains("execution.")
                        {
                            if sse_tx.send(payload.to_string()).await.is_err() {
                                return;
                            }
                        }
                    }
                }
            }
        }
    });

    // 给 SSE 一点握手时间
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    if let Err(err) = client.prompt(&session_id, prompt_text).await {
        reader.abort();
        return Err(err);
    }

    let mut saw_text = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);

    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            let _ = event_tx
                .send(StreamEvent::Error {
                    message: "OpenCode 回合超时".to_string(),
                })
                .await;
            break;
        }

        let payload = match tokio::time::timeout(left, sse_rx.recv()).await {
            Ok(Some(p)) => p,
            Ok(None) => break,
            Err(_) => {
                let _ = event_tx
                    .send(StreamEvent::Error {
                        message: "OpenCode 回合超时".to_string(),
                    })
                    .await;
                break;
            }
        };

        let Ok(v) = serde_json::from_str::<serde_json::Value>(&payload) else {
            continue;
        };
        let event_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        let data = v.get("data").cloned().unwrap_or(serde_json::Value::Null);

        // 过滤其它 session
        if let Some(sid) = data.get("sessionID").and_then(|s| s.as_str()) {
            if sid != session_id {
                continue;
            }
        }

        match event_type {
            "session.text.delta" => {
                if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                    if !delta.is_empty() {
                        saw_text = true;
                        let _ = event_tx
                            .send(StreamEvent::ContentDelta {
                                text: delta.to_string(),
                            })
                            .await;
                    }
                }
            }
            "session.usage.updated" => {
                let tokens = data.get("tokens");
                let input = tokens
                    .and_then(|t| t.get("input"))
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0) as u32;
                let output = tokens
                    .and_then(|t| t.get("output"))
                    .and_then(|n| n.as_u64())
                    .unwrap_or(0) as u32;
                if input > 0 || output > 0 {
                    let _ = event_tx
                        .send(StreamEvent::Usage {
                            input_tokens: input,
                            output_tokens: output,
                        })
                        .await;
                }
            }
            "session.execution.succeeded" => {
                let _ = event_tx
                    .send(StreamEvent::Done {
                        stop_reason: StopReason::EndTurn,
                    })
                    .await;
                break;
            }
            "session.execution.failed" | "session.execution.error" => {
                let msg = data
                    .get("message")
                    .and_then(|m| m.as_str())
                    .unwrap_or("OpenCode 执行失败")
                    .to_string();
                let _ = event_tx.send(StreamEvent::Error { message: msg }).await;
                let _ = event_tx
                    .send(StreamEvent::Done {
                        stop_reason: StopReason::Error,
                    })
                    .await;
                break;
            }
            _ => {}
        }
    }

    reader.abort();
    let _ = saw_text;
    Ok(())
}
