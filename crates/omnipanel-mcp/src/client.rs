use anyhow::Context;
use rmcp::{
    model::CallToolRequestParams,
    service::RunningService,
    transport::{
        streamable_http_client::StreamableHttpClientTransport, TokioChildProcess,
    },
    ClientHandler, RoleClient, ServiceExt,
};
use tokio::process::Command;

use crate::types::{McpStdioTransport, McpToolCallResult, McpToolInfo};

#[derive(Clone, Default)]
struct ToolListClient;

impl ClientHandler for ToolListClient {}

pub async fn list_tools_http(url: &str) -> anyhow::Result<Vec<McpToolInfo>> {
    let transport = StreamableHttpClientTransport::from_uri(url);
    let mut client = ToolListClient
        .serve(transport)
        .await
        .context("连接 MCP 服务失败")?;
    collect_tools(&mut client).await
}

pub async fn list_tools_stdio(config: &McpStdioTransport) -> anyhow::Result<Vec<McpToolInfo>> {
    let mut command = Command::new(&config.command);
    command.args(&config.args);
    if let Some(cwd) = &config.cwd {
        if !cwd.trim().is_empty() {
            command.current_dir(cwd);
        }
    }
    for (key, value) in &config.env {
        command.env(key, value);
    }
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
    let transport = StreamableHttpClientTransport::from_uri(url);
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
    let mut command = Command::new(&config.command);
    command.args(&config.args);
    if let Some(cwd) = &config.cwd {
        if !cwd.trim().is_empty() {
            command.current_dir(cwd);
        }
    }
    for (key, value) in &config.env {
        command.env(key, value);
    }
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
