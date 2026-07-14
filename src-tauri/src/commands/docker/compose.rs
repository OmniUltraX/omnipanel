//! Docker 命令桥接：compose
use super::*;

/// 卷详情（`docker volume inspect`）。
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
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        project = %request.project,
        working_dir = ?request.working_dir,
        config_file = ?request.config_file,
        "docker_read_compose_files"
    );
    let result = resolve_adapter(&state, &connection_id)
        .await?
        .read_compose_project_files(&request)
        .await?;
    tracing::debug!(
        target: "docker_compose_files",
        connection_id = %connection_id,
        project = %request.project,
        compose_path = %result.compose_path,
        env_path = %result.env_path,
        compose_bytes = result.compose_content.len(),
        env_bytes = result.env_content.len(),
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
