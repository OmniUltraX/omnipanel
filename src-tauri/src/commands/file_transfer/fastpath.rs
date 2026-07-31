use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError};
use tauri::AppHandle;

use crate::commands::file_manager::{
    load_file_connection, parse_file_config, resolve_local_path, resolve_secret,
    s3_copy_object_from_bucket, s3_copy_object_internal, s3_get_object_bytes, s3_put_object_bytes,
    FileProtocol, LOCAL_CONNECTION_ID,
};
use crate::state::AppState;

use super::stream_relay::run_relay;
use super::types::{FileTransferJob, FileTransferOp, FileTransferRoute, FileTransferState};
use super::util::{emit_job, open_sftp, resolve_protocol, temp_transfer_path};

fn check_cancel(cancel: &AtomicBool) -> Result<(), OmniError> {
    if cancel.load(Ordering::Relaxed) {
        Err(OmniError::new(ErrorCode::Internal, "传输已取消"))
    } else {
        Ok(())
    }
}

async fn set_progress(app: &AppHandle, job: &mut FileTransferJob, done: u64, total: Option<u64>) {
    job.bytes_done = done as f64;
    job.bytes_total = total.map(|t| t as f64);
    job.progress = match total {
        Some(t) if t > 0 => ((done as f64 / t as f64) * 100.0).clamp(0.0, 100.0),
        _ => job.progress,
    };
    emit_job(app, job).await;
}

/// 同连接 FastPath。
pub async fn run_fastpath(
    app: &AppHandle,
    state: &AppState,
    job: &mut FileTransferJob,
    cancel: Arc<AtomicBool>,
) -> Result<(), OmniError> {
    if job.source.connection_id != job.dest.connection_id {
        return super::stream_relay::run_relay(app, state, job, cancel).await;
    }
    if job.source.kind == "dir" {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "目录递归传输将在后续版本启用",
        ));
    }

    check_cancel(&cancel)?;
    job.state = FileTransferState::Running;
    emit_job(app, job).await;

    if job.source.connection_id == LOCAL_CONNECTION_ID {
        let src = resolve_local_path(&job.source.path)?;
        let dest = resolve_local_path(&job.dest.path)?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let meta = tokio::fs::metadata(&src).await.ok();
        let total = meta.map(|m| m.len());
        set_progress(app, job, 0, total).await;
        match job.op {
            FileTransferOp::Move => {
                if tokio::fs::rename(&src, &dest).await.is_err() {
                    tokio::fs::copy(&src, &dest).await.map_err(|e| {
                        OmniError::new(ErrorCode::Io, "本地移动失败").with_cause(e.to_string())
                    })?;
                    tokio::fs::remove_file(&src).await.map_err(|e| {
                        OmniError::new(ErrorCode::Io, "删除源文件失败").with_cause(e.to_string())
                    })?;
                }
            }
            FileTransferOp::Copy => {
                tokio::fs::copy(&src, &dest).await.map_err(|e| {
                    OmniError::new(ErrorCode::Io, "本地复制失败").with_cause(e.to_string())
                })?;
            }
        }
        set_progress(app, job, total.unwrap_or(0), total).await;
        return Ok(());
    }

    let proto = resolve_protocol(state, &job.source.connection_id).await?;
    match proto {
        FileProtocol::Sftp if matches!(job.op, FileTransferOp::Move) => {
            let session = open_sftp(state, &job.source.connection_id).await?;
            session.sftp_rename(&job.source.path, &job.dest.path).await?;
            set_progress(app, job, 1, Some(1)).await;
            Ok(())
        }
        FileProtocol::Sftp => {
            let temp = temp_transfer_path(&job.id, &job.source.name);
            if let Some(parent) = temp.parent() {
                tokio::fs::create_dir_all(parent).await.ok();
            }
            let session = open_sftp(state, &job.source.connection_id).await?;
            session
                .sftp_download_to_file(&job.source.path, &temp)
                .await?;
            check_cancel(&cancel)?;
            session
                .sftp_upload_from_file(&job.dest.path, &temp)
                .await?;
            let _ = tokio::fs::remove_file(&temp).await;
            set_progress(app, job, 1, Some(1)).await;
            Ok(())
        }
        FileProtocol::S3 => {
            let src_conn = load_file_connection(state, &job.source.connection_id)
                .await?
                .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
            let src_cfg = parse_file_config(&src_conn)?;
            let src_secret = resolve_secret(&src_conn).unwrap_or_default();
            let src_key = job.source.path.trim_start_matches('/').to_string();
            let dst_key = job.dest.path.trim_start_matches('/').to_string();

            let same_conn = job.source.connection_id == job.dest.connection_id;
            let copy_result = if same_conn {
                s3_copy_object_internal(&src_cfg, &src_secret, &src_key, &dst_key).await
            } else {
                let dst_conn = load_file_connection(state, &job.dest.connection_id)
                    .await?
                    .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "目标连接不存在"))?;
                let dst_cfg = parse_file_config(&dst_conn)?;
                let dst_secret = resolve_secret(&dst_conn).unwrap_or_default();
                s3_copy_object_from_bucket(
                    &dst_cfg,
                    &dst_secret,
                    &src_cfg.bucket,
                    &src_key,
                    &dst_key,
                )
                .await
            };

            match copy_result {
                Ok(()) => {
                    if matches!(job.op, FileTransferOp::Move) {
                        if let Ok(bucket) =
                            crate::commands::file_manager::s3_bucket(&src_cfg, &src_secret)
                        {
                            let _ = bucket.delete_object(&src_key).await;
                        }
                    }
                    set_progress(app, job, 1, Some(1)).await;
                    Ok(())
                }
                Err(_) if same_conn => {
                    // 同连接回落：经本机 get+put（仍算 fastpath 语义）
                    let data = s3_get_object_bytes(&src_cfg, &src_secret, &src_key).await?;
                    let n = data.len() as u64;
                    set_progress(app, job, 0, Some(n)).await;
                    s3_put_object_bytes(&src_cfg, &src_secret, &dst_key, &data).await?;
                    if matches!(job.op, FileTransferOp::Move) {
                        if let Ok(bucket) =
                            crate::commands::file_manager::s3_bucket(&src_cfg, &src_secret)
                        {
                            let _ = bucket.delete_object(&src_key).await;
                        }
                    }
                    set_progress(app, job, n, Some(n)).await;
                    Ok(())
                }
                Err(e) => {
                    job.route = FileTransferRoute::Relay;
                    job.route_reason = format!("S3 服务端拷失败，回落中继：{}", e.message);
                    emit_job(app, job).await;
                    run_relay(app, state, job, cancel).await
                }
            }
        }
        _ => super::stream_relay::run_relay(app, state, job, cancel).await,
    }
}
