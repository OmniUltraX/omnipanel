//! Docker 命令桥接：images
use super::*;

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_prune_images(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerPruneResult, OmniError> {
    tracing::info!(connection = %connection_id, "打开 Docker 容器终端");
    resolve_adapter(&state, &connection_id)
        .await?
        .prune_images()
        .await
}

/// 搜索镜像仓库（`docker search`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_search_images(
    state: State<'_, AppState>,
    connection_id: String,
    term: String,
    limit: u32,
) -> Result<DockerImageSearchPage, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .search_images(&term, limit)
        .await
}

/// 清理构建缓存。
#[tauri::command]
#[specta::specta]
pub async fn docker_prune_build_cache(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerPruneResult, OmniError> {
    tracing::info!(connection = %connection_id, "打开 Docker 容器终端");
    resolve_adapter(&state, &connection_id)
        .await?
        .prune_build_cache()
        .await
}


/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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

/// 卷详情（`docker volume inspect`）。
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

/// 在连接对应宿主机上执行 `docker …` CLI（搜索页「运行容器」等）。
#[tauri::command]
#[specta::specta]
pub async fn docker_host_run_cli(
    state: State<'_, AppState>,
    connection_id: String,
    command: String,
) -> Result<DockerHostCliResult, OmniError> {
    let target = resolve_target(&state, &connection_id).await?;
    match target {
        DockerTarget::Local => run_local_docker_cli(&command).await,
        DockerTarget::Ssh(session) => run_ssh_docker_cli(&session, &command).await,
        DockerTarget::Remote(_) => Err(OmniError::new(
            ErrorCode::InvalidInput,
            "远程 Engine 连接不支持在宿主机执行 docker CLI，请改用 SSH / 本地连接",
        )),
        DockerTarget::OnePanel(_) => Err(OmniError::new(
            ErrorCode::InvalidInput,
            "1Panel 连接暂不支持在宿主机执行 docker CLI",
        )),
    }
}
