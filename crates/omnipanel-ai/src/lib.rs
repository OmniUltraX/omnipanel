pub mod ir;
pub mod orchestrator;
pub mod prompts;
pub mod provider;
pub mod providers;
pub mod routing;
pub mod types;

pub use ir::{StopReason, StreamEvent, ToolStatus};
pub use orchestrator::{
    AiContextBundle, HttpProviderSnapshot, InternalChatRequest, InternalOrchestrator,
    InternalToolsMode, ToolExecutor,
};
pub use provider::{AiProvider, AiProviderRegistry, RenamedProvider};
pub use routing::{parse_backend_id, BackendKind, ParsedBackendId};
pub use types::{
    ChatMessage, ChatRequest, ChatResponse, FunctionCall, FunctionDef, ModelInfo, Role, ToolCall,
    ToolDef, Usage,
};
