use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::agent::AgentRegistry;
use crate::protocol::grpc::GrpcSession;
use crate::protocol::modbus::ModbusSession;
use crate::protocol::mqtt::MqttSession;
use crate::protocol::redis_pubsub::RedisPubSubSession;
use crate::protocol::serial::SerialSession;
use crate::protocol::sniffer::SnifferSession;
use crate::protocol::sse::SseSession;
use crate::protocol::ws::WsSession;
use omnipanel_core::terminal::Terminal;
use omnipanel_db::DbDriver;
use omnipanel_docker::DockerExecSession;
use omnipanel_exec::{ExecutionEngine, ShellExecutor};
use omnipanel_ssh::SshSession;
use omnipanel_store::{AppModuleStatus, DatabaseConnectionStore, FileIndexStorage, Storage};

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

use crate::background::{BackgroundWorkerPool, SshPool, default_worker_count};
use crate::commands::ssh::SshTunnelInfo;
use crate::commands::ssh_capabilities::CapabilityCache;
use crate::log_store::LogStore;
use crate::media_stream::MediaStreamServer;
use crate::output_buffer::{self, OutputBuffers};
use crate::ssh_tmux::TmuxManager;
use omnipanel_mcp::SharedMcpManager;
use omnipanel_plugin::{InvokeGateway, PluginRegistry};

/// Docker 容器交互终端会话条目（含归属，便于切换/重进时回收旧 PTY）。
pub struct DockerExecSessionEntry {
    pub session: DockerExecSession,
    pub connection_id: String,
    pub container_id: String,
}

/// SQL 编辑器手动事务会话：独占连接 + 是否已 BEGIN。
pub struct DbQueryTxSession {
    pub driver: Box<dyn DbDriver>,
    pub in_transaction: bool,
}

pub type DbQueryTxSessionHandle = Arc<Mutex<DbQueryTxSession>>;

pub struct AppState {
    pub serial_sessions: Arc<Mutex<HashMap<String, SerialSession>>>,
    pub ws_sessions: Arc<Mutex<HashMap<String, WsSession>>>,
    pub sse_sessions: Arc<Mutex<HashMap<String, SseSession>>>,
    pub mqtt_sessions: Arc<Mutex<HashMap<String, MqttSession>>>,
    pub redis_pubsub_sessions: Arc<Mutex<HashMap<String, RedisPubSubSession>>>,
    pub grpc_sessions: Arc<Mutex<HashMap<String, GrpcSession>>>,
    pub sniffer_sessions: Arc<Mutex<HashMap<String, SnifferSession>>>,
    pub modbus_sessions: Arc<Mutex<HashMap<String, ModbusSession>>>,
    pub terminal_sessions: Arc<Mutex<HashMap<String, Terminal>>>,
    pub app_handle: AppHandle,
    pub ai_registry: Arc<Mutex<AiProviderRegistry>>,
    #[allow(dead_code)]
    pub current_provider: Arc<Mutex<Option<String>>>,
    #[allow(dead_code)]
    pub current_model: Arc<Mutex<Option<String>>>,
    pub db_connections: DatabaseConnectionStore,
    /// 本地元数据存储（连接、审计等）。
    pub storage: Arc<Mutex<Storage>>,
    /// 动作执行引擎（按 kind 分发到各 Executor）。
    pub engine: Arc<ExecutionEngine>,
    /// 活跃 SSH 会话（交互式，直连模式）。tmux 模式的会话不在此表内。
    pub ssh_sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    /// SSH 连接池（端口探测 + 按需会话；池内会话由 `SshPool` 持有）。
    pub ssh_pool: Arc<SshPool>,
    /// 远程终端的 tmux control mode 复用层（按 `user@host:port` 复用连接）。
    pub tmux: Arc<TmuxManager>,
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
    /// 正在运行的 SQL 查询 abort 句柄（按 runId 索引），用于 db_cancel_query。
    pub running_db_queries: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
    /// SQL Tab 手动事务会话（按 sessionId=tabId 索引；独占连接以保持事务）。
    pub db_query_sessions: Arc<Mutex<HashMap<String, DbQueryTxSessionHandle>>>,
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
    /// 跨连接文件传输引擎。
    pub file_transfers: Arc<crate::commands::file_transfer::FileTransferEngine>,
    /// 网络代理配置（由前端通用设置同步而来）。
    pub proxy_config: Arc<Mutex<ProxyConfig>>,
    /// MCP 服务管理器（内置 OmniMCP + 用户自定义服务）。
    pub mcp_manager: SharedMcpManager,
    /// ACP agent 连接与会话管理。
    pub acp_state: Arc<Mutex<crate::commands::acp::AcpState>>,
    /// Internal AI chat 取消标记（conversation_id → cancel flag）。
    pub internal_chat_cancel_flags: crate::commands::ai_chat::InternalChatCancelFlags,
    /// 外部 Agent（ACP）多 profile 注册表。
    pub agent_registry: Arc<AgentRegistry>,
    /// 全局后台任务线程池（对比分析等 CPU/IO 密集型任务）。
    pub worker_pool: Arc<BackgroundWorkerPool>,
    /// Internal AI UiDelegated 工具审批/执行等待（conversation_id:tool_call_id → oneshot）。
    /// 统一通道：终端与数据库等所有 UiDelegated 工具都挂在这里，由前端 dispatchTool 回传。
    pub pending_internal_tool_results:
        Arc<Mutex<HashMap<String, tokio::sync::oneshot::Sender<(String, bool)>>>>,
    /// Agent Router 句柄（可选）。
    pub gateway_handle: Arc<Mutex<Option<omnipanel_gateway::GatewayHandle>>>,
    /// 外部 MCP 工具调用是否需用户审批（由设置同步）。
    pub mcp_external_require_approval: Arc<std::sync::atomic::AtomicBool>,
    /// 本地媒体 Range 代理（边下边播）。
    pub media_stream: Arc<MediaStreamServer>,
    /// 活跃日志跟踪流（按 token 索引），用于 sftp_log_tail_stop 主动停止。
    pub log_tail_streams: Arc<Mutex<HashMap<String, omnipanel_ssh::SshStreamHandle>>>,
    /// 远端工具能力探测结果缓存（按 resource_id 索引，TTL 5 分钟）。
    pub capability_cache: Arc<CapabilityCache>,
    /// 插件 Runtime（清单 / 启用 / 贡献点）。
    pub plugin_registry: Arc<Mutex<PluginRegistry>>,
    /// 第一方 `plugin_invoke` 白名单网关（编译期登记，运行期只读共享）。
    pub plugin_invoke: Arc<InvokeGateway>,
    /// 磁盘安装插件根目录（`app_data/plugins/`）；定位失败为 None（仅内置可用）。
    pub plugin_packages_dir: Option<PathBuf>,
    /// L2 逻辑执行器；构建未启用 `plugin-wasm` feature 时为 None。
    pub plugin_logic_executor: Option<Arc<dyn omnipanel_plugin::PluginLogicExecutor>>,
    /// prod 确认等待表（request_id → 回传通道）。
    pub plugin_pending_confirms:
        Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::oneshot::Sender<bool>>>>,
    /// L2 桥共享 HTTP 客户端（复用代理配置）。
    pub plugin_http: reqwest::Client,
    /// 已实例化的 L2 逻辑执行体（plugin_id → instance）。
    pub plugin_logic_instances: Arc<
        std::sync::Mutex<
            HashMap<
                String,
                std::sync::Arc<std::sync::Mutex<Box<dyn omnipanel_plugin::PluginLogicInstance>>>,
            >,
        >,
    >,
    /// 终端 tmux 模式偏好：auto / always / never，由前端设置同步。
    pub terminal_tmux_mode: Arc<std::sync::Mutex<String>>,
}

impl AppState {
    pub async fn new(
        app_handle: AppHandle,
        storage: Arc<Mutex<Storage>>,
        file_index_storage: Arc<Mutex<FileIndexStorage>>,
        file_index_storage_dir: String,
        db_connections: DatabaseConnectionStore,
        mcp_manager: SharedMcpManager,
    ) -> Self {
        let log_store = LogStore::new(500);
        let ssh_pool_sessions = Arc::new(Mutex::new(HashMap::new()));
        let ssh_pool = Arc::new(SshPool::new(
            log_store.clone(),
            ssh_pool_sessions.clone(),
            storage.clone(),
        ));

        let mut engine = ExecutionEngine::new();
        let shell = Arc::new(ShellExecutor);
        // 本地命令型动作统一走 shell 执行器；ssh/sql 待 M3/M5 注册专用 executor。
        engine.register("terminal", shell.clone());
        engine.register("docker", shell.clone());
        engine.register("server", shell.clone());

        let ssh_sessions: Arc<Mutex<HashMap<String, SshSession>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let media_stream = Arc::new(
            MediaStreamServer::start(ssh_sessions.clone(), ssh_pool.clone())
                .await
                .expect("启动媒体流代理失败"),
        );
        let plugin_packages_dir = app_handle
            .path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join("plugins"));
        let (plugin_registry, plugin_invoke) = {
            let store = storage.lock().await;
            crate::commands::plugin::seed_plugin_runtime(&store, plugin_packages_dir.as_deref())
        };
        {
            let extras = plugin_registry.module_seeds();
            let pairs: Vec<(&str, i32, AppModuleStatus)> = extras
                .iter()
                .map(|(key, order)| (key.as_str(), *order, AppModuleStatus::Closed))
                .collect();
            let store = storage.lock().await;
            let _ = store.repair_app_modules_with_plugins(&pairs);
        }
        {
            let mcp = mcp_manager.lock().await;
            crate::commands::plugin::sync_native_plugin_tools(
                &plugin_registry,
                &mcp.tool_registry,
                &plugin_invoke,
            );
        }
        crate::commands::plugin::remap_highgo_identity_connections(
            &db_connections,
            &plugin_registry,
        );
        let _ = db_connections.purge_local_docker_seed_connections();

        Self {
            serial_sessions: Arc::new(Mutex::new(HashMap::new())),
            ws_sessions: Arc::new(Mutex::new(HashMap::new())),
            sse_sessions: Arc::new(Mutex::new(HashMap::new())),
            mqtt_sessions: Arc::new(Mutex::new(HashMap::new())),
            redis_pubsub_sessions: Arc::new(Mutex::new(HashMap::new())),
            grpc_sessions: Arc::new(Mutex::new(HashMap::new())),
            sniffer_sessions: Arc::new(Mutex::new(HashMap::new())),
            modbus_sessions: Arc::new(Mutex::new(HashMap::new())),
            terminal_sessions: Arc::new(Mutex::new(HashMap::new())),
            app_handle,
            ai_registry: Arc::new(Mutex::new(AiProviderRegistry::new())),
            current_provider: Arc::new(Mutex::new(None)),
            current_model: Arc::new(Mutex::new(None)),
            db_connections,
            storage: storage.clone(),
            engine: Arc::new(engine),
            ssh_sessions,
            ssh_pool,
            tmux: Arc::new(TmuxManager::new()),
            output_buffers: output_buffer::new_buffers(),
            log_store,
            docker_ssh_sessions: Arc::new(Mutex::new(HashMap::new())),
            docker_log_streams: Arc::new(Mutex::new(HashMap::new())),
            docker_stats_streams: Arc::new(Mutex::new(HashMap::new())),
            docker_exec_sessions: Arc::new(Mutex::new(HashMap::new())),
            ssh_tunnels: Arc::new(Mutex::new(HashMap::new())),
            running_workflows: Arc::new(Mutex::new(HashMap::new())),
            running_tasks: Arc::new(Mutex::new(HashMap::new())),
            running_db_queries: Arc::new(Mutex::new(HashMap::new())),
            db_query_sessions: Arc::new(Mutex::new(HashMap::new())),
            file_sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            file_index_storage,
            file_index_storage_dir: Arc::new(Mutex::new(file_index_storage_dir)),
            file_index_tasks: Arc::new(StdMutex::new(HashMap::new())),
            file_connection_online: Arc::new(StdMutex::new(HashSet::new())),
            file_transfers: Arc::new(
                crate::commands::file_transfer::FileTransferEngine::new(storage.clone()).await,
            ),
            proxy_config: Arc::new(Mutex::new(ProxyConfig::default())),
            mcp_manager,
            acp_state: Arc::new(Mutex::new(crate::commands::acp::AcpState::default())),
            internal_chat_cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            agent_registry: Arc::new(AgentRegistry::default()),
            worker_pool: Arc::new(BackgroundWorkerPool::new(default_worker_count(), storage)),
            pending_internal_tool_results: Arc::new(Mutex::new(HashMap::new())),
            gateway_handle: Arc::new(Mutex::new(None)),
            mcp_external_require_approval: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            media_stream,
            log_tail_streams: Arc::new(Mutex::new(HashMap::new())),
            capability_cache: Arc::new(CapabilityCache::new()),
            plugin_registry: Arc::new(Mutex::new(plugin_registry)),
            plugin_invoke,
            plugin_packages_dir,
            plugin_pending_confirms: Arc::new(Mutex::new(HashMap::new())),
            plugin_http: reqwest::Client::builder()
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            plugin_logic_executor: crate::commands::plugin::make_logic_executor(),
            plugin_logic_instances: Arc::new(std::sync::Mutex::new(HashMap::new())),
            terminal_tmux_mode: Arc::new(std::sync::Mutex::new("auto".to_string())),
        }
    }
}
