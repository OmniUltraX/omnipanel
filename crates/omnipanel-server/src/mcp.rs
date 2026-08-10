//! P4 MCP 外部服务桥接（Web 端）。
//!
//! 桌面端通过 `AppState.mcp_manager`（`McpManager::bootstrap`）管理内置 OmniMCP 与
//! 自定义外部 MCP 服务（stdio / SSE），并把启用中的外部服务工具注入内部编排（AI 工具面）。
//! Web 端此前未集成：`ai_chat_stream` 的 DirectInject 只注入内置 omni_* 工具，外部 MCP
//! 工具无法调用；设置页 MCP 管理在浏览器下也不可用。
//!
//! 本模块复用 `omnipanel-mcp::McpManager`（纯 Rust，不依赖 Tauri），提供与桌面端
//! `src-tauri/src/commands/mcp.rs` 语义一致的 IPC 命令：
//!
//! - `mcp_list_services` / `mcp_upsert_service` / `mcp_delete_service`
//! - `mcp_set_service_enabled` / `mcp_set_service_running`
//! - `mcp_list_service_tools` / `mcp_call_tool`
//!
//! 并在 `ai_chat_stream` 的 DirectInject 里把启用中的外部 MCP 工具并入工具面
//! （`McpManager::to_internal_tool_defs`），执行器 `ServerToolExecutor` 对
//! `extmcp::{service_id}::{tool}` 名称走 `McpManager::call_service_tool` 桥接。
//!
//! 诚实边界：
//! - Web 端外部 MCP 调用**直接执行**（与桌面端"外部工具需审批"开关默认关时的行为一致；
//!   设置页的审批开关 `mcp_external_require_approval` 依赖 Tauri AppState，Web 端未接入，
//!   建议部署方以 `--api-key` + TLS 反代保护）。
//! - stdio 子进程在服务端机器上启动（Web「服务器版控制台」语义）。

use omnipanel_mcp::{
    McpServiceConfig, McpServiceView, McpTransport, McpTransportKind, BUILTIN_SERVICE_ID,
};
use serde::Deserialize;
use serde::Serialize;

use crate::state::ServerState;

/// `mcp_upsert_service` 入参（与桌面端 `UpsertMcpServiceInput` 同形）。
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertMcpServiceInput {
    pub id: Option<String>,
    pub name: String,
    pub enabled: bool,
    pub transport_kind: McpTransportKind,
    pub command: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: Vec<McpEnvEntry>,
    pub cwd: Option<String>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvEntry {
    pub key: String,
    pub value: String,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn build_service_config(input: UpsertMcpServiceInput) -> Result<McpServiceConfig, String> {
    let id = input
        .id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("mcp_{}", now_millis()));

    let transport = match input.transport_kind {
        McpTransportKind::Stdio => {
            let command = input.command.unwrap_or_default().trim().to_string();
            if command.is_empty() {
                return Err("stdio 命令不能为空".to_string());
            }
            let env = input
                .env
                .into_iter()
                .filter(|e| !e.key.trim().is_empty())
                .map(|e| (e.key.trim().to_string(), e.value))
                .collect();
            McpTransport::Stdio {
                config: omnipanel_mcp::McpStdioTransport {
                    command,
                    args: input.args,
                    env,
                    cwd: input.cwd.filter(|s| !s.trim().is_empty()),
                },
            }
        }
        McpTransportKind::Sse => {
            let url = input.url.unwrap_or_default().trim().to_string();
            if url.is_empty() {
                return Err("SSE URL 不能为空".to_string());
            }
            McpTransport::Sse {
                config: omnipanel_mcp::McpSseTransport { url },
            }
        }
    };

    Ok(McpServiceConfig {
        id,
        name: input.name.trim().to_string(),
        enabled: input.enabled,
        builtin: false,
        transport,
        created_at: now_millis(),
    })
}

/// 获取 MCP 管理器共享句柄（懒初始化）。
async fn shared_manager(
    state: &ServerState,
) -> Result<omnipanel_mcp::SharedMcpManager, String> {
    state
        .ensure_mcp_manager()
        .await
        .ok_or_else(|| "MCP 管理器初始化失败（详见服务端日志）".to_string())
}

pub async fn mcp_list_services(state: &ServerState) -> Result<Vec<McpServiceView>, String> {
    let shared = shared_manager(state).await?;
    let manager = shared.lock().await;
    Ok(manager.list_services())
}

pub async fn mcp_upsert_service(
    state: &ServerState,
    input: UpsertMcpServiceInput,
) -> Result<McpServiceView, String> {
    let service = build_service_config(input)?;
    let shared = shared_manager(state).await?;
    let mut manager = shared.lock().await;
    manager
        .upsert_service(service)
        .await
        .map_err(|e| e.to_string())
}

pub async fn mcp_delete_service(state: &ServerState, id: String) -> Result<(), String> {
    if id == BUILTIN_SERVICE_ID {
        return Err("不能删除内置 OmniMCP 服务".to_string());
    }
    let shared = shared_manager(state).await?;
    let mut manager = shared.lock().await;
    manager
        .delete_service(&id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn mcp_set_service_enabled(
    state: &ServerState,
    id: String,
    enabled: bool,
) -> Result<McpServiceView, String> {
    let shared = shared_manager(state).await?;
    let mut manager = shared.lock().await;
    manager
        .set_enabled(&id, enabled)
        .await
        .map_err(|e| e.to_string())
}

pub async fn mcp_set_service_running(
    state: &ServerState,
    id: String,
    running: bool,
) -> Result<McpServiceView, String> {
    let shared = shared_manager(state).await?;
    let mut manager = shared.lock().await;
    manager
        .set_service_running(&id, running)
        .await
        .map_err(|e| e.to_string())
}

pub async fn mcp_list_service_tools(
    state: &ServerState,
    id: String,
) -> Result<Vec<omnipanel_mcp::ToolInfo>, String> {
    let shared = shared_manager(state).await?;
    let manager = shared.lock().await;
    manager
        .list_service_tools(&id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn mcp_call_tool(
    state: &ServerState,
    service_id: String,
    tool_name: String,
    tool_arguments: String,
) -> Result<omnipanel_mcp::ToolCallResult, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&tool_arguments).unwrap_or(serde_json::Value::Object(Default::default()));
    let shared = shared_manager(state).await?;
    let manager = shared.lock().await;
    manager
        .call_service_tool(&service_id, &tool_name, parsed)
        .await
        .map_err(|e| e.to_string())
}

/// 设置外部 MCP 工具是否需审批（等价桌面端 `ai_gateway_configure` 的
/// `mcp_external_require_approval` 参数；Web 端独立开关）。
pub async fn mcp_set_external_require_approval(
    state: &ServerState,
    require: bool,
) -> Result<(), String> {
    state
        .mcp_external_require_approval
        .store(require, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// 供 `ai_chat_stream` 注入外部 MCP 工具面：把启用且运行中的外部服务工具
/// 并入 ToolDef 列表（复用桌面端 `McpManager::to_internal_tool_defs` 语义）。
pub async fn merge_external_tool_defs(
    state: &ServerState,
    module_filter: Option<&str>,
) -> Result<Vec<omnipanel_ai::types::ToolDef>, String> {
    // 模块隔离：指定 filter（非 master/web）时不混入外部 MCP（与桌面端一致）
    match module_filter {
        None | Some("master") | Some("web") => {}
        Some(_) => return Ok(Vec::new()),
    }
    let shared = shared_manager(state).await?;
    let manager = shared.lock().await;
    manager
        .to_internal_tool_defs(module_filter)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stdio_input() -> UpsertMcpServiceInput {
        UpsertMcpServiceInput {
            id: None,
            name: "test".to_string(),
            enabled: true,
            transport_kind: McpTransportKind::Stdio,
            command: Some("npx".to_string()),
            args: vec!["-y".to_string(), "some-mcp".to_string()],
            env: vec![McpEnvEntry { key: "FOO".to_string(), value: "bar".to_string() }],
            cwd: None,
            url: None,
        }
    }

    #[test]
    fn stdio_config_requires_command() {
        let mut input = stdio_input();
        input.command = None;
        assert!(build_service_config(input).is_err());
    }

    #[test]
    fn stdio_config_builds() {
        let cfg = build_service_config(stdio_input()).expect("build");
        assert!(cfg.id.starts_with("mcp_"));
        assert!(!cfg.builtin);
        let McpTransport::Stdio { config } = &cfg.transport else {
            panic!("期望 stdio transport");
        };
        assert_eq!(config.command, "npx");
        assert_eq!(config.env.get("FOO").map(|s| s.as_str()), Some("bar"));
    }

    #[test]
    fn sse_config_requires_url() {
        let mut input = stdio_input();
        input.transport_kind = McpTransportKind::Sse;
        input.url = None;
        assert!(build_service_config(input).is_err());
        let mut input = stdio_input();
        input.transport_kind = McpTransportKind::Sse;
        input.url = Some("http://127.0.0.1:18080/mcp".to_string());
        let cfg = build_service_config(input).expect("build");
        let McpTransport::Sse { config } = &cfg.transport else {
            panic!("期望 sse transport");
        };
        assert_eq!(config.url, "http://127.0.0.1:18080/mcp");
    }
}
