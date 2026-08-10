//! HTTP 服务入口：`/ipc/invoke` + `WS /ipc/events` + 静态托管 + 健康检查。

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
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
        .route("/media/{token}", get(media_handler).head(media_head_handler))
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
        "p2_docker_commands": ["docker_list_container_stats", "docker_inspect_container", "docker_container_action", "docker_container_logs", "docker_clear_container_logs", "docker_list_container_log_infos", "docker_create_container", "docker_list_images", "docker_remove_image", "docker_inspect_image", "docker_image_history", "docker_prune_images", "docker_search_images", "docker_prune_build_cache", "docker_tag_image", "docker_pull_image", "docker_push_image", "docker_build_image", "docker_host_run_cli", "docker_list_volumes", "docker_create_volume", "docker_remove_volume", "docker_inspect_volume", "docker_prune_volumes", "docker_list_networks", "docker_create_network", "docker_remove_network", "docker_prune_networks", "docker_inspect_network", "docker_connect_network", "docker_disconnect_network", "docker_list_compose_projects", "docker_compose_action", "docker_read_compose_files", "docker_write_compose_files", "docker_read_daemon_config", "docker_write_daemon_config", "docker_restart_daemon", "docker_start_local_engine", "docker_get_system_disk_usage", "docker_list_container_dir", "docker_read_container_file", "docker_write_container_file", "docker_list_volume_dir", "docker_read_volume_file", "docker_stream_container_logs", "docker_stop_log_stream", "docker_stream_stats", "docker_stop_stats_stream", "docker_exec_command", "docker_create_exec_session", "docker_create_host_shell_session", "docker_exec_write", "docker_exec_resize", "docker_exec_close"],
        "p2_file_commands": ["file_list_connections", "file_list_dir", "file_s3_search", "file_read_file", "file_upload_file", "file_mkdir", "file_rename", "file_delete", "file_local_quick_paths", "file_local_system_info", "file_upload_local_bytes", "file_download_file"],
        "p2_ai_commands": ["ai_chat_stream", "ai_chat_cancel", "ai_http_stream_post"],
        "p3_ai_tools": ["ai_chat_tool_result", "tools: omni_ssh_exec/omni_ssh_get_stats/omni_ssh_create_run_script/omni_docker_*/omni_database_*/omni_files_* + Native 知识库/skill/web + external MCP (extmcp::*)"],
        "p3_file_relay": ["transfer_start", "transfer_cancel", "files-transfer-progress"],
        "p4_mcp": ["mcp_list_services", "mcp_upsert_service", "mcp_delete_service", "mcp_set_service_enabled", "mcp_set_service_running", "mcp_list_service_tools", "mcp_call_tool"],
        "p4_s3_multipart": ["file_upload_local_path_multipart", "file_download_s3_range_to_file", "events: files-transfer-progress"],
        "events": ["terminal-output", "terminal-event", "docker-log", "docker-log-end", "docker-stats", "docker-stats-end", "@channel", "files-transfer-progress"],
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

fn apply_media_cors(headers: &mut HeaderMap) {
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static("*"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Range, Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        HeaderValue::from_static("Accept-Ranges, Content-Range, Content-Length, Content-Type"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
}

async fn media_head_handler(
    State(ctx): State<AppCtx>,
    Path(token): Path<String>,
) -> Response {
    let entry = {
        let map = ctx.state.media_streams.lock().await;
        map.get(&token).cloned()
    };
    let Some(entry) = entry else {
        let mut res = Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::NOT_FOUND.into_response());
        apply_media_cors(res.headers_mut());
        return res;
    };

    let mut builder = Response::builder().status(StatusCode::OK);
    if let Some(h) = builder.headers_mut() {
        apply_media_cors(h);
        h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(&entry.mime)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        );
        h.insert(
            header::CONTENT_LENGTH,
            HeaderValue::from_str(&entry.size.to_string())
                .unwrap_or_else(|_| HeaderValue::from_static("0")),
        );
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    builder
        .body(Body::empty())
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

async fn media_handler(
    State(ctx): State<AppCtx>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    use omnipanel_ssh::media::read_media_range;

    let entry = {
        let map = ctx.state.media_streams.lock().await;
        map.get(&token).cloned()
    };
    let Some(entry) = entry else {
        let mut res = Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap_or_else(|_| StatusCode::NOT_FOUND.into_response());
        apply_media_cors(res.headers_mut());
        return res;
    };

    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    let session_result =
        crate::log_tail::resolve_log_session_for_media(&ctx.state, &entry.ssh_id).await;
    let result = match session_result {
        Ok(session) => read_media_range(session.as_ref(), &entry, range).await,
        Err(e) => Err(e),
    };

    match result {
        Ok(resp) => {
            let status = if resp.partial {
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            };
            let mut builder = Response::builder().status(status);
            if let Some(h) = builder.headers_mut() {
                apply_media_cors(h);
                h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
                h.insert(
                    header::CONTENT_TYPE,
                    HeaderValue::from_str(&resp.mime)
                        .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
                );
                h.insert(
                    header::CONTENT_LENGTH,
                    HeaderValue::from_str(&resp.content_length().to_string())
                        .unwrap_or_else(|_| HeaderValue::from_static("0")),
                );
                if let Some(cr) = resp.content_range_value() {
                    if let Ok(v) = HeaderValue::from_str(&cr) {
                        h.insert(header::CONTENT_RANGE, v);
                    }
                }
                h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
            }
            builder
                .body(Body::from(resp.data))
                .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
        }
        Err(e) => {
            tracing::warn!(error = %e, "媒体流读取失败");
            let mut res = Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(e.to_string()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
            apply_media_cors(res.headers_mut());
            res
        }
    }
}
