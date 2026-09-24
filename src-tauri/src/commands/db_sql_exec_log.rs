use omnipanel_error::OmniResult;
use omnipanel_store::{
    SqlExecAppend, SqlExecListFilter, SqlExecRecord, SqlExecResultPage, append_sql_execution,
    clear_sql_executions, delete_sql_execution, get_sql_execution_result, list_sql_executions,
    rebind_sql_execution_file, set_sql_execution_pinned,
};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
#[specta::specta]
pub async fn db_sql_exec_append(
    state: State<'_, AppState>,
    input: SqlExecAppend,
) -> OmniResult<SqlExecRecord> {
    let storage = state.storage.lock().await;
    append_sql_execution(&storage, &input)
}

#[tauri::command]
#[specta::specta]
pub async fn db_sql_exec_list(
    state: State<'_, AppState>,
    filter: SqlExecListFilter,
) -> OmniResult<Vec<SqlExecRecord>> {
    let storage = state.storage.lock().await;
    list_sql_executions(&storage, &filter)
}

#[tauri::command]
#[specta::specta]
pub async fn db_sql_exec_result(
    state: State<'_, AppState>,
    id: String,
) -> OmniResult<Option<SqlExecResultPage>> {
    let storage = state.storage.lock().await;
    get_sql_execution_result(&storage, &id)
}

#[tauri::command]
#[specta::specta]
pub async fn db_sql_exec_set_pinned(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> OmniResult<()> {
    let storage = state.storage.lock().await;
    set_sql_execution_pinned(&storage, &id, pinned)
}

#[tauri::command]
#[specta::specta]
pub async fn db_sql_exec_delete(state: State<'_, AppState>, id: String) -> OmniResult<()> {
    let storage = state.storage.lock().await;
    delete_sql_execution(&storage, &id)
}

#[tauri::command]
#[specta::specta]
pub async fn db_sql_exec_clear(state: State<'_, AppState>, connection_id: String) -> OmniResult<u32> {
    let storage = state.storage.lock().await;
    clear_sql_executions(&storage, &connection_id)
}

#[tauri::command]
#[specta::specta]
pub async fn db_sql_exec_rebind_file(
    state: State<'_, AppState>,
    tab_id: String,
    sql_file_id: String,
) -> OmniResult<u32> {
    let storage = state.storage.lock().await;
    rebind_sql_execution_file(&storage, &tab_id, &sql_file_id)
}
