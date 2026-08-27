use anyhow::{Result, bail};
use async_trait::async_trait;
use futures::Stream;
use futures::StreamExt as _;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::ir::{StopReason, StreamEvent};
use crate::provider::AiProvider;
use crate::types::{ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, ToolDef, Usage};

/// Anthropic Claude Messages API provider
pub struct AnthropicProvider {
    api_key: String,
    base_url: String,
    models: Vec<ModelInfo>,
    client: Client,
}

impl AnthropicProvider {
    pub fn new(api_key: &str, base_url: Option<&str>, models: Vec<ModelInfo>) -> Self {
        Self::with_client(api_key, base_url, models, None)
    }

    pub fn with_client(
        api_key: &str,
        base_url: Option<&str>,
        models: Vec<ModelInfo>,
        client: Option<Client>,
    ) -> Self {
        Self {
            api_key: api_key.to_string(),
            base_url: base_url
                .unwrap_or("https://api.anthropic.com/v1")
                .trim_end_matches('/')
                .to_string(),
            models,
            client: client.unwrap_or_else(Client::new),
        }
    }
}

#[derive(Serialize)]
struct AnthropicRequest {
    model: String,
    max_tokens: u32,
    messages: Vec<AnthropicMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
}

#[derive(Serialize, Deserialize)]
struct AnthropicMessage {
    role: String,
    content: serde_json::Value,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct AnthropicResponse {
    content: Vec<ContentBlock>,
    usage: AnthropicUsage,
    stop_reason: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct ContentBlock {
    #[serde(rename = "type")]
    block_type: String,
    text: Option<String>,
    id: Option<String>,
    name: Option<String>,
    input: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct AnthropicUsage {
    input_tokens: u32,
    output_tokens: u32,
}

// SSE streaming types

#[derive(Deserialize)]
#[allow(dead_code)]
struct StreamEvent2 {
    #[serde(rename = "type")]
    event_type: String,
    #[serde(flatten)]
    data: serde_json::Value,
}

fn convert_messages(messages: &[ChatMessage]) -> (Option<String>, Vec<AnthropicMessage>) {
    let mut system = None;
    let mut anthropic_msgs = Vec::new();

    for msg in messages {
        match msg.role {
            Role::System => {
                system = Some(msg.content.clone());
            }
            Role::User => {
                anthropic_msgs.push(AnthropicMessage {
                    role: "user".to_string(),
                    content: serde_json::Value::String(msg.content.clone()),
                });
            }
            Role::Assistant => {
                if let Some(tool_calls) = &msg.tool_calls {
                    let mut blocks = Vec::new();
                    if !msg.content.is_empty() {
                        blocks.push(serde_json::json!({
                            "type": "text",
                            "text": msg.content
                        }));
                    }
                    for tc in tool_calls {
                        blocks.push(serde_json::json!({
                            "type": "tool_use",
                            "id": tc.id,
                            "name": tc.function.name,
                            "input": serde_json::from_str::<serde_json::Value>(&tc.function.arguments)
                                .unwrap_or(serde_json::Value::Null)
                        }));
                    }
                    anthropic_msgs.push(AnthropicMessage {
                        role: "assistant".to_string(),
                        content: serde_json::Value::Array(blocks),
                    });
                } else {
                    anthropic_msgs.push(AnthropicMessage {
                        role: "assistant".to_string(),
                        content: serde_json::Value::String(msg.content.clone()),
                    });
                }
            }
            Role::Tool => {
                anthropic_msgs.push(AnthropicMessage {
                    role: "user".to_string(),
                    content: serde_json::json!([{
                        "type": "tool_result",
                        "tool_use_id": msg.tool_call_id,
                        "content": msg.content
                    }]),
                });
            }
        }
    }

    (system, anthropic_msgs)
}

fn convert_tools(tools: &[ToolDef]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| {
            serde_json::json!({
                "name": t.function.name,
                "description": t.function.description,
                "input_schema": t.function.parameters
            })
        })
        .collect()
}

/// Stateful parser for Anthropic SSE streaming that handles tool_use accumulation.
struct AnthropicStreamParser {
    /// Accumulated tool call data: index -> (id, name, accumulated_json_args)
    tool_calls: HashMap<usize, (String, String, String)>,
    /// 跨网络分片缓冲：一行 `data: {...}` 可能被 TCP 切成两半分两个分片到达，
    /// 只解析以换行结束的完整行，剩余不完整片段留在这里。
    line_buffer: String,
    /// 是否已经根据 `message_delta.stop_reason` 产生过 Done。
    /// 若已产生，`message_stop` 不再覆盖（否则 tool_use 会被 EndTurn 覆盖，工具永不触发）。
    done_emitted: bool,
    /// message_start 记录的输入 token，最终在 message_delta 补齐输出 token。
    input_tokens: u32,
}

impl AnthropicStreamParser {
    fn new() -> Self {
        Self {
            tool_calls: HashMap::new(),
            line_buffer: String::new(),
            done_emitted: false,
            input_tokens: 0,
        }
    }

    fn parse(&mut self, raw: &str) -> Vec<Result<StreamEvent>> {
        let mut results = Vec::new();

        self.line_buffer.push_str(raw);
        while let Some(pos) = self.line_buffer.find('\n') {
            let line: String = self.line_buffer.drain(..=pos).collect();
            self.parse_line(line.trim(), &mut results);
        }

        results
    }

    fn parse_line(&mut self, line: &str, results: &mut Vec<Result<StreamEvent>>) {
        let data = match line.strip_prefix("data:") {
            Some(rest) => rest.trim(),
            None => return,
        };
        if data.is_empty() {
            return;
        }

        let evt: serde_json::Value = match serde_json::from_str(data) {
            Ok(v) => v,
            Err(err) => {
                tracing::warn!(target: "omni_sse", error = %err, line = %data, "Anthropic SSE 行解析失败");
                return;
            }
        };

        let event_type = evt.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match event_type {
            "content_block_start" => {
                if let Some(block) = evt.get("content_block") {
                    let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    if block_type == "tool_use" {
                        let index = evt.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                        let id = block
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        self.tool_calls
                            .insert(index, (id.clone(), name.clone(), String::new()));
                        results.push(Ok(StreamEvent::ToolCall {
                            id,
                            name,
                            arguments: String::new(),
                        }));
                    }
                }
            }
            "content_block_delta" => {
                if let Some(delta) = evt.get("delta") {
                    let delta_type = delta.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    match delta_type {
                        "input_json_delta" => {
                            let index =
                                evt.get("index").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                            let partial = delta
                                .get("partial_json")
                                .and_then(|v| v.as_str())
                                .unwrap_or("");
                            if let Some(entry) = self.tool_calls.get_mut(&index) {
                                entry.2.push_str(partial);
                            }
                            // Emit as ToolCall with empty name (argument update)
                            results.push(Ok(StreamEvent::ToolCall {
                                id: String::new(),
                                name: String::new(),
                                arguments: partial.to_string(),
                            }));
                        }
                        "text_delta" => {
                            if let Some(text) = delta.get("text").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    results.push(Ok(StreamEvent::ContentDelta {
                                        text: text.to_string(),
                                    }));
                                }
                            }
                        }
                        // Claude 3.7+ extended thinking：思考内容以 thinking_delta 流式返回。
                        "thinking_delta" => {
                            if let Some(text) = delta.get("thinking").and_then(|v| v.as_str()) {
                                if !text.is_empty() {
                                    results.push(Ok(StreamEvent::ReasoningDelta {
                                        text: text.to_string(),
                                    }));
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            // message_stop 只作结束标记；Done 已由 message_delta 的 stop_reason 精确产生。
            // 仅当整个流程从未产出 Done 时兜底一个 EndTurn。
            "message_stop" => {
                if !self.done_emitted {
                    self.done_emitted = true;
                    results.push(Ok(StreamEvent::Done {
                        stop_reason: StopReason::EndTurn,
                    }));
                }
            }
            "message_delta" => {
                if let Some(delta) = evt.get("delta") {
                    if let Some(reason) = delta.get("stop_reason").and_then(|v| v.as_str()) {
                        let stop = match reason {
                            "tool_use" => StopReason::ToolUse,
                            "max_tokens" => StopReason::MaxTokens,
                            "refusal" => StopReason::Refusal,
                            // end_turn / stop_sequence / pause_turn 等归为正常结束
                            _ => StopReason::EndTurn,
                        };
                        self.done_emitted = true;
                        results.push(Ok(StreamEvent::Done { stop_reason: stop }));
                    }
                }
                // 输出 token 在 message_delta.usage 中给出，补齐 Usage。
                if let Some(usage) = evt.get("usage") {
                    if let Some(output) = usage.get("output_tokens").and_then(|v| v.as_u64()) {
                        results.push(Ok(StreamEvent::Usage {
                            input_tokens: self.input_tokens,
                            output_tokens: output as u32,
                        }));
                    }
                }
            }
            "message_start" => {
                if let Some(message) = evt.get("message") {
                    if let Some(usage) = message.get("usage") {
                        let input = usage
                            .get("input_tokens")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(0) as u32;
                        self.input_tokens = input;
                        results.push(Ok(StreamEvent::Usage {
                            input_tokens: input,
                            output_tokens: 0,
                        }));
                    }
                }
            }
            // Anthropic 在流中以独立 error 事件报告错误，不能落入 `_` 被吞掉。
            "error" => {
                let msg = evt
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Anthropic 流错误");
                results.push(Ok(StreamEvent::Error {
                    message: msg.to_string(),
                }));
            }
            _ => {}
        }
    }
}

#[async_trait]
impl AiProvider for AnthropicProvider {
    fn name(&self) -> &str {
        "anthropic"
    }

    fn models(&self) -> Vec<ModelInfo> {
        self.models.clone()
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let (system, messages) = convert_messages(&request.messages);
        let body = AnthropicRequest {
            model: request.model.clone(),
            max_tokens: request.max_tokens.unwrap_or(4096),
            messages,
            system,
            stream: Some(false),
            temperature: request.temperature,
            tools: request.tools.as_ref().map(|t| convert_tools(t)),
        };

        let resp = self
            .client
            .post(format!("{}/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("Anthropic API error {}: {}", status, text);
        }

        let data: AnthropicResponse = resp.json().await?;

        // Extract text content
        let text = data
            .content
            .iter()
            .filter_map(|b| b.text.as_deref())
            .collect::<Vec<_>>()
            .join("");

        // Extract tool_use blocks
        let tool_calls: Vec<crate::types::ToolCall> = data
            .content
            .iter()
            .filter(|b| b.block_type == "tool_use")
            .filter_map(|b| {
                Some(crate::types::ToolCall {
                    id: b.id.clone()?,
                    call_type: "function".to_string(),
                    function: crate::types::FunctionCall {
                        name: b.name.clone()?,
                        arguments: b.input.as_ref().map(|v| v.to_string()).unwrap_or_default(),
                    },
                })
            })
            .collect();

        Ok(ChatResponse {
            message: ChatMessage {
                role: Role::Assistant,
                content: text,
                tool_call_id: None,
                tool_calls: if tool_calls.is_empty() {
                    None
                } else {
                    Some(tool_calls)
                },
                name: None,
            },
            usage: Usage {
                input_tokens: data.usage.input_tokens,
                output_tokens: data.usage.output_tokens,
            },
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>> {
        let (system, messages) = convert_messages(&request.messages);
        let body = AnthropicRequest {
            model: request.model.clone(),
            max_tokens: request.max_tokens.unwrap_or(4096),
            messages,
            system,
            stream: Some(true),
            temperature: request.temperature,
            tools: request.tools.as_ref().map(|t| convert_tools(t)),
        };

        let resp = self
            .client
            .post(format!("{}/messages", self.base_url))
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("Anthropic API error {}: {}", status, text);
        }

        let stream = resp.bytes_stream();
        let parser = Arc::new(Mutex::new(AnthropicStreamParser::new()));

        let event_stream = stream.flat_map(move |chunk| match chunk {
            Ok(bytes) => {
                let mut p = parser.lock().unwrap();
                let events = p.parse(&String::from_utf8_lossy(&bytes));
                futures::stream::iter(events)
            }
            Err(e) => futures::stream::iter(vec![Err(anyhow::anyhow!("Stream error: {}", e))]),
        });

        Ok(Box::pin(event_stream))
    }
}
