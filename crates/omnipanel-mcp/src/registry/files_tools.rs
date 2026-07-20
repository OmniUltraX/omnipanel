//! Files MCP 工具 — OmniMCP 外部路径直连后端实现。
//!
//! 内部 AI 路径下，`omni_files_*` 工具是 UiDelegated（走前端 invoke Tauri 命令）；
//! 但外部 OmniMCP 客户端无法访问前端的 Tauri runtime，故此处提供"一次性连接"
//! 后端实现：
//! - Local: 直接 std::fs（与 src-tauri 的 local_read/local_write/list_local_dir 一致）
//! - SFTP: 一次性 `SshSession::connect_no_shell` → `sftp_list/sftp_download/sftp_upload`
//! - FTP / S3: 外部路径暂不支持（依赖AppState/连接池），返回友好错误
//!
//! 性能权衡：SFTP 每次调用都重新建立连接，不缓存。外部 MCP 调用频率远低于
//! 内部 AI 工具，且避免引入连接池生命周期管理。

use std::sync::Arc;
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{ssh_config_from_json, SshConfig, SshSession};
use omnipanel_store::{ConnectionKind, Storage, Vault};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

/// 一次性 Files 操作超时（秒）。
const FILES_OP_TIMEOUT_SECS: u64 = 60;

/// 默认读取上限：512KB（与 src-tauri `file_read_file` 默认一致）。
const DEFAULT_READ_MAX_BYTES: u64 = 512 * 1024;
/// 硬上限：8MB。
const MAX_READ_BYTES: u64 = 8 * 1024 * 1024;

/// 本机文件系统的固定 connection_id。
const FILES_LOCAL_CONNECTION_ID: &str = "__local__";

/// Windows 此电脑虚拟根。
#[cfg(windows)]
const LOCAL_COMPUTER_ROOT: &str = "\\\\";

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少必填参数: {key}"))
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// 已解析的文件操作目标。
enum FileTarget {
    Local,
    Sftp(Arc<SshSession>, FileConnConfig),
}

/// 文件连接配置（与 src-tauri 的 `FileConnConfig` 字段对齐，camelCase）。
///
/// FTP/S3 字段（tls/bucket/region/endpoint/public_domain/prefix/access_key）
/// 当前在外部 MCP 路径下未实现，但保留以确保与 src-tauri 配置结构一致，
/// 未来扩展 FTP/S3 直调时直接可用。
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
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
    #[serde(default, rename = "publicDomain")]
    public_domain: String,
    #[serde(default)]
    prefix: String,
    #[serde(default, rename = "accessKey")]
    access_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FileProtocol {
    Local,
    Sftp,
    Ftp,
    S3,
}

fn protocol_of(cfg: &FileConnConfig) -> FileProtocol {
    match cfg.protocol.trim().to_ascii_lowercase().as_str() {
        "ftp" => FileProtocol::Ftp,
        "s3" => FileProtocol::S3,
        "sftp" => FileProtocol::Sftp,
        "local" => FileProtocol::Local,
        _ if !cfg.bucket.trim().is_empty() => FileProtocol::S3,
        _ if !cfg.host.trim().is_empty() => FileProtocol::Sftp,
        _ => FileProtocol::Local,
    }
}

/// 从 storage 同步读取文件连接配置（不建立任何连接）。
fn load_file_config(
    storage: &Storage,
    connection_id: &str,
) -> Result<(String, FileConnConfig, FileProtocol), String> {
    let conn = storage
        .get_connection(connection_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("文件连接不存在: {connection_id}"))?;
    if conn.kind != ConnectionKind::File {
        return Err(format!("连接 {connection_id} 不是 File 类型"));
    }
    let cfg: FileConnConfig =
        serde_json::from_str(&conn.config).unwrap_or_default();
    let protocol = protocol_of(&cfg);
    Ok((conn.name, cfg, protocol))
}

/// 同步解析 SFTP 连接的 SshConfig：
/// - 若 `sshConnectionId` 设置，从 storage 加载该 SSH 连接的配置；
/// - 否则使用 file 配置内嵌的 host/user/port + Vault 密码。
fn resolve_ssh_config_for_file(
    storage: &Storage,
    conn_id: &str,
    cfg: &FileConnConfig,
) -> Result<SshConfig, String> {
    if let Some(ssh_id) = cfg
        .ssh_connection_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        let ssh_conn = storage
            .get_connection(ssh_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("绑定的 SSH 连接不存在: {ssh_id}"))?;
        if ssh_conn.kind != ConnectionKind::Ssh {
            return Err(format!("绑定连接 {ssh_id} 不是 SSH 类型"));
        }
        let secret = ssh_conn
            .credential_ref
            .as_deref()
            .and_then(|r| Vault::get(r).ok());
        return ssh_config_from_json(&ssh_conn.config, secret.as_deref())
            .map_err(|e| format!("SSH 配置解析失败: {}", e.user_message()));
    }
    // 内嵌配置：从 Vault 读取密码（credential_ref 在 file 连接上）
    let secret = storage
        .get_connection(conn_id)
        .ok()
        .flatten()
        .and_then(|c| c.credential_ref)
        .and_then(|r| Vault::get(&r).ok())
        .unwrap_or_default();
    let port = cfg.port.unwrap_or(22);
    let auth = if !secret.is_empty() {
        omnipanel_ssh::SshAuth::Password { password: secret }
    } else {
        omnipanel_ssh::SshAuth::PrivateKey {
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

/// 加载配置 + 建立目标（统一入口）。
async fn resolve_target(
    storage: Arc<Mutex<Storage>>,
    connection_id: &str,
) -> Result<(String, FileTarget), String> {
    if connection_id == FILES_LOCAL_CONNECTION_ID {
        return Ok((
            "本机文件系统".to_string(),
            FileTarget::Local,
        ));
    }
    let (conn_name, cfg, protocol) = {
        let storage = storage.lock().await;
        load_file_config(&storage, connection_id)?
    };
    match protocol {
        FileProtocol::Local => Ok((conn_name, FileTarget::Local)),
        FileProtocol::Sftp => {
            let ssh_config = {
                let storage = storage.lock().await;
                resolve_ssh_config_for_file(&storage, connection_id, &cfg)?
            };
            let session = tokio::time::timeout(
                Duration::from_secs(FILES_OP_TIMEOUT_SECS),
                SshSession::connect_no_shell(ssh_config),
            )
            .await
            .map_err(|_| format!("SFTP 连接超时（{FILES_OP_TIMEOUT_SECS}s）"))?
            .map_err(|e| format!("SFTP 连接失败: {}", e.user_message()))?;
            Ok((conn_name, FileTarget::Sftp(Arc::new(session), cfg)))
        }
        FileProtocol::Ftp => Err(OmniError::new(
            ErrorCode::InvalidInput,
            "外部 OmniMCP 路径暂不支持 FTP 协议；请在应用内通过内部 AI 调用 omni_files_*。",
        )
        .user_message()
        .to_string()),
        FileProtocol::S3 => Err(OmniError::new(
            ErrorCode::InvalidInput,
            "外部 OmniMCP 路径暂不支持 S3 协议；请在应用内通过内部 AI 调用 omni_files_*。",
        )
        .user_message()
        .to_string()),
    }
}

// ─── 本机路径解析（与 src-tauri `resolve_local_path` 一致） ────────────────────

fn local_home() -> Result<std::path::PathBuf, String> {
    if let Ok(p) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        return Ok(std::path::PathBuf::from(p));
    }
    Err("无法获取用户主目录".to_string())
}

fn resolve_local_path(path: &str) -> Result<std::path::PathBuf, String> {
    if path.is_empty() || path == "/" || path == "~" {
        return local_home();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Ok(local_home()?.join(rest));
    }
    Ok(std::path::PathBuf::from(path))
}

fn unix_secs(t: std::time::SystemTime) -> i64 {
    t.duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[derive(serde::Serialize)]
struct FileEntryOut {
    name: String,
    path: String,
    kind: String,
    size: u64,
    modified: i64,
    permissions: Option<String>,
}

fn list_local_dir(path: &str) -> Result<Vec<FileEntryOut>, String> {
    #[cfg(windows)]
    if path == LOCAL_COMPUTER_ROOT || path == "\\" {
        let mut entries = Vec::new();
        for letter in b'A'..=b'Z' {
            let drive = format!("{}:\\", letter as char);
            if std::path::Path::new(&drive).exists() {
                entries.push(FileEntryOut {
                    name: format!("{}:", letter as char),
                    path: drive,
                    kind: "dir".into(),
                    size: 0,
                    modified: 0,
                    permissions: None,
                });
            }
        }
        return Ok(entries);
    }
    let p = resolve_local_path(path)?;
    if !p.exists() {
        return Err(format!("路径不存在: {}", p.display()));
    }
    if !p.is_dir() {
        return Err("不是目录".to_string());
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&p).map_err(|e| format!("读取目录失败: {e}"))? {
        let entry = match entry {
            Ok(e) => e,
            Err(e) => {
                tracing::warn!(error = %e, "跳过无法读取的目录项");
                continue;
            }
        };
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
        entries.push(FileEntryOut {
            name,
            path: full,
            kind: if is_dir { "dir".into() } else { "file".into() },
            size,
            modified,
            permissions,
        });
    }
    // 目录优先，然后按名称不区分大小写排序
    entries.sort_by(|a, b| {
        let ad = a.kind == "dir";
        let bd = b.kind == "dir";
        ad.cmp(&bd)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn local_read(path: &str, max_bytes: u64) -> Result<Vec<u8>, String> {
    let p = resolve_local_path(path)?;
    if p.is_dir() {
        return Err("无法预览目录".to_string());
    }
    if !p.exists() {
        return Err(format!("文件不存在: {}", p.display()));
    }
    let data = std::fs::read(&p).map_err(|e| format!("读取文件失败: {e}"))?;
    if data.len() as u64 > max_bytes {
        return Err(format!("文件超过大小限制 ({max_bytes} 字节)"));
    }
    Ok(data)
}

fn local_write(path: &str, data: &[u8], append: bool) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).ok();
        }
    }
    if append {
        use std::io::Write;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| format!("打开文件失败（append）: {e}"))?;
        f.write_all(data).map_err(|e| format!("追加写入失败: {e}"))?;
    } else {
        std::fs::write(path, data).map_err(|e| format!("写入文件失败: {e}"))?;
    }
    Ok(())
}

// ─── SFTP 路径辅助 ──────────────────────────────────────────────────────────

fn join_posix(base: &str, name: &str) -> String {
    if base == "/" || base.is_empty() {
        format!("/{name}")
    } else {
        format!("{}/{}", base.trim_end_matches('/'), name)
    }
}

fn sftp_remote_path(path: &str, cfg: &FileConnConfig) -> String {
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

fn sftp_entry_to_out(
    entry: &omnipanel_ssh::SftpEntry,
    base: &str,
) -> FileEntryOut {
    FileEntryOut {
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

// ─── 工具入口 ───────────────────────────────────────────────────────────────

/// 列出目录内容。
pub async fn list(args: Value, storage: Arc<Mutex<Storage>>) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let path = require_str(&args, "path")?;
    let search = optional_str(&args, "search");

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let mut entries = match target {
        FileTarget::Local => list_local_dir(&path)?,
        FileTarget::Sftp(session, cfg) => {
            let remote = sftp_remote_path(&path, &cfg);
            let list = with_timeout(session.sftp_list(&remote), FILES_OP_TIMEOUT_SECS)
                .await?;
            session.disconnect().await;
            list.iter().map(|e| sftp_entry_to_out(e, &remote)).collect()
        }
    };

    // 应用 search 过滤（与 src-tauri filter_file_entries 一致）
    if let Some(q) = search.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let lower = q.to_lowercase();
        entries.retain(|e| e.name.to_lowercase().contains(&lower));
    }

    let count = entries.len();
    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "path": path,
        "search": search,
        "count": count,
        "truncated": false,
        "entries": entries,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 读取文件文本内容。
pub async fn read(args: Value, storage: Arc<Mutex<Storage>>) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let path = require_str(&args, "path")?;
    let max_bytes = args
        .get("max_bytes")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .map(|n| (n as u64).min(MAX_READ_BYTES))
        .unwrap_or(DEFAULT_READ_MAX_BYTES);

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let bytes = match target {
        FileTarget::Local => local_read(&path, max_bytes)?,
        FileTarget::Sftp(session, cfg) => {
            let remote = sftp_remote_path(&path, &cfg);
            let result = with_timeout(session.sftp_download(&remote), FILES_OP_TIMEOUT_SECS).await;
            session.disconnect().await;
            let bytes = result?;
            if bytes.len() as u64 > max_bytes {
                return Err(format!("文件超过大小限制 ({max_bytes} 字节)"));
            }
            bytes
        }
    };

    // 字节 → UTF-8 字符串（无效字节替换为 U+FFFD）
    let content = String::from_utf8_lossy(&bytes).into_owned();
    let actual_bytes = bytes.len();
    let truncated = actual_bytes as u64 >= max_bytes;

    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "path": path,
        "maxBytes": max_bytes,
        "actualBytes": actual_bytes,
        "truncated": truncated,
        "content": content,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 写入文本内容到文件。
pub async fn write(args: Value, storage: Arc<Mutex<Storage>>) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let path = require_str(&args, "path")?;
    let content = require_str(&args, "content")?;
    let append = args.get("append").and_then(|v| v.as_bool()).unwrap_or(false);
    let data = content.into_bytes();

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let bytes_written = data.len();
    match target {
        FileTarget::Local => local_write(&path, &data, append)?,
        FileTarget::Sftp(session, cfg) => {
            let remote = sftp_remote_path(&path, &cfg);
            // SFTP 追加：先下载旧内容到内存，拼接后覆盖上传
            let to_upload = if append {
                let existing = match session.sftp_download(&remote).await {
                    Ok(b) => b,
                    Err(_) => Vec::new(), // 文件不存在
                };
                let mut combined = existing;
                combined.extend_from_slice(&data);
                combined
            } else {
                data
            };
            let result = with_timeout(session.sftp_upload(&remote, &to_upload), FILES_OP_TIMEOUT_SECS).await;
            session.disconnect().await;
            result?;
        }
    }

    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "path": path,
        "append": append,
        "bytesWritten": bytes_written,
        "applied": true,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 按文件名子串搜索（仅当前目录一层）。
pub async fn search(args: Value, storage: Arc<Mutex<Storage>>) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let query = require_str(&args, "query")?;
    let path = optional_str(&args, "path").unwrap_or_default();

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let mut entries = match target {
        FileTarget::Local => list_local_dir(&path)?,
        FileTarget::Sftp(session, cfg) => {
            let remote = sftp_remote_path(&path, &cfg);
            let list = with_timeout(session.sftp_list(&remote), FILES_OP_TIMEOUT_SECS).await?;
            session.disconnect().await;
            list.iter().map(|e| sftp_entry_to_out(e, &remote)).collect()
        }
    };

    let lower = query.to_lowercase();
    entries.retain(|e| e.name.to_lowercase().contains(&lower));

    let count = entries.len();
    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "query": query,
        "path": path,
        "count": count,
        "truncated": false,
        "results": entries,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 包装 future 加超时，统一错误转换为 String。
async fn with_timeout<F, T>(fut: F, secs: u64) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, OmniError>>,
{
    tokio::time::timeout(Duration::from_secs(secs), fut)
        .await
        .map_err(|_| format!("Files 操作超时（{secs}s）"))?
        .map_err(|e| e.user_message().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_of_infers_from_fields() {
        let mut cfg = FileConnConfig::default();
        cfg.protocol = "s3".into();
        assert_eq!(protocol_of(&cfg), FileProtocol::S3);

        cfg.protocol = "".into();
        cfg.bucket = "b".into();
        assert_eq!(protocol_of(&cfg), FileProtocol::S3);

        cfg.bucket = "".into();
        cfg.host = "h".into();
        assert_eq!(protocol_of(&cfg), FileProtocol::Sftp);

        cfg.host = "".into();
        assert_eq!(protocol_of(&cfg), FileProtocol::Local);
    }

    #[test]
    fn sftp_remote_path_uses_root_path_when_empty() {
        let mut cfg = FileConnConfig::default();
        cfg.root_path = "/data".into();
        assert_eq!(sftp_remote_path("", &cfg), "/data");
        assert_eq!(sftp_remote_path("/etc", &cfg), "/etc");
    }

    #[test]
    fn join_posix_handles_root_base() {
        assert_eq!(join_posix("/", "foo"), "/foo");
        assert_eq!(join_posix("", "foo"), "/foo");
        assert_eq!(join_posix("/var", "log"), "/var/log");
        assert_eq!(join_posix("/var/", "log"), "/var/log");
    }
}
