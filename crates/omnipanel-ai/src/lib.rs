pub mod ir;
pub mod orchestrator;
pub mod prompts;
pub mod provider;
pub mod providers;
pub mod redact;
pub mod routing;
pub mod types;

pub use ir::{StopReason, StreamEvent, ToolStatus};
pub use orchestrator::{
    AiContextBundle, HttpProviderSnapshot, InternalChatRequest, InternalOrchestrator,
    InternalToolsMode, ToolExecutor,
};
pub use provider::{AiProvider, AiProviderRegistry, RenamedProvider};
pub use providers::model_list::{
    FetchModelsError, RemoteModelInfo, fetch_provider_models, parse_models_payload,
};
pub use routing::{
    parse_backend_id, BackendKind, HttpInferenceApi, ParsedBackendId,
    model_requires_anthropic_messages_api, resolve_anthropic_messages_base_url,
    resolve_http_inference_api,
};
pub use types::{
    ChatMessage, ChatRequest, ChatResponse, FunctionCall, FunctionDef, ModelInfo, Role, ToolCall,
    ToolDef, Usage,
};
