//! 终端历史 IPC（对接 omnipanel-store）。

use omnipanel_error::OmniResult;
use omnipanel_store::{TerminalHistoryBlockRecord, TerminalHistoryRetainPolicy};

use crate::terminal::ServerState;

pub async fn terminal_history_load_session(
    state: &ServerState,
    session_id: String,
) -> OmniResult<Vec<TerminalHistoryBlockRecord>> {
    let storage = state.storage.lock().await;
    storage.terminal_history_load_session(&session_id)
}

pub async fn terminal_history_upsert_blocks(
    state: &ServerState,
    session_id: String,
    workspace_id: Option<String>,
    blocks: Vec<TerminalHistoryBlockRecord>,
    policy: TerminalHistoryRetainPolicy,
) -> OmniResult<()> {
    let storage = state.storage.lock().await;
    storage.terminal_history_upsert_blocks(
        &session_id,
        workspace_id.as_deref(),
        &blocks,
        &policy,
    )
}

pub async fn terminal_history_remove_block(
    state: &ServerState,
    session_id: String,
    block_id: String,
) -> OmniResult<()> {
    let storage = state.storage.lock().await;
    storage.terminal_history_remove_block(&session_id, &block_id)
}

pub async fn terminal_history_clear_session(
    state: &ServerState,
    session_id: String,
) -> OmniResult<()> {
    let storage = state.storage.lock().await;
    storage.terminal_history_clear_session(&session_id)
}

pub async fn terminal_history_clear_all(state: &ServerState) -> OmniResult<()> {
    let storage = state.storage.lock().await;
    storage.terminal_history_clear_all()
}

pub async fn terminal_history_counts(state: &ServerState) -> OmniResult<(u32, u32)> {
    let storage = state.storage.lock().await;
    storage.terminal_history_counts()
}
