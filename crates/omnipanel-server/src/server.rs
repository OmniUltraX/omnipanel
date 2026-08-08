//! HTTP 服务入口：`/ipc/invoke` + `WS /ipc/events` + 静态托管 + 健康检查。

use std::sync::Arc;

use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::ServeDir;

use crate::ipc::{self, InvokeRequest};
use crate::terminal::ServerState;
use crate::ws;

/// 默认端口（Web 版独立，不与 gateway 8765/8766 冲突）。
pub const DEFAULT_WEB_PORT: u16 = 8899;

/// 服务配置。
#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub bind_addr: String,
    /// 静态资源目录（`frontend/dist`）。None 时不托管静态文件。
    pub static_dir: Option<std::path::PathBuf>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_addr: format!("127.0.0.1:{DEFAULT_WEB_PORT}"),
            static_dir: None,
        }
    }
}

/// 服务句柄（可优雅停止）。
pub struct ServerHandle {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl ServerHandle {
    pub fn stop(&self) {
        let _ = self.shutdown.send(true);
    }

    /// 停止并等待退出（端口释放后返回）。
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

/// 启动 HTTP/WS 服务（阻塞直至端口就绪或失败）。
pub fn run_server(config: ServerConfig) -> anyhow::Result<ServerHandle> {
    let state = Arc::new(ServerState::new());
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let mut router = Router::new()
        .route("/ipc/invoke", post(invoke_handler))
        .route("/ipc/events", get(ws::ws_events))
        .route("/ipc/status", get(status_handler))
        .route("/healthz", get(healthz))
        .layer(cors)
        .with_state(state);

    if let Some(dir) = &config.static_dir {
        let serve = ServeDir::new(dir);
        router = router.fallback_service(serve);
    }

    let bind = config.bind_addr.clone();
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let task = tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(&bind).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("OmniPanel Web 服务绑定 {bind} 失败: {e}");
                return;
            }
        };
        tracing::info!("OmniPanel Web 服务监听 {bind}");
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.wait_for(|v| *v).await;
            })
            .await
            .ok();
    });

    Ok(ServerHandle {
        shutdown: shutdown_tx,
        task,
    })
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "service": "omnipanel-server" }))
}

async fn status_handler(State(_state): State<Arc<ServerState>>) -> impl IntoResponse {
    Json(serde_json::json!({
        "service": "omnipanel-server",
        "ipc": "/ipc/invoke",
        "events": "/ipc/events (WebSocket)",
        "p0_commands": ["create_terminal", "write_terminal", "resize_terminal", "close_terminal", "terminal_snapshot", "list_shells"],
    }))
}

async fn invoke_handler(
    State(state): State<Arc<ServerState>>,
    Json(req): Json<InvokeRequest>,
) -> impl IntoResponse {
    let resp = ipc::dispatch(&state, req).await;
    if resp.ok {
        (StatusCode::OK, Json(resp)).into_response()
    } else {
        (
            StatusCode::OK, // 与 Tauri invoke 一致：命令错误仍是 200，由 ok:false 表达
            Json(resp),
        )
            .into_response()
    }
}
