//! 跨连接文件传输：Tauri IPC 薄适配层（引擎在 `omnipanel-transfer`）。

pub use omnipanel_transfer::{
    rate_limit, FileTransferConflictPolicy, FileTransferEnqueueRequest, FileTransferEndpoint,
    FileTransferEngine, FileTransferItemSpec, FileTransferJob, FileTransferListResult,
    FileTransferOp, FileTransferPlanRequest, FileTransferPlanResult, FileTransferRoute,
    FileTransferState, TRANSFER_PROGRESS_EVENT,
};

use std::path::PathBuf;

use omnipanel_error::{ErrorCode, OmniError};
use tauri::{AppHandle, Manager, State};

use crate::commands::file_manager::{local_temp_dir, LOCAL_CONNECTION_ID};
use crate::state::AppState;
use crate::transfer_bridge::{transfer_host, transfer_sink};

#[tauri::command]
#[specta::specta]
pub async fn file_transfer_plan(
    state: State<'_, AppState>,
    request: FileTransferPlanRequest,
) -> Result<FileTransferPlanResult, OmniError> {
    let host = transfer_host(state.app_handle.clone());
    Ok(state
        .file_transfers
        .plan(host.as_ref(), &request)
        .await)
}

/// 上传浏览器拖拽/粘贴的本地文件字节到目标连接。
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
    let host = transfer_host(app.clone());
    let sink = transfer_sink(app.clone());
    let result = state
        .file_transfers
        .enqueue(host, sink, request)
        .await;

    match result {
        Ok(batch_id) => {
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
                        tracing::warn!(
                            "临时文件清理超时（1h），强制删除：{}",
                            temp_path_clone.display()
                        );
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
    let host = transfer_host(app.clone());
    let sink = transfer_sink(app);
    state.file_transfers.enqueue(host, sink, request).await
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
    let host = transfer_host(app.clone());
    let sink = transfer_sink(app);
    state
        .file_transfers
        .retry(host, sink, &job_id)
        .await
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
pub async fn file_transfer_set_rate_limit(rate_limit_bps: f64) -> Result<(), OmniError> {
    rate_limit::set_rate_limit_bps(rate_limit_bps.max(0.0) as u64);
    Ok(())
}
