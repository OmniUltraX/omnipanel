use omnipanel_error::OmniError;
use omnipanel_store::{SaveTaskRequest, Task, TaskStatus};
use tauri::State;

use crate::state::AppState;

/// 列出任务，可选按状态过滤。
#[tauri::command]
#[specta::specta]
pub async fn task_list(
    state: State<'_, AppState>,
    status_filter: Option<String>,
    limit: u32,
) -> Result<Vec<Task>, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_list(status_filter.as_deref(), limit)
}

/// 获取单个任务。
#[tauri::command]
#[specta::specta]
pub async fn task_get(state: State<'_, AppState>, id: String) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_get(&id)
}

/// 创建或更新任务。
#[tauri::command]
#[specta::specta]
pub async fn task_save(
    state: State<'_, AppState>,
    req: SaveTaskRequest,
) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_save(&req)
}

/// 更新任务状态。
#[tauri::command]
#[specta::specta]
pub async fn task_update_status(
    state: State<'_, AppState>,
    id: String,
    status: TaskStatus,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.task_update_status(&id, &status)
}

/// 删除任务。
#[tauri::command]
#[specta::specta]
pub async fn task_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.task_delete(&id)
}
