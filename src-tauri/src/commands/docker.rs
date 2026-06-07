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
    bollard, ContainerFilter, DockerAdapter, DockerBuildContext, DockerBuildResult,
    DockerComposeAction, DockerComposeProject, DockerComposeRequest, DockerComposeResult,
    DockerConnectionInfo, DockerConnectionSource, DockerConnectionStatus, DockerContainerAction,
    DockerContainerDetail, DockerContainerStats, DockerContainerSummary,
    DockerCreateNetworkRequest, DockerCreateVolumeRequest, DockerFileEntry, DockerImageDetail,
    DockerImageHistoryLayer, DockerImageProgress, DockerImageSummary, DockerLogLine,
    DockerNetworkDetail, DockerNetworkSummary, DockerOverview, DockerProbe, DockerPruneResult,
    DockerPruneVolumesResult, DockerPullResult, DockerVolumeDetail, DockerVolumeSummary,
    LocalDockerAdapter, OnePanelAdapter, OnePanelClient, SshDockerAdapter,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{SshConfig, SshEvent, SshSession, SshSink};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::state::AppState;

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
    Ssh(Arc<Mutex<SshSession>>),
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
            let port = cfg.port.unwrap_or(if cfg.tls.unwrap_or(true) { 2376 } else { 2375 });
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
) -> Result<Arc<Mutex<SshSession>>, OmniError> {
    // 1. Docker 专用池命中
    {
        let pool = state.docker_ssh_sessions.lock().await;
        if let Some(existing) = pool.get(connection_id) {
            return Ok(existing.clone());
        }
    }

    // 2. 尝试从 SSH 连接池复用（bound_ssh_connection_id 或按 host:port 匹配）
    //    先查存储中的 Docker 连接配置，看是否有 bound_ssh_connection_id
    let bound_id: Option<String> = {
        let storage = state.storage.lock().await;
        storage
            .get_connection(connection_id)?
            .and_then(|c| {
                serde_json::from_str::<DockerConnectionConfig>(&c.config)
                    .ok()
                    .and_then(|cfg| cfg.bound_ssh_connection_id)
            })
    };

    if let Some(ref ssh_id) = bound_id {
        // 从 SSH 池获取配置，建立专用 Docker 会话（exec-only，无 shell）
        if let Some(ssh_config) = state.ssh_pool.get_ssh_config(ssh_id).await {
            tracing::info!(
                "Docker 连接 {connection_id} 使用 SSH 配置 {ssh_id} 建立专用会话"
            );
            let sink: SshSink = Arc::new(|_: SshEvent| {});
            let session = SshSession::connect(ssh_config, 80, 24, sink).await?;
            let handle = Arc::new(Mutex::new(session));
            let mut pool = state.docker_ssh_sessions.lock().await;
            pool.insert(connection_id.to_string(), handle.clone());
            return Ok(handle);
        }
    }

    // 3. 建立新连接
    let sink: SshSink = Arc::new(|_: SshEvent| {});
    let session = SshSession::connect(ssh, 80, 24, sink).await?;
    let handle = Arc::new(Mutex::new(session));
    let mut pool = state.docker_ssh_sessions.lock().await;
    pool.insert(connection_id.to_string(), handle.clone());
    Ok(handle)
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
            DockerConnectionSource::OnePanel => {
                Some("1Panel 适配器：暂不支持日志流式 / 容器 exec / 镜像 push-pull / build".to_string())
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
                let guard = session.lock().await;
                omnipanel_docker::ssh::stream_logs(
                    &*guard,
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
        let sink: Box<dyn FnMut(DockerContainerStats) + Send> =
            Box::new(emit);

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
                let guard = session.lock().await;
                omnipanel_docker::ssh::stream_stats(
                    &*guard,
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
        DockerTarget::Ssh(ssh_arc) => {
            let shell_str = shell.unwrap_or_else(|| "/bin/sh".to_string());
            let guard = ssh_arc.lock().await;
            let pair =
                omnipanel_docker::ssh::create_exec(&*guard, &container_id, &shell_str, cols, rows)
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
        .insert(session_id.clone(), session);

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
        sessions.lock().await.remove(&sid);
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
    let session = sessions.get(&session_id).ok_or_else(|| {
        OmniError::new(
            ErrorCode::NotFound,
            format!("容器终端会话 {session_id} 不存在"),
        )
    })?;
    session.write(&data).await
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
    if let Some(session) = sessions.get(&session_id) {
        session.resize(cols, rows).await?;
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
    state.docker_exec_sessions.lock().await.remove(&session_id);
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
    adapter
        .pull_image(&image, Some(Box::new(cb) as _))
        .await
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
    adapter
        .push_image(&image, Some(Box::new(cb) as _))
        .await
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
    adapter
        .build_image(&context, Some(Box::new(cb) as _))
        .await
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
    // Get or create SSH session from the pool
    let session = state
        .ssh_pool
        .ensure_session(&ssh_connection_id)
        .await?;

    // Probe Docker daemon
    let version_output = session
        .exec_command("docker version --format '{{.Server.Version}}' 2>/dev/null")
        .await;

    let info_output = session
        .exec_command("docker info --format '{{.OperatingSystem}}|{{.ServerVersion}}|{{.Containers}}|{{.Images}}' 2>/dev/null")
        .await;

    match (version_output, info_output) {
        (Ok(version), Ok(info)) => {
            let parts: Vec<&str> = info.split('|').collect();
            Ok(DockerAutoDetectResult {
                available: true,
                version: Some(version.trim().to_string()),
                os: parts.first().map(|s| s.to_string()),
                containers: parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
                images: parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0),
                error: None,
            })
        }
        (_, Err(e)) | (Err(e), _) => Ok(DockerAutoDetectResult {
            available: false,
            version: None,
            os: None,
            containers: 0,
            images: 0,
            error: Some(format!("Docker not available: {}", e)),
        }),
    }
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
