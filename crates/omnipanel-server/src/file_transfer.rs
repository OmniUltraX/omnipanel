//! 桌面端 `file_transfer_*` IPC 的 Web 薄适配层。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub use omnipanel_transfer::{
    FileTransferConflictPolicy, FileTransferEndpoint, FileTransferEnqueueRequest,
    FileTransferItemSpec, FileTransferJob, FileTransferListResult, FileTransferOp,
    FileTransferPlanRequest, FileTransferPlanResult, FileTransferRoute, FileTransferState,
    TRANSFER_PROGRESS_EVENT, WebFileTransferEngine,
    rate_limit::{rate_limit_bps, set_rate_limit_bps},
};

use crate::files::LOCAL_CONNECTION_ID;
use crate::terminal::ServerState;
use crate::transfer_host::{transfer_host, transfer_sink};

pub type FileTransferEngine = WebFileTransferEngine;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub async fn file_transfer_plan(
    state: &Arc<ServerState>,
    request: FileTransferPlanRequest,
) -> Result<FileTransferPlanResult, String> {
    let host = transfer_host(state.clone());
    Ok(state.file_transfers.plan(host.as_ref(), &request).await)
}

pub async fn file_transfer_enqueue(
    state: Arc<ServerState>,
    request: FileTransferEnqueueRequest,
) -> Result<String, String> {
    let host = transfer_host(state.clone());
    let sink = transfer_sink(state.bus.clone());
    state
        .file_transfers
        .enqueue(host, sink, request)
        .await
        .map_err(|e| e.user_message())
}

pub async fn file_transfer_list(
    state: &Arc<ServerState>,
) -> Result<FileTransferListResult, String> {
    Ok(state.file_transfers.list().await)
}

pub async fn file_transfer_cancel(state: &Arc<ServerState>, job_id: String) -> Result<(), String> {
    state
        .file_transfers
        .cancel(&job_id)
        .await
        .map_err(|e| e.user_message())
}

pub async fn file_transfer_retry(state: Arc<ServerState>, job_id: String) -> Result<(), String> {
    let job = {
        let jobs = state.file_transfers.jobs.lock().await;
        jobs.get(&job_id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())?
    };
    if !matches!(
        job.state,
        FileTransferState::Error | FileTransferState::Cancelled
    ) {
        return Err("任务不可重试".to_string());
    }
    let request = FileTransferEnqueueRequest {
        items: vec![FileTransferItemSpec {
            connection_id: job.source.connection_id.clone(),
            path: job.source.path.clone(),
            kind: job.source.kind.clone(),
            name: job.source.name.clone(),
            size: job.bytes_total,
        }],
        dest_connection_id: job.dest.connection_id.clone(),
        dest_dir: job.dest.path.clone(),
        op: job.op.clone(),
        conflict_policy: FileTransferConflictPolicy::Overwrite,
        force_route: Some(FileTransferRoute::Relay),
        remote_direct_policy: "never".into(),
    };
    {
        let mut jobs = state.file_transfers.jobs.lock().await;
        jobs.remove(&job_id);
    }
    file_transfer_enqueue(state, request).await.map(|_| ())
}

pub async fn file_transfer_clear_finished(state: &Arc<ServerState>) -> Result<(), String> {
    state.file_transfers.clear_finished().await;
    Ok(())
}

pub async fn file_transfer_dismiss(state: &Arc<ServerState>, job_id: String) -> Result<(), String> {
    state
        .file_transfers
        .dismiss_finished(&job_id)
        .await
        .map_err(|e| e.user_message())
}

pub async fn file_transfer_set_concurrency(
    state: &Arc<ServerState>,
    concurrency: u32,
) -> Result<(), String> {
    state.file_transfers.set_concurrency(concurrency).await;
    Ok(())
}

pub async fn file_transfer_set_rate_limit(rate_limit_bps: Option<f64>) -> Result<(), String> {
    set_rate_limit_bps(rate_limit_bps.unwrap_or(0.0).max(0.0) as u64);
    Ok(())
}

pub async fn file_transfer_upload_local_bytes(
    state: Arc<ServerState>,
    file_name: String,
    data: Vec<u8>,
    dest_connection_id: String,
    dest_dir: String,
    conflict_policy: FileTransferConflictPolicy,
) -> Result<String, String> {
    let temp_dir = std::env::temp_dir().join("omnipanel-uploads");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| format!("创建临时目录失败: {e}"))?;
    let stamp = now_ms();
    let safe_name = file_name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let temp_path = temp_dir.join(format!("omnipanel-upload-{stamp}-{safe_name}"));
    tokio::fs::write(&temp_path, &data)
        .await
        .map_err(|e| format!("写入临时文件失败: {e}"))?;

    let size = data.len() as f64;
    let temp_path_str = temp_path.to_string_lossy().into_owned();

    let request = FileTransferEnqueueRequest {
        items: vec![FileTransferItemSpec {
            connection_id: LOCAL_CONNECTION_ID.to_string(),
            path: temp_path_str.clone(),
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

    let batch_id = file_transfer_enqueue(state.clone(), request).await;

    if batch_id.is_err() {
        let _ = tokio::fs::remove_file(&temp_path).await;
    } else {
        let temp_path_clone = temp_path.clone();
        let batch_id_clone = batch_id.as_ref().unwrap().clone();
        let state_cleanup = state.clone();
        tokio::spawn(async move {
            let timeout = tokio::time::Duration::from_secs(3600);
            let interval = tokio::time::Duration::from_secs(2);
            let deadline = tokio::time::Instant::now() + timeout;
            loop {
                tokio::time::sleep(interval).await;
                if tokio::time::Instant::now() > deadline {
                    let _ = tokio::fs::remove_file(&temp_path_clone).await;
                    return;
                }
                let list = state_cleanup.file_transfers.list().await;
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
    }

    batch_id
}
