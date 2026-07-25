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
    /// 通义 / DashScope 兼容：开启思考链。
    #[serde(skip_serializing_if = "Option::is_none")]
    enable_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_effort: Option<String>,
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
            enable_thinking: request.enable_thinking,
            reasoning_effort: request.reasoning_effort.clone(),
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

        let text = resp.text().await?;
        match serde_json::from_str::<OpenAiResponse>(&text) {
            Ok(data) => {
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
            Err(_) => {
                // 部分网关（如阿里云 MaaS）返回 {"text":"...","finish_reason":"stop"}，
                // 而非 OpenAI 的 choices[].message.content。
                if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(msg) = extract_error_message(&val) {
                        bail!("OpenAI API error: {msg}");
                    }
                    if let Some(content) = extract_plain_text_completion(&val) {
                        return Ok(ChatResponse {
                            message: ChatMessage {
                                role: Role::Assistant,
                                content,
                                tool_call_id: None,
                                tool_calls: None,
                                name: None,
                            },
                            usage: Usage {
                                input_tokens: 0,
                                output_tokens: 0,
                            },
                        });
                    }
                }
                bail!("Unexpected OpenAI response: {text}");
            }
        }
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
            enable_thinking: request.enable_thinking,
            reasoning_effort: request.reasoning_effort.clone(),
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
        let buffer = Arc::new(Mutex::new(String::new()));
        let flush_buffer = buffer.clone();
        let event_stream = stream
            .flat_map(move |chunk| {
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
            })
            .chain(
                futures::stream::once(async move {
                    let leftover = {
                        let mut buf = flush_buffer.lock().unwrap();
                        std::mem::take(&mut *buf)
                    };
                    leftover
                })
                .flat_map(|leftover| {
                    let mut events = Vec::new();
                    let trimmed = leftover.trim();
                    if !trimmed.is_empty() {
                        parse_sse_line(trimmed, &mut events);
                    }
                    futures::stream::iter(events)
                }),
            );

        Ok(Box::pin(event_stream))
    }
}

fn stop_reason_from_finish(reason: &str) -> StopReason {
    match reason {
        "tool_calls" | "function_call" => StopReason::ToolUse,
        "length" => StopReason::MaxTokens,
        "content_filter" => StopReason::Refusal,
        _ => StopReason::EndTurn,
    }
}

fn extract_error_message(val: &serde_json::Value) -> Option<String> {
    val.get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .map(|s| s.to_string())
}

/// 非 OpenAI `choices` 形态：如阿里云 MaaS `{"text":"...","finish_reason":"stop"}`。
fn extract_plain_text_completion(val: &serde_json::Value) -> Option<String> {
    if val.get("choices").is_some() {
        return None;
    }
    val.get("text")
        .and_then(|t| t.as_str())
        .map(|s| s.to_string())
}

fn extract_plain_reasoning(val: &serde_json::Value) -> Option<String> {
    if val.get("choices").is_some() {
        return None;
    }
    val.get("reasoning_content")
        .or_else(|| val.get("reasoning"))
        .or_else(|| val.get("thinking"))
        .and_then(|t| t.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

fn push_plain_text_completion(val: &serde_json::Value, events: &mut Vec<Result<StreamEvent>>) -> bool {
    let text = extract_plain_text_completion(val);
    let reasoning = extract_plain_reasoning(val);
    if text.is_none() && reasoning.is_none() {
        return false;
    }
    if let Some(reasoning) = reasoning {
        events.push(Ok(StreamEvent::ReasoningDelta { text: reasoning }));
    }
    if let Some(text) = text {
        if !text.is_empty() {
            events.push(Ok(StreamEvent::ContentDelta { text }));
        }
    }
    let stop_reason = val
        .get("finish_reason")
        .and_then(|f| f.as_str())
        .map(stop_reason_from_finish)
        .unwrap_or(StopReason::EndTurn);
    events.push(Ok(StreamEvent::Done { stop_reason }));
    true
}

/// 解析单行流式负载（已去除首尾空白），把产生的事件追加到 `events`。
/// 支持标准 OpenAI SSE（`data: {...}`）以及无 `data:` 前缀的整段 JSON。
fn parse_sse_line(line: &str, events: &mut Vec<Result<StreamEvent>>) {
    if line.is_empty() {
        return;
    }

    let data = match line.strip_prefix("data:") {
        Some(rest) => {
            let data = rest.trim();
            // [DONE] 仅为终止信号；stop_reason 由 finish_reason 决定，
            // 此处不再 emit Done，避免覆盖已产生的 Done{ToolUse}。
            if data.is_empty() || data == "[DONE]" {
                return;
            }
            data
        }
        // 无 SSE 前缀：可能是网关直接返回的整段 JSON（如阿里云 MaaS）。
        None if line.starts_with('{') => line,
        None => return,
    };

    let chunk = match serde_json::from_str::<StreamChunk>(data) {
        Ok(chunk) => chunk,
        Err(err) => {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
                if let Some(msg) = extract_error_message(&val) {
                    events.push(Ok(StreamEvent::Error {
                        message: msg,
                    }));
                    return;
                }
                if push_plain_text_completion(&val, events) {
                    return;
                }
            }
            tracing::warn!(target: "omni_sse", error = %err, line = %data, "OpenAI SSE 行解析失败");
            return;
        }
    };

    // StreamChunk 反序列化成功但 choices 为空时，再尝试 plain text。
    if chunk.choices.is_empty() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(data) {
            if push_plain_text_completion(&val, events) {
                return;
            }
        }
    }

    for choice in chunk.choices {
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
            events.push(Ok(StreamEvent::Done {
                stop_reason: stop_reason_from_finish(reason),
            }));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_aliyun_maas_plain_json() {
        let mut events = Vec::new();
        parse_sse_line(
            r#"{"finish_reason":"stop","text":"你好，有什么可以帮你的"}"#,
            &mut events,
        );
        assert_eq!(events.len(), 2);
        match &events[0] {
            Ok(StreamEvent::ContentDelta { text }) => {
                assert_eq!(text, "你好，有什么可以帮你的");
            }
            other => panic!("expected ContentDelta, got {other:?}"),
        }
        match &events[1] {
            Ok(StreamEvent::Done {
                stop_reason: StopReason::EndTurn,
            }) => {}
            other => panic!("expected Done EndTurn, got {other:?}"),
        }
    }

    #[test]
    fn parse_openai_sse_still_works() {
        let mut events = Vec::new();
        parse_sse_line(
            r#"data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}"#,
            &mut events,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            Ok(StreamEvent::ContentDelta { text }) => assert_eq!(text, "hi"),
            other => panic!("expected ContentDelta, got {other:?}"),
        }
    }

    #[test]
    fn parse_openai_sse_reasoning_with_null_content() {
        let mut events = Vec::new();
        parse_sse_line(
            r#"data: {"choices":[{"delta":{"content":null,"reasoning_content":"先想一步"},"finish_reason":null}]}"#,
            &mut events,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            Ok(StreamEvent::ReasoningDelta { text }) => assert_eq!(text, "先想一步"),
            other => panic!("expected ReasoningDelta, got {other:?}"),
        }
    }

    #[test]
    fn parse_aliyun_maas_plain_json_with_reasoning() {
        let mut events = Vec::new();
        parse_sse_line(
            r#"{"finish_reason":"stop","reasoning_content":"思考","text":"答案"}"#,
            &mut events,
        );
        assert_eq!(events.len(), 3);
        match &events[0] {
            Ok(StreamEvent::ReasoningDelta { text }) => assert_eq!(text, "思考"),
            other => panic!("expected ReasoningDelta, got {other:?}"),
        }
        match &events[1] {
            Ok(StreamEvent::ContentDelta { text }) => assert_eq!(text, "答案"),
            other => panic!("expected ContentDelta, got {other:?}"),
        }
    }
}
