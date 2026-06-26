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

pub(crate) fn mark_file_connection_online(state: &AppState, connection_id: &str) {
    if connection_id == LOCAL_CONNECTION_ID {
        return;
    }
    if let Ok(mut online) = state.file_connection_online.lock() {
        online.insert(connection_id.to_string());
    }
}

async fn file_connection_is_online(state: &AppState, connection_id: &str) -> bool {
    if connection_id == LOCAL_CONNECTION_ID {
        return true;
    }
    if state
        .file_connection_online
        .lock()
        .ok()
        .is_some_and(|online| online.contains(connection_id))
    {
        return true;
    }
    state
        .file_sftp_sessions
        .lock()
        .await
        .contains_key(connection_id)
}

/// 目录列表结果。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileListDirResult {
    pub entries: Vec<FileEntry>,
    /// 是否还有下一页（S3 分页）。
    pub truncated: bool,
    pub next_continuation_token: Option<String>,
}

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
pub(crate) struct FileConnConfig {
    #[serde(default)]
    protocol: String,
    #[serde(default)]
    host: String,
    #[serde(default)]
    port: Option<u16>,
    #[serde(default)]
    user: String,
    #[serde(default, rename = "rootPath")]
    pub(crate) root_path: String,
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
    /// 前端生成公开链接用，后端 S3 API 不读取。
    #[serde(default, rename = "publicDomain")]
    #[allow(dead_code)]
    public_domain: String,
    #[serde(default)]
    prefix: String,
    #[serde(default, rename = "accessKey")]
    access_key: String,
}

pub(crate) fn parse_file_config(conn: &Connection) -> Result<FileConnConfig, OmniError> {
    serde_json::from_str(&conn.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "文件连接配置解析失败").with_cause(e.to_string())
    })
}

pub(crate) fn resolve_secret(conn: &Connection) -> Option<String> {
    conn.credential_ref
        .as_deref()
        .and_then(|r| Vault::get(r).ok())
}

fn unix_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub(crate) fn local_home() -> Result<PathBuf, OmniError> {
    if let Ok(p) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        return Ok(PathBuf::from(p));
    }
    Err(OmniError::new(ErrorCode::Internal, "无法获取用户主目录"))
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

pub(crate) fn join_posix(base: &str, name: &str) -> String {
    if base == "/" || base.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

pub(crate) async fn load_file_connection(
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

pub(crate) fn local_read(path: &str, max_bytes: u64) -> Result<Vec<u8>, OmniError> {
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

pub(crate) async fn sftp_session_for(
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

pub(crate) fn sftp_entry_to_file(entry: &omnipanel_ssh::SftpEntry, base: &str) -> FileEntry {
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

pub(crate) async fn list_sftp_dir(
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

pub(crate) fn ftp_connect_sync(cfg: &FileConnConfig, secret: &str) -> Result<FtpStream, OmniError> {
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

pub(crate) async fn list_ftp_dir(
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

pub(crate) fn s3_bucket(cfg: &FileConnConfig, secret: &str) -> Result<Box<Bucket>, OmniError> {
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

pub(crate) fn normalize_s3_prefix(path: &str, cfg: &FileConnConfig) -> String {
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
    search: Option<&str>,
    start_token: Option<&str>,
) -> Result<(Vec<FileEntry>, bool, Option<String>), OmniError> {
    let bucket = s3_bucket(cfg, secret)?;
    let prefix = normalize_s3_prefix(path, cfg);
    let search_q = search
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    tracing::debug!(
        bucket = %cfg.bucket,
        region = %cfg.region,
        endpoint = %cfg.endpoint,
        prefix = %prefix,
        path = %path,
        search = ?search_q,
        start_token = ?start_token,
        "list_s3_dir"
    );
    const S3_PAGE_SIZE: usize = 200;
    let matches_search = |name: &str| -> bool {
        search_q
            .as_ref()
            .map_or(true, |q| name.to_lowercase().contains(q))
    };
    let (page, _status) = bucket
        .list_page(
            prefix.clone(),
            Some("/".to_string()),
            start_token.map(str::to_string),
            None,
            Some(S3_PAGE_SIZE),
        )
        .await
        .map_err(|e| {
            tracing::error!(
                bucket = %cfg.bucket,
                region = %cfg.region,
                endpoint = %cfg.endpoint,
                prefix = %prefix,
                error = %e,
                "列出 S3 对象失败"
            );
            OmniError::new(ErrorCode::Io, "列出 S3 对象失败").with_cause(e.to_string())
        })?;
    let mut entries = Vec::new();
    if let Some(prefixes) = page.common_prefixes {
        for cp in prefixes {
            let key = cp.prefix.trim_end_matches('/');
            let name = key.rsplit('/').next().unwrap_or(&key).to_string();
            if !matches_search(&name) {
                continue;
            }
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
        if !matches_search(&name) {
            continue;
        }
        entries.push(FileEntry {
            name: name.clone(),
            path: obj.key,
            kind: "file".into(),
            size: obj.size,
            modified: 0,
            permissions: None,
        });
    }
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd).then_with(|| a.name.cmp(&b.name))
    });
    let has_more = page.is_truncated;
    let next_token = if has_more {
        page.next_continuation_token
    } else {
        None
    };
    Ok((entries, has_more, next_token))
}

fn push_s3_list_page_entries(
    page: &s3::serde_types::ListBucketResult,
    entries: &mut Vec<FileEntry>,
    name_filter: Option<&str>,
) {
    if let Some(prefixes) = &page.common_prefixes {
        for cp in prefixes {
            let key = cp.prefix.trim_end_matches('/');
            let name = key.rsplit('/').next().unwrap_or(&key).to_string();
            if name_filter.map_or(true, |q| name.to_lowercase().contains(q)) {
                entries.push(FileEntry {
                    name: name.clone(),
                    path: cp.prefix.clone(),
                    kind: "dir".into(),
                    size: 0,
                    modified: 0,
                    permissions: None,
                });
            }
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
        if name_filter.map_or(true, |q| name.to_lowercase().contains(q)) {
            entries.push(FileEntry {
                name: name.clone(),
                path: obj.key.clone(),
                kind: "file".into(),
                size: obj.size,
                modified: 0,
                permissions: None,
            });
        }
    }
}

fn sort_s3_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd).then_with(|| a.name.cmp(&b.name))
    });
}

/// 搜索词含 `/` 时按 S3 对象 key 前缀查询（如 `foo/`）。
fn is_s3_key_prefix_search(query: &str) -> bool {
    query.trim().contains('/')
}

/// 将用户输入拼成 ListObjectsV2 的 Prefix（保留末尾 `/`）。
pub(crate) fn normalize_s3_search_key_prefix(query: &str, cfg: &FileConnConfig) -> String {
    let base = cfg.prefix.trim();
    let q = query.trim();
    let q = q.strip_prefix('/').unwrap_or(q);
    if q.is_empty() {
        if base.is_empty() {
            return String::new();
        }
        let base = base.trim_end_matches('/');
        return format!("{base}/");
    }
    if base.is_empty() {
        return q.to_string();
    }
    let base = base.trim_end_matches('/');
    format!("{base}/{q}")
}

/// 按 key 前缀列出 S3「目录」一层（Delimiter=/，含子目录 CommonPrefixes）。
async fn list_s3_prefix_page(
    cfg: &FileConnConfig,
    secret: &str,
    prefix: &str,
    start_token: Option<&str>,
) -> Result<(Vec<FileEntry>, bool, Option<String>), OmniError> {
    let bucket = s3_bucket(cfg, secret)?;
    const S3_PAGE_SIZE: usize = 200;
    let (page, _status) = bucket
        .list_page(
            prefix.to_string(),
            Some("/".to_string()),
            start_token.map(str::to_string),
            None,
            Some(S3_PAGE_SIZE),
        )
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 前缀搜索失败").with_cause(e.to_string())
        })?;
    let mut entries = Vec::new();
    push_s3_list_page_entries(&page, &mut entries, None);
    sort_s3_entries(&mut entries);
    let has_more = page.is_truncated;
    let next_token = if has_more {
        page.next_continuation_token
    } else {
        None
    };
    Ok((entries, has_more, next_token))
}

/// 在 S3 存储桶内搜索：含 `/` 时按 key 前缀；否则按文件名子串匹配。
async fn search_s3(
    cfg: &FileConnConfig,
    secret: &str,
    query: &str,
    start_token: Option<&str>,
) -> Result<(Vec<FileEntry>, bool, Option<String>), OmniError> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok((Vec::new(), false, None));
    }

    let key_prefix_mode = is_s3_key_prefix_search(trimmed);
    if key_prefix_mode && trimmed.ends_with('/') {
        let prefix = normalize_s3_search_key_prefix(trimmed, cfg);
        tracing::debug!(
            bucket = %cfg.bucket,
            prefix = %prefix,
            query = %trimmed,
            start_token = ?start_token,
            "search_s3 prefix dir"
        );
        return list_s3_prefix_page(cfg, secret, &prefix, start_token).await;
    }

    let bucket = s3_bucket(cfg, secret)?;
    let prefix = if key_prefix_mode {
        normalize_s3_search_key_prefix(trimmed, cfg)
    } else {
        normalize_s3_prefix("", cfg)
    };
    let search_q = trimmed.to_lowercase();

    const S3_LIST_PAGE_SIZE: usize = 1000;
    const S3_SEARCH_RESULT_LIMIT: usize = 200;

    tracing::debug!(
        bucket = %cfg.bucket,
        prefix = %prefix,
        key_prefix_mode,
        query = %trimmed,
        start_token = ?start_token,
        "search_s3"
    );

    let mut entries = Vec::new();
    let mut token = start_token.map(str::to_string);

    loop {
        let (page, _status) = bucket
            .list_page(prefix.clone(), None, token, None, Some(S3_LIST_PAGE_SIZE))
            .await
            .map_err(|e| {
                tracing::error!(
                    bucket = %cfg.bucket,
                    region = %cfg.region,
                    endpoint = %cfg.endpoint,
                    prefix = %prefix,
                    error = %e,
                    "S3 搜索失败"
                );
                OmniError::new(ErrorCode::Io, "S3 搜索失败").with_cause(e.to_string())
            })?;

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
            if !key_prefix_mode && !name.to_lowercase().contains(&search_q) {
                continue;
            }
            entries.push(FileEntry {
                name: name.clone(),
                path: obj.key,
                kind: "file".into(),
                size: obj.size,
                modified: 0,
                permissions: None,
            });
            if entries.len() >= S3_SEARCH_RESULT_LIMIT {
                return Ok((entries, true, page.next_continuation_token));
            }
        }

        if !page.is_truncated {
            break;
        }
        token = page.next_continuation_token;
        if token.is_none() {
            break;
        }
    }

    Ok((entries, false, None))
}

#[cfg(test)]
mod s3_search_tests {
    use super::*;

    fn cfg(prefix: &str) -> FileConnConfig {
        FileConnConfig {
            protocol: "s3".into(),
            host: String::new(),
            port: None,
            user: String::new(),
            root_path: String::new(),
            tls: false,
            ssh_connection_id: None,
            bucket: "b".into(),
            region: "us-east-1".into(),
            endpoint: String::new(),
            public_domain: String::new(),
            prefix: prefix.into(),
            access_key: String::new(),
        }
    }

    #[test]
    fn key_prefix_search_detects_slash() {
        assert!(is_s3_key_prefix_search("foo/"));
        assert!(is_s3_key_prefix_search("a/b"));
        assert!(!is_s3_key_prefix_search("report"));
    }

    #[test]
    fn normalize_search_key_prefix_preserves_trailing_slash() {
        assert_eq!(
            normalize_s3_search_key_prefix("foo/", &cfg("")),
            "foo/"
        );
        assert_eq!(
            normalize_s3_search_key_prefix("foo/", &cfg("root")),
            "root/foo/"
        );
        assert_eq!(
            normalize_s3_search_key_prefix("foo/bar", &cfg("root")),
            "root/foo/bar"
        );
    }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

#[derive(PartialEq)]
pub(crate) enum FileProtocol {
    Local,
    Sftp,
    Ftp,
    S3,
}

fn protocol_label(protocol: FileProtocol) -> &'static str {
    match protocol {
        FileProtocol::Local => "local",
        FileProtocol::Sftp => "sftp",
        FileProtocol::Ftp => "ftp",
        FileProtocol::S3 => "s3",
    }
}

pub(crate) fn protocol_of(cfg: &FileConnConfig) -> FileProtocol {
    match cfg.protocol.trim().to_ascii_lowercase().as_str() {
        "ftp" => FileProtocol::Ftp,
        "s3" => FileProtocol::S3,
        "sftp" => FileProtocol::Sftp,
        "local" => FileProtocol::Local,
        _ if !cfg.bucket.trim().is_empty() => FileProtocol::S3,
        _ => FileProtocol::Local,
    }
}

fn normalize_s3_object_key(path: &str) -> String {
    path.trim_start_matches('/').to_string()
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
        let online = file_connection_is_online(&state, &conn.id).await;
        out.push(FileManagerConnectionInfo {
            id: conn.id,
            name: conn.name,
            protocol: protocol_label(protocol_of(&cfg)).to_string(),
            status: if online {
                "online".to_string()
            } else {
                "offline".to_string()
            },
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
            // 使用 head_object 对一个几乎不存在的 key 做探测，避免 list 的 XML
            // 反序列化（rust-s3 0.35 的 ListBucketResult 要求 Name 字段，部分 S3 兼容
            // 服务响应里会缺失该字段导致 "missing field `Name`" 报错）。
            // head_object 不解析响应体，仅依据 HTTP 状态码判断连通性与凭据：
            //   2xx / 404 -> 凭据有效，Bucket 可达
            //   403        -> 凭据/权限被拒绝
            //   其它 / Err -> 连接或签名失败
            let probe_key = "__omnipanel_connect_probe__";
            match bucket.head_object(probe_key).await {
                Ok((_, status)) => match status {
                    200 | 204 | 404 => Ok("S3 连接成功".into()),
                    403 => Err(OmniError::new(
                        ErrorCode::Auth,
                        "S3 凭据被拒绝（Access Key / Secret Key 无效或无权限）",
                    )),
                    other => Err(OmniError::new(
                        ErrorCode::Connection,
                        format!("S3 连接测试失败（HTTP {other}）"),
                    )),
                },
                Err(e) => Err(OmniError::new(ErrorCode::Connection, "S3 连接测试失败").with_cause(e.to_string())),
            }
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
    let result = file_test_connection_config(&state, &conn).await?;
    mark_file_connection_online(&state, &connection_id);
    Ok(result)
}

/// 列出目录内容。
#[tauri::command]
#[specta::specta]
pub async fn file_list_dir(
    state: State<'_, AppState>,
    connection_id: String,
    path: String,
    search: Option<String>,
    continuation_token: Option<String>,
) -> Result<FileListDirResult, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        let entries = filter_file_entries(list_local_dir(&path)?, search.as_deref())?;
        mark_file_connection_online(&state, &connection_id);
        return Ok(FileListDirResult {
            entries,
            truncated: false,
            next_continuation_token: None,
        });
    }
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    let secret = resolve_secret(&conn).unwrap_or_default();
    let token = continuation_token
        .as_deref()
        .filter(|t| !t.is_empty());
    let (entries, truncated, next_continuation_token) = match protocol_of(&cfg) {
        FileProtocol::Local => {
            let entries = filter_file_entries(list_local_dir(&path)?, search.as_deref())?;
            (entries, false, None)
        }
        FileProtocol::Sftp => {
            let entries = filter_file_entries(
                list_sftp_dir(&state, &connection_id, &conn, &cfg, &path).await?,
                search.as_deref(),
            )?;
            (entries, false, None)
        }
        FileProtocol::Ftp => {
            let entries = filter_file_entries(
                list_ftp_dir(&cfg, &secret, &path).await?,
                search.as_deref(),
            )?;
            (entries, false, None)
        }
        FileProtocol::S3 => {
            list_s3_dir(&cfg, &secret, &path, search.as_deref(), token).await?
        }
    };
    mark_file_connection_online(&state, &connection_id);
    Ok(FileListDirResult {
        entries,
        truncated,
        next_continuation_token,
    })
}

/// 在 S3 连接存储桶内搜索：含 `/` 时按 key 前缀，否则按文件名子串。
#[tauri::command]
#[specta::specta]
pub async fn file_s3_search(
    state: State<'_, AppState>,
    connection_id: String,
    query: String,
    continuation_token: Option<String>,
) -> Result<FileListDirResult, OmniError> {
    let conn = load_file_connection(&state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    let cfg = parse_file_config(&conn)?;
    if protocol_of(&cfg) != FileProtocol::S3 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "仅 S3 连接支持此搜索"));
    }
    let secret = resolve_secret(&conn).unwrap_or_default();
    let token = continuation_token
        .as_deref()
        .filter(|t| !t.is_empty());
    let (entries, truncated, next_continuation_token) =
        search_s3(&cfg, &secret, &query, token).await?;
    mark_file_connection_online(&state, &connection_id);
    Ok(FileListDirResult {
        entries,
        truncated,
        next_continuation_token,
    })
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
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd).then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
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
            let key = normalize_s3_object_key(&path);
            let response = bucket.get_object(&key).await.map_err(|e| {
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
            let key = normalize_s3_object_key(&path);
            bucket.put_object(&key, &data).await.map_err(|e| {
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
            let mut key = normalize_s3_object_key(&path);
            if !key.ends_with('/') {
                key.push('/');
            }
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
            let old_key = normalize_s3_object_key(&old_path);
            let new_key = normalize_s3_object_key(&new_path);
            let response = bucket.get_object(&old_key).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 读取对象失败").with_cause(e.to_string())
            })?;
            let bytes = response.bytes();
            bucket.put_object(&new_key, bytes).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 写入对象失败").with_cause(e.to_string())
            })?;
            bucket.delete_object(&old_key).await.map_err(|e| {
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
            let key = normalize_s3_object_key(&path);
            bucket.delete_object(&key).await.map_err(|e| {
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
