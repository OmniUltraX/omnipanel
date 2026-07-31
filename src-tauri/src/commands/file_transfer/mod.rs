//! 跨连接文件传输引擎：FastPath / RemoteDirect / StreamRelay。

mod engine;
mod expand;
mod fastpath;
mod rate_limit;
mod remote_direct;
mod resume;
mod stream_relay;
mod types;
mod util;

pub use engine::FileTransferEngine;
pub use types::{
    FileTransferEnqueueRequest, FileTransferPlanRequest, FileTransferPlanResult,
};

use tauri::{AppHandle, State};

use omnipanel_error::OmniError;

use crate::state::AppState;

use types::FileTransferListResult;

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_plan(
    state: State<'_, AppState>,
    request: FileTransferPlanRequest,
) -> Result<FileTransferPlanResult, OmniError> {
    Ok(state.file_transfers.plan(&state, &request).await)
}

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_enqueue(
    app: AppHandle,
    state: State<'_, AppState>,
    request: FileTransferEnqueueRequest,
) -> Result<String, OmniError> {
    let _ = &state;
    state.file_transfers.enqueue(app, request).await
}

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_list(
    state: State<'_, AppState>,
) -> Result<FileTransferListResult, OmniError> {
    Ok(state.file_transfers.list().await)
}

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_cancel(
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), OmniError> {
    state.file_transfers.cancel(&job_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_retry(
    app: AppHandle,
    state: State<'_, AppState>,
    job_id: String,
) -> Result<(), OmniError> {
    let _ = &state;
    state.file_transfers.retry(app, &job_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_clear_finished(state: State<'_, AppState>) -> Result<(), OmniError> {
    state.file_transfers.clear_finished().await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_set_concurrency(
    state: State<'_, AppState>,
    concurrency: u32,
) -> Result<(), OmniError> {
    state.file_transfers.set_concurrency(concurrency).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
// 速率可超 u32 范围，用 f64 承载（IPC 本就是 JSON number），避免 specta 拒绝 u64
pub async fn file_transfer_set_rate_limit(rate_limit_bps: f64) -> Result<(), OmniError> {
    rate_limit::set_rate_limit_bps(rate_limit_bps.max(0.0) as u64);
    Ok(())
}
