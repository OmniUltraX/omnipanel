//! tmux 相关 IPC 命令（对接 [`crate::ssh_tmux::TmuxManager`]）。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::tmux::{self, TmuxSessionInfo, TmuxWindowInfo};
use omnipanel_store::ConnectionKind;

use crate::monitoring::ensure_ssh_session;
use crate::ssh::connect_direct;
use crate::ssh_tmux::{host_identity, AttachOutcome, SshTerminalInfo, TmuxTabStat};
use crate::state::{resolve_ssh_config, ServerState};

pub async fn set_terminal_tmux_mode(state: &ServerState, mode: String) -> OmniResult<()> {
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

pub async fn invalidate_tmux_cache(state: &ServerState) -> OmniResult<()> {
    state.tmux.invalidate_all().await;
    Ok(())
}

pub async fn ssh_terminal_info(state: &ServerState, id: String) -> OmniResult<SshTerminalInfo> {
    state
        .tmux
        .info(&id)
        .await
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("SSH 会话 {id} 不存在")))
}

pub async fn ssh_terminal_set_direct_mode(
    state: &ServerState,
    id: String,
    cols: u16,
    rows: u16,
) -> OmniResult<()> {
    let config = state.tmux.config_of(&id).await.ok_or_else(|| {
        OmniError::new(ErrorCode::NotFound, format!("会话 {id} 不在 tmux 模式"))
    })?;
    state.tmux.detach(&id).await;
    connect_direct(
        state,
        config,
        cols,
        rows,
        id,
        Some("用户手动切换为直连模式".to_string()),
    )
    .await?;
    Ok(())
}

pub async fn ssh_tmux_capture_pane(
    state: &ServerState,
    id: String,
    history_lines: u32,
) -> OmniResult<String> {
    let data = state.tmux.capture_pane(&id, history_lines).await?;
    Ok(STANDARD.encode(&data))
}

pub async fn ssh_tmux_list_sessions(
    state: &ServerState,
    connection_id: String,
) -> OmniResult<Vec<TmuxSessionInfo>> {
    let (session, _) = ensure_ssh_session(state, &connection_id).await?;
    let out = session.exec_capture(&tmux::list_sessions_shell()).await?;
    if out.exit_code != 0 {
        return Ok(Vec::new());
    }
    Ok(out
        .stdout
        .lines()
        .filter_map(|line| tmux::parse_session_line(line.as_bytes()))
        .collect())
}

pub async fn ssh_tmux_list_windows(
    state: &ServerState,
    connection_id: String,
    session_name: String,
) -> OmniResult<Vec<TmuxWindowInfo>> {
    let (session, _) = ensure_ssh_session(state, &connection_id).await?;
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

pub async fn ssh_tmux_tab_stats(
    state: &ServerState,
    connection_id: String,
) -> OmniResult<Vec<TmuxTabStat>> {
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
    let host_key = host_identity(&config);
    Ok(state.tmux.tab_stats_for_host(&host_key).await)
}

pub async fn ssh_tmux_kill_session(
    state: &ServerState,
    connection_id: String,
    session_name: String,
) -> OmniResult<()> {
    let (session, _) = ensure_ssh_session(state, &connection_id).await?;
    let out = session
        .exec_capture(&tmux::kill_session_shell(&session_name))
        .await?;
    if out.exit_code != 0 {
        let msg = if out.stderr.trim().is_empty() {
            out.stdout.trim().to_string()
        } else {
            out.stderr.trim().to_string()
        };
        return Err(OmniError::new(
            ErrorCode::Ssh,
            format!("终止 tmux 会话失败: {msg}"),
        ));
    }
    Ok(())
}

pub async fn ssh_tmux_attach_session(
    state: &ServerState,
    connection_id: String,
    session_name: String,
    cols: u16,
    rows: u16,
    pane_id: Option<u32>,
) -> OmniResult<String> {
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
    let id = format!(
        "ssh-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );

    match state
        .tmux
        .attach(
            &state.bus,
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
