//! OpenCode Go 网关多协议对话（Responses / Anthropic Messages）。

use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use anyhow::{Result, bail};
use futures::{Stream, StreamExt};
use reqwest::Client;
use reqwest::header::HeaderMap;
use serde_json::{Value, json};

use omnipanel_ai::ir::{StopReason, StreamEvent};
use omnipanel_ai::types::{ChatRequest, Role, ToolDef};

use crate::model_metadata::WireApi;

pub fn resolve_wire_api(model_id: &str, wire_apis: &HashMap<String, WireApi>) -> WireApi {
    wire_apis
        .get(model_id)
        .copied()
        .unwrap_or(WireApi::OpenAiCompletions)
}

fn messages_to_responses_body(model_id: &str, request: &ChatRequest) -> Value {
    let mut instructions: Option<String> = None;
    let mut input = Vec::new();
    for msg in &request.messages {
        match msg.role {
            Role::System => instructions = Some(msg.content.clone()),
            Role::User => {
                input.push(json!({
                    "role": "user",
                    "content": [{"type": "input_text", "text": msg.content}]
                }));
            }
            Role::Assistant => {
                if !msg.content.is_empty() {
                    input.push(json!({
                        "role": "assistant",
                        "content": [{"type": "output_text", "text": msg.content}]
                    }));
                }
                if let Some(calls) = &msg.tool_calls {
                    for call in calls {
                        input.push(json!({
                            "type": "function_call",
                            "call_id": call.id,
                            "name": call.function.name,
                            "arguments": call.function.arguments,
                        }));
                    }
                }
            }
            Role::Tool => {
                let call_id = msg.tool_call_id.clone().unwrap_or_default();
                if call_id.is_empty() {
                    continue;
                }
                input.push(json!({
                    "type": "function_call_output",
                    "call_id": call_id,
                    "output": msg.content,
                }));
            }
        }
    }
    let mut body = json!({
        "model": model_id,
        "input": input,
        "stream": true,
    });
    if let Some(inst) = instructions {
        body["instructions"] = json!(inst);
    }
    if let Some(tools) = &request.tools {
        let converted = convert_tools_for_responses(tools);
        if !converted.is_empty() {
            body["tools"] = Value::Array(converted);
        }
    }
    body
}

/// OpenAI Responses API：`name` / `description` / `parameters` 在顶层，不能沿用 Chat Completions 的 `function` 嵌套。
fn convert_tools_for_responses(tools: &[ToolDef]) -> Vec<Value> {
    tools
        .iter()
        .filter(|t| !t.function.name.trim().is_empty())
        .map(|t| {
            json!({
                "type": "function",
                "name": t.function.name,
                "description": t.function.description,
                "parameters": t.function.parameters,
            })
        })
        .collect()
}

struct ResponsesSseParser {
    /// 当前 function_call 是否已经吃过 arguments delta，避免 done 再拼一遍。
    saw_arg_delta: bool,
}

impl ResponsesSseParser {
    fn new() -> Self {
        Self {
            saw_arg_delta: false,
        }
    }

    fn push_tool(
        &self,
        id: &str,
        name: &str,
        arguments: &str,
        events: &mut Vec<Result<StreamEvent>>,
    ) {
        if name.is_empty() && arguments.is_empty() {
            return;
        }
        events.push(Ok(StreamEvent::ToolCall {
            id: id.to_string(),
            name: name.to_string(),
            arguments: arguments.to_string(),
        }));
    }
}

impl ResponsesSseParser {
    fn parse_line(&mut self, line: &str, events: &mut Vec<Result<StreamEvent>>) {
        if line.is_empty() {
            return;
        }
        let data = match line.strip_prefix("data:") {
            Some(rest) => rest.trim(),
            None if line.starts_with('{') => line,
            _ => return,
        };
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let evt: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return,
        };
        let event_type = evt.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "response.output_text.delta" => {
                if let Some(delta) = evt.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        events.push(Ok(StreamEvent::ContentDelta {
                            text: delta.to_string(),
                        }));
                    }
                }
            }
            "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                if let Some(delta) = evt.get("delta").and_then(Value::as_str) {
                    if !delta.is_empty() {
                        events.push(Ok(StreamEvent::ReasoningDelta {
                            text: delta.to_string(),
                        }));
                    }
                }
            }
            "response.completed" => {
                if let Some(usage) = evt.get("response").and_then(|r| r.get("usage")) {
                    let input = usage
                        .get("input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u32;
                    let output = usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0) as u32;
                    events.push(Ok(StreamEvent::Usage {
                        input_tokens: input,
                        output_tokens: output,
                    }));
                }
                events.push(Ok(StreamEvent::Done {
                    stop_reason: StopReason::EndTurn,
                }));
            }
            "error" => {
                let msg = evt
                    .get("message")
                    .or_else(|| evt.get("error").and_then(|e| e.get("message")))
                    .and_then(Value::as_str)
                    .unwrap_or("Responses 流错误");
                events.push(Ok(StreamEvent::Error {
                    message: msg.to_string(),
                }));
            }
            "response.output_item.added" => {
                let Some(item) = evt.get("item") else {
                    return;
                };
                if item.get("type").and_then(Value::as_str) != Some("function_call") {
                    return;
                }
                let name = item.get("name").and_then(Value::as_str).unwrap_or("");
                let id = item
                    .get("call_id")
                    .and_then(Value::as_str)
                    .or_else(|| item.get("id").and_then(Value::as_str))
                    .unwrap_or("");
                self.saw_arg_delta = false;
                self.push_tool(id, name, "", events);
            }
            "response.function_call_arguments.delta" => {
                let delta = evt.get("delta").and_then(Value::as_str).unwrap_or("");
                if delta.is_empty() {
                    return;
                }
                self.saw_arg_delta = true;
                self.push_tool("", "", delta, events);
            }
            "response.function_call_arguments.done" => {
                if self.saw_arg_delta {
                    return;
                }
                let arguments = evt.get("arguments").and_then(Value::as_str).unwrap_or("");
                if arguments.is_empty() {
                    return;
                }
                self.saw_arg_delta = true;
                self.push_tool("", "", arguments, events);
            }
            _ => {}
        }
    }
}

fn anthropic_messages_body(model_id: &str, request: &ChatRequest) -> Value {
    let mut system: Option<String> = None;
    let mut messages = Vec::new();
    for msg in &request.messages {
        match msg.role {
            Role::System => system = Some(msg.content.clone()),
            Role::User => {
                messages.push(json!({"role": "user", "content": msg.content}));
            }
            Role::Assistant => {
                if let Some(calls) = &msg.tool_calls {
                    let mut blocks = Vec::new();
                    if !msg.content.is_empty() {
                        blocks.push(json!({"type": "text", "text": msg.content}));
                    }
                    for call in calls {
                        let input = serde_json::from_str::<Value>(&call.function.arguments)
                            .unwrap_or(json!({}));
                        blocks.push(json!({
                            "type": "tool_use",
                            "id": call.id,
                            "name": call.function.name,
                            "input": input,
                        }));
                    }
                    messages.push(json!({"role": "assistant", "content": blocks}));
                } else {
                    messages.push(json!({"role": "assistant", "content": msg.content}));
                }
            }
            Role::Tool => {
                messages.push(json!({
                    "role": "user",
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": msg.tool_call_id,
                        "content": msg.content
                    }]
                }));
            }
        }
    }
    let mut body = json!({
        "model": model_id,
        "max_tokens": request.max_tokens.unwrap_or(4096),
        "messages": messages,
        "stream": true,
    });
    if let Some(sys) = system {
        body["system"] = json!(sys);
    }
    if let Some(tools) = &request.tools {
        if !tools.is_empty() {
            body["tools"] = json!(convert_tools(tools));
        }
    }
    body
}

fn convert_tools(tools: &[ToolDef]) -> Vec<Value> {
    tools
        .iter()
        .map(|t| {
            json!({
                "name": t.function.name,
                "description": t.function.description,
                "input_schema": t.function.parameters
            })
        })
        .collect()
}

struct AnthropicLiteParser {
    done_emitted: bool,
}

impl AnthropicLiteParser {
    fn new() -> Self {
        Self {
            done_emitted: false,
        }
    }

    fn parse_line(&mut self, line: &str, events: &mut Vec<Result<StreamEvent>>) {
        let data = match line.strip_prefix("data:") {
            Some(rest) => rest.trim(),
            None => return,
        };
        if data.is_empty() {
            return;
        }
        let evt: Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(_) => return,
        };
        let event_type = evt.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "content_block_start" => {
                let Some(block) = evt.get("content_block") else {
                    return;
                };
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    return;
                }
                let id = block.get("id").and_then(Value::as_str).unwrap_or("");
                let name = block.get("name").and_then(Value::as_str).unwrap_or("");
                events.push(Ok(StreamEvent::ToolCall {
                    id: id.to_string(),
                    name: name.to_string(),
                    arguments: String::new(),
                }));
            }
            "content_block_delta" => {
                if let Some(delta) = evt.get("delta") {
                    let delta_type = delta.get("type").and_then(Value::as_str).unwrap_or("");
                    if delta_type == "input_json_delta" {
                        if let Some(partial) = delta.get("partial_json").and_then(Value::as_str) {
                            if !partial.is_empty() {
                                events.push(Ok(StreamEvent::ToolCall {
                                    id: String::new(),
                                    name: String::new(),
                                    arguments: partial.to_string(),
                                }));
                            }
                        }
                    } else if delta_type == "text_delta" {
                        if let Some(text) = delta.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                events.push(Ok(StreamEvent::ContentDelta {
                                    text: text.to_string(),
                                }));
                            }
                        }
                    } else if delta_type == "thinking_delta" {
                        if let Some(text) = delta.get("thinking").and_then(Value::as_str) {
                            events.push(Ok(StreamEvent::ReasoningDelta {
                                text: text.to_string(),
                            }));
                        }
                    }
                }
            }
            "message_delta" => {
                if let Some(delta) = evt.get("delta") {
                    if delta.get("stop_reason").is_some() && !self.done_emitted {
                        self.done_emitted = true;
                        events.push(Ok(StreamEvent::Done {
                            stop_reason: StopReason::EndTurn,
                        }));
                    }
                }
            }
            "message_stop" => {
                if !self.done_emitted {
                    self.done_emitted = true;
                    events.push(Ok(StreamEvent::Done {
                        stop_reason: StopReason::EndTurn,
                    }));
                }
            }
            "error" => {
                let msg = evt
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("Anthropic 流错误");
                events.push(Ok(StreamEvent::Error {
                    message: msg.to_string(),
                }));
            }
            _ => {}
        }
    }
}

type ParseLineFn = Arc<dyn Fn(&str, &mut Vec<Result<StreamEvent>>) + Send + Sync>;

fn sse_bytes_stream(
    response: reqwest::Response,
    parse_line: ParseLineFn,
) -> Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>> {
    let stream = response.bytes_stream();
    let buffer = Arc::new(Mutex::new(String::new()));
    let flush_buffer = buffer.clone();
    let parse_chunk = parse_line.clone();
    let parse_tail = parse_line;
    let event_stream = stream
        .flat_map(move |chunk| {
            let parse_line = parse_chunk.clone();
            let events = match chunk {
                Ok(bytes) => {
                    let mut buf = buffer.lock().unwrap();
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    let mut events = Vec::new();
                    while let Some(pos) = buf.find('\n') {
                        let line: String = buf.drain(..=pos).collect();
                        parse_line(line.trim(), &mut events);
                    }
                    events
                }
                Err(err) => vec![Err(anyhow::anyhow!("流读取失败: {err}"))],
            };
            futures::stream::iter(events)
        })
        .chain(
            futures::stream::once(async move { flush_buffer.lock().unwrap().clone() }).flat_map(
                move |leftover| {
                    let mut events = Vec::new();
                    let trimmed = leftover.trim();
                    if !trimmed.is_empty() {
                        parse_tail(&trimmed, &mut events);
                    }
                    if events.is_empty() {
                        events.push(Ok(StreamEvent::Done {
                            stop_reason: StopReason::EndTurn,
                        }));
                    }
                    futures::stream::iter(events)
                },
            ),
        );
    Box::pin(event_stream)
}

pub async fn chat_stream_wire(
    wire: WireApi,
    client: &Client,
    headers: HeaderMap,
    base_url: &str,
    model_id: &str,
    request: ChatRequest,
) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>> {
    let base = base_url.trim_end_matches('/');
    match wire {
        WireApi::OpenAiCompletions => {
            bail!("openai-completions 由 OpencodeGoProvider 直接处理");
        }
        WireApi::OpenAiResponses => {
            let url = format!("{base}/responses");
            let body = messages_to_responses_body(model_id, &request);
            let response = client
                .post(&url)
                .headers(headers)
                .json(&body)
                .send()
                .await?;
            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                bail!("OpenCode Go 对话失败 {status}: {text}");
            }
            let parser = Arc::new(Mutex::new(ResponsesSseParser::new()));
            Ok(sse_bytes_stream(
                response,
                Arc::new(move |line, events| {
                    parser.lock().unwrap().parse_line(line, events);
                }),
            ))
        }
        WireApi::AnthropicMessages => {
            let url = format!("{base}/messages");
            let body = anthropic_messages_body(model_id, &request);
            let mut headers = headers;
            headers.insert(
                reqwest::header::HeaderName::from_static("anthropic-version"),
                "2023-06-01".parse().expect("anthropic-version"),
            );
            let response = client
                .post(&url)
                .headers(headers)
                .json(&body)
                .send()
                .await?;
            if !response.status().is_success() {
                let status = response.status();
                let text = response.text().await.unwrap_or_default();
                bail!("OpenCode Go 对话失败 {status}: {text}");
            }
            let parser = Arc::new(Mutex::new(AnthropicLiteParser::new()));
            Ok(sse_bytes_stream(
                response,
                Arc::new(move |line, events| {
                    let mut p = parser.lock().unwrap();
                    p.parse_line(line, events);
                }),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnipanel_ai::types::{ChatMessage, FunctionCall, FunctionDef, ToolCall, ToolDef};
    use serde_json::json;

    #[test]
    fn responses_tools_use_flat_function_shape() {
        let tools = vec![ToolDef {
            tool_type: "function".into(),
            function: FunctionDef {
                name: "get_time".into(),
                description: "Current time".into(),
                parameters: json!({"type": "object", "properties": {}}),
            },
        }];
        let body = messages_to_responses_body(
            "muse-spark-1.3-contributor",
            &ChatRequest {
                model: "muse-spark-1.3-contributor".into(),
                messages: vec![ChatMessage {
                    role: Role::User,
                    content: "hi".into(),
                    tool_call_id: None,
                    tool_calls: None,
                    name: None,
                }],
                stream: true,
                tools: Some(tools),
                temperature: None,
                max_tokens: None,
                enable_thinking: None,
                reasoning_effort: None,
            },
        );
        let first = body["tools"][0].clone();
        assert_eq!(first["name"], "get_time");
        assert!(first.get("function").is_none());
    }

    #[test]
    fn responses_followup_includes_function_call_output() {
        let body = messages_to_responses_body(
            "muse-spark-1.3-contributor",
            &ChatRequest {
                model: "muse-spark-1.3-contributor".into(),
                messages: vec![
                    ChatMessage {
                        role: Role::Assistant,
                        content: "正在查询".into(),
                        tool_call_id: None,
                        tool_calls: Some(vec![ToolCall {
                            id: "call_test".into(),
                            call_type: "function".into(),
                            function: FunctionCall {
                                name: "get_current_time".into(),
                                arguments: "{}".into(),
                            },
                        }]),
                        name: None,
                    },
                    ChatMessage {
                        role: Role::Tool,
                        content: "18:30".into(),
                        tool_call_id: Some("call_test".into()),
                        tool_calls: None,
                        name: Some("get_current_time".into()),
                    },
                ],
                stream: true,
                tools: None,
                temperature: None,
                max_tokens: None,
                enable_thinking: None,
                reasoning_effort: None,
            },
        );
        let input = body["input"].as_array().unwrap();
        assert_eq!(input[1]["type"], "function_call");
        assert_eq!(input[1]["call_id"], "call_test");
        assert_eq!(input[2]["type"], "function_call_output");
        assert_eq!(input[2]["output"], "18:30");
    }

    #[test]
    fn parses_function_call_without_duplicating_arguments() {
        let mut parser = ResponsesSseParser::new();
        let mut events = Vec::new();
        for line in [
            r#"data: {"type":"response.output_text.delta","delta":"正在查询"}"#,
            r#"data: {"type":"response.output_item.added","item":{"type":"function_call","name":"get_current_time","call_id":"call_1","arguments":""}}"#,
            r#"data: {"type":"response.function_call_arguments.delta","delta":"{}"}"#,
            r#"data: {"type":"response.function_call_arguments.done","arguments":"{}"}"#,
            r#"data: {"type":"response.completed"}"#,
        ] {
            parser.parse_line(line, &mut events);
        }
        let calls: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                Ok(StreamEvent::ToolCall {
                    id,
                    name,
                    arguments,
                }) => Some((id.clone(), name.clone(), arguments.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(
            calls,
            vec![
                ("call_1".into(), "get_current_time".into(), String::new()),
                (String::new(), String::new(), "{}".into()),
            ]
        );
    }
}
