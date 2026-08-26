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
use omnipanel_s3::{S3Client, S3Config};
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

/// 读取本地文件内容（供文件索引等模块使用，限制最大字节数）。
pub fn file_read_file_sync_local(path: &str, max_bytes: u64) -> Result<Vec<u8>, OmniError> {
    let pb = resolve_local_path(path)?;
    let meta = std::fs::metadata(&pb).map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取文件元数据失败").with_cause(e.to_string())
    })?;
    if meta.len() > max_bytes {
        return Err(OmniError::invalid_input("文件过大，跳过索引"));
    }
    std::fs::read(&pb).map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取文件失败").with_cause(e.to_string())
    })
}

pub(crate) fn resolve_local_path(path: &str) -> Result<PathBuf, OmniError> {
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

/// FTP 连接建立（同步客户端，spawn_blocking 内使用）。
pub(crate) fn ftp_connect_sync(cfg: &FileConnConfig, secret: &str) -> Result<suppaftp::FtpStream, String> {
    use suppaftp::FtpStream;
    let port = cfg.port.unwrap_or(21);
    let addr = format!("{}:{}", cfg.host, port);
    let mut ftp = FtpStream::connect(&addr)
        .map_err(|e| format!("FTP 连接失败: {e}"))?;
    if !cfg.user.is_empty() {
        ftp.login(&cfg.user, &secret.to_string())
            .map_err(|e| format!("FTP 登录失败: {e}"))?;
    }
    Ok(ftp)
}

/// FTP 远端路径（空路径回退 rootPath / 根）。
pub(crate) fn ftp_remote_path(path: &str, cfg: &FileConnConfig) -> String {
    if path.is_empty() {
        if cfg.root_path.is_empty() {
            "/".to_string()
        } else {
            cfg.root_path.clone()
        }
    } else {
        path.to_string()
    }
}

/// 列出 FTP 目录（同步 + spawn_blocking）。
fn list_ftp_dir(
    cfg: &FileConnConfig,
    secret: &str,
    path: &str,
    search: Option<&str>,
) -> Result<Vec<FileEntry>, String> {
    let cfg = cfg.clone();
    let secret = secret.to_string();
    let path = path.to_string();
    let search = search.map(|s| s.to_lowercase());
    std::thread::spawn(move || -> Result<Vec<FileEntry>, String> {
        let mut ftp = ftp_connect_sync(&cfg, &secret)?;
        let remote = ftp_remote_path(&path, &cfg);
        ftp.cwd(&remote)
            .map_err(|e| format!("切换 FTP 目录失败: {e}"))?;
        let list = ftp.list(None).map_err(|e| format!("列出 FTP 目录失败: {e}"))?;
        let _ = ftp.quit();
        let mut entries = Vec::new();
        for line in list {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let is_dir = trimmed.starts_with('d');
            let parts: Vec<&str> = trimmed.split_whitespace().collect();
            let name = parts.last().copied().unwrap_or(trimmed).to_string();
            if name == "." || name == ".." {
                continue;
            }
            if let Some(q) = &search {
                if !name.to_lowercase().contains(q) {
                    continue;
                }
            }
            entries.push(FileEntry {
                name: name.clone(),
                path: join_posix(&remote, &name),
                kind: if is_dir { "dir".into() } else { "file".into() },
                size: 0.0,
                modified: 0,
                permissions: parts.first().map(|s| s.to_string()),
            });
        }
        sort_file_entries(&mut entries);
        Ok(entries)
    })
    .join()
    .map_err(|_| "FTP 任务线程异常".to_string())?
}

/// FTP 读取文件（同步 + spawn_blocking）。
fn read_ftp_file(cfg: &FileConnConfig, secret: &str, path: &str) -> Result<Vec<u8>, String> {
    use std::io::Read;
    let cfg = cfg.clone();
    let secret = secret.to_string();
    let path = path.to_string();
    std::thread::spawn(move || -> Result<Vec<u8>, String> {
        let mut ftp = ftp_connect_sync(&cfg, &secret)?;
        let mut reader = ftp
            .retr_as_stream(&path)
            .map_err(|e| format!("FTP 下载失败: {e}"))?;
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).map_err(|e| format!("读取 FTP 数据失败: {e}"))?;
        let _ = ftp.quit();
        Ok(buf)
    })
    .join()
    .map_err(|_| "FTP 任务线程异常".to_string())?
}

/// FTP 写入文件（同步 + spawn_blocking）。
fn write_ftp_file(cfg: &FileConnConfig, secret: &str, path: &str, data: &[u8]) -> Result<(), String> {
    use std::io::Cursor;
    let cfg = cfg.clone();
    let secret = secret.to_string();
    let path = path.to_string();
    let data = data.to_vec();
    std::thread::spawn(move || -> Result<(), String> {
        let mut ftp = ftp_connect_sync(&cfg, &secret)?;
        let parent = path
            .rfind('/')
            .map(|i| &path[..i])
            .filter(|p| !p.is_empty() && *p != "/")
            .map(|p| p.to_string());
        if let Some(dir) = &parent {
            let _ = ftp.cwd(dir);
        }
        let fname = path.rsplit('/').next().unwrap_or(&path).to_string();
        ftp.put_file(&fname, &mut Cursor::new(data))
            .map_err(|e| format!("FTP 上传失败: {e}"))?;
        let _ = ftp.quit();
        Ok(())
    })
    .join()
    .map_err(|_| "FTP 任务线程异常".to_string())?
}

/// FTP 创建目录（同步 + spawn_blocking）。
fn mkdir_ftp(cfg: &FileConnConfig, secret: &str, path: &str) -> Result<(), String> {
    let cfg = cfg.clone();
    let secret = secret.to_string();
    let path = path.to_string();
    std::thread::spawn(move || -> Result<(), String> {
        let mut ftp = ftp_connect_sync(&cfg, &secret)?;
        ftp.mkdir(&path).map_err(|e| format!("FTP 创建目录失败: {e}"))?;
        let _ = ftp.quit();
        Ok(())
    })
    .join()
    .map_err(|_| "FTP 任务线程异常".to_string())?
}

/// FTP 重命名（同步 + spawn_blocking）。
fn rename_ftp(cfg: &FileConnConfig, secret: &str, old_path: &str, new_path: &str) -> Result<(), String> {
    let cfg = cfg.clone();
    let secret = secret.to_string();
    let old_path = old_path.to_string();
    let new_path = new_path.to_string();
    std::thread::spawn(move || -> Result<(), String> {
        let mut ftp = ftp_connect_sync(&cfg, &secret)?;
        ftp.rename(&old_path, &new_path)
            .map_err(|e| format!("FTP 重命名失败: {e}"))?;
        let _ = ftp.quit();
        Ok(())
    })
    .join()
    .map_err(|_| "FTP 任务线程异常".to_string())?
}

/// FTP 删除（同步 + spawn_blocking；目录需以 / 结尾，由调用方处理）。
fn delete_ftp(cfg: &FileConnConfig, secret: &str, path: &str) -> Result<(), String> {
    let cfg = cfg.clone();
    let secret = secret.to_string();
    let path = path.to_string();
    std::thread::spawn(move || -> Result<(), String> {
        let mut ftp = ftp_connect_sync(&cfg, &secret)?;
        if path.ends_with('/') {
            ftp.rmdir(&path).map_err(|e| format!("FTP 删除目录失败: {e}"))?;
        } else {
            ftp.rm(&path).map_err(|e| format!("FTP 删除文件失败: {e}"))?;
        }
        let _ = ftp.quit();
        Ok(())
    })
    .join()
    .map_err(|_| "FTP 任务线程异常".to_string())?
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
#[derive(Debug, Default, Clone, Deserialize)]
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
    /// aws | aliyun | tencent | qiniu；缺省 aws（兼容旧连接）
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default, rename = "accessKey")]
    pub access_key: String,
    #[serde(default)]
    pub prefix: String,
}

pub(crate) fn parse_file_config(conn: &Connection) -> Result<FileConnConfig, OmniError> {
    serde_json::from_str(&conn.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "文件连接配置解析失败").with_cause(e.to_string())
    })
}

pub(crate) fn protocol_of(cfg: &FileConnConfig) -> &str {
    let p = cfg.protocol.to_lowercase();
    if p.is_empty() {
        "sftp"
    } else {
        &cfg.protocol
    }
}

/// 构造 S3 客户端（凭据走 Vault 注入）。
fn s3_client_for(cfg: &FileConnConfig, secret: &str) -> Result<S3Client, String> {
    let s3_cfg = S3Config {
        bucket: cfg.bucket.clone(),
        provider: cfg.provider.clone(),
        region: cfg.region.clone(),
        endpoint: cfg.endpoint.clone(),
        access_key: cfg.access_key.clone(),
        prefix: cfg.prefix.clone(),
    };
    S3Client::new(s3_cfg, secret.to_string()).map_err(|e| e.user_message())
}

/// S3 object key：去掉开头 `/`。
fn s3_object_key(path: &str) -> String {
    path.trim_start_matches('/').to_string()
}

/// 目录前缀：S3 目录以 `/` 结尾（对齐桌面端 normalize_s3_prefix）。
fn s3_prefix_of(path: &str, cfg: &FileConnConfig) -> String {
    let base = cfg.prefix.trim_matches('/');
    let mut p = path.trim_matches('/').to_string();
    if !base.is_empty() {
        if let Some(rest) = p.strip_prefix(&base) {
            p = rest.trim_matches('/').to_string();
        }
    }
    if path.is_empty() || path == "/" || p.is_empty() {
        if base.is_empty() {
            return String::new();
        }
        return format!("{base}/");
    }
    if base.is_empty() {
        format!("{p}/")
    } else {
        format!("{base}/{p}/")
    }
}

/// S3 目录项 → 统一 FileEntry。
fn s3_entry_to_file(name: &str, key: &str, is_dir: bool, size: u64) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        path: key.to_string(),
        kind: if is_dir { "dir".into() } else { "file".into() },
        size: size as f64,
        modified: 0,
        permissions: None,
    }
}

/// 列出 S3 目录（Delimiter=/，含 CommonPrefixes 子目录与对象）。
async fn list_s3_dir(
    cfg: &FileConnConfig,
    secret: &str,
    path: &str,
    search: Option<&str>,
    start_token: Option<String>,
) -> Result<FileListDirResult, String> {
    let client = s3_client_for(cfg, secret)?;
    let prefix = s3_prefix_of(path, cfg);
    let search_q = search
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let page = client
        .list_objects_v2(prefix, Some("/".to_string()), start_token, Some(200))
        .await
        .map_err(|e| e.user_message())?;

    let mut entries = Vec::new();
    for cp in &page.common_prefixes {
        let key = cp.trim_end_matches('/');
        let name = key.rsplit('/').next().unwrap_or(key).to_string();
        if search_q.as_ref().map_or(true, |q| name.to_lowercase().contains(q)) {
            entries.push(s3_entry_to_file(&name, cp, true, 0));
        }
    }
    for obj in &page.contents {
        if obj.key.ends_with('/') {
            continue;
        }
        let name = obj
            .key
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or(&obj.key)
            .to_string();
        if search_q.as_ref().map_or(true, |q| name.to_lowercase().contains(q)) {
            entries.push(s3_entry_to_file(&name, &obj.key, false, obj.size));
        }
    }
    sort_file_entries(&mut entries);
    Ok(FileListDirResult {
        entries,
        truncated: page.is_truncated,
        next_continuation_token: page.next_continuation_token,
    })
}

/// 删除 S3 前缀下全部对象（含子目录中的文件），并尝试删除目录占位对象。
async fn delete_s3_prefix_recursive(
    cfg: &FileConnConfig,
    secret: &str,
    prefix: &str,
) -> Result<(), String> {
    let client = s3_client_for(cfg, secret)?;
    let prefix = if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    };
    let mut token: Option<String> = None;
    loop {
        let page = client
            .list_objects_v2(prefix.clone(), None, token, Some(1000))
            .await
            .map_err(|e| e.user_message())?;
        for obj in &page.contents {
            client.delete_object(&obj.key).await.map_err(|e| e.user_message())?;
        }
        if !page.is_truncated {
            break;
        }
        token = page.next_continuation_token.clone();
        if token.is_none() {
            break;
        }
    }
    let _ = client.delete_object(&prefix).await;
    Ok(())
}

/// 判定 S3 路径按目录删除。
fn is_s3_prefix_delete_path(path: &str, entry_kind: Option<&str>) -> bool {
    if entry_kind == Some("dir") {
        return true;
    }
    s3_object_key(path).ends_with('/')
}

/// 连接 id → 连接模型（本机返回 None）。
pub(crate) async fn load_file_connection(
    state: &ServerState,
    connection_id: &str,
) -> Result<Option<Connection>, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(None);
    }
    let storage = state.storage.lock().await;
    Ok(storage.get_connection(connection_id)?)
}

pub(crate) fn resolve_secret(conn: &Connection) -> Option<String> {
    conn.credential_ref
        .as_deref()
        .and_then(|r| Vault::get(r).ok())
}

/// 解析 SFTP 文件连接的实际 SSH 端点（含关联 SSH 连接上的 host/port/user）。
pub(crate) async fn ssh_config_from_file_conn(
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
            key_id: None,
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
pub(crate) async fn sftp_session_for(
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

pub(crate) fn list_local_dir(path: &str) -> Result<Vec<FileEntry>, OmniError> {
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
    continuation_token: Option<String>,
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
        "ftp" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let entries = list_ftp_dir(&cfg, &secret, &path, search.as_deref())
                .map_err(|e| e.to_string())?;
            Ok(FileListDirResult {
                entries,
                truncated: false,
                next_continuation_token: None,
            })
        }
        "s3" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let token = continuation_token
                .as_deref()
                .filter(|t| !t.is_empty())
                .map(str::to_string);
            list_s3_dir(&cfg, &secret, &path, search.as_deref(), token).await
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}（当前支持 local / sftp / ftp / s3）")),
    }
}

/// 在 S3 连接存储桶内搜索：含 `/` 时按 key 前缀，否则按文件名子串匹配。
pub async fn file_s3_search(
    state: &ServerState,
    connection_id: String,
    query: String,
    continuation_token: Option<String>,
) -> Result<FileListDirResult, String> {
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    if protocol_of(&cfg) != "s3" {
        return Err("仅 S3 连接支持此搜索".to_string());
    }
    let secret = resolve_secret(&conn).unwrap_or_default();
    let client = s3_client_for(&cfg, &secret)?;
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(FileListDirResult {
            entries: Vec::new(),
            truncated: false,
            next_continuation_token: None,
        });
    }

    let token = continuation_token
        .as_deref()
        .filter(|t| !t.is_empty())
        .map(str::to_string);

    // 含 `/` 且以 `/` 结尾 → 按 key 前缀列目录一层
    let prefix_mode = trimmed.contains('/') && trimmed.ends_with('/');
    if prefix_mode {
        let prefix = {
            let base = cfg.prefix.trim();
            let q = trimmed.strip_prefix('/').unwrap_or(trimmed);
            if base.is_empty() {
                q.to_string()
            } else {
                let base = base.trim_end_matches('/');
                format!("{base}/{q}")
            }
        };
        let page = client
            .list_objects_v2(prefix, Some("/".to_string()), token, Some(200))
            .await
            .map_err(|e| e.user_message())?;
        let mut entries = Vec::new();
        for cp in &page.common_prefixes {
            let key = cp.trim_end_matches('/');
            let name = key.rsplit('/').next().unwrap_or(key).to_string();
            entries.push(s3_entry_to_file(&name, cp, true, 0));
        }
        for obj in &page.contents {
            if obj.key.ends_with('/') {
                continue;
            }
            let name = obj
                .key
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&obj.key)
                .to_string();
            entries.push(s3_entry_to_file(&name, &obj.key, false, obj.size));
        }
        sort_file_entries(&mut entries);
        return Ok(FileListDirResult {
            entries,
            truncated: page.is_truncated,
            next_continuation_token: page.next_continuation_token,
        });
    }

    // 文件名子串匹配：翻页扫描（最多 200 条结果）
    let search_q = trimmed.to_lowercase();
    let mut entries = Vec::new();
    let mut page_token = token;
    loop {
        let page = client
            .list_objects_v2(String::new(), None, page_token, Some(1000))
            .await
            .map_err(|e| e.user_message())?;
        for obj in &page.contents {
            if obj.key.ends_with('/') {
                continue;
            }
            let name = obj
                .key
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or(&obj.key)
                .to_string();
            if name.to_lowercase().contains(&search_q) {
                entries.push(s3_entry_to_file(&name, &obj.key, false, obj.size));
                if entries.len() >= 200 {
                    return Ok(FileListDirResult {
                        entries,
                        truncated: true,
                        next_continuation_token: page.next_continuation_token.clone(),
                    });
                }
            }
        }
        if !page.is_truncated {
            break;
        }
        page_token = page.next_continuation_token.clone();
        if page_token.is_none() {
            break;
        }
    }
    Ok(FileListDirResult {
        entries,
        truncated: false,
        next_continuation_token: None,
    })
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
        "ftp" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let data = read_ftp_file(&cfg, &secret, &path).map_err(|e| e.to_string())?;
            if data.len() as u64 > max_bytes {
                return Err("文件过大".to_string());
            }
            Ok(data)
        }
        "s3" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let client = s3_client_for(&cfg, &secret)?;
            let key = s3_object_key(&path);
            let data = client.get_object(&key).await.map_err(|e| e.user_message())?;
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
        "ftp" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            write_ftp_file(&cfg, &secret, &path, &data).map_err(|e| e.to_string())
        }
        "s3" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let client = s3_client_for(&cfg, &secret)?;
            let key = s3_object_key(&path);
            // 大文件走分块上传（不整载进内存）；小文件单 PUT
            const S3_MULTIPART_THRESHOLD: usize = 8 * 1024 * 1024;
            if data.len() >= S3_MULTIPART_THRESHOLD {
                client
                    .upload_object_multipart(&key, &data, 8 * 1024 * 1024)
                    .await
                    .map_err(|e| e.user_message())?;
            } else {
                client.put_object(&key, &data).await.map_err(|e| e.user_message())?;
            }
            Ok(())
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

/// 分块上传：把本地文件分块（每块 `chunk_size`）上传到 S3，避免整文件进内存。
///
/// 走 `S3Client::upload_object_multipart`（自动 initiate → upload_part → complete，
/// 失败 abort）。返回上传总字节数。
pub async fn file_upload_local_path_multipart(
    state: &ServerState,
    connection_id: String,
    dest_path: String,
    local_path: String,
    chunk_size: Option<usize>,
) -> Result<u64, String> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Err("本机连接无需分块上传".to_string());
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    if protocol_of(&cfg) != "s3" {
        return Err(format!("仅 S3 连接支持分块上传，当前协议: {}", protocol_of(&cfg)));
    }
    let secret = resolve_secret(&conn).unwrap_or_default();
    let client = s3_client_for(&cfg, &secret)?;
    let key = s3_object_key(&dest_path);
    let chunk_size = chunk_size.unwrap_or(8 * 1024 * 1024).clamp(5 * 1024 * 1024, 64 * 1024 * 1024);

    // 分块读本地文件（不整载进内存）
    let mut file = std::fs::File::open(&local_path)
        .map_err(|e| format!("打开本地文件失败: {e}"))?;
    use std::io::Read;
    let mut buf = vec![0u8; chunk_size];
    let mut parts: Vec<(u32, String)> = Vec::new();
    let mut part_number: u32 = 1;
    let upload_id = client
        .initiate_multipart_upload(&key)
        .await
        .map_err(|e| e.user_message())?;
    let result = (async || -> Result<u64, String> {
        let mut total: u64 = 0;
        loop {
            let n = file.read(&mut buf).map_err(|e| format!("读取本地文件失败: {e}"))?;
            if n == 0 {
                break;
            }
            let etag = client
                .upload_part(&key, part_number, &upload_id, &buf[..n])
                .await
                .map_err(|e| e.user_message())?;
            parts.push((part_number, etag));
            total += n as u64;
            part_number += 1;
        }
        client
            .complete_multipart_upload(&key, &upload_id, &parts)
            .await
            .map_err(|e| e.user_message())?;
        Ok(total)
    })()
    .await;
    if result.is_err() {
        let _ = client.abort_multipart_upload(&key, &upload_id).await;
    }
    result
}

/// 分块下载：把 S3 对象按 Range 分块写入本地文件（不整载进内存）。返回总字节数。
pub async fn file_download_s3_range_to_file(
    state: &ServerState,
    connection_id: String,
    remote_path: String,
    local_path: String,
    chunk_size: Option<u64>,
) -> Result<u64, String> {
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    if protocol_of(&cfg) != "s3" {
        return Err(format!("仅 S3 连接支持 Range 下载，当前协议: {}", protocol_of(&cfg)));
    }
    let secret = resolve_secret(&conn).unwrap_or_default();
    let client = s3_client_for(&cfg, &secret)?;
    let key = s3_object_key(&remote_path);
    let chunk_size = chunk_size.unwrap_or(8 * 1024 * 1024).max(1024 * 1024);

    // HEAD 拿对象总长（失败时按 0 处理，之后逐块读到空）
    let total = {
        let status = client.head_object(&key).await.map_err(|e| e.user_message())?;
        if status == 200 {
            // rust-s3 HEAD 不返回 Content-Length（仅状态码），用 0 表示未知，逐块读
            0
        } else {
            0
        }
    };
    let _ = total;

    if let Some(parent) = Path::new(&local_path).parent() {
        std::fs::create_dir_all(parent).ok();
    }
    use std::io::Write;
    let mut file = std::fs::File::create(&local_path)
        .map_err(|e| format!("创建本地文件失败: {e}"))?;
    let mut offset: u64 = 0;
    let mut written: u64 = 0;
    loop {
        let data = client
            .get_object_range(&key, offset, offset.checked_add(chunk_size))
            .await
            .map_err(|e| e.user_message())?;
        if data.is_empty() {
            break;
        }
        file.write_all(&data).map_err(|e| format!("写入本地文件失败: {e}"))?;
        written += data.len() as u64;
        offset += data.len() as u64;
        if (data.len() as u64) < chunk_size {
            break;
        }
    }
    file.flush().ok();
    Ok(written)
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
        "ftp" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            mkdir_ftp(&cfg, &secret, &path).map_err(|e| e.to_string())
        }
        "s3" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let client = s3_client_for(&cfg, &secret)?;
            let mut key = s3_object_key(&path);
            if !key.ends_with('/') {
                key.push('/');
            }
            client.put_object(&key, &[]).await.map_err(|e| e.user_message())
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
        "ftp" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            rename_ftp(&cfg, &secret, &old_path, &new_path).map_err(|e| e.to_string())
        }
        "s3" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let client = s3_client_for(&cfg, &secret)?;
            let old_key = s3_object_key(&old_path);
            let new_key = s3_object_key(&new_path);
            let bytes = client.get_object(&old_key).await.map_err(|e| e.user_message())?;
            client.put_object(&new_key, &bytes).await.map_err(|e| e.user_message())?;
            client.delete_object(&old_key).await.map_err(|e| e.user_message())?;
            Ok(())
        }
        proto => Err(format!("Web 端暂不支持文件协议: {proto}")),
    }
}

/// S3 服务端复制（同一连接内 `from_path` → `to_path`，完全不经本机）。
///
/// - 小对象（≤8MB 或单次 CopyObject 成功）走 `copy_object_internal`；
/// - 大对象走 `copy_object_multipart`（UploadPartCopy 分片直传，规避 5GB 单次拷贝上限）。
/// 返回复制后的对象大小（字节）。
pub async fn file_s3_copy_object(
    state: &ServerState,
    connection_id: String,
    from_path: String,
    to_path: String,
) -> Result<u64, String> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Err("本地连接不支持 S3 服务端复制".to_string());
    }
    let conn = load_file_connection(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("连接不存在: {connection_id}"))?;
    let cfg = parse_file_config(&conn).map_err(|e| e.to_string())?;
    if protocol_of(&cfg) != "s3" {
        return Err("file_s3_copy_object 仅支持 S3 连接".to_string());
    }
    let secret = resolve_secret(&conn).unwrap_or_default();
    let client = s3_client_for(&cfg, &secret)?;
    let from_key = s3_object_key(&from_path);
    let to_key = s3_object_key(&to_path);

    // 先尝试单次服务端拷贝（5GB 内，rust-s3 路径）；失败或为 SigV4 路径时按大小分片复制。
    // SigV4 路径（阿里云/七牛）单次 CopyObject 本身不支持，直接走 multipart。
    let object_size = {
        // HEAD 获取源对象大小；拿不到时按 multipart 兜底（5MB 片）。
        let size = client
            .head_object_size(&from_key)
            .await
            .ok();
        match size {
            Some(sz) => sz,
            None => {
                // 无法 HEAD：尝试单次拷贝；失败再报错
                client
                    .copy_object_internal(&from_key, &to_key)
                    .await
                    .map_err(|e| e.user_message())?;
                return Ok(0);
            }
        }
    };

    // 小对象（≤5GB）且非 SigV4-only：单次服务端拷贝
    if object_size <= 5 * 1024 * 1024 * 1024 {
        if client
            .copy_object_internal(&from_key, &to_key)
            .await
            .is_ok()
        {
            return Ok(object_size);
        }
        // 回落到分片复制（SigV4 路径会在这里失败单次拷贝，落到此处）
    }

    // 大对象 / SigV4 路径：分片服务端复制
    let copied = client
        .copy_object_multipart(&from_key, &to_key, object_size, 8 * 1024 * 1024)
        .await
        .map_err(|e| e.user_message())?;
    Ok(copied)
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
        "ftp" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let p = if entry_kind.as_deref() == Some("dir") && !path.ends_with('/') {
                format!("{path}/")
            } else {
                path.clone()
            };
            delete_ftp(&cfg, &secret, &p).map_err(|e| e.to_string())
        }
        "s3" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let client = s3_client_for(&cfg, &secret)?;
            let key = s3_object_key(&path);
            if key.is_empty() {
                return Err("不能删除存储桶根目录".to_string());
            }
            if is_s3_prefix_delete_path(&path, entry_kind.as_deref()) {
                let prefix = if key.ends_with('/') {
                    key
                } else {
                    format!("{key}/")
                };
                delete_s3_prefix_recursive(&cfg, &secret, &prefix).await?;
            } else {
                client.delete_object(&key).await.map_err(|e| e.user_message())?;
            }
            Ok(())
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
        "ftp" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            write_ftp_file(&cfg, &secret, &dest_path, &data).map_err(|e| e.to_string())?;
            Ok(dest_connection_id)
        }
        "s3" => {
            let secret = resolve_secret(&conn).unwrap_or_default();
            let client = s3_client_for(&cfg, &secret)?;
            let key = s3_object_key(&dest_path);
            client.put_object(&key, &data).await.map_err(|e| e.user_message())?;
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
