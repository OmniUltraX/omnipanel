mod builtin;
mod client;
mod embedding;
mod exposed_tools;
mod manager;
mod omni_module;
mod process;
mod registry;
mod store;
mod types;

pub use manager::{McpManager, SharedMcpManager};
pub use registry::{
    RegisteredTool, ToolExecutionKind, ToolRegistry, external, plugin_tools, web, web_tools,
};
pub use types::{
    BUILTIN_MCP_ENDPOINT, BUILTIN_MCP_PORT, BUILTIN_SERVICE_ID, BUILTIN_SERVICE_NAME,
    McpServiceConfig, McpServiceRuntimeStatus, McpServiceView, McpServicesFile, McpSseTransport,
    McpStdioTransport, McpTransport, McpTransportKind, OMNI_MODULE_MASTER, ToolCallResult,
    ToolInfo, X_OMNI_MODULE_HEADER, builtin_mcp_endpoint,
};
