//! OpenCode HTTP Client（连本地 `opencode serve`）。
//!
//! 标准契约：
//! - 生命周期：`opencode serve --hostname 127.0.0.1 --port 4096`
//! - 密码：环境变量 `OPENCODE_SERVER_PASSWORD`（默认 `omnipanel-opencode-local`）
//! - 鉴权：Basic `opencode:{password}`
//! - 会话：`/api/session`；发消息：`/api/session/{id}/prompt`
//! - 事件：`GET /api/event` SSE
//! - 模型：`GET /api/model`

mod client;
mod service;
mod turn;

pub use client::{OpenCodeChatMessage, OpenCodeClient, OpenCodeModel, OpenCodeSessionInfo};
pub use service::{
    OpenCodeEndpoint, debug_log_path, ensure_opencode_service, list_opencode_models,
    probe_opencode_online, stop_opencode_serve,
};
pub use turn::run_opencode_http_turn;
