use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use omnipanel_error::{ErrorCode, OmniError};

use crate::engine::FileTransferEngine;
use crate::event::{TransferEventSink, emit_job};
use crate::provider::{TransferHost, TransferProtocol};
use crate::rate_limit::RATE_LIMIT_BPS;
use crate::resume::{
    copy_local_resume, fingerprint_matches, local_partial_len, partial_dest_path, sftp_partial_len,
    source_fingerprint,
};
use crate::types::{FileTransferJob, FileTransferState};
use crate::util::{check_cancel, open_sftp, resolve_protocol, set_progress, temp_transfer_path};

async fn set_progress_with_persist(
    sink: &dyn TransferEventSink,
    engine: Option<&FileTransferEngine>,
    job: &mut FileTransferJob,
    done: u64,
    total: Option<u64>,
) {
    set_progress(sink, job, done, total).await;
    if let Some(eng) = engine {
        eng.persist_progress_throttled(job).await;
    }
}

async fn download_to_local(
    host: &dyn TransferHost,
    connection_id: &str,
    remote_path: &str,
    local_path: &Path,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    check_cancel(cancel)?;
    if connection_id == host.local_connection_id() {
        let src = host.resolve_local_path(remote_path)?;
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "创建临时目录失败").with_cause(e.to_string())
            })?;
        }
        tokio::fs::copy(&src, local_path).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "复制本地文件失败").with_cause(e.to_string())
        })?;
        let meta = tokio::fs::metadata(local_path).await.ok();
        return Ok(meta.map(|m| m.len()).unwrap_or(0));
    }

    match host.connection_protocol(connection_id).await? {
        TransferProtocol::Sftp => {
            let session = open_sftp(host, connection_id).await?;
            session
                .sftp_download_to_file(remote_path, local_path)
                .await?;
            let meta = tokio::fs::metadata(local_path).await.ok();
            Ok(meta.map(|m| m.len()).unwrap_or(0))
        }
        TransferProtocol::S3 => {
            let n = host
                .s3_download_to_file(connection_id, remote_path, local_path)
                .await?;
            Ok(n)
        }
        TransferProtocol::Ftp => {
            host.ftp_download_to_file(connection_id, remote_path, local_path)
                .await
        }
        TransferProtocol::Local => {
            let src = host.resolve_local_path(remote_path)?;
            tokio::fs::copy(&src, local_path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "复制本地文件失败").with_cause(e.to_string())
            })?;
            let meta = tokio::fs::metadata(local_path).await.ok();
            Ok(meta.map(|m| m.len()).unwrap_or(0))
        }
    }
}

async fn upload_from_local(
    host: &dyn TransferHost,
    connection_id: &str,
    remote_path: &str,
    local_path: &Path,
    cancel: &AtomicBool,
) -> Result<(), OmniError> {
    check_cancel(cancel)?;
    if connection_id == host.local_connection_id() {
        let dest = host.resolve_local_path(remote_path)?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::copy(local_path, &dest).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "写入本地目标失败").with_cause(e.to_string())
        })?;
        return Ok(());
    }

    match host.connection_protocol(connection_id).await? {
        TransferProtocol::Sftp => {
            let session = open_sftp(host, connection_id).await?;
            if let Some(parent) = Path::new(remote_path).parent() {
                let p = parent.to_string_lossy();
                if !p.is_empty() && p != "/" {
                    let _ = session.sftp_mkdir(&p).await;
                }
            }
            session
                .sftp_upload_from_file(remote_path, local_path)
                .await?;
            Ok(())
        }
        TransferProtocol::S3 => {
            host.s3_upload_from_file(connection_id, remote_path, local_path)
                .await?;
            Ok(())
        }
        TransferProtocol::Ftp => {
            host.ftp_upload_from_file(connection_id, remote_path, local_path)
                .await?;
            Ok(())
        }
        TransferProtocol::Local => {
            let dest = host.resolve_local_path(remote_path)?;
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await.ok();
            }
            tokio::fs::copy(local_path, &dest).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "写入本地目标失败").with_cause(e.to_string())
            })?;
            Ok(())
        }
    }
}

/// 本机流式中继：源 →（临时文件）→ 宿。
pub async fn run_relay(
    sink: &dyn TransferEventSink,
    host: &dyn TransferHost,
    job: &mut FileTransferJob,
    cancel: Arc<AtomicBool>,
) -> Result<(), OmniError> {
    run_relay_with_engine(sink, host, None, job, cancel).await
}

pub async fn run_relay_with_engine(
    sink: &dyn TransferEventSink,
    host: &dyn TransferHost,
    engine: Option<&FileTransferEngine>,
    job: &mut FileTransferJob,
    cancel: Arc<AtomicBool>,
) -> Result<(), OmniError> {
    if job.source.kind == "dir" {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "目录递归传输将在后续版本启用，请先传输单个文件",
        ));
    }

    job.state = FileTransferState::Running;
    emit_job(sink, job).await;

    let temp = temp_transfer_path(&job.id, &job.source.name);
    if let Some(parent) = temp.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }

    let src_local = job.source.connection_id == host.local_connection_id();
    let dst_local = job.dest.connection_id == host.local_connection_id();

    let result = async {
        if job.source_fingerprint.is_none() {
            job.source_fingerprint =
                source_fingerprint(host, &job.source.connection_id, &job.source.path).await;
        }

        if src_local && dst_local {
            let src = host.resolve_local_path(&job.source.path)?;
            let dest = host.resolve_local_path(&job.dest.path)?;
            let partial_str = job
                .partial_path
                .clone()
                .unwrap_or_else(|| partial_dest_path(&job.dest.path));
            job.partial_path = Some(partial_str.clone());
            let partial = host.resolve_local_path(&partial_str)?;
            let meta = tokio::fs::metadata(&src).await.ok();
            let total = meta.map(|m| m.len());
            let fp = job.source_fingerprint.clone().unwrap_or_default();
            let mut start = 0u64;
            if fingerprint_matches(job, &fp) || job.source_fingerprint.is_some() {
                let cur = source_fingerprint(host, &job.source.connection_id, &job.source.path)
                    .await
                    .unwrap_or_default();
                if fingerprint_matches(job, &cur) {
                    start = local_partial_len(host, &partial_str);
                    if total == Some(start) && start > 0 {
                        if let Some(parent) = dest.parent() {
                            tokio::fs::create_dir_all(parent).await.ok();
                        }
                        tokio::fs::rename(&partial, &dest).await.map_err(|e| {
                            OmniError::new(ErrorCode::Io, "提交目标失败").with_cause(e.to_string())
                        })?;
                        set_progress_with_persist(sink, engine, job, start, total).await;
                        return Ok(());
                    }
                } else {
                    start = 0;
                    let _ = tokio::fs::remove_file(&partial).await;
                }
            }
            set_progress_with_persist(sink, engine, job, start, total).await;
            let done = copy_local_resume(host, &src, &dest, &partial, start, &cancel).await?;
            set_progress_with_persist(sink, engine, job, done, total).await;
            job.partial_path = None;
            return Ok(());
        }

        if src_local && !dst_local {
            let src = host.resolve_local_path(&job.source.path)?;
            let meta = tokio::fs::metadata(&src).await.ok();
            let total = meta.map(|m| m.len());
            let is_sftp = matches!(
                resolve_protocol(host, &job.dest.connection_id).await?,
                TransferProtocol::Sftp
            );

            if is_sftp {
                let session = open_sftp(host, &job.dest.connection_id).await?;
                let partial_str = job
                    .partial_path
                    .clone()
                    .unwrap_or_else(|| partial_dest_path(&job.dest.path));
                job.partial_path = Some(partial_str.clone());

                if let Some(parent) = Path::new(&job.dest.path).parent() {
                    let p = parent.to_string_lossy();
                    if !p.is_empty() && p != "/" {
                        let _ = session.sftp_mkdir(&p).await;
                    }
                }

                let cur_fp = source_fingerprint(host, &job.source.connection_id, &job.source.path)
                    .await
                    .unwrap_or_default();
                let mut start = 0u64;
                if fingerprint_matches(job, &cur_fp) {
                    start = sftp_partial_len(host, &job.dest.connection_id, &partial_str).await;
                    if total == Some(start) && start > 0 {
                        session.sftp_rename(&partial_str, &job.dest.path).await?;
                        set_progress_with_persist(sink, engine, job, start, total).await;
                        job.partial_path = None;
                        return Ok(());
                    }
                } else {
                    let _ = session.sftp_remove(&partial_str).await;
                    job.source_fingerprint = Some(cur_fp);
                }
                set_progress_with_persist(sink, engine, job, start, total).await;

                let done = session
                    .sftp_upload_from_file_resume(
                        &partial_str,
                        &src,
                        start,
                        &cancel,
                        Some(&RATE_LIMIT_BPS),
                    )
                    .await?;

                if let Some(total_v) = total {
                    if done > total_v {
                        session.sftp_set_length(&partial_str, total_v).await?;
                    }
                }

                session.sftp_rename(&partial_str, &job.dest.path).await?;
                set_progress_with_persist(sink, engine, job, total.unwrap_or(done), total).await;
                job.partial_path = None;
                return Ok(());
            }

            set_progress_with_persist(sink, engine, job, 0, total).await;
            upload_from_local(host, &job.dest.connection_id, &job.dest.path, &src, &cancel).await?;
            set_progress_with_persist(sink, engine, job, total.unwrap_or(0), total).await;
            return Ok(());
        }

        if !src_local && dst_local {
            let dest = host.resolve_local_path(&job.dest.path)?;
            let partial_str = job
                .partial_path
                .clone()
                .unwrap_or_else(|| partial_dest_path(&job.dest.path));
            job.partial_path = Some(partial_str.clone());
            let partial = host.resolve_local_path(&partial_str)?;
            let cur_fp = source_fingerprint(host, &job.source.connection_id, &job.source.path)
                .await
                .unwrap_or_default();
            let mut start = 0u64;
            if fingerprint_matches(job, &cur_fp) {
                start = local_partial_len(host, &partial_str);
            } else {
                let _ = tokio::fs::remove_file(&partial).await;
                job.source_fingerprint = Some(cur_fp);
            }
            set_progress_with_persist(sink, engine, job, start, None).await;
            let n = download_to_local_resume(
                host,
                &job.source.connection_id,
                &job.source.path,
                &partial,
                start,
                &cancel,
            )
            .await?;
            if let Some(parent) = dest.parent() {
                tokio::fs::create_dir_all(parent).await.ok();
            }
            tokio::fs::rename(&partial, &dest).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "提交目标失败").with_cause(e.to_string())
            })?;
            set_progress_with_persist(sink, engine, job, n, Some(n)).await;
            job.partial_path = None;
            return Ok(());
        }

        set_progress_with_persist(sink, engine, job, 0, None).await;
        let cur_fp = source_fingerprint(host, &job.source.connection_id, &job.source.path)
            .await
            .unwrap_or_default();
        let temp_ok = fingerprint_matches(job, &cur_fp)
            && temp.exists()
            && tokio::fs::metadata(&temp)
                .await
                .map(|m| m.len() > 0)
                .unwrap_or(false);
        let n = if temp_ok {
            tokio::fs::metadata(&temp)
                .await
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            job.source_fingerprint = Some(cur_fp);
            let _ = tokio::fs::remove_file(&temp).await;
            download_to_local(
                host,
                &job.source.connection_id,
                &job.source.path,
                &temp,
                &cancel,
            )
            .await?
        };
        set_progress_with_persist(sink, engine, job, n / 2, Some(n)).await;
        upload_from_local(
            host,
            &job.dest.connection_id,
            &job.dest.path,
            &temp,
            &cancel,
        )
        .await?;
        set_progress_with_persist(sink, engine, job, n, Some(n)).await;
        Ok(())
    }
    .await;

    if result.is_ok() {
        let _ = tokio::fs::remove_file(&temp).await;
        if let Some(parent) = temp.parent() {
            let _ = tokio::fs::remove_dir(parent).await;
        }
    }

    result
}

async fn download_to_local_resume(
    host: &dyn TransferHost,
    connection_id: &str,
    remote_path: &str,
    local_path: &Path,
    start_offset: u64,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    check_cancel(cancel)?;
    if start_offset == 0 {
        return download_to_local(host, connection_id, remote_path, local_path, cancel).await;
    }
    if connection_id != host.local_connection_id()
        && matches!(
            host.connection_protocol(connection_id).await?,
            TransferProtocol::Sftp
        )
    {
        let session = open_sftp(host, connection_id).await?;
        let total = session.sftp_file_size(remote_path).await.unwrap_or(0);
        if total > 0 && start_offset >= total {
            return Ok(start_offset);
        }
        use tokio::io::AsyncWriteExt;
        if let Some(parent) = local_path.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(local_path)
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, "打开 partial 失败").with_cause(e.to_string())
            })?;
        let mut offset = start_offset;
        const CHUNK: u32 = 512 * 1024;
        while total == 0 || offset < total {
            check_cancel(cancel)?;
            let chunk = session.sftp_read_range(remote_path, offset, CHUNK).await?;
            if chunk.is_empty() {
                break;
            }
            file.write_all(&chunk).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "写入 partial 失败").with_cause(e.to_string())
            })?;
            offset += chunk.len() as u64;
            crate::rate_limit::throttle_bytes(chunk.len() as u64).await;
            if chunk.len() < CHUNK as usize {
                break;
            }
        }
        file.flush().await.ok();
        return Ok(offset);
    }
    let _ = tokio::fs::remove_file(local_path).await;
    download_to_local(host, connection_id, remote_path, local_path, cancel).await
}
