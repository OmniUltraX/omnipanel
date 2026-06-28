use omnipanel_error::OmniError;
use omnipanel_store::{AppModule, AppModuleStatus};
use tauri::State;

use crate::state::AppState;

/// 列出全部应用模块及其状态。
#[tauri::command]
#[specta::specta]
pub async fn app_module_list(state: State<'_, AppState>) -> Result<Vec<AppModule>, OmniError> {
    let storage = state.storage.lock().await;
    storage.app_module_list()
}

/// 设置单个模块状态（open / closed；disabled 模块不可修改）。
#[tauri::command]
#[specta::specta]
pub async fn app_module_set_status(
    state: State<'_, AppState>,
    module_key: String,
    status: AppModuleStatus,
) -> Result<AppModule, OmniError> {
    let storage = state.storage.lock().await;
    storage.app_module_set_status(&module_key, status)
}
