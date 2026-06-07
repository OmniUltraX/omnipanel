use omnipanel_error::OmniError;
use omnipanel_store::{SaveWorkflowRequest, Workflow, WorkflowDetail, WorkflowExecution};
use tauri::State;

use crate::state::AppState;

/// 列出所有工作流。
#[tauri::command]
#[specta::specta]
pub async fn workflow_list(state: State<'_, AppState>) -> Result<Vec<Workflow>, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_list()
}

/// 按 id 获取工作流详情（含步骤）。
#[tauri::command]
#[specta::specta]
pub async fn workflow_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_get(&id)
}

/// 创建或更新工作流。
#[tauri::command]
#[specta::specta]
pub async fn workflow_save(
    state: State<'_, AppState>,
    req: SaveWorkflowRequest,
) -> Result<WorkflowDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_save(&req)
}

/// 删除工作流（级联删除步骤和执行记录）。
#[tauri::command]
#[specta::specta]
pub async fn workflow_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_delete(&id)
}

/// 获取工作流执行历史。
#[tauri::command]
#[specta::specta]
pub async fn workflow_executions(
    state: State<'_, AppState>,
    workflow_id: String,
    limit: u32,
) -> Result<Vec<WorkflowExecution>, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_executions(&workflow_id, limit)
}
