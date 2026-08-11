//! 传输任务持久化与断点续传元数据。

use std::path::{Path, PathBuf};

use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};

use crate::provider::TransferHost;
use crate::types::{FileTransferJob, FileTransferState};
use crate::util::open_sftp;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PersistEnvelope {
    pub jobs: Vec<FileTransferJob>,
}

fn store_path() -> Result<PathBuf, OmniError> {
    let root = omnipanel_store::omnipd_root().map_err(|e| {
        OmniError::new(ErrorCode::Storage, "无法定位数据目录").with_cause(e.to_string())
    })?;
    Ok(root.join("files").join("transfers").join("jobs.json"))
}

pub fn partial_dest_path(final_path: &str) -> String {
    format!("{final_path}.omnipanel.partial")
}

pub fn load_jobs() -> Vec<FileTransferJob> {
    let Ok(path) = store_path() else {
        return Vec::new();
    };
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice::<PersistEnvelope>(&bytes)
        .map(|e| e.jobs)
        .unwrap_or_default()
}

/// 启动时规整：Running → Error（中断），Probing → Queued。
pub fn normalize_after_load(mut jobs: Vec<FileTransferJob>) -> Vec<FileTransferJob> {
    for j in &mut jobs {
        match j.state {
            FileTransferState::Running | FileTransferState::Probing => {
                j.state = FileTransferState::Error;
                j.error = Some("应用退出时传输中断，可重试（将尝试断点续传）".into());
            }
            _ => {}
        }
    }
    jobs
}

pub async fn source_fingerprint(
    host: &dyn TransferHost,
    connection_id: &str,
    path: &str,
) -> Option<String> {
    if connection_id == host.local_connection_id() {
        let p = host.resolve_local_path(path).ok()?;
        let meta = std::fs::metadata(&p).ok()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        return Some(format!("local:{}:{}", meta.len(), mtime));
    }
    let session = open_sftp(host, connection_id).await.ok()?;
    let size = session.sftp_file_size(path).await.unwrap_or(0);
    let mtime = session.sftp_file_mtime(path).await.unwrap_or(0);
    Some(format!("sftp:{connection_id}:{path}:{size}:{mtime}"))
}

pub fn fingerprint_matches(job: &FileTransferJob, current: &str) -> bool {
    job.source_fingerprint
        .as_deref()
        .map(|f| f == current)
        .unwrap_or(false)
}

pub fn local_partial_len(host: &dyn TransferHost, path: &str) -> u64 {
    host.resolve_local_path(path)
        .ok()
        .and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len())
        .unwrap_or(0)
}

pub async fn sftp_partial_len(
    host: &dyn TransferHost,
    connection_id: &str,
    remote_partial_path: &str,
) -> u64 {
    let Ok(session) = open_sftp(host, connection_id).await else {
        return 0;
    };
    session
        .sftp_file_size(remote_partial_path)
        .await
        .unwrap_or(0)
}

pub async fn copy_local_resume(
    host: &dyn TransferHost,
    src: &Path,
    dest_final: &Path,
    partial: &Path,
    start_offset: u64,
    cancel: &std::sync::atomic::AtomicBool,
) -> Result<u64, OmniError> {
    use std::io::{Read, Seek, SeekFrom, Write};
    use std::sync::atomic::Ordering;

    if let Some(parent) = dest_final.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let mut reader = std::fs::File::open(src).map_err(|e| {
        OmniError::new(ErrorCode::Io, "打开源文件失败").with_cause(e.to_string())
    })?;
    if start_offset > 0 {
        reader.seek(SeekFrom::Start(start_offset)).map_err(|e| {
            OmniError::new(ErrorCode::Io, "定位源文件失败").with_cause(e.to_string())
        })?;
    }
    let mut writer = std::fs::OpenOptions::new()
        .create(true)
        .append(start_offset > 0)
        .write(true)
        .truncate(start_offset == 0)
        .open(partial)
        .map_err(|e| OmniError::new(ErrorCode::Io, "打开 partial 失败").with_cause(e.to_string()))?;

    let mut buf = vec![0u8; 256 * 1024];
    let mut done = start_offset;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(OmniError::new(ErrorCode::Internal, "传输已取消"));
        }
        let n = reader.read(&mut buf).map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取源文件失败").with_cause(e.to_string())
        })?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).map_err(|e| {
            OmniError::new(ErrorCode::Io, "写入 partial 失败").with_cause(e.to_string())
        })?;
        done += n as u64;
        crate::rate_limit::throttle_bytes(n as u64).await;
    }
    writer.flush().ok();
    drop(writer);
    std::fs::rename(partial, dest_final).map_err(|e| {
        OmniError::new(ErrorCode::Io, "提交目标文件失败").with_cause(e.to_string())
    })?;
    let _ = host;
    Ok(done)
}
