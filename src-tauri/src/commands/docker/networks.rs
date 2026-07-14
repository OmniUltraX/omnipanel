//! Docker 命令桥接：networks
use super::*;

// -------- 镜像 --------

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

/// 清理未使用网络。
#[tauri::command]
#[specta::specta]
pub async fn docker_prune_networks(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerPruneResult, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .prune_networks()
        .await
}

/// 卷详情（`docker volume inspect`）。
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
