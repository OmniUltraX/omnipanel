use anyhow::{Result, bail};
use async_trait::async_trait;
use futures::{Stream, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use crate::ir::{StopReason, StreamEvent};
use crate::provider::AiProvider;
use crate::types::{ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, ToolDef, Usage};

fn format_http_request_error(err: reqwest::Error, url: &str) -> anyhow::Error {
    let mut hint = String::new();
    if err.is_connect() {
        hint.push_str("网络连接失败，请检查：① 本机网络 ② 设置中的代理是否已开启但不可用 ③ Base URL 是否正确");
    } else if err.is_timeout() {
        hint.push_str("请求超时，请稍后重试或检查网络/代理");
    } else if err.is_request() {
        hint.push_str("请求发送失败，请检查代理设置与 API 地址");
    }
    if hint.is_empty() {
        anyhow::anyhow!("请求失败 ({url}): {err}")
    } else {
        anyhow::anyhow!("请求失败 ({url}): {err}。{hint}")
    }
}

/// OpenAI-compatible provider. Works with:
/// - OpenAI API (api.openai.com)
/// - Ollama (localhost:11434, OpenAI-compat mode)
/// - Any OpenAI-compatible endpoint
pub struct OpenAiProvider {
    name: String,
    api_key: String,
    base_url: String,
    models: Vec<ModelInfo>,
    client: Client,
}

impl OpenAiProvider {
    pub fn new(name: &str, api_key: &str, base_url: &str, models: Vec<ModelInfo>) -> Self {
        Self::with_client(name, api_key, base_url, models, None)
    }

    pub fn with_client(
        name: &str,
        api_key: &str,
        base_url: &str,
        models: Vec<ModelInfo>,
        client: Option<Client>,
    ) -> Self {
        Self {
            name: name.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            models,
            client: client.unwrap_or_else(Client::new),
        }
    }
}

#[derive(Serialize)]
struct OpenAiRequest {
    model: String,
    messages: Vec<OpenAiMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<serde_json::Value>>,
}

#[derive(Serialize, Deserialize)]
struct OpenAiMessage {
    role: String,
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
}

#[derive(Deserialize)]
struct OpenAiResponse {
    choices: Vec<OpenAiChoice>,
    usage: Option<OpenAiUsage>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenAiChoice {
    message: OpenAiMessageResponse,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct OpenAiMessageResponse {
    role: String,
    content: Option<String>,
    tool_calls: Option<Vec<serde_json::Value>>,
}

#[derive(Deserialize)]
struct OpenAiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
}

#[derive(Deserialize)]
struct StreamChunk {
    choices: Vec<StreamChoice>,
}

#[derive(Deserialize)]
struct StreamChoice {
    delta: StreamDelta,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct StreamDelta {
    role: Option<String>,
    content: Option<String>,
    /// 推理模型思考内容：DeepSeek 用 `reasoning_content`，
    /// OpenRouter/部分兼容端用 `reasoning`。
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Deserialize)]
struct StreamToolCall {
    #[serde(default)]
    index: usize,
    id: Option<String>,
    function: Option<StreamFunction>,
}

#[derive(Deserialize)]
struct StreamFunction {
    name: Option<String>,
    arguments: Option<String>,
}

fn convert_messages(messages: &[ChatMessage]) -> Vec<OpenAiMessage> {
    messages
        .iter()
        .map(|m| OpenAiMessage {
            role: match m.role {
                Role::User => "user".to_string(),
                Role::Assistant => "assistant".to_string(),
                Role::System => "system".to_string(),
                Role::Tool => "tool".to_string(),
            },
            content: Some(m.content.clone()),
            tool_calls: m.tool_calls.as_ref().map(|tcs| {
                tcs.iter()
                    .map(|tc| serde_json::to_value(tc).unwrap_or_default())
                    .collect()
            }),
            tool_call_id: m.tool_call_id.clone(),
        })
        .collect()
}

fn convert_tools(tools: &[ToolDef]) -> Vec<serde_json::Value> {
    tools
        .iter()
        .map(|t| serde_json::to_value(t).unwrap_or_default())
        .collect()
}

#[async_trait]
impl AiProvider for OpenAiProvider {
    fn name(&self) -> &str {
        &self.name
    }

    fn models(&self) -> Vec<ModelInfo> {
        self.models.clone()
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let body = OpenAiRequest {
            model: request.model.clone(),
            messages: convert_messages(&request.messages),
            stream: Some(false),
            temperature: request.temperature,
            max_tokens: request.max_tokens,
            tools: request.tools.as_ref().map(|t| convert_tools(t)),
        };

        let url = format!("{}/chat/completions", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format_http_request_error(e, &url))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("OpenAI API error {}: {}", status, text);
        }

        let data: OpenAiResponse = resp.json().await?;
        let choice = data
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No choices in response"))?;

        Ok(ChatResponse {
            message: ChatMessage {
                role: Role::Assistant,
                content: choice.message.content.unwrap_or_default(),
                tool_call_id: None,
                tool_calls: None,
                name: None,
            },
            usage: Usage {
                input_tokens: data.usage.as_ref().map(|u| u.prompt_tokens).unwrap_or(0),
                output_tokens: data
                    .usage
                    .as_ref()
                    .map(|u| u.completion_tokens)
                    .unwrap_or(0),
            },
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>> {
        let body = OpenAiRequest {
            model: request.model.clone(),
            messages: convert_messages(&request.messages),
            stream: Some(true),
            temperature: request.temperature,
            max_tokens: request.max_tokens,
            tools: request.tools.as_ref().map(|t| convert_tools(t)),
        };

        let url = format!("{}/chat/completions", self.base_url);
        let resp = self
            .client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format_http_request_error(e, &url))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("OpenAI API error {}: {}", status, text);
        }

        let stream = resp.bytes_stream();
        // 每个网络分片可能包含多行 SSE、多个 delta（content/tool_call/finish_reason），
        // 必须全部展开为事件，绝不能只保留最后一个（否则会丢失 Done{ToolUse} 或
        // tool_call 的 arguments 分片，导致工具永不执行）。
        // 同时：一行 `data: {...}` 可能被 TCP 切成两半分两个分片到达，
        // 必须跨分片缓冲，只解析以换行结束的完整行，否则半行 JSON 会被静默丢弃。
        let buffer = Arc::new(Mutex::new(String::new()));
        let event_stream = stream.flat_map(move |chunk| {
            let events = match chunk {
                Ok(bytes) => {
                    let mut buf = buffer.lock().unwrap();
                    buf.push_str(&String::from_utf8_lossy(&bytes));
                    let mut events = Vec::new();
                    // 逐个完整行（含换行符）取出解析，最后不完整的一行留在 buffer 里。
                    while let Some(pos) = buf.find('\n') {
                        let line: String = buf.drain(..=pos).collect();
                        parse_sse_line(line.trim(), &mut events);
                    }
                    events
                }
                Err(e) => vec![Err(anyhow::anyhow!("Stream error: {}", e))],
            };
            futures::stream::iter(events)
        });

        Ok(Box::pin(event_stream))
    }
}

/// 解析单行 SSE（已去除首尾空白），把产生的事件追加到 `events`。
fn parse_sse_line(line: &str, events: &mut Vec<Result<StreamEvent>>) {
    let data = match line.strip_prefix("data:") {
        Some(rest) => rest.trim(),
        None => return,
    };
    // [DONE] 仅为终止信号；stop_reason 由 finish_reason 决定，
    // 此处不再 emit Done，避免覆盖已产生的 Done{ToolUse}。
    if data.is_empty() || data == "[DONE]" {
        return;
    }

    let chunk = match serde_json::from_str::<StreamChunk>(data) {
        Ok(chunk) => chunk,
        Err(err) => {
            // 完整行仍解析失败：可能是 API 返回的错误对象或非法 JSON。
            // 检测 error 字段映射为 IR Error，否则记日志（不再静默吞掉）。
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(msg) = val
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                {
                    events.push(Ok(StreamEvent::Error {
                        message: msg.to_string(),
                    }));
                    return;
                }
            }
            tracing::warn!(target: "omni_sse", error = %err, line = %data, "OpenAI SSE 行解析失败");
            return;
        }
    };

    for choice in chunk.choices {
        // 顺序：先 reasoning/content/tool_call 分片，最后才是 finish_reason 的 Done，
        // 确保同一分片内的 arguments 尾段先于 Done 被消费。
        let reasoning = choice
            .delta
            .reasoning_content
            .as_deref()
            .or(choice.delta.reasoning.as_deref());
        if let Some(reasoning) = reasoning {
            if !reasoning.is_empty() {
                events.push(Ok(StreamEvent::ReasoningDelta {
                    text: reasoning.to_string(),
                }));
            }
        }
        if let Some(content) = &choice.delta.content {
            if !content.is_empty() {
                events.push(Ok(StreamEvent::ContentDelta {
                    text: content.clone(),
                }));
            }
        }
        if let Some(tool_calls) = &choice.delta.tool_calls {
            for tc in tool_calls {
                if let Some(func) = &tc.function {
                    events.push(Ok(StreamEvent::ToolCall {
                        id: tc
                            .id
                            .clone()
                            .unwrap_or_else(|| format!("call_{}", tc.index)),
                        name: func.name.clone().unwrap_or_default(),
                        arguments: func.arguments.clone().unwrap_or_default(),
                    }));
                }
            }
        }
        if let Some(reason) = &choice.finish_reason {
            let stop_reason = match reason.as_str() {
                "tool_calls" | "function_call" => StopReason::ToolUse,
                "length" => StopReason::MaxTokens,
                "content_filter" => StopReason::Refusal,
                _ => StopReason::EndTurn,
            };
            events.push(Ok(StreamEvent::Done { stop_reason }));
        }
    }
}
