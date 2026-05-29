use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{SftpEntry, SshConfig, SshEvent, SshSession, SshSink};
use tauri::{Emitter, State};

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

/// 列出远端目录。
#[tauri::command]
#[specta::specta]
pub async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<Vec<SftpEntry>, OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))?;
    session.sftp_list(&path).await
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
    let session = sessions
        .get(&id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))?;
    session.sftp_download(&path).await
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
    let session = sessions
        .get(&id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))?;
    session.sftp_upload(&path, &data).await
}
