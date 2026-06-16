//! Docker 模块 Tauri 命令桥接。
//!
//! 设计原则：本文件只做参数解析、连接解析与事件桥接，所有 Docker 业务逻辑都在
//! `omnipanel-docker` crate。命令统一返回 `Result<T, OmniError>`，流式数据通过
//! `docker-log` / `docker-log-end` 事件回传前端。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::StreamExt;
use omnipanel_docker::{
    ContainerFilter, DockerAdapter, DockerBuildContext, DockerBuildResult, DockerComposeAction,
    DockerComposeProject, DockerComposeRequest, DockerComposeResult, DockerConnectionInfo,
    DockerConnectionSource, DockerConnectionStatus, DockerContainerAction, DockerContainerDetail,
    DockerContainerStats, DockerContainerSummary, DockerCreateContainerRequest,
    DockerCreateNetworkRequest, DockerCreateServiceRequest, DockerCreateVolumeRequest,
    DockerFileEntry, DockerImageDetail, DockerImageHistoryLayer, DockerImageProgress,
    DockerImageSummary, DockerLogLine, DockerNetworkDetail, DockerNetworkSummary,
    DockerLocalEngineStatus, DockerNodeSummary, DockerOverview, DockerProbe, DockerPruneResult, DockerPruneVolumesResult,
    DockerPullResult, DockerServiceSummary, DockerStackSummary, DockerSystemDiskUsage,
    DockerVolumeDetail, DockerVolumeSummary, LocalDockerAdapter, OnePanelAdapter, OnePanelClient, SshDockerAdapter,
    local_engine_status, start_local_engine,
    bollard,
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
    /// 1Panel 专用：baseUrl / apiKey / insecure。
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
enum DockerTarget {
    Local,
    Remote(bollard::Docker),
    Ssh(Arc<SshSession>),
    OnePanel(OnePanelAdapter),
}

/// 解析连接 id 到操作目标。SSH 目标会从复用池获取或建立会话。
async fn resolve_target(state: &AppState, connection_id: &str) -> Result<DockerTarget, OmniError> {
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
            let ssh = cfg.ssh.ok_or_else(|| {
                OmniError::new(
                    ErrorCode::InvalidInput,
                    "ssh-engine 类型的 Docker 连接缺少 SSH 配置",
                )
            })?;
            let session = ensure_docker_ssh(state, connection_id, ssh).await?;
            Ok(DockerTarget::Ssh(session))
        }
        Some(DockerConnectionSource::RemoteEngine) => {
            let host = cfg.host.ok_or_else(|| {
                OmniError::new(
                    ErrorCode::InvalidInput,
                    "remote-engine 类型的 Docker 连接缺少 host 字段",
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
                    "onepanel 类型的 Docker 连接缺少 1Panel 配置",
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

/// 从复用池获取 SSH 会话，优先复用 SSH 模块已有的连接。
///
/// 复用策略：
/// 1. Docker 专用池 (`docker_ssh_sessions`) 已有缓存 → 直接返回
/// 2. `bound_ssh_connection_id` 存在 → 尝试从 SSH 连接池获取已有会话
/// 3. 以上都没有 → 建立新连接并缓存到 Docker 专用池
async fn ensure_docker_ssh(
    state: &AppState,
    connection_id: &str,
    ssh: SshConfig,
) -> Result<Arc<SshSession>, OmniError> {
    // 1. Docker 专用池命中
    {
        let pool = state.docker_ssh_sessions.lock().await;
        if let Some(existing) = pool.get(connection_id) {
            return Ok(existing.clone());
        }
    }

    // 2. 绑定 SSH 连接时复用 SSH 模块连接池中的已有会话
    let bound_id: Option<String> = {
        let storage = state.storage.lock().await;
        storage.get_connection(connection_id)?.and_then(|c| {
            serde_json::from_str::<DockerConnectionConfig>(&c.config)
                .ok()
                .and_then(|cfg| cfg.bound_ssh_connection_id)
        })
    };

    if let Some(ref ssh_id) = bound_id {
        match state.ssh_pool.ensure_session(ssh_id).await {
            Ok(pool_session) => {
                tracing::info!("Docker 连接 {connection_id} 复用 SSH 池会话 {ssh_id}");
                let mut pool = state.docker_ssh_sessions.lock().await;
                pool.insert(connection_id.to_string(), pool_session.clone());
                return Ok(pool_session);
            }
            Err(e) => {
                tracing::warn!(
                    "Docker 连接 {connection_id} 无法复用 SSH 池 {ssh_id}，将建立独立 exec 会话: {}",
                    e.message
                );
            }
        }
    }

    // 3. 建立 exec-only 会话（无交互 shell，避免占用额外 channel）
    let session = Arc::new(SshSession::connect_no_shell(ssh).await?);
    let mut pool = state.docker_ssh_sessions.lock().await;
    pool.insert(connection_id.to_string(), session.clone());
    Ok(session)
}

/// 目标 → 统一 adapter 对象。
fn adapter_for(target: DockerTarget) -> Result<Box<dyn DockerAdapter>, OmniError> {
    match target {
        DockerTarget::Local => Ok(Box::new(LocalDockerAdapter::connect()?)),
        DockerTarget::Remote(docker) => Ok(Box::new(LocalDockerAdapter::with_docker(docker))),
        DockerTarget::Ssh(session) => Ok(Box::new(SshDockerAdapter::new(session))),
        DockerTarget::OnePanel(adapter) => Ok(Box::new(adapter)),
    }
}

/// 解析连接得到 adapter（大部分命令的统一入口）。
async fn resolve_adapter(
    state: &AppState,
    connection_id: &str,
) -> Result<Box<dyn DockerAdapter>, OmniError> {
    let target = resolve_target(state, connection_id).await?;
    adapter_for(target)
}

/// 列出全部 Docker 连接：内建本地 Engine + 已保存的 docker 类型连接。
/// 不在此处做连通性探测（避免逐一连接远端阻塞），状态由 `docker_probe_connection` 按需更新。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<DockerConnectionInfo>, OmniError> {
    let mut out = vec![DockerConnectionInfo {
        connection_id: LOCAL_CONNECTION_ID.to_string(),
        name: "本地 Docker".to_string(),
        source: DockerConnectionSource::LocalEngine,
        status: DockerConnectionStatus::Offline,
        host_label: "本机 Engine".to_string(),
        environment: "local".to_string(),
        engine_version: None,
        api_version: None,
        containers_running: 0,
        containers_total: 0,
        warning_message: None,
        bound_ssh_connection_id: None,
    }];

    let stored = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(omnipanel_store::ConnectionKind::Docker)?
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
            DockerConnectionSource::OnePanel => Some(
                "1Panel 适配器：暂不支持日志流式 / 容器 exec / 镜像 push-pull / build".to_string(),
            ),
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

    Ok(out)
}

/// 探测连接连通性与能力。
#[tauri::command]
#[specta::specta]
pub async fn docker_probe_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerProbe, OmniError> {
    resolve_adapter(&state, &connection_id).await?.probe().await
}

/// 本地 Docker Engine 安装与运行状态（仅本机）。
#[tauri::command]
#[specta::specta]
pub async fn docker_get_local_engine_status() -> Result<DockerLocalEngineStatus, OmniError> {
    Ok(local_engine_status().await)
}

/// 一键启动本地 Docker Desktop（已安装但未运行时）。
#[tauri::command]
#[specta::specta]
pub async fn docker_start_local_engine() -> Result<(), OmniError> {
    start_local_engine()
}

/// 连接总览统计。
#[tauri::command]
#[specta::specta]
pub async fn docker_get_overview(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerOverview, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .overview()
        .await
}

/// `docker system df` 磁盘占用汇总。
#[tauri::command]
#[specta::specta]
pub async fn docker_get_system_disk_usage(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerSystemDiskUsage, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .system_disk_usage()
        .await
}

/// 容器列表。`filter` 取 all/running/stopped。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_containers(
    state: State<'_, AppState>,
    connection_id: String,
    filter: Option<String>,
) -> Result<Vec<DockerContainerSummary>, OmniError> {
    let filter = ContainerFilter::parse(filter.as_deref());
    resolve_adapter(&state, &connection_id)
        .await?
        .list_containers(filter)
        .await
}

/// 容器详情。
#[tauri::command]
#[specta::specta]
pub async fn docker_inspect_container(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
) -> Result<DockerContainerDetail, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .inspect_container(&container_id)
        .await
}

/// 容器生命周期动作：start/stop/restart/kill/pause/unpause/remove。
/// 高风险动作（kill/remove）应在前端完成二次确认后再调用。
#[tauri::command]
#[specta::specta]
pub async fn docker_container_action(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    action: String,
) -> Result<(), OmniError> {
    let parsed = DockerContainerAction::parse(&action).ok_or_else(|| {
        OmniError::new(ErrorCode::InvalidInput, format!("未知容器动作: {action}"))
    })?;
    if parsed.is_destructive() {
        tracing::info!(
            connection = %connection_id,
            container = %container_id,
            action = %action,
            "执行高风险 Docker 容器动作"
        );
    }
    resolve_adapter(&state, &connection_id)
        .await?
        .container_action(&container_id, parsed)
        .await
}

/// 一次性拉取容器日志（tail 行）。流式跟随用 `docker_stream_container_logs`。
#[tauri::command]
#[specta::specta]
pub async fn docker_container_logs(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    tail: i32,
) -> Result<Vec<DockerLogLine>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .container_logs(&container_id, tail as i64)
        .await
}

/// 开始流式跟随容器日志。返回 streamId；日志行通过 `docker-log` 事件回传，
/// 结束/出错通过 `docker-log-end` 事件通知。本地 Engine 支持真正 follow；
/// SSH Engine 当前为一次性 tail（follow 后续增强）。
#[tauri::command]
#[specta::specta]
pub async fn docker_stream_container_logs(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    tail: i32,
    follow: bool,
) -> Result<String, OmniError> {
    let stream_id = format!(
        "docker-log-{}",
        LOG_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let stop = Arc::new(AtomicBool::new(false));
    state
        .docker_log_streams
        .lock()
        .await
        .insert(stream_id.clone(), stop.clone());

    let target = resolve_target(&state, &connection_id).await?;
    let app = state.app_handle.clone();
    let sid = stream_id.clone();
    let log_streams = state.docker_log_streams.clone();

    tokio::spawn(async move {
        let emit = |line: DockerLogLine| {
            let _ = app.emit(
                "docker-log",
                serde_json::json!({
                    "streamId": sid,
                    "stream": line.stream,
                    "message": line.message,
                }),
            );
        };

        let result: Result<(), OmniError> = match target {
            DockerTarget::Local => match LocalDockerAdapter::connect() {
                Ok(adapter) => {
                    adapter
                        .stream_logs(&container_id, tail as i64, follow, stop, emit)
                        .await
                }
                Err(e) => Err(e),
            },
            DockerTarget::Remote(docker) => {
                let adapter = LocalDockerAdapter::with_docker(docker);
                adapter
                    .stream_logs(&container_id, tail as i64, follow, stop, emit)
                    .await
            }
            DockerTarget::Ssh(session) => {
                omnipanel_docker::ssh::stream_logs(
                    &*session,
                    &container_id,
                    tail as i64,
                    follow,
                    stop,
                    emit,
                )
                .await
            }
            DockerTarget::OnePanel(_adapter) => {
                // 1Panel 暂不支持 `docker logs -f` 流式；前端可改用 polling + container_logs。
                Err(OmniError::new(
                    ErrorCode::Internal,
                    "1Panel 适配器暂不支持日志流式订阅",
                ))
            }
        };

        let _ = app.emit(
            "docker-log-end",
            serde_json::json!({
                "streamId": sid,
                "error": result.err().map(|e| e.message),
            }),
        );
        log_streams.lock().await.remove(&sid);
    });

    Ok(stream_id)
}

/// 停止一个日志流。
#[tauri::command]
#[specta::specta]
pub async fn docker_stop_log_stream(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), OmniError> {
    if let Some(stop) = state.docker_log_streams.lock().await.remove(&stream_id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

static STATS_STREAM_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 启动容器 stats 实时流。返回 streamId；每次统计通过 `docker-stats` 事件回传，
/// 结束/出错通过 `docker-stats-end` 事件通知。
#[tauri::command]
#[specta::specta]
pub async fn docker_stream_stats(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
) -> Result<String, OmniError> {
    let stream_id = format!(
        "docker-stats-{}",
        STATS_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let stop = Arc::new(AtomicBool::new(false));
    state
        .docker_stats_streams
        .lock()
        .await
        .insert(stream_id.clone(), stop.clone());

    let target = resolve_target(&state, &connection_id).await?;
    let app = state.app_handle.clone();
    let sid = stream_id.clone();
    let stats_streams = state.docker_stats_streams.clone();
    let stop_for_task = stop.clone();

    tokio::spawn(async move {
        let sid_owned = sid.clone();
        let app_for_end = app.clone();
        let emit = move |stats: DockerContainerStats| {
            let _ = app.emit(
                "docker-stats",
                serde_json::json!({
                    "streamId": sid_owned,
                    "stats": stats,
                }),
            );
        };
        let sink: Box<dyn FnMut(DockerContainerStats) + Send> = Box::new(emit);

        let result: Result<(), OmniError> = match target {
            DockerTarget::Local => match LocalDockerAdapter::connect() {
                Ok(adapter) => {
                    adapter
                        .stream_stats(&container_id, stop_for_task.clone(), sink)
                        .await
                }
                Err(e) => Err(e),
            },
            DockerTarget::Remote(docker) => {
                let adapter = LocalDockerAdapter::with_docker(docker);
                adapter
                    .stream_stats(&container_id, stop_for_task.clone(), sink)
                    .await
            }
            DockerTarget::Ssh(session) => {
                omnipanel_docker::ssh::stream_stats(
                    &*session,
                    &container_id,
                    stop_for_task.clone(),
                    sink,
                )
                .await
            }
            DockerTarget::OnePanel(adapter) => {
                adapter
                    .stream_stats(&container_id, stop_for_task.clone(), sink)
                    .await
            }
        };

        let _ = app_for_end.emit(
            "docker-stats-end",
            serde_json::json!({
                "streamId": sid,
                "error": result.err().map(|e| e.message),
            }),
        );
        stats_streams.lock().await.remove(&sid);
    });

    Ok(stream_id)
}

/// 停止一个 stats 流。
#[tauri::command]
#[specta::specta]
pub async fn docker_stop_stats_stream(
    state: State<'_, AppState>,
    stream_id: String,
) -> Result<(), OmniError> {
    if let Some(stop) = state.docker_stats_streams.lock().await.remove(&stream_id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/// 镜像列表。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_images(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerImageSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .list_images()
        .await
}

/// 删除镜像（高风险，前端需确认）。
#[tauri::command]
#[specta::specta]
pub async fn docker_remove_image(
    state: State<'_, AppState>,
    connection_id: String,
    image_id: String,
    force: bool,
) -> Result<(), OmniError> {
    tracing::info!(connection = %connection_id, image = %image_id, force, "删除 Docker 镜像");
    resolve_adapter(&state, &connection_id)
        .await?
        .remove_image(&image_id, force)
        .await
}

/// 镜像详情（`docker inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_inspect_image(
    state: State<'_, AppState>,
    connection_id: String,
    image_id: String,
) -> Result<DockerImageDetail, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .inspect_image(&image_id)
        .await
}

/// 镜像历史层（`docker history`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_image_history(
    state: State<'_, AppState>,
    connection_id: String,
    image_id: String,
) -> Result<Vec<DockerImageHistoryLayer>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .image_history(&image_id)
        .await
}

/// 清理悬空镜像（高风险，前端需确认）。
#[tauri::command]
#[specta::specta]
pub async fn docker_prune_images(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerPruneResult, OmniError> {
    tracing::info!(connection = %connection_id, "清理 Docker 悬空镜像");
    resolve_adapter(&state, &connection_id)
        .await?
        .prune_images()
        .await
}

/// 清理构建缓存（高风险，前端需确认）。
#[tauri::command]
#[specta::specta]
pub async fn docker_prune_build_cache(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerPruneResult, OmniError> {
    tracing::info!(connection = %connection_id, "清理 Docker 构建缓存");
    resolve_adapter(&state, &connection_id)
        .await?
        .prune_build_cache()
        .await
}

/// 关闭同一 Docker 连接上所有 exec 会话（PTY 按 SSH 连接串行，须先释放旧会话）。
async fn close_docker_exec_for_connection(state: &AppState, connection_id: &str) {
    loop {
        let next = {
            let mut map = state.docker_exec_sessions.lock().await;
            let key = map
                .iter()
                .find(|(_, entry)| entry.connection_id == connection_id)
                .map(|(id, _)| id.clone());
            key.and_then(|id| map.remove(&id))
        };
        match next {
            Some(entry) => {
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(8),
                    entry.session.close(),
                )
                .await;
            }
            None => break,
        }
    }
}

/// 创建容器交互终端会话（仅本地 Engine）。返回 sessionId；
/// 终端输出复用 `terminal-output` 事件，前端可直接用 xterm 绑定该 sessionId。
#[tauri::command]
#[specta::specta]
pub async fn docker_create_exec_session(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, OmniError> {
    close_docker_exec_for_connection(&state, &connection_id).await;

    let target = resolve_target(&state, &connection_id).await?;
    let (session, output): (omnipanel_docker::DockerExecSession, _);

    match target {
        DockerTarget::Local => {
            let adapter = LocalDockerAdapter::connect()?;
            let cmd = vec![shell.unwrap_or_else(|| "/bin/sh".to_string())];
            let pair = adapter.create_exec(&container_id, cmd, cols, rows).await?;
            session = pair.0;
            output = pair.1;
        }
        DockerTarget::Remote(docker) => {
            let adapter = LocalDockerAdapter::with_docker(docker);
            let cmd = vec![shell.unwrap_or_else(|| "/bin/sh".to_string())];
            let pair = adapter.create_exec(&container_id, cmd, cols, rows).await?;
            session = pair.0;
            output = pair.1;
        }
        DockerTarget::Ssh(ssh_session) => {
            let shell_str = shell.unwrap_or_else(|| "/bin/sh".to_string());
            let pair =
                omnipanel_docker::ssh::create_exec(&*ssh_session, &container_id, &shell_str, cols, rows)
                    .await?;
            session = pair.0;
            output = pair.1;
        }
        DockerTarget::OnePanel(_adapter) => {
            return Err(OmniError::new(
                ErrorCode::Internal,
                "1Panel 适配器暂不支持 exec",
            ));
        }
    }

    // 让 `output` 在 task 外仍可借用。
    let mut output = output;

    let session_id = format!(
        "docker-exec-{}",
        EXEC_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    state
        .docker_exec_sessions
        .lock()
        .await
        .insert(
            session_id.clone(),
            DockerExecSessionEntry {
                session,
                connection_id: connection_id.clone(),
            },
        );

    let app = state.app_handle.clone();
    let sid = session_id.clone();
    let sessions = state.docker_exec_sessions.clone();
    tokio::spawn(async move {
        while let Some(item) = output.next().await {
            match item {
                Ok(bytes) => {
                    let _ = app.emit(
                        "terminal-output",
                        serde_json::json!({ "session_id": sid, "data": STANDARD.encode(&bytes) }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(
            "terminal-event",
            serde_json::json!({ "session_id": sid, "event": "exited" }),
        );
        if let Some(entry) = sessions.lock().await.remove(&sid) {
            let _ = entry.session.close().await;
        }
    });

    Ok(session_id)
}

/// 写入容器终端 stdin。
#[tauri::command]
#[specta::specta]
pub async fn docker_exec_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), OmniError> {
    let sessions = state.docker_exec_sessions.lock().await;
    let entry = sessions.get(&session_id).ok_or_else(|| {
        OmniError::new(
            ErrorCode::NotFound,
            format!("容器终端会话 {session_id} 不存在"),
        )
    })?;
    entry.session.write(&data).await
}

/// 调整容器终端尺寸。
#[tauri::command]
#[specta::specta]
pub async fn docker_exec_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), OmniError> {
    let sessions = state.docker_exec_sessions.lock().await;
    if let Some(entry) = sessions.get(&session_id) {
        entry.session.resize(cols, rows).await?;
    }
    Ok(())
}

/// 关闭容器终端会话（丢弃 stdin 写端即关闭）。
#[tauri::command]
#[specta::specta]
pub async fn docker_exec_close(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), OmniError> {
    if let Some(entry) = state.docker_exec_sessions.lock().await.remove(&session_id) {
        entry.session.close().await?;
    }
    Ok(())
}

/// 识别 Compose 项目（按容器标签聚合）。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_compose_projects(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerComposeProject>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .list_compose_projects()
        .await
}

/// 拉取镜像。进度通过 `docker_image_progress` 事件向指定 `progress_channel` 投递。
#[tauri::command]
#[specta::specta]
pub async fn docker_pull_image(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    image: String,
    progress_channel: String,
) -> Result<DockerPullResult, OmniError> {
    let adapter = resolve_adapter(&state, &connection_id).await?;
    let app_for_cb = app.clone();
    let channel = progress_channel.clone();
    let cb = move |p: DockerImageProgress| {
        let _ = app_for_cb.emit(&channel, &p);
    };
    adapter.pull_image(&image, Some(Box::new(cb) as _)).await
}

/// 推送镜像。进度通过 `docker_image_progress` 事件向指定 `progress_channel` 投递。
#[tauri::command]
#[specta::specta]
pub async fn docker_push_image(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    image: String,
    progress_channel: String,
) -> Result<DockerPullResult, OmniError> {
    let adapter = resolve_adapter(&state, &connection_id).await?;
    let app_for_cb = app.clone();
    let channel = progress_channel.clone();
    let cb = move |p: DockerImageProgress| {
        let _ = app_for_cb.emit(&channel, &p);
    };
    adapter.push_image(&image, Some(Box::new(cb) as _)).await
}

/// 给本地或远端镜像打 tag。
#[tauri::command]
#[specta::specta]
pub async fn docker_tag_image(
    state: State<'_, AppState>,
    connection_id: String,
    source: String,
    target: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .tag_image(&source, &target)
        .await
}

/// 构建镜像（Dockerfile）。进度通过 `progress_channel` 事件上报。
#[tauri::command]
#[specta::specta]
pub async fn docker_build_image(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    context: DockerBuildContext,
    progress_channel: String,
) -> Result<DockerBuildResult, OmniError> {
    let adapter = resolve_adapter(&state, &connection_id).await?;
    let app_for_cb = app.clone();
    let channel = progress_channel.clone();
    let cb = move |p: DockerImageProgress| {
        let _ = app_for_cb.emit(&channel, &p);
    };
    adapter.build_image(&context, Some(Box::new(cb) as _)).await
}

/// Compose 生命周期（up/down/restart/pull/logs）。
#[tauri::command]
#[specta::specta]
pub async fn docker_compose_action(
    state: State<'_, AppState>,
    connection_id: String,
    action: DockerComposeAction,
    request: DockerComposeRequest,
) -> Result<DockerComposeResult, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .compose_action(action, &request)
        .await
}

// -------- 网络 --------

#[tauri::command]
#[specta::specta]
pub async fn docker_list_networks(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerNetworkSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .list_networks()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_create_network(
    state: State<'_, AppState>,
    connection_id: String,
    request: DockerCreateNetworkRequest,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .create_network(&request)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_remove_network(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .remove_network(&name)
        .await
}

/// 网络详情（`docker network inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_inspect_network(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<DockerNetworkDetail, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .inspect_network(&name)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_connect_network(
    state: State<'_, AppState>,
    connection_id: String,
    network: String,
    container_id: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .connect_container_to_network(&network, &container_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_disconnect_network(
    state: State<'_, AppState>,
    connection_id: String,
    network: String,
    container_id: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .disconnect_container_from_network(&network, &container_id)
        .await
}

// -------- 卷 --------

#[tauri::command]
#[specta::specta]
pub async fn docker_list_volumes(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerVolumeSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .list_volumes()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_create_volume(
    state: State<'_, AppState>,
    connection_id: String,
    request: DockerCreateVolumeRequest,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .create_volume(&request)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_remove_volume(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
    force: bool,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .remove_volume(&name, force)
        .await
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_inspect_volume(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<DockerVolumeDetail, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .inspect_volume(&name)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_prune_volumes(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerPruneVolumesResult, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .prune_volumes()
        .await
}

// -------- 容器内文件 --------

#[tauri::command]
#[specta::specta]
pub async fn docker_list_container_dir(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    path: String,
) -> Result<Vec<DockerFileEntry>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .list_container_dir(&container_id, &path)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_read_container_file(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    path: String,
    max_bytes: i32,
) -> Result<Vec<u8>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .read_container_file(&container_id, &path, max_bytes as i64)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_write_container_file(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .write_container_file(&container_id, &path, data)
        .await
}
// Append to docker.rs — Docker auto-detection via SSH

/// Probe a remote SSH host for Docker daemon availability.
/// Returns Docker version info if found, or an error if Docker is not installed/running.
#[tauri::command]
#[specta::specta]
pub async fn docker_probe_ssh_docker(
    state: State<'_, AppState>,
    ssh_connection_id: String,
) -> Result<DockerAutoDetectResult, OmniError> {
    let session = state.ssh_pool.ensure_session(&ssh_connection_id).await?;
    Ok(probe_ssh_docker_session(&session).await)
}

/// Docker auto-detection result.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerAutoDetectResult {
    pub available: bool,
    pub version: Option<String>,
    pub os: Option<String>,
    pub containers: u32,
    pub images: u32,
    pub error: Option<String>,
}

/// List SSH connections available for Docker binding.
/// Returns connections that are in "connected" state in the SSH pool.
#[tauri::command]
#[specta::specta]
pub async fn docker_list_ssh_hosts(
    state: State<'_, AppState>,
) -> Result<Vec<SshHostInfo>, OmniError> {
    let connected_ids = state.ssh_pool.connected_ids().await;
    let storage = state.storage.lock().await;
    let mut hosts = Vec::new();

    for id in connected_ids {
        if let Ok(Some(conn)) = storage.get_connection(&id) {
            if let Ok(config) = serde_json::from_str::<omnipanel_ssh::SshConfig>(&conn.config) {
                hosts.push(SshHostInfo {
                    connection_id: conn.id,
                    name: conn.name,
                    host: config.host,
                    port: config.port,
                    user: config.user,
                });
            }
        }
    }

    Ok(hosts)
}

/// SSH host info for Docker connection binding.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshHostInfo {
    pub connection_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// 单台 SSH 主机 Docker 扫描条目。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerScanItemResult {
    pub ssh_connection_id: String,
    pub ssh_name: String,
    pub available: bool,
    pub probe: Option<DockerAutoDetectResult>,
    pub docker_connection_id: Option<String>,
    /// created | updated | unchanged | no_docker | failed
    pub action: String,
    pub error: Option<String>,
}

/// 批量扫描已配置 SSH 中的 Docker 服务汇总。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerScanResult {
    pub scanned: u32,
    pub created: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub no_docker: u32,
    pub failed: u32,
    pub items: Vec<DockerScanItemResult>,
}

fn find_docker_by_bound_ssh(
    connections: &[omnipanel_store::Connection],
    ssh_id: &str,
) -> Option<omnipanel_store::Connection> {
    connections.iter().find(|conn| {
        let cfg: DockerConnectionConfig = serde_json::from_str(&conn.config).unwrap_or_default();
        cfg.bound_ssh_connection_id.as_deref() == Some(ssh_id)
    }).cloned()
}

fn build_ssh_engine_config_json(ssh_id: &str, ssh: &SshConfig) -> String {
    serde_json::json!({
        "source": "ssh-engine",
        "host": format!("{}@{}:{}", ssh.user, ssh.host, ssh.port),
        "boundSshConnectionId": ssh_id,
        "autoScanned": true,
        "ssh": ssh,
    })
    .to_string()
}

async fn probe_ssh_docker_session(session: &SshSession) -> DockerAutoDetectResult {
    let version_output = session
        .exec_command("docker version --format '{{.Server.Version}}' 2>/dev/null")
        .await;
    let info_output = session
        .exec_command(
            "docker info --format '{{.OperatingSystem}}|{{.ServerVersion}}|{{.Containers}}|{{.Images}}' 2>/dev/null",
        )
        .await;

    match (version_output, info_output) {
        (Ok(version), Ok(info)) => {
            let parts: Vec<&str> = info.split('|').collect();
            DockerAutoDetectResult {
                available: true,
                version: Some(version.trim().to_string()),
                os: parts.first().map(|s| s.to_string()),
                containers: parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
                images: parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0),
                error: None,
            }
        }
        (_, Err(e)) | (Err(e), _) => DockerAutoDetectResult {
            available: false,
            version: None,
            os: None,
            containers: 0,
            images: 0,
            error: Some(format!("Docker not available: {}", e)),
        },
    }
}

/// 扫描全部已配置 SSH 连接中的 Docker 服务，并按需自动保存为 Docker 连接。
#[tauri::command]
#[specta::specta]
pub async fn docker_scan_ssh_docker_hosts(
    state: State<'_, AppState>,
    auto_save: bool,
) -> Result<DockerScanResult, OmniError> {
    let ssh_connections = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(omnipanel_store::ConnectionKind::Ssh)?
    };

    let existing_docker = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(omnipanel_store::ConnectionKind::Docker)?
    };

    let mut result = DockerScanResult {
        scanned: ssh_connections.len() as u32,
        created: 0,
        updated: 0,
        unchanged: 0,
        no_docker: 0,
        failed: 0,
        items: Vec::new(),
    };

    for ssh_conn in ssh_connections {
        let ssh_config: SshConfig = match serde_json::from_str(&ssh_conn.config) {
            Ok(cfg) => cfg,
            Err(e) => {
                result.failed += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id.clone(),
                    ssh_name: ssh_conn.name.clone(),
                    available: false,
                    probe: None,
                    docker_connection_id: None,
                    action: "failed".to_string(),
                    error: Some(format!("SSH 配置解析失败: {e}")),
                });
                continue;
            }
        };

        let session = match state.ssh_pool.ensure_session(&ssh_conn.id).await {
            Ok(s) => s,
            Err(e) => {
                result.failed += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id.clone(),
                    ssh_name: ssh_conn.name.clone(),
                    available: false,
                    probe: None,
                    docker_connection_id: None,
                    action: "failed".to_string(),
                    error: Some(e.to_string()),
                });
                continue;
            }
        };

        let probe = probe_ssh_docker_session(&session).await;
        if !probe.available {
            result.no_docker += 1;
            result.items.push(DockerScanItemResult {
                ssh_connection_id: ssh_conn.id.clone(),
                ssh_name: ssh_conn.name.clone(),
                available: false,
                probe: Some(probe),
                docker_connection_id: None,
                action: "no_docker".to_string(),
                error: None,
            });
            continue;
        }

        let mut action = "unchanged".to_string();
        let mut docker_connection_id: Option<String> = None;
        let mut error: Option<String> = None;

        if auto_save {
            let config_json = build_ssh_engine_config_json(&ssh_conn.id, &ssh_config);
            let existing = find_docker_by_bound_ssh(&existing_docker, &ssh_conn.id);
            let docker_name = format!("Docker - {}", ssh_conn.name);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or_default();

            let docker_conn = if let Some(existing) = existing {
                let mut conn = existing;
                if conn.config != config_json
                    || conn.name != docker_name
                    || conn.group != ssh_conn.group
                    || conn.env_tag != ssh_conn.env_tag
                {
                    conn.config = config_json;
                    conn.name = docker_name;
                    conn.group = ssh_conn.group.clone();
                    conn.env_tag = ssh_conn.env_tag.clone();
                    conn.updated_at = now;
                    action = "updated".to_string();
                } else {
                    action = "unchanged".to_string();
                }
                conn
            } else {
                action = "created".to_string();
                omnipanel_store::Connection {
                    id: format!("docker-bound-{}", ssh_conn.id),
                    kind: omnipanel_store::ConnectionKind::Docker,
                    name: docker_name,
                    group: ssh_conn.group.clone(),
                    env_tag: ssh_conn.env_tag.clone(),
                    tags: vec![],
                    config: config_json,
                    credential_ref: None,
                    created_at: now,
                    updated_at: now,
                }
            };

            docker_connection_id = Some(docker_conn.id.clone());
            match {
                let storage = state.storage.lock().await;
                storage.save_connection(&docker_conn)
            } {
                Ok(_) => match action.as_str() {
                    "created" => result.created += 1,
                    "updated" => result.updated += 1,
                    _ => result.unchanged += 1,
                },
                Err(e) => {
                    result.failed += 1;
                    action = "failed".to_string();
                    error = Some(e.to_string());
                }
            }
        } else {
            result.unchanged += 1;
        }

        result.items.push(DockerScanItemResult {
            ssh_connection_id: ssh_conn.id,
            ssh_name: ssh_conn.name,
            available: true,
            probe: Some(probe),
            docker_connection_id,
            action,
            error,
        });
    }

    Ok(result)
}

/// 创建容器。返回新容器 ID。
#[tauri::command]
#[specta::specta]
pub async fn docker_create_container(
    state: State<'_, AppState>,
    connection_id: String,
    request: DockerCreateContainerRequest,
) -> Result<String, OmniError> {
    tracing::info!(
        connection = %connection_id,
        image = %request.image,
        name = ?request.name,
        "创建 Docker 容器"
    );
    resolve_adapter(&state, &connection_id)
        .await?
        .create_container(&request)
        .await
}

// ── Docker Swarm Commands ──────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_init(
    state: State<'_, AppState>,
    connection_id: String,
    listen_addr: Option<String>,
    advertise_addr: Option<String>,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .swarm_init(listen_addr.as_deref(), advertise_addr.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_join(
    state: State<'_, AppState>,
    connection_id: String,
    remote_addrs: Vec<String>,
    token: String,
    listen_addr: Option<String>,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .swarm_join(remote_addrs, &token, listen_addr.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_leave(
    state: State<'_, AppState>,
    connection_id: String,
    force: bool,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .swarm_leave(force)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_inspect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<String, OmniError> {
    let val = resolve_adapter(&state, &connection_id)
        .await?
        .swarm_inspect()
        .await?;
    serde_json::to_string_pretty(&val)
        .map_err(|e| OmniError::new(ErrorCode::Internal, "序列化失败").with_cause(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerServiceSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_list()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_create(
    state: State<'_, AppState>,
    connection_id: String,
    request: DockerCreateServiceRequest,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_create(&request)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_update(
    state: State<'_, AppState>,
    connection_id: String,
    service_id: String,
    replicas: Option<f64>,
    image: Option<String>,
) -> Result<(), OmniError> {
    let replicas_u64 = replicas.map(|r| r as u64);
    resolve_adapter(&state, &connection_id)
        .await?
        .service_update(&service_id, replicas_u64, image.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_remove(
    state: State<'_, AppState>,
    connection_id: String,
    service_id: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_remove(&service_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_logs(
    state: State<'_, AppState>,
    connection_id: String,
    service_id: String,
    tail: Option<String>,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_logs(&service_id, tail.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerNodeSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .node_list()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_inspect(
    state: State<'_, AppState>,
    connection_id: String,
    node_id: String,
) -> Result<String, OmniError> {
    let val = resolve_adapter(&state, &connection_id)
        .await?
        .node_inspect(&node_id)
        .await?;
    serde_json::to_string_pretty(&val)
        .map_err(|e| OmniError::new(ErrorCode::Internal, "序列化失败").with_cause(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_update(
    state: State<'_, AppState>,
    connection_id: String,
    node_id: String,
    availability: Option<String>,
    labels: Option<Vec<omnipanel_docker::DockerKeyValue>>,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .node_update(&node_id, availability.as_deref(), labels)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_remove(
    state: State<'_, AppState>,
    connection_id: String,
    node_id: String,
    force: bool,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .node_remove(&node_id, force)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_deploy(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
    compose_content: String,
    env: Option<Vec<String>>,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_deploy(&name, &compose_content, env)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerStackSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_list()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_remove(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_remove(&name)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_services(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<Vec<DockerServiceSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_services(&name)
        .await
}
