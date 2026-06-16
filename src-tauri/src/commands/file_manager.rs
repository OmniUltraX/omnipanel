//! 统一文件管理器：本地 / SFTP / FTP / S3 对象存储。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{SshAuth, SshConfig, SshSession};
use omnipanel_store::{Connection, ConnectionKind, Vault};
use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;
use serde::{Deserialize, Serialize};
use specta::Type;
use suppaftp::FtpStream;
use tauri::State;

use crate::state::AppState;

/// 内置本地文件连接 id。
pub const LOCAL_CONNECTION_ID: &str = "__local__";

/// 文件条目（统一模型）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    /// `file` | `dir`
    pub kind: String,
    #[specta(type = f64)]
    pub size: u64,
    #[specta(type = f64)]
    pub modified: i64,
    pub permissions: Option<String>,
}

/// 文件管理器连接摘要。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileManagerConnectionInfo {
    pub id: String,
    pub name: String,
    /// local | ftp | sftp | s3
    pub protocol: String,
    pub status: String,
    pub group: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConnConfig {
    #[serde(default)]
    protocol: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: String,
    #[serde(default, rename = "rootPath")]
    root_path: String,
    /// FTPS TLS 开关（当前预留字段，后续接入显式 FTPS）。
    #[allow(dead_code)]
    #[serde(default)]
    tls: bool,
    #[serde(default, rename = "sshConnectionId")]
    ssh_connection_id: Option<String>,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    endpoint: String,
    #[serde(default)]
    prefix: String,
    #[serde(default, rename = "accessKey")]
    access_key: String,
}

fn parse_file_config(conn: &Connection) -> Result<FileConnConfig, OmniError> {
    serde_json::from_str(&conn.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "文件连接配置解析失败").with_cause(e.to_string())
    })
}

fn resolve_secret(conn: &Connection) -> Option<String> {
    conn.credential_ref
        .as_deref()
        .and_then(|r| Vault::get(r).ok())
}

fn unix_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn local_home() -> Result<PathBuf, OmniError> {
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

fn join_posix(base: &str, name: &str) -> String {
    if base == "/" || base.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

async fn load_file_connection(
    state: &AppState,
    connection_id: &str,
) -> Result<Option<Connection>, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(None);
    }
    let storage = state.storage.lock().await;
    storage.get_connection(connection_id)
}

// ─── Local backend ───────────────────────────────────────────────────────────

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
            size,
            modified,
            permissions,
        });
    }
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn local_mkdir(path: &str) -> Result<(), OmniError> {
    std::fs::create_dir_all(path)
        .map_err(|e| OmniError::new(ErrorCode::Io, "创建目录失败").with_cause(e.to_string()))
}

fn local_rename(old: &str, new: &str) -> Result<(), OmniError> {
    std::fs::rename(old, new)
        .map_err(|e| OmniError::new(ErrorCode::Io, "重命名失败").with_cause(e.to_string()))
}

fn local_delete(path: &str) -> Result<(), OmniError> {
    let p = Path::new(path);
    if p.is_dir() {
        std::fs::remove_dir_all(p)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除目录失败").with_cause(e.to_string()))
    } else {
        std::fs::remove_file(p)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除文件失败").with_cause(e.to_string()))
    }
}

fn local_read(path: &str, max_bytes: u64) -> Result<Vec<u8>, OmniError> {
    let data = std::fs::read(path)
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

// ─── SFTP backend ────────────────────────────────────────────────────────────

async fn ssh_config_from_file_conn(
    state: &AppState,
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
        return serde_json::from_str(&ssh_conn.config).map_err(|e| {
            OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(e.to_string())
        });
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
    })
}

async fn sftp_session_for(
    state: &AppState,
    connection_id: &str,
    conn: &Connection,
    cfg: &FileConnConfig,
) -> Result<Arc<SshSession>, OmniError> {
    if let Some(ssh_id) = cfg.ssh_connection_id.as_deref().filter(|s| !s.is_empty()) {
        return state.ssh_pool.ensure_session(ssh_id).await;
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
        kind: if entry.is_dir {
            "dir".into()
        } else {
            "file".into()
        },
        size: entry.size,
        modified: 0,
        permissions: None,
    }
}

async fn list_sftp_dir(
    state: &AppState,
    connection_id: &str,
    conn: &Connection,
    cfg: &FileConnConfig,
    path: &str,
) -> Result<Vec<FileEntry>, OmniError> {
    let session = sftp_session_for(state, connection_id, conn, cfg).await?;
    let remote = if path.is_empty() {
        if cfg.root_path.is_empty() {
            "/".to_string()
        } else {
            cfg.root_path.clone()
        }
    } else {
        path.to_string()
    };
    let list = session.sftp_list(&remote).await?;
    Ok(list
        .iter()
        .map(|e| sftp_entry_to_file(e, &remote))
        .collect())
}

// ─── FTP backend（同步客户端 + spawn_blocking）────────────────────────────────

fn ftp_connect_sync(cfg: &FileConnConfig, secret: &str) -> Result<FtpStream, OmniError> {
    let port = cfg.port.unwrap_or(21);
    let addr = format!("{}:{}", cfg.host, port);
    let mut ftp = FtpStream::connect(&addr).map_err(|e| {
        OmniError::new(ErrorCode::Connection, "FTP 连接失败").with_cause(e.to_string())
    })?;
    if !cfg.user.is_empty() {
        ftp.login(&cfg.user, &secret.to_string()).map_err(|e| {
            OmniError::new(ErrorCode::Auth, "FTP 登录失败").with_cause(e.to_string())
        })?;
    }
    Ok(ftp)
}

fn ftp_remote_path(path: &str, cfg: &FileConnConfig) -> String {
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

async fn list_ftp_dir(
    cfg: &FileConnConfig,
    secret: &str,
    path: &str,
) -> Result<Vec<FileEntry>, OmniError> {
    let cfg = cfg.clone();
    let secret = secret.to_string();
    let path = path.to_string();
    tokio::task::spawn_blocking(move || {
        let mut ftp = ftp_connect_sync(&cfg, &secret)?;
        let remote = ftp_remote_path(&path, &cfg);
        ftp.cwd(&remote).map_err(|e| {
            OmniError::new(ErrorCode::Io, "切换 FTP 目录失败").with_cause(e.to_string())
        })?;
        let list = ftp.list(None).map_err(|e| {
            OmniError::new(ErrorCode::Io, "列出 FTP 目录失败").with_cause(e.to_string())
        })?;
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
            entries.push(FileEntry {
                name: name.clone(),
                path: join_posix(&remote, &name),
                kind: if is_dir { "dir".into() } else { "file".into() },
                size: 0,
                modified: 0,
                permissions: parts.first().map(|s| s.to_string()),
            });
        }
        Ok(entries)
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string()))?
}

async fn ftp_test(cfg: &FileConnConfig, secret: &str) -> Result<(), OmniError> {
    let cfg = cfg.clone();
    let secret = secret.to_string();
    tokio::task::spawn_blocking(move || {
        let ftp = ftp_connect_sync(&cfg, &secret)?;
        drop(ftp);
        Ok(())
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string()))?
}

// ─── S3 backend ──────────────────────────────────────────────────────────────

fn s3_bucket(cfg: &FileConnConfig, secret: &str) -> Result<Box<Bucket>, OmniError> {
    let region = if cfg.endpoint.is_empty() {
        Region::Custom {
            region: cfg.region.clone(),
            endpoint: format!("https://s3.{}.amazonaws.com", cfg.region),
        }
    } else {
        Region::Custom {
            region: cfg.region.clone(),
            endpoint: cfg.endpoint.clone(),
        }
    };
    let creds = Credentials::new(Some(&cfg.access_key), Some(secret), None, None, None)
        .map_err(|e| OmniError::new(ErrorCode::Auth, "S3 凭据无效").with_cause(e.to_string()))?;
    Bucket::new(&cfg.bucket, region, creds).map_err(|e| {
        OmniError::new(ErrorCode::Connection, "创建 S3 客户端失败").with_cause(e.to_string())
    })
}

fn normalize_s3_prefix(path: &str, cfg: &FileConnConfig) -> String {
    let base = cfg.prefix.trim_matches('/');
    let p = path.trim_matches('/');
    if path.is_empty() || path == "/" {
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

async fn list_s3_dir(
    cfg: &FileConnConfig,
    secret: &str,
    path: &str,
) -> Result<Vec<FileEntry>, OmniError> {
    let bucket = s3_bucket(cfg, secret)?;
    let prefix = normalize_s3_prefix(path, cfg);
    let pages = bucket
        .list(prefix, Some("/".to_string()))
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, "列出 S3 对象失败").with_cause(e.to_string()))?;
    let mut entries = Vec::new();
    for page in pages {
        if let Some(prefixes) = page.common_prefixes {
            for cp in prefixes {
                let key = cp.prefix.trim_end_matches('/');
                let name = key.rsplit('/').next().unwrap_or(&key).to_string();
                entries.push(FileEntry {
                    name: name.clone(),
                    path: cp.prefix,
                    kind: "dir".into(),
                    size: 0,
                    modified: 0,
                    permissions: None,
                });
            }
        }
        for obj in page.contents {
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
            entries.push(FileEntry {
                name: name.clone(),
                path: obj.key,
                kind: "file".into(),
                size: obj.size,
                modified: 0,
                permissions: None,
            });
        }
    }
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd).then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

enum FileProtocol {
    Local,
    Sftp,
    Ftp,
    S3,
}

fn protocol_of(cfg: &FileConnConfig) -> FileProtocol {
    match cfg.protocol.as_str() {
        "ftp" => FileProtocol::Ftp,
        "s3" => FileProtocol::S3,
        "sftp" => FileProtocol::Sftp,
        _ => FileProtocol::Local,
    }
}

/// 列出文件管理器可用连接（含内置本机）。
#[tauri::command]
#[specta::specta]
pub async fn file_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<FileManagerConnectionInfo>, OmniError> {
    let mut out = vec![FileManagerConnectionInfo {
        id: LOCAL_CONNECTION_ID.to_string(),
        name: "本机文件系统".to_string(),
        protocol: "local".to_string(),
        status: "online".to_string(),
        group: "本地文件".to_string(),
    }];
    let storage = state.storage.lock().await;
    for conn in storage.list_connections_by_kind(ConnectionKind::File)? {
        let cfg = parse_file_config(&conn)?;
        out.push(FileManagerConnectionInfo {
            id: conn.id,
            name: conn.name,
            protocol: cfg.protocol,
            status: "offline".to_string(),
            group: conn.group,
        });
    }
    Ok(out)
}

/// 保存文件连接（凭据写入 Vault）。
#[tauri::command]
#[specta::specta]
pub async fn file_save_connection(
    state: State<'_, AppState>,
    mut connection: Connection,
    secret: Option<String>,
) -> Result<Connection, OmniError> {
    connection.kind = ConnectionKind::File;
    if let Some(sec) = secret.filter(|s| !s.is_empty()) {
        let cred_ref = connection
            .credential_ref
            .clone()
            .filter(|r| !r.is_empty())
            .unwrap_or_else(|| format!("file-cred-{}", connection.id));
        Vault::store(&cred_ref, &sec)?;
        connection.credential_ref = Some(cred_ref);
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    if connection.id.is_empty() {
        connection.id = format!("file-{:x}", now);
        connection.created_at = now;
    }
    connection.updated_at = now;
    let storage = state.storage.lock().await;
    storage.save_connection(&connection)?;
    Ok(connection)
}

/// 测试未保存或已保存的文件连接配置。
pub async fn file_test_connection_config(
    state: &AppState,
    connection: &Connection,
) -> Result<String, OmniError> {
    let cfg = parse_file_config(connection)?;
    let secret = resolve_secret(connection).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Local => {
            let home = local_home()?;
            Ok(format!("本机可用：{}", home.display()))
        }
        FileProtocol::Sftp => {
            let _ = sftp_session_for(state, &connection.id, connection, &cfg).await?;
            Ok("SFTP 连接成功".into())
        }
        FileProtocol::Ftp => {
            ftp_test(&cfg, &secret).await?;
            Ok("FTP 连接成功".into())
        }
        FileProtocol::S3 => {
            let bucket = s3_bucket(&cfg, &secret)?;
            bucket.list(String::new(), None).await.map_err(|e| {
                OmniError::new(ErrorCode::Connection, "S3 连接测试失败").with_cause(e.to_string())
            })?;
            Ok("S3 连接成功".into())
        }
    }
}

/// 测试文件连接。
#[tauri::command]
#[specta::specta]
pub async fn file_test_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<String, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        let home = local_home()?;
        return Ok(format!("本机可用：{}", home.display()));
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    file_test_connection_config(&state, &conn).await
}

/// 列出目录内容。
#[tauri::command]
#[specta::specta]
pub async fn file_list_dir(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<Vec<FileEntry>, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return list_local_dir(&path);
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Local => list_local_dir(&path),
        FileProtocol::Sftp => list_sftp_dir(&state, &connection_id, &conn, &cfg, &path).await,
        FileProtocol::Ftp => list_ftp_dir(&cfg, &secret, &path).await,
        FileProtocol::S3 => list_s3_dir(&cfg, &secret, &path).await,
    }
}

/// 读取文件内容（字节）。
#[tauri::command]
#[specta::specta]
pub async fn file_read_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    max_bytes: f64,
) -> Result<Vec<u8>, OmniError> {
    let max_bytes = max_bytes.max(0.0) as u64;
    if connection_id == LOCAL_CONNECTION_ID {
        return local_read(&path, max_bytes);
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Local => local_read(&path, max_bytes),
        FileProtocol::Sftp => {
            let session = sftp_session_for(&state, &connection_id, &conn, &cfg).await?;
            let data = session.sftp_download(&path).await?;
            if data.len() as u64 > max_bytes {
                return Err(OmniError::new(ErrorCode::InvalidInput, "文件过大"));
            }
            Ok(data)
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = secret.to_string();
            let path = path.clone();
            let max_bytes = max_bytes;
            tokio::task::spawn_blocking(move || {
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                let mut reader = ftp.retr_as_stream(&path).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "FTP 下载失败").with_cause(e.to_string())
                })?;
                use std::io::Read;
                let mut buf = Vec::new();
                reader.read_to_end(&mut buf).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "读取 FTP 数据失败").with_cause(e.to_string())
                })?;
                let _ = ftp.quit();
                if buf.len() as u64 > max_bytes {
                    return Err(OmniError::new(ErrorCode::InvalidInput, "文件过大"));
                }
                Ok(buf)
            })
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
            })?
        }
        FileProtocol::S3 => {
            let bucket = s3_bucket(&cfg, &secret)?;
            let response = bucket.get_object(&path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 下载失败").with_cause(e.to_string())
            })?;
            let data: Vec<u8> = response.bytes().to_vec();
            if data.len() as u64 > max_bytes {
                return Err(OmniError::new(ErrorCode::InvalidInput, "文件过大"));
            }
            Ok(data)
        }
    }
}

/// 上传文件（覆盖）。
#[tauri::command]
#[specta::specta]
pub async fn file_upload_file(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_write(&path, &data);
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Local => local_write(&path, &data),
        FileProtocol::Sftp => {
            let session = sftp_session_for(&state, &connection_id, &conn, &cfg).await?;
            session.sftp_upload(&path, &data).await
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = secret.to_string();
            let path = path.clone();
            let data = data.clone();
            tokio::task::spawn_blocking(move || {
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                let parent = Path::new(&path)
                    .parent()
                    .and_then(|p| p.to_str())
                    .unwrap_or("/");
                if !parent.is_empty() && parent != "/" {
                    let _ = ftp.cwd(parent);
                }
                let fname = Path::new(&path)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or(&path);
                use std::io::Cursor;
                ftp.put_file(fname, &mut Cursor::new(data)).map_err(|e| {
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
        FileProtocol::S3 => {
            let bucket = s3_bucket(&cfg, &secret)?;
            bucket.put_object(&path, &data).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 上传失败").with_cause(e.to_string())
            })?;
            Ok(())
        }
    }
}

/// 下载文件到本地路径。
#[tauri::command]
#[specta::specta]
pub async fn file_download_file(
    state: State<'_, AppState>,
    connection_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), OmniError> {
    let data = file_read_file(
        state.clone(),
        connection_id,
        remote_path,
        (512 * 1024 * 1024) as f64,
    )
    .await?;
    local_write(&local_path, &data)
}

/// 创建目录。
#[tauri::command]
#[specta::specta]
pub async fn file_mkdir(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<(), OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_mkdir(&path);
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Local => local_mkdir(&path),
        FileProtocol::Sftp => {
            let session = sftp_session_for(&state, &connection_id, &conn, &cfg).await?;
            session.sftp_mkdir(&path).await
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = secret.to_string();
            let path = path.clone();
            tokio::task::spawn_blocking(move || {
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                ftp.mkdir(&path).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "FTP 创建目录失败").with_cause(e.to_string())
                })?;
                let _ = ftp.quit();
                Ok(())
            })
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
            })?
        }
        FileProtocol::S3 => {
            let bucket = s3_bucket(&cfg, &secret)?;
            let key = if path.ends_with('/') {
                path
            } else {
                format!("{path}/")
            };
            bucket.put_object(&key, &[] as &[u8]).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 创建目录失败").with_cause(e.to_string())
            })?;
            Ok(())
        }
    }
}

/// 重命名文件/目录。
#[tauri::command]
#[specta::specta]
pub async fn file_rename(
    state: State<'_, AppState>,
    connection_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_rename(&old_path, &new_path);
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Local => local_rename(&old_path, &new_path),
        FileProtocol::Sftp => {
            let session = sftp_session_for(&state, &connection_id, &conn, &cfg).await?;
            session.sftp_rename(&old_path, &new_path).await
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = secret.to_string();
            let old_path = old_path.clone();
            let new_path = new_path.clone();
            tokio::task::spawn_blocking(move || {
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                ftp.rename(&old_path, &new_path).map_err(|e| {
                    OmniError::new(ErrorCode::Io, "FTP 重命名失败").with_cause(e.to_string())
                })?;
                let _ = ftp.quit();
                Ok(())
            })
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
            })?
        }
        FileProtocol::S3 => {
            let bucket = s3_bucket(&cfg, &secret)?;
            let response = bucket.get_object(&old_path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 读取对象失败").with_cause(e.to_string())
            })?;
            let bytes = response.bytes();
            bucket.put_object(&new_path, bytes).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 写入对象失败").with_cause(e.to_string())
            })?;
            bucket.delete_object(&old_path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 删除旧对象失败").with_cause(e.to_string())
            })?;
            Ok(())
        }
    }
}

/// 删除文件/目录。
#[tauri::command]
#[specta::specta]
pub async fn file_delete(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
) -> Result<(), OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return local_delete(&path);
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    match protocol_of(&cfg) {
        FileProtocol::Local => local_delete(&path),
        FileProtocol::Sftp => {
            let session = sftp_session_for(&state, &connection_id, &conn, &cfg).await?;
            session.sftp_remove(&path).await
        }
        FileProtocol::Ftp => {
            let cfg = cfg.clone();
            let secret = secret.to_string();
            let path = path.clone();
            tokio::task::spawn_blocking(move || {
                let mut ftp = ftp_connect_sync(&cfg, &secret)?;
                if path.ends_with('/') {
                    ftp.rmdir(&path).map_err(|e| {
                        OmniError::new(ErrorCode::Io, "FTP 删除目录失败").with_cause(e.to_string())
                    })?;
                } else {
                    ftp.rm(&path).map_err(|e| {
                        OmniError::new(ErrorCode::Io, "FTP 删除文件失败").with_cause(e.to_string())
                    })?;
                }
                let _ = ftp.quit();
                Ok(())
            })
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "FTP 任务失败").with_cause(e.to_string())
            })?
        }
        FileProtocol::S3 => {
            let bucket = s3_bucket(&cfg, &secret)?;
            bucket.delete_object(&path).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 删除失败").with_cause(e.to_string())
            })?;
            Ok(())
        }
    }
}

/// 本机常用目录快捷路径。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileQuickPaths {
    pub home: String,
    pub desktop: String,
    pub documents: String,
    pub downloads: String,
}

/// 本机常用目录快捷路径。
#[tauri::command]
#[specta::specta]
pub async fn file_local_quick_paths() -> Result<FileQuickPaths, OmniError> {
    let home = local_home()?;
    Ok(FileQuickPaths {
        home: home.to_string_lossy().into_owned(),
        desktop: home.join("Desktop").to_string_lossy().into_owned(),
        documents: home.join("Documents").to_string_lossy().into_owned(),
        downloads: home.join("Downloads").to_string_lossy().into_owned(),
    })
}
