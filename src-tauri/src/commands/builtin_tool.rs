use omnipanel_error::OmniError;
use omnipanel_store::{BuiltinToolCatalogEntry, BuiltinToolRecord};
use tauri::State;

use crate::state::AppState;

/// 列出全部内置工具配置。
#[tauri::command]
#[specta::specta]
pub async fn builtin_tool_list(state: State<'_, AppState>) -> Result<Vec<BuiltinToolRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_list()
}

/// 设置内置工具「内部可用」。
#[tauri::command]
#[specta::specta]
pub async fn builtin_tool_set_internal_enabled(
    state: State<'_, AppState>,
    tool_name: String,
    enabled: bool,
) -> Result<BuiltinToolRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_set_internal_enabled(&tool_name, enabled)
}

/// 设置内置工具「对外暴露」。
#[tauri::command]
#[specta::specta]
pub async fn builtin_tool_set_external_exposed(
    state: State<'_, AppState>,
    tool_name: String,
    exposed: bool,
) -> Result<BuiltinToolRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_set_external_exposed(&tool_name, exposed)
}

/// 设置内置工具启用状态（兼容旧 API，等同 internal_enabled）。
#[tauri::command]
#[specta::specta]
pub async fn builtin_tool_set_enabled(
    state: State<'_, AppState>,
    tool_name: String,
    enabled: bool,
) -> Result<BuiltinToolRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_set_enabled(&tool_name, enabled)
}

/// 从前端目录同步内置工具元数据（不覆盖开关）。
#[tauri::command]
#[specta::specta]
pub async fn builtin_tool_sync_catalog(
    state: State<'_, AppState>,
    entries: Vec<BuiltinToolCatalogEntry>,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_sync_catalog(&entries)
}
