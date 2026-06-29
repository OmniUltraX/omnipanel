use std::sync::atomic::{AtomicU64, Ordering};

use tauri::ipc::Channel;
use tauri::{Emitter, State};

use crate::protocol::http::{self, HttpRequestConfig, HttpResponse};
use crate::protocol::modbus::{self, ModbusConfig};
use crate::protocol::mqtt::{self, MqttConfig, MqttMessage, MqttPublish, MqttSubscription};
use crate::protocol::serial::{self, PortInfo, SerialConfig};
use crate::protocol::sniffer::{self, CaptureStats, NetworkInterface, SnifferPacket};
use crate::protocol::ws::{self, WsConfig, WsMessage};
use crate::state::AppState;
use omnipanel_store::{HttpCollection, HttpHistoryEntry, SavedHttpRequest};

static SERIAL_COUNTER: AtomicU64 = AtomicU64::new(1);
static WS_COUNTER: AtomicU64 = AtomicU64::new(1);
static MQTT_COUNTER: AtomicU64 = AtomicU64::new(1);

// ──────────────────────────────────────────────
// Serial Port Commands
// ──────────────────────────────────────────────

#[tauri::command]
pub async fn serial_scan_ports() -> Result<Vec<PortInfo>, String> {
    serial::scan_ports()
}

#[tauri::command]
pub async fn serial_open(
    state: State<'_, AppState>,
    config: SerialConfig,
    on_data: Channel<Vec<u8>>,
) -> Result<String, String> {
    let id = format!("serial-{}", SERIAL_COUNTER.fetch_add(1, Ordering::Relaxed));

    let mut session = serial::SerialSession::open(&config)?;

    // Spawn a reader task to forward received data to frontend
    let session_id = id.clone();
    let app_handle = state.app_handle.clone();

    tokio::task::spawn_blocking(move || {
        let mut buf = [0u8; 4096];
        loop {
            match session.read_into(&mut buf) {
                Ok(0) => {
                    // No data available (timeout), continue
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Ok(n) => {
                    if on_data.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = app_handle.emit(
                        "serial-event",
                        serde_json::json!({
                            "session_id": session_id,
                            "event": "error"
                        }),
                    );
                    break;
                }
            }
        }
    });

    state.serial_sessions.lock().await.insert(
        id.clone(),
        serial::SerialSession::open(&config)
            .map_err(|e| format!("Re-open for storage failed: {e}"))?,
    );

    tracing::info!("Opened serial port {id} on {}", config.port_name);
    Ok(id)
}

#[tauri::command]
pub async fn serial_write(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<usize, String> {
    let mut sessions = state.serial_sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("Serial session {id} not found"))?;
    session.write(&data)
}

#[tauri::command]
pub async fn serial_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sessions = state.serial_sessions.lock().await;
    if sessions.remove(&id).is_some() {
        tracing::info!("Closed serial port {id}");
        Ok(())
    } else {
        Err(format!("Serial session {id} not found"))
    }
}

#[tauri::command]
pub async fn serial_set_dtr(
    state: State<'_, AppState>,
    id: String,
    level: bool,
) -> Result<(), String> {
    let mut sessions = state.serial_sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("Serial session {id} not found"))?;
    session.set_dtr(level)
}

#[tauri::command]
pub async fn serial_set_rts(
    state: State<'_, AppState>,
    id: String,
    level: bool,
) -> Result<(), String> {
    let mut sessions = state.serial_sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("Serial session {id} not found"))?;
    session.set_rts(level)
}

// ──────────────────────────────────────────────
// HTTP Commands
// ──────────────────────────────────────────────

#[tauri::command]
pub async fn http_request(config: HttpRequestConfig) -> Result<HttpResponse, String> {
    http::execute_request(config).await
}

// ──────────────────────────────────────────────
// WebSocket Commands
// ──────────────────────────────────────────────

#[tauri::command]
pub async fn ws_connect(
    state: State<'_, AppState>,
    config: WsConfig,
    on_message: Channel<WsMessage>,
) -> Result<String, String> {
    let id = format!("ws-{}", WS_COUNTER.fetch_add(1, Ordering::Relaxed));

    // Create a channel that forwards to the Tauri Channel
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<WsMessage>();
    let session_id = id.clone();
    let app_handle = state.app_handle.clone();

    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if on_message.send(msg).is_err() {
                break;
            }
        }
        let _ = app_handle.emit(
            "ws-event",
            serde_json::json!({
                "session_id": session_id,
                "event": "closed"
            }),
        );
    });

    let session = ws::WsSession::connect(config, tx).await?;

    state.ws_sessions.lock().await.insert(id.clone(), session);

    tracing::info!("WebSocket connected: {id}");
    Ok(id)
}

#[tauri::command]
pub async fn ws_send_text(
    state: State<'_, AppState>,
    id: String,
    message: String,
) -> Result<(), String> {
    let sessions = state.ws_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("WebSocket session {id} not found"))?;
    session.send_text(message)
}

#[tauri::command]
pub async fn ws_send_binary(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.ws_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("WebSocket session {id} not found"))?;
    session.send_binary_hex(&hex::encode(data))
}

#[tauri::command]
pub async fn ws_ping(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let sessions = state.ws_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("WebSocket session {id} not found"))?;
    session.send_ping()
}

#[tauri::command]
pub async fn ws_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sessions = state.ws_sessions.lock().await;
    if sessions.remove(&id).is_some() {
        tracing::info!("WebSocket closed: {id}");
        Ok(())
    } else {
        Err(format!("WebSocket session {id} not found"))
    }
}

// ──────────────────────────────────────────────
// MQTT Commands
// ──────────────────────────────────────────────

#[tauri::command]
pub async fn mqtt_connect(
    state: State<'_, AppState>,
    config: MqttConfig,
    on_message: Channel<MqttMessage>,
) -> Result<String, String> {
    let id = format!("mqtt-{}", MQTT_COUNTER.fetch_add(1, Ordering::Relaxed));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<MqttMessage>();
    let session_id = id.clone();
    let app_handle = state.app_handle.clone();

    tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if on_message.send(msg).is_err() {
                break;
            }
        }
        let _ = app_handle.emit(
            "mqtt-event",
            serde_json::json!({
                "session_id": session_id,
                "event": "disconnected"
            }),
        );
    });

    let session = mqtt::MqttSession::connect(config, tx).await?;

    state.mqtt_sessions.lock().await.insert(id.clone(), session);

    tracing::info!("MQTT connected: {id}");
    Ok(id)
}

#[tauri::command]
pub async fn mqtt_subscribe(
    state: State<'_, AppState>,
    id: String,
    subscription: MqttSubscription,
) -> Result<(), String> {
    let sessions = state.mqtt_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("MQTT session {id} not found"))?;
    session
        .subscribe(&subscription.topic, subscription.qos)
        .await
}

#[tauri::command]
pub async fn mqtt_unsubscribe(
    state: State<'_, AppState>,
    id: String,
    topic: String,
) -> Result<(), String> {
    let sessions = state.mqtt_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("MQTT session {id} not found"))?;
    session.unsubscribe(&topic).await
}

#[tauri::command]
pub async fn mqtt_publish(
    state: State<'_, AppState>,
    id: String,
    message: MqttPublish,
) -> Result<(), String> {
    let sessions = state.mqtt_sessions.lock().await;
    let session = sessions
        .get(&id)
        .ok_or_else(|| format!("MQTT session {id} not found"))?;
    session.publish(message).await
}

#[tauri::command]
pub async fn mqtt_disconnect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sessions = state.mqtt_sessions.lock().await;
    if let Some(session) = sessions.remove(&id) {
        session.disconnect().await?;
        tracing::info!("MQTT disconnected: {id}");
        Ok(())
    } else {
        Err(format!("MQTT session {id} not found"))
    }
}

// ──────────────────────────────────────────────
// HTTP History & Collections Commands
// ──────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn http_save_request(
    state: State<'_, AppState>,
    req: SavedHttpRequest,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_save_request(&req).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_list_requests(
    state: State<'_, AppState>,
    collection_id: Option<String>,
) -> Result<Vec<SavedHttpRequest>, String> {
    let storage = state.storage.lock().await;
    storage
        .http_list_requests(collection_id.as_deref())
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_delete_request(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_delete_request(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_add_history(
    state: State<'_, AppState>,
    entry: HttpHistoryEntry,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_add_history(&entry).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_list_history(
    state: State<'_, AppState>,
    limit: f64,
) -> Result<Vec<HttpHistoryEntry>, String> {
    let storage = state.storage.lock().await;
    storage
        .http_list_history(limit as i64)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_clear_history(state: State<'_, AppState>) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_clear_history().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_delete_history(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_delete_history(&id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_clear_history_for_request(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage
        .http_clear_history_for_request(&request_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_save_collection(
    state: State<'_, AppState>,
    col: HttpCollection,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage
        .http_save_collection(&col)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_list_collections(
    state: State<'_, AppState>,
) -> Result<Vec<HttpCollection>, String> {
    let storage = state.storage.lock().await;
    storage.http_list_collections().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn http_delete_collection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage
        .http_delete_collection(&id)
        .map_err(|e| e.to_string())
}

// ──────────────────────────────────────────────
// Sniffer (Packet Capture) Commands
// ──────────────────────────────────────────────

#[tauri::command]
#[specta::specta]
pub async fn sniffer_list_interfaces() -> Result<Vec<NetworkInterface>, String> {
    Ok(sniffer::list_interfaces().await)
}

#[tauri::command]
#[specta::specta]
pub async fn sniffer_start_capture(
    state: State<'_, AppState>,
    iface: String,
    filter: String,
) -> Result<String, String> {
    sniffer::start_capture(&state.sniffer_sessions, iface, filter).await
}

#[tauri::command]
#[specta::specta]
pub async fn sniffer_stop_capture(
    state: State<'_, AppState>,
    capture_id: String,
) -> Result<(), String> {
    sniffer::stop_capture(&state.sniffer_sessions, &capture_id).await
}

#[tauri::command]
#[specta::specta]
pub async fn sniffer_get_packets(
    state: State<'_, AppState>,
    capture_id: String,
    limit: Option<f64>,
) -> Result<Vec<SnifferPacket>, String> {
    let limit = limit.map(|n| n as usize);
    sniffer::get_packets(&state.sniffer_sessions, &capture_id, limit).await
}

#[tauri::command]
#[specta::specta]
pub async fn sniffer_get_stats(
    state: State<'_, AppState>,
    capture_id: String,
) -> Result<CaptureStats, String> {
    sniffer::get_stats(&state.sniffer_sessions, &capture_id).await
}

// ──────────────────────────────────────────────
// Modbus Commands
// ──────────────────────────────────────────────

static MODBUS_COUNTER: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
#[specta::specta]
pub async fn modbus_connect(
    state: State<'_, AppState>,
    config: ModbusConfig,
) -> Result<String, String> {
    let id = format!("modbus-{}", MODBUS_COUNTER.fetch_add(1, Ordering::Relaxed));
    let session = modbus::ModbusSession::connect(config)?;
    state
        .modbus_sessions
        .lock()
        .await
        .insert(id.clone(), session);
    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_read_coils(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<bool>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_coils(addr, qty)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_read_discrete_inputs(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<bool>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_discrete_inputs(addr, qty)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_read_holding_registers(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<u16>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_holding_registers(addr, qty)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_read_input_registers(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    qty: u16,
) -> Result<Vec<u16>, String> {
    let sessions = state.modbus_sessions.lock().await;
    let session = sessions.get(&id).ok_or("Modbus session not found")?;
    session.read_input_registers(addr, qty)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_write_single_coil(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    value: bool,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_single_coil(addr, value)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_write_single_register(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    value: u16,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_single_register(addr, value)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_write_multiple_coils(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    values: Vec<bool>,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_multiple_coils(addr, values)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_write_multiple_registers(
    state: State<'_, AppState>,
    id: String,
    addr: u16,
    values: Vec<u16>,
) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.write_multiple_registers(addr, values)
}

#[tauri::command]
#[specta::specta]
pub async fn modbus_disconnect(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut sessions = state.modbus_sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Modbus session not found")?;
    session.disconnect()
}
