mod builtin;
mod client;
mod exposed_tools;
mod manager;
mod omni_module;
mod process;
mod registry;
mod store;
mod types;

pub use manager::{McpManager, SharedMcpManager};
pub use registry::{external, web, web_tools, RegisteredTool, ToolExecutionKind, ToolRegistry};
pub use types::{
    McpServiceConfig, McpServiceRuntimeStatus, McpServiceView, McpServicesFile, McpSseTransport,
    McpStdioTransport, ToolCallResult, ToolInfo, McpTransport, McpTransportKind,
    BUILTIN_MCP_ENDPOINT,
    BUILTIN_MCP_PORT,
    BUILTIN_SERVICE_ID,
    BUILTIN_SERVICE_NAME, OMNI_MODULE_MASTER, X_OMNI_MODULE_HEADER,
};
