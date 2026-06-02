use tauri::State;

use crate::log_store::LogEntry;
use crate::state::AppState;

/// 获取所有后台日志（按时间正序）。
#[tauri::command]
pub async fn get_backend_logs(state: State<'_, AppState>) -> Result<Vec<LogEntry>, String> {
    Ok(state.log_store.get_all().await)
}

/// 清空后台日志。
#[tauri::command]
pub async fn clear_backend_logs(state: State<'_, AppState>) -> Result<(), String> {
    state.log_store.clear().await;
    Ok(())
}
