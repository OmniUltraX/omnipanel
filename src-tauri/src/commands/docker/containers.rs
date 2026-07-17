//! Docker 命令桥接：containers
use super::*;

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_containers(
    state: State<'_, AppState>,
    connection_id: String,
    filter: Option<String>,
) -> Result<Vec<DockerContainerSummary>, OmniError> {
    let filter = ContainerFilter::parse(filter.as_deref());
    with_adapter(&state, &connection_id, |a| async move {
        a.list_containers(filter).await
    })
    .await
}

/// 批量获取容器 CPU / 内存统计（本地 / SSH / 远程 Engine / 1Panel）。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_container_stats(
    state: State<'_, AppState>,
    connection_id: String,
    container_ids: Option<Vec<String>>,
) -> Result<Vec<DockerContainerStats>, OmniError> {
    let started = std::time::Instant::now();
    let scope = container_ids
        .as_ref()
        .map(|ids| ids.len())
        .unwrap_or(usize::MAX);
    let source = match resolve_target(&state, &connection_id).await {
        Ok(DockerTarget::Local) => "local",
        Ok(DockerTarget::Remote(_)) => "remote",
        Ok(DockerTarget::Ssh(_)) => "ssh",
        Ok(DockerTarget::OnePanel(_)) => "onepanel",
        Err(_) => "unknown",
    };
    tracing::warn!(
        target: "docker_stats",
        connection = %connection_id,
        source,
        scope = if scope == usize::MAX { -1 } else { scope as i64 },
        "docker_list_container_stats 开始"
    );
    // 同步打到 stderr，避免未设 RUST_LOG 时看不到
    eprintln!(
        "[docker_stats] start connection={connection_id} source={source} scope={}",
        if scope == usize::MAX {
            "all".to_string()
        } else {
            scope.to_string()
        }
    );

    let ids = container_ids.clone();
    let result = with_adapter(&state, &connection_id, move |a| {
        let ids = ids.clone();
        async move { a.list_container_stats(ids.as_deref()).await }
    })
    .await;

    let elapsed_ms = started.elapsed().as_millis();
    match &result {
        Ok(stats) => {
            tracing::warn!(
                target: "docker_stats",
                connection = %connection_id,
                source,
                elapsed_ms,
                result_count = stats.len(),
                "docker_list_container_stats 完成"
            );
            eprintln!(
                "[docker_stats] done connection={connection_id} source={source} elapsed_ms={elapsed_ms} count={}",
                stats.len()
            );
        }
        Err(err) => {
            tracing::warn!(
                target: "docker_stats",
                connection = %connection_id,
                source,
                elapsed_ms,
                error = %err,
                "docker_list_container_stats 失败"
            );
            eprintln!(
                "[docker_stats] fail connection={connection_id} source={source} elapsed_ms={elapsed_ms} error={err}"
            );
        }
    }
    result
}

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_container_action(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    action: String,
) -> Result<(), OmniError> {
    let parsed = DockerContainerAction::parse(&action)
        .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, format!("未知容器操作: {action}")))?;
    if parsed.is_destructive() {
        tracing::info!(
            connection = %connection_id,
            container = %container_id,
            action = %action,
            "请先连接 Docker 引擎"
        );
    }
    resolve_adapter(&state, &connection_id)
        .await?
        .container_action(&container_id, parsed)
        .await
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_container_logs(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    tail: i32,
    since: Option<String>,
) -> Result<Vec<DockerLogLine>, OmniError> {
    let query = DockerLogQuery {
        tail: tail as i64,
        since,
    };
    resolve_adapter(&state, &connection_id)
        .await?
        .container_logs(&container_id, &query)
        .await
}

/// 清空容器日志文件。
#[tauri::command]
#[specta::specta]
pub async fn docker_clear_container_logs(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .clear_container_logs(&container_id)
        .await
}

/// 列出全部容器日志文件路径与大小。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_container_log_infos(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerContainerLogInfo>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .list_container_log_infos()
        .await
}


/// 卷详情（`docker volume inspect`）。
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
        "删除 Docker 镜像"
    );
    resolve_adapter(&state, &connection_id)
        .await?
        .create_container(&request)
        .await
}
