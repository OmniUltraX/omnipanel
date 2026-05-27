use anyhow::Result;
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

use crate::ir::StreamEvent;
use crate::types::{ChatRequest, ChatResponse, ModelInfo};

/// Unified interface for all AI providers.
/// Implementations include OpenAI-compatible APIs, Anthropic, and ACP CLI agents.
#[async_trait]
pub trait AiProvider: Send + Sync {
    /// Provider identifier (e.g. "openai", "anthropic", "acp:claude-code")
    fn name(&self) -> &str;

    /// Available models from this provider
    fn models(&self) -> Vec<ModelInfo>;

    /// Non-streaming chat completion
    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse>;

    /// Streaming chat completion — yields IR events as they arrive
    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>>;
}

/// Registry of all configured AI providers
pub struct AiProviderRegistry {
    providers: Vec<Box<dyn AiProvider>>,
}

impl AiProviderRegistry {
    pub fn new() -> Self {
        Self {
            providers: Vec::new(),
        }
    }

    pub fn register(&mut self, provider: Box<dyn AiProvider>) {
        self.providers.push(provider);
    }

    pub fn get(&self, name: &str) -> Option<&dyn AiProvider> {
        self.providers.iter().find(|p| p.name() == name).map(|p| &**p)
    }

    pub fn list(&self) -> Vec<&str> {
        self.providers.iter().map(|p| p.name()).collect()
    }

    pub fn all_models(&self) -> Vec<ModelInfo> {
        self.providers.iter().flat_map(|p| p.models()).collect()
    }
}
