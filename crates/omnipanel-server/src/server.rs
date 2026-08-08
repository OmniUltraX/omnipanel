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
    /// API Key（可选）。配置后 `/ipc/invoke` / `/ipc/events` 需要 `Authorization: Bearer <key>`。
    pub api_key: Option<String>,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind_addr: format!("127.0.0.1:{DEFAULT_WEB_PORT}"),
            static_dir: None,
            api_key: None,
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

/// 应用上下文：共享 `ServerState` + API Key 鉴权配置。
#[derive(Clone)]
pub struct AppCtx {
    pub(crate) state: Arc<ServerState>,
    pub(crate) api_key: Option<String>,
}

/// 启动 HTTP/WS 服务（阻塞直至端口就绪或失败）。
pub fn run_server(config: ServerConfig) -> anyhow::Result<ServerHandle> {
    let state = Arc::new(ServerState::new());
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app_ctx = AppCtx {
        state,
        api_key: config.api_key.clone().filter(|k| !k.trim().is_empty()),
    };

    let mut router = Router::new()
        .route("/ipc/invoke", post(invoke_handler))
        .route("/ipc/events", get(ws::ws_events))
        .route("/ipc/status", get(status_handler))
        .route("/healthz", get(healthz))
        .layer(cors)
        .with_state(app_ctx);

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

/// 校验请求是否带有效 API Key（未配置时放行）。
fn check_api_key(ctx: &AppCtx, headers: &axum::http::HeaderMap) -> Result<(), axum::response::Response> {
    if let Some(ref expected) = ctx.api_key {
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let token = auth.strip_prefix("Bearer ").unwrap_or(auth);
        if token != expected {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "invalid api key" })),
            )
                .into_response());
        }
    }
    Ok(())
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok", "service": "omnipanel-server" }))
}

async fn status_handler(State(_ctx): State<AppCtx>) -> impl IntoResponse {
    Json(serde_json::json!({
        "service": "omnipanel-server",
        "ipc": "/ipc/invoke",
        "events": "/ipc/events (WebSocket)",
        "p0_commands": ["create_terminal", "write_terminal", "resize_terminal", "close_terminal", "terminal_snapshot", "list_shells"],
        "p1_db_commands": ["db_list_connections", "db_get_connection_secret", "db_save_connection", "db_delete_connection", "db_test_connection", "db_list_databases", "db_list_tables", "db_preview_table", "db_count_table", "db_count_tables", "db_execute_query", "db_cancel_query", "db_run_sql"],
        "p1_ssh_commands": ["ssh_list_connections", "ssh_connect_connection", "ssh_write", "ssh_resize", "ssh_disconnect"],
        "p1_docker_commands": ["docker_list_connections", "docker_probe_connection", "docker_get_overview", "docker_list_containers", "docker_get_local_engine_status", "docker_reset_ssh_session"],
    }))
}

async fn invoke_handler(
    State(ctx): State<AppCtx>,
    headers: axum::http::HeaderMap,
    Json(req): Json<InvokeRequest>,
) -> impl IntoResponse {
    if let Err(resp) = check_api_key(&ctx, &headers) {
        return resp;
    }
    let resp = ipc::dispatch(&ctx.state, req).await;
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
