use std::collections::HashMap;
use std::sync::Arc;

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::protocol::mqtt::MqttSession;
use crate::protocol::serial::SerialSession;
use crate::protocol::ws::WsSession;
use omnipanel_core::terminal::Terminal;
use omnipanel_exec::{ExecutionEngine, ShellExecutor};
use omnipanel_ssh::SshSession;
use omnipanel_store::{DatabaseConnectionStore, Storage};

use omnipanel_ai::provider::AiProviderRegistry;

use crate::log_store::LogStore;
use crate::output_buffer::{self, OutputBuffers};

pub struct AppState {
    pub serial_sessions: Arc<Mutex<HashMap<String, SerialSession>>>,
    pub ws_sessions: Arc<Mutex<HashMap<String, WsSession>>>,
    pub mqtt_sessions: Arc<Mutex<HashMap<String, MqttSession>>>,
    pub terminal_sessions: Arc<Mutex<HashMap<String, Terminal>>>,
    pub app_handle: AppHandle,
    pub ai_registry: Arc<Mutex<AiProviderRegistry>>,
    pub current_provider: Arc<Mutex<Option<String>>>,
    pub current_model: Arc<Mutex<Option<String>>>,
    pub db_connections: DatabaseConnectionStore,
    /// 本地元数据存储（连接、审计等）。
    pub storage: Arc<Mutex<Storage>>,
    /// 动作执行引擎（按 kind 分发到各 Executor）。
    pub engine: Arc<ExecutionEngine>,
    /// 活跃 SSH 会话。
    pub ssh_sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    /// 终端/SSH 输出 scrollback 缓冲（会话恢复用）。
    pub output_buffers: OutputBuffers,
    /// 后台任务日志存储。
    pub log_store: LogStore,
}

impl AppState {
    pub fn new(app_handle: AppHandle, storage: Storage, db_connections: DatabaseConnectionStore) -> Self {
        let mut engine = ExecutionEngine::new();
        let shell = Arc::new(ShellExecutor);
        // 本地命令型动作统一走 shell 执行器；ssh/sql 待 M3/M5 注册专用 executor。
        engine.register("terminal", shell.clone());
        engine.register("docker", shell.clone());
        engine.register("server", shell.clone());
        Self {
            serial_sessions: Arc::new(Mutex::new(HashMap::new())),
            ws_sessions: Arc::new(Mutex::new(HashMap::new())),
            mqtt_sessions: Arc::new(Mutex::new(HashMap::new())),
            terminal_sessions: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
            ai_registry: Arc::new(Mutex::new(AiProviderRegistry::new())),
            current_provider: Arc::new(Mutex::new(None)),
            current_model: Arc::new(Mutex::new(None)),
            db_connections,
            storage: Arc::new(Mutex::new(storage)),
            engine: Arc::new(engine),
            ssh_sessions: Arc::new(Mutex::new(HashMap::new())),
            output_buffers: output_buffer::new_buffers(),
            log_store: LogStore::new(500),
        }
    }
}
