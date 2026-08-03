//! 统一文件管理器：本地 / SFTP / FTP / S3 对象存储。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{ssh_config_from_json, SshAuth, SshConfig, SshSession};
use omnipanel_store::{inject_ssh_vault_into_config, Connection, ConnectionKind, Vault};
use s3::bucket::Bucket;
use s3::creds::Credentials;
use s3::region::Region;
use serde::{Deserialize, Serialize};
use specta::Type;
use suppaftp::FtpStream;
use tauri::State;

use crate::commands::aliyun_oss::AliyunOssClient;
use crate::commands::s3_list_compat::{s3_list_page, S3ListPage};
use crate::state::AppState;

/// 内置本地文件连接 id。
pub const LOCAL_CONNECTION_ID: &str = "__local__";

/// Windows「此电脑」虚拟根路径（列出盘符）。
pub const LOCAL_COMPUTER_ROOT: &str = "\\\\";

/// Windows「此电脑」虚拟根路径判定。
#[cfg(windows)]
fn is_local_computer_root(path: &str) -> bool {
    path == LOCAL_COMPUTER_ROOT || path == "\\"
}

fn local_platform_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    }
}

fn local_computer_root_path() -> &'static str {
    if cfg!(windows) {
        LOCAL_COMPUTER_ROOT
    } else {
        "/"
    }
}

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
    pub(crate) protocol: String,
    #[serde(default)]
    pub(crate) host: String,
    #[serde(default)]
    pub(crate) port: Option<u16>,
    #[serde(default)]
    pub(crate) user: String,
    #[serde(default, rename = "rootPath")]
    pub(crate) root_path: String,
    /// FTPS TLS 开关（当前预留字段，后续接入显式 FTPS）。
    #[allow(dead_code)]
    #[serde(default)]
    tls: bool,
    #[serde(default, rename = "sshConnectionId")]
    pub(crate) ssh_connection_id: Option<String>,
    #[serde(default)]
    pub(crate) bucket: String,
    /// aws | aliyun | tencent；缺省 aws（兼容旧连接）
    #[serde(default)]
    pub(crate) provider: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    pub(crate) endpoint: String,
    /// 前端生成公开链接用，后端 S3 API 不读取。
    #[serde(default, rename = "publicDomain")]
    #[allow(dead_code)]
    public_domain: String,
    #[serde(default)]
    prefix: String,
    #[serde(default, rename = "accessKey")]
    pub(crate) access_key: String,
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
    let Some(mut conn) = storage.get_connection(connection_id)? else {
        return Ok(None);
    };
    if migrate_shared_file_credential_inplace(&mut conn)? {
        conn.updated_at = unix_secs(SystemTime::now());
        storage.save_connection(&conn)?;
    }
    Ok(Some(conn))
}

// ─── Local backend ───────────────────────────────────────────────────────────

fn sort_file_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub(crate) fn list_local_dir(path: &str) -> Result<Vec<FileEntry>, OmniError> {
    #[cfg(windows)]
    if is_local_computer_root(path) {
        return list_windows_drives();
    }
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
    sort_file_entries(&mut entries);
    Ok(entries)
}

#[cfg(windows)]
fn list_windows_drives() -> Result<Vec<FileEntry>, OmniError> {
    let mut entries = Vec::new();
    for letter in b'A'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        if Path::new(&drive).exists() {
            entries.push(FileEntry {
                name: format!("{}:", letter as char),
                path: drive,
                kind: "dir".into(),
                size: 0,
                modified: 0,
                permissions: None,
            });
        }
    }
    Ok(entries)
}

fn list_local_volumes() -> Vec<(String, String)> {
    let mut volumes = Vec::new();
    if cfg!(windows) {
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if Path::new(&drive).exists() {
                volumes.push((format!("{}:", letter as char), drive));
            }
        }
    } else if cfg!(target_os = "macos") {
        volumes.push(("/".to_string(), "/".to_string()));
        if let Ok(read_dir) = std::fs::read_dir("/Volumes") {
            for entry in read_dir.flatten() {
                if entry.path().is_dir() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    let path = entry.path().to_string_lossy().to_string();
                    volumes.push((name, path));
                }
            }
        }
    } else {
        volumes.push(("/".to_string(), "/".to_string()));
        for mount_root in ["/mnt", "/media"] {
            if let Ok(read_dir) = std::fs::read_dir(mount_root) {
                for entry in read_dir.flatten() {
                    if entry.path().is_dir() {
                        let name = format!("{mount_root}/{}", entry.file_name().to_string_lossy());
                        let path = entry.path().to_string_lossy().to_string();
                        volumes.push((name, path));
                    }
                }
            }
        }
    }
    volumes
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

/// 解析 SFTP 文件连接的实际 SSH 端点（含关联 SSH 连接上的 host/port/user）。
pub(crate) async fn ssh_config_from_file_conn(
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
        kind: if entry.is_symlink {
            "symlink".into()
        } else if entry.is_dir {
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
    let mut entries: Vec<FileEntry> = list
        .iter()
        .map(|e| sftp_entry_to_file(e, &remote))
        .collect();
    sort_file_entries(&mut entries);
    Ok(entries)
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
        sort_file_entries(&mut entries);
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

/// 将虚拟主机风格 endpoint 规范为「区域 / 服务 endpoint」。
///
/// rust-s3 默认 subdomain style：请求 host = `{bucket}.{region.host()}`。
/// 若用户把 endpoint 填成 `https://old-bucket.oss-cn-beijing.aliyuncs.com`，
/// 再改 bucket 字段，仍会打到含旧桶名的域名（或拼出非法双层子域）。
pub(crate) fn normalize_s3_api_endpoint(endpoint: &str, bucket: &str) -> String {
    let raw = endpoint.trim().trim_end_matches('/');
    if raw.is_empty() {
        return String::new();
    }
    let (scheme, after_scheme) = if let Some(idx) = raw.find("://") {
        (&raw[..idx], &raw[idx + 3..])
    } else {
        ("https", raw)
    };
    let host_port = after_scheme
        .split('/')
        .next()
        .unwrap_or(after_scheme)
        .trim();
    if host_port.is_empty() {
        return String::new();
    }
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
        _ => (host_port, None),
    };
    let normalized_host = strip_virtual_hosted_bucket_host(host, bucket);
    match port {
        Some(p) => format!("{scheme}://{normalized_host}:{p}"),
        None => format!("{scheme}://{normalized_host}"),
    }
}

fn strip_virtual_hosted_bucket_host(host: &str, bucket: &str) -> String {
    let Some((first, rest)) = host.split_once('.') else {
        return host.to_string();
    };
    if rest.is_empty() {
        return host.to_string();
    }
    let first_l = first.to_ascii_lowercase();
    let rest_l = rest.to_ascii_lowercase();
    let bucket_l = bucket.trim().to_ascii_lowercase();

    // 当前 bucket 作为子域：bucket.oss-cn-xxx.aliyuncs.com
    if !bucket_l.is_empty() && first_l == bucket_l {
        return rest.to_string();
    }
    // 阿里云 OSS 虚拟主机：*.oss-*.aliyuncs.com / *.oss.*.aliyuncs.com
    // S3 兼容域名：*.s3.oss-*.aliyuncs.com
    if (rest_l.starts_with("oss-") || rest_l.starts_with("oss.") || rest_l.starts_with("s3.oss-"))
        && rest_l.contains("aliyuncs.com")
    {
        return rest.to_string();
    }
    // AWS S3 虚拟主机
    if rest_l == "s3.amazonaws.com"
        || (rest_l.starts_with("s3.") && rest_l.ends_with(".amazonaws.com"))
        || (rest_l.starts_with("s3-") && rest_l.ends_with(".amazonaws.com"))
    {
        return rest.to_string();
    }
    // 腾讯云 COS
    if rest_l.starts_with("cos.") && rest_l.contains("myqcloud.com") {
        return rest.to_string();
    }
    // 七牛 Kodo S3：*.s3.*.qiniucs.com
    if rest_l.starts_with("s3.") && rest_l.contains("qiniucs.com") {
        return rest.to_string();
    }
    host.to_string()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum S3ProviderKind {
    Aws,
    Aliyun,
    Tencent,
    Qiniu,
}

pub(crate) fn s3_provider_of(cfg: &FileConnConfig) -> S3ProviderKind {
    let ep = cfg.endpoint.to_ascii_lowercase();
    // Endpoint 域名优先：避免 UI 选「阿里云」却填了七牛域名，误走 OSS 专用签名客户端
    if ep.contains("qiniucs.com") || ep.contains(".qiniu.com") {
        return S3ProviderKind::Qiniu;
    }
    if ep.contains("aliyuncs.com") {
        return S3ProviderKind::Aliyun;
    }
    if ep.contains("myqcloud.com") || ep.contains("qcloud.com") {
        return S3ProviderKind::Tencent;
    }
    match cfg.provider.trim().to_ascii_lowercase().as_str() {
        "aliyun" | "oss" | "aliyun-oss" => S3ProviderKind::Aliyun,
        "tencent" | "cos" | "tencent-cos" => S3ProviderKind::Tencent,
        "qiniu" | "kodo" => S3ProviderKind::Qiniu,
        _ => {
            if ep.contains("aliyun") {
                S3ProviderKind::Aliyun
            } else if ep.contains("qcloud") {
                S3ProviderKind::Tencent
            } else if ep.contains("qiniu") {
                S3ProviderKind::Qiniu
            } else {
                S3ProviderKind::Aws
            }
        }
    }
}

pub(crate) fn default_s3_endpoint(provider: S3ProviderKind, region: &str) -> String {
    let r = region.trim();
    if r.is_empty() {
        return String::new();
    }
    match provider {
        S3ProviderKind::Aliyun => {
            let oss_region = if r.starts_with("oss-") {
                r.to_string()
            } else {
                format!("oss-{r}")
            };
            format!("https://{oss_region}.aliyuncs.com")
        }
        S3ProviderKind::Tencent => format!("https://cos.{r}.myqcloud.com"),
        S3ProviderKind::Qiniu => format!("https://s3.{r}.qiniucs.com"),
        S3ProviderKind::Aws => {
            if r == "us-east-1" {
                "https://s3.amazonaws.com".into()
            } else {
                format!("https://s3.{r}.amazonaws.com")
            }
        }
    }
}

/// 阿里云签名 region：控制台常填 oss-cn-beijing，SigV4 用 cn-beijing。
pub(crate) fn aliyun_signing_region(region: &str) -> String {
    let r = region.trim();
    if let Some(rest) = r.strip_prefix("oss-") {
        rest.to_string()
    } else {
        r.to_string()
    }
}

pub(crate) fn s3_bucket(cfg: &FileConnConfig, secret: &str) -> Result<Box<Bucket>, OmniError> {
    let provider = s3_provider_of(cfg);
    let region_input = cfg.region.trim();
    let endpoint = if cfg.endpoint.trim().is_empty() {
        let fallback_region = if region_input.is_empty() {
            match provider {
                S3ProviderKind::Aliyun => "oss-cn-beijing",
                S3ProviderKind::Tencent => "ap-beijing",
                S3ProviderKind::Qiniu => "cn-north-1",
                S3ProviderKind::Aws => "us-east-1",
            }
        } else {
            region_input
        };
        default_s3_endpoint(provider, fallback_region)
    } else {
        normalize_s3_api_endpoint(&cfg.endpoint, &cfg.bucket)
    };
    if endpoint.is_empty() {
        return Err(OmniError::invalid_input("请填写 Region 或 Endpoint"));
    }

    let signing_region = match provider {
        S3ProviderKind::Aliyun => aliyun_signing_region(if region_input.is_empty() {
            "oss-cn-beijing"
        } else {
            region_input
        }),
        S3ProviderKind::Tencent => {
            if region_input.is_empty() {
                "ap-beijing".into()
            } else {
                region_input.to_string()
            }
        }
        S3ProviderKind::Qiniu => {
            if region_input.is_empty() {
                "cn-north-1".into()
            } else {
                region_input.to_string()
            }
        }
        S3ProviderKind::Aws => {
            if region_input.is_empty() {
                "us-east-1".into()
            } else {
                region_input.to_string()
            }
        }
    };

    let endpoint_host = endpoint_host_of(&endpoint);
    let prefer_path_style = match provider {
        // 阿里云 OSS：官方仅支持虚拟主机（Bucket 作子域）；path-style 会 SignatureDoesNotMatch
        S3ProviderKind::Aliyun => false,
        // 七牛 S3：虚拟主机 / path-style 均支持，默认虚拟主机
        S3ProviderKind::Qiniu => false,
        // 腾讯云 COS：path-style 更稳（含 AppId 的桶名）
        S3ProviderKind::Tencent => true,
        S3ProviderKind::Aws => is_path_style_s3_host(&endpoint_host),
    };

    let region = Region::Custom {
        region: signing_region,
        endpoint,
    };
    let creds = Credentials::new(Some(&cfg.access_key), Some(secret), None, None, None)
        .map_err(|e| OmniError::new(ErrorCode::Auth, "S3 凭据无效").with_cause(e.to_string()))?;
    let mut bucket = Bucket::new(&cfg.bucket, region, creds).map_err(|e| {
        OmniError::new(ErrorCode::Connection, "创建 S3 客户端失败").with_cause(e.to_string())
    })?;
    if prefer_path_style {
        bucket.set_path_style();
    }
    Ok(bucket)
}

/// 阿里云 / 七牛等走自签 SigV4（避开 rust-s3 在部分兼容服务上的签名差异）。
fn sigv4_compat_client(cfg: &FileConnConfig, secret: &str) -> Result<AliyunOssClient, OmniError> {
    let provider = s3_provider_of(cfg);
    if !matches!(provider, S3ProviderKind::Aliyun | S3ProviderKind::Qiniu) {
        return Err(OmniError::invalid_input("当前供应商不使用 SigV4 兼容客户端"));
    }
    validate_s3_credentials_for_provider(provider, &cfg.access_key, secret)?;

    let region_input = cfg.region.trim();
    let endpoint = if cfg.endpoint.trim().is_empty() {
        let fallback = if region_input.is_empty() {
            match provider {
                S3ProviderKind::Aliyun => "oss-cn-beijing",
                S3ProviderKind::Qiniu => "cn-north-1",
                _ => "us-east-1",
            }
        } else {
            region_input
        };
        default_s3_endpoint(provider, fallback)
    } else {
        normalize_s3_api_endpoint(&cfg.endpoint, &cfg.bucket)
    };
    let signing_region = match provider {
        S3ProviderKind::Aliyun => aliyun_signing_region(if region_input.is_empty() {
            "oss-cn-beijing"
        } else {
            region_input
        }),
        S3ProviderKind::Qiniu => {
            if region_input.is_empty() {
                "cn-north-1".into()
            } else {
                region_input.to_string()
            }
        }
        _ => region_input.to_string(),
    };
    AliyunOssClient::new(
        &cfg.access_key,
        secret,
        &cfg.bucket,
        &signing_region,
        &endpoint,
    )
}

/// 阿里云 / 七牛密钥长度约定。长度明显错位时几乎必定是混用了另一家的密钥。
fn validate_s3_credentials_for_provider(
    provider: S3ProviderKind,
    access_key: &str,
    secret: &str,
) -> Result<(), OmniError> {
    let ak = access_key.trim();
    let sk = secret.trim();
    match provider {
        S3ProviderKind::Qiniu => {
            if !sk.is_empty() && sk.len() != 40 {
                return Err(OmniError::invalid_input(format!(
                    "七牛 SecretKey 长度异常（当前 {}，应为 40）。请编辑连接，从七牛控制台重新复制 SecretKey 并保存（勿混用阿里云密钥）",
                    sk.len()
                )));
            }
            if !ak.is_empty() && ak.len() != 40 {
                return Err(OmniError::invalid_input(format!(
                    "七牛 AccessKey 长度异常（当前 {}，应为 40）。请编辑连接，从七牛控制台重新复制 AccessKey 并保存",
                    ak.len()
                )));
            }
        }
        S3ProviderKind::Aliyun => {
            // 阿里云 AccessKeySecret 通常 30；40 基本是误粘了七牛 SK
            if !sk.is_empty() && sk.len() == 40 {
                return Err(OmniError::invalid_input(
                    "阿里云 SecretKey 长度异常（当前 40，通常为 30）。很像粘成了七牛 SecretKey；请到阿里云 RAM 控制台重新复制与 AccessKey 成对的 Secret，保存后再试",
                ));
            }
            if !sk.is_empty() && sk.len() != 30 {
                return Err(OmniError::invalid_input(format!(
                    "阿里云 SecretKey 长度异常（当前 {}，通常为 30）。请编辑连接，从阿里云控制台重新复制 SecretKey 并保存",
                    sk.len()
                )));
            }
            if !ak.is_empty() && !ak.starts_with("LTAI") {
                return Err(OmniError::invalid_input(
                    "阿里云 AccessKey 通常以 LTAI 开头。请确认未填入七牛或其他云的 AccessKey",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

fn uses_sigv4_compat_client(cfg: &FileConnConfig) -> bool {
    matches!(
        s3_provider_of(cfg),
        S3ProviderKind::Aliyun | S3ProviderKind::Qiniu
    )
}

async fn s3_list_page_cfg(
    cfg: &FileConnConfig,
    secret: &str,
    prefix: String,
    delimiter: Option<String>,
    continuation_token: Option<String>,
    max_keys: Option<usize>,
) -> Result<S3ListPage, OmniError> {
    let provider = s3_provider_of(cfg);
    let provider_field = cfg.provider.trim();
    if provider == S3ProviderKind::Qiniu
        && provider_field.eq_ignore_ascii_case("aliyun")
    {
        tracing::warn!(
            target: "aliyun_oss_sig",
            endpoint = %cfg.endpoint,
            provider_field = %provider_field,
            "连接供应商字段为阿里云，但 Endpoint 是七牛（qiniucs.com）；已按七牛路由，请在连接里改选「七牛云」"
        );
    }
    tracing::warn!(
        target: "aliyun_oss_sig",
        provider = ?provider,
        provider_raw = %cfg.provider,
        bucket = %cfg.bucket,
        region = %cfg.region,
        endpoint = %cfg.endpoint,
        access_key_len = cfg.access_key.trim().len(),
        secret_len = secret.trim().len(),
        prefix = %prefix,
        delimiter = ?delimiter,
        "S3 list 路由"
    );
    if uses_sigv4_compat_client(cfg) {
        let client = sigv4_compat_client(cfg, secret)?;
        return client
            .list_objects_v2(prefix, delimiter, continuation_token, max_keys)
            .await;
    }
    let bucket = s3_bucket(cfg, secret)?;
    s3_list_page(&bucket, prefix, delimiter, continuation_token, max_keys).await
}

fn endpoint_host_of(endpoint: &str) -> String {
    let raw = endpoint.trim();
    let after_scheme = raw
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(raw);
    let host_port = after_scheme.split('/').next().unwrap_or(after_scheme);
    host_port
        .rsplit_once(':')
        .and_then(|(h, p)| {
            if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
                Some(h.to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| host_port.to_string())
}

fn is_path_style_s3_host(host: &str) -> bool {
    let h = host.trim();
    if h.is_empty() {
        return false;
    }
    h.eq_ignore_ascii_case("localhost") || h.parse::<std::net::IpAddr>().is_ok()
}

pub(crate) fn normalize_s3_prefix(path: &str, cfg: &FileConnConfig) -> String {
    let base = cfg.prefix.trim_matches('/');
    // 前端路径相对配置 prefix；若误带上 prefix 前缀则剥离，避免双重拼接
    let mut p = path.trim_matches('/').to_string();
    if !base.is_empty() {
        if let Some(rest) = p.strip_prefix(base) {
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

async fn list_s3_dir(
    cfg: &FileConnConfig,
    secret: &str,
    path: &str,
    search: Option<&str>,
    start_token: Option<&str>,
) -> Result<(Vec<FileEntry>, bool, Option<String>), OmniError> {
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
    let page = s3_list_page_cfg(
        cfg,
        secret,
        prefix.clone(),
        Some("/".to_string()),
        start_token.map(str::to_string),
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
        e
    })?;
    let mut entries = Vec::new();
    if !page.common_prefixes.is_empty() {
        for cp in &page.common_prefixes {
            let key = cp.trim_end_matches('/');
            let name = key.rsplit('/').next().unwrap_or(key).to_string();
            if !matches_search(&name) {
                continue;
            }
            entries.push(FileEntry {
                name: name.clone(),
                path: cp.clone(),
                kind: "dir".into(),
                size: 0,
                modified: 0,
                permissions: None,
            });
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
        if !matches_search(&name) {
            continue;
        }
        entries.push(FileEntry {
            name: name.clone(),
            path: obj.key.clone(),
            kind: "file".into(),
            size: obj.size,
            modified: 0,
            permissions: None,
        });
    }
    sort_file_entries(&mut entries);
    let has_more = page.is_truncated;
    let next_token = if has_more {
        page.next_continuation_token.clone()
    } else {
        None
    };
    Ok((entries, has_more, next_token))
}

fn push_s3_list_page_entries(
    page: &S3ListPage,
    entries: &mut Vec<FileEntry>,
    name_filter: Option<&str>,
) {
    for cp in &page.common_prefixes {
        let key = cp.trim_end_matches('/');
        let name = key.rsplit('/').next().unwrap_or(key).to_string();
        if name_filter.map_or(true, |q| name.to_lowercase().contains(q)) {
            entries.push(FileEntry {
                name: name.clone(),
                path: cp.clone(),
                kind: "dir".into(),
                size: 0,
                modified: 0,
                permissions: None,
            });
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
    sort_file_entries(entries);
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
    const S3_PAGE_SIZE: usize = 200;
    let page = s3_list_page_cfg(
        cfg,
        secret,
        prefix.to_string(),
        Some("/".to_string()),
        start_token.map(str::to_string),
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
        page.next_continuation_token.clone()
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
        let page = s3_list_page_cfg(
            cfg,
            secret,
            prefix.clone(),
            None,
            token,
            Some(S3_LIST_PAGE_SIZE),
        )
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
            if !key_prefix_mode && !name.to_lowercase().contains(&search_q) {
                continue;
            }
            entries.push(FileEntry {
                name: name.clone(),
                path: obj.key.clone(),
                kind: "file".into(),
                size: obj.size,
                modified: 0,
                permissions: None,
            });
            if entries.len() >= S3_SEARCH_RESULT_LIMIT {
                return Ok((entries, true, page.next_continuation_token.clone()));
            }
        }

        if !page.is_truncated {
            break;
        }
        token = page.next_continuation_token.clone();
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
            provider: String::new(),
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

    #[test]
    fn normalize_endpoint_strips_virtual_hosted_bucket() {
        assert_eq!(
            normalize_s3_api_endpoint(
                "https://old-bucket.oss-cn-beijing.aliyuncs.com",
                "new-bucket"
            ),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            normalize_s3_api_endpoint(
                "https://new-bucket.oss-cn-beijing.aliyuncs.com",
                "new-bucket"
            ),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            normalize_s3_api_endpoint("https://oss-cn-beijing.aliyuncs.com", "any"),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            normalize_s3_api_endpoint("https://my.s3.us-east-1.amazonaws.com", "x"),
            "https://s3.us-east-1.amazonaws.com"
        );
        assert_eq!(
            normalize_s3_api_endpoint("http://127.0.0.1:9000", "minio"),
            "http://127.0.0.1:9000"
        );
    }

    #[test]
    fn provider_default_endpoints() {
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Aliyun, "oss-cn-beijing"),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Aliyun, "cn-hangzhou"),
            "https://oss-cn-hangzhou.aliyuncs.com"
        );
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Tencent, "ap-beijing"),
            "https://cos.ap-beijing.myqcloud.com"
        );
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Qiniu, "cn-north-1"),
            "https://s3.cn-north-1.qiniucs.com"
        );
        assert_eq!(aliyun_signing_region("oss-cn-beijing"), "cn-beijing");
    }

    #[test]
    fn qiniu_endpoint_overrides_aliyun_provider_field() {
        let mut c = cfg("");
        c.provider = "aliyun".into();
        c.endpoint = "https://s3.cn-north-1.qiniucs.com".into();
        assert_eq!(
            s3_provider_of(&c),
            S3ProviderKind::Qiniu,
            "七牛域名必须覆盖错误的阿里云供应商字段"
        );
    }

    #[test]
    fn qiniu_rejects_non_40_char_secret() {
        let err = validate_s3_credentials_for_provider(
            S3ProviderKind::Qiniu,
            "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
            "too-short-secret-key-30chars!!",
        )
        .expect_err("sk len 30");
        assert!(err.message.contains("SecretKey"));
        assert!(err.message.contains("40"));
    }

    #[test]
    fn aliyun_rejects_40_char_secret_looking_like_qiniu() {
        let err = validate_s3_credentials_for_provider(
            S3ProviderKind::Aliyun,
            "LTAI5t7cNGJVnJuzJWRY6GX3",
            "abcdefghijklmnopqrstuvwxyz0123456789ABCD",
        )
        .expect_err("sk len 40");
        assert!(err.message.contains("40"));
        assert!(err.message.contains("七牛") || err.message.contains("30"));
    }

    #[test]
    fn aliyun_uses_virtual_host_not_path_style() {
        let mut c = cfg("");
        c.provider = "aliyun".into();
        c.bucket = "teacher-chat".into();
        c.region = "oss-cn-beijing".into();
        c.endpoint = "https://oss-cn-beijing.aliyuncs.com".into();
        c.access_key = "ak".into();
        let bucket = s3_bucket(&c, "secret").expect("bucket");
        assert!(
            !bucket.is_path_style(),
            "阿里云必须用虚拟主机，否则 SignatureDoesNotMatch"
        );
        assert!(bucket.host().starts_with("teacher-chat."));
        assert!(bucket.host().contains("oss-cn-beijing.aliyuncs.com"));
    }

    #[test]
    fn provider_detects_from_endpoint_when_unset() {
        let mut c = cfg("");
        c.endpoint = "https://oss-cn-beijing.aliyuncs.com".into();
        assert_eq!(s3_provider_of(&c), S3ProviderKind::Aliyun);
        c.endpoint = "https://cos.ap-guangzhou.myqcloud.com".into();
        assert_eq!(s3_provider_of(&c), S3ProviderKind::Tencent);
        c.provider = "aliyun".into();
        c.endpoint = String::new();
        assert_eq!(s3_provider_of(&c), S3ProviderKind::Aliyun);
    }
}

// ─── Dispatch ────────────────────────────────────────────────────────────────

#[derive(PartialEq, Eq, Clone, Copy)]
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

fn is_s3_prefix_delete_path(path: &str, entry_kind: Option<&str>) -> bool {
    if entry_kind == Some("dir") {
        return true;
    }
    normalize_s3_object_key(path).ends_with('/')
}

fn normalize_s3_delete_prefix(path: &str, entry_kind: Option<&str>) -> String {
    let mut key = normalize_s3_object_key(path);
    if is_s3_prefix_delete_path(path, entry_kind) && !key.ends_with('/') {
        key.push('/');
    }
    key
}

/// 删除 S3 前缀下全部对象（含子目录中的文件），并尝试删除目录占位对象。
async fn delete_s3_prefix_recursive(
    cfg: &FileConnConfig,
    secret: &str,
    prefix: &str,
) -> Result<(), OmniError> {
    let prefix = if prefix.ends_with('/') {
        prefix.to_string()
    } else {
        format!("{prefix}/")
    };
    const S3_DELETE_PAGE_SIZE: usize = 1000;
    let mut token: Option<String> = None;
    loop {
        let page = s3_list_page_cfg(
            cfg,
            secret,
            prefix.clone(),
            None,
            token.clone(),
            Some(S3_DELETE_PAGE_SIZE),
        )
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Io, "列出 S3 对象失败").with_cause(e.to_string())
        })?;
        for obj in &page.contents {
            s3_delete_object(cfg, secret, &obj.key).await?;
        }
        if !page.is_truncated {
            break;
        }
        token = page.next_continuation_token.clone();
        if token.is_none() {
            break;
        }
    }
    let _ = s3_delete_object(cfg, secret, &prefix).await;
    Ok(())
}

async fn s3_delete_object(cfg: &FileConnConfig, secret: &str, key: &str) -> Result<(), OmniError> {
    if uses_sigv4_compat_client(cfg) {
        let client = sigv4_compat_client(cfg, secret)?;
        return client.delete_object(key).await;
    }
    let bucket = s3_bucket(cfg, secret)?;
    bucket.delete_object(key).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "S3 删除对象失败").with_cause(e.to_string())
    })?;
    Ok(())
}

pub(crate) async fn s3_get_object_bytes(
    cfg: &FileConnConfig,
    secret: &str,
    key: &str,
) -> Result<Vec<u8>, OmniError> {
    if uses_sigv4_compat_client(cfg) {
        let client = sigv4_compat_client(cfg, secret)?;
        return client.get_object(key).await;
    }
    let bucket = s3_bucket(cfg, secret)?;
    let response = bucket.get_object(key).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "S3 下载失败").with_cause(e.to_string())
    })?;
    Ok(response.bytes().to_vec())
}

pub(crate) async fn s3_put_object_bytes(
    cfg: &FileConnConfig,
    secret: &str,
    key: &str,
    data: &[u8],
) -> Result<(), OmniError> {
    if uses_sigv4_compat_client(cfg) {
        let client = sigv4_compat_client(cfg, secret)?;
        return client.put_object(key, data).await;
    }
    let bucket = s3_bucket(cfg, secret)?;
    bucket.put_object(key, data).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "S3 上传失败").with_cause(e.to_string())
    })?;
    Ok(())
}

/// 同桶服务端拷贝（不经本机）。
pub(crate) async fn s3_copy_object_internal(
    cfg: &FileConnConfig,
    secret: &str,
    from_key: &str,
    to_key: &str,
) -> Result<(), OmniError> {
    if uses_sigv4_compat_client(cfg) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "当前 S3 兼容端点暂不支持服务端拷贝",
        ));
    }
    let bucket = s3_bucket(cfg, secret)?;
    let code = bucket
        .copy_object_internal(from_key, to_key)
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 服务端拷贝失败").with_cause(e.to_string())
        })?;
    if !(200..300).contains(&code) {
        return Err(OmniError::new(
            ErrorCode::Io,
            format!("S3 服务端拷贝失败（HTTP {code}）"),
        ));
    }
    Ok(())
}

/// 跨桶服务端拷贝（要求目标凭据能读源桶）。
pub(crate) async fn s3_copy_object_from_bucket(
    dest_cfg: &FileConnConfig,
    dest_secret: &str,
    source_bucket: &str,
    source_key: &str,
    dest_key: &str,
) -> Result<(), OmniError> {
    if uses_sigv4_compat_client(dest_cfg) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "当前 S3 兼容端点暂不支持跨桶服务端拷贝",
        ));
    }
    use s3::command::Command;
    use s3::request::tokio_backend::HyperRequest;
    use s3::request::Request;

    let bucket = s3_bucket(dest_cfg, dest_secret)?;
    let from = format!(
        "{}/{}",
        source_bucket.trim_matches('/'),
        source_key.trim_start_matches('/')
    );
    let command = Command::CopyObject { from: from.as_str() };
    let request = HyperRequest::new(bucket.as_ref(), dest_key, command)
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 跨桶拷贝请求失败").with_cause(e.to_string())
        })?;
    let response = request.response_data(false).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "S3 跨桶拷贝失败").with_cause(e.to_string())
    })?;
    let code = response.status_code();
    if !(200..300).contains(&code) {
        return Err(OmniError::new(
            ErrorCode::Io,
            format!("S3 跨桶拷贝失败（HTTP {code}）"),
        ));
    }
    Ok(())
}

async fn s3_head_object_status(
    cfg: &FileConnConfig,
    secret: &str,
    key: &str,
) -> Result<u16, OmniError> {
    if uses_sigv4_compat_client(cfg) {
        let client = sigv4_compat_client(cfg, secret)?;
        return client.head_object(key).await;
    }
    let bucket = s3_bucket(cfg, secret)?;
    let (_, status) = bucket.head_object(key).await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "S3 连接测试失败").with_cause(e.to_string())
    })?;
    Ok(status)
}

async fn delete_s3_path(
    cfg: &FileConnConfig,
    secret: &str,
    path: &str,
    entry_kind: Option<&str>,
) -> Result<(), OmniError> {
    let key = normalize_s3_object_key(path);
    if key.is_empty() {
        return Err(OmniError::invalid_input("不能删除存储桶根目录"));
    }
    if is_s3_prefix_delete_path(path, entry_kind) {
        let prefix = normalize_s3_delete_prefix(path, entry_kind);
        delete_s3_prefix_recursive(cfg, secret, &prefix).await
    } else {
        s3_delete_object(cfg, secret, &key).await
    }
}

#[cfg(test)]
mod s3_delete_tests {
    use super::{is_s3_prefix_delete_path, normalize_s3_delete_prefix};

    #[test]
    fn prefix_delete_detects_trailing_slash_and_kind() {
        assert!(is_s3_prefix_delete_path("foo/", None));
        assert!(is_s3_prefix_delete_path("root/foo/bar/", None));
        assert!(is_s3_prefix_delete_path("foo/bar", Some("dir")));
        assert!(!is_s3_prefix_delete_path("foo/bar.txt", None));
        assert!(!is_s3_prefix_delete_path("/object.key", None));
        assert_eq!(normalize_s3_delete_prefix("foo/bar", Some("dir")), "foo/bar/");
    }
}

#[cfg(test)]
mod file_credential_binding_tests {
    use omnipanel_store::{Connection, ConnectionKind};

    use super::{
        ensure_file_connection_id, file_credential_ref_for, is_shared_file_credential_ref,
        bind_file_connection_secret,
    };

    fn blank_file_conn() -> Connection {
        Connection {
            id: String::new(),
            kind: ConnectionKind::File,
            name: "test".into(),
            group: String::new(),
            env_tag: "dev".into(),
            tags: vec![],
            config: "{}".into(),
            credential_ref: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    #[test]
    fn ensure_id_assigns_before_cred_ref_shape() {
        let mut a = blank_file_conn();
        let mut b = blank_file_conn();
        ensure_file_connection_id(&mut a);
        ensure_file_connection_id(&mut b);
        assert!(a.id.starts_with("file-"));
        assert!(b.id.starts_with("file-"));
        assert_ne!(a.id, b.id);
        assert_eq!(
            file_credential_ref_for(&a.id),
            format!("file-cred-{}", a.id)
        );
        // 专属 key 绝不是空 id 的共享槽
        assert_ne!(file_credential_ref_for(&a.id), "file-cred-");
        assert!(!is_shared_file_credential_ref(&file_credential_ref_for(&a.id)));
    }

    #[test]
    fn ensure_id_preserves_existing() {
        let mut c = blank_file_conn();
        c.id = "file-fixed".into();
        ensure_file_connection_id(&mut c);
        assert_eq!(c.id, "file-fixed");
    }

    #[test]
    fn shared_ref_detection() {
        assert!(is_shared_file_credential_ref(""));
        assert!(is_shared_file_credential_ref("file-cred-"));
        assert!(is_shared_file_credential_ref("file-cred"));
        assert!(!is_shared_file_credential_ref("file-cred-file-abc"));
    }

    #[test]
    fn bind_requires_id() {
        let mut c = blank_file_conn();
        let err = bind_file_connection_secret(&mut c, Some("sk".into())).unwrap_err();
        assert!(err.to_string().contains("connection.id"));
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
///
/// 注意：必须先分配 `connection.id`，再写入 Vault。
/// 历史 bug：新建时 id 仍为空就把 Secret 存成 `file-cred-`，导致多条连接共用同一钥匙串条目，后保存的覆盖先保存的。
#[tauri::command]
#[specta::specta]
pub async fn file_save_connection(
    state: State<'_, AppState>,
    mut connection: Connection,
    secret: Option<String>,
) -> Result<Connection, OmniError> {
    connection.kind = ConnectionKind::File;
    ensure_file_connection_id(&mut connection);
    bind_file_connection_secret(&mut connection, secret)?;
    connection.updated_at = unix_secs(SystemTime::now());
    let storage = state.storage.lock().await;
    storage.save_connection(&connection)?;
    Ok(connection)
}

fn now_unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// 确保文件连接有稳定唯一 id（新建时用纳秒，避免同秒冲突）。
pub(crate) fn ensure_file_connection_id(connection: &mut Connection) {
    if !connection.id.trim().is_empty() {
        return;
    }
    let nanos = now_unix_nanos();
    connection.id = format!("file-{nanos:x}");
    if connection.created_at == 0 {
        connection.created_at = (nanos / 1_000_000_000) as i64;
    }
}

pub(crate) fn file_credential_ref_for(connection_id: &str) -> String {
    format!("file-cred-{connection_id}")
}

/// 是否为历史 bug 产生的共享钥匙串 key（多连接抢同一条目）。
///
/// 旧版在 id 为空时写入 `file-cred-` / `file-cred`。
pub(crate) fn is_shared_file_credential_ref(credential_ref: &str) -> bool {
    let r = credential_ref.trim();
    r.is_empty() || r == "file-cred-" || r == "file-cred"
}

/// 写入或迁移文件连接 Secret：始终落到 `file-cred-{connection.id}`。
///
/// 不主动删除历史共享 key（可能仍被其它连接引用）；用户各自重存后共享槽可自然闲置。
pub(crate) fn bind_file_connection_secret(
    connection: &mut Connection,
    secret: Option<String>,
) -> Result<(), OmniError> {
    if connection.id.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Internal,
            "保存文件凭据前必须先分配 connection.id",
        ));
    }
    let desired = file_credential_ref_for(&connection.id);
    let old_ref = connection
        .credential_ref
        .clone()
        .filter(|r| !r.trim().is_empty());

    if let Some(sec) = secret.filter(|s| !s.is_empty()) {
        Vault::store(&desired, &sec)?;
        connection.credential_ref = Some(desired);
        return Ok(());
    }

    // 未提交新 Secret：若仍绑在共享 key 上，把现有内容复制到本连接专属 key
    // （止血用：共享槽里往往是「最后保存的那条」密钥，其它连接仍需各自重填）
    // 同时支持从云账户 `cloud-secret-*` 等其它 Vault key 复制到文件连接专属 key。
    if let Some(old) = old_ref {
        if old != desired {
            if let Ok(existing) = Vault::get(&old) {
                if !existing.trim().is_empty() {
                    Vault::store(&desired, &existing)?;
                    connection.credential_ref = Some(desired);
                    if is_shared_file_credential_ref(&old) {
                        tracing::warn!(
                            connection_id = %connection.id,
                            old_ref = %old,
                            "文件连接凭据曾共用钥匙串条目，已迁移到专属 key；若签名失败请按连接重新填写 SecretKey"
                        );
                    }
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

/// 加载时若仍指向共享凭据槽，则迁移并回写存储。
pub(crate) fn migrate_shared_file_credential_inplace(
    connection: &mut Connection,
) -> Result<bool, OmniError> {
    let Some(old) = connection.credential_ref.as_deref() else {
        return Ok(false);
    };
    if !is_shared_file_credential_ref(old) {
        return Ok(false);
    }
    let before = connection.credential_ref.clone();
    bind_file_connection_secret(connection, None)?;
    Ok(connection.credential_ref != before)
}

/// 测试未保存或已保存的文件连接配置。
///
/// `secret_override`：对话框测试时传入的明文密钥；为空则回退 Vault。
pub async fn file_test_connection_config(
    state: &AppState,
    connection: &Connection,
    secret_override: Option<&str>,
) -> Result<String, OmniError> {
    let cfg = parse_file_config(connection)?;
    let secret = secret_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| resolve_secret(connection))
        .unwrap_or_default();
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
            if cfg.access_key.trim().is_empty() || secret.is_empty() {
                return Err(OmniError::invalid_input(
                    "请填写 Access Key 与 Secret Key（保存前测试需在表单中输入密钥）",
                ));
            }
            // 使用 head_object 对一个几乎不存在的 key 做探测，避免 list 的 XML
            // 反序列化（rust-s3 0.35 的 ListBucketResult 要求 Name 字段，部分 S3 兼容
            // 服务响应里会缺失该字段导致 "missing field `Name`" 报错）。
            // head_object 不解析响应体，仅依据 HTTP 状态码判断连通性与凭据：
            //   2xx / 404 -> 凭据有效，Bucket 可达
            //   403        -> 凭据/权限被拒绝
            //   其它 / Err -> 连接或签名失败
            let probe_key = "__omnipanel_connect_probe__";
            match s3_head_object_status(&cfg, &secret, probe_key).await {
                Ok(status) => match status {
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
                Err(e) => Err(e),
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
    let result = file_test_connection_config(&state, &conn, None).await?;
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
    sort_file_entries(&mut entries);
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
            let key = normalize_s3_object_key(&path);
            let data = s3_get_object_bytes(&cfg, &secret, &key).await?;
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
            let key = normalize_s3_object_key(&path);
            s3_put_object_bytes(&cfg, &secret, &key, &data).await
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
            let mut key = normalize_s3_object_key(&path);
            if !key.ends_with('/') {
                key.push('/');
            }
            s3_put_object_bytes(&cfg, &secret, &key, &[]).await.map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 创建目录失败").with_cause(e.to_string())
            })
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
            let old_key = normalize_s3_object_key(&old_path);
            let new_key = normalize_s3_object_key(&new_path);
            let bytes = s3_get_object_bytes(&cfg, &secret, &old_key)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Io, "S3 读取对象失败").with_cause(e.to_string())
                })?;
            s3_put_object_bytes(&cfg, &secret, &new_key, &bytes)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Io, "S3 写入对象失败").with_cause(e.to_string())
                })?;
            s3_delete_object(&cfg, &secret, &old_key).await.map_err(|e| {
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
    entry_kind: Option<String>,
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
        FileProtocol::S3 => delete_s3_path(&cfg, &secret, &path, entry_kind.as_deref()).await
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileLocalVolume {
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FileLocalSystemInfo {
    pub platform: String,
    pub computer_root: String,
    pub volumes: Vec<FileLocalVolume>,
}

/// 本机文件系统平台信息与卷/盘符列表。
#[tauri::command]
#[specta::specta]
pub async fn file_local_system_info() -> Result<FileLocalSystemInfo, OmniError> {
    Ok(FileLocalSystemInfo {
        platform: local_platform_name().to_string(),
        computer_root: local_computer_root_path().to_string(),
        volumes: list_local_volumes()
            .into_iter()
            .map(|(label, path)| FileLocalVolume { label, path })
            .collect(),
    })
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

/// 获取本机临时目录路径。
#[tauri::command]
#[specta::specta]
pub async fn file_local_temp_dir() -> Result<String, OmniError> {
    let temp_dir = std::env::temp_dir();
    Ok(temp_dir.to_string_lossy().into_owned())
}
