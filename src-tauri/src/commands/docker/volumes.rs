//! Docker 命令桥接：volumes
use super::*;

// -------- ? --------

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

// -------- 文件操作 --------

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

#[tauri::command]
#[specta::specta]
pub async fn docker_list_volume_dir(
    state: State<'_, AppState>,
    connection_id: String,
    volume_name: String,
    path: String,
) -> Result<Vec<DockerFileEntry>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .list_volume_dir(&volume_name, &path)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_read_volume_file(
    state: State<'_, AppState>,
    connection_id: String,
    volume_name: String,
    path: String,
    max_bytes: i32,
) -> Result<Vec<u8>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .read_volume_file(&volume_name, &path, max_bytes as i64)
        .await
}
// Append to docker.rs ? Docker auto-detection via SSH
