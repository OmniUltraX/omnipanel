//! OmniPanel Web 服务端（P0：Web 化 + 前后端分离）。
//!
//! 架构：不改任何业务代码，只把 Tauri IPC 的底层传输从 WebView 换成 HTTP + WebSocket。
//! 浏览器与桌面共用同一套前端产物、同一个 Rust 后端能力：
//!
//! - `POST /ipc/invoke`：`{ cmd, args }` → 分发到命令实现（等价于 Tauri `invoke`）。
//! - `WS  /ipc/events`：订阅后端事件流（等价于 Tauri `listen`）。
//! - `GET /`：静态托管 `frontend/dist`（浏览器直接打开即用）。
//!
//! P0 范围：本地终端链路（`create_terminal` / `write_terminal` / `resize_terminal` /
//! `close_terminal` / `terminal_snapshot` / `list_shells`），其余命令后续按模块渐进接入。

pub mod bus;
pub mod ipc;
pub mod server;
pub mod terminal;
pub mod ws;

pub use bus::{EventBus, EventKind, EventPayload, SessionEvent};
pub use server::{run_server, ServerConfig, ServerHandle};
