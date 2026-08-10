//! SSH 池操作与 SFTP CRUD（自桌面端 `commands/ssh.rs` 移植到 Web server）。
//!
//! 会话入口统一走 [`crate::monitoring::ensure_ssh_session`]：优先复用交互式
//! shell / Docker SSH 池，否则新建 no-shell 会话。

use std::sync::Arc;
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{SftpEntry, SshProcessDetail, SshSession};
use serde::Serialize;

use crate::monitoring::{ensure_ssh_session, ssh_pool_fetch_stats, ssh_pool_load_processes};
use crate::terminal::ServerState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCreateRunScriptOutput {
    pub remote_path: String,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostOverview {
    pub stats: omnipanel_ssh::HostSystemStats,
    pub processes: Vec<omnipanel_ssh::SshProcessInfo>,
}

/// 先查交互式会话，再走 ensure_ssh_session（与桌面 sftp_* 回落策略对齐）。
async fn resolve_sftp_session(state: &ServerState, id: &str) -> OmniResult<Arc<SshSession>> {
    {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(id) {
            if !session.is_closed() {
                return Ok(session.clone());
            }
        }
    }
    let (session, _) = ensure_ssh_session(state, id).await?;
    Ok(session)
}

pub async fn ssh_pool_exec_command(
    state: &ServerState,
    resource_id: String,
    command: String,
) -> OmniResult<SshExecOutput> {
    let (session, _) = ensure_ssh_session(state, &resource_id).await?;
    let output = session.exec_capture(&command).await?;
    Ok(SshExecOutput {
        stdout: output.stdout,
        stderr: output.stderr,
        exit_code: output.exit_code,
    })
}

pub async fn ssh_pool_process_detail(
    state: &ServerState,
    resource_id: String,
    pid: u32,
) -> OmniResult<SshProcessDetail> {
    let (session, _) = ensure_ssh_session(state, &resource_id).await?;
    session.process_detail(pid).await
}

pub async fn ssh_pool_kill_process(
    state: &ServerState,
    resource_id: String,
    pid: u32,
    signal: Option<u32>,
) -> OmniResult<()> {
    let (session, _) = ensure_ssh_session(state, &resource_id).await?;
    let sig = signal.unwrap_or(9);
    let cmd = format!("kill -s {sig} {pid} 2>/dev/null || kill -{sig} {pid}");
    session.exec_command(&cmd).await?;
    Ok(())
}

pub async fn ssh_pool_create_run_script(
    state: &ServerState,
    resource_id: String,
    name: String,
    content: String,
    args: Option<Vec<String>>,
    timeout_secs: Option<u64>,
) -> OmniResult<SshCreateRunScriptOutput> {
    let timeout = timeout_secs.unwrap_or(120).clamp(1, 600);
    let script_args = args.unwrap_or_default();
    let (session, _) = ensure_ssh_session(state, &resource_id).await?;
    let output = tokio::time::timeout(
        Duration::from_secs(timeout),
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

pub async fn ssh_pool_load_overview(
    state: &ServerState,
    resource_id: String,
) -> OmniResult<SshHostOverview> {
    let stats = ssh_pool_fetch_stats(state, &resource_id).await?;
    let processes = ssh_pool_load_processes(state, &resource_id).await?;
    Ok(SshHostOverview { stats, processes })
}

/// 释放非交互池中的会话（`docker_ssh_sessions`）；不主动断开交互式 shell。
pub async fn ssh_pool_release(state: &ServerState, resource_id: String) -> OmniResult<()> {
    let mut pool = state.docker_ssh_sessions.lock().await;
    if let Some(session) = pool.remove(&resource_id) {
        drop(pool);
        session.disconnect().await;
    }
    Ok(())
}

pub async fn ssh_pool_get_active_sessions(state: &ServerState) -> OmniResult<Vec<String>> {
    let mut ids = Vec::new();
    {
        let sessions = state.ssh_sessions.lock().await;
        for (id, session) in sessions.iter() {
            if !session.is_closed() {
                ids.push(id.clone());
            }
        }
    }
    {
        let sessions = state.docker_ssh_sessions.lock().await;
        for (id, session) in sessions.iter() {
            if !session.is_closed() && !ids.iter().any(|x| x == id) {
                ids.push(id.clone());
            }
        }
    }
    Ok(ids)
}

pub async fn ssh_pool_probe_all(_state: &ServerState) -> OmniResult<()> {
    // Web 端无桌面 SshPool 主机表后台探测；成功空返回避免前端报错。
    Ok(())
}

/// 暴露 capabilities 内的二进制下载安装。
pub async fn ssh_pool_download_install_binary(
    state: &ServerState,
    resource_id: String,
    url: String,
    remote_path: String,
) -> OmniResult<String> {
    crate::ssh_capabilities::download_install_binary_public(state, &resource_id, &url, &remote_path)
        .await
}

pub async fn sftp_list(state: &ServerState, id: String, path: String) -> OmniResult<Vec<SftpEntry>> {
    resolve_sftp_session(state, &id).await?.sftp_list(&path).await
}

pub async fn sftp_download(state: &ServerState, id: String, path: String) -> OmniResult<Vec<u8>> {
    resolve_sftp_session(state, &id)
        .await?
        .sftp_download(&path)
        .await
}

pub async fn sftp_upload(
    state: &ServerState,
    id: String,
    path: String,
    data: Vec<u8>,
) -> OmniResult<()> {
    resolve_sftp_session(state, &id)
        .await?
        .sftp_upload(&path, &data)
        .await
}

pub async fn sftp_mkdir(state: &ServerState, id: String, path: String) -> OmniResult<()> {
    resolve_sftp_session(state, &id).await?.sftp_mkdir(&path).await
}

pub async fn sftp_remove(state: &ServerState, id: String, path: String) -> OmniResult<()> {
    resolve_sftp_session(state, &id).await?.sftp_remove(&path).await
}

pub async fn sftp_rename(
    state: &ServerState,
    id: String,
    old_path: String,
    new_path: String,
) -> OmniResult<()> {
    resolve_sftp_session(state, &id)
        .await?
        .sftp_rename(&old_path, &new_path)
        .await
}

pub async fn sftp_chmod(
    state: &ServerState,
    id: String,
    path: String,
    mode: u32,
) -> OmniResult<()> {
    let session = resolve_sftp_session(state, &id).await?;
    // omnipanel-ssh 已有 sftp_chmod；失败时回退 exec
    match session.sftp_chmod(&path, mode).await {
        Ok(()) => Ok(()),
        Err(_) => {
            let cmd = format!("chmod {:o} {}", mode, path);
            session.exec_capture(&cmd).await?.ok_or_err("chmod 失败")?;
            Ok(())
        }
    }
}
