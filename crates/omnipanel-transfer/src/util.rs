use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};

use crate::provider::{TransferHost, TransferProtocol, LOCAL_CONNECTION_ID};
use crate::remote_direct::remote_direct_eligible;
use crate::types::{FileTransferEndpoint, FileTransferJob, FileTransferRoute};
use crate::event::TransferEventSink;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn join_dest(dir: &str, name: &str) -> String {
    let name = name.replace('\\', "/");
    let parts: Vec<&str> = name.split('/').filter(|p| !p.is_empty()).collect();
    if parts.is_empty() {
        return dir.to_string();
    }
    let mut cur = dir.trim_end_matches(['/', '\\']).to_string();
    for part in parts {
        if cur.is_empty() || cur == "." {
            cur = part.to_string();
            continue;
        }
        if cur == "/" || cur == "\\" {
            cur = format!("/{part}");
            continue;
        }
        if cur.len() == 2 && cur.as_bytes()[1] == b':' {
            cur = format!("{cur}\\{part}");
            continue;
        }
        if cur.contains('\\') && !cur.contains('/') {
            cur = format!("{cur}\\{part}");
        } else {
            cur = format!("{cur}/{part}");
        }
    }
    cur
}

pub fn unique_rename_name(dest_dir: &str, name: &str) -> String {
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let parent_rel = Path::new(name)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .filter(|p| !p.is_empty() && p != ".");
    for i in 1..10_000 {
        let leaf = format!("{stem} ({i}){ext}");
        let candidate = match &parent_rel {
            Some(p) => format!("{p}/{leaf}"),
            None => leaf,
        };
        let full = join_dest(dest_dir, &candidate);
        let exists = host_resolve_local_exists(&full);
        if !exists {
            return candidate;
        }
    }
    format!("{stem}-{}{}", now_ms(), ext)
}

fn host_resolve_local_exists(path: &str) -> bool {
    Path::new(path).exists()
}

pub async fn dest_path_exists(
    host: &dyn TransferHost,
    connection_id: &str,
    path: &str,
) -> Result<bool, OmniError> {
    if connection_id == host.local_connection_id() {
        return Ok(host
            .resolve_local_path(path)
            .map(|p| p.exists())
            .unwrap_or(false));
    }
    let proto = resolve_protocol(host, connection_id).await?;
    match proto {
        TransferProtocol::Sftp => {
            let session = open_sftp(host, connection_id).await?;
            Ok(session.sftp_exists(path).await)
        }
        _ => Ok(false),
    }
}

pub async fn unique_rename_name_for(
    host: &dyn TransferHost,
    connection_id: &str,
    dest_dir: &str,
    name: &str,
) -> Result<String, OmniError> {
    if connection_id == host.local_connection_id() {
        return Ok(unique_rename_name(dest_dir, name));
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or(name);
    let ext = path
        .extension()
        .and_then(|s| s.to_str())
        .map(|e| format!(".{e}"))
        .unwrap_or_default();
    let parent_rel = Path::new(name)
        .parent()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .filter(|p| !p.is_empty() && p != ".");

    for i in 1..10_000 {
        let leaf = format!("{stem} ({i}){ext}");
        let candidate = match &parent_rel {
            Some(p) => format!("{p}/{leaf}"),
            None => leaf,
        };
        let full = join_dest(dest_dir, &candidate);
        if !dest_path_exists(host, connection_id, &full).await? {
            return Ok(candidate);
        }
    }
    Ok(format!("{stem}-{}{}", now_ms(), ext))
}

pub async fn resolve_protocol(
    host: &dyn TransferHost,
    connection_id: &str,
) -> Result<TransferProtocol, OmniError> {
    if connection_id == host.local_connection_id() {
        return Ok(TransferProtocol::Local);
    }
    host.connection_protocol(connection_id).await
}

pub async fn decide_route(
    host: &dyn TransferHost,
    source_connection_id: &str,
    dest_connection_id: &str,
    force: Option<FileTransferRoute>,
    policy: &str,
) -> (FileTransferRoute, String, bool) {
    if let Some(FileTransferRoute::Relay) = force {
        return (FileTransferRoute::Relay, "用户强制本机中继".into(), false);
    }
    if source_connection_id == dest_connection_id {
        return (
            FileTransferRoute::Fastpath,
            "同连接服务端/本地拷贝".into(),
            false,
        );
    }

    if let (Ok(TransferProtocol::S3), Ok(TransferProtocol::S3)) = (
        resolve_protocol(host, source_connection_id).await,
        resolve_protocol(host, dest_connection_id).await,
    ) {
        if host
            .s3_server_copy_eligible(source_connection_id, dest_connection_id)
            .await
        {
            return (
                FileTransferRoute::Fastpath,
                "S3 服务端拷贝（失败将回落本机中继）".into(),
                false,
            );
        }
    }

    let eligible = remote_direct_eligible(host, source_connection_id, dest_connection_id).await;

    if matches!(force, Some(FileTransferRoute::RemoteDirect)) && eligible {
        return (
            FileTransferRoute::RemoteDirect,
            "用户指定远程直传".into(),
            false,
        );
    }

    if eligible {
        match policy {
            "never" => {
                return (
                    FileTransferRoute::Relay,
                    "策略禁止直传，经本机中继".into(),
                    false,
                );
            }
            "always" => {
                return (
                    FileTransferRoute::RemoteDirect,
                    "策略始终直传（失败将自动回落中继）".into(),
                    false,
                );
            }
            _ => {
                return (
                    FileTransferRoute::RemoteDirect,
                    "两端 SFTP 可达时可远程直传（不占用本机带宽）".into(),
                    true,
                );
            }
        }
    }

    (
        FileTransferRoute::Relay,
        "跨连接本机流式中继".into(),
        false,
    )
}

pub async fn open_sftp(
    host: &dyn TransferHost,
    connection_id: &str,
) -> Result<Arc<omnipanel_ssh::SshSession>, OmniError> {
    host.open_sftp(connection_id).await
}

pub fn temp_transfer_path(job_id: &str, name: &str) -> PathBuf {
    let safe: String = name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    std::env::temp_dir()
        .join("omnipanel-xfer")
        .join(job_id)
        .join(safe)
}

pub fn endpoint(connection_id: &str, path: &str, kind: &str, name: &str) -> FileTransferEndpoint {
    FileTransferEndpoint {
        connection_id: connection_id.to_string(),
        path: path.to_string(),
        kind: kind.to_string(),
        name: name.to_string(),
    }
}

pub fn leaf_name(name: &str) -> String {
    name.replace('\\', "/")
        .rsplit('/')
        .next()
        .unwrap_or(name)
        .to_string()
}

pub async fn set_progress(
    sink: &dyn TransferEventSink,
    job: &mut FileTransferJob,
    done: u64,
    total: Option<u64>,
) {
    job.bytes_done = done as f64;
    job.bytes_total = total.map(|t| t as f64);
    job.progress = match total {
        Some(t) if t > 0 => ((done as f64 / t as f64) * 100.0).clamp(0.0, 100.0),
        _ => job.progress,
    };
    crate::event::emit_job(sink, job).await;
}

pub fn s3_key(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}

pub fn join_posix(base: &str, name: &str) -> String {
    if base == "/" || base.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

pub fn check_cancel(cancel: &std::sync::atomic::AtomicBool) -> Result<(), OmniError> {
    use std::sync::atomic::Ordering;
    if cancel.load(Ordering::Relaxed) {
        Err(OmniError::new(ErrorCode::Internal, "传输已取消"))
    } else {
        Ok(())
    }
}
