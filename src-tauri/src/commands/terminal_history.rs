use omnipanel_error::OmniError;
use omnipanel_store::{TerminalHistoryBlockRecord, TerminalHistoryRetainPolicy};
use tauri::State;

use crate::state::AppState;

/// 加载指定会话的终端历史块（按 timestamp 升序）。
#[tauri::command]
#[specta::specta]
pub async fn terminal_history_load_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<TerminalHistoryBlockRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.terminal_history_load_session(&session_id)
}

/// 增量 upsert 会话内块，并按保留策略 prune。
#[tauri::command]
#[specta::specta]
pub async fn terminal_history_upsert_blocks(
    state: State<'_, AppState>,
    session_id: String,
    workspace_id: Option<String>,
    blocks: Vec<TerminalHistoryBlockRecord>,
    policy: TerminalHistoryRetainPolicy,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.terminal_history_upsert_blocks(
        &session_id,
        workspace_id.as_deref(),
        &blocks,
        &policy,
    )
}

/// 删除单个历史块。
#[tauri::command]
#[specta::specta]
pub async fn terminal_history_remove_block(
    state: State<'_, AppState>,
    session_id: String,
    block_id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.terminal_history_remove_block(&session_id, &block_id)
}

/// 清除单个会话的历史。
#[tauri::command]
#[specta::specta]
pub async fn terminal_history_clear_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.terminal_history_clear_session(&session_id)
}

/// 清除全部终端历史。
#[tauri::command]
#[specta::specta]
pub async fn terminal_history_clear_all(state: State<'_, AppState>) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.terminal_history_clear_all()
}

/// 返回 (sessions, blocks) 计数，供设置页展示。
#[tauri::command]
#[specta::specta]
pub async fn terminal_history_counts(state: State<'_, AppState>) -> Result<(u32, u32), OmniError> {
    let storage = state.storage.lock().await;
    storage.terminal_history_counts()
}
