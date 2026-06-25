use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex as StdMutex};

use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::protocol::grpc::GrpcSession;
use crate::protocol::modbus::ModbusSession;
use crate::protocol::mqtt::MqttSession;
use crate::protocol::serial::SerialSession;
use crate::protocol::sniffer::SnifferSession;
use crate::protocol::ws::WsSession;
use omnipanel_core::terminal::Terminal;
use omnipanel_docker::DockerExecSession;
use omnipanel_exec::{ExecutionEngine, ShellExecutor};
use omnipanel_ssh::SshSession;
use omnipanel_store::{DatabaseConnectionStore, FileIndexStorage, Storage};

/// Proxy 配置，从前端设置同步到后端。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

use omnipanel_ai::provider::AiProviderRegistry;

use crate::background::SshPool;
use crate::commands::ssh::SshTunnelInfo;
use crate::log_store::LogStore;
use crate::output_buffer::{self, OutputBuffers};
use omnipanel_mcp::SharedMcpManager;

/// Docker 容器交互终端会话条目（含归属，便于切换/重进时回收旧 PTY）。
pub struct DockerExecSessionEntry {
    pub session: DockerExecSession,
    pub connection_id: String,
    pub container_id: String,
}

pub struct AppState {
    pub serial_sessions: Arc<Mutex<HashMap<String, SerialSession>>>,
    pub ws_sessions: Arc<Mutex<HashMap<String, WsSession>>>,
    pub mqtt_sessions: Arc<Mutex<HashMap<String, MqttSession>>>,
    pub grpc_sessions: Arc<Mutex<HashMap<String, GrpcSession>>>,
    pub sniffer_sessions: Arc<Mutex<HashMap<String, SnifferSession>>>,
    pub modbus_sessions: Arc<Mutex<HashMap<String, ModbusSession>>>,
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
    /// 活跃 SSH 会话（交互式）。
    pub ssh_sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    /// SSH 连接池（端口探测 + 按需会话；池内会话由 `SshPool` 持有）。
    pub ssh_pool: Arc<SshPool>,
    /// 终端/SSH 输出 scrollback 缓冲（会话恢复用）。
    pub output_buffers: OutputBuffers,
    /// 后台任务日志存储。
    pub log_store: LogStore,
    /// Docker SSH-Engine 连接的复用会话池（按 docker 连接 id 索引）。
    pub docker_ssh_sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
    /// 活跃 Docker 日志流的停止句柄（按 streamId 索引）。
    pub docker_log_streams: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// 活跃 Docker stats 流的停止句柄（按 streamId 索引）。
    pub docker_stats_streams: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// 活跃 Docker 容器交互终端会话（按 sessionId 索引）。
    pub docker_exec_sessions: Arc<Mutex<HashMap<String, DockerExecSessionEntry>>>,
    /// 活跃 SSH 隧道（按 tunnelId 索引）。
    pub ssh_tunnels: Arc<Mutex<HashMap<String, SshTunnelInfo>>>,
    /// 正在运行的工作流执行（按 executionId 索引，AtomicBool 为 cancel flag）。
    pub running_workflows: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// 正在运行的任务后台句柄（按 taskId 索引），用于 task_stop 取消。
    pub running_tasks: Arc<Mutex<HashMap<String, tokio::task::JoinHandle<()>>>>,
    /// 文件管理器独立 SFTP 会话（按 file 连接 id 索引）。
    pub file_sftp_sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
    /// 文件索引独立 SQLite 存储（目录可在设置中配置）。
    pub file_index_storage: Arc<Mutex<FileIndexStorage>>,
    /// 用户配置的索引存储目录，空字符串表示默认 `~/.omnipd/files/index`。
    pub file_index_storage_dir: Arc<Mutex<String>>,
    /// 文件索引后台任务取消标记（按连接 id）。
    pub file_index_tasks: Arc<StdMutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// 本轮会话内已验证可用的文件连接（测试通过或成功列目录）。
    pub file_connection_online: Arc<StdMutex<HashSet<String>>>,
    /// 网络代理配置（由前端通用设置同步而来）。
    pub proxy_config: Arc<Mutex<ProxyConfig>>,
    /// MCP 服务管理器（内置 OmniMCP + 用户自定义服务）。
    pub mcp_manager: SharedMcpManager,
}

impl AppState {
    pub fn new(
        app_handle: AppHandle,
        storage: Arc<Mutex<Storage>>,
        file_index_storage: Arc<Mutex<FileIndexStorage>>,
        file_index_storage_dir: String,
        db_connections: DatabaseConnectionStore,
        mcp_manager: SharedMcpManager,
    ) -> Self {
        let log_store = LogStore::new(500);
        let ssh_pool_sessions = Arc::new(Mutex::new(HashMap::new()));
        let ssh_pool = Arc::new(SshPool::new(log_store.clone(), ssh_pool_sessions.clone()));

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
            grpc_sessions: Arc::new(Mutex::new(HashMap::new())),
            sniffer_sessions: Arc::new(Mutex::new(HashMap::new())),
            modbus_sessions: Arc::new(Mutex::new(HashMap::new())),
            terminal_sessions: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
            ai_registry: Arc::new(Mutex::new(AiProviderRegistry::new())),
            current_provider: Arc::new(Mutex::new(None)),
            current_model: Arc::new(Mutex::new(None)),
            db_connections,
            storage,
            engine: Arc::new(engine),
            ssh_sessions: Arc::new(Mutex::new(HashMap::new())),
            ssh_pool,
            output_buffers: output_buffer::new_buffers(),
            log_store,
            docker_ssh_sessions: Arc::new(Mutex::new(HashMap::new())),
            docker_log_streams: Arc::new(Mutex::new(HashMap::new())),
            docker_stats_streams: Arc::new(Mutex::new(HashMap::new())),
            docker_exec_sessions: Arc::new(Mutex::new(HashMap::new())),
            ssh_tunnels: Arc::new(Mutex::new(HashMap::new())),
            running_workflows: Arc::new(Mutex::new(HashMap::new())),
            running_tasks: Arc::new(Mutex::new(HashMap::new())),
            file_sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            file_index_storage,
            file_index_storage_dir: Arc::new(Mutex::new(file_index_storage_dir)),
            file_index_tasks: Arc::new(StdMutex::new(HashMap::new())),
            file_connection_online: Arc::new(StdMutex::new(HashSet::new())),
            proxy_config: Arc::new(Mutex::new(ProxyConfig::default())),
            mcp_manager,
        }
    }
}
