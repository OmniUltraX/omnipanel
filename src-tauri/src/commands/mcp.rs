use std::sync::Arc;

use omnipanel_mcp::{
    McpManager, McpServiceConfig, McpServiceView, McpServicesFile, McpTransport, McpTransportKind,
    BUILTIN_SERVICE_ID,
};
use omnipanel_store::Storage;
use tauri::State;
use tokio::sync::Mutex;

use crate::state::AppState;

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
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

#[derive(Debug, Clone, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct McpEnvEntry {
    pub key: String,
    pub value: String,
}

fn map_err(err: anyhow::Error) -> String {
    err.to_string()
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_list_services(state: State<'_, AppState>) -> Result<Vec<McpServiceView>, String> {
    let manager = state.mcp_manager.lock().await;
    Ok(manager.list_services())
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_upsert_service(
    state: State<'_, AppState>,
    input: UpsertMcpServiceInput,
) -> Result<McpServiceView, String> {
    let service = build_service_config(input)?;
    let mut manager = state.mcp_manager.lock().await;
    manager.upsert_service(service).await.map_err(map_err)
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_delete_service(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if id == BUILTIN_SERVICE_ID {
        return Err("不能删除内置 OmniMCP 服务".to_string());
    }
    let mut manager = state.mcp_manager.lock().await;
    manager.delete_service(&id).await.map_err(map_err)
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_set_service_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<McpServiceView, String> {
    let mut manager = state.mcp_manager.lock().await;
    manager
        .set_enabled(&id, enabled)
        .await
        .map_err(map_err)
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_set_service_running(
    state: State<'_, AppState>,
    id: String,
    running: bool,
) -> Result<McpServiceView, String> {
    let mut manager = state.mcp_manager.lock().await;
    manager
        .set_service_running(&id, running)
        .await
        .map_err(map_err)
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_list_service_tools(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<omnipanel_mcp::McpToolInfo>, String> {
    let manager = state.mcp_manager.lock().await;
    manager.list_service_tools(&id).await.map_err(map_err)
}

#[tauri::command]
#[specta::specta]
pub async fn mcp_call_tool(
    state: State<'_, AppState>,
    service_id: String,
    tool_name: String,
    tool_arguments: String,
) -> Result<omnipanel_mcp::McpToolCallResult, String> {
    let parsed: serde_json::Value =
        serde_json::from_str(&tool_arguments).unwrap_or(serde_json::Value::Object(Default::default()));
    let manager = state.mcp_manager.lock().await;
    manager
        .call_service_tool(&service_id, &tool_name, parsed)
        .await
        .map_err(map_err)
}

fn build_service_config(input: UpsertMcpServiceInput) -> Result<McpServiceConfig, String> {
    let id = input
        .id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("mcp_{}", chrono_like_id()));

    let transport = match input.transport_kind {
        McpTransportKind::Stdio => {
            let command = input
                .command
                .unwrap_or_default()
                .trim()
                .to_string();
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

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn chrono_like_id() -> String {
    format!(
        "{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

pub async fn init_mcp_manager(
    storage: Arc<Mutex<Storage>>,
) -> Result<Arc<Mutex<McpManager>>, String> {
    McpManager::bootstrap(storage)
        .await
        .map(|manager| Arc::new(Mutex::new(manager)))
        .map_err(|e| e.to_string())
}

#[allow(dead_code)]
pub fn empty_services_file() -> McpServicesFile {
    McpServicesFile::default()
}
