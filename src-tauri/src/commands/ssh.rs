use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{
    SftpEntry, SshConfig, SshConfigEntry, SshEvent, SshProcessInfo, SshSession, SshSink, find_ssh_config_entry,
    load_ssh_config_hosts, ssh_config_to_connect_config,
};
use tauri::{Emitter, State};

use crate::background::{HostSystemStats, SshHostOverview};
use crate::output_buffer;
use crate::state::AppState;

static SSH_COUNTER: AtomicU64 = AtomicU64::new(1);

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
pub async fn ssh_pool_release(state: State<'_, AppState>, resource_id: String) -> Result<(), OmniError> {
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
    pool_session(&state, &id).await?.sftp_upload(&path, &data).await
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
    let entry = find_ssh_config_entry(&alias)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 配置中未找到 Host `{alias}`")))?;
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
 