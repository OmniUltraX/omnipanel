use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use omnipanel_error::{ErrorCode, OmniError};

use crate::event::TransferEventSink;
use crate::event::emit_job;
use crate::provider::{TransferHost, TransferProtocol};
use crate::stream_relay::run_relay;
use crate::types::{FileTransferJob, FileTransferOp, FileTransferRoute, FileTransferState};
use crate::util::{
    check_cancel, open_sftp, resolve_protocol, s3_key, set_progress, temp_transfer_path,
};

/// 同连接 FastPath。
pub async fn run_fastpath(
    sink: &dyn TransferEventSink,
    host: &dyn TransferHost,
    job: &mut FileTransferJob,
    cancel: Arc<AtomicBool>,
) -> Result<(), OmniError> {
    if job.source.connection_id != job.dest.connection_id {
        return run_relay(sink, host, job, cancel).await;
    }
    if job.source.kind == "dir" {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "目录递归传输将在后续版本启用",
        ));
    }

    check_cancel(&cancel)?;
    job.state = FileTransferState::Running;
    emit_job(sink, job).await;

    if job.source.connection_id == host.local_connection_id() {
        let src = host.resolve_local_path(&job.source.path)?;
        let dest = host.resolve_local_path(&job.dest.path)?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let meta = tokio::fs::metadata(&src).await.ok();
        let total = meta.map(|m| m.len());
        set_progress(sink, job, 0, total).await;
        match job.op {
            FileTransferOp::Move => {
                if src == dest {
                    set_progress(sink, job, total.unwrap_or(0), total).await;
                    return Ok(());
                }
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
        set_progress(sink, job, total.unwrap_or(0), total).await;
        return Ok(());
    }

    let proto = resolve_protocol(host, &job.source.connection_id).await?;
    match proto {
        TransferProtocol::Sftp if matches!(job.op, FileTransferOp::Move) => {
            if job.source.path == job.dest.path {
                set_progress(sink, job, 1, Some(1)).await;
                return Ok(());
            }
            let session = open_sftp(host, &job.source.connection_id).await?;
            session
                .sftp_rename(&job.source.path, &job.dest.path)
                .await?;
            set_progress(sink, job, 1, Some(1)).await;
            Ok(())
        }
        TransferProtocol::Sftp => {
            let temp = temp_transfer_path(&job.id, &job.source.name);
            if let Some(parent) = temp.parent() {
                tokio::fs::create_dir_all(parent).await.ok();
            }
            let session = open_sftp(host, &job.source.connection_id).await?;
            session
                .sftp_download_to_file(&job.source.path, &temp)
                .await?;
            check_cancel(&cancel)?;
            session.sftp_upload_from_file(&job.dest.path, &temp).await?;
            let _ = tokio::fs::remove_file(&temp).await;
            set_progress(sink, job, 1, Some(1)).await;
            Ok(())
        }
        TransferProtocol::S3 => {
            let src_key = s3_key(&job.source.path);
            let dst_key = s3_key(&job.dest.path);
            let same_conn = job.source.connection_id == job.dest.connection_id;
            let copy_result = if same_conn {
                host.s3_copy_internal(&job.source.connection_id, &src_key, &dst_key)
                    .await
            } else {
                host.s3_copy_cross_bucket(
                    &job.source.connection_id,
                    &src_key,
                    &job.dest.connection_id,
                    &dst_key,
                )
                .await
            };

            match copy_result {
                Ok(()) => {
                    if matches!(job.op, FileTransferOp::Move) {
                        let _ = host
                            .s3_delete_object(&job.source.connection_id, &src_key)
                            .await;
                    }
                    set_progress(sink, job, 1, Some(1)).await;
                    Ok(())
                }
                Err(_) if same_conn => {
                    let data = host
                        .s3_get_bytes(&job.source.connection_id, &src_key)
                        .await?;
                    let n = data.len() as u64;
                    set_progress(sink, job, 0, Some(n)).await;
                    host.s3_put_bytes(&job.source.connection_id, &dst_key, &data)
                        .await?;
                    if matches!(job.op, FileTransferOp::Move) {
                        let _ = host
                            .s3_delete_object(&job.source.connection_id, &src_key)
                            .await;
                    }
                    set_progress(sink, job, n, Some(n)).await;
                    Ok(())
                }
                Err(e) => {
                    job.route = FileTransferRoute::Relay;
                    job.route_reason = format!("S3 服务端拷失败，回落中继：{}", e.message);
                    emit_job(sink, job).await;
                    run_relay(sink, host, job, cancel).await
                }
            }
        }
        _ => run_relay(sink, host, job, cancel).await,
    }
}
