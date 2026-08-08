//! P1 SSH 命令（Web 端）。
//!
//! 与桌面端 `src-tauri/src/commands/ssh.rs` 的交互式 shell 链路对齐：
//! 按连接 id 建立 `SshSession`（复用 `omnipanel-ssh`），输出经事件总线广播
//! （`terminal-output` / `terminal-event`），与本地终端共用同一套前端 xterm。

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{SshEvent, SshSession, SshSink};
use omnipanel_store::ConnectionKind;

use crate::bus::SessionEvent;
use crate::state::{ServerState, resolve_ssh_config};

static SSH_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 按连接 id 建立 SSH 会话（交互式 shell），返回会话 id。
/// 输出经事件总线广播，与本地终端一致（`terminal-output` 事件）。
pub async fn ssh_connect_connection(
    state: &ServerState,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, OmniError> {
    let conn = {
        let storage = state.storage.lock().await;
        storage
            .get_connection(&connection_id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "SSH 连接不存在"))?
    };
    if conn.kind != ConnectionKind::Ssh {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "连接不是 SSH 类型",
        ));
    }
    let config = resolve_ssh_config(&conn)?;

    let id = format!("ssh-{}", SSH_COUNTER.fetch_add(1, Ordering::Relaxed));

    let bus = state.bus.clone();
    let session_id = id.clone();
    let sink: SshSink = Arc::new(move |event: SshEvent| match event {
        SshEvent::Data(data) => bus.emit_terminal_output(&session_id, STANDARD.encode(&data)),
        SshEvent::Exit(_) | SshEvent::Disconnected => {
            bus.emit_terminal_event(&session_id, SessionEvent::Exited);
        }
    });

    let session = SshSession::connect(config, cols, rows, sink).await?;
    state
        .ssh_sessions
        .lock()
        .await
        .insert(id.clone(), Arc::new(session));
    Ok(id)
}

/// 写入远端 shell。
pub async fn ssh_write(
    state: &ServerState,
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
pub async fn ssh_resize(
    state: &ServerState,
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
pub async fn ssh_disconnect(state: &ServerState, id: String) -> Result<(), OmniError> {
    if let Some(session) = state.ssh_sessions.lock().await.remove(&id) {
        session.disconnect().await;
    }
    Ok(())
}

/// 列出已保存的 SSH 连接（与桌面端 `ssh_list_connections` 语义一致：
/// 返回连接模型 + 解析后的 host 标签）。
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub env_tag: String,
}

pub async fn ssh_list_connections(state: &ServerState) -> Result<Vec<SshConnectionInfo>, String> {
    let storage = state.storage.lock().await;
    let connections = storage
        .list_connections_by_kind(ConnectionKind::Ssh)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(connections.len());
    for conn in connections {
        let (host, port, user) = match resolve_ssh_config(&conn) {
            Ok(cfg) => (cfg.host, cfg.port, cfg.user),
            Err(_) => (String::new(), 22, String::new()),
        };
        out.push(SshConnectionInfo {
            id: conn.id,
            name: conn.name,
            host,
            port,
            user,
            env_tag: conn.env_tag,
        });
    }
    Ok(out)
}

/// 会话快照占位：Web 端 SSH 会话无 output_buffer 缓冲（与本地终端共用
/// `terminal_snapshot` 接口时返回空）。桌面端 SSH 会话同样走 `output_buffer`，
/// 这里保持接口一致，后续如需恢复远端屏幕可接入。
#[allow(dead_code)]
pub fn ssh_snapshot(_state: &ServerState, _id: &str) -> String {
    String::new()
}
