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
    SshProcessInfo, SshSession, SshSink, default_ssh_dir, discover_ssh_identity_file,
    find_ssh_config_entry, is_private_key_pem_content, list_ssh_private_key_paths_in,
    load_ssh_config_hosts, ssh_config_from_json, ssh_config_to_connect_config, ssh_public_key_meta,
};
use omnipanel_store::{
    inject_ssh_vault_into_config, AuditEntry, Connection, ConnectionKind, SshKeyRecord, Vault,
};
use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::background::{HostSystemStats, PoolStatusEvent, SshHostOverview};
use crate::output_buffer;
use crate::ssh_tmux::{host_identity, AttachOutcome, SshTerminalInfo, TmuxTabStat};
use crate::state::AppState;
use omnipanel_ssh::tmux::{self, TmuxSessionInfo, TmuxWindowInfo};

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
    pane_id: Option<u32>,
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
            None,
            pane_id,
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
    pane_id: Option<u32>,
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
    ssh_connect(state, config, cols, rows, pane_id).await
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

/// 列出指定远端 tmux 会话内的 window（1 window = 1 pane）。
///
/// 走 exec 通道，无需当前已打开终端；用于远端会话治理页展开窗口树。
#[tauri::command]
#[specta::specta]
pub async fn ssh_tmux_list_windows(
    state: State<'_, AppState>,
    connection_id: String,
    session_name: String,
) -> Result<Vec<TmuxWindowInfo>, OmniError> {
    let session = state.ssh_pool.ensure_session(&connection_id).await?;
    let out = session
        .exec_capture(&tmux::list_windows_shell(&session_name))
        .await?;
    if out.exit_code != 0 {
        return Ok(Vec::new());
    }
    Ok(out
        .stdout
        .lines()
        .filter_map(|line| tmux::parse_window_info_line(line.as_bytes()))
        .collect())
}

/// 查询当前 OmniPanel 在该主机上每个 tmux 会话关联的 Tab 数。
///
/// 关联数据来自后端 `sessions` 表（跨所有窗口共享），不依赖前端 per-window 的
/// terminalStore——远端会话治理视图所在窗口未必持有开 Tab 的窗口的 store 状态。
#[tauri::command]
#[specta::specta]
pub async fn ssh_tmux_tab_stats(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<TmuxTabStat>, OmniError> {
    let config = state
        .ssh_pool
        .get_ssh_config(&connection_id)
        .await
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "未找到 SSH 连接配置"))?;
    let host_key = host_identity(&config);
    Ok(state.tmux.tab_stats_for_host(&host_key).await)
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

/// Attach 到远端指定名称的 tmux 会话，在终端模块开一个新 Tab。
///
/// 与 `ssh_connect` 的区别：`ssh_connect` 用固定会话名 `omnipanel-<host>`，
/// 本命令允许用户从远端会话列表选择任意会话名进入（含非 OmniPanel 创建的）。
/// `pane_id` 不为 None 时尝试 attach 回该 pane 对应的原 window（关 Tab 保留进程后重连），
/// 匹配不到则新建 window。返回后端会话 id（`ssh-{n}`），前端据此创建终端 Tab。
#[tauri::command]
#[specta::specta]
pub async fn ssh_tmux_attach_session(
    state: State<'_, AppState>,
    connection_id: String,
    session_name: String,
    cols: u16,
    rows: u16,
    pane_id: Option<u32>,
) -> Result<String, OmniError> {
    let config = state
        .ssh_pool
        .get_ssh_config(&connection_id)
        .await
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "未找到 SSH 连接配置"))?;

    let id = format!("ssh-{}", SSH_COUNTER.fetch_add(1, Ordering::Relaxed));

    // attach 到用户指定的会话名（-A = attach-or-create，已存在则 attach）
    match state
        .tmux
        .attach(
            &state.app_handle,
            &state.output_buffers,
            &config,
            &id,
            cols,
            rows,
            Some(&session_name),
            pane_id,
        )
        .await
    {
        Ok(AttachOutcome::Attached) => Ok(id),
        Ok(AttachOutcome::Unsupported(reason)) => Err(OmniError::new(
            ErrorCode::Internal,
            format!("无法接入 tmux 会话 {session_name}: {reason}"),
        )),
        Err(err) => Err(OmniError::new(
            ErrorCode::Internal,
            format!("接入 tmux 会话 {session_name} 失败: {}", err.user_message()),
        )),
    }
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
pub use omnipanel_ssh::media::SftpMediaProbe;

/// 打开边下边播流后的句柄。
pub use omnipanel_ssh::media::SftpMediaStream;

pub use omnipanel_ssh::log_tail::{
    LogLine, LogSearchHit, LogSearchOptions, LogSessionInfo, LogTailChunk, LogTailHandle,
};

/// 探测远端媒体时长/大小/封面：不下载整文件。
#[tauri::command]
#[specta::specta]
pub async fn sftp_probe_media(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<SftpMediaProbe, OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return Ok(omnipanel_ssh::media::probe_sftp_media(session, &path).await);
    }
    drop(sessions);
    let session = pool_session(&state, &id).await?;
    Ok(omnipanel_ssh::media::probe_sftp_media(session.as_ref(), &path).await)
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
    let entry = omnipanel_ssh::media::MediaStreamEntry {
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
        omnipanel_ssh::capabilities::assert_allowed_binary_download_url(url)?;
    }
    let session = pool_session(state, resource_id).await?;
    omnipanel_ssh::capabilities::download_install_binary(&session, url, remote_path).await
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
/// `aliases` 非空时仅同步列出的别名；为 `None` 时同步全部。
#[tauri::command]
#[specta::specta]
pub async fn ssh_sync_config_hosts(
    state: State<'_, AppState>,
    aliases: Option<Vec<String>>,
) -> Result<SshConfigSyncResult, OmniError> {
    let hosts = load_ssh_config_hosts()?;
    let alias_filter: Option<std::collections::HashSet<String>> =
        aliases.map(|list| list.into_iter().collect());
    let now = conn_now_secs();
    let mut added = 0u32;
    let mut updated = 0u32;
    let mut skipped = 0u32;
    let mut failures = Vec::new();

    {
        let storage = state.storage.lock().await;
        let existing = storage.list_connections_by_kind(ConnectionKind::Ssh)?;

        for host in hosts {
            if let Some(ref filter) = alias_filter {
                if !filter.contains(&host.alias) {
                    continue;
                }
            }
            let mut ssh_config = match ssh_config_to_connect_config(&host) {
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
            if let Err(e) = bind_ssh_identity_to_key_store(&storage, &mut ssh_config) {
                failures.push(SshConfigSyncFailure {
                    alias: host.alias.clone(),
                    reason: e.to_string(),
                });
                skipped += 1;
                continue;
            }
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
    ssh_connect(state, config, cols, rows, None).await
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
    pub id: String,
    pub name: String,
    pub key_type: String,
    pub path: String,
    pub fingerprint: String,
    pub comment: String,
}

fn ssh_key_record_to_info(record: &SshKeyRecord) -> SshKeyInfo {
    SshKeyInfo {
        id: record.id.clone(),
        name: record.name.clone(),
        key_type: record.key_type.clone(),
        path: record.source_path.clone(),
        fingerprint: record.fingerprint.clone(),
        comment: record.comment.clone(),
    }
}

fn load_private_pem_for_auth(auth: &SshAuth) -> Option<(String, Option<PathBuf>)> {
    match auth {
        SshAuth::PrivateKey {
            pem,
            key_path,
            key_id,
            ..
        } => {
            if key_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
                return None;
            }
            if let Some(value) = pem.as_deref().filter(|s| !s.is_empty()) {
                return Some((value.to_string(), None));
            }
            match key_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                Some("auto") | None => {
                    let path = discover_ssh_identity_file()?;
                    let pem = std::fs::read_to_string(&path).ok()?;
                    Some((pem, Some(path)))
                }
                Some(path) => {
                    let path_buf = PathBuf::from(path);
                    let pem = std::fs::read_to_string(&path_buf).ok()?;
                    Some((pem, Some(path_buf)))
                }
            }
        }
        _ => None,
    }
}

fn bind_ssh_identity_to_key_store(
    storage: &omnipanel_store::Storage,
    config: &mut SshConfig,
) -> Result<(), OmniError> {
    let Some((private_pem, source_path)) = load_private_pem_for_auth(&config.auth) else {
        return Ok(());
    };
    let SshAuth::PrivateKey {
        pem,
        key_path,
        key_id,
        passphrase,
    } = &mut config.auth
    else {
        return Ok(());
    };
    if key_id.as_deref().map(|s| !s.is_empty()).unwrap_or(false) {
        return Ok(());
    }
    if !is_private_key_pem_content(&private_pem) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "SSH 私钥内容无效",
        ));
    }
    let name = source_path
        .as_ref()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("imported-key");
    let public_key = source_path
        .as_ref()
        .and_then(|p| {
            let pub_path = p.with_extension("pub");
            if pub_path.is_file() {
                std::fs::read_to_string(pub_path).ok()
            } else {
                None
            }
        })
        .unwrap_or_default();
    let (fingerprint, comment) = ssh_public_key_meta(&public_key);
    let key_type = detect_private_key_type(name, &private_pem);
    let record = storage
        .upsert_ssh_key_from_private_pem(
            name,
            &private_pem,
            &key_type,
            &fingerprint,
            &comment,
            &public_key,
            source_path
                .as_ref()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default()
                .as_str(),
            passphrase.as_deref(),
        )
        .map_err(|e| OmniError::new(ErrorCode::Storage, "写入 SSH 密钥库失败").with_cause(e.to_string()))?;
    *key_id = Some(record.id);
    *key_path = None;
    *pem = None;
    Ok(())
}

fn bootstrap_ssh_keys_from_ssh_dir(storage: &omnipanel_store::Storage) -> Result<(), OmniError> {
    if !storage.list_ssh_keys()?.is_empty() {
        return Ok(());
    }
    let Some(ssh_dir) = default_ssh_dir() else {
        return Ok(());
    };
    for path in list_ssh_private_key_paths_in(&ssh_dir) {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("imported-key");
        let Ok(private_pem) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !is_private_key_pem_content(&private_pem) {
            continue;
        }
        let public_key = {
            let pub_path = path.with_extension("pub");
            if pub_path.is_file() {
                std::fs::read_to_string(pub_path).unwrap_or_default()
            } else {
                String::new()
            }
        };
        let (fingerprint, comment) = ssh_public_key_meta(&public_key);
        let key_type = detect_private_key_type(name, &private_pem);
        let _ = storage.upsert_ssh_key_from_private_pem(
            name,
            &private_pem,
            &key_type,
            &fingerprint,
            &comment,
            &public_key,
            &path.to_string_lossy(),
            None,
        );
    }
    Ok(())
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

fn allocate_ssh_key_name(
    storage: &omnipanel_store::Storage,
    algo: &str,
    preferred: Option<&str>,
) -> Result<String, OmniError> {
    if let Some(name) = preferred.map(str::trim).filter(|n| !n.is_empty()) {
        let safe = sanitize_ssh_key_name(name)?;
        if storage.get_ssh_key_by_name(&safe)?.is_some() {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("密钥 `{safe}` 已存在"),
            ));
        }
        return Ok(safe);
    }

    let base = format!("id_{algo}");
    if storage.get_ssh_key_by_name(&base)?.is_none() {
        return Ok(base);
    }
    for i in 2..100 {
        let candidate = format!("{base}_{i}");
        if storage.get_ssh_key_by_name(&candidate)?.is_none() {
            return Ok(candidate);
        }
    }
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    Ok(format!("id_{algo}_{millis}"))
}

/// 列出 OmniPanel 密钥库中的 SSH 密钥。
#[tauri::command]
#[specta::specta]
pub async fn ssh_list_keys(state: State<'_, AppState>) -> Result<Vec<SshKeyInfo>, OmniError> {
    let storage = state.storage.lock().await;
    bootstrap_ssh_keys_from_ssh_dir(&storage)?;
    Ok(storage
        .list_ssh_keys()?
        .iter()
        .map(ssh_key_record_to_info)
        .collect())
}

/// 读取密钥库中公钥内容。
#[tauri::command]
#[specta::specta]
pub async fn ssh_read_key_public(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, OmniError> {
    let name = sanitize_ssh_key_name(&name)?;
    let storage = state.storage.lock().await;
    let Some(record) = storage.get_ssh_key_by_name(&name)? else {
        return Ok(None);
    };
    if record.public_key.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(record.public_key))
}

/// 读取密钥库中私钥内容。
#[tauri::command]
#[specta::specta]
pub async fn ssh_read_key_private(
    state: State<'_, AppState>,
    name: String,
) -> Result<Option<String>, OmniError> {
    use omnipanel_store::ssh_key_private_ref;

    let name = sanitize_ssh_key_name(&name)?;
    let storage = state.storage.lock().await;
    let Some(record) = storage.get_ssh_key_by_name(&name)? else {
        return Ok(None);
    };
    let content = Vault::get(&ssh_key_private_ref(&record.id)).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "读取 SSH 私钥失败").with_cause(e.to_string())
    })?;
    if !is_private_key_pem_content(&content) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "密钥库中的私钥格式无效",
        ));
    }
    Ok(Some(content))
}

/// 生成 SSH 密钥对并写入 OmniPanel 密钥库。
#[tauri::command]
#[specta::specta]
pub async fn ssh_generate_key(
    state: State<'_, AppState>,
    key_type: String,
    bits: Option<u32>,
    comment: String,
    passphrase: String,
    name: Option<String>,
) -> Result<SshKeyInfo, OmniError> {
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

    let storage = state.storage.lock().await;
    let filename = allocate_ssh_key_name(&storage, algo, name.as_deref())?;
    drop(storage);

    let temp_dir = std::env::temp_dir().join(format!(
        "omnipanel-ssh-gen-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&temp_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建临时目录失败").with_cause(e.to_string())
    })?;
    let key_path = temp_dir.join(&filename);

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
        let _ = std::fs::remove_dir_all(&temp_dir);
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(OmniError::new(ErrorCode::Ssh, "ssh-keygen 执行失败")
            .with_cause(if stderr.is_empty() {
                format!("exit code {:?}", output.status.code())
            } else {
                stderr
            }));
    }

    let private_pem = std::fs::read_to_string(&key_path).map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取生成的私钥失败").with_cause(e.to_string())
    })?;
    let public_key = std::fs::read_to_string(key_path.with_extension("pub")).unwrap_or_default();
    let (fingerprint, parsed_comment) = ssh_public_key_meta(&public_key);
    let key_type_name = detect_private_key_type(&filename, &private_pem);
    let storage = state.storage.lock().await;
    let record = storage.upsert_ssh_key_from_private_pem(
        &filename,
        &private_pem,
        &key_type_name,
        &fingerprint,
        if comment.trim().is_empty() {
            &parsed_comment
        } else {
            comment.trim()
        },
        &public_key,
        "",
        if passphrase.is_empty() {
            None
        } else {
            Some(passphrase.as_str())
        },
    )?;
    let _ = std::fs::remove_dir_all(&temp_dir);
    Ok(ssh_key_record_to_info(&record))
}

/// 导入 SSH 私钥到 OmniPanel 密钥库。
#[tauri::command]
#[specta::specta]
pub async fn ssh_import_key(
    state: State<'_, AppState>,
    name: String,
    private_key: String,
) -> Result<SshKeyInfo, OmniError> {
    let trimmed_key = private_key.trim();
    if !is_private_key_pem_content(trimmed_key) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "私钥内容无效，请粘贴 OpenSSH / PEM 格式私钥",
        ));
    }

    let name = sanitize_ssh_key_name(&name)?;
    let key_type = detect_private_key_type(&name, trimmed_key);
    let storage = state.storage.lock().await;
    if storage.get_ssh_key_by_name(&name)?.is_some() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("密钥 `{name}` 已存在"),
        ));
    }
    let record = storage.upsert_ssh_key_from_private_pem(
        &name,
        trimmed_key,
        &key_type,
        "",
        "",
        "",
        "",
        None,
    )?;
    Ok(ssh_key_record_to_info(&record))
}

/// 删除 OmniPanel 密钥库中的 SSH 密钥。
#[tauri::command]
#[specta::specta]
pub async fn ssh_delete_key(state: State<'_, AppState>, name: String) -> Result<(), OmniError> {
    let name = sanitize_ssh_key_name(&name)?;
    let storage = state.storage.lock().await;
    if !storage.delete_ssh_key_by_name(&name)? {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            format!("密钥 `{name}` 不存在"),
        ));
    }
    Ok(())
}

/// 上传快照前：将仍引用本机绝对路径的 SSH 私钥绑定到密钥库，并改写为 `keyId`。
pub(crate) fn materialize_ssh_connection_keys_for_sync(
    storage: &omnipanel_store::Storage,
) -> Result<(), OmniError> {
    for conn in storage.list_connections_by_kind(ConnectionKind::Ssh)? {
        let Ok(mut cfg) = ssh_config_from_json(&conn.config, None) else {
            continue;
        };
        if bind_ssh_identity_to_key_store(storage, &mut cfg).is_err() {
            continue;
        }
        let Ok(config_json) = serde_json::to_string(&cfg) else {
            continue;
        };
        if config_json == conn.config {
            continue;
        }
        let mut updated = conn;
        updated.config = config_json;
        storage.save_connection(&updated)?;
    }
    Ok(())
}

// ============================================================================
// 大日志文件流式预览 / 搜索 / 跟踪
//
// 设计：远端命令（sed / grep / tail -F）作为引擎，Tauri 命令做封装，
//      前端虚拟滚动按行号切片拉取；跟踪走 exec_stream + Tauri event 推送。
//      超大文件（wc -l 超时）用采样估算行数，前端改走末尾窗口模式避免 sed 全扫。
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

/// 解析日志命令可用的 SSH 会话：文件 SFTP 缓存 → 文件连接关联 SSH → SSH 连接池。
/// 注：交互式 `ssh_sessions` 存的是拥有型 `SshSession`（非 Arc），大日志路径统一走连接池 / 文件缓存。
/// 必须先解析 file→sshConnectionId，再 ensure_session；否则会对 file-* id 误走 SSH 建连并卡住。
async fn resolve_log_session(state: &AppState, id: &str) -> Result<Arc<SshSession>, OmniError> {
    {
        let sessions = state.file_sftp_sessions.lock().await;
        if let Some(session) = sessions.get(id) {
            return Ok(session.clone());
        }
    }

    // 文件连接：优先走关联的 sshConnectionId（与 file_manager::sftp_session_for 一致）
    let linked_ssh = {
        let storage = state.storage.lock().await;
        match storage.get_connection(id) {
            Ok(Some(conn)) if conn.kind == ConnectionKind::File => {
                serde_json::from_str::<serde_json::Value>(&conn.config)
                    .ok()
                    .and_then(|v| {
                        v.get("sshConnectionId")
                            .and_then(|x| x.as_str())
                            .map(|s| s.trim().to_string())
                            .filter(|s| !s.is_empty())
                    })
            }
            _ => None,
        }
    };
    if let Some(ssh_id) = linked_ssh {
        return state.ssh_pool.ensure_session(&ssh_id).await;
    }

    state.ssh_pool.ensure_session(id).await
}

/// 采样估算行数：读文件头 512KB，用「字节/换行」外推全文件（GB 级文件避免 wc -l 卡死）。
async fn estimate_line_count(session: &SshSession, path: &str, size: u64) -> Option<u64> {
    if size == 0 {
        return Some(0);
    }
    const SAMPLE_BYTES: u64 = 512 * 1024;
    let sample = SAMPLE_BYTES.min(size);
    let cmd = format!(
        "head -c {sample} {} | wc -cl",
        shell_quote_single(path)
    );
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        session.exec_capture(&cmd),
    )
    .await
    .ok()?
    .ok()?;
    if output.exit_code != 0 {
        return None;
    }
    let mut parts = output.stdout.split_whitespace();
    let lines: u64 = parts.next()?.parse().ok()?;
    let bytes: u64 = parts.next()?.parse().ok()?;
    if bytes == 0 {
        return None;
    }
    if lines == 0 {
        // 采样区无换行：按 ~80 字节/行兜底
        return Some((size / 80).max(1));
    }
    let est = ((size as f64) * (lines as f64) / (bytes as f64)).round() as u64;
    Some(est.max(1))
}

/// 打开日志会话：探测文件大小与总行数。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_open(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<LogSessionInfo, OmniError> {
    let session = resolve_log_session(&state, &id).await?;
    let size = session.sftp_file_size(&path).await.unwrap_or(0);

    // 精确行数：wc -l，3s 超时；失败则采样估算，避免 GB 级文件卡死首屏
    let wc_cmd = format!("wc -l < {}", shell_quote_single(&path));
    let (total_lines, lines_estimated) =
        match tokio::time::timeout(std::time::Duration::from_secs(3), session.exec_command(&wc_cmd))
            .await
        {
            Ok(Ok(s)) => match s.trim().parse::<u64>() {
                Ok(n) => (Some(n), false),
                Err(_) => (estimate_line_count(&session, &path, size).await, true),
            },
            _ => (estimate_line_count(&session, &path, size).await, true),
        };

    // 采样也失败时 lines_estimated=false 且 total_lines=None，前端按纯窗口模式兜底
    let lines_estimated = lines_estimated && total_lines.is_some();

    Ok(LogSessionInfo {
        size_bytes: size,
        total_lines,
        lines_estimated,
    })
}

/// 按行号范围读取（虚拟滚动按需切片，1-based）。
/// 超大文件中部/尾部的 sed 扫描可能很慢，默认 30s 超时。
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

    // 末尾加 `{safe_end}q`：打印完目标区间后立即退出，避免继续扫到 EOF（21GB 文件上可差几个数量级）
    let cmd = if start_line == 1 {
        // 文件头用 head 更快更稳
        format!(
            "head -n {} {}",
            safe_end,
            shell_quote_single(&path)
        )
    } else {
        format!(
            "sed -n '{start},{end}p;{end}q' {}",
            shell_quote_single(&path),
            start = start_line,
            end = safe_end,
        )
    };

    let session = resolve_log_session(&state, &id).await?;
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        session.exec_capture(&cmd),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(OmniError::new(
                ErrorCode::Timeout,
                "读取日志行超时（文件过大时请用末尾预览或搜索定位）",
            ));
        }
    };

    if output.exit_code != 0 {
        return Err(OmniError::new(ErrorCode::Ssh, "读取日志行失败")
            .with_cause(output.stderr.trim().to_string()));
    }
    // 统一换行：CRLF → LF，去除末尾换行后 split
    let stdout = output.stdout.replace("\r\n", "\n");
    let trimmed = stdout.strip_suffix('\n').unwrap_or(&stdout);
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
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

    let session = resolve_log_session(&state, &id).await?;
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        session.exec_capture(&cmd),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(OmniError::new(ErrorCode::Timeout, "读取日志末尾超时"));
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
///
/// 大文件持续反搜请用 `skip_matches`（tac | grep -m skip+max），
/// **禁止**对超大 before_line 做 `head -n`（会扫整文件超时）。
#[tauri::command]
#[specta::specta]
pub async fn sftp_log_search(
    state: State<'_, AppState>,
    id: String,
    path: String,
    pattern: String,
    options: Option<LogSearchOptions>,
) -> Result<Vec<LogSearchHit>, OmniError> {
    const DEFAULT_MAX: u32 = 200;
    const ABSOLUTE_MAX: u32 = 5_000;
    let opts = options.unwrap_or_default();
    let is_regex = opts.is_regex.unwrap_or(false);
    let max = opts.max_results.unwrap_or(DEFAULT_MAX).min(ABSOLUTE_MAX);
    let reverse = opts.reverse.unwrap_or(false);
    let before = opts.before_line.filter(|&n| n > 1);
    let after = opts.after_line.filter(|&n| n > 0);
    let total_hint = opts.total_lines_hint.filter(|&n| n > 0);
    let skip = opts.skip_matches.unwrap_or(0);
    let context_before = opts.context_before;
    let context_after = opts.context_after;

    let pattern_quoted = format!("'{}'", pattern.replace('\'', "'\"'\"'"));
    let path_q = shell_quote_single(&path);
    let grep_flags = if is_regex { "-E" } else { "-F" };
    let context_args = if reverse {
        String::new()
    } else {
        let mut s = String::new();
        if let Some(b) = context_before {
            s.push_str(&format!(" -B {b}"));
        }
        if let Some(a) = context_after {
            s.push_str(&format!(" -A {a}"));
        }
        s
    };

    // take = 已跳过 + 本页，从同一端一次取够再切片，避免 head -n 四亿行
    let take = skip.saturating_add(max).max(1);

    let (cmd, line_base, invert_relative) = if reverse {
        if let Some(total) = total_hint {
            // 始终从 EOF 反扫，用 -m take 截断；大文件可持续翻页
            let cmd = format!(
                "tac {path_q} | grep -n --color=never --line-buffered {grep_flags}{context_args} -m {take} {pattern_quoted}"
            );
            (cmd, Some(total), true)
        } else {
            // 无总行数：全文件 grep 后取末尾 take（可能慢，但仍比错误 head 可控）
            let cmd = format!(
                "grep -n --color=never --line-buffered {grep_flags}{context_args} {pattern_quoted} {path_q} | tail -n {take}"
            );
            (cmd, None, false)
        }
    } else if let Some(after_l) = after {
        // 有 skip：从文件头持续正搜；仅 after 无 skip 时才 tail 切片（大 after 可能慢）
        if skip > 0 {
            let cmd = format!(
                "grep -n --color=never --line-buffered {grep_flags}{context_args} -m {take} {pattern_quoted} {path_q}"
            );
            (cmd, None, false)
        } else {
            let start = after_l + 1;
            let cmd = format!(
                "tail -n +{start} {path_q} | grep -n --color=never --line-buffered {grep_flags}{context_args} -m {max} {pattern_quoted}"
            );
            (cmd, Some(after_l), false)
        }
    } else {
        // 正搜首页 / 带 skip 的持续正搜
        let cmd = format!(
            "grep -n --color=never --line-buffered {grep_flags}{context_args} -m {take} {pattern_quoted} {path_q}"
        );
        (cmd, None, false)
    };

    let session = resolve_log_session(&state, &id).await?;
    let output = match tokio::time::timeout(
        std::time::Duration::from_secs(90),
        session.exec_capture(&cmd),
    )
    .await
    {
        Ok(Ok(o)) => o,
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            return Err(OmniError::new(
                ErrorCode::Timeout,
                "搜索超时（关键词过宽时命中太密/太稀都会变慢，请换更具体的模式后点「向上」继续）",
            ));
        }
    };

    if output.exit_code != 0 && output.exit_code != 1 {
        let stderr = output.stderr.trim();
        if output.stdout.trim().is_empty() && !stderr.is_empty() {
            return Err(OmniError::new(ErrorCode::Ssh, "搜索失败").with_cause(stderr.to_string()));
        }
    }

    let mut hits = Vec::new();
    for line in output.stdout.lines() {
        let sep_idx = line.find(|c: char| c == ':' || c == '-');
        if let Some(idx) = sep_idx {
            if let Ok(rel_no) = line[..idx].parse::<u64>() {
                if rel_no == 0 {
                    continue;
                }
                let content = line[idx + 1..].to_string();
                let line_no = if let Some(base) = line_base {
                    if invert_relative {
                        base.saturating_sub(rel_no).saturating_add(1)
                    } else {
                        base.saturating_add(rel_no)
                    }
                } else {
                    rel_no
                };
                if line_no == 0 {
                    continue;
                }
                // before_line：只要更早的命中（持续向上时的保险过滤）
                if let Some(b) = before {
                    if line_no >= b {
                        continue;
                    }
                }
                // after_line：只要更晚的命中
                if let Some(a) = after {
                    if line_no <= a {
                        continue;
                    }
                }
                hits.push(LogSearchHit {
                    line_no,
                    content,
                    match_start: None,
                    match_end: None,
                });
            }
        }
    }

    if reverse {
        hits.sort_by(|a, b| b.line_no.cmp(&a.line_no));
        hits.dedup_by(|a, b| a.line_no == b.line_no);
        // tac -m take 得到的是从末尾起的前 take 条；去掉已展示的 skip 条，留下本页
        if skip > 0 {
            let skip_usize = skip as usize;
            if hits.len() > skip_usize {
                hits = hits.split_off(skip_usize);
            } else {
                hits.clear();
            }
        }
        if hits.len() > max as usize {
            hits.truncate(max as usize);
        }
    } else {
        hits.sort_by(|a, b| a.line_no.cmp(&b.line_no));
        hits.dedup_by(|a, b| a.line_no == b.line_no);
        if skip > 0 {
            let skip_usize = skip as usize;
            if hits.len() > skip_usize {
                hits = hits.split_off(skip_usize);
            } else {
                hits.clear();
            }
        }
        if hits.len() > max as usize {
            hits.truncate(max as usize);
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

    let session = resolve_log_session(&state, &id).await?;
    let handle = session
        .exec_stream(&cmd, tx)
        .await
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
