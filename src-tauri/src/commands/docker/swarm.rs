//! Docker 命令桥接：swarm
use super::*;

// -- Docker Swarm Commands（集群模式，与单机 Engine 命令分区）--

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_init(
    state: State<'_, AppState>,
    connection_id: String,
    listen_addr: Option<String>,
    advertise_addr: Option<String>,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .swarm_init(listen_addr.as_deref(), advertise_addr.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_join(
    state: State<'_, AppState>,
    connection_id: String,
    remote_addrs: Vec<String>,
    token: String,
    listen_addr: Option<String>,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .swarm_join(remote_addrs, &token, listen_addr.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_leave(
    state: State<'_, AppState>,
    connection_id: String,
    force: bool,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .swarm_leave(force)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_swarm_inspect(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<String, OmniError> {
    let val = resolve_adapter(&state, &connection_id)
        .await?
        .swarm_inspect()
        .await?;
    serde_json::to_string_pretty(&val)
        .map_err(|e| OmniError::new(ErrorCode::Internal, "序列化失败").with_cause(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerServiceSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_list()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_create(
    state: State<'_, AppState>,
    connection_id: String,
    request: DockerCreateServiceRequest,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_create(&request)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_update(
    state: State<'_, AppState>,
    connection_id: String,
    service_id: String,
    replicas: Option<f64>,
    image: Option<String>,
) -> Result<(), OmniError> {
    let replicas_u64 = replicas.map(|r| r as u64);
    resolve_adapter(&state, &connection_id)
        .await?
        .service_update(&service_id, replicas_u64, image.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_remove(
    state: State<'_, AppState>,
    connection_id: String,
    service_id: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_remove(&service_id)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_service_logs(
    state: State<'_, AppState>,
    connection_id: String,
    service_id: String,
    tail: Option<String>,
) -> Result<String, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .service_logs(&service_id, tail.as_deref())
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerNodeSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .node_list()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_inspect(
    state: State<'_, AppState>,
    connection_id: String,
    node_id: String,
) -> Result<String, OmniError> {
    let val = resolve_adapter(&state, &connection_id)
        .await?
        .node_inspect(&node_id)
        .await?;
    serde_json::to_string_pretty(&val)
        .map_err(|e| OmniError::new(ErrorCode::Internal, "序列化失败").with_cause(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_update(
    state: State<'_, AppState>,
    connection_id: String,
    node_id: String,
    availability: Option<String>,
    labels: Option<Vec<omnipanel_docker::DockerKeyValue>>,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .node_update(&node_id, availability.as_deref(), labels)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_node_remove(
    state: State<'_, AppState>,
    connection_id: String,
    node_id: String,
    force: bool,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .node_remove(&node_id, force)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_deploy(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
    compose_content: String,
    env: Option<Vec<String>>,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_deploy(&name, &compose_content, env)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_list(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<DockerStackSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_list()
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_remove(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<(), OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_remove(&name)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_stack_services(
    state: State<'_, AppState>,
    connection_id: String,
    name: String,
) -> Result<Vec<DockerServiceSummary>, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .stack_services(&name)
        .await
}
