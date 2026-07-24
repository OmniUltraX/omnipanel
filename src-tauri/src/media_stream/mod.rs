//! 本地 HTTP Range 代理：按播放器请求从远端 SFTP 按需读字节，实现边下边播。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::MethodRouter;
use axum::Router;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tracing::{info, warn};

use crate::background::SshPool;

const MAX_CHUNK: u32 = 4 * 1024 * 1024;
/// 无 Range 时单次最多回传的字节（图片 / 小音频全量 GET）
const MAX_FULL_GET: u64 = 64 * 1024 * 1024;

#[derive(Clone)]
pub struct MediaStreamEntry {
    pub ssh_id: String,
    pub remote_path: String,
    pub size: u64,
    pub mime: String,
}

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
                MethodRouter::new()
                    .get(serve_media)
                    .head(serve_media_head),
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

    pub fn port(&self) -> u16 {
        self.port
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
    // 本机代理 + 不可猜测路径即可
    format!("{nanos:x}{:08x}", (nanos.wrapping_mul(0x9e37_79b9) as u32) ^ 0xa5a5_5a5a)
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

fn parse_bytes_range(headers: &HeaderMap, size: u64) -> Option<(u64, u64)> {
    let value = headers.get(header::RANGE)?.to_str().ok()?;
    let spec = value.strip_prefix("bytes=")?;
    // 只处理单段 Range
    let spec = spec.split(',').next()?.trim();
    if let Some((start_s, end_s)) = spec.split_once('-') {
        if start_s.is_empty() {
            // suffix: bytes=-N
            let n: u64 = end_s.parse().ok()?;
            if n == 0 || size == 0 {
                return None;
            }
            let start = size.saturating_sub(n);
            return Some((start, size - 1));
        }
        let start: u64 = start_s.parse().ok()?;
        if start >= size {
            return None;
        }
        let end = if end_s.is_empty() {
            size - 1
        } else {
            end_s.parse::<u64>().ok()?.min(size - 1)
        };
        if end < start {
            return None;
        }
        return Some((start, end));
    }
    None
}

async fn read_bytes(
    state: &MediaStreamState,
    ssh_id: &str,
    path: &str,
    offset: u64,
    len: u64,
) -> OmniResult<Vec<u8>> {
    let mut out = Vec::with_capacity(len.min(MAX_CHUNK as u64) as usize);
    let mut off = offset;
    let mut remaining = len;
    while remaining > 0 {
        let chunk = remaining.min(MAX_CHUNK as u64) as u32;
        let data = {
            let sessions = state.ssh_sessions.lock().await;
            if let Some(session) = sessions.get(ssh_id) {
                session.sftp_read_range(path, off, chunk).await?
            } else {
                drop(sessions);
                let session = state.ssh_pool.ensure_session(ssh_id).await?;
                session.sftp_read_range(path, off, chunk).await?
            }
        };
        if data.is_empty() {
            break;
        }
        let n = data.len() as u64;
        off += n;
        remaining = remaining.saturating_sub(n);
        out.extend(data);
        if n < chunk as u64 {
            break;
        }
    }
    Ok(out)
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

    let size = entry.size;
    if size == 0 {
        let mut res = Response::builder()
            .status(StatusCode::NOT_FOUND)
            .body(Body::from("empty"))
            .unwrap_or_else(|_| StatusCode::NOT_FOUND.into_response());
        apply_cors(res.headers_mut());
        return res;
    }

    let range = parse_bytes_range(&headers, size);
    let (status, start, end) = match range {
        Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e),
        None => {
            if size > MAX_FULL_GET {
                // 强制客户端走 Range，避免整文件灌入内存
                let end = (2 * 1024 * 1024 - 1).min(size - 1);
                (StatusCode::PARTIAL_CONTENT, 0u64, end)
            } else {
                (StatusCode::OK, 0u64, size - 1)
            }
        }
    };

    let len = end - start + 1;
    let data = match read_bytes(&state, &entry.ssh_id, &entry.remote_path, start, len).await {
        Ok(d) => d,
        Err(e) => {
            warn!(error = %e, "媒体流读取失败");
            let mut res = Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(e.to_string()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
            apply_cors(res.headers_mut());
            return res;
        }
    };

    let mut builder = Response::builder().status(status);
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
            HeaderValue::from_str(&data.len().to_string())
                .unwrap_or_else(|_| HeaderValue::from_static("0")),
        );
        if status == StatusCode::PARTIAL_CONTENT && !data.is_empty() {
            let actual_end = start + data.len() as u64 - 1;
            let cr = format!("bytes {start}-{actual_end}/{size}");
            if let Ok(v) = HeaderValue::from_str(&cr) {
                h.insert(header::CONTENT_RANGE, v);
            }
        }
        h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    }
    builder
        .body(Body::from(data))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

/// 根据文件名猜测 MIME。
pub fn guess_media_mime(path: &str) -> &'static str {
    let ext = std::path::Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "ogv" => "video/ogg",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "aac" | "m4a" => "audio/mp4",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}
