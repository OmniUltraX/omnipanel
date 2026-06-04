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
    ContainerFilter, DockerAdapter, DockerComposeProject, DockerConnectionInfo,
    DockerConnectionSource, DockerConnectionStatus, DockerContainerAction, DockerContainerDetail,
    DockerContainerSummary, DockerImageSummary, DockerLogLine, DockerOverview, DockerProbe,
    DockerPruneResult, LocalDockerAdapter, SshDockerAdapter,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{SshConfig, SshEvent, SshSession, SshSink};
use serde::Deserialize;
use tauri::{Emitter, State};
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
    ssh: Option<SshConfig>,
    bound_ssh_connection_id: Option<String>,
}

/// 已解析的操作目标。
enum DockerTarget {
    Local,
    Ssh(Arc<Mutex<SshSession>>),
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
        _ => Ok(DockerTarget::Local),
    }
}

/// 从复用池获取 SSH 会话，不存在则建立并缓存。
async fn ensure_docker_ssh(
    state: &AppState,
    connection_id: &str,
    ssh: SshConfig,
) -> Result<Arc<Mutex<SshSession>>, OmniError> {
    let mut pool = state.docker_ssh_sessions.lock().await;
    if let Some(existing) = pool.get(connection_id) {
        return Ok(existing.clone());
    }
    // Docker SSH adapter 仅用 exec channel，交互输出无需回流，sink 留空。
    let sink: SshSink = Arc::new(|_: SshEvent| {});
    let session = SshSession::connect(ssh, 80, 24, sink).await?;
    let handle = Arc::new(Mutex::new(session));
    pool.insert(connection_id.to_string(), handle.clone());
    Ok(handle)
}

/// 目标 → 统一 adapter 对象。
fn adapter_for(target: DockerTarget) -> Result<Box<dyn DockerAdapter>, OmniError> {
    match target {
        DockerTarget::Local => Ok(Box::new(LocalDockerAdapter::connect()?)),
        DockerTarget::Ssh(session) => Ok(Box::new(SshDockerAdapter::new(session))),
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
            .unwrap_or_else(|| conn.name.clone());
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
            warning_message: None,
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
            DockerTarget::Ssh(session) => {
                let adapter = SshDockerAdapter::new(session);
                match adapter.container_logs(&container_id, tail as i64).await {
                    Ok(lines) => {
                        lines.into_iter().for_each(emit);
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
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
    let adapter = match target {
        DockerTarget::Local => LocalDockerAdapter::connect()?,
        DockerTarget::Ssh(_) => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "SSH 宿主机容器终端将在后续版本支持，请使用本地 Engine",
            ));
        }
    };

    let cmd = vec![shell.unwrap_or_else(|| "/bin/sh".to_string())];
    let (session, mut output) = adapter.create_exec(&container_id, cmd, cols, rows).await?;

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
