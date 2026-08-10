//! P1 SSH 命令（Web 端）。
//!
//! 与桌面端 `src-tauri/src/commands/ssh.rs` 的交互式 shell 链路对齐：
//! 按连接 id 建立 `SshSession`（复用 `omnipanel-ssh`），输出经事件总线广播
//! （`terminal-output` / `terminal-event`），与本地终端共用同一套前端 xterm。

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_core::output_buffer;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{
    find_ssh_config_entry, load_ssh_config_hosts, ssh_config_to_connect_config, SshConfig,
    SshConfigEntry, SshEvent, SshProcessInfo, SshSession, SshSink,
};
use omnipanel_store::ConnectionKind;
use serde::Serialize;

use crate::bus::SessionEvent;
use crate::monitoring::ensure_ssh_session;
use crate::ssh_tmux::{host_identity, AttachOutcome};
use crate::state::{resolve_ssh_config, ServerState};

static SSH_COUNTER: AtomicU64 = AtomicU64::new(1);

fn next_ssh_id() -> String {
    format!("ssh-{}", SSH_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// 建立 SSH 连接并请求交互式 shell（支持 tmux auto/always/never）。
pub async fn ssh_connect(
    state: &ServerState,
    config: SshConfig,
    cols: u16,
    rows: u16,
    pane_id: Option<u32>,
) -> Result<String, OmniError> {
    let id = next_ssh_id();

    let tmux_mode = state
        .terminal_tmux_mode
        .lock()
        .map(|m| m.clone())
        .unwrap_or_else(|_| "auto".to_string());

    if tmux_mode == "never" {
        return connect_direct(
            state,
            config,
            cols,
            rows,
            id,
            Some("disabled_by_user".to_string()),
        )
        .await;
    }

    let fallback_reason = match state
        .tmux
        .attach(
            &state.bus,
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
        Ok(AttachOutcome::Attached) => return Ok(id),
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

    connect_direct(state, config, cols, rows, id, fallback_reason).await
}

/// 建立一 Tab 一连接的直连 shell（tmux 不可用时的回退路径）。
pub async fn connect_direct(
    state: &ServerState,
    config: SshConfig,
    cols: u16,
    rows: u16,
    id: String,
    fallback_reason: Option<String>,
) -> Result<String, OmniError> {
    let bus = state.bus.clone();
    let buffers = state.output_buffers.clone();
    let session_id = id.clone();
    let sink: SshSink = Arc::new(move |event: SshEvent| match event {
        SshEvent::Data(data) => {
            output_buffer::append(&buffers, &session_id, &data);
            bus.emit_terminal_output(&session_id, STANDARD.encode(&data));
        }
        SshEvent::Exit(_) | SshEvent::Disconnected => {
            bus.emit_terminal_event(&session_id, SessionEvent::Exited);
        }
    });

    let host = host_identity(&config);
    let session = SshSession::connect(config, cols, rows, sink).await?;
    state
        .ssh_sessions
        .lock()
        .await
        .insert(id.clone(), Arc::new(session));
    state.tmux.record_direct(&id, host, fallback_reason).await;
    Ok(id)
}

/// 按连接 id 建立 SSH 会话（交互式 shell），返回会话 id。
pub async fn ssh_connect_connection(
    state: &ServerState,
    connection_id: String,
    cols: u16,
    rows: u16,
    pane_id: Option<u32>,
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
    ssh_connect(state, config, cols, rows, pane_id).await
}

/// 写入远端 shell。
pub async fn ssh_write(
    state: &ServerState,
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
pub async fn ssh_resize(
    state: &ServerState,
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
pub async fn ssh_disconnect(state: &ServerState, id: String) -> Result<(), OmniError> {
    if state.tmux.detach(&id).await {
        return Ok(());
    }
    if let Some(session) = state.ssh_sessions.lock().await.remove(&id) {
        session.disconnect().await;
    }
    Ok(())
}

/// 读取 `~/.ssh/config` 中的 Host 条目。
pub async fn ssh_list_config_hosts() -> Result<Vec<SshConfigEntry>, OmniError> {
    load_ssh_config_hosts()
}

/// 按 `~/.ssh/config` 中的 Host 别名建立连接。
pub async fn ssh_connect_config_host(
    state: &ServerState,
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
pub async fn ssh_process_list(
    state: &ServerState,
    id: String,
) -> Result<Vec<SshProcessInfo>, OmniError> {
    let sessions = state.ssh_sessions.lock().await;
    if let Some(session) = sessions.get(&id) {
        return session.process_list().await;
    }
    drop(sessions);
    let (session, _) = ensure_ssh_session(state, &id).await?;
    session.process_list().await
}

/// 列出已保存的 SSH 连接。
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

/// SSH 主机连接状态快照（Web 端基于活跃会话简化实现）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatusEvent {
    pub resource_id: String,
    pub status: String,
    pub error: Option<String>,
}

pub async fn ssh_pool_get_statuses(state: &ServerState) -> Result<Vec<PoolStatusEvent>, OmniError> {
    let storage = state.storage.lock().await;
    let connections = storage.list_connections_by_kind(ConnectionKind::Ssh)?;
    drop(storage);

    let active: std::collections::HashSet<String> = {
        let mut ids = std::collections::HashSet::new();
        {
            let sessions = state.ssh_sessions.lock().await;
            for (id, session) in sessions.iter() {
                if !session.is_closed() {
                    ids.insert(id.clone());
                }
            }
        }
        {
            let sessions = state.docker_ssh_sessions.lock().await;
            for (id, session) in sessions.iter() {
                if !session.is_closed() {
                    ids.insert(id.clone());
                }
            }
        }
        ids
    };

    Ok(connections
        .into_iter()
        .map(|conn| {
            let connected = active.contains(&conn.id);
            PoolStatusEvent {
                resource_id: conn.id,
                status: if connected {
                    "connected".to_string()
                } else {
                    "idle".to_string()
                },
                error: None,
            }
        })
        .collect())
}

#[allow(dead_code)]
pub fn ssh_snapshot(_state: &ServerState, _id: &str) -> String {
    String::new()
}
