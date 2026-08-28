use std::sync::Arc;

use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
};
use omnipanel_ai::provider::AiProviderRegistry;
use omnipanel_store::Storage;
use serde::Deserialize;
use tokio::sync::Mutex;
use tower_http::cors::{Any, CorsLayer};

use crate::acp_resolver::AcpResolver;
use crate::router::GatewayRouter;

/// 正式版 Agent Router 默认端口。
pub const RELEASE_GATEWAY_PORT: u16 = 8765;
/// 开发构建默认端口（与正式版错开）。
pub const DEV_GATEWAY_PORT: u16 = 8766;

/// 解析实际监听端口：`0` 用构建默认；开发态若仍是正式版默认 `8765` 则改为 `8766`。
pub fn resolve_gateway_port(port: u16) -> u16 {
    let port = if port == 0 {
        if cfg!(debug_assertions) {
            DEV_GATEWAY_PORT
        } else {
            RELEASE_GATEWAY_PORT
        }
    } else {
        port
    };
    if cfg!(debug_assertions) && port == RELEASE_GATEWAY_PORT {
        DEV_GATEWAY_PORT
    } else {
        port
    }
}

#[derive(Clone)]
pub struct GatewayConfig {
    pub bind_addr: String,
    pub api_key: Option<String>,
}

#[derive(Clone)]
struct AppCtx {
    router: Arc<GatewayRouter>,
    api_key: Option<String>,
}

pub struct GatewayHandle {
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

pub fn spawn_gateway(
    config: GatewayConfig,
    ai_registry: Arc<Mutex<AiProviderRegistry>>,
    storage: Option<Arc<Mutex<Storage>>>,
    acp_resolver: Option<Arc<dyn AcpResolver>>,
) -> GatewayHandle {
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    let ctx = AppCtx {
        router: Arc::new(GatewayRouter::new(ai_registry, storage, acp_resolver)),
        api_key: config.api_key.filter(|k| !k.trim().is_empty()),
    };

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .route("/v1/chat/completions", post(chat_completions))
        .route("/v1/models", get(list_models))
        .route("/gateway/healthz", get(healthz))
        .route("/gateway/status", get(status))
        .route("/gateway/metrics", get(metrics))
        .layer(cors)
        .with_state(ctx);

    let bind = config.bind_addr.clone();
    let task = tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(&bind).await {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("Agent Router 绑定 {bind} 失败: {e}");
                return;
            }
        };
        tracing::info!("Agent Router 监听 {bind}");
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.wait_for(|v| *v).await;
            })
            .await
            .ok();
    });

    GatewayHandle {
        shutdown: shutdown_tx,
        task,
    }
}

impl GatewayHandle {
    pub fn stop(self) {
        let _ = self.shutdown.send(true);
    }

    /// 优雅停止并等待监听任务退出（端口释放后返回），供重新配置时安全重绑同端口。
    pub async fn shutdown(self) {
        let _ = self.shutdown.send(true);
        let _ = self.task.await;
    }
}

async fn healthz() -> impl IntoResponse {
    Json(serde_json::json!({ "status": "ok" }))
}

async fn status(State(ctx): State<AppCtx>) -> impl IntoResponse {
    Json(serde_json::json!({
        "service": "omnipanel-agent-router",
        "auth": ctx.api_key.is_some(),
    }))
}

async fn metrics() -> impl IntoResponse {
    Json(serde_json::json!({
        "gateway_requests_total": 0,
        "gateway_active_streams": 0,
    }))
}

async fn list_models(State(ctx): State<AppCtx>) -> impl IntoResponse {
    match ctx.router.list_models().await {
        Ok(models) => (StatusCode::OK, Json(serde_json::json!({ "data": models }))).into_response(),
        Err(err) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "error": err })),
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
struct ChatCompletionsRequest {
    model: String,
    messages: Vec<serde_json::Value>,
    #[serde(default)]
    stream: bool,
    #[serde(default)]
    tools: Option<Vec<serde_json::Value>>,
}

async fn chat_completions(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(body): Json<ChatCompletionsRequest>,
) -> impl IntoResponse {
    if let Some(ref expected) = ctx.api_key {
        let auth = headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let token = auth.strip_prefix("Bearer ").unwrap_or(auth);
        if token != expected {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({ "error": "invalid api key" })),
            )
                .into_response();
        }
    }

    let conversation_id = headers
        .get("x-conversation-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("default")
        .to_string();

    match ctx
        .router
        .chat_completions(
            body.model,
            body.messages,
            body.stream,
            body.tools,
            conversation_id,
        )
        .await
    {
        Ok(resp) => (StatusCode::OK, resp).into_response(),
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            Json(serde_json::json!({ "error": err })),
        )
            .into_response(),
    }
}
