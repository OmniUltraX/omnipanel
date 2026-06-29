use anyhow::Context;
use http::{HeaderName, HeaderValue};
use rmcp::{
    model::CallToolRequestParams,
    service::RunningService,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
        TokioChildProcess,
    },
    ClientHandler, RoleClient, ServiceExt,
};
use std::collections::HashMap;

use crate::types::{McpStdioTransport, McpToolCallResult, McpToolInfo, X_OMNI_MODULE_HEADER};
use crate::process::stdio_command;

#[derive(Clone, Default)]
struct ToolListClient;

impl ClientHandler for ToolListClient {}

fn http_transport_config(
    url: &str,
    module_key: Option<&str>,
) -> anyhow::Result<StreamableHttpClientTransportConfig> {
    let mut config = StreamableHttpClientTransportConfig::with_uri(url);
    if let Some(module) = module_key.map(str::trim).filter(|m| !m.is_empty()) {
        let value = HeaderValue::from_str(module)
            .with_context(|| format!("无效的 X-Omni-Module 值: {module}"))?;
        let mut headers = HashMap::new();
        headers.insert(HeaderName::from_static(X_OMNI_MODULE_HEADER), value);
        config = config.custom_headers(headers);
    }
    Ok(config)
}

pub async fn list_tools_http(url: &str) -> anyhow::Result<Vec<McpToolInfo>> {
    list_tools_http_for_module(url, None).await
}

pub async fn list_tools_http_for_module(
    url: &str,
    module_key: Option<&str>,
) -> anyhow::Result<Vec<McpToolInfo>> {
    let transport =
        StreamableHttpClientTransport::from_config(http_transport_config(url, module_key)?);
    let mut client = ToolListClient
        .serve(transport)
        .await
        .context("连接 MCP 服务失败")?;
    collect_tools(&mut client).await
}

pub async fn list_tools_stdio(config: &McpStdioTransport) -> anyhow::Result<Vec<McpToolInfo>> {
    let command = stdio_command(config);
    let transport = TokioChildProcess::new(command).context("spawn MCP stdio 客户端失败")?;
    let mut client = ToolListClient
        .serve(transport)
        .await
        .context("连接 MCP 服务失败")?;
    collect_tools(&mut client).await
}

async fn collect_tools(client: &mut RunningService<RoleClient, ToolListClient>) -> anyhow::Result<Vec<McpToolInfo>> {
    let tools = client
        .list_all_tools()
        .await
        .context("获取 MCP 工具列表失败")?;
    let _ = client.close().await;
    Ok(tools
        .into_iter()
        .map(|tool| McpToolInfo {
            name: tool.name.to_string(),
            description: tool.description.map(|d| d.to_string()),
        })
        .collect())
}

pub async fn call_tool_http(
    url: &str,
    tool_name: &str,
    arguments: serde_json::Value,
) -> anyhow::Result<McpToolCallResult> {
    call_tool_http_for_module(url, None, tool_name, arguments).await
}

pub async fn call_tool_http_for_module(
    url: &str,
    module_key: Option<&str>,
    tool_name: &str,
    arguments: serde_json::Value,
) -> anyhow::Result<McpToolCallResult> {
    let transport =
        StreamableHttpClientTransport::from_config(http_transport_config(url, module_key)?);
    let mut client = ToolListClient
        .serve(transport)
        .await
        .context("连接 MCP 服务失败")?;
    let result = invoke_tool(&mut client, tool_name, arguments).await?;
    let _ = client.close().await;
    Ok(result)
}

pub async fn call_tool_stdio(
    config: &McpStdioTransport,
    tool_name: &str,
    arguments: serde_json::Value,
) -> anyhow::Result<McpToolCallResult> {
    let command = stdio_command(config);
    let transport = TokioChildProcess::new(command).context("spawn MCP stdio 客户端失败")?;
    let mut client = ToolListClient
        .serve(transport)
        .await
        .context("连接 MCP 服务失败")?;
    let result = invoke_tool(&mut client, tool_name, arguments).await?;
    let _ = client.close().await;
    Ok(result)
}

async fn invoke_tool(
    client: &mut RunningService<RoleClient, ToolListClient>,
    tool_name: &str,
    arguments: serde_json::Value,
) -> anyhow::Result<McpToolCallResult> {
    let args = match arguments {
        serde_json::Value::Object(map) => map,
        serde_json::Value::Null => serde_json::Map::new(),
        other => {
            let mut map = serde_json::Map::new();
            map.insert("input".to_string(), other);
            map
        }
    };
    let result = client
        .call_tool(
            CallToolRequestParams::new(tool_name.to_string()).with_arguments(args),
        )
        .await
        .context("调用 MCP 工具失败")?;
    Ok(format_call_tool_result(result))
}

fn format_call_tool_result(result: rmcp::model::CallToolResult) -> McpToolCallResult {
    let is_error = result.is_error.unwrap_or(false);
    let content = if let Some(structured) = result.structured_content {
        structured.to_string()
    } else if result.content.is_empty() {
        String::new()
    } else {
        serde_json::to_string(&result.content).unwrap_or_default()
    };
    McpToolCallResult { content, is_error }
}
