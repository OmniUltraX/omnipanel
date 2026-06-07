//! gRPC Tauri 命令。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::State;

use crate::protocol::grpc::{
    GrpcCallRequest, GrpcCallResponse, GrpcConnectionConfig, GrpcSession,
};
use crate::state::AppState;

static GRPC_COUNTER: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
#[specta::specta]
pub async fn grpc_connect(
    state: State<'_, AppState>,
    config: GrpcConnectionConfig,
) -> Result<String, String> {
    let id = format!("grpc-{}", GRPC_COUNTER.fetch_add(1, Ordering::Relaxed));
    let session = GrpcSession::connect(config).map_err(|e| e.to_string())?;
    state.grpc_sessions.lock().await.insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub async fn grpc_call(
    state: State<'_, AppState>,
    connection_id: String,
    request: GrpcCallRequest,
) -> Result<GrpcCallResponse, String> {
    let sessions = state.grpc_sessions.lock().await;
    let session = sessions
        .get(&connection_id)
        .ok_or_else(|| format!("gRPC 连接 {connection_id} 不存在"))?;
    session.call(request).await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn grpc_close(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), String> {
    state.grpc_sessions.lock().await.remove(&connection_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn grpc_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let sessions = state.grpc_sessions.lock().await;
    Ok(sessions.keys().cloned().collect())
}
