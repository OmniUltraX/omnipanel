//! P2 文件管理器（Web 端）：本机 + SFTP。
//!
//! 复用 `omnipanel-ssh::SshSession` 的 SFTP 能力（与桌面端 `file_manager.rs`
//! 的 SFTP 后端同一实现），连接配置复用 `omnipanel-store` 存储 + Vault 凭据。
//!
//! 范围说明（诚实边界）：
//! - 协议：本机文件系统 + SFTP（含绑定 SSH 连接复用）。
//! - FTP / S3 依赖桌面端 `suppaftp` / `rust-s3` 依赖与 `s3_list_compat` 等模块，
//!   本 crate 未引入，Web 端返回明确错误（后续可按需引入）。
//! - 跨连接传输引擎（fastpath / remote-direct / relay + 断点续传）体量较大且深度依赖
//!   桌面端 `AppState`/`AppHandle`，P2 先提供**本机→目标 & 目标→本机**的单向传输
//!   （SFTP 直传），跨连接 relay 在后续版本接入。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{SshAuth, SshConfig, SshSession, ssh_config_from_json};
use omnipanel_store::{Connection, ConnectionKind, Vault, inject_ssh_vault_into_config};
use serde::{Deserialize, Serialize};

use crate::state::ServerState;

/// 内建本机连接 id（与桌面端一致，不落库、始终可用）。
pub const LOCAL_CONNECTION_ID: &str = "file-local";

fn unix_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn local_home() -> Result<PathBuf, OmniError> {
    if let Ok(p) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        return Ok(PathBuf::from(p));
    }
    Err(OmniError::new(ErrorCode::Internal, "无法获取用户主目录"))
}

fn resolve_local_path(path: &str) -> Result<PathBuf, OmniError> {
    if path.is_empty() || path == "/" || path == "~" {
        local_home()
    } else if let Some(rest) = path.strip_prefix("~/") {
        Ok(local_home()?.join(rest))
    } else {
        Ok(PathBuf::from(path))
    }
}

/// 文件条目（与桌面端 `FileEntry` 同形）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub kind: String,
    #[serde(rename = "size")]
    pub size: f64,
    pub modified: i64,
    pub permissions: Option<String>,
}

/// 目录列表结果（与桌面端 `FileListDirResult` 同形）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileListDirResult {
    pub entries: Vec<FileEntry>,
    pub truncated: bool,
    pub next_continuation_token: Option<String>,
}

/// 文件连接摘要。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileManagerConnectionInfo {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub status: String,
    pub group: String,
}

/// 解析自 `Connection.config`（kind=file）的配置。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileConnConfig {
    #[serde(default)]
    pub protocol: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub user: String,
    #[serde(default, rename = "rootPath")]
    pub root_path: String,
    #[serde(default, rename = "sshConnectionId")]
    pub ssh_connection_id: Option<String>,
    #[serde(default)]
    pub bucket: String,
}

fn parse_file_config(conn: &Connection) -> Result<FileConnConfig, OmniError> {
    serde_json::from_str(&conn.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "文件连接配置解析失败").with_cause(e.to_string())
    })
}

fn protocol_of(cfg: &FileConnConfig) -> &str {
    let p = cfg.protocol.to_lowercase();
    if p.is_empty() {
        "sftp"
    } else {
        &cfg.protocol
    }
}

/// 连接 id → 连接模型（本机返回 None）。
async fn load_file_connection(
    state: &ServerState,
    connection_id: &str,
) -> Result<Option<Connection>, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(None);
    }
    let storage = state.storage.lock().await;
    Ok(storage.get_connection(connection_id)?)
}

fn resolve_secret(conn: &Connection) -> Option<String> {
    conn.credential_ref
        .as_deref()
        .and_then(|r| Vault::get(r).ok())
}

/// 解析 SFTP 文件连接的实际 SSH 端点（含关联 SSH 连接上的 host/port/user）。
async fn ssh_config_from_file_conn(
    state: &ServerState,
    conn: &Connection,
    cfg: &FileConnConfig,
) -> Result<SshConfig, OmniError> {
    if let Some(ssh_id) = cfg.ssh_connection_id.as_deref().filter(|s| !s.is_empty()) {
        let storage = state.storage.lock().await;
        let ssh_conn = storage
            .get_connection(ssh_id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "关联的 SSH 连接不存在"))?;
        if ssh_conn.kind != ConnectionKind::Ssh {
            return Err(OmniError::invalid_input("关联连接不是 SSH 类型"));
        }
        let (patched, secret) = inject_ssh_vault_into_config(
            &ssh_conn.config,
            &ssh_conn.id,
            ssh_conn.credential_ref.as_deref(),
        )?;
        return ssh_config_from_json(&patched, secret.as_deref());
    }
    let secret = resolve_secret(conn).unwrap_or_default();
    let port = cfg.port.unwrap_or(22);
    let auth = if !secret.is_empty() {
        SshAuth::Password { password: secret }
    } else {
        SshAuth::PrivateKey {
            pem: None,
            key_path: Some("auto".into()),
            passphrase: None,
        }
    };
    Ok(SshConfig {
        host: cfg.host.clone(),
        port,
        user: cfg.user.clone(),
        auth,
        public_ip: None,
    })
}

/// SFTP 会话：优先复用缓存；关联 SSH 连接时每次走连接（无池，串行复用同连接）。
async fn sftp_session_for(
    state: &ServerState,
    connection_id: &str,
    conn: &Connection,
    cfg: &FileConnConfig,
) -> Result<Arc<SshSession>, OmniError> {
    if let Some(ssh_id) = cfg.ssh_connection_id.as_deref().filter(|s| !s.is_empty()) {
        // 复用已有 SSH 交互会话（如果存在）
        if let Some(session) = state.ssh_sessions.lock().await.get(ssh_id) {
            return Ok(session.clone());
        }
        // 否则独立建会话（进程内缓存，按 file 连接 id）
        {
            let sessions = state.file_sftp_sessions.lock().await;
            if let Some(s) = sessions.get(connection_id) {
                return Ok(s.clone());
            }
        }
        let ssh_cfg = ssh_config_from_file_conn(state, conn, cfg).await?;
        let session = SshSession::connect_no_shell(ssh_cfg).await?;
        let arc = Arc::new(session);
        state
            .file_sftp_sessions
            .lock()
            .await
            .insert(connection_id.to_string(), arc.clone());
        return Ok(arc);
    }

    {
        let sessions = state.file_sftp_sessions.lock().await;
        if let Some(s) = sessions.get(connection_id) {
            return Ok(s.clone());
        }
    }
    let ssh_cfg = ssh_config_from_file_conn(state, conn, cfg).await?;
    let session = SshSession::connect_no_shell(ssh_cfg).await?;
    let arc = Arc::new(session);
    state
        .file_sftp_sessions
        .lock()
        .await
        .insert(connection_id.to_string(), arc.clone());
    Ok(arc)
}

fn sftp_entry_to_file(entry: &omnipanel_ssh::SftpEntry, base: &str) -> FileEntry {
    FileEntry {
        name: entry.name.clone(),
        path: join_posix(base, &entry.name),
        kind: if entry.is_symlink {
            "symlink".into()
        } else if entry.is_dir {
            "dir".into()
        } else {
            "file".into()
        },
        size: entry.size as f64,
        modified: 0,
        permissions: None,
    }
}

fn join_posix(base: &str, name: &str) -> String {
    if base == "/" || base.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

/// SFTP 递归删除目录（无内建递归，逐个遍历删除）。
async fn sftp_remove_dir_recursive(session: &SshSession, path: &str) -> Result<(), OmniError> {
    let list = session.sftp_list(path).await?;
    for entry in list {
        let child = join_posix(path, &entry.name);
        if entry.is_dir {
            Box::pin(sftp_remove_dir_recursive(session, &child)).await?;
        } else {
            session.sftp_remove(&child).await?;
        }
    }
    session.sftp_remove(path).await
}

fn sort_file_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

fn filter_file_entries(
    mut entries: Vec<FileEntry>,
    search: Option<&str>,
) -> Result<Vec<FileEntry>, OmniError> {
    let Some(q) = search
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
    else {
        return Ok(entries);
    };
    entries.retain(|e| e.name.to_lowercase().contains(&q));
    sort_file_entries(&mut entries);
    Ok(entries)
}

fn list_local_dir(path: &str) -> Result<Vec<FileEntry>, OmniError> {
    let p = resolve_local_path(path)?;
    if !p.exists() {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            format!("路径不存在: {}", p.display()),
        ));
    }
    if !p.is_dir() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "不是目录"));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&p)
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取目录失败").with_cause(e.to_string()))?
    {
        let entry = entry.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取目录项失败").with_cause(e.to_string())
        })?;
        let meta = entry.metadata().ok();
        let name = entry.file_name().to_string_lossy().to_string();
        let full = entry.path().to_string_lossy().to_string();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let size = meta
            .as_ref()
            .map(|m| if m.is_dir() { 0 } else { m.len() })
            .unwrap_or(0);
        let modified = meta
            .as_ref()
            .and_then(|m| m.modified().ok())
            .map(unix_secs)
            .unwrap_or(0);
        #[cfg(unix)]
        let permissions = meta.as_ref().and_then(|m| {
            use std::os::unix::fs::PermissionsExt;
            Some(format!("{:o}", m.permissions().mode() & 0o777))
        });
        #[cfg(not(unix))]
        let permissions: Option<String> = None;
        entries.push(FileEntry {
            name,
            path: full,
            kind: if is_dir { "dir".into() } else { "file".into() },
            size: size as f64,
            modified,
            permissions,
        });
    }
    sort_file_entries(&mut entries);
    Ok(entries)
}

fn local_read(path: &str, max_bytes: u64) -> Result<Vec<u8>, OmniError> {
    let p = resolve_local_path(path)?;
    if p.is_dir() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "无法预览目录"));
    }
    if !p.exists() {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            format!("文件不存在: {}", p.display()),
        ));
    }
    let data = std::fs::read(&p)
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取文件失败").with_cause(e.to_string()))?;
    if data.len() as u64 > max_bytes {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("文件超过大小限制 ({max_bytes} 字节)"),
        ));
    }
    Ok(data)
}

fn local_write(path: &str, data: &[u8]) -> Result<(), OmniError> {
    if let Some(parent) = Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    std::fs::write(path, data)
        .map_err(|e| OmniError::new(ErrorCode::Io, "写入文件失败").with_cause(e.to_string()))
}

fn local_mkdir(path: &str) -> Result<(), OmniError> {
    let p = resolve_local_path(path)?;
    std::fs::create_dir_all(&p)
        .map_err(|e| OmniError::new(ErrorCode::Io, "创建目录失败").with_cause(e.to_string()))
}

fn local_rename(old: &str, new: &str) -> Result<(), OmniError> {
    let old = resolve_local_path(old)?;
    let new = resolve_local_path(new)?;
    std::fs::rename(&old, &new)
        .map_err(|e| OmniError::new(ErrorCode::Io, "重命名失败").with_cause(e.to_string()))
}

fn local_delete(path: &str) -> Result<(), OmniError> {
    let p = resolve_local_path(path)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除目录失败").with_cause(e.to_string()))
    } else {
        std::fs::remove_file(&p)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除文件失败").with_cause(e.to_string()))
    }
}

/* ---------------- 命令实现 ---------------- */

pub async fn file_list_connections(
    state: &ServerState,
) -> Result<Vec<FileManagerConnectionInfo>, String> {
    let mut out = vec![FileManagerConnectionInfo {
        id: LOCAL_CONNECTION_ID.to_string(),
        name: "本机文件系统".to_string(),
        protocol: "local".to_string(),
        status: "online".to_string(),
        group: "本地文件".to_string(),
    }];
    let storage = state.storage.lock().await;
    for conn in storage
        .list_connections_by_kind(ConnectionKind::File)
        .map_err(|e| e.to_string())?
    {
        let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
        out.push(FileManagerConnectionInfo {
            id: conn.id,
            name: conn.name,
            protocol: protocol_of(&cfg).to_string(),
            status: "offline".to_string(),
            group: conn.group,
        });
    }
    Ok(out)
}

pub async fn file_list_dir(
    state: &ServerState,
    connection_id: String,
    path: String,
    search: Option<String>,
) -> Result<FileListDirResult, String> {
    if connection_id == LOCAL_CONNECTION_ID {
        let entries =
            filter_file_entries(list_local_dir(&path).map_err(|e| e.to_string())?, search.as_deref())
                .map_err(|e| e.to_string())?;
        return Ok(FileListDirResult {
            entries,
            truncated: false,
            next_continuation_token: None,
        });
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    match protocol_of(&cfg) {
        "local" => {
            let entries = filter_file_entries(list_local_dir(&path).map_err(|e| e.to_string())?, search.as_deref())
                .map_err(|e| e.to_string())?;
            Ok(FileListDirResult {
                entries,
                truncated: false,
                next_continuation_token: None,
            })
        }
        "sftp" => {
            let session = sftp_session_for(state, &connection_id, &conn, &cfg)
                .await
                .map_err(|e| e.to_string())?;
            let remote = if path.is_empty() {
                if cfg.root_path.is_empty() {
                    "/".to_string()
                } else {
                    cfg.root_path.clone()
                }
            } else {
                path.clone()
            };
            let list = session.sftp_list(&remote).await.map_err(|e| e.to_string())?;
            let mut entries: Vec<FileEntry> = list
                .iter()
                .map(|e| sftp_entry_to_file(e, &remote))
                .collect();
            sort_file_entries(&mut entries);
            let entries = filter_file_entries(entries, search.as_deref())
                .map_err(|e| e.to_string())?;
            Ok(FileListDirResult {
                entries,
                truncated: false,
                next_continuation_token: None,
            })
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}（当前支持 local / sftp）")),
    }
}

pub async fn file_read_file(
    state: &ServerState,
    connection_id: String,
    path: String,
    max_bytes: f64,
) -> Result<Vec<u8>, String> {
    let max_bytes = max_bytes.max(0.0) as u64;
    if connection_id == LOCAL_CONNECTION_ID {
        return local_read(&path, max_bytes).map_err(|e| e.to_string());
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    match protocol_of(&cfg) {
        "local" => local_read(&path, max_bytes).map_err(|e| e.to_string()),
        "sftp" => {
            let session = sftp_session_for(state, &connection_id, &conn, &cfg)
                .await
                .map_err(|e| e.to_string())?;
            let data = session.sftp_download(&path).await.map_err(|e| e.to_string())?;
            if data.len() as u64 > max_bytes {
                return Err("文件过大".to_string());
            }
            Ok(data)
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

pub async fn file_upload_file(
    state: &ServerState,
    connection_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_write(&path, &data).map_err(|e| e.to_string());
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    match protocol_of(&cfg) {
        "local" => local_write(&path, &data).map_err(|e| e.to_string()),
        "sftp" => {
            let session = sftp_session_for(state, &connection_id, &conn, &cfg)
                .await
                .map_err(|e| e.to_string())?;
            session.sftp_upload(&path, &data).await.map_err(|e| e.to_string())
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

pub async fn file_mkdir(
    state: &ServerState,
    connection_id: String,
    path: String,
) -> Result<(), String> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_mkdir(&path).map_err(|e| e.to_string());
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    match protocol_of(&cfg) {
        "local" => local_mkdir(&path).map_err(|e| e.to_string()),
        "sftp" => {
            let session = sftp_session_for(state, &connection_id, &conn, &cfg)
                .await
                .map_err(|e| e.to_string())?;
            session.sftp_mkdir(&path).await.map_err(|e| e.to_string())
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

pub async fn file_rename(
    state: &ServerState,
    connection_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_rename(&old_path, &new_path).map_err(|e| e.to_string());
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    match protocol_of(&cfg) {
        "local" => local_rename(&old_path, &new_path).map_err(|e| e.to_string()),
        "sftp" => {
            let session = sftp_session_for(state, &connection_id, &conn, &cfg)
                .await
                .map_err(|e| e.to_string())?;
            session.sftp_rename(&old_path, &new_path).await.map_err(|e| e.to_string())
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

pub async fn file_delete(
    state: &ServerState,
    connection_id: String,
    path: String,
    entry_kind: Option<String>,
) -> Result<(), String> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_delete(&path).map_err(|e| e.to_string());
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    match protocol_of(&cfg) {
        "local" => local_delete(&path).map_err(|e| e.to_string()),
        "sftp" => {
            let session = sftp_session_for(state, &connection_id, &conn, &cfg)
                .await
                .map_err(|e| e.to_string())?;
            if entry_kind.as_deref() == Some("dir") || path.ends_with('/') {
                // SFTP 无递归删除目录，尝试逐个删除内容（递归）
                sftp_remove_dir_recursive(&session, &path)
                    .await
                    .map_err(|e| e.to_string())
            } else {
                session.sftp_remove(&path).await.map_err(|e| e.to_string())
            }
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

/// 本机常用目录快捷路径。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQuickPaths {
    pub home: String,
    pub desktop: String,
    pub documents: String,
    pub downloads: String,
}

pub async fn file_local_quick_paths() -> Result<FileQuickPaths, String> {
    let home = local_home().map_err(|e| e.to_string())?;
    Ok(FileQuickPaths {
        home: home.to_string_lossy().into_owned(),
        desktop: home.join("Desktop").to_string_lossy().into_owned(),
        documents: home.join("Documents").to_string_lossy().into_owned(),
        downloads: home.join("Downloads").to_string_lossy().into_owned(),
    })
}

/// 本机文件系统平台信息与卷/盘符列表。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLocalSystemInfo {
    pub platform: String,
    pub computer_root: String,
    pub volumes: Vec<FileLocalVolume>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileLocalVolume {
    pub label: String,
    pub path: String,
}

pub async fn file_local_system_info() -> Result<FileLocalSystemInfo, String> {
    #[cfg(unix)]
    let volumes = vec![FileLocalVolume {
        label: "根目录".to_string(),
        path: "/".to_string(),
    }];
    #[cfg(windows)]
    let volumes: Vec<FileLocalVolume> = (b'A'..=b'Z')
        .filter_map(|letter| {
            let drive = format!("{}:\\", letter as char);
            Path::new(&drive).exists().then(|| FileLocalVolume {
                label: format!("{}:", letter as char),
                path: drive,
            })
        })
        .collect();
    Ok(FileLocalSystemInfo {
        platform: std::env::consts::OS.to_string(),
        computer_root: "/".to_string(),
        volumes,
    })
}

/* ---------------- 单向传输（本机 ↔ SFTP） ---------------- */

/// 上传本地文件到目标连接（SFTP / local）。
pub async fn file_upload_local_bytes(
    state: &ServerState,
    file_name: String,
    data: Vec<u8>,
    dest_connection_id: String,
    dest_dir: String,
) -> Result<String, String> {
    let safe_name: String = file_name
        .chars()
        .map(|c| if r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    let dest_path = if dest_dir == "/" || dest_dir.is_empty() {
        format!("/{safe_name}")
    } else {
        format!("{}/{}", dest_dir.trim_end_matches('/'), safe_name)
    };

    if dest_connection_id == LOCAL_CONNECTION_ID {
        local_write(&dest_path, &data).map_err(|e| e.to_string())?;
        return Ok("local".to_string());
    }

    let conn = load_file_connection(state, &dest_connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {dest_connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    match protocol_of(&cfg) {
        "sftp" => {
            let session = sftp_session_for(state, &dest_connection_id, &conn, &cfg)
                .await
                .map_err(|e| e.to_string())?;
            session.sftp_upload(&dest_path, &data).await.map_err(|e| e.to_string())?;
            Ok(dest_connection_id)
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

/// 下载目标连接文件到本机（browser 经 `file_read_file` 拉取，此命令供将来断点/大文件）。
pub async fn file_download_file(
    state: &ServerState,
    connection_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let data = file_read_file(state, connection_id, remote_path, (512 * 1024 * 1024) as f64)
        .await?;
    local_write(&local_path, &data).map_err(|e| e.to_string())
}
