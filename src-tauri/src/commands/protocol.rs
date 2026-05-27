use std::sync::atomic::{AtomicU64, Ordering};

use tauri::ipc::Channel;
use tauri::{Emitter, State};

use crate::protocol::http::{self, HttpRequestConfig, HttpResponse};
use crate::protocol::mqtt::{self, MqttConfig, MqttMessage, MqttPublish, MqttSubscription};
use crate::protocol::serial::{self, PortInfo, SerialConfig};
use crate::protocol::ws::{self, WsConfig, WsMessage};
use crate::state::AppState;

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

    state
        .serial_sessions
        .lock()
        .await
        .insert(id.clone(), serial::SerialSession::open(&config).map_err(|e| format!("Re-open for storage failed: {e}"))?);

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
