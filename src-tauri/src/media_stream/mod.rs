//! 本地 HTTP Range 代理：按播放器请求从远端 SFTP 按需读字节，实现边下边播。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::MethodRouter;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use omnipanel_ssh::media::{MediaStreamEntry, read_media_range};
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::background::SshPool;

pub use omnipanel_ssh::media::guess_media_mime;

#[derive(Clone)]
struct MediaStreamState {
    entries: Arc<Mutex<HashMap<String, MediaStreamEntry>>>,
    ssh_sessions: Arc<Mutex<HashMap<String, SshSession>>>,
    ssh_pool: Arc<SshPool>,
}

/// 常驻本机 Range 代理。
pub struct MediaStreamServer {
    port: u16,
    entries: Arc<Mutex<HashMap<String, MediaStreamEntry>>>,
    _state: MediaStreamState,
}

impl MediaStreamServer {
    pub async fn start(
        ssh_sessions: Arc<Mutex<HashMap<String, SshSession>>>,
        ssh_pool: Arc<SshPool>,
    ) -> OmniResult<Self> {
        let entries = Arc::new(Mutex::new(HashMap::new()));
        let state = MediaStreamState {
            entries: entries.clone(),
            ssh_sessions,
            ssh_pool,
        };

        let app = Router::new()
            .route(
                "/media/{token}",
                MethodRouter::new().get(serve_media).head(serve_media_head),
            )
            .with_state(state.clone());

        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], 0)))
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, "无法启动媒体流代理").with_cause(e.to_string())
            })?;
        let port = listener
            .local_addr()
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, "无法获取媒体流代理端口").with_cause(e.to_string())
            })?
            .port();

        tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                warn!(error = %e, "媒体流代理退出");
            }
        });

        info!(port, "媒体流 Range 代理已启动");
        Ok(Self {
            port,
            entries,
            _state: state,
        })
    }

    pub async fn register(&self, entry: MediaStreamEntry) -> String {
        let token = new_token();
        self.entries.lock().await.insert(token.clone(), entry);
        token
    }

    pub async fn unregister(&self, token: &str) {
        self.entries.lock().await.remove(token);
    }

    pub fn url_for_token(&self, token: &str) -> String {
        format!("http://127.0.0.1:{}/media/{}", self.port, token)
    }
}

fn new_token() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!(
        "{nanos:x}{:08x}",
        (nanos.wrapping_mul(0x9e37_79b9) as u32) ^ 0xa5a5_5a5a
    )
}

fn apply_cors(headers: &mut HeaderMap) {
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

async fn serve_media_head(
    State(state): State<MediaStreamState>,
    Path(token): Path<String>,
) -> Response {
    let entry = {
        let map = state.entries.lock().await;
        map.get(&token).cloned()
    };
    let Some(entry) = entry else {
        let mut res = Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::NOT_FOUND.into_response());
        apply_cors(res.headers_mut());
        return res;
    };

    let mut builder = Response::builder().status(StatusCode::OK);
    if let Some(h) = builder.headers_mut() {
        apply_cors(h);
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

async fn serve_media(
    State(state): State<MediaStreamState>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    let entry = {
        let map = state.entries.lock().await;
        map.get(&token).cloned()
    };
    let Some(entry) = entry else {
        let mut res = Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("not found"))
            .unwrap_or_else(|_| StatusCode::NOT_FOUND.into_response());
        apply_cors(res.headers_mut());
        return res;
    };

    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());

    let result = {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(&entry.ssh_id) {
            read_media_range(session, &entry, range).await
        } else {
            drop(sessions);
            match state.ssh_pool.ensure_session(&entry.ssh_id).await {
                Ok(session) => read_media_range(session.as_ref(), &entry, range).await,
                Err(e) => Err(e),
            }
        }
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
                apply_cors(h);
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
            warn!(error = %e, "媒体流读取失败");
            let mut res = Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(e.to_string()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
            apply_cors(res.headers_mut());
            res
        }
    }
}
