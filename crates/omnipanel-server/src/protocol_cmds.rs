//! gRPC / Modbus 协议调试 IPC。

use std::sync::atomic::{AtomicU64, Ordering};

use crate::protocol::grpc::{GrpcCallRequest, GrpcCallResponse, GrpcConnectionConfig, GrpcSession};
use crate::protocol::modbus::ModbusConfig;
use crate::state::ServerState;

static GRPC_COUNTER: AtomicU64 = AtomicU64::new(1);
static MODBUS_COUNTER: AtomicU64 = AtomicU64::new(1);

pub async fn grpc_connect(
    state: &ServerState,
    config: GrpcConnectionConfig,
) -> Result<String, String> {
    let id = format!("grpc-{}", GRPC_COUNTER.fetch_add(1, Ordering::Relaxed));
    let session = GrpcSession::connect(config).map_err(|e| e.to_string())?;
    state.grpc_sessions.lock().await.insert(id.clone(), session);
    Ok(id)
}

pub async fn grpc_call(
    state: &ServerState,
    connection_id: String,
    request: GrpcCallRequest,
) -> Result<GrpcCallResponse, String> {
    let sessions = state.grpc_sessions.lock().await;
    let session = sessions
        .get(&connection_id)
        .ok_or_else(|| format!("gRPC 连接 {connection_id} 不存在"))?;
    session.call(request).await.map_err(|e| e.to_string())
}

pub async fn grpc_close(state: &ServerState, connection_id: String) -> Result<(), String> {
    state.grpc_sessions.lock().await.remove(&connection_id);
    Ok(())
}

pub async fn grpc_list_connections(state: &ServerState) -> Result<Vec<String>, String> {
    let sessions = state.grpc_sessions.lock().await;
    Ok(sessions.keys().cloned().collect())
}

pub async fn modbus_connect(state: &ServerState, config: ModbusConfig) -> Result<String, String> {
    let id = format!("modbus-{}", MODBUS_COUNTER.fetch_add(1, Ordering::Relaxed));
    let session = crate::protocol::modbus::ModbusSession::connect(config)?;
    state
        .modbus_sessions
        .lock()
        .await
        .insert(id.clone(), session);
    Ok(id)
}

pub async fn modbus_read_coils(
    state: &ServerState,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<bool>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_coils(addr, qty)
}

pub async fn modbus_read_discrete_inputs(
    state: &ServerState,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<bool>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_discrete_inputs(addr, qty)
}

pub async fn modbus_read_holding_registers(
    state: &ServerState,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<u16>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_holding_registers(addr, qty)
}

pub async fn modbus_read_input_registers(
    state: &ServerState,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<u16>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_input_registers(addr, qty)
}

pub async fn modbus_write_single_coil(
    state: &ServerState,
    id: String,
    addr: u16,
    value: bool,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_single_coil(addr, value)
}

pub async fn modbus_write_single_register(
    state: &ServerState,
    id: String,
    addr: u16,
    value: u16,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_single_register(addr, value)
}

pub async fn modbus_write_multiple_coils(
    state: &ServerState,
    id: String,
    addr: u16,
    values: Vec<bool>,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_multiple_coils(addr, values)
}

pub async fn modbus_write_multiple_registers(
    state: &ServerState,
    id: String,
    addr: u16,
    values: Vec<u16>,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_multiple_registers(addr, values)
}

pub async fn modbus_disconnect(state: &ServerState, id: String) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.disconnect()
}
