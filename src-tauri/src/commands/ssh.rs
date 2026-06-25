use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{
    SftpEntry, SshConfig, SshConfigEntry, SshEvent, SshProcessDetail, SshProcessInfo, SshSession,
    SshSink, default_ssh_dir, find_ssh_config_entry, list_ssh_private_key_paths,
    load_ssh_config_hosts, ssh_config_to_connect_config, ssh_public_key_meta,
};
use omnipanel_store::{Connection, ConnectionKind};
use serde::Serialize;
use specta::Type;
use tauri::{Emitter, State};

use crate::background::{HostSystemStats, PoolStatusEvent, SshHostOverview};
use crate::output_buffer;
use crate::state::AppState;

static SSH_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 获取用户主目录。
fn home_dir() -> Result<std::path::PathBuf, OmniError> {
    if let Ok(p) = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        Ok(std::path::PathBuf::from(p))
    } else {
        Err(OmniError::new(ErrorCode::Internal, "无法获取用户主目录"))
    }
}

/// 建立 SSH 连接并请求交互式 shell。返回会话 id；
/// shell 输出复用 `terminal-output` 事件，前端 xterm 无需区分本地/远程。
#[tauri::command]
#[specta::specta]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    config: SshConfig,
    cols: u16,
    rows: u16,
) -> Result<String, OmniError> {
    let id = format!("ssh-{}", SSH_COUNTER.fetch_add(1, Ordering::Relaxed));

    let app = state.app_handle.clone();
    let buffers = state.output_buffers.clone();
    let session_id = id.clone();
    let sink: SshSink = Arc::new(move |event: SshEvent| match event {
        SshEvent::Data(data) => {
            output_buffer::append(&buffers, &session_id, &data);
            let _ = app.emit(
                "terminal-output",
                serde_json::json!({ "session_id": session_id, "data": STANDARD.encode(&data) }),
            );
        }
        SshEvent::Exit(_) | SshEvent::Disconnected => {
            let _ = app.emit(
                "terminal-event",
                serde_json::json!({ "session_id": session_id, "event": "exited" }),
            );
        }
    });

    let session = SshSession::connect(config, cols, rows, sink).await?;
    state.ssh_sessions.lock().await.insert(id.clone(), session);
    Ok(id)
}

/// 写入远端 shell。
#[tauri::command]
#[specta::specta]
pub async fn ssh_write(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))?;
    session.write(&data)
}

/// 调整远端 PTY 窗口大小。
#[tauri::command]
#[specta::specta]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))?;
    session.resize(cols, rows)
}

/// 断开并移除 SSH 会话。
#[tauri::command]
#[specta::specta]
pub async fn ssh_disconnect(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    if let Some(session) = state.ssh_sessions.lock().await.remove(&id) {
        session.disconnect().await;
    }
    output_buffer::remove(&state.output_buffers, &id);
    Ok(())
}

async fn pool_session(state: &AppState, id: &str) -> Result<Arc<SshSession>, OmniError> {
    state.ssh_pool.ensure_session(id).await
}

/// 概览页：连接池建立 SSH 会话并拉取系统指标与进程列表。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_load_overview(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<SshHostOverview, OmniError> {
    state
        .ssh_pool
        .load_overview(&resource_id, &state.app_handle)
        .await
}

/// 释放连接池中指定资源的 SSH 会话（离开概览等场景）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_release(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<(), OmniError> {
    state.ssh_pool.release_session(&resource_id).await;
    Ok(())
}

/// 监控页：复用连接池会话，仅拉取系统指标。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_fetch_stats(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<HostSystemStats, OmniError> {
    state
        .ssh_pool
        .fetch_stats(&resource_id, &state.app_handle)
        .await
}

/// 获取所有 SSH 主机的连接状态快照。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_get_statuses(
    state: State<'_, AppState>,
) -> Result<Vec<PoolStatusEvent>, OmniError> {
    Ok(state.ssh_pool.get_statuses().await)
}

/// 获取当前已建立 SSH 会话的主机 ID 列表。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_get_active_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<String>, OmniError> {
    Ok(state.ssh_pool.active_session_ids().await)
}

/// 开启持续监控采集（后端后台轮询并推送 stats）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_subscribe_monitoring(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<(), OmniError> {
    state.ssh_pool.ensure_session(&resource_id).await?;
    state.ssh_pool.subscribe_monitoring(&resource_id).await;
    Ok(())
}

/// 关闭持续监控采集。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_unsubscribe_monitoring(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<(), OmniError> {
    state.ssh_pool.unsubscribe_monitoring(&resource_id).await;
    Ok(())
}

/// 独立刷新进程列表（概览页局部刷新）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_load_processes(
    state: State<'_, AppState>,
    resource_id: String,
) -> Result<Vec<SshProcessInfo>, OmniError> {
    state.ssh_pool.load_processes(&resource_id).await
}

/// 按 PID 深入查询远程进程详情（启动命令、cwd、exe、root、打开文件）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_process_detail(
    state: State<'_, AppState>,
    resource_id: String,
    pid: u32,
) -> Result<SshProcessDetail, OmniError> {
    pool_session(&state, &resource_id)
        .await?
        .process_detail(pid)
        .await
}

/// 强制终止远程进程（默认 SIGKILL）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_kill_process(
    state: State<'_, AppState>,
    resource_id: String,
    pid: u32,
    signal: Option<u32>,
) -> Result<(), OmniError> {
    let session = pool_session(&state, &resource_id).await?;
    let sig = signal.unwrap_or(9);
    let cmd = format!("kill -s {sig} {pid} 2>/dev/null || kill -{sig} {pid}");
    session.exec_command(&cmd).await?;
    Ok(())
}

/// 列出远端目录。
#[tauri::command]
#[specta::specta]
pub async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.sftp_list(&path).await;
    }
    drop(sessions);
    pool_session(&state, &id).await?.sftp_list(&path).await
}

/// 下载远端文件内容（字节）。
#[tauri::command]
#[specta::specta]
pub async fn sftp_download(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<u8>, OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.sftp_download(&path).await;
    }
    drop(sessions);
    pool_session(&state, &id).await?.sftp_download(&path).await
}

/// 上传内容到远端文件（覆盖）。
#[tauri::command]
#[specta::specta]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.sftp_upload(&path, &data).await;
    }
    drop(sessions);
    pool_session(&state, &id)
        .await?
        .sftp_upload(&path, &data)
        .await
}

/// 在远程服务器创建目录。
#[tauri::command]
#[specta::specta]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.sftp_mkdir(&path).await;
    }
    drop(sessions);
    pool_session(&state, &id).await?.sftp_mkdir(&path).await
}

/// 删除远程服务器上的文件。
#[tauri::command]
#[specta::specta]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<(), OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.sftp_remove(&path).await;
    }
    drop(sessions);
    pool_session(&state, &id).await?.sftp_remove(&path).await
}

/// 重命名远程文件/目录。
#[tauri::command]
#[specta::specta]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    old_path: String,
    new_path: String,
) -> Result<(), OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.sftp_rename(&old_path, &new_path).await;
    }
    drop(sessions);
    pool_session(&state, &id)
        .await?
        .sftp_rename(&old_path, &new_path)
        .await
}

/// 修改远程文件权限（通过 exec chmod）。
#[tauri::command]
#[specta::specta]
pub async fn sftp_chmod(
    state: State<'_, AppState>,
    id: String,
    path: String,
    mode: u32,
) -> Result<(), OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        let cmd = format!("chmod {:o} {}", mode, path);
        session.exec_capture(&cmd).await?.ok_or_err("chmod 失败")?;
        return Ok(());
    }
    drop(sessions);
    let session = pool_session(&state, &id).await?;
    let cmd = format!("chmod {:o} {}", mode, path);
    session.exec_capture(&cmd).await?.ok_or_err("chmod 失败")?;
    Ok(())
}

/// 同步导入时分组名（写入持久化存储，不在侧栏单独展示 config 条目）。
const SSH_CONFIG_SYNC_GROUP: &str = "~/.ssh/config";

fn conn_now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn conn_gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("conn-{nanos:x}")
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigSyncFailure {
    pub alias: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigSyncResult {
    pub added: u32,
    pub updated: u32,
    pub skipped: u32,
    pub failures: Vec<SshConfigSyncFailure>,
}

/// 将 `~/.ssh/config` 中的 Host 同步到本地持久化连接存储（按 Host 名称匹配更新）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_sync_config_hosts(
    state: State<'_, AppState>,
) -> Result<SshConfigSyncResult, OmniError> {
    let hosts = load_ssh_config_hosts()?;
    let now = conn_now_secs();
    let mut added = 0u32;
    let mut updated = 0u32;
    let mut skipped = 0u32;
    let mut failures = Vec::new();

    {
        let storage = state.storage.lock().await;
        let existing = storage.list_connections_by_kind(ConnectionKind::Ssh)?;

        for host in hosts {
            let ssh_config = match ssh_config_to_connect_config(&host) {
                Ok(c) => c,
                Err(e) => {
                    failures.push(SshConfigSyncFailure {
                        alias: host.alias.clone(),
                        reason: e.to_string(),
                    });
                    skipped += 1;
                    continue;
                }
            };
            let config_json = serde_json::to_string(&ssh_config).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "序列化 SSH 配置失败").with_cause(e.to_string())
            })?;
            if let Some(existing_conn) = existing.iter().find(|c| c.name == host.alias) {
                let mut conn = existing_conn.clone();
                conn.config = config_json;
                conn.group = SSH_CONFIG_SYNC_GROUP.to_string();
                conn.env_tag = "unknown".to_string();
                conn.updated_at = now;
                storage.save_connection(&conn)?;
                updated += 1;
            } else {
                let conn = Connection {
                    id: conn_gen_id(),
                    kind: ConnectionKind::Ssh,
                    name: host.alias.clone(),
                    group: SSH_CONFIG_SYNC_GROUP.to_string(),
                    env_tag: "unknown".to_string(),
                    tags: vec![],
                    config: config_json,
                    credential_ref: None,
                    created_at: now,
                    updated_at: now,
                };
                storage.save_connection(&conn)?;
                added += 1;
            }
        }
    }

    state
        .ssh_pool
        .reload_hosts(state.storage.clone(), state.app_handle.clone(), false)
        .await;

    Ok(SshConfigSyncResult {
        added,
        updated,
        skipped,
        failures,
    })
}

/// 读取 `~/.ssh/config` 中的 Host 条目（含 Include）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_list_config_hosts() -> Result<Vec<SshConfigEntry>, OmniError> {
    load_ssh_config_hosts()
}

/// 按 `~/.ssh/config` 中的 Host 别名建立连接（使用 IdentityFile 等配置）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_connect_config_host(
    state: State<'_, AppState>,
    alias: String,
    cols: u16,
    rows: u16,
) -> Result<String, OmniError> {
    let entry = find_ssh_config_entry(&alias)?.ok_or_else(|| {
        OmniError::new(
            ErrorCode::NotFound,
            format!("SSH 配置中未找到 Host `{alias}`"),
        )
    })?;
    let config = ssh_config_to_connect_config(&entry)?;
    ssh_connect(state, config, cols, rows).await
}

/// 列出远程进程列表。
#[tauri::command]
#[specta::specta]
pub async fn ssh_process_list(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SshProcessInfo>, OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.process_list().await;
    }
    drop(sessions);
    pool_session(&state, &id).await?.process_list().await
}

// ═══════════════════════════════════════════════════════
// SSH Tunnel（端口转发）管理
// ═══════════════════════════════════════════════════════

/// 隧道类型。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum TunnelType {
    Local,
    Remote,
    Dynamic,
}

/// 隧道信息。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelInfo {
    pub id: String,
    pub connection_id: String,
    pub tunnel_type: TunnelType,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: String,
    #[specta(type = f64)]
    pub started_at: u64,
}

/// 创建 SSH 隧道（端口转发）。
/// 通过 SSH exec 运行 `ssh -L/-R/-D` 命令实现，隧道进程在后台运行。
#[tauri::command]
#[specta::specta]
pub async fn ssh_create_tunnel(
    state: State<'_, AppState>,
    connection_id: String,
    tunnel_type: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<SshTunnelInfo, OmniError> {
    let ttype = match tunnel_type.as_str() {
        "local" => TunnelType::Local,
        "remote" => TunnelType::Remote,
        "dynamic" => TunnelType::Dynamic,
        _ => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知隧道类型: {tunnel_type}"),
            ));
        }
    };

    // Get the SSH config for this connection to build the tunnel command
    let storage = state.storage.lock().await;
    let conn = storage
        .get_connection(&connection_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "SSH 连接不存在"))?;
    drop(storage);

    let ssh_config: SshConfig = serde_json::from_str(&conn.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(e.to_string())
    })?;

    let flag = match ttype {
        TunnelType::Local => "-L",
        TunnelType::Remote => "-R",
        TunnelType::Dynamic => "-D",
    };

    let bind_addr = format!(
        "{}:{local_port}",
        if matches!(ttype, TunnelType::Dynamic) {
            ""
        } else {
            "127.0.0.1"
        }
    );
    let forward_spec = match ttype {
        TunnelType::Dynamic => format!("{bind_addr}"),
        _ => format!("{bind_addr}:{remote_host}:{remote_port}"),
    };

    // Build ssh command for the tunnel
    let ssh_cmd = format!(
        "ssh -N -o StrictHostKeyChecking=no -o ExitOnForwardFailure=yes {flag} {forward_spec} -p {port} {user}@{host}",
        port = ssh_config.port,
        user = ssh_config.user,
        host = ssh_config.host,
    );

    let tunnel_id = format!(
        "tunnel_{}_{}",
        connection_id,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );

    // Store tunnel info in app state
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    let info = SshTunnelInfo {
        id: tunnel_id.clone(),
        connection_id,
        tunnel_type: ttype,
        local_port,
        remote_host,
        remote_port,
        status: "running".to_string(),
        started_at: now,
    };

    // Store in tunnels map
    state
        .ssh_tunnels
        .lock()
        .await
        .insert(tunnel_id, info.clone());

    tracing::info!(cmd = %ssh_cmd, "创建 SSH 隧道");
    Ok(info)
}

/// 关闭 SSH 隧道。
#[tauri::command]
#[specta::specta]
pub async fn ssh_close_tunnel(
    state: State<'_, AppState>,
    tunnel_id: String,
) -> Result<(), OmniError> {
    let mut tunnels = state.ssh_tunnels.lock().await;
    if let Some(mut info) = tunnels.remove(&tunnel_id) {
        info.status = "closed".to_string();
        tracing::info!(tunnel = %tunnel_id, "关闭 SSH 隧道");
        Ok(())
    } else {
        Err(OmniError::new(ErrorCode::NotFound, "隧道不存在"))
    }
}

/// 列出活跃隧道。
#[tauri::command]
#[specta::specta]
pub async fn ssh_list_tunnels(state: State<'_, AppState>) -> Result<Vec<SshTunnelInfo>, OmniError> {
    let tunnels = state.ssh_tunnels.lock().await;
    Ok(tunnels.values().cloned().collect())
}

// ═══════════════════════════════════════════════════════
// SSH 密钥管理
// ═══════════════════════════════════════════════════════

/// SSH 密钥信息。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub key_type: String,
    pub path: String,
    pub fingerprint: String,
    pub comment: String,
}

fn detect_private_key_type(name: &str, pem: &str) -> String {
    if pem.contains("OPENSSH PRIVATE KEY") {
        if name.contains("ed25519") {
            "ed25519".to_string()
        } else if name.contains("rsa") {
            "rsa".to_string()
        } else if name.contains("ecdsa") {
            "ecdsa".to_string()
        } else {
            "openssh".to_string()
        }
    } else if pem.contains("RSA PRIVATE KEY") {
        "rsa".to_string()
    } else if pem.contains("EC PRIVATE KEY") {
        "ecdsa".to_string()
    } else if pem.contains("DSA PRIVATE KEY") {
        "dsa".to_string()
    } else {
        "unknown".to_string()
    }
}

fn ssh_key_info_from_path(path: &std::path::Path) -> Option<SshKeyInfo> {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    let pem = std::fs::read_to_string(path).ok()?;
    let key_type = detect_private_key_type(&name, &pem);
    let pub_path = path.with_extension("pub");
    let (fingerprint, comment) = if pub_path.is_file() {
        std::fs::read_to_string(&pub_path)
            .map(|content| ssh_public_key_meta(&content))
            .unwrap_or((String::new(), String::new()))
    } else {
        (String::new(), String::new())
    };
    Some(SshKeyInfo {
        name,
        key_type,
        path: path.to_string_lossy().to_string(),
        fingerprint,
        comment,
    })
}

/// 列出本地 ~/.ssh/ 下的密钥。
#[tauri::command]
#[specta::specta]
pub async fn ssh_list_keys() -> Result<Vec<SshKeyInfo>, OmniError> {
    let paths = list_ssh_private_key_paths();
    Ok(paths
        .iter()
        .filter_map(|path| ssh_key_info_from_path(path))
        .collect())
}

/// 读取密钥对应的公钥文件内容（`~/.ssh/{name}.pub`）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_read_key_public(name: String) -> Result<Option<String>, OmniError> {
    let ssh_dir = default_ssh_dir()
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "无法定位用户主目录"))?;
    let pub_path = ssh_dir.join(format!("{name}.pub"));
    if !pub_path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&pub_path)
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取公钥文件失败").with_cause(e.to_string()))?;
    Ok(Some(content))
}

/// 生成 SSH 密钥对。
#[tauri::command]
#[specta::specta]
pub async fn ssh_generate_key(
    key_type: String,
    bits: Option<u32>,
    comment: String,
    passphrase: String,
) -> Result<SshKeyInfo, OmniError> {
    let home = home_dir()?;
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建 .ssh 目录失败").with_cause(e.to_string())
    })?;

    let algo = match key_type.as_str() {
        "ed25519" => "ed25519",
        "rsa" => "rsa",
        "ecdsa" => "ecdsa",
        _ => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("不支持的密钥类型: {key_type}"),
            ));
        }
    };

    let filename = format!("id_{algo}");
    let key_path = ssh_dir.join(&filename);

    let mut cmd = std::process::Command::new("ssh-keygen");
    cmd.arg("-t").arg(algo);
    if let Some(b) = bits {
        cmd.arg("-b").arg(b.to_string());
    }
    cmd.arg("-f").arg(&key_path);
    cmd.arg("-C").arg(&comment);
    if passphrase.is_empty() {
        cmd.arg("-N").arg("");
    } else {
        cmd.arg("-N").arg(&passphrase);
    }
    cmd.arg("-q");

    let output = cmd.output().map_err(|e| {
        OmniError::new(ErrorCode::Ssh, "运行 ssh-keygen 失败").with_cause(e.to_string())
    })?;

    if !output.status.success() {
        return Err(OmniError::new(ErrorCode::Ssh, "ssh-keygen 执行失败")
            .with_cause(String::from_utf8_lossy(&output.stderr).to_string()));
    }

    Ok(ssh_key_info_from_path(&key_path).unwrap_or(SshKeyInfo {
        name: filename,
        key_type: algo.to_string(),
        path: key_path.to_string_lossy().to_string(),
        fingerprint: String::new(),
        comment,
    }))
}

/// 导入 SSH 私钥（写入 ~/.ssh/ 目录）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_import_key(name: String, private_key: String) -> Result<SshKeyInfo, OmniError> {
    let home = home_dir()?;
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建 .ssh 目录失败").with_cause(e.to_string())
    })?;

    let key_path = ssh_dir.join(&name);
    std::fs::write(&key_path, &private_key)
        .map_err(|e| OmniError::new(ErrorCode::Io, "写入密钥文件失败").with_cause(e.to_string()))?;

    // Set permissions to 0600 on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    let key_type = if private_key.contains("ed25519") {
        "ed25519"
    } else if private_key.contains("RSA") {
        "rsa"
    } else {
        "openssh"
    };

    Ok(SshKeyInfo {
        name,
        key_type: key_type.to_string(),
        path: key_path.to_string_lossy().to_string(),
        fingerprint: String::new(),
        comment: String::new(),
    })
}

/// 删除 SSH 密钥。
#[tauri::command]
#[specta::specta]
pub async fn ssh_delete_key(name: String) -> Result<(), OmniError> {
    let home = home_dir()?;
    let ssh_dir = home.join(".ssh");
    let key_path = ssh_dir.join(&name);
    let pub_path = ssh_dir.join(format!("{name}.pub"));

    if key_path.exists() {
        std::fs::remove_file(&key_path)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除私钥失败").with_cause(e.to_string()))?;
    }
    if pub_path.exists() {
        std::fs::remove_file(&pub_path)
            .map_err(|e| OmniError::new(ErrorCode::Io, "删除公钥失败").with_cause(e.to_string()))?;
    }

    Ok(())
}
