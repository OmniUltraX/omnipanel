//! Docker 模块 Tauri 命令桥接。
//!
//! 设计原则：本文件只做参数解析、连接解析与事件桥接，所有 Docker 业务逻辑都在
//! `omnipanel-docker` crate。命令统一返回 `Result<T, OmniError>`，流式数据通过
//! `docker-log` / `docker-log-end` 事件回传前端。
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::StreamExt;
use omnipanel_docker::{
    ContainerFilter, DockerAdapter, DockerBuildContext, DockerBuildResult, DockerComposeAction,
    DockerComposeProject, DockerComposeRequest, DockerComposeResult, DockerConnectionInfo,
    DockerConnectionSource, DockerConnectionStatus, DockerContainerAction, DockerContainerDetail,
    DockerContainerLogInfo, DockerContainerStats, DockerContainerSummary,
    DockerCreateContainerRequest, DockerCreateNetworkRequest, DockerCreateServiceRequest,
    DockerCreateVolumeRequest, DockerComposeProjectFiles, DockerComposeReadFilesRequest,
    DockerComposeWriteFilesRequest, DockerDaemonConfigFile, DockerFileEntry, DockerImageDetail,
    DockerImageHistoryLayer, DockerImageProgress, DockerImageSearchResult, DockerImageSummary,
    DockerLocalEngineStatus, DockerLogLine, DockerLogQuery, DockerNetworkDetail,
    DockerNetworkSummary, DockerNodeSummary, DockerOverview, DockerProbe, DockerPruneResult,
    DockerPruneVolumesResult, DockerPullResult, DockerServiceSummary, DockerStackSummary,
    DockerSystemDiskUsage, DockerVolumeDetail, DockerVolumeSummary, LocalDockerAdapter,
    OnePanelAdapter, OnePanelClient, SshDockerAdapter, bollard, local_engine_status,
    remote_engine_daemon_config, restart_local_engine, start_local_engine,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{SshConfig, SshSession};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, DockerExecSessionEntry};

/// 内建本地 Engine 连接 id（不落库，始终可用）。
const LOCAL_CONNECTION_ID: &str = "docker-local";

static LOG_STREAM_COUNTER: AtomicU64 = AtomicU64::new(1);
static EXEC_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

/// 1Panel 无原生 `docker logs -f`，以轮询 `container_logs` 模拟跟踪。
pub(crate) async fn onepanel_poll_container_logs<F>(
    adapter: OnePanelAdapter,
    container_id: &str,
    query: &DockerLogQuery,
    follow: bool,
    stop: Arc<AtomicBool>,
    mut emit: F,
) -> Result<(), OmniError>
where
    F: FnMut(DockerLogLine),
{
    let mut seen_count = 0usize;
    loop {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let lines = adapter.container_logs(container_id, query).await?;
        if lines.len() > seen_count {
            for line in &lines[seen_count..] {
                emit(line.clone());
            }
            seen_count = lines.len();
        } else if lines.len() < seen_count {
            for line in &lines {
                emit(line.clone());
            }
            seen_count = lines.len();
        }
        if !follow {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
    }
    Ok(())
}

/// 解析自 `Connection.config`（kind=docker）的 Docker 连接配置。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DockerConnectionConfig {
    source: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    #[serde(default)]
    tls: Option<bool>,
    #[serde(default)]
    ca_cert: Option<String>,
    #[serde(default)]
    client_cert: Option<String>,
    #[serde(default)]
    client_key: Option<String>,
    ssh: Option<SshConfig>,
    bound_ssh_connection_id: Option<String>,
    /// 1Panel 面板配置：baseUrl / apiKey / insecure
    #[serde(default)]
    onepanel: Option<OnePanelConfigDto>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnePanelConfigDto {
    base_url: String,
    api_key: String,
    #[serde(default)]
    insecure: bool,
}

/// 已解析的操作目标。
pub(crate) enum DockerTarget {
    Local,
    Remote(bollard::Docker),
    Ssh(Arc<SshSession>),
    OnePanel(OnePanelAdapter),
}

/// 解析连接 id 到操作目标。SSH 目标会从复用池获取或建立会话。
pub(crate) async fn resolve_target(state: &AppState, connection_id: &str) -> Result<DockerTarget, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(DockerTarget::Local);
    }

    let conn = {
        let storage = state.storage.lock().await;
        storage.get_connection(connection_id)?
    }
    .ok_or_else(|| {
        OmniError::new(
            ErrorCode::NotFound,
            format!("Docker 连接 {connection_id} 不存在"),
        )
    })?;

    let cfg: DockerConnectionConfig = serde_json::from_str(&conn.config).unwrap_or_default();

    match cfg.source.as_deref().map(DockerConnectionSource::parse) {
        Some(DockerConnectionSource::SshEngine) => {
            let session = ensure_docker_ssh(
                state,
                connection_id,
                cfg.ssh,
                cfg.bound_ssh_connection_id,
            )
            .await?;
            Ok(DockerTarget::Ssh(session))
        }
        Some(DockerConnectionSource::RemoteEngine) => {
            let host = cfg.host.ok_or_else(|| {
                OmniError::new(
                    ErrorCode::InvalidInput,
                    "remote-engine 类型缺少 Docker host 配置",
                )
            })?;
            let port = cfg
                .port
                .unwrap_or(if cfg.tls.unwrap_or(true) { 2376 } else { 2375 });
            let docker = if cfg.tls.unwrap_or(true) {
                LocalDockerAdapter::connect_remote_https(
                    &host,
                    port,
                    cfg.ca_cert.as_deref(),
                    cfg.client_cert.as_deref(),
                    cfg.client_key.as_deref(),
                )?
                .into_docker()
            } else {
                LocalDockerAdapter::connect_remote_http(&host, port)?.into_docker()
            };
            Ok(DockerTarget::Remote(docker))
        }
        Some(DockerConnectionSource::OnePanel) => {
            let panel = cfg.onepanel.as_ref().ok_or_else(|| {
                OmniError::new(
                    ErrorCode::InvalidInput,
                    "onepanel 类型缺少 Docker 1Panel 配置",
                )
            })?;
            let adapter = OnePanelAdapter::new(
                OnePanelClient::new(&panel.base_url, &panel.api_key, panel.insecure),
                connection_id.to_string(),
            );
            Ok(DockerTarget::OnePanel(adapter))
        }
        _ => Ok(DockerTarget::Local),
    }
}

/// 读取 Docker 连接绑定的 SSH 连接 id（如有）。
async fn lookup_bound_ssh_id(state: &AppState, connection_id: &str) -> Option<String> {
    let storage = state.storage.lock().await;
    storage.get_connection(connection_id).ok().flatten().and_then(|c| {
        serde_json::from_str::<DockerConnectionConfig>(&c.config)
            .ok()
            .and_then(|cfg| cfg.bound_ssh_connection_id)
            .filter(|id| !id.trim().is_empty())
    })
}

/// 清除所有绑定同一 SSH 主机的 Docker 会话缓存（释放池会话前调用）。
async fn clear_docker_ssh_cache_for_bound(state: &AppState, ssh_id: &str) {
    let docker_ids: Vec<String> = {
        let storage = state.storage.lock().await;
        match storage.list_connections_by_kind(omnipanel_store::ConnectionKind::Docker) {
            Ok(conns) => conns
                .into_iter()
                .filter_map(|c| {
                    let cfg: DockerConnectionConfig = serde_json::from_str(&c.config).ok()?;
                    (cfg.bound_ssh_connection_id.as_deref() == Some(ssh_id)).then_some(c.id)
                })
                .collect(),
            Err(_) => Vec::new(),
        }
    };
    let mut pool = state.docker_ssh_sessions.lock().await;
    for id in docker_ids {
        pool.remove(&id);
    }
}

/// 从复用池获取 SSH 会话，不存在则建立并缓存。
///
/// 绑定了 SSH 主机时优先复用 `ssh_pool` 会话（与 UI「复用凭据与会话」一致），
/// 避免切换 Docker 模块时再开一条 TCP 导致远端 MaxStartups / 会话数打满被 RST。
pub(crate) async fn ensure_docker_ssh(
    state: &AppState,
    connection_id: &str,
    ssh: Option<SshConfig>,
    bound_id: Option<String>,
) -> Result<Arc<SshSession>, OmniError> {
    {
        let pool = state.docker_ssh_sessions.lock().await;
        if let Some(existing) = pool.get(connection_id) {
            return Ok(existing.clone());
        }
    }

    // 与 ssh_pool.ensure_session 类似：串行化同一 Docker 连接的建连
    let connect_lock = {
        static LOCKS: std::sync::OnceLock<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
            std::sync::OnceLock::new();
        let locks = LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
        let mut map = locks.lock().await;
        map.entry(connection_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let _connect_guard = connect_lock.lock().await;

    {
        let pool = state.docker_ssh_sessions.lock().await;
        if let Some(existing) = pool.get(connection_id) {
            return Ok(existing.clone());
        }
    }

    let bound_id = bound_id.filter(|id| !id.trim().is_empty());

    let session = if let Some(ref ssh_id) = bound_id {
        tracing::info!("Docker 连接 {connection_id} 复用 SSH 池会话 {ssh_id}");
        state.ssh_pool.ensure_session(ssh_id).await?
    } else {
        let ssh = ssh.ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "ssh-engine 类型缺少 Docker SSH 配置")
        })?;
        Arc::new(SshSession::connect_no_shell(ssh).await?)
    };

    let mut pool = state.docker_ssh_sessions.lock().await;
    // 并发建连时后完成的一方复用已写入的会话，避免覆盖并泄漏 TCP。
    if let Some(existing) = pool.get(connection_id) {
        let existing = existing.clone();
        drop(pool);
        // 仅断开「独立建连」的多余会话；绑定池会话由 ssh_pool 统一管理，不可 disconnect。
        if bound_id.is_none() {
            session.disconnect().await;
        }
        return Ok(existing);
    }
    pool.insert(connection_id.to_string(), session.clone());
    Ok(session)
}

pub(crate) async fn invalidate_docker_ssh(state: &AppState, connection_id: &str) {
    let bound_id = lookup_bound_ssh_id(state, connection_id).await;

    if let Some(ssh_id) = bound_id {
        tracing::warn!("使 Docker 绑定的 SSH 池会话失效: docker={connection_id} ssh={ssh_id}");
        clear_docker_ssh_cache_for_bound(state, &ssh_id).await;
        // 共享会话只从池释放；不要对 docker 缓存里的 Arc 单独 disconnect，以免误伤池内引用。
        state.ssh_pool.release_session(&ssh_id).await;
        return;
    }

    if let Some(session) = state.docker_ssh_sessions.lock().await.remove(connection_id) {
        tracing::warn!("移除 Docker 独立 SSH 会话: {connection_id}");
        session.disconnect().await;
    }
}

pub(crate) fn is_ssh_session_recoverable(err: &OmniError) -> bool {
    match err.code {
        ErrorCode::Ssh | ErrorCode::Connection | ErrorCode::Terminal => true,
        ErrorCode::Auth => false,
        _ => {
            let msg = err.message.to_lowercase();
            let cause = err.cause.as_deref().unwrap_or("").to_lowercase();

            let recoverable_patterns = [
                "too many open sessions",
                "channel open failure",
                "channel send",
                "connection reset",
                "connection closed",
                "connection is closed",
                "broken pipe",
                "input device is not a tty",
                "not a tty",
                // Windows WSAECONNRESET / 中文系统文案
                "10054",
                "强迫关闭",
                "forcibly closed",
                "forcible",
            ];

            recoverable_patterns
                .iter()
                .any(|pattern| msg.contains(pattern) || cause.contains(pattern))
        }
    }
}

pub(crate) async fn with_adapter<T, F, Fut>(
    state: &AppState,
    connection_id: &str,
    op: F,
) -> Result<T, OmniError>
where
    F: Fn(Box<dyn DockerAdapter>) -> Fut,
    Fut: std::future::Future<Output = Result<T, OmniError>> + Send,
{
    for attempt in 0..2 {
        let target = match resolve_target(state, connection_id).await {
            Ok(target) => target,
            Err(err) if attempt == 0 && is_ssh_session_recoverable(&err) => {
                invalidate_docker_ssh(state, connection_id).await;
                continue;
            }
            Err(err) => return Err(err),
        };
        let adapter = adapter_for(target)?;
        match op(adapter).await {
            Ok(value) => return Ok(value),
            Err(err) if attempt == 0 && is_ssh_session_recoverable(&err) => {
                invalidate_docker_ssh(state, connection_id).await;
                continue;
            }
            Err(err) => return Err(err),
        }
    }
    Err(OmniError::new(ErrorCode::Ssh, "SSH 会话不可用或已断开"))
}

/// 目标 → 统一 adapter 对象。
pub(crate) fn adapter_for(target: DockerTarget) -> Result<Box<dyn DockerAdapter>, OmniError> {
    match target {
        DockerTarget::Local => Ok(Box::new(LocalDockerAdapter::connect()?)),
        DockerTarget::Remote(docker) => Ok(Box::new(LocalDockerAdapter::with_docker(docker))),
        DockerTarget::Ssh(session) => Ok(Box::new(SshDockerAdapter::new(session))),
        DockerTarget::OnePanel(adapter) => Ok(Box::new(adapter)),
    }
}

/// 解析连接得到 adapter（大部分命令的统一入口）。
pub(crate) async fn resolve_adapter(
    state: &AppState,
    connection_id: &str,
) -> Result<Box<dyn DockerAdapter>, OmniError> {
    let target = resolve_target(state, connection_id).await?;
    adapter_for(target)
}


mod connection;
mod containers;
mod logs;
mod images;
mod exec;
mod compose;
mod networks;
mod volumes;
mod ssh_detect;
mod swarm;
mod sidebar_cache;

pub use connection::*;
pub use containers::*;
pub use logs::*;
pub use images::*;
pub use exec::*;
pub use compose::*;
pub use networks::*;
pub use volumes::*;
pub use ssh_detect::*;
pub use swarm::*;
pub use sidebar_cache::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_error_is_recoverable() {
        let err = OmniError::new(ErrorCode::Ssh, "SSH exec 通道失败");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Ssh, "PTY 请求失败");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Ssh, "SFTP 通道失败");
        assert!(is_ssh_session_recoverable(&err));
    }

    #[test]
    fn connection_error_is_recoverable() {
        let err = OmniError::new(ErrorCode::Connection, "SSH 连接失败");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Connection, "连接被重置");
        assert!(is_ssh_session_recoverable(&err));
    }

    #[test]
    fn windows_connreset_cause_is_recoverable() {
        let err = OmniError::new(ErrorCode::Internal, "底层 IO 失败").with_cause(
            "远程主机强迫关闭了一个现有的连接。 (os error 10054)",
        );
        assert!(is_ssh_session_recoverable(&err));
    }

    #[test]
    fn terminal_error_is_recoverable() {
        let err = OmniError::new(ErrorCode::Terminal, "终端错误");
        assert!(is_ssh_session_recoverable(&err));
    }

    #[test]
    fn auth_error_is_not_recoverable() {
        let err = OmniError::new(ErrorCode::Auth, "认证失败");
        assert!(!is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Auth, "密码错误");
        assert!(!is_ssh_session_recoverable(&err));
    }

    #[test]
    fn internal_error_with_recoverable_pattern_is_recoverable() {
        let err = OmniError::new(ErrorCode::Internal, "something wrong")
            .with_cause("Too many open sessions");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "channel open failure");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "打开 SSH exec 通道失败")
            .with_cause("Channel send error");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "Connection reset by peer");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "connection is closed");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "broken pipe error");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "input device is not a TTY");
        assert!(is_ssh_session_recoverable(&err));
    }

    #[test]
    fn internal_error_without_recoverable_pattern_is_not_recoverable() {
        let err = OmniError::new(ErrorCode::Internal, "some random error");
        assert!(!is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "permission denied");
        assert!(!is_ssh_session_recoverable(&err));
    }

    #[test]
    fn case_insensitive_pattern_matching() {
        let err = OmniError::new(ErrorCode::Internal, "CONNECTION RESET");
        assert!(is_ssh_session_recoverable(&err));

        let err = OmniError::new(ErrorCode::Internal, "Broken Pipe");
        assert!(is_ssh_session_recoverable(&err));
    }

    #[test]
    fn not_found_error_is_not_recoverable() {
        let err = OmniError::new(ErrorCode::NotFound, "resource not found");
        assert!(!is_ssh_session_recoverable(&err));
    }
}
