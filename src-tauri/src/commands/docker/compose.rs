//! Docker 命令桥接：compose
use super::*;
use std::time::Instant;

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_compose_projects(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerComposeProject>, OmniError> {
    let total = Instant::now();
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        "docker_list_compose_projects 开始"
    );
    let resolve_started = Instant::now();
    let adapter = resolve_adapter(&state, &connection_id).await?;
    let resolve_ms = resolve_started.elapsed().as_millis();
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        resolve_ms,
        "docker_list_compose_projects resolve_adapter 完成"
    );
    let list_started = Instant::now();
    let projects = adapter.list_compose_projects().await?;
    let list_ms = list_started.elapsed().as_millis();
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        count = projects.len(),
        resolve_ms,
        list_ms,
        total_ms = total.elapsed().as_millis(),
        "docker_list_compose_projects 完成"
    );
    Ok(projects)
}

/// 卷详情（`docker volume inspect`）。
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

#[tauri::command]
#[specta::specta]
pub async fn docker_read_compose_files(
    state: State<'_, AppState>,
    connection_id: String,
    request: DockerComposeReadFilesRequest,
) -> Result<DockerComposeProjectFiles, OmniError> {
    let total = Instant::now();
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        project = %request.project,
        working_dir = ?request.working_dir,
        config_file = ?request.config_file,
        "docker_read_compose_files 开始"
    );
    let resolve_started = Instant::now();
    let adapter = resolve_adapter(&state, &connection_id).await?;
    let resolve_ms = resolve_started.elapsed().as_millis();
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        project = %request.project,
        resolve_ms,
        "docker_read_compose_files resolve_adapter 完成"
    );
    let read_started = Instant::now();
    let result = adapter.read_compose_project_files(&request).await?;
    let read_ms = read_started.elapsed().as_millis();
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        project = %request.project,
        compose_path = %result.compose_path,
        env_path = %result.env_path,
        compose_bytes = result.compose_content.len(),
        env_bytes = result.env_content.len(),
        resolve_ms,
        read_ms,
        total_ms = total.elapsed().as_millis(),
        "docker_read_compose_files 完成"
    );
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn docker_write_compose_files(
    state: State<'_, AppState>,
    connection_id: String,
    request: DockerComposeWriteFilesRequest,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .write_compose_project_files(&request)
        .await
}
