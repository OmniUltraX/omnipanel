//! 个人待办（MS To Do 对齐）IPC。

use omnipanel_error::OmniError;
use omnipanel_store::{TodoList, TodoStep, TodoTask, TodoTaskQuery};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn todo_list_list(state: State<'_, AppState>) -> Result<Vec<TodoList>, OmniError> {
    let storage = state.storage.lock().await;
    storage.ensure_todo_schema_data()?;
    storage.list_todo_lists()
}

#[tauri::command]
#[specta::specta]
pub async fn todo_list_save(
    state: State<'_, AppState>,
    list: TodoList,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_todo_list(&list)
}

#[tauri::command]
#[specta::specta]
pub async fn todo_list_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_todo_list(&id)
}

#[tauri::command]
#[specta::specta]
pub async fn todo_task_list(
    state: State<'_, AppState>,
    query: TodoTaskQuery,
) -> Result<Vec<TodoTask>, OmniError> {
    let storage = state.storage.lock().await;
    storage.ensure_todo_schema_data()?;
    storage.list_todo_tasks(&query)
}

#[tauri::command]
#[specta::specta]
pub async fn todo_task_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<TodoTask>, OmniError> {
    let storage = state.storage.lock().await;
    storage.get_todo_task(&id)
}

#[tauri::command]
#[specta::specta]
pub async fn todo_task_save(
    state: State<'_, AppState>,
    task: TodoTask,
    replace_steps: bool,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_todo_task(&task, replace_steps)
}

#[tauri::command]
#[specta::specta]
pub async fn todo_task_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_todo_task(&id)
}

#[tauri::command]
#[specta::specta]
pub async fn todo_step_save(state: State<'_, AppState>, step: TodoStep) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_todo_step(&step)
}

#[tauri::command]
#[specta::specta]
pub async fn todo_step_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_todo_step(&id)
}
