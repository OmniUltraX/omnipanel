use std::collections::HashMap;
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::protocol::mqtt::MqttSession;
use crate::protocol::serial::SerialSession;
use crate::protocol::ws::WsSession;
use crate::terminal::TerminalSession;
use omnipanel_ai::provider::AiProviderRegistry;

pub struct AppState {
    pub terminals: Arc<Mutex<HashMap<String, TerminalSession>>>,
    pub serial_sessions: Arc<Mutex<HashMap<String, SerialSession>>>,
    pub ws_sessions: Arc<Mutex<HashMap<String, WsSession>>>,
    pub mqtt_sessions: Arc<Mutex<HashMap<String, MqttSession>>>,
    pub app_handle: AppHandle,
    pub ai_registry: Arc<Mutex<AiProviderRegistry>>,
    pub current_provider: Arc<Mutex<Option<String>>>,
    pub current_model: Arc<Mutex<Option<String>>>,
}

impl AppState {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            terminals: Arc::new(Mutex::new(HashMap::new())),
            serial_sessions: Arc::new(Mutex::new(HashMap::new())),
            ws_sessions: Arc::new(Mutex::new(HashMap::new())),
            mqtt_sessions: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
            ai_registry: Arc::new(Mutex::new(AiProviderRegistry::new())),
            current_provider: Arc::new(Mutex::new(None)),
            current_model: Arc::new(Mutex::new(None)),
        }
    }
}
