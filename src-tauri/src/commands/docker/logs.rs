//! Docker 命令桥接：logs
use super::*;

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_stream_container_logs(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    tail: i32,
    since: Option<String>,
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
    let query = DockerLogQuery {
        tail: tail as i64,
        since,
    };
    let app = state.app_handle.clone();
    let sid = stream_id.clone();
    let log_streams = state.docker_log_streams.clone();
    let container_id_owned = container_id.clone();

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
                onepanel_poll_container_logs(adapter, &container_id_owned, &query, follow, stop, emit)
                    .await
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

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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
