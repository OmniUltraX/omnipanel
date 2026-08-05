use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError};
use tauri::{AppHandle, Manager};

use crate::commands::file_manager::{
    load_file_connection, parse_file_config, protocol_of, resolve_local_path, resolve_secret,
    s3_get_object_bytes, s3_put_object_bytes, FileProtocol, LOCAL_CONNECTION_ID,
};
use crate::state::AppState;

use super::rate_limit::RATE_LIMIT_BPS;
use super::resume::{
    copy_local_resume, fingerprint_matches, local_partial_len, partial_dest_path,
    sftp_partial_len, source_fingerprint,
};
use super::types::{FileTransferJob, FileTransferState};
use super::util::{emit_job, open_sftp, temp_transfer_path};

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
    // 降频持久化进度（含 partial_path / source_fingerprint，支持断点续传握手）
    if let Some(state) = app.try_state::<AppState>() {
        state.file_transfers.persist_progress_throttled(job).await;
    }
}

async fn download_to_local(
    state: &AppState,
    connection_id: &str,
    remote_path: &str,
    local_path: &Path,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    check_cancel(cancel)?;
    if connection_id == LOCAL_CONNECTION_ID {
        let src = resolve_local_path(remote_path)?;
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

    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Sftp => {
            let session = open_sftp(state, connection_id).await?;
            session
                .sftp_download_to_file(remote_path, local_path)
                .await?;
            let meta = tokio::fs::metadata(local_path).await.ok();
            Ok(meta.map(|m| m.len()).unwrap_or(0))
        }
        FileProtocol::S3 => {
            let key = remote_path.trim_start_matches('/');
            let data = s3_get_object_bytes(&cfg, &secret, key).await?;
            if let Some(parent) = local_path.parent() {
                tokio::fs::create_dir_all(parent).await.ok();
            }
            tokio::fs::write(local_path, &data).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "写入临时文件失败").with_cause(e.to_string())
            })?;
            Ok(data.len() as u64)
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = secret.to_string();
            let remote_path = remote_path.to_string();
            let local_path = local_path.to_path_buf();
            tokio::task::spawn_blocking(move || {
                use crate::commands::file_manager::ftp_connect_sync;
                use std::io::Write;
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                let mut reader = ftp.retr_as_stream(&remote_path).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "FTP 下载失败").with_cause(e.to_string())
                })?;
                if let Some(parent) = local_path.parent() {
                    std::fs::create_dir_all(parent).ok();
                }
                let mut file = std::fs::File::create(&local_path).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "创建临时文件失败").with_cause(e.to_string())
                })?;
                let n = std::io::copy(&mut reader, &mut file).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "FTP 写入失败").with_cause(e.to_string())
                })?;
                file.flush().ok();
                drop(reader);
                let _ = ftp.quit();
                Ok(n)
            })
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
            })?
        }
        FileProtocol::Local => {
            let src = resolve_local_path(remote_path)?;
            tokio::fs::copy(&src, local_path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "复制本地文件失败").with_cause(e.to_string())
            })?;
            let meta = tokio::fs::metadata(local_path).await.ok();
            Ok(meta.map(|m| m.len()).unwrap_or(0))
        }
    }
}

async fn upload_from_local(
    state: &AppState,
    connection_id: &str,
    remote_path: &str,
    local_path: &Path,
    cancel: &AtomicBool,
) -> Result<(), OmniError> {
    check_cancel(cancel)?;
    if connection_id == LOCAL_CONNECTION_ID {
        let dest = resolve_local_path(remote_path)?;
        if let Some(parent) = dest.parent() {
            tokio::fs::create_dir_all(parent).await.ok();
        }
        tokio::fs::copy(local_path, &dest).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "写入本地目标失败").with_cause(e.to_string())
        })?;
        return Ok(());
    }

    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Sftp => {
            let session = open_sftp(state, connection_id).await?;
            if let Some(parent) = Path::new(remote_path).parent() {
                let p = parent.to_string_lossy();
                if !p.is_empty() && p != "/" {
                    let _ = session.sftp_mkdir(&p).await;
                }
            }
            session
                .sftp_upload_from_file(remote_path, local_path)
                .await
        }
        FileProtocol::S3 => {
            let key = remote_path.trim_start_matches('/');
            let data = tokio::fs::read(local_path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "读取临时文件失败").with_cause(e.to_string())
            })?;
            s3_put_object_bytes(&cfg, &secret, key, &data).await
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = secret.to_string();
            let remote_path = remote_path.to_string();
            let local_path = local_path.to_path_buf();
            tokio::task::spawn_blocking(move || {
                use crate::commands::file_manager::ftp_connect_sync;
                use std::io::Read;
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                let parent = Path::new(&remote_path)
                    .parent()
                    .and_then(|p| p.to_str())
                    .unwrap_or("/");
                if !parent.is_empty() && parent != "/" {
                    let _ = ftp.cwd(parent);
                }
                let fname = Path::new(&remote_path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&remote_path);
                let mut file = std::fs::File::open(&local_path).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "打开临时文件失败").with_cause(e.to_string())
                })?;
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "读取临时文件失败").with_cause(e.to_string())
                })?;
                use std::io::Cursor;
                ftp.put_file(fname, &mut Cursor::new(buf)).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "FTP 上传失败").with_cause(e.to_string())
                })?;
                let _ = ftp.quit();
                Ok(())
            })
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
            })?
        }
        FileProtocol::Local => {
            let dest = resolve_local_path(remote_path)?;
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
    app: &AppHandle,
    state: &AppState,
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
    emit_job(app, job).await;

    let temp = temp_transfer_path(&job.id, &job.source.name);
    if let Some(parent) = temp.parent() {
        tokio::fs::create_dir_all(parent).await.ok();
    }

    let src_local = job.source.connection_id == LOCAL_CONNECTION_ID;
    let dst_local = job.dest.connection_id == LOCAL_CONNECTION_ID;

    let result = async {
        // 记录指纹（续传校验）
        if job.source_fingerprint.is_none() {
            job.source_fingerprint =
                source_fingerprint(state, &job.source.connection_id, &job.source.path).await;
        }

        if src_local && dst_local {
            let src = resolve_local_path(&job.source.path)?;
            let dest = resolve_local_path(&job.dest.path)?;
            let partial_str = job
                .partial_path
                .clone()
                .unwrap_or_else(|| partial_dest_path(&job.dest.path));
            job.partial_path = Some(partial_str.clone());
            let partial = resolve_local_path(&partial_str)?;
            let meta = tokio::fs::metadata(&src).await.ok();
            let total = meta.map(|m| m.len());
            let fp = job.source_fingerprint.clone().unwrap_or_default();
            let mut start = 0u64;
            if fingerprint_matches(job, &fp) || job.source_fingerprint.is_some() {
                let cur = source_fingerprint(state, &job.source.connection_id, &job.source.path)
                    .await
                    .unwrap_or_default();
                if fingerprint_matches(job, &cur) {
                    start = local_partial_len(&partial_str);
                    if total == Some(start) && start > 0 {
                        // partial 已完整，直接提交
                        if let Some(parent) = dest.parent() {
                            tokio::fs::create_dir_all(parent).await.ok();
                        }
                        tokio::fs::rename(&partial, &dest).await.map_err(|e| {
                            OmniError::new(ErrorCode::Io, "提交目标失败").with_cause(e.to_string())
                        })?;
                        set_progress(app, job, start, total).await;
                        return Ok(());
                    }
                } else {
                    start = 0;
                    let _ = tokio::fs::remove_file(&partial).await;
                }
            }
            set_progress(app, job, start, total).await;
            let done = copy_local_resume(&src, &dest, &partial, start, &cancel).await?;
            set_progress(app, job, done, total).await;
            job.partial_path = None;
            return Ok(());
        }

        if src_local && !dst_local {
            let src = resolve_local_path(&job.source.path)?;
            let meta = tokio::fs::metadata(&src).await.ok();
            let total = meta.map(|m| m.len());

            // 判断目标协议；仅 SFTP 支持断点续传（其它协议走旧的覆盖式上传）
            let dst_conn = load_file_connection(state, &job.dest.connection_id)
                .await?
                .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
            let dst_cfg = parse_file_config(&dst_conn)?;
            let is_sftp = matches!(protocol_of(&dst_cfg), FileProtocol::Sftp);

            if is_sftp {
                let session = open_sftp(state, &job.dest.connection_id).await?;
                let partial_str = job
                    .partial_path
                    .clone()
                    .unwrap_or_else(|| partial_dest_path(&job.dest.path));
                job.partial_path = Some(partial_str.clone());

                // 父目录创建（与 upload_from_local 一致）
                if let Some(parent) = Path::new(&job.dest.path).parent() {
                    let p = parent.to_string_lossy();
                    if !p.is_empty() && p != "/" {
                        let _ = session.sftp_mkdir(&p).await;
                    }
                }

                let cur_fp = source_fingerprint(state, &job.source.connection_id, &job.source.path)
                    .await
                    .unwrap_or_default();
                let mut start = 0u64;
                if fingerprint_matches(job, &cur_fp) {
                    start = sftp_partial_len(state, &job.dest.connection_id, &partial_str).await;
                    if total == Some(start) && start > 0 {
                        // partial 已完整，直接提交
                        session.sftp_rename(&partial_str, &job.dest.path).await?;
                        set_progress(app, job, start, total).await;
                        job.partial_path = None;
                        return Ok(());
                    }
                } else {
                    // 指纹不匹配：源文件已变更，丢弃旧 partial 从头传
                    let _ = session.sftp_remove(&partial_str).await;
                    job.source_fingerprint = Some(cur_fp);
                }
                set_progress(app, job, start, total).await;

                let done = session
                    .sftp_upload_from_file_resume(
                        &partial_str,
                        &src,
                        start,
                        &cancel,
                        Some(&RATE_LIMIT_BPS),
                    )
                    .await?;

                // 裁剪到目标 size（防止 partial 大于 final，比如源文件在上次传输后被截断）
                if let Some(total_v) = total {
                    if done > total_v {
                        session.sftp_set_length(&partial_str, total_v).await?;
                    }
                }

                session.sftp_rename(&partial_str, &job.dest.path).await?;
                set_progress(app, job, total.unwrap_or(done), total).await;
                job.partial_path = None;
                return Ok(());
            }

            // 非 SFTP：走旧的覆盖式上传（从 0 开始）
            set_progress(app, job, 0, total).await;
            upload_from_local(
                state,
                &job.dest.connection_id,
                &job.dest.path,
                &src,
                &cancel,
            )
            .await?;
            set_progress(app, job, total.unwrap_or(0), total).await;
            return Ok(());
        }

        if !src_local && dst_local {
            let dest = resolve_local_path(&job.dest.path)?;
            let partial_str = job
                .partial_path
                .clone()
                .unwrap_or_else(|| partial_dest_path(&job.dest.path));
            job.partial_path = Some(partial_str.clone());
            let partial = resolve_local_path(&partial_str)?;
            let cur_fp = source_fingerprint(state, &job.source.connection_id, &job.source.path)
                .await
                .unwrap_or_default();
            let mut start = 0u64;
            if fingerprint_matches(job, &cur_fp) {
                start = local_partial_len(&partial_str);
            } else {
                let _ = tokio::fs::remove_file(&partial).await;
                job.source_fingerprint = Some(cur_fp);
            }
            set_progress(app, job, start, None).await;
            // 续传：用 range 拉取剩余写入 partial
            let n = download_to_local_resume(
                state,
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
            set_progress(app, job, n, Some(n)).await;
            job.partial_path = None;
            return Ok(());
        }

        // 远程 → 远程：经临时文件；临时文件可复用
        set_progress(app, job, 0, None).await;
        let cur_fp = source_fingerprint(state, &job.source.connection_id, &job.source.path)
            .await
            .unwrap_or_default();
        let temp_ok = fingerprint_matches(job, &cur_fp)
            && temp.exists()
            && tokio::fs::metadata(&temp)
                .await
                .map(|m| m.len() > 0)
                .unwrap_or(false);
        let n = if temp_ok {
            tokio::fs::metadata(&temp).await.map(|m| m.len()).unwrap_or(0)
        } else {
            job.source_fingerprint = Some(cur_fp);
            let _ = tokio::fs::remove_file(&temp).await;
            download_to_local(
                state,
                &job.source.connection_id,
                &job.source.path,
                &temp,
                &cancel,
            )
            .await?
        };
        set_progress(app, job, n / 2, Some(n)).await;
        upload_from_local(
            state,
            &job.dest.connection_id,
            &job.dest.path,
            &temp,
            &cancel,
        )
        .await?;
        set_progress(app, job, n, Some(n)).await;
        Ok(())
    }
    .await;

    // 成功才清临时文件；失败保留供断点续传
    if result.is_ok() {
        let _ = tokio::fs::remove_file(&temp).await;
        if let Some(parent) = temp.parent() {
            let _ = tokio::fs::remove_dir(parent).await;
        }
    }

    result
}

async fn download_to_local_resume(
    state: &AppState,
    connection_id: &str,
    remote_path: &str,
    local_path: &Path,
    start_offset: u64,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    check_cancel(cancel)?;
    if start_offset == 0 {
        return download_to_local(state, connection_id, remote_path, local_path, cancel).await;
    }
    // SFTP：按块 range 追加
    if connection_id != LOCAL_CONNECTION_ID {
        let conn = load_file_connection(state, connection_id)
            .await?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
        let cfg = parse_file_config(&conn)?;
        if matches!(protocol_of(&cfg), FileProtocol::Sftp) {
            let session = open_sftp(state, connection_id).await?;
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
                let chunk = session
                    .sftp_read_range(remote_path, offset, CHUNK)
                    .await?;
                if chunk.is_empty() {
                    break;
                }
                file.write_all(&chunk).await.map_err(|e| {
                    OmniError::new(ErrorCode::Io, "写入 partial 失败").with_cause(e.to_string())
                })?;
                offset += chunk.len() as u64;
                super::rate_limit::throttle_bytes(chunk.len() as u64).await;
                if chunk.len() < CHUNK as usize {
                    break;
                }
            }
            file.flush().await.ok();
            return Ok(offset);
        }
    }
    // 其它协议：无法可靠续传则重头下载
    let _ = tokio::fs::remove_file(local_path).await;
    download_to_local(state, connection_id, remote_path, local_path, cancel).await
}
