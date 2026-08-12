//! P1 Docker 命令（Web 端）。
//!
//! 与桌面端 `src-tauri/src/commands/docker` 的核心只读链路对齐：
//! 连接列表 / 探测 / 总览 / 容器列表。所有业务逻辑复用 `omnipanel-docker`
//! 的 `DockerAdapter`（本地 / 远程 / SSH / 1Panel 四种来源），
//! 不在 server crate 里重新实现。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use omnipanel_docker::{
    ContainerFilter, DockerAdapter, DockerConnectionInfo, DockerConnectionSource,
    DockerConnectionStatus, DockerContainerSummary, DockerOverview, DockerProbe,
    BtPanelAdapter, BtPanelClient, LocalDockerAdapter, OnePanelAdapter, OnePanelClient,
    SshDockerAdapter, local_engine_status,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::SshConfig;
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::state::ServerState;

/// 内建本地 Engine 连接 id（与桌面端一致，不落库、始终可用）。
pub const LOCAL_CONNECTION_ID: &str = "docker-local";

/// 列表探测超时：避免单个不可达主机拖死侧栏加载。
const LIST_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// 运行期 Docker SSH 会话池（按 docker 连接 id 索引）。
pub type DockerSshSessions = Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>;

/// 解析自 `Connection.config`（kind=docker）的 Docker 连接配置（与桌面端同构）。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnectionConfig {
    pub source: Option<String>,
    pub host: Option<String>,
    pub port: Option<u16>,
    #[serde(default)]
    pub tls: Option<bool>,
    #[serde(default)]
    pub ca_cert: Option<String>,
    #[serde(default)]
    pub client_cert: Option<String>,
    #[serde(default)]
    pub client_key: Option<String>,
    pub ssh: Option<SshConfig>,
    pub bound_ssh_connection_id: Option<String>,
    #[serde(default)]
    pub onepanel: Option<OnePanelConfigDto>,
    /// 宝塔面板配置（亦兼容 JSON 字段名 `panel`）
    #[serde(default, alias = "panel")]
    pub btpanel: Option<BtPanelConfigDto>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnePanelConfigDto {
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub insecure: bool,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtPanelConfigDto {
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub insecure: bool,
}

/// 已解析的操作目标（与桌面端 `DockerTarget` 同构）。
pub enum DockerTarget {
    Local,
    Remote(bollard::Docker),
    Ssh(Arc<omnipanel_ssh::SshSession>),
    OnePanel(OnePanelAdapter),
    BtPanel(BtPanelAdapter),
}

/// 解析连接 id 到操作目标。
pub async fn resolve_target(
    state: &ServerState,
    connection_id: &str,
) -> Result<DockerTarget, OmniError> {
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
            let session = ensure_docker_ssh(state, connection_id, cfg.ssh, cfg.bound_ssh_connection_id)
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
            let mut panel = cfg.onepanel.ok_or_else(|| {
                OmniError::new(
                    ErrorCode::InvalidInput,
                    "onepanel 类型缺少 Docker 1Panel 配置",
                )
            })?;
            if panel.api_key.trim().is_empty() {
                if let Ok(key) = omnipanel_store::Vault::get(&format!("docker-onepanel-{connection_id}"))
                {
                    panel.api_key = key;
                } else if let Some(r) = conn.credential_ref.as_deref() {
                    if let Ok(key) = omnipanel_store::Vault::get(r) {
                        panel.api_key = key;
                    }
                }
            }
            if panel.api_key.trim().is_empty() {
                return Err(OmniError::new(
                    ErrorCode::Auth,
                    "1Panel API 密钥未配置（请重新填写并保存连接）",
                ));
            }
            let bound_ssh = require_bound_ssh_id(cfg.bound_ssh_connection_id, "1Panel")?;
            let session =
                ensure_docker_ssh(state, connection_id, None, Some(bound_ssh)).await?;
            let adapter = OnePanelAdapter::new(
                OnePanelClient::new(&panel.base_url, &panel.api_key, panel.insecure),
                connection_id.to_string(),
                session,
            );
            Ok(DockerTarget::OnePanel(adapter))
        }
        Some(DockerConnectionSource::PanelAdapter) => {
            let mut panel = cfg.btpanel.ok_or_else(|| {
                OmniError::new(
                    ErrorCode::InvalidInput,
                    "宝塔类型缺少 Docker 面板配置（btpanel / panel）",
                )
            })?;
            if panel.api_key.trim().is_empty() {
                if let Ok(key) =
                    omnipanel_store::Vault::get(&format!("docker-btpanel-{connection_id}"))
                {
                    panel.api_key = key;
                } else if let Some(r) = conn.credential_ref.as_deref() {
                    if let Ok(key) = omnipanel_store::Vault::get(r) {
                        panel.api_key = key;
                    }
                }
            }
            if panel.api_key.trim().is_empty() {
                return Err(OmniError::new(
                    ErrorCode::Auth,
                    "宝塔 API 密钥未配置（请重新填写并保存连接）",
                ));
            }
            let bound_ssh = require_bound_ssh_id(cfg.bound_ssh_connection_id, "宝塔")?;
            let session =
                ensure_docker_ssh(state, connection_id, None, Some(bound_ssh)).await?;
            let client = BtPanelClient::new(&panel.base_url, &panel.api_key, panel.insecure);
            tracing::info!(
                target: "btpanel",
                connection_id = %connection_id,
                base_url = %panel.base_url,
                api_key_len = panel.api_key.len(),
                insecure = panel.insecure,
                "解析宝塔 Docker 连接"
            );
            let adapter = BtPanelAdapter::new(client, connection_id.to_string(), session);
            Ok(DockerTarget::BtPanel(adapter))
        }
        _ => Ok(DockerTarget::Local),
    }
}

/// 面板类 Docker 连接必须绑定 SSH（无面板 API 时回退）。
fn require_bound_ssh_id(
    bound: Option<String>,
    panel_label: &str,
) -> Result<String, OmniError> {
    bound
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            OmniError::new(
                ErrorCode::InvalidInput,
                format!("{panel_label} Docker 连接必须绑定 SSH 连接（用于无面板接口时的能力回退）"),
            )
        })
}

/// 从复用池获取 SSH 会话，不存在则建立并缓存（与桌面端 `ensure_docker_ssh` 等价）。
async fn ensure_docker_ssh(
    state: &ServerState,
    connection_id: &str,
    ssh: Option<SshConfig>,
    bound_id: Option<String>,
) -> Result<Arc<omnipanel_ssh::SshSession>, OmniError> {
    {
        let pool = state.docker_ssh_sessions.lock().await;
        if let Some(existing) = pool.get(connection_id) {
            return Ok(existing.clone());
        }
    }

    let bound_id = bound_id.filter(|id| !id.trim().is_empty());
    let session = if let Some(ref ssh_id) = bound_id {
        let ssh_conn = {
            let storage = state.storage.lock().await;
            storage.get_connection(ssh_id)?
        }
        .ok_or_else(|| {
            OmniError::new(
                ErrorCode::NotFound,
                format!("绑定的 SSH 连接 {ssh_id} 不存在"),
            )
        })?;
        let ssh_cfg = crate::state::resolve_ssh_config(&ssh_conn)?;
        Arc::new(omnipanel_ssh::SshSession::connect_no_shell(ssh_cfg).await?)
    } else {
        let mut ssh = ssh.ok_or_else(|| {
            OmniError::new(
                ErrorCode::InvalidInput,
                "ssh-engine 类型缺少 Docker SSH 配置",
            )
        })?;
        // 内嵌 SSH：从 Vault 回填密码 / PEM
        if let omnipanel_ssh::SshAuth::Password { ref mut password } = ssh.auth {
            if password.is_empty() {
                if let Ok(pw) =
                    omnipanel_store::Vault::get(&format!("docker-ssh-password-{connection_id}"))
                {
                    *password = pw;
                }
            }
        } else if let omnipanel_ssh::SshAuth::PrivateKey {
            ref mut pem,
            ref mut passphrase,
            ..
        } = ssh.auth
        {
            if pem.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                if let Ok(p) =
                    omnipanel_store::Vault::get(&format!("docker-ssh-pem-{connection_id}"))
                {
                    *pem = Some(p);
                }
            }
            if passphrase.as_ref().map(|s| s.is_empty()).unwrap_or(true) {
                if let Ok(pp) =
                    omnipanel_store::Vault::get(&format!("docker-ssh-passphrase-{connection_id}"))
                {
                    *passphrase = Some(pp);
                }
            }
        }
        Arc::new(omnipanel_ssh::SshSession::connect_no_shell(ssh).await?)
    };

    let mut pool = state.docker_ssh_sessions.lock().await;
    if let Some(existing) = pool.get(connection_id) {
        let existing = existing.clone();
        drop(pool);
        session.disconnect().await;
        return Ok(existing);
    }
    pool.insert(connection_id.to_string(), session.clone());
    Ok(session)
}

/// 目标 → 统一 adapter 对象。
pub fn adapter_for(target: DockerTarget) -> Result<Box<dyn DockerAdapter>, OmniError> {
    match target {
        DockerTarget::Local => Ok(Box::new(LocalDockerAdapter::connect()?)),
        DockerTarget::Remote(docker) => Ok(Box::new(LocalDockerAdapter::with_docker(docker))),
        DockerTarget::Ssh(session) => Ok(Box::new(SshDockerAdapter::new(session))),
        DockerTarget::OnePanel(adapter) => Ok(Box::new(adapter)),
        DockerTarget::BtPanel(adapter) => Ok(Box::new(adapter)),
    }
}

/// 解析连接得到 adapter（大部分命令的统一入口）。
pub async fn resolve_adapter(
    state: &ServerState,
    connection_id: &str,
) -> Result<Box<dyn DockerAdapter>, OmniError> {
    let target = resolve_target(state, connection_id).await?;
    adapter_for(target)
}

/// 带重试的 adapter 调用（SSH 会话可恢复时重建，与桌面端 `with_adapter` 等价）。
pub async fn with_adapter<T, F, Fut>(
    state: &ServerState,
    connection_id: &str,
    op: F,
) -> Result<T, OmniError>
where
    F: Fn(Box<dyn DockerAdapter>) -> Fut,
    Fut: std::future::Future<Output = Result<T, OmniError>> + Send,
{
    for attempt in 0..2 {
        let adapter = match resolve_adapter(state, connection_id).await {
            Ok(a) => a,
            Err(err) if attempt == 0 && is_ssh_recoverable(&err) => {
                // SSH 会话不可用时先清缓存再试一次
                state
                    .docker_ssh_sessions
                    .lock()
                    .await
                    .remove(connection_id);
                tracing::warn!("Docker adapter 解析失败（重试）: {err}");
                continue;
            }
            Err(err) => return Err(err),
        };
        match op(adapter).await {
            Ok(value) => return Ok(value),
            Err(err) if attempt == 0 && is_ssh_recoverable(&err) => {
                state
                    .docker_ssh_sessions
                    .lock()
                    .await
                    .remove(connection_id);
                tracing::warn!("Docker 操作失败（重试）: {err}");
                continue;
            }
            Err(err) => return Err(err),
        }
    }
    Err(OmniError::new(ErrorCode::Ssh, "SSH 会话不可用或已断开"))
}

/// 编辑 Docker 连接表单：从 Vault 取回面板 API Key。
pub async fn docker_get_connection_secret(
    state: &ServerState,
    id: String,
) -> Result<String, OmniError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(OmniError::invalid_input("连接 id 为空"));
    }
    let conn = {
        let storage = state.storage.lock().await;
        storage.get_connection(id)?
    }
    .ok_or_else(|| OmniError::not_found(format!("Docker 连接 {id} 不存在")))?;

    if !matches!(conn.kind, omnipanel_store::ConnectionKind::Docker) {
        return Err(OmniError::invalid_input("连接不是 Docker 类型"));
    }

    let cfg: DockerConnectionConfig = serde_json::from_str(&conn.config).unwrap_or_default();
    let source = cfg
        .source
        .as_deref()
        .map(DockerConnectionSource::parse)
        .unwrap_or(DockerConnectionSource::LocalEngine);

    let vault_key = match source {
        DockerConnectionSource::OnePanel => format!("docker-onepanel-{id}"),
        DockerConnectionSource::PanelAdapter => format!("docker-btpanel-{id}"),
        _ => {
            return Err(OmniError::invalid_input(
                "仅 1Panel / 宝塔连接支持回显 API Key",
            ));
        }
    };

    if let Ok(key) = omnipanel_store::Vault::get(&vault_key) {
        if !key.trim().is_empty() {
            return Ok(key);
        }
    }
    if let Some(r) = conn.credential_ref.as_deref() {
        if let Ok(key) = omnipanel_store::Vault::get(r) {
            if !key.trim().is_empty() {
                return Ok(key);
            }
        }
    }
    Ok(String::new())
}

/// 列出全部 Docker 连接（本地 Engine + 已保存连接 + 并行探测状态）。
pub async fn docker_list_connections(
    state: &ServerState,
) -> Result<Vec<DockerConnectionInfo>, String> {
    let mut out = Vec::new();

    let local_status = local_engine_status().await;
    if local_status.installed {
        out.push(DockerConnectionInfo {
            connection_id: LOCAL_CONNECTION_ID.to_string(),
            name: "本地 Docker".to_string(),
            source: DockerConnectionSource::LocalEngine,
            status: if local_status.running {
                DockerConnectionStatus::Online
            } else {
                DockerConnectionStatus::Offline
            },
            host_label: "本地 Engine".to_string(),
            environment: "local".to_string(),
            engine_version: None,
            api_version: None,
            containers_running: 0,
            containers_total: 0,
            warning_message: None,
            bound_ssh_connection_id: None,
        });
    }

    let stored = {
        let storage = state.storage.lock().await;
        storage
            .list_connections_by_kind(omnipanel_store::ConnectionKind::Docker)
            .map_err(|e| e.to_string())?
    };

    for conn in stored {
        let cfg: DockerConnectionConfig = serde_json::from_str(&conn.config).unwrap_or_default();
        let source = cfg
            .source
            .as_deref()
            .map(DockerConnectionSource::parse)
            .unwrap_or(DockerConnectionSource::LocalEngine);
        let host_label = cfg
            .host
            .or_else(|| cfg.ssh.as_ref().map(|s| format!("{}@{}", s.user, s.host)))
            .or_else(|| cfg.onepanel.as_ref().map(|p| p.base_url.clone()))
            .unwrap_or_else(|| conn.name.clone());
        let warning_message = match source {
            DockerConnectionSource::OnePanel => {
                Some("1Panel 面板模式：容器 / 镜像 exec / 镜像 push-pull / build".to_string())
            }
            _ => None,
        };
        out.push(DockerConnectionInfo {
            connection_id: conn.id,
            name: conn.name,
            source,
            status: DockerConnectionStatus::Offline,
            host_label,
            environment: conn.env_tag,
            engine_version: None,
            api_version: None,
            containers_running: 0,
            containers_total: 0,
            warning_message,
            bound_ssh_connection_id: cfg.bound_ssh_connection_id,
        });
    }

    let mut probes = Vec::new();
    for info in &out {
        let connection_id = info.connection_id.clone();
        probes.push(async move {
            let probed = tokio::time::timeout(LIST_PROBE_TIMEOUT, async {
                // 注意：这里直接 resolve_adapter（无需重试）
                let adapter = resolve_adapter_direct(state, &connection_id).await?;
                adapter.probe().await
            })
            .await;
            match probed {
                Ok(Ok(probe)) => Some((connection_id, probe)),
                Ok(Err(_)) | Err(_) => None,
            }
        });
    }
    let probe_results = futures_util::future::join_all(probes).await;

    for (connection_id, probe) in probe_results.into_iter().flatten() {
        let Some(info) = out
            .iter_mut()
            .find(|item| item.connection_id == connection_id)
        else {
            continue;
        };
        info.status = probe.status;
        if info.engine_version.is_none() {
            info.engine_version = probe.engine_version;
        }
        if info.api_version.is_none() {
            info.api_version = probe.api_version;
        }
        if info.warning_message.is_none() {
            info.warning_message = probe.warning_message;
        }
    }

    Ok(out)
}

async fn resolve_adapter_direct(
    state: &ServerState,
    connection_id: &str,
) -> Result<Box<dyn DockerAdapter>, OmniError> {
    resolve_adapter(state, connection_id).await
}

/// 探测单个连接。
pub async fn docker_probe_connection(
    state: &ServerState,
    connection_id: String,
) -> Result<DockerProbe, String> {
    with_adapter(state, &connection_id, |a| async move { a.probe().await })
        .await
        .map_err(|e| e.to_string())
}

/// 总览统计。
pub async fn docker_get_overview(
    state: &ServerState,
    connection_id: String,
) -> Result<DockerOverview, String> {
    with_adapter(state, &connection_id, |a| async move { a.overview().await })
        .await
        .map_err(|e| e.to_string())
}

/// 容器列表。
pub async fn docker_list_containers(
    state: &ServerState,
    connection_id: String,
    filter: Option<String>,
) -> Result<Vec<DockerContainerSummary>, String> {
    let filter = ContainerFilter::parse(filter.as_deref());
    with_adapter(state, &connection_id, |a| async move {
        a.list_containers(filter).await
    })
    .await
    .map_err(|e| e.to_string())
}

/// 获取本地 Docker Engine 状态。
pub async fn docker_get_local_engine_status() -> Result<omnipanel_docker::DockerLocalEngineStatus, String> {
    Ok(local_engine_status().await)
}

/// 复位 Docker SSH 会话（断开会话池缓存）。
pub async fn docker_reset_ssh_session(
    state: &ServerState,
    connection_id: String,
) -> Result<(), String> {
    invalidate_docker_ssh(state, &connection_id).await;
    Ok(())
}

/// 使 Docker SSH 会话失效（清缓存并断开独立会话）。
pub async fn invalidate_docker_ssh(state: &ServerState, connection_id: &str) {
    if let Some(session) = state.docker_ssh_sessions.lock().await.remove(connection_id) {
        tracing::warn!("移除 Docker 独立 SSH 会话: {connection_id}");
        session.disconnect().await;
    }
}

/// SSH 会话是否可恢复（与桌面端 `is_ssh_session_recoverable` 同构）。
pub fn is_ssh_recoverable(err: &OmniError) -> bool {
    // 宝塔鉴权/封禁绝不能重试：每次失败会计数，满 20 次锁 1 小时
    if matches!(err.code, ErrorCode::Auth)
        || omnipanel_docker::is_bt_auth_or_lockout_message(&err.message)
        || err
            .cause
            .as_deref()
            .is_some_and(omnipanel_docker::is_bt_auth_or_lockout_message)
    {
        return false;
    }
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

/// 1Panel 无原生 `docker logs -f`，以轮询 `container_logs` 模拟跟踪。
pub async fn onepanel_poll_container_logs<F>(
    adapter: OnePanelAdapter,
    container_id: &str,
    query: &omnipanel_docker::DockerLogQuery,
    follow: bool,
    stop: Arc<std::sync::atomic::AtomicBool>,
    mut emit: F,
) -> Result<(), OmniError>
where
    F: FnMut(omnipanel_docker::DockerLogLine),
{
    use std::sync::atomic::Ordering;
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
