//! P2 Docker 命令（Web 端）：容器/镜像/卷/网络/compose/daemon/exec/流式。
//!
//! 延续 P1「复用 `omnipanel-docker` 领域 crate、不在 server 里重写业务」的路线，
//! 本模块只做：参数解析 → `resolve_adapter`/`with_adapter` → 序列化回传。
//! 流式能力（日志 / stats / 镜像 pull/push/build / CLI 逐行）经 [`EventBus`] 广播，
//! 等价桌面端 `app.emit("docker-log", ...)` / `app.emit(progress_channel, ...)`。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::StreamExt;
use omnipanel_docker::{
    DockerBuildContext, DockerComposeAction, DockerComposeProjectFiles,
    DockerComposeReadFilesRequest, DockerComposeRequest, DockerComposeWriteFilesRequest,
    DockerContainerAction, DockerCreateContainerRequest, DockerCreateNetworkRequest,
    DockerCreateVolumeRequest, DockerDaemonConfigFile,
    DockerHostCliResult, DockerImageProgress, LocalDockerAdapter, run_local_docker_cli,
    run_ssh_docker_cli,
};
use omnipanel_error::{ErrorCode, OmniError};

use crate::docker::{DockerTarget, resolve_adapter, resolve_target, with_adapter};
use crate::state::ServerState;

static LOG_STREAM_COUNTER: AtomicU64 = AtomicU64::new(1);
static STATS_STREAM_COUNTER: AtomicU64 = AtomicU64::new(0);
static EXEC_SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

fn not_supported(msg: &str) -> OmniError {
    OmniError::new(ErrorCode::InvalidInput, msg.to_string())
}

/* ---------------- 容器 ---------------- */

pub async fn docker_list_container_stats(
    state: &ServerState,
    connection_id: String,
    container_ids: Option<Vec<String>>,
) -> Result<Vec<omnipanel_docker::DockerContainerStats>, String> {
    let ids = container_ids.clone();
    with_adapter(state, &connection_id, move |a| {
        let ids = ids.clone();
        async move { a.list_container_stats(ids.as_deref()).await }
    })
    .await
    .map_err(|e| e.to_string())
}

pub async fn docker_inspect_container(
    state: &ServerState,
    connection_id: String,
    container_id: String,
) -> Result<omnipanel_docker::DockerContainerDetail, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .inspect_container(&container_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_container_action(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    action: String,
) -> Result<(), String> {
    let parsed = DockerContainerAction::parse(&action)
        .ok_or_else(|| format!("未知容器操作: {action}"))?;
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .container_action(&container_id, parsed)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_container_logs(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    tail: i32,
    since: Option<String>,
) -> Result<Vec<omnipanel_docker::DockerLogLine>, String> {
    let query = omnipanel_docker::DockerLogQuery {
        tail: tail as i64,
        since,
    };
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .container_logs(&container_id, &query)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_clear_container_logs(
    state: &ServerState,
    connection_id: String,
    container_id: String,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .clear_container_logs(&container_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_list_container_log_infos(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<omnipanel_docker::DockerContainerLogInfo>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .list_container_log_infos()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_create_container(
    state: &ServerState,
    connection_id: String,
    request: DockerCreateContainerRequest,
) -> Result<String, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .create_container(&request)
        .await
        .map_err(|e| e.to_string())
}

/* ---------------- 镜像 ---------------- */

pub async fn docker_list_images(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<omnipanel_docker::DockerImageSummary>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .list_images()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_remove_image(
    state: &ServerState,
    connection_id: String,
    image_id: String,
    force: bool,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .remove_image(&image_id, force)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_inspect_image(
    state: &ServerState,
    connection_id: String,
    image_id: String,
) -> Result<omnipanel_docker::DockerImageDetail, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .inspect_image(&image_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_image_history(
    state: &ServerState,
    connection_id: String,
    image_id: String,
) -> Result<Vec<omnipanel_docker::DockerImageHistoryLayer>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .image_history(&image_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_prune_images(
    state: &ServerState,
    connection_id: String,
) -> Result<omnipanel_docker::DockerPruneResult, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .prune_images()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_search_images(
    state: &ServerState,
    connection_id: String,
    term: String,
    limit: u32,
) -> Result<omnipanel_docker::DockerImageSearchPage, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .search_images(&term, limit)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_prune_build_cache(
    state: &ServerState,
    connection_id: String,
) -> Result<omnipanel_docker::DockerPruneResult, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .prune_build_cache()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_tag_image(
    state: &ServerState,
    connection_id: String,
    source: String,
    target: String,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .tag_image(&source, &target)
        .await
        .map_err(|e| e.to_string())
}

/// 镜像 pull/push/build 进度回调 → Channel 帧（等价桌面端 `progress_channel`）。
fn progress_to_channel(
    bus: crate::bus::EventBus,
    channel_id: String,
) -> Box<dyn Fn(DockerImageProgress) + Send + Sync> {
    Box::new(move |p: DockerImageProgress| {
        bus.emit_channel(
            &channel_id,
            serde_json::json!({
                "id": p.id,
                "status": p.status,
                "progress": p.progress,
                "detail": p.detail,
            }),
        );
    })
}

pub async fn docker_pull_image(
    state: &ServerState,
    connection_id: String,
    image: String,
    progress_channel: String,
) -> Result<omnipanel_docker::DockerPullResult, String> {
    let adapter = resolve_adapter(state, &connection_id).await.map_err(|e| e.to_string())?;
    let cb = progress_to_channel(state.bus.clone(), progress_channel);
    adapter
        .pull_image(&image, Some(cb as _))
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_push_image(
    state: &ServerState,
    connection_id: String,
    image: String,
    progress_channel: String,
) -> Result<omnipanel_docker::DockerPullResult, String> {
    let adapter = resolve_adapter(state, &connection_id).await.map_err(|e| e.to_string())?;
    let cb = progress_to_channel(state.bus.clone(), progress_channel);
    adapter
        .push_image(&image, Some(cb as _))
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_build_image(
    state: &ServerState,
    connection_id: String,
    context: DockerBuildContext,
    progress_channel: String,
) -> Result<omnipanel_docker::DockerBuildResult, String> {
    let adapter = resolve_adapter(state, &connection_id).await.map_err(|e| e.to_string())?;
    let cb = progress_to_channel(state.bus.clone(), progress_channel);
    adapter
        .build_image(&context, Some(cb as _))
        .await
        .map_err(|e| e.to_string())
}

/// 在连接对应宿主机上执行 `docker …` CLI（按行回传 Channel）。
pub async fn docker_host_run_cli(
    state: &ServerState,
    connection_id: String,
    command: String,
    progress_channel: String,
) -> Result<DockerHostCliResult, String> {
    let target = resolve_target(state, &connection_id).await.map_err(|e| e.to_string())?;
    let bus = state.bus.clone();
    let channel = progress_channel.clone();
    let on_line = move |line: String| {
        bus.emit_channel(&channel, serde_json::json!(line));
    };
    match target {
        DockerTarget::Local => run_local_docker_cli(&command, on_line).await.map_err(|e| e.to_string()),
        DockerTarget::Ssh(session) => run_ssh_docker_cli(&session, &command, on_line)
            .await
            .map_err(|e| e.to_string()),
        DockerTarget::Remote(_) => Err(not_supported(
            "远程 Engine 连接不支持在宿主机执行 docker CLI，请改用 SSH / 本地连接",
        ))
        .map_err(|e| e.to_string()),
        DockerTarget::OnePanel(_) => Err(not_supported("1Panel 连接暂不支持在宿主机执行 docker CLI"))
            .map_err(|e| e.to_string()),
    }
}

/* ---------------- 卷 ---------------- */

pub async fn docker_list_volumes(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<omnipanel_docker::DockerVolumeSummary>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .list_volumes()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_create_volume(
    state: &ServerState,
    connection_id: String,
    request: DockerCreateVolumeRequest,
) -> Result<String, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .create_volume(&request)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_remove_volume(
    state: &ServerState,
    connection_id: String,
    name: String,
    force: bool,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .remove_volume(&name, force)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_inspect_volume(
    state: &ServerState,
    connection_id: String,
    name: String,
) -> Result<omnipanel_docker::DockerVolumeDetail, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .inspect_volume(&name)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_prune_volumes(
    state: &ServerState,
    connection_id: String,
) -> Result<omnipanel_docker::DockerPruneVolumesResult, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .prune_volumes()
        .await
        .map_err(|e| e.to_string())
}

/* ---------------- 网络 ---------------- */

pub async fn docker_list_networks(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<omnipanel_docker::DockerNetworkSummary>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .list_networks()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_create_network(
    state: &ServerState,
    connection_id: String,
    request: DockerCreateNetworkRequest,
) -> Result<String, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .create_network(&request)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_remove_network(
    state: &ServerState,
    connection_id: String,
    name: String,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .remove_network(&name)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_prune_networks(
    state: &ServerState,
    connection_id: String,
) -> Result<omnipanel_docker::DockerPruneResult, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .prune_networks()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_inspect_network(
    state: &ServerState,
    connection_id: String,
    name: String,
) -> Result<omnipanel_docker::DockerNetworkDetail, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .inspect_network(&name)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_connect_network(
    state: &ServerState,
    connection_id: String,
    network: String,
    container_id: String,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .connect_container_to_network(&network, &container_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_disconnect_network(
    state: &ServerState,
    connection_id: String,
    network: String,
    container_id: String,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .disconnect_container_from_network(&network, &container_id)
        .await
        .map_err(|e| e.to_string())
}

/* ---------------- Compose ---------------- */

pub async fn docker_list_compose_projects(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<omnipanel_docker::DockerComposeProject>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .list_compose_projects()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_compose_action(
    state: &ServerState,
    connection_id: String,
    action: DockerComposeAction,
    request: DockerComposeRequest,
) -> Result<omnipanel_docker::DockerComposeResult, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .compose_action(action, &request)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_read_compose_files(
    state: &ServerState,
    connection_id: String,
    request: DockerComposeReadFilesRequest,
) -> Result<DockerComposeProjectFiles, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .read_compose_project_files(&request)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_write_compose_files(
    state: &ServerState,
    connection_id: String,
    request: DockerComposeWriteFilesRequest,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .write_compose_project_files(&request)
        .await
        .map_err(|e| e.to_string())
}

/* ---------------- daemon ---------------- */

pub async fn docker_read_daemon_config(
    state: &ServerState,
    connection_id: String,
) -> Result<DockerDaemonConfigFile, String> {
    if connection_is_remote_engine(state, &connection_id).await? {
        return Ok(omnipanel_docker::remote_engine_daemon_config());
    }
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .read_daemon_config()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_write_daemon_config(
    state: &ServerState,
    connection_id: String,
    content: String,
) -> Result<(), String> {
    if connection_is_remote_engine(state, &connection_id).await? {
        return Err("远程 Engine 连接不支持编辑 daemon.json".to_string());
    }
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .write_daemon_config(&content)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_restart_daemon(
    state: &ServerState,
    connection_id: String,
) -> Result<(), String> {
    if connection_is_remote_engine(state, &connection_id).await? {
        return Err("远程 Engine 连接不支持重启 Docker 服务".to_string());
    }
    if connection_id == crate::docker::LOCAL_CONNECTION_ID {
        return omnipanel_docker::restart_local_engine().map_err(|e| e.to_string());
    }
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .restart_docker_daemon()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_start_local_engine() -> Result<(), String> {
    omnipanel_docker::start_local_engine().map_err(|e| e.to_string())
}

pub async fn docker_get_system_disk_usage(
    state: &ServerState,
    connection_id: String,
) -> Result<omnipanel_docker::DockerSystemDiskUsage, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .system_disk_usage()
        .await
        .map_err(|e| e.to_string())
}

async fn connection_is_remote_engine(
    state: &ServerState,
    connection_id: &str,
) -> Result<bool, String> {
    if connection_id == crate::docker::LOCAL_CONNECTION_ID {
        return Ok(false);
    }
    let conn = {
        let storage = state.storage.lock().await;
        storage.get_connection(connection_id).map_err(|e| e.to_string())?
    }
    .ok_or_else(|| format!("Docker 连接 {connection_id} 不存在"))?;
    let cfg: crate::docker::DockerConnectionConfig =
        serde_json::from_str(&conn.config).unwrap_or_default();
    Ok(cfg
        .source
        .as_deref()
        .map(omnipanel_docker::DockerConnectionSource::parse)
        == Some(omnipanel_docker::DockerConnectionSource::RemoteEngine))
}

/* ---------------- 容器内文件 ---------------- */

pub async fn docker_list_container_dir(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    path: String,
) -> Result<Vec<omnipanel_docker::DockerFileEntry>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .list_container_dir(&container_id, &path)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_read_container_file(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    path: String,
    max_bytes: i64,
) -> Result<Vec<u8>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .read_container_file(&container_id, &path, max_bytes)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_write_container_file(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    path: String,
    data: Vec<u8>,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .write_container_file(&container_id, &path, data)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_list_volume_dir(
    state: &ServerState,
    connection_id: String,
    volume_name: String,
    path: String,
) -> Result<Vec<omnipanel_docker::DockerFileEntry>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .list_volume_dir(&volume_name, &path)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_read_volume_file(
    state: &ServerState,
    connection_id: String,
    volume_name: String,
    path: String,
    max_bytes: i64,
) -> Result<Vec<u8>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .read_volume_file(&volume_name, &path, max_bytes)
        .await
        .map_err(|e| e.to_string())
}

/* ---------------- 流式：日志 / stats ---------------- */

pub async fn docker_stream_container_logs(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    tail: i32,
    since: Option<String>,
    follow: bool,
) -> Result<String, String> {
    let stream_id = format!("docker-log-{}", LOG_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed));
    let stop = Arc::new(AtomicBool::new(false));
    state
        .docker_log_streams
        .lock()
        .await
        .insert(stream_id.clone(), stop.clone());

    let target = resolve_target(state, &connection_id).await.map_err(|e| e.to_string())?;
    let query = omnipanel_docker::DockerLogQuery {
        tail: tail as i64,
        since,
    };
    let bus = state.bus.clone();
    let sid = stream_id.clone();
    let log_streams = state.docker_log_streams.clone();
    let container_id_owned = container_id.clone();

    tokio::spawn(async move {
        let emit = |line: omnipanel_docker::DockerLogLine| {
            bus.emit(
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
                        .stream_logs(&container_id_owned, &query, follow, stop.clone(), emit)
                        .await
                }
                Err(e) => Err(e),
            },
            DockerTarget::Remote(docker) => {
                let adapter = LocalDockerAdapter::with_docker(docker);
                adapter
                    .stream_logs(&container_id_owned, &query, follow, stop.clone(), emit)
                    .await
            }
            DockerTarget::Ssh(session) => {
                omnipanel_docker::ssh::stream_logs(
                    &*session,
                    &container_id_owned,
                    &query,
                    follow,
                    stop.clone(),
                    emit,
                )
                .await
            }
            DockerTarget::OnePanel(adapter) => {
                crate::docker::onepanel_poll_container_logs(
                    adapter,
                    &container_id_owned,
                    &query,
                    follow,
                    stop,
                    emit,
                )
                .await
            }
        };

        bus.emit(
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

pub async fn docker_stop_log_stream(
    state: &ServerState,
    stream_id: String,
) -> Result<(), String> {
    if let Some(stop) = state.docker_log_streams.lock().await.remove(&stream_id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub async fn docker_stream_stats(
    state: &ServerState,
    connection_id: String,
    container_id: String,
) -> Result<String, String> {
    let stream_id = format!("docker-stats-{}", STATS_STREAM_COUNTER.fetch_add(1, Ordering::Relaxed));
    let stop = Arc::new(AtomicBool::new(false));
    state
        .docker_stats_streams
        .lock()
        .await
        .insert(stream_id.clone(), stop.clone());

    let target = resolve_target(state, &connection_id).await.map_err(|e| e.to_string())?;
    let bus = state.bus.clone();
    let sid = stream_id.clone();
    let stats_streams = state.docker_stats_streams.clone();
    let stop_for_task = stop.clone();

    tokio::spawn(async move {
        let sid_owned = sid.clone();
        let bus_for_end = bus.clone();
        let emit = move |stats: omnipanel_docker::DockerContainerStats| {
            bus.emit(
                "docker-stats",
                serde_json::json!({
                    "streamId": sid_owned,
                    "stats": stats,
                }),
            );
        };
        let sink: Box<dyn FnMut(omnipanel_docker::DockerContainerStats) + Send> = Box::new(emit);

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
                use omnipanel_docker::DockerAdapter as _;
                adapter
                    .stream_stats(&container_id, stop_for_task.clone(), sink)
                    .await
            }
        };

        bus_for_end.emit(
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

pub async fn docker_stop_stats_stream(
    state: &ServerState,
    stream_id: String,
) -> Result<(), String> {
    if let Some(stop) = state.docker_stats_streams.lock().await.remove(&stream_id) {
        stop.store(true, Ordering::Relaxed);
    }
    Ok(())
}

/* ---------------- 容器内交互终端（exec） ---------------- */

/// Docker exec 会话条目（与桌面端 `DockerExecSessionEntry` 同构）。
pub struct DockerExecSessionEntry {
    pub session: omnipanel_docker::DockerExecSession,
    pub connection_id: String,
    pub container_id: String,
}

fn exec_shell_candidates(requested: Option<String>, image: Option<&str>) -> Vec<String> {
    if let Some(s) = requested.filter(|s| !s.trim().is_empty()) {
        return vec![s.trim().to_string()];
    }
    let image_lower = image.unwrap_or("").to_lowercase();
    let mut shells = vec!["/bin/sh".to_string(), "sh".to_string()];
    if image_lower.contains("alpine") || image_lower.contains("busybox") {
        shells.extend(["/bin/ash", "ash"].map(str::to_string));
    }
    shells.extend(["/bin/bash", "bash"].map(str::to_string));
    shells
}

fn is_exec_shell_missing_text(text: &str) -> bool {
    let msg = text.to_lowercase();
    msg.contains("executable file not found")
        || msg.contains("no such file or directory")
        || msg.contains(": not found")
        || (msg.contains("oci runtime exec failed")
            && (msg.contains("not found") || msg.contains("stat /bin/")))
}

fn is_exec_shell_missing(err: &OmniError) -> bool {
    is_exec_shell_missing_text(&format!(
        "{}{}",
        err.message,
        err.cause.as_deref().unwrap_or("")
    ))
}

async fn create_exec_with_shell_probe(
    target: &DockerTarget,
    container_id: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> Result<
    (
        omnipanel_docker::DockerExecSession,
        omnipanel_docker::DockerExecOutput,
    ),
    OmniError,
> {
    let (session, mut output) = create_exec_for_target(target, container_id, shell, cols, rows).await?;

    let peek = tokio::time::timeout(std::time::Duration::from_millis(1200), output.next()).await;

    match peek {
        Ok(Some(Ok(bytes))) if is_exec_shell_missing_text(&String::from_utf8_lossy(&bytes)) => {
            let _ = session.close().await;
            Err(OmniError::new(
                ErrorCode::Internal,
                format!("容器内不存在 shell：{shell}"),
            )
            .with_cause(String::from_utf8_lossy(&bytes).into_owned()))
        }
        Ok(Some(Ok(bytes))) => {
            // 首包回灌到流头部（保留原始输出顺序）
            let first = Ok(bytes);
            let rest = output;
            let combined: omnipanel_docker::DockerExecOutput = Box::pin(
                futures::stream::once(async move { first }).chain(rest),
            );
            Ok((session, combined))
        }
        Ok(Some(Err(err))) => {
            let _ = session.close().await;
            Err(err)
        }
        Ok(None) | Err(_) => Ok((session, output)),
    }
}

async fn create_exec_for_target(
    target: &DockerTarget,
    container_id: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> Result<
    (
        omnipanel_docker::DockerExecSession,
        omnipanel_docker::DockerExecOutput,
    ),
    OmniError,
> {
    match target {
        DockerTarget::Local => {
            let adapter = LocalDockerAdapter::connect()?;
            adapter
                .create_exec(container_id, vec![shell.to_string()], cols, rows)
                .await
        }
        DockerTarget::Remote(docker) => {
            let adapter = LocalDockerAdapter::with_docker(docker.clone());
            adapter
                .create_exec(container_id, vec![shell.to_string()], cols, rows)
                .await
        }
        DockerTarget::Ssh(ssh_session) => {
            omnipanel_docker::ssh::create_exec(ssh_session, container_id, shell, cols, rows).await
        }
        DockerTarget::OnePanel(adapter) => {
            adapter
                .create_container_exec(container_id, shell, cols, rows)
                .await
        }
    }
}

/// 一次性 exec：非交互执行并返回 stdout/stderr/exit_code。
pub async fn docker_exec_command(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    command: String,
) -> Result<omnipanel_docker::DockerOneShotExecOutput, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("command 不能为空".to_string());
    }
    if trimmed.contains("&&") || trimmed.contains("||") || trimmed.contains(';') {
        return Err(
            "command 不支持复合命令（; / && / ||），请单条执行或写入脚本后调用".to_string(),
        );
    }

    let target = resolve_target(state, &connection_id).await.map_err(|e| e.to_string())?;
    match target {
        DockerTarget::Local => {
            let local = LocalDockerAdapter::connect().map_err(|e| e.to_string())?;
            let cmd = vec!["sh".to_string(), "-c".to_string(), trimmed.to_string()];
            let out = local.exec_one_shot(&container_id, cmd).await.map_err(|e| e.to_string())?;
            Ok(out)
        }
        DockerTarget::Remote(docker) => {
            let local = LocalDockerAdapter::with_docker(docker);
            let cmd = vec!["sh".to_string(), "-c".to_string(), trimmed.to_string()];
            let out = local.exec_one_shot(&container_id, cmd).await.map_err(|e| e.to_string())?;
            Ok(out)
        }
        DockerTarget::Ssh(session) => {
            let docker_cmd = format!(
                "docker exec --tty=false {container_id} sh -c {cmd:?}",
                cmd = trimmed
            );
            let output = session.exec_capture(&docker_cmd).await.map_err(|e| e.to_string())?;
            Ok(omnipanel_docker::DockerOneShotExecOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code as i64,
            })
        }
        DockerTarget::OnePanel(_) => Err(
            "1Panel 连接暂不支持一次性 exec；请在宿主机 SSH 终端执行".to_string(),
        ),
    }
}

/// 创建容器内交互终端会话，输出经 `terminal-output` / `terminal-event` 广播。
pub async fn docker_create_exec_session(
    state: &ServerState,
    connection_id: String,
    container_id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    close_docker_exec_for_container(state, &connection_id, &container_id).await;

    // 解析候选 shell（显式 shell 或按镜像推断）
    let shells = if shell.as_ref().is_some_and(|s| !s.trim().is_empty()) {
        vec![shell.unwrap().trim().to_string()]
    } else {
        let image = match resolve_adapter(state, &connection_id).await {
            Ok(adapter) => adapter
                .inspect_container(&container_id)
                .await
                .ok()
                .map(|d| d.summary.image),
            Err(_) => None,
        };
        exec_shell_candidates(None, image.as_deref())
    };

    let mut exec_pair: Option<(omnipanel_docker::DockerExecSession, _)> = None;
    let mut last_err: Option<OmniError> = None;

    for attempt in 0..2 {
        let target = match resolve_target(state, &connection_id).await {
            Ok(t) => t,
            Err(e) => {
                last_err = Some(e);
                break;
            }
        };
        for shell_str in &shells {
            match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                create_exec_with_shell_probe(&target, &container_id, shell_str, cols, rows),
            )
            .await
            {
                Err(_) => {
                    last_err = Some(OmniError::new(
                        ErrorCode::Ssh,
                        format!("进入容器终端超时：{shell_str}"),
                    ));
                    continue;
                }
                Ok(Ok(pair)) => {
                    exec_pair = Some(pair);
                    break;
                }
                Ok(Err(err)) if is_exec_shell_missing(&err) => {
                    last_err = Some(err);
                    continue;
                }
                Ok(Err(err)) if attempt == 0 && crate::docker::is_ssh_recoverable(&err) => {
                    crate::docker::invalidate_docker_ssh(state, &connection_id).await;
                    last_err = Some(err);
                    break;
                }
                Ok(Err(err)) => return Err(err.to_string()),
            }
        }
        if exec_pair.is_some() {
            break;
        }
    }

    let (session, mut output) = exec_pair.ok_or_else(|| {
        last_err
            .map(|e| e.user_message())
            .unwrap_or_else(|| "无法在容器内启动交互 shell，请尝试 bash/sh".to_string())
    })?;

    let session_id = format!("docker-exec-{}", EXEC_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed));
    state.docker_exec_sessions.lock().await.insert(
        session_id.clone(),
        DockerExecSessionEntry {
            session,
            connection_id: connection_id.clone(),
            container_id: container_id.clone(),
        },
    );

    let bus = state.bus.clone();
    let sid = session_id.clone();
    let sessions = state.docker_exec_sessions.clone();
    tokio::spawn(async move {
        while let Some(item) = output.next().await {
            match item {
                Ok(bytes) => {
                    bus.emit_terminal_output(
                        &sid,
                        STANDARD.encode(&bytes),
                    );
                }
                Err(_) => break,
            }
        }
        bus.emit_terminal_event(&sid, crate::bus::SessionEvent::Exited);
        if let Some(entry) = sessions.lock().await.remove(&sid) {
            drop(entry);
        }
    });

    Ok(session_id)
}

/// 宿主机交互终端（SSH / 1Panel；本地 Engine 走本机终端）。
pub async fn docker_create_host_shell_session(
    state: &ServerState,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    close_docker_exec_for_container(state, &connection_id, "__host__").await;

    let mut exec_pair: Option<(omnipanel_docker::DockerExecSession, _)> = None;
    let mut last_err: Option<OmniError> = None;

    for attempt in 0..2 {
        let target = match resolve_target(state, &connection_id).await {
            Ok(t) => t,
            Err(e) => {
                last_err = Some(e);
                break;
            }
        };
        let result = match &target {
            DockerTarget::Ssh(ssh_session) => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    omnipanel_docker::ssh::create_host_shell(ssh_session, cols, rows),
                )
                .await
            }
            DockerTarget::Local | DockerTarget::Remote(_) => {
                return Err(
                    "本地 / 远程 Engine 连接请使用本机终端；宿主机 Docker shell 仅支持 SSH / 1Panel"
                        .to_string(),
                );
            }
            DockerTarget::OnePanel(adapter) => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    adapter.create_host_shell(cols, rows),
                )
                .await
            }
        };

        match result {
            Err(_) => {
                last_err = Some(OmniError::new(ErrorCode::Ssh, "打开宿主机终端超时"));
            }
            Ok(Ok(pair)) => {
                exec_pair = Some(pair);
                break;
            }
            Ok(Err(err)) if attempt == 0 && crate::docker::is_ssh_recoverable(&err) => {
                crate::docker::invalidate_docker_ssh(state, &connection_id).await;
                last_err = Some(err);
            }
            Ok(Err(err)) => return Err(err.to_string()),
        }
    }

    let (session, mut output) = exec_pair.ok_or_else(|| {
        last_err
            .map(|e| e.user_message())
            .unwrap_or_else(|| "无法打开宿主机交互 shell".to_string())
    })?;

    let session_id = format!("docker-host-{}", EXEC_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed));
    state.docker_exec_sessions.lock().await.insert(
        session_id.clone(),
        DockerExecSessionEntry {
            session,
            connection_id: connection_id.clone(),
            container_id: "__host__".to_string(),
        },
    );

    let bus = state.bus.clone();
    let sid = session_id.clone();
    let sessions = state.docker_exec_sessions.clone();
    tokio::spawn(async move {
        while let Some(item) = output.next().await {
            match item {
                Ok(bytes) => {
                    bus.emit_terminal_output(&sid, STANDARD.encode(&bytes));
                }
                Err(_) => break,
            }
        }
        bus.emit_terminal_event(&sid, crate::bus::SessionEvent::Exited);
        if let Some(entry) = sessions.lock().await.remove(&sid) {
            drop(entry);
        }
    });

    Ok(session_id)
}

pub async fn docker_exec_write(
    state: &ServerState,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.docker_exec_sessions.lock().await;
    let entry = sessions
        .get(&session_id)
        .ok_or_else(|| format!("容器终端会话 {session_id} 不存在"))?;
    entry.session.write(&data).await.map_err(|e| e.to_string())
}

pub async fn docker_exec_resize(
    state: &ServerState,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.docker_exec_sessions.lock().await;
    if let Some(entry) = sessions.get(&session_id) {
        entry.session.resize(cols, rows).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn docker_exec_close(
    state: &ServerState,
    session_id: String,
) -> Result<(), String> {
    if let Some(entry) = state.docker_exec_sessions.lock().await.remove(&session_id) {
        drop(entry);
    }
    Ok(())
}

/// 关闭指定连接下所有容器 exec 会话（切换连接/重进时回收旧 PTY）。
async fn close_docker_exec_for_container(
    state: &ServerState,
    connection_id: &str,
    container_id: &str,
) {
    loop {
        let next = {
            let mut map = state.docker_exec_sessions.lock().await;
            let key = map
                .iter()
                .find(|(_, entry)| {
                    entry.connection_id == connection_id && entry.container_id == container_id
                })
                .map(|(id, _)| id.clone());
            key.and_then(|id| map.remove(&id))
        };
        match next {
            Some(entry) => drop(entry),
            None => break,
        }
    }
}
