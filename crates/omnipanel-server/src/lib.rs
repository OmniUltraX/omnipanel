//! OmniPanel Web 服务端（P1：Web 化 + 前后端分离 + 运维闭环）。
//!
//! 架构：不改任何业务代码，只把 Tauri IPC 的底层传输从 WebView 换成 HTTP + WebSocket。
//! 浏览器与桌面共用同一套前端产物、同一个 Rust 后端能力：
//!
//! - `POST /ipc/invoke`：`{ cmd, args }` → 分发到命令实现（等价于 Tauri `invoke`）。
//! - `WS  /ipc/events`：订阅后端事件流（等价于 Tauri `listen`）。
//! - `GET /`：静态托管 `frontend/dist`（浏览器直接打开即用）。
//!
//! P0 范围：本地终端链路；P1 范围：DB / SSH / Docker 核心只读 + 会话链路 + API Key 鉴权。
//! 详见 `docs/web-p1.md`。

pub mod acp_cmds;
pub mod ai;
pub mod ai_tools;
pub mod agents_detect;
pub mod assistant_cmds;
pub mod auth_cmds;
pub mod bg_task_cmds;
pub mod bg_worker_pool;
pub mod bus;
pub mod client_sync_cmds;
pub mod client_sync_modules_cmds;
pub mod cloud;
pub mod cloud_cmds;
pub mod db;
pub mod db_mysql_export;
pub mod db_sync;
pub mod db_sync_bridge;
pub mod db_sync_diff;
pub mod docker;
pub mod docker_ops;
pub mod docker_ssh_detect;
pub mod docker_swarm;
pub mod embedding_cmds;
pub mod defer_cmds;
pub mod exec_cmds;
pub mod file_index;
pub mod file_transfer;
pub mod files;
pub mod files_conn;
pub mod http_client;
pub mod ipc;
pub mod knowledge_cmds;
pub mod knowledge_vector_cmds;
pub mod local_runtime_cmds;
pub mod log_search;
pub mod log_tail;
pub mod mcp;
pub mod monitoring;
pub mod navicat;
pub mod panel;
pub mod panel_cmds;
pub mod pool;
pub mod protocol;
pub mod protocol_cmds;
pub mod resource_profile_cmds;
pub mod server;
pub mod skills_cmds;
pub mod soft_degrade;
pub mod ssh;
pub mod ssh_archive;
pub mod ssh_capabilities;
pub mod ssh_keys;
pub mod ssh_ops;
pub mod ssh_tmux;
pub mod ssh_tmux_cmds;
pub mod state;
pub mod store_bridge;
pub mod store_ext;
pub mod system_cmds;
pub mod terminal;
pub mod terminal_history;
pub mod transfer;
pub mod transfer_host;
pub mod web_search_cmds;
pub mod workflow_cmds;
pub mod ws;

pub use bus::{EventBus, EventPayload, SessionEvent};
pub use server::{run_server, ServerConfig, ServerHandle};
