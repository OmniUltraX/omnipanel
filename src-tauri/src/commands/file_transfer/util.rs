use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use tauri::{AppHandle, Emitter};

use crate::commands::file_manager::{
    load_file_connection, parse_file_config, protocol_of, resolve_local_path, sftp_session_for,
    FileProtocol, LOCAL_CONNECTION_ID,
};
use crate::state::AppState;

use super::remote_direct::remote_direct_eligible;
use super::types::{FileTransferEndpoint, FileTransferJob, FileTransferRoute, TRANSFER_PROGRESS_EVENT};

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
        let exists = resolve_local_path(&full)
            .map(|p| p.exists())
            .unwrap_or_else(|_| Path::new(&full).exists());
        if !exists {
            return candidate;
        }
    }
    format!("{stem}-{}{}", now_ms(), ext)
}

/// 目标路径是否已存在（本机 / SFTP；其他协议视为不存在，由写入侧覆盖）。
pub async fn dest_path_exists(
    state: &AppState,
    connection_id: &str,
    path: &str,
) -> Result<bool, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(resolve_local_path(path)
            .map(|p| p.exists())
            .unwrap_or(false));
    }
    let proto = resolve_protocol(state, connection_id).await?;
    match proto {
        FileProtocol::Sftp => {
            let session = open_sftp(state, connection_id).await?;
            Ok(session.sftp_exists(path).await)
        }
        // FTP / S3：暂不做预检，保持覆盖语义
        _ => Ok(false),
    }
}

/// 生成目标侧不冲突的相对名（本机 / SFTP）。
pub async fn unique_rename_name_for(
    state: &AppState,
    connection_id: &str,
    dest_dir: &str,
    name: &str,
) -> Result<String, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
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
        if !dest_path_exists(state, connection_id, &full).await? {
            return Ok(candidate);
        }
    }
    Ok(format!("{stem}-{}{}", now_ms(), ext))
}

pub async fn resolve_protocol(
    state: &AppState,
    connection_id: &str,
) -> Result<FileProtocol, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(FileProtocol::Local);
    }
    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    Ok(protocol_of(&cfg))
}

/// 跨连接 S3 是否值得尝试服务端 Copy（同 accessKey + 同 endpoint 族）。
async fn s3_server_copy_eligible(
    state: &AppState,
    source_connection_id: &str,
    dest_connection_id: &str,
) -> bool {
    let Ok(Some(src_conn)) = load_file_connection(state, source_connection_id).await else {
        return false;
    };
    let Ok(Some(dst_conn)) = load_file_connection(state, dest_connection_id).await else {
        return false;
    };
    let Ok(src_cfg) = parse_file_config(&src_conn) else {
        return false;
    };
    let Ok(dst_cfg) = parse_file_config(&dst_conn) else {
        return false;
    };
    if src_cfg.access_key.trim().is_empty()
        || src_cfg.access_key.trim() != dst_cfg.access_key.trim()
    {
        return false;
    }
    let src_ep = src_cfg.endpoint.trim().to_ascii_lowercase();
    let dst_ep = dst_cfg.endpoint.trim().to_ascii_lowercase();
    if !src_ep.is_empty() && !dst_ep.is_empty() && src_ep != dst_ep {
        return false;
    }
    // 阿里云等自签路径暂不走服务端拷
    let src_provider = src_cfg.provider.trim().to_ascii_lowercase();
    let dst_provider = dst_cfg.provider.trim().to_ascii_lowercase();
    if src_provider == "aliyun" || dst_provider == "aliyun" {
        return false;
    }
    true
}

/// policy: "ask" | "always" | "never"
pub async fn decide_route(
    state: &AppState,
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

    // 跨连接 S3：同账号/同端点可尝试服务端 CopyObject
    if let (Ok(FileProtocol::S3), Ok(FileProtocol::S3)) = (
        resolve_protocol(state, source_connection_id).await,
        resolve_protocol(state, dest_connection_id).await,
    ) {
        if s3_server_copy_eligible(state, source_connection_id, dest_connection_id).await {
            return (
                FileTransferRoute::Fastpath,
                "S3 服务端拷贝（失败将回落本机中继）".into(),
                false,
            );
        }
    }

    let eligible =
        remote_direct_eligible(state, source_connection_id, dest_connection_id).await;

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

    let _ = (source_connection_id, dest_connection_id);
    (
        FileTransferRoute::Relay,
        "跨连接本机流式中继".into(),
        false,
    )
}

pub async fn emit_job(app: &AppHandle, job: &FileTransferJob) {
    let _ = app.emit(TRANSFER_PROGRESS_EVENT, job);
}

pub async fn open_sftp(
    state: &AppState,
    connection_id: &str,
) -> Result<std::sync::Arc<omnipanel_ssh::SshSession>, OmniError> {
    let conn = load_file_connection(state, connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    sftp_session_for(state, connection_id, &conn, &cfg).await
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
