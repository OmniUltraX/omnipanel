use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{
    SftpEntry, StreamChunk, SshAuth, SshConfig, SshConfigEntry, SshEvent, SshProcessDetail,
    SshProcessInfo, SshSession, SshSink, default_ssh_dir, find_ssh_config_entry,
    is_private_key_pem_content, list_ssh_private_key_paths, load_ssh_config_hosts,
    ssh_config_from_json, ssh_config_to_connect_config, ssh_public_key_meta,
};
use omnipanel_store::{
    inject_ssh_vault_into_config, AuditEntry, Connection, ConnectionKind, Vault,
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::background::{HostSystemStats, PoolStatusEvent, SshHostOverview};
use crate::output_buffer;
use crate::ssh_tmux::{host_identity, AttachOutcome, SshTerminalInfo};
use crate::state::AppState;
use omnipanel_ssh::tmux::{self, TmuxSessionInfo};

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

    // 读取 tmux 偏好：auto（默认，探测可用就用）/ always（强制，不可用报错）/ never（直连）
    let tmux_mode = state
        .terminal_tmux_mode
        .lock()
        .map(|m| m.clone())
        .unwrap_or_else(|_| "auto".to_string());

    if tmux_mode == "never" {
        // 用户明确要求直连，跳过 tmux
        return connect_direct(&state, config, cols, rows, id, Some("disabled_by_user".to_string())).await;
    }

    // 优先走 tmux：同主机复用一条连接，且会话可跨应用重启存活。
    // always 模式下不降级；auto 模式下任何不支持或失败都静默降级为直连。
    let fallback_reason = match state
        .tmux
        .attach(
            &state.app_handle,
            &state.output_buffers,
            &config,
            &id,
            cols,
            rows,
        )
        .await
    {
        Ok(AttachOutcome::Attached { .. }) => return Ok(id),
        Ok(AttachOutcome::Unsupported(reason)) => {
            if tmux_mode == "always" {
                return Err(OmniError::new(
                    ErrorCode::Internal,
                    format!("已设置为强制 tmux 模式，但远端不支持：{reason}"),
                ));
            }
            Some(reason)
        }
        Err(err) => {
            tracing::warn!(target: "tmux", "tmux 接入失败，降级直连: {err}");
            if tmux_mode == "always" {
                return Err(OmniError::new(
                    ErrorCode::Internal,
                    format!("已设置为强制 tmux 模式，但接入失败：{}", err.user_message()),
                ));
            }
            Some(err.user_message())
        }
    };

    connect_direct(&state, config, cols, rows, id, fallback_reason).await
}

/// 同步终端 tmux 模式偏好到后端（auto / always / never）。
#[tauri::command]
#[specta::specta]
pub async fn set_terminal_tmux_mode(
    state: State<'_, AppState>,
    mode: String,
) -> Result<(), OmniError> {
    let mode = mode.trim().to_lowercase();
    let mode = match mode.as_str() {
        "auto" | "always" | "never" => mode,
        _ => "auto".to_string(),
    };
    if let Ok(mut guard) = state.terminal_tmux_mode.lock() {
        *guard = mode;
    }
    Ok(())
}

/// 清除 tmux unsupported 缓存，让下次开终端 Tab 时重新探测远端 tmux。
///
/// 用户在能力治理 Tab 安装/升级 tmux 后，或从「始终直连」切回「自动」时调用。
#[tauri::command]
#[specta::specta]
pub async fn invalidate_tmux_cache(state: State<'_, AppState>) -> Result<(), OmniError> {
    state.tmux.invalidate_all().await;
    Ok(())
}

/// 建立一 Tab 一连接的直连 shell（tmux 不可用时的回退路径）。
async fn connect_direct(
    state: &AppState,
    config: SshConfig,
    cols: u16,
    rows: u16,
    id: String,
    fallback_reason: Option<String>,
) -> Result<String, OmniError> {
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

    let host = host_identity(&config);
    let session = SshSession::connect(config, cols, rows, sink).await?;
    state.ssh_sessions.lock().await.insert(id.clone(), session);
    state.tmux.record_direct(&id, host, fallback_reason).await;
    Ok(id)
}

fn resolve_connection_secret(conn: &Connection) -> Option<String> {
    Vault::get(&crate::commands::connection::ssh_credential_ref(&conn.id))
        .ok()
        .or_else(|| {
            conn.credential_ref
                .as_deref()
                .and_then(|r| Vault::get(r).ok())
        })
}

/// 按已保存的连接 id 建立 SSH 会话（尊重 `auth.type`，密码认证不走私钥）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_connect_connection(
    state: State<'_, AppState>,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, OmniError> {
    let storage = state.storage.lock().await;
    let conn = storage
        .get_connection(&connection_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "SSH 连接不存在"))?;
    if conn.kind != ConnectionKind::Ssh {
        return Err(OmniError::new(ErrorCode::InvalidInput, "连接不是 SSH 类型"));
    }
    let config = crate::commands::connection::resolve_ssh_config(&conn)?;
    drop(storage);
    ssh_connect(state, config, cols, rows).await
}

/// 写入远端 shell。
#[tauri::command]
#[specta::specta]
pub async fn ssh_write(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), OmniError> {
    if let Some(result) = state.tmux.write(&id, &data).await {
        return result;
    }
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
    if let Some(result) = state.tmux.resize(&id, cols, rows).await {
        return result;
    }
    let sessions = state.ssh_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))?;
    session.resize(cols, rows)
}

/// 断开并移除 SSH 会话。
///
/// tmux 模式下只关闭该 Tab 对应的 window：同主机其他 Tab 与远端 tmux 会话不受影响。
#[tauri::command]
#[specta::specta]
pub async fn ssh_disconnect(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    if !state.tmux.close(&id).await {
        if let Some(session) = state.ssh_sessions.lock().await.remove(&id) {
            session.disconnect().await;
        }
        state.tmux.forget_direct(&id).await;
    }
    output_buffer::remove(&state.output_buffers, &id);
    Ok(())
}

/// 查询远程终端当前的传输模式（tmux / 直连）与相关元信息。
#[tauri::command]
#[specta::specta]
pub async fn ssh_terminal_info(
    state: State<'_, AppState>,
    id: String,
) -> Result<SshTerminalInfo, OmniError> {
    state
        .tmux
        .info(&id)
        .await
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))
}

/// 逃生阀：把单个 Tab 从 tmux 切换为直连。
///
/// 远端 window 保留（其中的进程继续运行），本地改用独立连接；会话 id 不变，
/// 因此前端无需重建 Tab，输出流自动衔接。同主机其余 Tab 仍走 tmux。
#[tauri::command]
#[specta::specta]
pub async fn ssh_terminal_set_direct_mode(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), OmniError> {
    let config = state.tmux.config_of(&id).await.ok_or_else(|| {
        OmniError::new(ErrorCode::NotFound, format!("会话 {id} 不在 tmux 模式"))
    })?;
    state.tmux.detach(&id).await;
    connect_direct(
        &state,
        config,
        cols,
        rows,
        id,
        Some("用户手动切换为直连模式".to_string()),
    )
    .await?;
    Ok(())
}

/// 抓取 tmux pane 内容用于重开 Tab 时恢复屏幕（替代直连模式的 scrollback 快照）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_tmux_capture_pane(
    state: State<'_, AppState>,
    id: String,
    history_lines: u32,
) -> Result<String, OmniError> {
    let data = state.tmux.capture_pane(&id, history_lines).await?;
    Ok(STANDARD.encode(&data))
}

/// 列出连接对应主机上的远端 tmux 会话（含非本应用创建的）。
///
/// 走 exec 通道而非 control mode：即便当前没有打开任何终端，也能查看与治理
/// 遗留在远端的会话。
#[tauri::command]
#[specta::specta]
pub async fn ssh_tmux_list_sessions(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<TmuxSessionInfo>, OmniError> {
    let session = state.ssh_pool.ensure_session(&connection_id).await?;
    let out = session.exec_capture(&tmux::list_sessions_shell()).await?;
    // 无 tmux server 时以非 0 退出并打印 "no server running"，按空列表处理
    if out.exit_code != 0 {
        return Ok(Vec::new());
    }
    Ok(out
        .stdout
        .lines()
        .filter_map(|line| tmux::parse_session_line(line.as_bytes()))
        .collect())
}

/// 终止远端 tmux 会话，其中的全部窗口与进程都会被杀掉。
///
/// 该操作不可撤销且会波及其他客户端的会话，因此无论成败都写入审计日志。
#[tauri::command]
#[specta::specta]
pub async fn ssh_tmux_kill_session(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<(), OmniError> {
    let session = state.ssh_pool.ensure_session(&connection_id).await?;
    let result = session
        .exec_capture(&tmux::kill_session_shell(&name))
        .await
        .and_then(|out| out.ok_or_err("终止 tmux 会话失败"));

    let env_tag = {
        let storage = state.storage.lock().await;
        storage
            .get_connection(&connection_id)
            .ok()
            .flatten()
            .map(|c| c.env_tag)
            .unwrap_or_else(|| "unknown".to_string())
    };
    let (status, detail) = match &result {
        Ok(_) => ("success".to_string(), format!("session={name}")),
        Err(e) => ("failed".to_string(), format!("error={}", e.message)),
    };
    let entry = AuditEntry {
        ts: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default(),
        action: "ssh.tmux.kill_session".to_string(),
        target: format!("{connection_id}:{name}"),
        // 终止会话会杀掉其中全部进程，生产环境按高风险记账
        risk: if env_tag == "prod" { "high" } else { "medium" }.to_string(),
        env_tag,
        status,
        detail,
    };
    {
        let storage = state.storage.lock().await;
        let _ = storage.append_audit(&entry);
    }

    result.map(|_| ())
}

pub(crate) async fn pool_session(state: &AppState, id: &str) -> Result<Arc<SshSession>, OmniError> {
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

/// 非交互执行远程命令（连接池 exec channel）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_exec_command(
    state: State<'_, AppState>,
    resource_id: String,
    command: String,
) -> Result<SshExecOutput, OmniError> {
    let session = pool_session(&state, &resource_id).await?;
    let output = session.exec_capture(&command).await?;
    Ok(SshExecOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
    })
}

/// 在远端 `~/.omnipanel/scripts/<name>` 创建脚本并执行。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshCreateRunScriptOutput {
    pub remote_path: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_create_run_script(
    state: State<'_, AppState>,
    resource_id: String,
    name: String,
    content: String,
    args: Option<Vec<String>>,
    timeout_secs: Option<u64>,
) -> Result<SshCreateRunScriptOutput, OmniError> {
    let timeout = timeout_secs.unwrap_or(120).clamp(1, 600);
    let script_args = args.unwrap_or_default();
    let session = pool_session(&state, &resource_id).await?;
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(timeout),
        session.create_run_script(&name, &content, &script_args),
    )
    .await
    .map_err(|_| {
        OmniError::new(
            ErrorCode::Timeout,
            format!("创建/执行脚本超时（{timeout}s）"),
        )
    })??;
    Ok(SshCreateRunScriptOutput {
        remote_path: output.remote_path,
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
    })
}

/// 对所有 SSH 主机重新进行端口可达性探测。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_probe_all(state: State<'_, AppState>) -> Result<(), OmniError> {
    state.ssh_pool.probe_all(&state.app_handle).await;
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

fn media_preview_cache_path(
    app: &AppHandle,
    resource_id: &str,
    remote_path: &str,
    size: Option<u64>,
) -> Result<PathBuf, OmniError> {
    let root = app
        .path()
        .app_cache_dir()
        .map_err(|e| OmniError::new(ErrorCode::Io, "无法定位缓存目录").with_cause(e.to_string()))?
        .join("media-preview");
    std::fs::create_dir_all(&root).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建媒体预览缓存目录失败").with_cause(e.to_string())
    })?;

    let mut hasher = DefaultHasher::new();
    resource_id.hash(&mut hasher);
    remote_path.hash(&mut hasher);
    size.unwrap_or(0).hash(&mut hasher);
    let stem = format!("{:016x}", hasher.finish());
    let ext = Path::new(remote_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let safe: String = e
                .chars()
                .filter(|c| c.is_ascii_alphanumeric())
                .take(16)
                .collect();
            if safe.is_empty() {
                String::new()
            } else {
                format!(".{safe}")
            }
        })
        .unwrap_or_default();
    Ok(root.join(format!("{stem}{ext}")))
}

/// 将远端媒体流式缓存到本地，返回本地绝对路径（供 convertFileSrc 播放）。
/// `size` 参与缓存键：远端同路径文件变大/变小时自动失效。
#[tauri::command]
#[specta::specta]
pub async fn sftp_cache_for_preview(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
    size: Option<f64>,
) -> Result<String, OmniError> {
    let size_u64 = size.map(|n| n.max(0.0) as u64);
    let local = media_preview_cache_path(&app, &id, &path, size_u64)?;
    if local.is_file() {
        if let Some(expected) = size_u64 {
            if let Ok(meta) = std::fs::metadata(&local) {
                if meta.len() == expected {
                    return Ok(local.to_string_lossy().into_owned());
                }
            }
        } else {
            return Ok(local.to_string_lossy().into_owned());
        }
    }

    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        session.sftp_download_to_file(&path, &local).await?;
        return Ok(local.to_string_lossy().into_owned());
    }
    drop(sessions);
    pool_session(&state, &id)
        .await?
        .sftp_download_to_file(&path, &local)
        .await?;
    Ok(local.to_string_lossy().into_owned())
}

/// 远端媒体探测结果（不下载整文件）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SftpMediaProbe {
    pub duration_secs: Option<f64>,
    #[specta(type = Option<f64>)]
    pub size: Option<u64>,
    /// JPEG 封面的 data URL（无封面时为 null）
    pub poster_data_url: Option<String>,
}

/// 打开边下边播流后的句柄。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SftpMediaStream {
    pub url: String,
    pub token: String,
    #[specta(type = f64)]
    pub size: u64,
    pub mime: String,
}

fn parse_wav_duration_secs(bytes: &[u8]) -> Option<f64> {
    if bytes.len() < 44 {
        return None;
    }
    if &bytes[0..4] != b"RIFF" && &bytes[0..4] != b"RF64" {
        return None;
    }
    if &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut i = 12usize;
    let mut byte_rate: Option<u32> = None;
    let mut data_size: Option<u32> = None;
    while i + 8 <= bytes.len() {
        let id = &bytes[i..i + 4];
        let size = u32::from_le_bytes(bytes[i + 4..i + 8].try_into().ok()?);
        let payload = i + 8;
        if id == b"fmt " && payload + 16 <= bytes.len() {
            // byteRate @ +8 within fmt payload (PCM layout)
            byte_rate = Some(u32::from_le_bytes(
                bytes[payload + 8..payload + 12].try_into().ok()?,
            ));
        } else if id == b"data" {
            data_size = Some(size);
            break;
        }
        let step = 8u64 + u64::from(size) + (u64::from(size) & 1);
        i = i.checked_add(step as usize)?;
    }
    let rate = byte_rate.filter(|r| *r > 0)?;
    let data = data_size?;
    Some(f64::from(data) / f64::from(rate))
}

async fn probe_duration_ffprobe(
    session: &omnipanel_ssh::SshSession,
    path: &str,
) -> Option<f64> {
    let quoted = shell_single_quote(path);
    let cmd = format!(
        "ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 {quoted} 2>/dev/null"
    );
    let output = session.exec_capture(&cmd).await.ok()?;
    if output.exit_code != 0 {
        return None;
    }
    let text = output.stdout.trim();
    let secs: f64 = text.parse().ok()?;
    if secs.is_finite() && secs >= 0.0 {
        Some(secs)
    } else {
        None
    }
}

/// 远端抽一帧封面，经 base64 回传为 data URL（无 ffmpeg 时返回 None）。
async fn probe_poster_data_url(
    session: &omnipanel_ssh::SshSession,
    path: &str,
) -> Option<String> {
    let lower = path.to_ascii_lowercase();
    let is_video = [".mp4", ".webm", ".m4v", ".mov", ".ogv"]
        .iter()
        .any(|ext| lower.ends_with(ext));
    if !is_video {
        return None;
    }
    let quoted = shell_single_quote(path);
    // 管道 base64，避免 exec_capture 的 lossy UTF-8 破坏二进制 JPEG
    let cmd = format!(
        "ffmpeg -v error -ss 1 -i {quoted} -frames:v 1 -f image2pipe -vcodec mjpeg - 2>/dev/null | base64 -w 0 2>/dev/null || ffmpeg -v error -ss 1 -i {quoted} -frames:v 1 -f image2pipe -vcodec mjpeg - 2>/dev/null | base64 2>/dev/null"
    );
    let output = session.exec_capture(&cmd).await.ok()?;
    if output.exit_code != 0 {
        return None;
    }
    let b64 = output.stdout.split_whitespace().collect::<String>();
    if b64.len() < 32 || b64.len() > 2_000_000 {
        return None;
    }
    if STANDARD.decode(&b64).is_err() {
        return None;
    }
    Some(format!("data:image/jpeg;base64,{b64}"))
}

fn path_looks_like_video(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    [".mp4", ".webm", ".m4v", ".mov", ".ogv"]
        .iter()
        .any(|ext| lower.ends_with(ext))
}

/// 探测远端媒体时长/大小/封面：不下载整文件。
#[tauri::command]
#[specta::specta]
pub async fn sftp_probe_media(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<SftpMediaProbe, OmniError> {
    let session = {
        let sessions = state.ssh_sessions.lock().await;
        if sessions.contains_key(&id) {
            None
        } else {
            drop(sessions);
            Some(pool_session(&state, &id).await?)
        }
    };

    let size = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(s) = sessions.get(&id) {
            s.sftp_file_size(&path).await
        } else {
            drop(sessions);
            session
                .as_ref()
                .ok_or_else(|| OmniError::new(ErrorCode::Ssh, "SSH 会话不存在"))?
                .sftp_file_size(&path)
                .await
        }
    };

    let mut duration_secs = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(s) = sessions.get(&id) {
            probe_duration_ffprobe(s, &path).await
        } else {
            drop(sessions);
            probe_duration_ffprobe(
                session
                    .as_ref()
                    .ok_or_else(|| OmniError::new(ErrorCode::Ssh, "SSH 会话不存在"))?
                    .as_ref(),
                &path,
            )
            .await
        }
    };

    if duration_secs.is_none() {
        let head = {
            let sessions = state.ssh_sessions.lock().await;
            if let Some(s) = sessions.get(&id) {
                s.sftp_read_range(&path, 0, 256 * 1024).await
            } else {
                drop(sessions);
                session
                    .as_ref()
                    .ok_or_else(|| OmniError::new(ErrorCode::Ssh, "SSH 会话不存在"))?
                    .sftp_read_range(&path, 0, 256 * 1024)
                    .await
            }
        }
        .ok();
        if let Some(bytes) = head {
            duration_secs = parse_wav_duration_secs(&bytes);
        }
    }

    let poster_data_url = if path_looks_like_video(&path) {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(s) = sessions.get(&id) {
            probe_poster_data_url(s, &path).await
        } else {
            drop(sessions);
            match session.as_ref() {
                Some(s) => probe_poster_data_url(s.as_ref(), &path).await,
                None => None,
            }
        }
    } else {
        None
    };

    Ok(SftpMediaProbe {
        duration_secs,
        size,
        poster_data_url,
    })
}

/// 注册本地 Range 代理令牌，返回可供 `<video>`/`<audio>` 边下边播的 URL。
#[tauri::command]
#[specta::specta]
pub async fn sftp_open_media_stream(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<SftpMediaStream, OmniError> {
    let size = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            session.sftp_file_size(&path).await
        } else {
            drop(sessions);
            pool_session(&state, &id).await?.sftp_file_size(&path).await
        }
    }
    .ok_or_else(|| OmniError::new(ErrorCode::Ssh, "无法获取远端文件大小"))?;

    if size == 0 {
        return Err(OmniError::new(ErrorCode::Ssh, "远端文件为空"));
    }

    let mime = crate::media_stream::guess_media_mime(&path).to_string();
    let entry = crate::media_stream::MediaStreamEntry {
        ssh_id: id,
        remote_path: path,
        size,
        mime: mime.clone(),
    };
    let token = state.media_stream.register(entry).await;
    let url = state.media_stream.url_for_token(&token);
    Ok(SftpMediaStream {
        url,
        token,
        size,
        mime,
    })
}

/// 关闭边下边播流令牌。
#[tauri::command]
#[specta::specta]
pub async fn sftp_close_media_stream(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), OmniError> {
    state.media_stream.unregister(&token).await;
    Ok(())
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

/// 仅允许从白名单 URL 本机下载二进制并经 SFTP 安装到远端（用于 my2sql 等）。
fn assert_allowed_binary_download_url(url: &str) -> Result<(), OmniError> {
    let ok = url.starts_with("https://raw.githubusercontent.com/liuhr/my2sql/")
        || url.starts_with("https://github.com/liuhr/my2sql/");
    if ok {
        Ok(())
    } else {
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "不允许从此 URL 下载远程安装包",
        ))
    }
}

/// 本机下载二进制并经 SFTP 安装到远端的内部实现（命令函数的薄包装底层）。
///
/// `url_whitelist` 为 true 时走 my2sql 白名单校验；false 时跳过（已由调用方校验）。
pub(crate) async fn download_install_binary_inner(
    state: &AppState,
    resource_id: &str,
    url: &str,
    remote_path: &str,
    url_whitelist: bool,
) -> Result<String, OmniError> {
    if url_whitelist {
        assert_allowed_binary_download_url(url)?;
    }
    let remote_path = remote_path.trim();
    if remote_path.is_empty() || remote_path.contains('\0') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "远程安装路径无效"));
    }

    let proxy_config = state.proxy_config.lock().await.clone();
    let client = crate::commands::proxy::build_http_client_for_url(
        url,
        &proxy_config,
        std::time::Duration::from_secs(120),
    )
    .map_err(|e| OmniError::new(ErrorCode::Connection, format!("创建下载客户端失败: {e}")))?;

    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Connection, format!("下载失败: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("下载失败，HTTP {}", response.status()),
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, format!("读取下载内容失败: {e}")))?;
    if bytes.len() < 1024 {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "下载内容过小，可能不是有效二进制",
        ));
    }

    let session = pool_session(state, resource_id).await?;

    let abs_path = if remote_path.starts_with("~/") || remote_path == "~" {
        let home = session.exec_capture("printf %s \"$HOME\"").await?;
        let home = home.stdout.trim();
        if home.is_empty() {
            return Err(OmniError::new(ErrorCode::Internal, "远端 HOME 为空"));
        }
        if remote_path == "~" {
            home.to_string()
        } else {
            format!("{}/{}", home.trim_end_matches('/'), &remote_path[2..])
        }
    } else {
        remote_path.to_string()
    };

    let parent = abs_path
        .rsplit_once('/')
        .map(|(p, _)| p)
        .filter(|p| !p.is_empty())
        .unwrap_or(".");
    let mkdir_cmd = format!("mkdir -p {}", shell_single_quote(parent));
    session
        .exec_capture(&mkdir_cmd)
        .await?
        .ok_or_err("创建远端目录失败")?;

    session.sftp_upload(&abs_path, &bytes).await?;

    let chmod_cmd = format!("chmod 755 {}", shell_single_quote(&abs_path));
    session
        .exec_capture(&chmod_cmd)
        .await?
        .ok_or_err("chmod 失败")?;

    Ok(abs_path)
}

/// 本机下载官方二进制，经 SSH/SFTP 安装到远端路径（默认用户目录，无需 sudo）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_download_install_binary(
    state: State<'_, AppState>,
    resource_id: String,
    url: String,
    remote_path: String,
) -> Result<String, OmniError> {
    download_install_binary_inner(&state, &resource_id, &url, &remote_path, true).await
}

fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// ============================================================================
// 压缩包条目预览：远端执行 unzip -l / tar -tvf / 7z l / unrar l 列条目
// 不下载文件到本地，远端工具缺失时返回 tool_missing 供前端一键安装
// ============================================================================

/// 单个压缩包条目
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// 条目相对路径（含目录层级）
    pub name: String,
    /// 解压后字节数（无法解析时为 0）
    #[specta(type = f64)]
    pub size: u64,
    /// 修改时间 Unix 秒（无法解析时为 null）
    #[specta(type = Option<f64>)]
    pub modified: Option<i64>,
    /// 是否为目录
    pub is_dir: bool,
}

/// 列压缩包条目结果
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListResult {
    pub entries: Vec<ArchiveEntry>,
    /// 检测到的格式：zip / tar / tar.gz / tar.bz2 / tar.xz / tar.zst / 7z / rar
    pub format: String,
    /// 解压后总字节数
    #[specta(type = f64)]
    pub total_uncompressed: u64,
    /// 远端工具缺失时返回提示（如 "unzip"），前端可调 ssh_pool_install_archive_tool
    pub tool_missing: Option<String>,
}

/// 单个安装工具结果
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveToolInstallResult {
    /// 工具二进制名：unzip / 7z / unrar / zstd / tar
    pub tool: String,
    pub installed: bool,
    /// 安装输出（成功或失败原因）
    pub message: String,
}

/// 按文件名扩展名识别压缩包格式，返回 (format, dispatch_tool)。
/// dispatch_tool 为远端要用的二进制名（unzip / tar / 7z / unrar / zstd）。
fn detect_archive_format(name: &str) -> Option<(&'static str, &'static str)> {
    let lower = name.to_ascii_lowercase();
    // 优先匹配复合扩展名
    if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        return Some(("tar.gz", "tar"));
    }
    if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") || lower.ends_with(".tbz") {
        return Some(("tar.bz2", "tar"));
    }
    if lower.ends_with(".tar.xz") || lower.ends_with(".txz") {
        return Some(("tar.xz", "tar"));
    }
    if lower.ends_with(".tar.zst") || lower.ends_with(".tzst") {
        return Some(("tar.zst", "tar"));
    }
    if lower.ends_with(".tar") {
        return Some(("tar", "tar"));
    }
    if lower.ends_with(".zip") {
        return Some(("zip", "unzip"));
    }
    if lower.ends_with(".7z") {
        return Some(("7z", "7z"));
    }
    if lower.ends_with(".rar") {
        return Some(("rar", "unrar"));
    }
    // 单层压缩格式（非 tar 容器）：gzip/bzip2/xz/zst 本身只能压单文件，
    // 列条目意义不大，这里也归 zip 类工具不支持
    None
}

/// 解析 `unzip -l` 输出（Info-ZIP 格式，跨 unzip 实现稳定）
/// 格式示例：
/// ```text
///   Length      Date    Time    Name
/// ---------  ---------- -----   ----
///         0  2024-01-01 00:00   dir/
///       123  2024-01-01 00:00   file.txt
/// ---------                     -------
/// ```
fn parse_unzip_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    let mut in_table = false;
    for line in stdout.lines() {
        let trimmed = line.trim_end();
        // 表头检测：包含 "Length" / "Date" / "Time" / "Name"
        if !in_table {
            if trimmed.contains("Length") && trimmed.contains("Date") && trimmed.contains("Name") {
                in_table = true;
            }
            continue;
        }
        // 表尾：以 "---------" 开头且后面只有空格/减号
        if trimmed.starts_with("---------") {
            break;
        }
        // 跳过空行
        if trimmed.is_empty() {
            continue;
        }
        // 解析列：长度(10) 日期(10) 时间(5) 名称(剩余)
        // 实际格式前 27 字符为定宽列，28 起为文件名
        if line.len() < 28 {
            continue;
        }
        let size_str = line[..10].trim();
        let date_str = line[11..21].trim();
        let time_str = line.get(22..27).unwrap_or("").trim();
        let name = line[28..].trim();
        if name.is_empty() {
            continue;
        }
        let size: u64 = size_str.parse().unwrap_or(0);
        let is_dir = name.ends_with('/');
        let modified = parse_date_time(date_str, time_str);
        entries.push(ArchiveEntry {
            name: name.to_string(),
            size,
            modified,
            is_dir,
        });
    }
    entries
}

/// 解析 `tar -tvf` 输出（GNU tar 长格式）
/// 格式：`-rw-r--r-- 0/user group 123 2024-01-01 00:00 file.txt`
fn parse_tar_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    for line in stdout.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 6 {
            continue;
        }
        // 第一列权限：10 字符（如 -rw-r--r-- / drwxr-xr-x）
        let perms = tokens[0];
        if perms.len() < 10 {
            continue;
        }
        let is_dir = perms.starts_with('d');
        // size 是 tokens[1..] 中第一个能解析为数字的字段（跳过 perms/owner/group）
        let mut size: u64 = 0;
        let mut size_idx = 0;
        for (i, tok) in tokens.iter().enumerate().skip(1) {
            if let Ok(n) = tok.parse::<u64>() {
                size = n;
                size_idx = i;
                break;
            }
        }
        if size_idx == 0 {
            continue;
        }
        // size 后是 date time [tz] name
        let date_idx = size_idx + 1;
        let time_idx = size_idx + 2;
        if tokens.len() <= time_idx {
            continue;
        }
        let date_str = tokens[date_idx];
        let time_str = tokens[time_idx];
        let modified = parse_date_time(date_str, time_str);
        // 跳过可能的时区字段（如 "UTC" 或 "+0000"）
        let mut name_idx = size_idx + 3;
        while name_idx < tokens.len() {
            let t = tokens[name_idx];
            // 时区字段：纯数字偏移（+0000）或纯字母（UTC/GMT）
            if (t.starts_with('+') || t.starts_with('-'))
                && t.len() == 5
                && t[1..].chars().all(|c| c.is_ascii_digit())
            {
                name_idx += 1;
                continue;
            }
            if t == "UTC" || t == "GMT" {
                name_idx += 1;
                continue;
            }
            break;
        }
        if name_idx >= tokens.len() {
            continue;
        }
        // name 是剩余 token 用空格连接（文件名可能含空格）
        let name = tokens[name_idx..].join(" ");
        // 去除 GNU tar 可能的引号包裹
        let name = name.trim_matches('"');
        if name.is_empty() {
            continue;
        }
        let is_dir_final = is_dir || name.ends_with('/');
        entries.push(ArchiveEntry {
            name: name.to_string(),
            size,
            modified,
            is_dir: is_dir_final,
        });
    }
    entries
}

/// 解析 `7z l` 输出（p7zip / 7-Zip 列表模式）
/// 格式：
/// ```text
///    Date      Time    Attr         Size   Compressed  Name
/// ------------------- ----- ------------ ------------  ----------------
/// 2024-01-01 00:00:00 ....A          123          100  file.txt
/// ------------------- ----- ------------ ------------  ----------------
/// ```
fn parse_7z_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    let mut in_table = false;
    for line in stdout.lines() {
        let trimmed = line.trim_end();
        if !in_table {
            // 表头：包含 Date Time Attr Size Name
            if trimmed.contains("Date")
                && trimmed.contains("Attr")
                && trimmed.contains("Name")
            {
                in_table = true;
            }
            continue;
        }
        // 表尾分隔行
        if trimmed.starts_with("---") {
            if entries.is_empty() {
                // 可能是表头后的第一行分隔，跳过
                continue;
            } else {
                break;
            }
        }
        if trimmed.is_empty() {
            continue;
        }
        // 格式：YYYY-MM-DD HH:MM:SS attr(5) size(12) compressed(12) name
        // 用 split_whitespace 拆分，name 是剩余部分
        if line.len() < 54 {
            continue;
        }
        let date_str = &line[0..10];
        let time_str = &line[11..19];
        let attr = line[20..25].trim();
        let size_str = line[26..38].trim();
        // name 从第 54 字符起
        let name = line.get(54..).unwrap_or("").trim();
        if name.is_empty() {
            continue;
        }
        let size: u64 = size_str.replace(',', "").parse().unwrap_or(0);
        let modified = parse_date_time(date_str, time_str);
        let is_dir = attr.contains('D') || name.ends_with('/');
        entries.push(ArchiveEntry {
            name: name.to_string(),
            size,
            modified,
            is_dir,
        });
    }
    entries
}

/// 解析 `unrar l` 输出
/// 格式：
/// ```text
/// Attributes      Size  Packed Ratio    Date    Time   CRC32  Method  Version  Name
/// -------------------------------------------------------------------------------
/// -rw-r--r--     123     100  81%  2024-01-01 00:00  ABCDEF00  m3a    3    file.txt
/// -------------------------------------------------------------------------------
/// ```
fn parse_unrar_list(stdout: &str) -> Vec<ArchiveEntry> {
    let mut entries = Vec::new();
    let mut in_table = false;
    for line in stdout.lines() {
        let trimmed = line.trim_end();
        if !in_table {
            // 表头：包含 Attributes Size Date Name
            if trimmed.contains("Attributes")
                && trimmed.contains("Size")
                && trimmed.contains("Name")
            {
                in_table = true;
            }
            continue;
        }
        // 分隔线
        if trimmed.starts_with("---") {
            if entries.is_empty() {
                continue;
            } else {
                break;
            }
        }
        if trimmed.is_empty() {
            continue;
        }
        // 用 split_whitespace 拆分 token
        // 格式：attrs size packed ratio date time crc method version name...
        let tokens: Vec<&str> = line.split_whitespace().collect();
        if tokens.len() < 10 {
            continue;
        }
        let attrs = tokens[0];
        let size_str = tokens[1];
        let date_str = tokens[4];
        let time_str = tokens[5];
        // name 是 version 后的剩余部分（token 9 起）
        let name = tokens[9..].join(" ");
        let size: u64 = size_str.parse().unwrap_or(0);
        let modified = parse_date_time(date_str, time_str);
        let is_dir = attrs.starts_with('d') || name.ends_with('/');
        entries.push(ArchiveEntry {
            name: name.trim_matches('"').to_string(),
            size,
            modified,
            is_dir,
        });
    }
    entries
}

/// 解析日期时间字符串为 Unix 秒（失败返回 None）
/// 支持格式：YYYY-MM-DD HH:MM[:SS]
fn parse_date_time(date: &str, time: &str) -> Option<i64> {
    if date.len() < 10 {
        return None;
    }
    let y: i32 = date.get(0..4)?.parse().ok()?;
    let m: u32 = date.get(5..7)?.parse().ok()?;
    let d: u32 = date.get(8..10)?.parse().ok()?;
    let time_part = if time.len() >= 5 { time } else { "00:00" };
    let (hh, mm, ss) = if time_part.len() >= 8 {
        let hh: u32 = time_part.get(0..2)?.parse().ok()?;
        let mm: u32 = time_part.get(3..5)?.parse().ok()?;
        let ss: u32 = time_part.get(6..8)?.parse().ok()?;
        (hh, mm, ss)
    } else if time_part.len() >= 5 {
        let hh: u32 = time_part.get(0..2)?.parse().ok()?;
        let mm: u32 = time_part.get(3..5)?.parse().ok()?;
        (hh, mm, 0)
    } else {
        (0, 0, 0)
    };
    days_from_civil(y, m, d).and_then(|days| {
        let secs = (days as i64) * 86400 + (hh as i64) * 3600 + (mm as i64) * 60 + ss as i64;
        Some(secs)
    })
}

/// 公历日期 → 自公元 0001-01-01 起的天数（Howard Hinnant 算法）
fn days_from_civil(y: i32, m: u32, d: u32) -> Option<i64> {
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era as i64) * 146097 + doe as i64 - 719468)
}

/// 列出远端压缩包条目（不在本地下载文件，远端执行 unzip/tar/7z/unrar）。
/// 远端工具缺失时返回 `tool_missing`，前端可调 `ssh_pool_install_archive_tool` 一键安装后重试。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_list_archive_entries(
    state: State<'_, AppState>,
    resource_id: String,
    path: String,
) -> Result<ArchiveListResult, OmniError> {
    let name = Path::new(&path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let (format, tool) = detect_archive_format(name).ok_or_else(|| {
        OmniError::new(
            ErrorCode::InvalidInput,
            format!("无法识别压缩包格式: {name}"),
        )
    })?;

    let session = pool_session(&state, &resource_id).await?;
    let quoted = shell_single_quote(&path);

    // 构造远端命令
    let cmd = match (format, tool) {
        ("tar", _) => format!("tar -tvf {quoted}"),
        ("tar.gz", _) => format!("tar -tzvf {quoted}"),
        ("tar.bz2", _) => format!("tar -tjvf {quoted}"),
        ("tar.xz", _) => format!("tar -tJvf {quoted}"),
        ("tar.zst", _) => format!("tar --zstd -tvf {quoted}"),
        ("zip", _) => format!("unzip -l {quoted}"),
        ("7z", _) => format!("7z l {quoted}"),
        ("rar", _) => format!("unrar l {quoted}"),
        _ => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("不支持的压缩格式: {format}"),
            ));
        }
    };

    // 先检查工具是否存在，避免 unzip 交互式卡密码提示
    let check = format!("command -v {tool} >/dev/null 2>&1 && echo OK || echo MISSING");
    let check_output = session.exec_capture(&check).await?;
    if check_output.stdout.trim() == "MISSING" {
        return Ok(ArchiveListResult {
            entries: Vec::new(),
            format: format.to_string(),
            total_uncompressed: 0,
            tool_missing: Some(tool.to_string()),
        });
    }

    // 加密 zip 防卡密码：unzip 传 -P '' 让它直接报错而非挂起
    let safe_cmd = if format == "zip" {
        format!("unzip -P '' -l {quoted}")
    } else {
        cmd
    };

    // 30s 超时（大压缩包列条目可能慢，但远端工具应能快速返回元数据）
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        session.exec_capture(&safe_cmd),
    )
    .await
    {
        Ok(r) => r?,
        Err(_) => {
            return Err(OmniError::new(
                ErrorCode::Internal,
                "列出压缩包条目超时（>30s）",
            ));
        }
    };

    // 工具执行但报错（如损坏的压缩包、加密 zip、缺解码库）
    if output.exit_code != 0 {
        let stderr = output.stderr.trim();
        let stdout = output.stdout.trim();
        let detail = if !stderr.is_empty() {
            stderr
        } else {
            stdout
        };
        // 检测加密标志
        if detail.contains("password")
            || detail.contains("encrypted")
            || detail.contains("密码")
        {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "压缩包已加密，不支持预览",
            ));
        }
        return Err(OmniError::new(
            ErrorCode::Internal,
            format!("列出压缩包条目失败: {detail}"),
        ));
    }

    let entries = match format {
        "zip" => parse_unzip_list(&output.stdout),
        "tar" | "tar.gz" | "tar.bz2" | "tar.xz" | "tar.zst" => parse_tar_list(&output.stdout),
        "7z" => parse_7z_list(&output.stdout),
        "rar" => parse_unrar_list(&output.stdout),
        _ => Vec::new(),
    };

    let total_uncompressed: u64 = entries.iter().filter(|e| !e.is_dir).map(|e| e.size).sum();

    Ok(ArchiveListResult {
        entries,
        format: format.to_string(),
        total_uncompressed,
        tool_missing: None,
    })
}

/// 远端工具 → 包名映射（按包管理器）
fn archive_tool_package(tool: &str, pm: &str) -> Option<&'static str> {
    match (tool, pm) {
        ("unzip", "apt") => Some("unzip"),
        ("unzip", "dnf") | ("unzip", "yum") => Some("unzip"),
        ("unzip", "apk") => Some("unzip"),
        ("unzip", "pacman") => Some("unzip"),
        ("unzip", "zypper") => Some("unzip"),

        ("tar", "apt") => Some("tar"),
        ("tar", "dnf") | ("tar", "yum") => Some("tar"),
        ("tar", "apk") => Some("tar"),
        ("tar", "pacman") => Some("tar"),
        ("tar", "zypper") => Some("tar"),

        ("7z", "apt") => Some("p7zip-full"),
        ("7z", "dnf") | ("7z", "yum") => Some("p7zip"),
        ("7z", "apk") => Some("p7zip"),
        ("7z", "pacman") => Some("p7zip"),
        ("7z", "zypper") => Some("p7zip"),

        ("unrar", "apt") => Some("unrar"),
        ("unrar", "dnf") | ("unrar", "yum") => Some("unrar"),
        ("unrar", "apk") => Some("unrar"),
        ("unrar", "pacman") => Some("unrar"),
        ("unrar", "zypper") => Some("unrar"),

        ("zstd", "apt") => Some("zstd"),
        ("zstd", "dnf") | ("zstd", "yum") => Some("zstd"),
        ("zstd", "apk") => Some("zstd"),
        ("zstd", "pacman") => Some("zstd"),
        ("zstd", "zypper") => Some("zstd"),

        _ => None,
    }
}

/// 在远端一键安装压缩包工具（unzip / tar / 7z / unrar / zstd）。
/// 自动检测包管理器（apt/dnf/yum/apk/pacman/zypper），优先用 sudo -n 非交互提权，
/// 失败回退无 sudo 直接安装（root 用户或免密场景）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_pool_install_archive_tool(
    state: State<'_, AppState>,
    resource_id: String,
    tool: String,
) -> Result<ArchiveToolInstallResult, OmniError> {
    let tool = tool.trim().to_lowercase();
    let valid_tools = ["unzip", "tar", "7z", "unrar", "zstd"];
    if !valid_tools.contains(&tool.as_str()) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("不支持的工具: {tool}（可选: unzip/tar/7z/unrar/zstd）"),
        ));
    }

    let session = pool_session(&state, &resource_id).await?;

    // 检测包管理器
    let detect_pm = r#"command -v apt-get >/dev/null 2>&1 && echo apt || \
(command -v dnf >/dev/null 2>&1 && echo dnf || \
(command -v yum >/dev/null 2>&1 && echo yum || \
(command -v apk >/dev/null 2>&1 && echo apk || \
(command -v pacman >/dev/null 2>&1 && echo pacman || \
(command -v zypper >/dev/null 2>&1 && echo zypper || \
echo UNKNOWN)))))"#;
    let pm_output = session.exec_capture(detect_pm).await?;
    let pm = pm_output.stdout.trim().to_string();
    if pm == "UNKNOWN" || pm.is_empty() {
        return Ok(ArchiveToolInstallResult {
            tool: tool.clone(),
            installed: false,
            message: "未检测到支持的包管理器（apt/dnf/yum/apk/pacman/zypper）".to_string(),
        });
    }

    let pkg = archive_tool_package(&tool, &pm).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            format!("包管理器 {pm} 不支持安装 {tool}"),
        )
    })?;

    // 构造安装命令：sudo -n 优先（非交互），失败回退无 sudo
    let install_cmd = match pm.as_str() {
        "apt" => format!(
            "sudo -n apt-get install -y {pkg} 2>/dev/null || apt-get install -y {pkg} 2>&1"
        ),
        "dnf" => format!(
            "sudo -n dnf install -y {pkg} 2>/dev/null || dnf install -y {pkg} 2>&1"
        ),
        "yum" => format!(
            "sudo -n yum install -y {pkg} 2>/dev/null || yum install -y {pkg} 2>&1"
        ),
        "apk" => format!("apk add --no-progress {pkg} 2>&1 || sudo -n apk add --no-progress {pkg} 2>&1"),
        "pacman" => format!(
            "sudo -n pacman -S --noconfirm --needed {pkg} 2>/dev/null || pacman -S --noconfirm --needed {pkg} 2>&1"
        ),
        "zypper" => format!(
            "sudo -n zypper -n install {pkg} 2>/dev/null || zypper -n install {pkg} 2>&1"
        ),
        _ => {
            return Ok(ArchiveToolInstallResult {
                tool: tool.clone(),
                installed: false,
                message: format!("不支持的包管理器: {pm}"),
            });
        }
    };

    // 安装可能耗时较长，给 120s 超时
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(120),
        session.exec_capture(&install_cmd),
    )
    .await
    {
        Ok(r) => r?,
        Err(_) => {
            return Ok(ArchiveToolInstallResult {
                tool: tool.clone(),
                installed: false,
                message: "安装超时（>120s）".to_string(),
            });
        }
    };

    // 校验安装结果：command -v 检查二进制是否可用
    let verify_cmd = format!("command -v {tool} >/dev/null 2>&1 && echo OK || echo FAIL");
    let verify_output = session.exec_capture(&verify_cmd).await?;
    let installed = verify_output.stdout.trim() == "OK";

    let combined = if !output.stderr.trim().is_empty() {
        format!("{}\n{}", output.stdout.trim(), output.stderr.trim())
    } else {
        output.stdout.trim().to_string()
    };
    let message = if installed {
        if combined.is_empty() {
            format!("已安装 {pkg}（{pm}）")
        } else {
            format!("已安装 {pkg}（{pm}）\n{}", combined.chars().take(500).collect::<String>())
        }
    } else if combined.is_empty() {
        format!("安装失败（{pm} install {pkg}）")
    } else {
        combined.chars().take(500).collect::<String>()
    };

    Ok(ArchiveToolInstallResult {
        tool,
        installed,
        message,
    })
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
            if let Some(existing_conn) = existing.iter().find(|c| c.name == host.alias) {
                let mut conn = existing_conn.clone();
                let mut merged_config = ssh_config;
                let secret = resolve_connection_secret(existing_conn);
                if let Ok((patched, _)) = inject_ssh_vault_into_config(
                    &existing_conn.config,
                    &existing_conn.id,
                    existing_conn.credential_ref.as_deref(),
                ) {
                    if let Ok(existing_cfg) =
                        ssh_config_from_json(&patched, secret.as_deref())
                    {
                        if matches!(existing_cfg.auth, SshAuth::Password { .. }) {
                            merged_config.auth = existing_cfg.auth;
                        }
                    }
                }
                let config_json = serde_json::to_string(&merged_config).map_err(|e| {
                    OmniError::new(ErrorCode::Internal, "序列化 SSH 配置失败").with_cause(e.to_string())
                })?;
                conn.config = config_json;
                conn.group = SSH_CONFIG_SYNC_GROUP.to_string();
                conn.env_tag = "unknown".to_string();
                conn.updated_at = now;
                storage.save_connection(&conn)?;
                updated += 1;
            } else {
                let config_json = serde_json::to_string(&ssh_config).map_err(|e| {
                    OmniError::new(ErrorCode::Internal, "序列化 SSH 配置失败").with_cause(e.to_string())
                })?;
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

fn ssh_keygen_command() -> std::process::Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        let bundled = std::path::Path::new(r"C:\Windows\System32\OpenSSH\ssh-keygen.exe");
        let mut cmd = if bundled.is_file() {
            std::process::Command::new(bundled)
        } else {
            std::process::Command::new("ssh-keygen")
        };
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("ssh-keygen")
    }
}

fn sanitize_ssh_key_name(raw: &str) -> Result<String, OmniError> {
    let mut name = raw.trim().to_string();
    if name.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "密钥名称不能为空"));
    }
    if name.ends_with(".pub") {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "密钥名称不能以 .pub 结尾",
        ));
    }
    if let Some(stem) = name.strip_suffix(".pem") {
        name = stem.to_string();
    }
    if name.contains('/') || name.contains('\\') {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "密钥名称不能包含路径分隔符",
        ));
    }
    Ok(name)
}

fn allocate_ssh_key_filename(
    ssh_dir: &std::path::Path,
    algo: &str,
    preferred: Option<&str>,
) -> Result<String, OmniError> {
    if let Some(name) = preferred.map(str::trim).filter(|n| !n.is_empty()) {
        let safe = sanitize_ssh_key_name(name)?;
        if ssh_dir.join(&safe).exists() {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("密钥 `{safe}` 已存在"),
            ));
        }
        return Ok(safe);
    }

    let base = format!("id_{algo}");
    if !ssh_dir.join(&base).exists() {
        return Ok(base);
    }
    for i in 2..100 {
        let candidate = format!("{base}_{i}");
        if !ssh_dir.join(&candidate).exists() {
            return Ok(candidate);
        }
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    Ok(format!("id_{algo}_{millis}"))
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

/// 读取私钥文件内容（`~/.ssh/{name}`）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_read_key_private(name: String) -> Result<Option<String>, OmniError> {
    let name = sanitize_ssh_key_name(&name)?;
    let ssh_dir = default_ssh_dir()
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "无法定位用户主目录"))?;
    let key_path = ssh_dir.join(&name);
    if !key_path.is_file() {
        return Ok(None);
    }
    let content = std::fs::read_to_string(&key_path)
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取私钥文件失败").with_cause(e.to_string()))?;
    if !is_private_key_pem_content(&content) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "文件不是有效的 OpenSSH / PEM 私钥",
        ));
    }
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
    name: Option<String>,
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

    let filename = allocate_ssh_key_filename(&ssh_dir, algo, name.as_deref())?;
    let key_path = ssh_dir.join(&filename);

    let mut cmd = ssh_keygen_command();
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
        OmniError::new(ErrorCode::Ssh, "运行 ssh-keygen 失败，请确认已安装 OpenSSH")
            .with_cause(e.to_string())
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(OmniError::new(ErrorCode::Ssh, "ssh-keygen 执行失败")
            .with_cause(if stderr.is_empty() {
                format!("exit code {:?}", output.status.code())
            } else {
                stderr
            }));
    }

    ssh_key_info_from_path(&key_path).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            format!("密钥已生成但无法读取: {filename}"),
        )
    })
}

/// 导入 SSH 私钥（写入 ~/.ssh/ 目录）。
#[tauri::command]
#[specta::specta]
pub async fn ssh_import_key(name: String, private_key: String) -> Result<SshKeyInfo, OmniError> {
    let trimmed_key = private_key.trim();
    if !is_private_key_pem_content(trimmed_key) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "私钥内容无效，请粘贴 OpenSSH / PEM 格式私钥",
        ));
    }

    let name = sanitize_ssh_key_name(&name)?;
    let home = home_dir()?;
    let ssh_dir = home.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建 .ssh 目录失败").with_cause(e.to_string())
    })?;

    let key_path = ssh_dir.join(&name);
    if key_path.exists() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("密钥 `{name}` 已存在"),
        ));
    }

    std::fs::write(&key_path, format!("{trimmed_key}\n")).map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入密钥文件失败").with_cause(e.to_string())
    })?;

    // Set permissions to 0600 on Unix
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&key_path, std::fs::Permissions::from_mode(0o600));
    }

    ssh_key_info_from_path(&key_path).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            format!("密钥已写入但无法解析: {name}"),
        )
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

// ============================================================================
// 大日志文件流式预览 / 搜索 / 跟踪
//
// 设计：远端命令（sed / grep / tail -F）作为引擎，Tauri 命令做封装，
//      前端虚拟滚动按行号切片拉取；跟踪走 exec_stream + Tauri event 推送。
// ============================================================================

/// 单引号 shell 转义：把字符串包成 'xxx'，内部单引号转义为 '"'"'。
fn shell_quote_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// 生成本地不可预测 token（参考 media_stream::new_token）。
fn new_log_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "logtail-{nanos:x}{:08x}",
        (nanos.wrapping_mul(0x9e37_79b9) as u32) ^ 0x5a5a_5a5a
    )
}

/// 日志会话元信息（打开时探测一次）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSessionInfo {
    #[specta(type = f64)]
    pub size_bytes: u64,
    /// 总行数预估（wc -l，可能比真实少 1 行如果末尾无换行）。
    #[specta(type = Option<f64>)]
    pub total_lines: Option<u64>,
}

/// 一行日志（带绝对行号，1-based）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    #[specta(type = f64)]
    pub line_no: u64,
    pub text: String,
}

/// grep 命中（带行号与命中片段）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogSearchHit {
    #[specta(type = f64)]
    pub line_no: u64,
    pub content: String,
    /// 命中在 content 中的起止列（None 表示未提供精确列）。
    #[specta(type = Option<f64>)]
    pub match_start: Option<usize>,
    #[specta(type = Option<f64>)]
    pub match_end: Option<usize>,
}

/// 跟踪句柄（返回 token 用于后续停止）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogTailHandle {
    pub token: String,
}

/// 跟踪事件 payload：通过 `sftp-log-tail-{token}` 事件推送给前端。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct LogTailChunk {
    pub token: String,
    /// 本次推送的新行（已按 \n 切分，已去 \r）。
    pub lines: Vec<String>,
    /// 远端进程退出码（仅 Exit 事件有）。
    pub exit_code: Option<i32>,
    /// 错误信息（仅 Closed / 异常有）。
    pub error: Option<String>,
}

/// 打开日志会话：探测文件大小与总行数。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_open(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<LogSessionInfo, OmniError> {
    // size：sftp_file_size 内部已有 exec_gate + sftp channel，锁内 await 可接受（参考 sftp_open_media_stream）
    let size = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            session.sftp_file_size(&path).await
        } else {
            drop(sessions);
            pool_session(&state, &id).await?.sftp_file_size(&path).await
        }
    }
    .unwrap_or(0);

    // total_lines：wc -l < file（不读最后一行无 \n 的情况，但作为预估够用）
    // 加 3s 超时保护，避免 GB 级文件或慢磁盘卡住首屏（超时返回 None，前端用 tail 推算）
    let wc_cmd = format!("wc -l < {}", shell_quote_single(&path));
    let wc_fut = async {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            session.exec_command(&wc_cmd).await
        } else {
            drop(sessions);
            pool_session(&state, &id).await?.exec_command(&wc_cmd).await
        }
    };
    let total_lines = match tokio::time::timeout(std::time::Duration::from_secs(3), wc_fut).await {
        Ok(Ok(s)) => s.trim().parse::<u64>().ok(),
        _ => None, // 超时或错误：返回 None，前端用 tail 行号兜底
    };

    Ok(LogSessionInfo { size_bytes: size, total_lines })
}

/// 按行号范围读取（虚拟滚动按需切片，1-based）。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_read_lines(
    state: State<'_, AppState>,
    id: String,
    path: String,
    start_line: f64,
    end_line: f64,
) -> Result<Vec<LogLine>, OmniError> {
    let start_line = start_line.max(0.0) as u64;
    let end_line = end_line.max(0.0) as u64;
    if start_line == 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "起始行号必须 ≥ 1"));
    }
    if end_line < start_line {
        return Err(OmniError::new(ErrorCode::InvalidInput, "结束行号不能小于起始行号"));
    }
    // 限制单次拉取行数，防止误传巨大范围
    const MAX_LINES_PER_CALL: u64 = 5_000;
    let safe_end = start_line + (end_line - start_line).min(MAX_LINES_PER_CALL - 1);

    let cmd = format!(
        "sed -n '{},{}p' {}",
        start_line,
        safe_end,
        shell_quote_single(&path)
    );

    let output = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            session.exec_capture(&cmd).await?
        } else {
            drop(sessions);
            pool_session(&state, &id).await?.exec_capture(&cmd).await?
        }
    };

    if output.exit_code != 0 {
        return Err(OmniError::new(ErrorCode::Ssh, "读取日志行失败")
            .with_cause(output.stderr.trim().to_string()));
    }
    // 统一换行：CRLF → LF，去除末尾换行后 split
    let stdout = output.stdout.replace("\r\n", "\n");
    let trimmed = stdout.strip_suffix('\n').unwrap_or(&stdout);
    let lines: Vec<LogLine> = trimmed
        .split('\n')
        .enumerate()
        .map(|(i, text)| LogLine {
            line_no: start_line + i as u64,
            text: text.to_string(),
        })
        .collect();
    Ok(lines)
}

/// 读取文件末尾 N 行（用 tail -n N，O(N) 反向 seek，不扫描整个文件）。
/// 用于大日志文件打开时的首屏末尾预览，比 sed -n 'X,Yp' 快 30x。
/// 行号推算：如果有 totalLinesHint，从 (hint - N + 1) 开始；否则从 1 开始。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_tail_initial(
    state: State<'_, AppState>,
    id: String,
    path: String,
    n_lines: u32,
    total_lines_hint: Option<f64>,
) -> Result<Vec<LogLine>, OmniError> {
    const MAX_N: u32 = 5_000;
    let n = n_lines.min(MAX_N).max(1);
    let total_lines_hint = total_lines_hint.map(|n| n.max(0.0) as u64);

    let cmd = format!("tail -n {n} {}", shell_quote_single(&path));

    let output = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            session.exec_capture(&cmd).await?
        } else {
            drop(sessions);
            pool_session(&state, &id).await?.exec_capture(&cmd).await?
        }
    };

    if output.exit_code != 0 {
        return Err(OmniError::new(ErrorCode::Ssh, "读取日志末尾失败")
            .with_cause(output.stderr.trim().to_string()));
    }

    let stdout = output.stdout.replace("\r\n", "\n");
    let trimmed = stdout.strip_suffix('\n').unwrap_or(&stdout);
    let lines: Vec<&str> = if trimmed.is_empty() { Vec::new() } else { trimmed.split('\n').collect() };

    // 推算起始行号
    let start_line: u64 = match total_lines_hint {
        Some(hint) => hint.saturating_sub(lines.len() as u64).saturating_add(1).max(1),
        None => 1,
    };

    let result: Vec<LogLine> = lines
        .iter()
        .enumerate()
        .map(|(i, text)| LogLine {
            line_no: start_line + i as u64,
            text: text.to_string(),
        })
        .collect();
    Ok(result)
}

/// 搜索日志（grep -n），返回命中行列表。
/// grep exit 1 = no match（非错误），其他非零 exit 视为错误。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_search(
    state: State<'_, AppState>,
    id: String,
    path: String,
    pattern: String,
    is_regex: bool,
    max_results: Option<u32>,
    context_before: Option<u32>,
    context_after: Option<u32>,
) -> Result<Vec<LogSearchHit>, OmniError> {
    const DEFAULT_MAX: u32 = 2000;
    const ABSOLUTE_MAX: u32 = 20_000;
    let max = max_results.unwrap_or(DEFAULT_MAX).min(ABSOLUTE_MAX);

    let pattern_quoted = format!("'{}'", pattern.replace('\'', "'\"'\"'"));
    let mut cmd = String::from("grep -n --color=never --line-buffered");
    cmd.push_str(if is_regex { " -E" } else { " -F" });
    if let Some(b) = context_before {
        cmd.push_str(&format!(" -B {b}"));
    }
    if let Some(a) = context_after {
        cmd.push_str(&format!(" -A {a}"));
    }
    cmd.push_str(&format!(" -m {max} {pattern_quoted} {}", shell_quote_single(&path)));

    let output = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            session.exec_capture(&cmd).await?
        } else {
            drop(sessions);
            pool_session(&state, &id).await?.exec_capture(&cmd).await?
        }
    };

    // grep exit 1 = no match，不是错误
    if output.exit_code != 0 && output.exit_code != 1 {
        return Err(OmniError::new(ErrorCode::Ssh, "搜索失败")
            .with_cause(output.stderr.trim().to_string()));
    }
    let mut hits = Vec::new();
    for line in output.stdout.lines() {
        // 行格式：`行号:内容`（context 行格式为 `行号-内容`，简化处理仍按 : 切）
        let sep_idx = line.find(|c: char| c == ':' || c == '-');
        if let Some(idx) = sep_idx {
            if let Ok(line_no) = line[..idx].parse::<u64>() {
                let content = line[idx + 1..].to_string();
                hits.push(LogSearchHit {
                    line_no,
                    content,
                    match_start: None,
                    match_end: None,
                });
            }
        }
    }
    Ok(hits)
}

/// 开始实时跟踪（tail -F，支持文件轮转）。
/// 输出通过 `sftp-log-tail-{token}` Tauri event 推送给前端。
///
/// `lines_after`：跟踪前先输出末尾 N 行（默认 0，只跟新行）。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_tail_start(
    app_handle: AppHandle,
    state: State<'_, AppState>,
    id: String,
    path: String,
    lines_after: Option<u32>,
) -> Result<LogTailHandle, OmniError> {
    use tokio::sync::mpsc;

    let n = lines_after.unwrap_or(0);
    // 用 tail -F（大写）：文件被 rotate 时自动重新打开
    let cmd = format!("tail -F -n {n} {}", shell_quote_single(&path));

    let (tx, mut rx) = mpsc::unbounded_channel::<StreamChunk>();

    // exec_stream 内部 acquire exec_gate + open channel + spawn 读 task
    // 这一步通常很快（< 1s），在 ssh_sessions 锁内可接受
    let handle = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&id) {
            session.exec_stream(&cmd, tx).await
        } else {
            drop(sessions);
            pool_session(&state, &id).await?.exec_stream(&cmd, tx).await
        }
    }
    .map_err(|e| OmniError::new(ErrorCode::Ssh, "启动日志跟踪失败").with_cause(e.to_string()))?;

    let token = new_log_token();
    let event_name = format!("sftp-log-tail-{token}");
    let token_for_task = token.clone();
    let event_for_task = event_name.clone();
    let app_for_task = app_handle.clone();

    tokio::spawn(async move {
        let mut line_buf: Vec<u8> = Vec::with_capacity(8192);
        while let Some(chunk) = rx.recv().await {
            match chunk {
                StreamChunk::Stdout(b) | StreamChunk::Stderr(b) => {
                    line_buf.extend_from_slice(&b);
                    let mut lines: Vec<String> = Vec::new();
                    // 按 \n 切分，保留未结束的部分到 line_buf
                    loop {
                        let Some(idx) = line_buf.iter().position(|&c| c == b'\n') else {
                            break;
                        };
                        let mut line: Vec<u8> = line_buf[..idx].to_vec();
                        if line.last() == Some(&b'\r') {
                            line.pop();
                        }
                        // line_buf drain 已切走的
                        line_buf = line_buf[idx + 1..].to_vec();
                        lines.push(String::from_utf8_lossy(&line).into_owned());
                    }
                    if !lines.is_empty() {
                        let _ = app_for_task.emit(
                            &event_for_task,
                            LogTailChunk {
                                token: token_for_task.clone(),
                                lines,
                                exit_code: None,
                                error: None,
                            },
                        );
                    }
                }
                StreamChunk::Exit(code) => {
                    let _ = app_for_task.emit(
                        &event_for_task,
                        LogTailChunk {
                            token: token_for_task.clone(),
                            lines: vec![],
                            exit_code: Some(code),
                            error: None,
                        },
                    );
                    break;
                }
                StreamChunk::Closed => {
                    let _ = app_for_task.emit(
                        &event_for_task,
                        LogTailChunk {
                            token: token_for_task.clone(),
                            lines: vec![],
                            exit_code: None,
                            error: Some("stream closed".to_string()),
                        },
                    );
                    break;
                }
            }
        }
    });

    state
        .log_tail_streams
        .lock()
        .await
        .insert(token.clone(), handle);

    Ok(LogTailHandle { token })
}

/// 停止实时跟踪。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_tail_stop(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), OmniError> {
    if let Some(mut handle) = state.log_tail_streams.lock().await.remove(&token) {
        handle.stop().await;
    }
    Ok(())
}
