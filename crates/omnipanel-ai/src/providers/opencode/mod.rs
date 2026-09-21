//! OpenCode HTTP Client（连本地 `opencode serve`）。
//!
//! 契约（V2 `/api/*`）：
//! - 鉴权：Basic `opencode:{password}`（`~/.config/opencode/service.json`）
//! - 建会话：`POST /api/session` + `model: { providerID, id }`
//! - 发消息：`POST /api/session/{id}/prompt` + `{ text }`
//! - 事件：`GET /api/event` SSE（`session.text.delta` / `session.execution.*`）
//! - 模型：`GET /api/model`

mod client;
mod service;
mod turn;

pub use client::{OpenCodeClient, OpenCodeModel};
pub use service::{OpenCodeEndpoint, ensure_opencode_service, list_opencode_models};
pub use turn::{OpenCodeSessionStore, run_opencode_http_turn};
