//! P4 Docker Swarm / Service / Stack / Node 命令（Web 端）。
//!
//! 与桌面端 `src-tauri/src/commands/docker/swarm.rs` 对齐：
//! 参数解析 → `resolve_adapter` → `omnipanel-docker` `DockerAdapter` trait。

use omnipanel_docker::{
    DockerCreateServiceRequest, DockerKeyValue, DockerNodeSummary, DockerServiceSummary,
    DockerStackSummary,
};
use omnipanel_error::{ErrorCode, OmniError};

use crate::docker::resolve_adapter;
use crate::state::ServerState;

/* ---------------- Swarm ---------------- */

pub async fn docker_swarm_init(
    state: &ServerState,
    connection_id: String,
    listen_addr: Option<String>,
    advertise_addr: Option<String>,
) -> Result<String, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .swarm_init(listen_addr.as_deref(), advertise_addr.as_deref())
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_swarm_join(
    state: &ServerState,
    connection_id: String,
    remote_addrs: Vec<String>,
    token: String,
    listen_addr: Option<String>,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .swarm_join(remote_addrs, &token, listen_addr.as_deref())
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_swarm_leave(
    state: &ServerState,
    connection_id: String,
    force: bool,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .swarm_leave(force)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_swarm_inspect(
    state: &ServerState,
    connection_id: String,
) -> Result<String, String> {
    let val = resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .swarm_inspect()
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&val).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化失败")
            .with_cause(e.to_string())
            .to_string()
    })
}

/* ---------------- Service ---------------- */

pub async fn docker_service_list(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<DockerServiceSummary>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .service_list()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_service_create(
    state: &ServerState,
    connection_id: String,
    request: DockerCreateServiceRequest,
) -> Result<String, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .service_create(&request)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_service_update(
    state: &ServerState,
    connection_id: String,
    service_id: String,
    replicas: Option<f64>,
    image: Option<String>,
) -> Result<(), String> {
    let replicas_u64 = replicas.map(|r| r as u64);
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .service_update(&service_id, replicas_u64, image.as_deref())
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_service_remove(
    state: &ServerState,
    connection_id: String,
    service_id: String,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .service_remove(&service_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_service_logs(
    state: &ServerState,
    connection_id: String,
    service_id: String,
    tail: Option<String>,
) -> Result<String, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .service_logs(&service_id, tail.as_deref())
        .await
        .map_err(|e| e.to_string())
}

/* ---------------- Node ---------------- */

pub async fn docker_node_list(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<DockerNodeSummary>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .node_list()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_node_inspect(
    state: &ServerState,
    connection_id: String,
    node_id: String,
) -> Result<String, String> {
    let val = resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .node_inspect(&node_id)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::to_string_pretty(&val).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化失败")
            .with_cause(e.to_string())
            .to_string()
    })
}

pub async fn docker_node_update(
    state: &ServerState,
    connection_id: String,
    node_id: String,
    availability: Option<String>,
    labels: Option<Vec<DockerKeyValue>>,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .node_update(&node_id, availability.as_deref(), labels)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_node_remove(
    state: &ServerState,
    connection_id: String,
    node_id: String,
    force: bool,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .node_remove(&node_id, force)
        .await
        .map_err(|e| e.to_string())
}

/* ---------------- Stack ---------------- */

pub async fn docker_stack_deploy(
    state: &ServerState,
    connection_id: String,
    name: String,
    compose_content: String,
    env: Option<Vec<String>>,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .stack_deploy(&name, &compose_content, env)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_stack_list(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<DockerStackSummary>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .stack_list()
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_stack_remove(
    state: &ServerState,
    connection_id: String,
    name: String,
) -> Result<(), String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .stack_remove(&name)
        .await
        .map_err(|e| e.to_string())
}

pub async fn docker_stack_services(
    state: &ServerState,
    connection_id: String,
    name: String,
) -> Result<Vec<DockerServiceSummary>, String> {
    resolve_adapter(state, &connection_id)
        .await
        .map_err(|e| e.to_string())?
        .stack_services(&name)
        .await
        .map_err(|e| e.to_string())
}
