use omnipanel_error::OmniError;
use omnipanel_store::{McpToolCatalogEntry, McpToolRecord};
use tauri::State;

use crate::state::AppState;

/// 列出全部 MCP 工具配置。
#[tauri::command]
#[specta::specta]
pub async fn mcp_tool_list(state: State<'_, AppState>) -> Result<Vec<McpToolRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.mcp_tool_list()
}

/// 设置 MCP 工具启用状态。
#[tauri::command]
#[specta::specta]
pub async fn mcp_tool_set_enabled(
    state: State<'_, AppState>,
    tool_name: String,
    enabled: bool,
) -> Result<McpToolRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.mcp_tool_set_enabled(&tool_name, enabled)
}

/// 从前端目录同步 MCP 工具元数据（不覆盖 enabled）。
#[tauri::command]
#[specta::specta]
pub async fn mcp_tool_sync_catalog(
    state: State<'_, AppState>,
    entries: Vec<McpToolCatalogEntry>,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.mcp_tool_sync_catalog(&entries)
}
