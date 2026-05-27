use anyhow::{bail, Result};
use async_trait::async_trait;
use futures::Stream;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::pin::Pin;
use tokio_stream::StreamExt;

use crate::ir::{StopReason, StreamEvent};
use crate::provider::AiProvider;
use crate::types::{ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, Usage};

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
        Self {
            name: name.to_string(),
            api_key: api_key.to_string(),
            base_url: base_url.trim_end_matches('/').to_string(),
            models,
            client: Client::new(),
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
struct OpenAiChoice {
    message: OpenAiMessageResponse,
    finish_reason: Option<String>,
}

#[derive(Deserialize)]
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
struct StreamDelta {
    role: Option<String>,
    content: Option<String>,
    tool_calls: Option<Vec<StreamToolCall>>,
}

#[derive(Deserialize)]
struct StreamToolCall {
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
        };

        let resp = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

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
        };

        let resp = self
            .client
            .post(format!("{}/chat/completions", self.base_url))
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            bail!("OpenAI API error {}: {}", status, text);
        }

        let stream = resp.bytes_stream();
        let event_stream = stream.filter_map(|chunk| match chunk {
            Ok(bytes) => {
                let text = String::from_utf8_lossy(&bytes);
                parse_sse_chunk(&text)
            }
            Err(e) => Some(Err(anyhow::anyhow!("Stream error: {}", e))),
        });

        Ok(Box::pin(event_stream))
    }
}

fn parse_sse_chunk(raw: &str) -> Option<Result<StreamEvent>> {
    let mut result = None;

    for line in raw.lines() {
        let line = line.trim();
        if !line.starts_with("data: ") {
            continue;
        }
        let data = &line[6..];
        if data == "[DONE]" {
            result = Some(Ok(StreamEvent::Done {
                stop_reason: StopReason::EndTurn,
            }));
            continue;
        }

        match serde_json::from_str::<StreamChunk>(data) {
            Ok(chunk) => {
                for choice in chunk.choices {
                    if let Some(reason) = &choice.finish_reason {
                        if reason == "tool_calls" {
                            result = Some(Ok(StreamEvent::Done {
                                stop_reason: StopReason::ToolUse,
                            }));
                        }
                    }
                    if let Some(content) = &choice.delta.content {
                        if !content.is_empty() {
                            result = Some(Ok(StreamEvent::ContentDelta {
                                text: content.clone(),
                            }));
                        }
                    }
                    if let Some(tool_calls) = &choice.delta.tool_calls {
                        for tc in tool_calls {
                            if let Some(func) = &tc.function {
                                result = Some(Ok(StreamEvent::ToolCall {
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
                }
            }
            Err(_) => continue,
        }
    }

    result
}
