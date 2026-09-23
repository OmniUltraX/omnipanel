use std::collections::HashMap;

use futures::StreamExt;
use tokio::sync::mpsc;

use crate::ir::{StopReason, StreamEvent, ToolStatus};

use super::client::{OpenCodeClient, OpenCodeTokenUsage};
use super::service::ensure_opencode_service;

/// OpenCode HTTP 一轮对话（标准 V2 事件契约）：
///
/// 1. 使用已有 OpenCode `session_id`（由前端/适配器管理，不再本地映射）
/// 2. `GET /api/event` 挂 SSE
/// 3. `POST /api/session/{id}/prompt` 投递（立即返回）
/// 4. 消费 SSE：
///    - 兼容旧 `{ type, data|properties }` 与 1.14+ `{ type:"sync", syncEvent:{ type:"….1", data } }`
///    - `session.next.text|reasoning.delta`（及遗留 `session.*.delta`）→ Content/ReasoningDelta
///    - `session.next.tool.*` / `message.part.updated` → ToolCall / ToolCallUpdate
///    - `session.next.step.ended` → Usage（当前上下文窗口 tokens）
///    - `session.idle` / `session.status(idle)` → Done(EndTurn)（须本轮已 active，忽略挂流回放）
///    - `session.error` / 遗留 `session.execution.*` → Error / Done
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
                        // 会话 id 过滤；交互事件（form/question/permission）即使嵌套略深也放行关键字
                        let pass = payload.contains(&session_filter)
                            || payload.contains("server.connected")
                            || payload.contains("form.created")
                            || payload.contains("form.replied")
                            || payload.contains("form.cancelled")
                            || payload.contains("question.asked")
                            || payload.contains("permission.asked");
                        if pass {
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

    // 历史会话可能把显示名（Build）写进 session.agent；执行期按 id（build）查找会失败。
    if let Err(err) = client.ensure_session_agent_id(session_id).await {
        reader.abort();
        return Err(err);
    }

    if let Err(err) = client.prompt(session_id, prompt_text).await {
        reader.abort();
        return Err(err);
    }

    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(600);
    // callID → 累积的工具入参（input.delta）
    let mut tool_args: HashMap<String, String> = HashMap::new();
    // callID → 工具名
    let mut tool_names: HashMap<String, String> = HashMap::new();
    // 轮询补工具：OpenCode 部分版本 SSE 丢 SyncEvent（message.part.updated），只剩 delta
    let mut polled_tool_fp: HashMap<String, String> = HashMap::new();
    let mut poll = tokio::time::interval(std::time::Duration::from_millis(1200));
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // 跳过立刻触发的第一拍，给 prompt 一点时间
    poll.tick().await;
    // 已有 idle session 挂 SSE 时常立刻回放 `session.idle` / `status:idle`。
    // 必须等本轮真正开始（busy / prompted / 任意 delta）后，才把 idle 当作 Done。
    let mut turn_active = false;

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

        let payload = tokio::select! {
            biased;
            msg = sse_rx.recv() => {
                match msg {
                    Some(p) => p,
                    None => {
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
                }
            }
            _ = poll.tick() => {
                // SSE 常缺 tool 的 SyncEvent：轮询会话消息补齐工具，切开推理/正文气泡
                if turn_active {
                    emit_polled_tools(
                        &client,
                        session_id,
                        &mut polled_tool_fp,
                        &mut tool_names,
                        &mut tool_args,
                        &event_tx,
                    )
                    .await;
                }
                continue;
            }
            _ = tokio::time::sleep(left) => {
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
        // OpenCode 1.14+ 常把流式增量包在 sync 信封里，且 type 带 `.1` 版本后缀。
        let (event_type_owned, data) = normalize_opencode_event(&v);
        let event_type = event_type_owned.as_str();

        if let Some(sid) = data.get("sessionID").and_then(|s| s.as_str()) {
            if sid != session_id {
                continue;
            }
        }

        if marks_turn_active(event_type, data) {
            turn_active = true;
        }

        match event_type {
            "session.next.text.delta" | "session.text.delta" => {
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
            "session.next.reasoning.delta" | "session.reasoning.delta" => {
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
            "message.part.delta" => {
                // field 多为 text；若无 part 类型信息，按正文增量处理
                let field = data.get("field").and_then(|f| f.as_str()).unwrap_or("text");
                if let Some(delta) = data.get("delta").and_then(|d| d.as_str()) {
                    if !delta.is_empty() {
                        if field == "reasoning" || field == "reasoning_content" {
                            let _ = event_tx
                                .send(StreamEvent::ReasoningDelta {
                                    text: delta.to_string(),
                                })
                                .await;
                        } else {
                            let _ = event_tx
                                .send(StreamEvent::ContentDelta {
                                    text: delta.to_string(),
                                })
                                .await;
                        }
                    }
                }
            }
            "session.next.tool.input.started" => {
                let call_id = data
                    .get("callID")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = data
                    .get("name")
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                if !call_id.is_empty() {
                    tool_names.insert(call_id.clone(), name.clone());
                    tool_args.insert(call_id.clone(), String::new());
                    polled_tool_fp.insert(
                        call_id.clone(),
                        tool_fingerprint("running", "", None),
                    );
                    let _ = event_tx
                        .send(StreamEvent::ToolCall {
                            id: call_id.clone(),
                            name,
                            arguments: String::new(),
                        })
                        .await;
                    let _ = event_tx
                        .send(StreamEvent::ToolCallUpdate {
                            id: call_id,
                            status: ToolStatus::Running,
                            result: None,
                        })
                        .await;
                }
            }
            "session.next.tool.input.delta" => {
                let call_id = data
                    .get("callID")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let delta = data.get("delta").and_then(|d| d.as_str()).unwrap_or("");
                if !call_id.is_empty() && !delta.is_empty() {
                    tool_args.entry(call_id.clone()).or_default().push_str(delta);
                    let args = tool_args.get(&call_id).cloned().unwrap_or_default();
                    let name = tool_names
                        .get(&call_id)
                        .cloned()
                        .unwrap_or_else(|| "tool".to_string());
                    let _ = event_tx
                        .send(StreamEvent::ToolCall {
                            id: call_id,
                            name,
                            arguments: args,
                        })
                        .await;
                }
            }
            "session.next.tool.input.ended" => {
                let call_id = data
                    .get("callID")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let text = data
                    .get("text")
                    .and_then(|t| t.as_str())
                    .map(str::to_string)
                    .unwrap_or_default();
                if !call_id.is_empty() {
                    if !text.is_empty() {
                        tool_args.insert(call_id.clone(), text.clone());
                    }
                    let name = tool_names
                        .get(&call_id)
                        .cloned()
                        .unwrap_or_else(|| "tool".to_string());
                    let args = tool_args.get(&call_id).cloned().unwrap_or(text);
                    let _ = event_tx
                        .send(StreamEvent::ToolCall {
                            id: call_id,
                            name,
                            arguments: args,
                        })
                        .await;
                }
            }
            "session.next.tool.called" => {
                let call_id = data
                    .get("callID")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                let name = data
                    .get("tool")
                    .or_else(|| data.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("tool")
                    .to_string();
                let args = data
                    .get("input")
                    .map(|input| {
                        if input.is_string() {
                            input.as_str().unwrap_or("{}").to_string()
                        } else {
                            serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
                        }
                    })
                    .unwrap_or_else(|| {
                        tool_args
                            .get(&call_id)
                            .cloned()
                            .unwrap_or_else(|| "{}".to_string())
                    });
                if !call_id.is_empty() {
                    tool_names.insert(call_id.clone(), name.clone());
                    tool_args.insert(call_id.clone(), args.clone());
                    let _ = event_tx
                        .send(StreamEvent::ToolCall {
                            id: call_id.clone(),
                            name,
                            arguments: args,
                        })
                        .await;
                    let _ = event_tx
                        .send(StreamEvent::ToolCallUpdate {
                            id: call_id,
                            status: ToolStatus::Running,
                            result: None,
                        })
                        .await;
                }
            }
            "session.next.tool.progress" => {
                let call_id = data
                    .get("callID")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                if !call_id.is_empty() {
                    let result = format_llm_tool_content(data.get("content"));
                    let _ = event_tx
                        .send(StreamEvent::ToolCallUpdate {
                            id: call_id,
                            status: ToolStatus::Running,
                            result,
                        })
                        .await;
                }
            }
            "session.next.tool.success" => {
                let call_id = data
                    .get("callID")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                if !call_id.is_empty() {
                    let result = format_llm_tool_content(data.get("content")).or_else(|| {
                        data.get("result")
                            .map(|r| {
                                if r.is_string() {
                                    r.as_str().unwrap_or("").to_string()
                                } else {
                                    serde_json::to_string(r).unwrap_or_default()
                                }
                            })
                            .filter(|s| !s.is_empty())
                    });
                    let _ = event_tx
                        .send(StreamEvent::ToolCallUpdate {
                            id: call_id,
                            status: ToolStatus::Completed,
                            result,
                        })
                        .await;
                }
            }
            "session.next.tool.failed" => {
                let call_id = data
                    .get("callID")
                    .and_then(|c| c.as_str())
                    .unwrap_or("")
                    .to_string();
                if !call_id.is_empty() {
                    let result = data
                        .get("error")
                        .and_then(|e| {
                            e.get("message")
                                .and_then(|m| m.as_str())
                                .or_else(|| e.as_str())
                        })
                        .map(str::to_string)
                        .or_else(|| {
                            data.get("result").map(|r| {
                                if r.is_string() {
                                    r.as_str().unwrap_or("").to_string()
                                } else {
                                    serde_json::to_string(r).unwrap_or_default()
                                }
                            })
                        });
                    let _ = event_tx
                        .send(StreamEvent::ToolCallUpdate {
                            id: call_id,
                            status: ToolStatus::Failed,
                            result,
                        })
                        .await;
                }
            }
            "message.part.updated" => {
                if let Some(part) = data.get("part") {
                    emit_from_message_part(&event_tx, part).await;
                }
            }
            // 每步结束携带该 assistant 消息的 tokens —— 上下文用量事实源（非 session 累计）
            "session.next.step.ended" | "session.step.ended" => {
                if let Some(usage) = parse_step_token_usage(data.get("tokens")) {
                    let _ = event_tx
                        .send(StreamEvent::Usage {
                            input_tokens: usage.input,
                            output_tokens: usage.output,
                            reasoning_tokens: usage.reasoning,
                            cached_input_tokens: usage.cache_read,
                            cache_write_tokens: usage.cache_write,
                            total_tokens: Some(usage.context_total()),
                        })
                        .await;
                }
            }
            // session.usage.updated 是会话累计值，不反映当前上下文窗口，忽略
            "session.usage.updated" => {}
            // OpenCode 向用户提问（旧 question API）；回合挂起直到 reply/reject
            "question.asked" | "question.v2.asked" => {
                if let Some(evt) = parse_question_ask(data) {
                    let _ = event_tx.send(evt).await;
                }
            }
            // OpenCode V2 Form（当前 serve 已无 /question，澄清走 form.created）
            "form.created" | "form.asked" => {
                if let Some(evt) = parse_form_ask(data) {
                    let _ = event_tx.send(evt).await;
                }
            }
            // 工具权限确认；不回复则整轮永久挂起
            "permission.asked" | "permission.v2.asked" => {
                if let Some(evt) = parse_permission_ask(data) {
                    let _ = event_tx.send(evt).await;
                }
            }
            "session.idle" => {
                // 忽略挂流时回放的「已 idle」快照，避免已有会话第二轮立刻 Done。
                if !turn_active {
                    continue;
                }
                // 收尾再扫一次工具，避免最后一次 SyncEvent 丢失
                emit_polled_tools(
                    &client,
                    session_id,
                    &mut polled_tool_fp,
                    &mut tool_names,
                    &mut tool_args,
                    &event_tx,
                )
                .await;
                let _ = event_tx
                    .send(StreamEvent::Done {
                        stop_reason: StopReason::EndTurn,
                    })
                    .await;
                break;
            }
            "session.status" => {
                let status_ty = data
                    .get("status")
                    .and_then(|s| s.get("type"))
                    .and_then(|t| t.as_str())
                    .unwrap_or("");
                if status_ty == "idle" {
                    if !turn_active {
                        continue;
                    }
                    emit_polled_tools(
                        &client,
                        session_id,
                        &mut polled_tool_fp,
                        &mut tool_names,
                        &mut tool_args,
                        &event_tx,
                    )
                    .await;
                    let _ = event_tx
                        .send(StreamEvent::Done {
                            stop_reason: StopReason::EndTurn,
                        })
                        .await;
                    break;
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
            "session.error" | "session.execution.failed" | "session.execution.error" => {
                let msg = data
                    .get("message")
                    .and_then(|m| m.as_str())
                    .or_else(|| {
                        data.get("error")
                            .and_then(|e| e.get("message").and_then(|m| m.as_str()))
                    })
                    .or_else(|| data.get("error").and_then(|e| e.as_str()))
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

/// 归一化 OpenCode SSE 帧，兼容三种形态：
/// 1. `{ type: "session.next.text.delta", data|properties }`
/// 2. `{ type: "sync", syncEvent: { type: "….delta.1", data } }`（serve 1.15+）
/// 3. `{ type: "sync", name: "….delta.1", data }`
fn normalize_opencode_event<'a>(v: &'a serde_json::Value) -> (String, &'a serde_json::Value) {
    let top_type = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
    if top_type == "sync" {
        if let Some(inner) = v.get("syncEvent") {
            let raw = inner
                .get("type")
                .or_else(|| inner.get("name"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            let ty = strip_event_version_suffix(raw);
            let data = event_body(inner);
            if !data.is_null() {
                return (ty, data);
            }
            return (ty, event_body(v));
        }
        let raw = v
            .get("name")
            .and_then(|t| t.as_str())
            .unwrap_or(top_type);
        return (strip_event_version_suffix(raw), event_body(v));
    }
    (
        strip_event_version_suffix(top_type),
        event_body(v),
    )
}

/// `session.next.text.delta.1` / `session.next.step.ended.2` → 去掉末尾数字版本后缀。
fn strip_event_version_suffix(raw: &str) -> String {
    if let Some(dot) = raw.rfind('.') {
        let suffix = &raw[dot + 1..];
        if !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()) {
            return raw[..dot].to_string();
        }
    }
    raw.to_string()
}

/// 运行态事件体在 `data`；部分类型定义写 `properties`——两者都认。
fn event_body(v: &serde_json::Value) -> &serde_json::Value {
    v.get("data")
        .or_else(|| v.get("properties"))
        .unwrap_or(&serde_json::Value::Null)
}

/// OpenCode 部分版本 SSE 丢 SyncEvent：轮询会话消息把工具补进流，便于前端切开气泡。
async fn emit_polled_tools(
    client: &OpenCodeClient,
    session_id: &str,
    seen: &mut HashMap<String, String>,
    tool_names: &mut HashMap<String, String>,
    tool_args: &mut HashMap<String, String>,
    event_tx: &mpsc::Sender<StreamEvent>,
) {
    let Ok(msgs) = client.get_session_messages(session_id).await else {
        return;
    };
    // 取最后一条 user 之后的全部 assistant（OpenCode 多步常拆成多条）
    let mut start = 0usize;
    for (i, m) in msgs.iter().enumerate() {
        if m.role == "user" {
            start = i + 1;
        }
    }
    for m in msgs.iter().skip(start) {
        if m.role != "assistant" {
            continue;
        }
        let Some(tools) = m.tool_calls.as_ref() else {
            continue;
        };
        for t in tools {
            let fp = tool_fingerprint(&t.status, &t.arguments, t.result.as_deref());
            if seen.get(&t.id) == Some(&fp) {
                continue;
            }
            seen.insert(t.id.clone(), fp);
            tool_names.insert(t.id.clone(), t.name.clone());
            tool_args.insert(t.id.clone(), t.arguments.clone());
            let _ = event_tx
                .send(StreamEvent::ToolCall {
                    id: t.id.clone(),
                    name: t.name.clone(),
                    arguments: t.arguments.clone(),
                })
                .await;
            let status = match t.status.as_str() {
                "pending" => ToolStatus::Pending,
                "completed" => ToolStatus::Completed,
                "failed" | "error" => ToolStatus::Failed,
                _ => ToolStatus::Running,
            };
            let _ = event_tx
                .send(StreamEvent::ToolCallUpdate {
                    id: t.id.clone(),
                    status,
                    result: t.result.clone(),
                })
                .await;
        }
    }
}

fn tool_fingerprint(status: &str, arguments: &str, result: Option<&str>) -> String {
    format!(
        "{status}|{}|{}",
        arguments.len(),
        result.map(|r| r.len()).unwrap_or(0)
    )
}

/// 本轮已真正开工的信号（用于忽略挂 SSE 时回放的 idle 快照）。
fn marks_turn_active(event_type: &str, data: &serde_json::Value) -> bool {
    match event_type {
        "session.next.prompted"
        | "session.next.prompt.admitted"
        | "session.next.text.delta"
        | "session.next.text.started"
        | "session.next.reasoning.delta"
        | "session.next.reasoning.started"
        | "session.next.tool.input.started"
        | "session.next.tool.called"
        | "session.next.step.started"
        | "session.text.delta"
        | "session.reasoning.delta"
        | "message.part.delta"
        | "question.asked"
        | "question.v2.asked"
        | "form.created"
        | "form.asked"
        | "permission.asked"
        | "permission.v2.asked" => true,
        "session.status" => matches!(
            data.get("status")
                .and_then(|s| s.get("type"))
                .and_then(|t| t.as_str()),
            Some("busy") | Some("retry")
        ),
        "message.part.updated" => data
            .get("part")
            .and_then(|p| p.get("type"))
            .and_then(|t| t.as_str())
            .is_some_and(|t| matches!(t, "text" | "reasoning" | "tool" | "subtask")),
        _ => false,
    }
}

fn format_llm_tool_content(content: Option<&serde_json::Value>) -> Option<String> {
    let Some(arr) = content.and_then(|c| c.as_array()) else {
        return content.and_then(|c| c.as_str()).map(str::to_string);
    };
    let text = arr
        .iter()
        .filter_map(|item| {
            if item.get("type").and_then(|t| t.as_str()) == Some("text") {
                item.get("text").and_then(|t| t.as_str())
            } else {
                item.as_str()
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

fn parse_step_token_usage(raw: Option<&serde_json::Value>) -> Option<OpenCodeTokenUsage> {
    let tokens = raw?;
    if !tokens.is_object() {
        return None;
    }
    let num = |key: &str| -> u32 {
        tokens
            .get(key)
            .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
            .unwrap_or(0) as u32
    };
    let cache = tokens.get("cache");
    let cache_read = cache
        .and_then(|c| c.get("read"))
        .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
        .unwrap_or(0) as u32;
    let cache_write = cache
        .and_then(|c| c.get("write"))
        .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
        .unwrap_or(0) as u32;
    let total = tokens
        .get("total")
        .and_then(|n| n.as_u64().or_else(|| n.as_f64().map(|f| f as u64)))
        .map(|n| n as u32)
        .filter(|&n| n > 0);
    let usage = OpenCodeTokenUsage {
        input: num("input"),
        output: num("output"),
        reasoning: num("reasoning"),
        cache_read,
        cache_write,
        total,
    };
    if usage.is_empty() {
        None
    } else {
        Some(usage)
    }
}

async fn emit_from_message_part(event_tx: &mpsc::Sender<StreamEvent>, part: &serde_json::Value) {
    let Some(ty) = part.get("type").and_then(|t| t.as_str()) else {
        return;
    };
    match ty {
        "text" => {
            if let Some(text) = part.get("text").and_then(|t| t.as_str()) {
                if !text.is_empty() {
                    // part.updated 常为全量快照；仅在流式缺口时作兜底，避免重复刷全文。
                    // 此处不发 ContentDelta（由 session.next.text.delta 负责）。
                    let _ = text;
                }
            }
        }
        "tool" => {
            let id = part
                .get("id")
                .or_else(|| part.get("callID"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                return;
            }
            let name = part
                .get("name")
                .or_else(|| part.get("tool"))
                .and_then(|v| v.as_str())
                .unwrap_or("tool")
                .to_string();
            let state = part.get("state");
            let args = state
                .and_then(|s| s.get("input"))
                .map(|input| {
                    if input.is_string() {
                        input.as_str().unwrap_or("{}").to_string()
                    } else {
                        serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
                    }
                })
                .unwrap_or_else(|| "{}".to_string());
            let _ = event_tx
                .send(StreamEvent::ToolCall {
                    id: id.clone(),
                    name,
                    arguments: args,
                })
                .await;
            let status_raw = state
                .and_then(|s| s.get("status"))
                .and_then(|s| s.as_str())
                .unwrap_or("running");
            let (status, result) = match status_raw {
                "pending" => (ToolStatus::Pending, None),
                "running" => (
                    ToolStatus::Running,
                    state.and_then(extract_tool_result_from_state),
                ),
                "completed" => (
                    ToolStatus::Completed,
                    state.and_then(extract_tool_result_from_state),
                ),
                "error" => (
                    ToolStatus::Failed,
                    state.and_then(extract_tool_result_from_state),
                ),
                _ => (ToolStatus::Running, None),
            };
            let _ = event_tx
                .send(StreamEvent::ToolCallUpdate {
                    id,
                    status,
                    result,
                })
                .await;
        }
        "subtask" => {
            let id = part
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            if id.is_empty() {
                return;
            }
            let agent = part
                .get("agent")
                .and_then(|v| v.as_str())
                .unwrap_or("subagent");
            let description = part
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let prompt = part.get("prompt").and_then(|v| v.as_str()).unwrap_or("");
            let args = serde_json::json!({
                "agent": agent,
                "description": description,
                "prompt": prompt,
            })
            .to_string();
            let _ = event_tx
                .send(StreamEvent::ToolCall {
                    id: id.clone(),
                    name: format!("subtask:{agent}"),
                    arguments: args,
                })
                .await;
            let _ = event_tx
                .send(StreamEvent::ToolCallUpdate {
                    id,
                    status: ToolStatus::Completed,
                    result: if description.is_empty() {
                        None
                    } else {
                        Some(description.to_string())
                    },
                })
                .await;
        }
        _ => {}
    }
}

/// 解析 OpenCode `question.asked` → `StreamEvent::QuestionAsk`。
fn parse_question_ask(data: &serde_json::Value) -> Option<StreamEvent> {
    let request_id = data
        .get("id")
        .or_else(|| data.get("requestID"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let session_id = data
        .get("sessionID")
        .or_else(|| data.get("sessionId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let questions = data.get("questions").cloned().unwrap_or(serde_json::json!([]));
    if !questions.is_array() || questions.as_array().is_some_and(|a| a.is_empty()) {
        return None;
    }
    let questions_json = serde_json::to_string(&questions).ok()?;
    Some(StreamEvent::QuestionAsk {
        request_id,
        session_id,
        questions_json,
        kind: "question".into(),
        title: None,
    })
}

/// 解析 OpenCode `form.created` → `StreamEvent::QuestionAsk`（kind=form）。
/// Form.Field → 前端 AskUserQuestion 兼容 JSON。
fn parse_form_ask(data: &serde_json::Value) -> Option<StreamEvent> {
    let request_id = data
        .get("id")
        .or_else(|| data.get("formID"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let session_id = data
        .get("sessionID")
        .or_else(|| data.get("sessionId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let title = data
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let fields = data.get("fields").and_then(|v| v.as_array())?;
    if fields.is_empty() {
        return None;
    }
    let mut questions = Vec::new();
    for field in fields {
        if field.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false) {
            continue;
        }
        let key = field
            .get("key")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("")
            .to_string();
        if key.is_empty() {
            continue;
        }
        let field_ty = field
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("string");
        // external 字段无本地答案，跳过（用户无法在表单里填）
        if field_ty == "external" {
            continue;
        }
        let prompt = field
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .or_else(|| {
                field
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            })
            .unwrap_or(key.as_str())
            .to_string();
        let header = field
            .get("title")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(key.as_str())
            .to_string();
        let custom = field.get("custom").and_then(|v| v.as_bool()).unwrap_or(true);
        let multiple = field_ty == "multiselect";

        let mut options = Vec::new();
        if field_ty == "boolean" {
            options.push(serde_json::json!({
                "label": "是",
                "description": "true",
                "value": "true"
            }));
            options.push(serde_json::json!({
                "label": "否",
                "description": "false",
                "value": "false"
            }));
        } else if let Some(arr) = field.get("options").and_then(|v| v.as_array()) {
            for o in arr {
                let label = o
                    .get("label")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        o.get("value")
                            .and_then(|v| v.as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                    })
                    .unwrap_or("")
                    .to_string();
                if label.is_empty() {
                    continue;
                }
                let value = o
                    .get("value")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or(label.as_str())
                    .to_string();
                let description = o
                    .get("description")
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("")
                    .to_string();
                options.push(serde_json::json!({
                    "label": label,
                    "description": description,
                    "value": value
                }));
            }
        }

        questions.push(serde_json::json!({
            "question": prompt,
            "header": header,
            "options": options,
            "multiple": multiple,
            "custom": custom,
            "key": key,
            "fieldType": field_ty,
        }));
    }
    if questions.is_empty() {
        return None;
    }
    let questions_json = serde_json::to_string(&questions).ok()?;
    Some(StreamEvent::QuestionAsk {
        request_id,
        session_id,
        questions_json,
        kind: "form".into(),
        title,
    })
}

/// 解析 OpenCode `permission.asked` → `StreamEvent::OpenCodePermissionAsk`。
fn parse_permission_ask(data: &serde_json::Value) -> Option<StreamEvent> {
    let request_id = data
        .get("id")
        .or_else(|| data.get("requestID"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let session_id = data
        .get("sessionID")
        .or_else(|| data.get("sessionId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    // 新 API：action + resources；旧：permission + patterns
    let action = data
        .get("action")
        .or_else(|| data.get("permission"))
        .and_then(|v| v.as_str())
        .unwrap_or("tool")
        .to_string();
    let resources = data
        .get("resources")
        .or_else(|| data.get("patterns"))
        .cloned()
        .unwrap_or(serde_json::json!([]));
    let message = data
        .get("message")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let title = message
        .clone()
        .unwrap_or_else(|| format!("权限确认：{action}"));
    let raw_input = serde_json::json!({
        "action": action,
        "resources": resources,
        "message": message,
        "metadata": data.get("metadata").cloned().unwrap_or(serde_json::Value::Null),
        "source": data.get("source").cloned().unwrap_or(serde_json::Value::Null),
    })
    .to_string();
    Some(StreamEvent::OpenCodePermissionAsk {
        request_id,
        session_id,
        title,
        raw_input,
    })
}

fn extract_tool_result_from_state(state: &serde_json::Value) -> Option<String> {
    if let Some(out) = state.get("output").and_then(|v| v.as_str()) {
        if !out.is_empty() {
            return Some(out.to_string());
        }
    }
    if let Some(err) = state.get("error").and_then(|v| v.as_str()) {
        if !err.is_empty() {
            return Some(err.to_string());
        }
    }
    format_llm_tool_content(state.get("content"))
}

#[cfg(test)]
mod turn_active_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn idle_does_not_mark_active() {
        assert!(!marks_turn_active("session.idle", &json!({ "sessionID": "ses_1" })));
        assert!(!marks_turn_active(
            "session.status",
            &json!({ "sessionID": "ses_1", "status": { "type": "idle" } })
        ));
    }

    #[test]
    fn busy_and_prompted_mark_active() {
        assert!(marks_turn_active(
            "session.status",
            &json!({ "status": { "type": "busy" } })
        ));
        assert!(marks_turn_active(
            "session.next.prompt.admitted",
            &json!({ "sessionID": "ses_1" })
        ));
        assert!(marks_turn_active(
            "session.next.text.delta",
            &json!({ "delta": "hi" })
        ));
    }

    #[test]
    fn strip_version_suffix_from_sync_types() {
        assert_eq!(
            strip_event_version_suffix("session.next.text.delta.1"),
            "session.next.text.delta"
        );
        assert_eq!(
            strip_event_version_suffix("session.next.step.ended.2"),
            "session.next.step.ended"
        );
        assert_eq!(
            strip_event_version_suffix("session.next.tool.called"),
            "session.next.tool.called"
        );
    }

    #[test]
    fn normalize_legacy_event() {
        let v = json!({
            "type": "session.next.text.delta",
            "data": { "sessionID": "ses_1", "delta": "hi" }
        });
        let (ty, data) = normalize_opencode_event(&v);
        assert_eq!(ty, "session.next.text.delta");
        assert_eq!(data.get("delta").and_then(|d| d.as_str()), Some("hi"));
    }

    #[test]
    fn normalize_sync_event_envelope() {
        let v = json!({
            "type": "sync",
            "id": "evt_1",
            "syncEvent": {
                "type": "session.next.text.delta.1",
                "id": "inner",
                "seq": 3,
                "aggregateID": "ses_abc",
                "data": {
                    "timestamp": 1,
                    "sessionID": "ses_abc",
                    "assistantMessageID": "msg_1",
                    "textID": "txt_1",
                    "delta": "你好"
                }
            }
        });
        let (ty, data) = normalize_opencode_event(&v);
        assert_eq!(ty, "session.next.text.delta");
        assert_eq!(data.get("delta").and_then(|d| d.as_str()), Some("你好"));
        assert_eq!(data.get("sessionID").and_then(|s| s.as_str()), Some("ses_abc"));
    }

    #[test]
    fn normalize_sync_name_shape() {
        let v = json!({
            "type": "sync",
            "name": "session.next.tool.called.1",
            "data": {
                "sessionID": "ses_1",
                "callID": "call_1",
                "tool": "bash"
            }
        });
        let (ty, data) = normalize_opencode_event(&v);
        assert_eq!(ty, "session.next.tool.called");
        assert_eq!(data.get("callID").and_then(|c| c.as_str()), Some("call_1"));
    }

    #[test]
    fn parse_question_ask_from_request() {
        let data = json!({
            "id": "qst_1",
            "sessionID": "ses_abc",
            "questions": [{
                "question": "Nacos 部署在哪？",
                "header": "部署位置",
                "options": [
                    { "label": "本机", "description": "localhost" },
                    { "label": "远程", "description": "p6 服务器" }
                ],
                "multiple": false,
                "custom": true
            }]
        });
        let evt = parse_question_ask(&data).expect("should parse");
        match evt {
            StreamEvent::QuestionAsk {
                request_id,
                session_id,
                questions_json,
                kind,
                title,
            } => {
                assert_eq!(request_id, "qst_1");
                assert_eq!(session_id, "ses_abc");
                assert_eq!(kind, "question");
                assert!(title.is_none());
                assert!(questions_json.contains("Nacos"));
            }
            other => panic!("expected QuestionAsk, got {other:?}"),
        }
        assert!(marks_turn_active("question.asked", &data));
    }

    #[test]
    fn parse_form_ask_from_fields() {
        let data = json!({
            "id": "frm_1",
            "sessionID": "ses_abc",
            "title": "确认 Nacos 位置",
            "fields": [{
                "key": "where",
                "type": "string",
                "title": "Nacos 部署在哪？",
                "options": [
                    { "value": "local", "label": "本机", "description": "localhost" },
                    { "value": "p6", "label": "远程", "description": "p6 服务器" }
                ],
                "custom": true
            }]
        });
        let evt = parse_form_ask(&data).expect("should parse");
        match evt {
            StreamEvent::QuestionAsk {
                request_id,
                session_id,
                questions_json,
                kind,
                title,
            } => {
                assert_eq!(request_id, "frm_1");
                assert_eq!(session_id, "ses_abc");
                assert_eq!(kind, "form");
                assert_eq!(title.as_deref(), Some("确认 Nacos 位置"));
                assert!(questions_json.contains("where"));
                assert!(questions_json.contains("本机"));
            }
            other => panic!("expected QuestionAsk form, got {other:?}"),
        }
        assert!(marks_turn_active("form.created", &data));
    }

    #[test]
    fn parse_permission_ask_from_request() {
        let data = json!({
            "id": "per_1",
            "sessionID": "ses_abc",
            "action": "bash",
            "resources": ["*"],
            "message": "允许执行 bash？"
        });
        let evt = parse_permission_ask(&data).expect("should parse");
        match evt {
            StreamEvent::OpenCodePermissionAsk {
                request_id,
                session_id,
                title,
                raw_input,
            } => {
                assert_eq!(request_id, "per_1");
                assert_eq!(session_id, "ses_abc");
                assert!(title.contains("bash") || title.contains("允许"));
                assert!(raw_input.contains("bash"));
            }
            other => panic!("expected OpenCodePermissionAsk, got {other:?}"),
        }
        assert!(marks_turn_active("permission.asked", &data));
    }
}
