use rmcp::{
    handler::server::wrapper::Parameters,
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ServerHandler,
};

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
struct EchoParams {
    message: String,
}

#[derive(Clone)]
pub struct OmniMcpHandler {
    #[allow(dead_code)]
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

#[tool_router]
impl OmniMcpHandler {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    #[tool(description = "Health check for OmniMCP built-in server")]
    fn ping(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        Ok(CallToolResult::success(vec![Content::text("pong")]))
    }

    #[tool(description = "Return OmniPanel application information")]
    fn app_info(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let info = serde_json::json!({
            "name": "OmniPanel",
            "mcpServer": "OmniMCP",
            "version": env!("CARGO_PKG_VERSION"),
        });
        Ok(CallToolResult::success(vec![Content::text(info.to_string())]))
    }

    #[tool(description = "Echo a message back to the caller")]
    fn echo(
        &self,
        Parameters(EchoParams { message }): Parameters<EchoParams>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        Ok(CallToolResult::success(vec![Content::text(message)]))
    }
}

#[tool_handler]
impl ServerHandler for OmniMcpHandler {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions(
                "OmniMCP is the built-in MCP server of OmniPanel. \
                 It exposes basic tools for health checks and app metadata.",
            )
    }
}
