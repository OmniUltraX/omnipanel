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

pub mod ai;
pub mod ai_tools;
pub mod bus;
pub mod db;
pub mod docker;
pub mod docker_ops;
pub mod files;
pub mod ipc;
pub mod mcp;
pub mod server;
pub mod ssh;
pub mod state;
pub mod terminal;
pub mod transfer;
pub mod ws;

pub use bus::{EventBus, EventPayload, SessionEvent};
pub use server::{run_server, ServerConfig, ServerHandle};
