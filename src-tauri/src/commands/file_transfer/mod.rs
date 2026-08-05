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

use tauri::{AppHandle, Manager, State};

use omnipanel_error::{ErrorCode, OmniError};

use crate::state::AppState;

use types::{
    FileTransferConflictPolicy, FileTransferItemSpec, FileTransferListResult, FileTransferOp,
    FileTransferState,
};

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_plan(
    state: State<'_, AppState>,
    request: FileTransferPlanRequest,
) -> Result<FileTransferPlanResult, OmniError> {
    Ok(state.file_transfers.plan(&state, &request).await)
}

/// 上传浏览器拖拽/粘贴的本地文件字节到目标连接。
///
/// 用于 SftpPanel/终端拖拽 File 对象（无绝对路径）的场景：
/// 后端先把 bytes 写入本地临时文件，再入队传输引擎（自动获得进度/取消/断点续传）。
/// 返回 batch_id，前端可通过 `files-transfer-progress` 事件监听进度。
#[tauri::command]
#[specta::specta]
pub async fn file_transfer_upload_local_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    file_name: String,
    data: Vec<u8>,
    dest_connection_id: String,
    dest_dir: String,
    conflict_policy: FileTransferConflictPolicy,
) -> Result<String, OmniError> {
    use crate::commands::file_manager::{local_temp_dir, LOCAL_CONNECTION_ID};
    use std::path::PathBuf;

    // 允许空文件（0 字节）上传；内容经临时文件入队。

    // 写入本地临时文件
    let temp_dir = local_temp_dir().map_err(|e| {
        OmniError::new(ErrorCode::Io, "获取临时目录失败").with_cause(e.to_string())
    })?;
    let temp_dir = PathBuf::from(temp_dir);
    tokio::fs::create_dir_all(&temp_dir).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建临时目录失败").with_cause(e.to_string())
    })?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe_name = file_name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let temp_path = temp_dir.join(format!("omnipanel-upload-{stamp}-{safe_name}"));
    tokio::fs::write(&temp_path, &data).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入临时文件失败").with_cause(e.to_string())
    })?;

    let size = data.len() as f64;
    let temp_path_str = temp_path.to_string_lossy().into_owned();

    let request = FileTransferEnqueueRequest {
        items: vec![FileTransferItemSpec {
            connection_id: LOCAL_CONNECTION_ID.to_string(),
            path: temp_path_str,
            kind: "file".into(),
            name: file_name,
            size: Some(size),
        }],
        dest_connection_id,
        dest_dir,
        op: FileTransferOp::Copy,
        conflict_policy,
        force_route: None,
        remote_direct_policy: "never".into(),
    };
    let result = state.file_transfers.enqueue(app.clone(), request).await;

    match result {
        Ok(batch_id) => {
            // 传输是异步的，启动清理任务：轮询批次状态，全部终态后删除临时文件。
            // 安全超时 1 小时，防止异常泄漏。
            let app_clone = app.clone();
            let temp_path_clone = temp_path.clone();
            let batch_id_clone = batch_id.clone();
            tokio::spawn(async move {
                let timeout = tokio::time::Duration::from_secs(3600);
                let interval = tokio::time::Duration::from_secs(2);
                let deadline = tokio::time::Instant::now() + timeout;
                loop {
                    tokio::time::sleep(interval).await;
                    if tokio::time::Instant::now() > deadline {
                        let _ = tokio::fs::remove_file(&temp_path_clone).await;
                        tracing::warn!("临时文件清理超时（1h），强制删除：{}", temp_path_clone.display());
                        return;
                    }
                    let state = app_clone.state::<AppState>();
                    let list = state.file_transfers.list().await;
                    let batch_jobs: Vec<_> = list
                        .jobs
                        .iter()
                        .filter(|j| j.batch_id == batch_id_clone)
                        .collect();
                    if batch_jobs.is_empty() {
                        // 批次已被清理（clear_finished），直接删临时文件
                        let _ = tokio::fs::remove_file(&temp_path_clone).await;
                        return;
                    }
                    let all_terminal = batch_jobs.iter().all(|j| {
                        matches!(
                            j.state,
                            FileTransferState::Done
                                | FileTransferState::Error
                                | FileTransferState::Cancelled
                        )
                    });
                    if all_terminal {
                        let _ = tokio::fs::remove_file(&temp_path_clone).await;
                        return;
                    }
                }
            });
            Ok(batch_id)
        }
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_path).await;
            Err(e)
        }
    }
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
