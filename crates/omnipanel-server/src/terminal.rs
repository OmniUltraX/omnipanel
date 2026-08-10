//! 本地终端会话管理（Web 版）。
//!
//! 复刻 `src-tauri/src/commands/terminal.rs` 的 P0 子集：`create_terminal` /
//! `write_terminal` / `resize_terminal` / `close_terminal` / `terminal_snapshot` /
//! `list_shells`。输出经 [`EventBus`](crate::bus::EventBus) 广播，替代 Tauri `app.emit`。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_core::output_buffer;
use omnipanel_core::terminal::{list_available_shells, ShellInfo, ShellSpec, Terminal, TerminalConfig};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::bus::{EventBus, SessionEvent};

static TERMINAL_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Web 服务端持有的会话状态（P0 终端 + P1 DB/SSH/Docker）。
pub struct ServerState {
    /// 终端会话表。
    pub terminal_sessions: Mutex<HashMap<String, Terminal>>,
    /// 输出 scrollback 缓冲（与桌面端共用实现）。
    pub output_buffers: omnipanel_core::output_buffer::OutputBuffers,
    /// 事件总线（WS 广播）。
    pub bus: EventBus,
    /// 元数据存储（连接、审计等，与桌面端共用 `~/.omnipd/store/omnipanel.db`）。
    pub storage: Arc<Mutex<omnipanel_store::Storage>>,
    /// DB 连接仓库（`~/.omnipd/database/connections.json`）。
    pub db_connections: Arc<omnipanel_store::DatabaseConnectionStore>,
    /// 运行中 SQL 查询 abort 句柄（按 run_id）。
    pub running_db_queries: Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>,
    /// 活跃 SSH 会话（交互式 shell，按会话 id）。
    pub ssh_sessions: Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>,
    /// Docker SSH-Engine 连接复用会话池（按 docker 连接 id）。
    pub docker_ssh_sessions: Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>,
    /// 活跃 Docker 日志流的停止句柄（按 streamId 索引）。
    pub docker_log_streams: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// 活跃 Docker stats 流的停止句柄（按 streamId 索引）。
    pub docker_stats_streams: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// 活跃 Docker 容器交互终端会话（按 sessionId 索引）。
    pub docker_exec_sessions: Arc<Mutex<HashMap<String, crate::docker_ops::DockerExecSessionEntry>>>,
    /// 活跃 AI 对话流的取消标志（按 conversation_id）。
    pub ai_chat_cancel_flags: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// 文件管理器 SFTP 会话（按 file 连接 id，进程内缓存）。
    pub file_sftp_sessions: Arc<Mutex<HashMap<String, Arc<omnipanel_ssh::SshSession>>>>,
    /// 跨连接 relay 传输的取消标志（按 job id）。
    pub transfer_cancel_flags: Arc<Mutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    /// MCP 管理器（懒初始化：bootstrap 内置 OmniMCP HTTP 服务 + stdio 子进程）。
    pub mcp_manager: Arc<Mutex<Option<omnipanel_mcp::SharedMcpManager>>>,
    /// 外部 MCP 工具是否需审批（默认 true，与桌面端一致）。false 时服务端直接自执。
    pub mcp_external_require_approval: Arc<std::sync::atomic::AtomicBool>,
    /// 挂起等待审批/回传的外部工具结果通道（`conversation_id:tool_call_id` → oneshot）。
    pub pending_internal_tool_results:
        Arc<tokio::sync::Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<(String, bool)>>>>,
}

impl Default for ServerState {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerState {
    pub fn new() -> Self {
        let storage = crate::state::open_meta_storage()
            .expect("打开 ~/.omnipd/store/omnipanel.db 失败");
        let db_connections = crate::state::open_db_connections()
            .expect("加载数据库连接配置失败");
        Self {
            terminal_sessions: Mutex::new(HashMap::new()),
            output_buffers: output_buffer::new_buffers(),
            bus: EventBus::new(),
            storage,
            db_connections,
            running_db_queries: Arc::new(Mutex::new(HashMap::new())),
            ssh_sessions: Arc::new(Mutex::new(HashMap::new())),
            docker_ssh_sessions: Arc::new(Mutex::new(HashMap::new())),
            docker_log_streams: Arc::new(Mutex::new(HashMap::new())),
            docker_stats_streams: Arc::new(Mutex::new(HashMap::new())),
            docker_exec_sessions: Arc::new(Mutex::new(HashMap::new())),
            ai_chat_cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            file_sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            transfer_cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            mcp_manager: Arc::new(Mutex::new(None)),
            mcp_external_require_approval: Arc::new(std::sync::atomic::AtomicBool::new(true)),
            pending_internal_tool_results: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 懒初始化 MCP 管理器（幂等；失败返回 None 时相关 IPC/AI 外部工具会报明确错误）。
    pub async fn ensure_mcp_manager(&self) -> Option<omnipanel_mcp::SharedMcpManager> {
        let mut slot = self.mcp_manager.lock().await;
        if let Some(m) = slot.as_ref() {
            return Some(m.clone());
        }
        match omnipanel_mcp::McpManager::bootstrap(self.storage.clone()).await {
            Ok(manager) => {
                let shared: omnipanel_mcp::SharedMcpManager = Arc::new(Mutex::new(manager));
                *slot = Some(shared.clone());
                Some(shared)
            }
            Err(e) => {
                tracing::error!(error = %e, "MCP 管理器初始化失败，Web 端外部 MCP 不可用");
                None
            }
        }
    }

    /// 创建本地终端（本地 PTY），输出经事件总线广播。
    pub async fn create_terminal(
        &self,
        cols: u16,
        rows: u16,
        shell: Option<ShellSpec>,
    ) -> Result<String, String> {
        let id = format!("term-{}", TERMINAL_COUNTER.fetch_add(1, Ordering::Relaxed));

        let config = TerminalConfig {
            cols,
            rows,
            shell,
            ..Default::default()
        };
        let mut session =
            Terminal::new(config).map_err(|e| format!("Failed to spawn terminal: {e}"))?;

        // 与桌面端一致：取 reader 后由后台线程转发输出到事件总线。
        let reader = session
            .take_reader()
            .ok_or_else(|| "Failed to take PTY reader".to_string())?;

        let session_id = id.clone();
        let buffers = self.output_buffers.clone();
        let bus = self.bus.clone();

        std::thread::spawn(move || {
            use std::io::Read;
            let mut reader = reader;
            // 64KB 读缓冲：大输出场景（如 cat 大文件）下单次 read 可吞下整个
            // conpty 默认 64KB 管道缓冲（与桌面端保持一致）。
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let chunk = &buf[..n];
                        output_buffer::append(&buffers, &session_id, chunk);
                        bus.emit_terminal_output(&session_id, STANDARD.encode(chunk));
                    }
                    Err(_) => {
                        bus.emit_terminal_event(&session_id, SessionEvent::Exited);
                        break;
                    }
                }
            }
        });

        self.terminal_sessions.lock().await.insert(id.clone(), session);
        Ok(id)
    }

    /// 写入终端输入。
    pub async fn write_terminal(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.terminal_sessions.lock().await;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("Terminal session {id} not found"))?;
        session
            .write(data)
            .map_err(|e| format!("Failed to write to terminal: {e}"))
    }

    /// 调整终端尺寸。
    pub async fn resize_terminal(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self.terminal_sessions.lock().await;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("Terminal session {id} not found"))?;
        session
            .resize(cols, rows)
            .map_err(|e| format!("Failed to resize terminal: {e}"))
    }

    /// 关闭终端会话并清理缓冲。
    pub async fn close_terminal(&self, id: &str) {
        let mut sessions = self.terminal_sessions.lock().await;
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.kill();
        }
        output_buffer::remove(&self.output_buffers, id);
    }

    /// 会话当前 scrollback 快照（base64），前端重连/remount 时重建屏幕。
    pub fn terminal_snapshot(&self, id: &str) -> String {
        let bytes = output_buffer::snapshot(&self.output_buffers, id).unwrap_or_default();
        STANDARD.encode(bytes)
    }

    /// 枚举当前系统可用的本地 shell。
    pub fn list_shells(&self) -> Result<Vec<ShellInfo>, String> {
        Ok(list_available_shells())
    }
}

/// `POST /ipc/invoke` 请求体（供 ipc.rs 使用）。
#[derive(Debug, Deserialize)]
pub struct InvokeRequest {
    pub cmd: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// `POST /ipc/invoke` 响应体（供 ipc.rs 使用）。
#[derive(Debug, serde::Serialize)]
pub struct InvokeResponse<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl InvokeResponse<serde_json::Value> {
    pub fn ok(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}
