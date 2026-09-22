use futures::StreamExt;
use tokio::sync::mpsc;

use crate::ir::{StopReason, StreamEvent};

use super::client::OpenCodeClient;
use super::service::ensure_opencode_service;

/// OpenCode HTTP 一轮对话（标准 V2 事件契约）：
///
/// 1. 使用已有 OpenCode `session_id`（由前端/适配器管理，不再本地映射）
/// 2. `GET /api/event` 挂 SSE
/// 3. `POST /api/session/{id}/prompt` 投递（立即返回）
/// 4. 消费 SSE：
///    - `session.text.delta` → ContentDelta
///    - `session.reasoning.delta` → ReasoningDelta
///    - `session.usage.updated` → Usage
///    - `session.execution.succeeded` → Done(EndTurn)
///    - `session.execution.failed` / `session.execution.error` → Error + Done(Error)
pub async fn run_opencode_http_turn(
    binary: Option<&std::path::Path>,
    session_id: &str,
    prompt_text: &str,
    event_tx: mpsc::Sender<StreamEvent>,
) -> Result<(), String> {
    if session_id.trim().is_empty() {
        return Err("OpenCode session_id 为空".to_string());
    }

    let endpoint = ensure_opencode_service(binary).await?;
    let client = OpenCodeClient::new(endpoint);

    let resp = client.open_event_stream().await?;
    if !resp.status().is_success() {
        return Err(format!("OpenCode SSE 状态异常: {}", resp.status()));
    }

    let mut byte_stream = resp.bytes_stream();
    let (sse_tx, mut sse_rx) = mpsc::channel::<String>(256);
    let session_filter = session_id.to_string();

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
                        if payload.contains(&session_filter) || payload.contains("server.connected")
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

    tokio::time::sleep(std::time::Duration::from_millis(150)).await;

    if let Err(err) = client.prompt(session_id, prompt_text).await {
        reader.abort();
        return Err(err);
    }

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);

    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            let _ = event_tx
                .send(StreamEvent::Error {
                    message: "OpenCode 回合超时".to_string(),
                })
                .await;
            let _ = event_tx
                .send(StreamEvent::Done {
                    stop_reason: StopReason::Error,
                })
                .await;
            break;
        }

        let payload = match tokio::time::timeout(left, sse_rx.recv()).await {
            Ok(Some(p)) => p,
            Ok(None) => {
                let _ = event_tx
                    .send(StreamEvent::Error {
                        message: "OpenCode SSE 已断开".to_string(),
                    })
                    .await;
                let _ = event_tx
                    .send(StreamEvent::Done {
                        stop_reason: StopReason::Error,
                    })
                    .await;
                break;
            }
            Err(_) => {
                let _ = event_tx
                    .send(StreamEvent::Error {
                        message: "OpenCode 回合超时".to_string(),
                    })
                    .await;
                let _ = event_tx
                    .send(StreamEvent::Done {
                        stop_reason: StopReason::Error,
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

        if let Some(sid) = data.get("sessionID").and_then(|s| s.as_str()) {
            if sid != session_id {
                continue;
            }
        }

        match event_type {
            "session.text.delta" => {
                if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                    if !delta.is_empty() {
                        let _ = event_tx
                            .send(StreamEvent::ContentDelta {
                                text: delta.to_string(),
                            })
                            .await;
                    }
                }
            }
            "session.reasoning.delta" => {
                if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                    if !delta.is_empty() {
                        let _ = event_tx
                            .send(StreamEvent::ReasoningDelta {
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
    Ok(())
}
