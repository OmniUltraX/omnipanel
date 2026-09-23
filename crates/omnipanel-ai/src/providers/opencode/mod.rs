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
mod mcp_config;
mod service;
mod turn;

pub use client::{
    OpenCodeAgentInfo, OpenCodeChatMessage, OpenCodeClient, OpenCodeMessagePart, OpenCodeModel,
    OpenCodeSessionInfo, OpenCodeTokenUsage, OpenCodeToolCall,
};
pub use mcp_config::{
    OPS_AGENT_ID, OpenCodeConfigSyncOutcome, merge_omnimcp_into_root, merge_ops_agent_into_root,
    merge_runtime_defaults_into_root, omnipanel_opencode_ops_dir, opencode_config_json_path,
    strip_omnimcp_from_global_config, sync_omnimcp_into_opencode_config,
    sync_project_opencode_workspace,
};
pub use service::{
    OpenCodeEndpoint, debug_log_path, ensure_opencode_service, list_opencode_models,
    probe_opencode_online, stop_opencode_serve,
};
pub use turn::run_opencode_http_turn;
