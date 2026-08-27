//! Web / 服务端 relay 传输（local ↔ SFTP ↔ S3）。

use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};

use crate::event::TransferEventSink;
use crate::provider::{LOCAL_CONNECTION_ID, TransferHost, TransferProtocol};
use crate::types::TRANSFER_PROGRESS_EVENT;
use crate::util::{join_posix, open_sftp, s3_key};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TransferState {
    Queued,
    Running,
    Done,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferJob {
    pub id: String,
    pub source_connection_id: String,
    pub source_path: String,
    pub dest_connection_id: String,
    pub dest_path: String,
    pub state: TransferState,
    pub bytes_done: f64,
    pub bytes_total: Option<f64>,
    pub progress: f64,
    pub error: Option<String>,
    #[serde(default)]
    pub resumed_from: Option<f64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferStartRequest {
    pub source_connection_id: String,
    pub source_path: String,
    pub dest_connection_id: String,
    pub dest_path: String,
    #[serde(default)]
    pub conflict_policy: Option<String>,
    #[serde(default = "default_resume")]
    pub resume: bool,
}

fn default_resume() -> bool {
    true
}

static TRANSFER_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn new_transfer_id() -> String {
    let n = TRANSFER_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("transfer-{}-{}", std::process::id(), n)
}

pub fn dest_final_path(
    host: &dyn TransferHost,
    dest_connection_id: &str,
    dest_path: &str,
    policy: Option<&str>,
) -> Result<String, OmniError> {
    let exists = match dest_connection_id {
        LOCAL_CONNECTION_ID => host
            .resolve_local_path(dest_path)
            .map(|p| p.exists())
            .unwrap_or(false),
        _ => false,
    };
    if !exists {
        return Ok(dest_path.to_string());
    }
    match policy.unwrap_or("overwrite") {
        "overwrite" => Ok(dest_path.to_string()),
        "rename" => {
            let (parent, name) = match dest_path.rfind('/') {
                Some(idx) => (&dest_path[..idx], &dest_path[idx + 1..]),
                None => ("", dest_path),
            };
            let base = name
                .rsplit_once('.')
                .map(|(b, e)| (b, Some(e)))
                .unwrap_or((name, None));
            let mut n = 1;
            loop {
                let candidate = match base.1 {
                    Some(ext) => format!("{}_{n}.{ext}", base.0),
                    None => format!("{}_{n}", base.0),
                };
                let full = if parent.is_empty() {
                    candidate
                } else {
                    join_posix(parent, &candidate)
                };
                let exists = if dest_connection_id == LOCAL_CONNECTION_ID {
                    host.resolve_local_path(&full)
                        .map(|p| p.exists())
                        .unwrap_or(false)
                } else {
                    false
                };
                if !exists {
                    return Ok(full);
                }
                n += 1;
            }
        }
        other => Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("未知冲突策略: {other}"),
        )),
    }
}

pub async fn relay_local_dest(
    host: &dyn TransferHost,
    source_connection_id: &str,
    source_path: &str,
    dest_path: &str,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    if source_connection_id == host.local_connection_id() {
        let src = host.resolve_local_path(source_path)?;
        if !src.exists() {
            return Err(OmniError::new(ErrorCode::NotFound, "源文件不存在"));
        }
        if let Some(parent) = Path::new(dest_path).parent() {
            tokio::fs::create_dir_all(parent).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "创建本地目标目录失败").with_cause(e.to_string())
            })?;
        }
        tokio::fs::copy(&src, dest_path)
            .await
            .map_err(|e| OmniError::new(ErrorCode::Io, "本地复制失败").with_cause(e.to_string()))?;
        let meta = tokio::fs::metadata(dest_path).await.ok();
        Ok(meta.map(|m| m.len()).unwrap_or(0))
    } else {
        let session = open_sftp(host, source_connection_id).await?;
        session
            .sftp_download_to_file(source_path, Path::new(dest_path))
            .await?;
        if cancel.load(Ordering::Relaxed) {
            return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
        }
        let meta = tokio::fs::metadata(dest_path).await.ok();
        Ok(meta.map(|m| m.len()).unwrap_or(0))
    }
}

pub async fn relay_sftp_dest(
    host: &dyn TransferHost,
    dest_connection_id: &str,
    dest_path: &str,
    local_path: &Path,
    resume: bool,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let session = open_sftp(host, dest_connection_id).await?;
    let start_offset = if resume {
        session.sftp_file_size(dest_path).await.unwrap_or(0)
    } else {
        0
    };
    let local_len = tokio::fs::metadata(local_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    if start_offset >= local_len {
        return Ok(start_offset);
    }
    if start_offset > 0 {
        session
            .sftp_upload_from_file_resume(dest_path, local_path, start_offset, cancel, None)
            .await
    } else {
        session.sftp_upload_from_file(dest_path, local_path).await?;
        Ok(local_len)
    }
}

pub async fn relay_sftp_sftp(
    host: &dyn TransferHost,
    source_connection_id: &str,
    source_path: &str,
    dest_connection_id: &str,
    dest_path: &str,
    resume: bool,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let src = open_sftp(host, source_connection_id).await?;
    let dst = open_sftp(host, dest_connection_id).await?;
    let start_offset = if resume {
        dst.sftp_file_size(dest_path).await.unwrap_or(0)
    } else {
        0
    };
    let size = src.sftp_file_size(source_path).await;
    if start_offset >= size.unwrap_or(0) && size.is_some() && start_offset > 0 {
        return Ok(start_offset);
    }
    if let Some(parent) = dest_path.rfind('/').map(|i| &dest_path[..i]) {
        if !parent.is_empty() && !dst.sftp_exists(parent).await {
            dst.sftp_mkdir(parent).await?;
        }
    }
    const CHUNK: u64 = 256 * 1024;
    let mut offset = start_offset;
    let mut total = start_offset;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
        }
        let data = src
            .sftp_read_range(source_path, offset, CHUNK as u32)
            .await?;
        if data.is_empty() {
            break;
        }
        let written = dst
            .sftp_write_at(dest_path, offset, &data)
            .await
            .map_err(|e| e.with_cause("SFTP 偏移写入目标文件失败"))?;
        offset += data.len() as u64;
        total = written;
        if data.len() < CHUNK as usize {
            break;
        }
    }
    if size.is_some_and(|s| s < total) {
        let _ = dst.sftp_set_length(dest_path, size.unwrap_or(total)).await;
    }
    Ok(total)
}

pub async fn source_to_local_temp(
    host: &dyn TransferHost,
    source_connection_id: &str,
    source_path: &str,
    job_id: &str,
    cancel: &AtomicBool,
) -> Result<(std::path::PathBuf, u64), OmniError> {
    let proto = host.connection_protocol(source_connection_id).await?;
    match proto {
        TransferProtocol::Local => {
            let src = host.resolve_local_path(source_path)?;
            if !src.exists() {
                return Err(OmniError::new(ErrorCode::NotFound, "源文件不存在"));
            }
            let len = tokio::fs::metadata(&src)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            Ok((src, len))
        }
        TransferProtocol::Sftp => {
            let session = open_sftp(host, source_connection_id).await?;
            let temp = std::env::temp_dir().join(format!("{job_id}.src"));
            session.sftp_download_to_file(source_path, &temp).await?;
            if cancel.load(Ordering::Relaxed) {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
            }
            let len = tokio::fs::metadata(&temp)
                .await
                .map(|m| m.len())
                .unwrap_or(0);
            Ok((temp, len))
        }
        TransferProtocol::S3 => {
            let temp = std::env::temp_dir().join(format!("{job_id}.src"));
            let written = host
                .s3_download_to_file(source_connection_id, source_path, &temp)
                .await?;
            if cancel.load(Ordering::Relaxed) {
                let _ = tokio::fs::remove_file(&temp).await;
                return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
            }
            let len = tokio::fs::metadata(&temp)
                .await
                .map(|m| m.len())
                .unwrap_or(written);
            Ok((temp, len))
        }
        _ => Err(OmniError::invalid_input(format!(
            "不支持的源协议: {proto:?}"
        ))),
    }
}

pub async fn local_temp_to_dest(
    host: &dyn TransferHost,
    dest_connection_id: &str,
    dest_path: &str,
    temp: &Path,
    resume: bool,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let proto = host.connection_protocol(dest_connection_id).await?;
    match proto {
        TransferProtocol::Local => {
            if let Some(parent) = Path::new(dest_path).parent() {
                tokio::fs::create_dir_all(parent).await.map_err(|e| {
                    OmniError::new(ErrorCode::Io, "创建本地目标目录失败").with_cause(e.to_string())
                })?;
            }
            tokio::fs::copy(temp, dest_path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "本地复制失败").with_cause(e.to_string())
            })?;
            let meta = tokio::fs::metadata(dest_path).await.ok();
            Ok(meta.map(|m| m.len()).unwrap_or(0))
        }
        TransferProtocol::Sftp => {
            relay_sftp_dest(host, dest_connection_id, dest_path, temp, resume, cancel).await
        }
        TransferProtocol::S3 => {
            host.s3_upload_from_file(dest_connection_id, dest_path, temp)
                .await
        }
        _ => Err(OmniError::invalid_input(format!(
            "不支持的目标协议: {proto:?}"
        ))),
    }
}

pub async fn relay_s3_s3(
    host: &dyn TransferHost,
    source_connection_id: &str,
    source_path: &str,
    dest_connection_id: &str,
    dest_path: &str,
    cancel: &AtomicBool,
) -> Result<u64, OmniError> {
    let src_key = s3_key(source_path);
    let dst_key = s3_key(dest_path);
    if source_connection_id == dest_connection_id
        || host
            .same_s3_bucket_and_endpoint(source_connection_id, dest_connection_id)
            .await?
    {
        if host
            .s3_copy_internal(source_connection_id, &src_key, &dst_key)
            .await
            .is_ok()
        {
            let _ = cancel.load(Ordering::Relaxed);
            return Ok(0);
        }
    }
    let temp = std::env::temp_dir().join(format!("s3s3-{}.tmp", std::process::id()));
    let written = host
        .s3_download_to_file(source_connection_id, source_path, &temp)
        .await?;
    if cancel.load(Ordering::Relaxed) {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
    }
    let n = host
        .s3_upload_from_file(dest_connection_id, dest_path, &temp)
        .await?;
    let _ = tokio::fs::remove_file(&temp).await;
    Ok(n.max(written))
}

/// 进度广播。
pub async fn emit_relay_progress(
    sink: &dyn TransferEventSink,
    id: &str,
    state: TransferState,
    bytes_done: f64,
    bytes_total: Option<f64>,
    error: Option<String>,
) {
    let progress = match bytes_total {
        Some(t) if t > 0.0 => ((bytes_done / t) * 100.0).clamp(0.0, 100.0),
        _ => 0.0,
    };
    let job = crate::types::FileTransferJob {
        id: id.to_string(),
        batch_id: String::new(),
        op: crate::types::FileTransferOp::Copy,
        source: crate::types::FileTransferEndpoint {
            connection_id: String::new(),
            path: String::new(),
            kind: String::new(),
            name: String::new(),
        },
        dest: crate::types::FileTransferEndpoint {
            connection_id: String::new(),
            path: String::new(),
            kind: String::new(),
            name: String::new(),
        },
        route: crate::types::FileTransferRoute::Relay,
        route_reason: String::new(),
        state: match state {
            TransferState::Queued => crate::types::FileTransferState::Queued,
            TransferState::Running => crate::types::FileTransferState::Running,
            TransferState::Done => crate::types::FileTransferState::Done,
            TransferState::Error => crate::types::FileTransferState::Error,
            TransferState::Cancelled => crate::types::FileTransferState::Cancelled,
        },
        bytes_done,
        bytes_total,
        speed_bps: None,
        error,
        progress,
        source_fingerprint: None,
        partial_path: None,
    };
    sink.emit_transfer_job(&job).await;
    let _ = TRANSFER_PROGRESS_EVENT;
}

pub async fn transfer_start(
    host: Arc<dyn TransferHost>,
    sink: Arc<dyn TransferEventSink>,
    cancel_flags: Arc<tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
    req: TransferStartRequest,
) -> Result<String, String> {
    let id = new_transfer_id();
    let cancel = Arc::new(AtomicBool::new(false));
    let dest_path = dest_final_path(
        host.as_ref(),
        &req.dest_connection_id,
        &req.dest_path,
        req.conflict_policy.as_deref(),
    )
    .map_err(|e| e.to_string())?;
    let resume = req.resume;
    cancel_flags.lock().await.insert(id.clone(), cancel.clone());

    let host_ref = host.clone();
    let sink_ref = sink.clone();
    let job_id = id.clone();
    let source_connection_id = req.source_connection_id.clone();
    let source_path = req.source_path.clone();
    let dest_connection_id = req.dest_connection_id.clone();
    let cancel_flag = cancel.clone();
    let flags = cancel_flags.clone();

    tokio::spawn(async move {
        emit_relay_progress(
            sink_ref.as_ref(),
            &job_id,
            TransferState::Running,
            0.0,
            None,
            None,
        )
        .await;
        let result: Result<u64, OmniError> = async {
            let dest_proto = host_ref.connection_protocol(&dest_connection_id).await?;
            let source_proto = host_ref.connection_protocol(&source_connection_id).await?;
            if dest_proto == TransferProtocol::S3 && source_proto == TransferProtocol::S3 {
                relay_s3_s3(
                    host_ref.as_ref(),
                    &source_connection_id,
                    &source_path,
                    &dest_connection_id,
                    &dest_path,
                    &cancel_flag,
                )
                .await
            } else if dest_proto == TransferProtocol::S3 || source_proto == TransferProtocol::S3 {
                let (temp, _len) = source_to_local_temp(
                    host_ref.as_ref(),
                    &source_connection_id,
                    &source_path,
                    &job_id,
                    &cancel_flag,
                )
                .await?;
                let cleanup = temp.clone();
                let n = local_temp_to_dest(
                    host_ref.as_ref(),
                    &dest_connection_id,
                    &dest_path,
                    &temp,
                    resume,
                    &cancel_flag,
                )
                .await;
                let _ = tokio::fs::remove_file(&cleanup).await;
                n
            } else if dest_connection_id == LOCAL_CONNECTION_ID {
                relay_local_dest(
                    host_ref.as_ref(),
                    &source_connection_id,
                    &source_path,
                    &dest_path,
                    &cancel_flag,
                )
                .await
            } else if source_connection_id == LOCAL_CONNECTION_ID {
                let temp = std::env::temp_dir().join(format!("{}.part", job_id));
                relay_local_dest(
                    host_ref.as_ref(),
                    &source_connection_id,
                    &source_path,
                    temp.to_str().unwrap(),
                    &cancel_flag,
                )
                .await?;
                let n = relay_sftp_dest(
                    host_ref.as_ref(),
                    &dest_connection_id,
                    &dest_path,
                    &temp,
                    resume,
                    &cancel_flag,
                )
                .await;
                let _ = tokio::fs::remove_file(&temp).await;
                n
            } else {
                relay_sftp_sftp(
                    host_ref.as_ref(),
                    &source_connection_id,
                    &source_path,
                    &dest_connection_id,
                    &dest_path,
                    resume,
                    &cancel_flag,
                )
                .await
            }
        }
        .await;

        flags.lock().await.remove(&job_id);
        match result {
            Ok(bytes) => {
                emit_relay_progress(
                    sink_ref.as_ref(),
                    &job_id,
                    TransferState::Done,
                    bytes as f64,
                    Some(bytes as f64),
                    None,
                )
                .await;
            }
            Err(e) => {
                emit_relay_progress(
                    sink_ref.as_ref(),
                    &job_id,
                    TransferState::Error,
                    0.0,
                    None,
                    Some(e.user_message()),
                )
                .await;
            }
        }
    });

    Ok(id)
}

pub async fn transfer_cancel(
    cancel_flags: &tokio::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
    id: String,
) -> Result<(), String> {
    let flags = cancel_flags.lock().await;
    if let Some(flag) = flags.get(&id) {
        flag.store(true, Ordering::Relaxed);
        Ok(())
    } else {
        Err("未找到传输任务".to_string())
    }
}
