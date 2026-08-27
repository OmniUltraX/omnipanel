//! 协议实验室：SSE（Server-Sent Events）长连接调试。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::sync::{Mutex, mpsc};
use tokio::task::JoinHandle;

use crate::commands::proxy::{build_http_client_for_url, normalize_localhost_url};
use crate::state::ProxyConfig;

/// SSE 连接配置（前端已解析 Query；认证与 HTTP 一样走 auth 字段）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SseConfig {
    #[serde(default = "default_sse_method")]
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub body_type: Option<String>,
    #[serde(default)]
    pub auth_type: Option<String>,
    #[serde(default)]
    pub auth_value: Option<String>,
}

fn default_sse_method() -> String {
    "GET".to_string()
}

/// 推送给前端的一条 SSE 事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SseEventMessage {
    pub event: String,
    pub data: String,
    pub id: String,
    pub timestamp: String,
}

/// 已连接的 SSE 会话（Drop / 关闭时 abort 读流任务）。
pub struct SseSession {
    task: JoinHandle<()>,
}

impl Drop for SseSession {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl SseSession {
    /// 发起流式请求并解析 SSE 帧；事件经 `on_event` 转发。
    pub async fn connect(
        config: SseConfig,
        proxy_config: &ProxyConfig,
        on_event: mpsc::UnboundedSender<SseEventMessage>,
    ) -> Result<Self, String> {
        let url = normalize_localhost_url(&config.url);
        let method = config.method.to_uppercase();
        // 调试：核对前端传入的原始配置（含认证字段是否落到 Rust）
        tracing::info!(
            target: "protocol_sse",
            url = %url,
            raw_url = %config.url,
            method = %method,
            header_count = config.headers.len(),
            headers = ?config.headers,
            auth_type = ?config.auth_type,
            auth_value = ?config.auth_value,
            "SSE connect: incoming config"
        );

        // SSE 长连接：关闭短超时（用近乎无限的读超时，由会话 abort 结束）
        let client =
            build_http_client_for_url(&url, proxy_config, Duration::from_secs(60 * 60 * 24 * 7))?;

        let mut req = match method.as_str() {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            "PUT" => client.put(&url),
            "PATCH" => client.patch(&url),
            "DELETE" => client.delete(&url),
            "HEAD" => client.head(&url),
            "OPTIONS" => client.request(reqwest::Method::OPTIONS, &url),
            _ => return Err(format!("Unsupported SSE HTTP method: {method}")),
        };
        let mut outgoing_headers: HashMap<String, String> = HashMap::new();
        let mut has_accept = false;
        for (key, value) in &config.headers {
            if key.eq_ignore_ascii_case("accept") {
                has_accept = true;
            }
            outgoing_headers.insert(key.clone(), value.clone());
            req = req.header(key.as_str(), value.as_str());
        }
        if !has_accept {
            outgoing_headers.insert("Accept".to_string(), "text/event-stream".to_string());
            req = req.header(reqwest::header::ACCEPT, "text/event-stream");
        }
        // 避免中间代理缓冲整段响应
        outgoing_headers.insert("Cache-Control".to_string(), "no-cache".to_string());
        req = req.header(reqwest::header::CACHE_CONTROL, "no-cache");

        // 与 protocol/http.rs / curl 一致：环境 / 请求认证由 auth_* 注入
        if let (Some(auth_type), Some(auth_value)) = (&config.auth_type, &config.auth_value) {
            let auth_value = auth_value.trim();
            if !auth_value.is_empty() {
                match auth_type.as_str() {
                    "Bearer Token" | "Bearer" => {
                        let value = format!("Bearer {auth_value}");
                        outgoing_headers.insert("Authorization".to_string(), value.clone());
                        req = req.header(reqwest::header::AUTHORIZATION, value);
                    }
                    "Basic Auth" | "Basic" => {
                        let value = format!("Basic {auth_value}");
                        outgoing_headers.insert("Authorization".to_string(), value.clone());
                        req = req.header(reqwest::header::AUTHORIZATION, value);
                    }
                    "API Key" => {
                        outgoing_headers.insert("X-API-Key".to_string(), auth_value.to_string());
                        req = req.header("X-API-Key", auth_value);
                    }
                    "Authorization" | "OAuth 2.0" => {
                        outgoing_headers
                            .insert("Authorization".to_string(), auth_value.to_string());
                        req = req.header(reqwest::header::AUTHORIZATION, auth_value);
                    }
                    _ => {
                        outgoing_headers
                            .insert("Authorization".to_string(), auth_value.to_string());
                        req = req.header(reqwest::header::AUTHORIZATION, auth_value);
                    }
                }
            } else {
                tracing::warn!(
                    target: "protocol_sse",
                    auth_type = %auth_type,
                    "SSE connect: auth_type 有值但 auth_value 为空，跳过注入"
                );
            }
        } else {
            tracing::warn!(
                target: "protocol_sse",
                auth_type = ?config.auth_type,
                auth_value_present = config.auth_value.as_ref().map(|v| !v.trim().is_empty()),
                "SSE connect: 未收到完整 auth_type/auth_value，未注入认证头"
            );
        }

        if let Some(body) = &config.body {
            if !matches!(method.as_str(), "GET" | "HEAD") {
                let content_type = config.body_type.as_deref().unwrap_or("json");
                let mime = match content_type {
                    "json" => "application/json",
                    "form" => "application/x-www-form-urlencoded",
                    "multipart" => "multipart/form-data",
                    _ => "text/plain",
                };
                outgoing_headers.insert("Content-Type".to_string(), mime.to_string());
                req = req.header(reqwest::header::CONTENT_TYPE, mime);
                req = req.body(body.clone());
            }
        }

        tracing::info!(
            target: "protocol_sse",
            method = %method,
            url = %url,
            headers = ?outgoing_headers,
            "SSE connect: outgoing request"
        );

        let resp = req.send().await.map_err(|e| format!("SSE 连接失败: {e}"))?;

        tracing::info!(
            target: "protocol_sse",
            status = %resp.status(),
            response_headers = ?resp
                .headers()
                .iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|s| (k.to_string(), s.to_string())))
                .collect::<HashMap<_, _>>(),
            "SSE connect: response status"
        );

        if !resp.status().is_success() {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            return Err(format!(
                "SSE 连接失败 (HTTP {}): {}",
                status.as_u16(),
                body.chars().take(200).collect::<String>()
            ));
        }

        let mut stream = resp.bytes_stream();
        let task = tokio::spawn(async move {
            let mut parser = SseParser::default();
            while let Some(item) = stream.next().await {
                let chunk = match item {
                    Ok(bytes) => bytes,
                    Err(_) => break,
                };
                for event in parser.push(&chunk) {
                    if on_event.send(event).is_err() {
                        return;
                    }
                }
            }
            // 流结束：冲刷未以空行结尾的缓冲（一般不完整，丢弃半帧）
            for event in parser.flush() {
                let _ = on_event.send(event);
            }
        });

        Ok(Self { task })
    }
}

#[allow(dead_code)]
pub type SseSessions = Arc<Mutex<HashMap<String, SseSession>>>;

#[derive(Default)]
struct SseParser {
    buf: String,
    event: String,
    data_lines: Vec<String>,
    id: String,
}

impl SseParser {
    fn push(&mut self, chunk: &[u8]) -> Vec<SseEventMessage> {
        self.buf.push_str(&String::from_utf8_lossy(chunk));
        let mut out = Vec::new();
        while let Some(idx) = self.buf.find('\n') {
            let mut line = self.buf[..idx].to_string();
            self.buf.drain(..=idx);
            if line.ends_with('\r') {
                line.pop();
            }
            if let Some(event) = self.feed_line(&line) {
                out.push(event);
            }
        }
        out
    }

    fn flush(&mut self) -> Vec<SseEventMessage> {
        // 仅处理已完整的空行分帧；残留半行丢弃
        Vec::new()
    }

    fn feed_line(&mut self, line: &str) -> Option<SseEventMessage> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((f, rest)) => {
                let v = if rest.starts_with(' ') {
                    &rest[1..]
                } else {
                    rest
                };
                (f, v)
            }
            None => (line, ""),
        };
        match field {
            "event" => self.event = value.to_string(),
            "data" => self.data_lines.push(value.to_string()),
            "id" => self.id = value.to_string(),
            "retry" => {}
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseEventMessage> {
        if self.data_lines.is_empty() && self.event.is_empty() && self.id.is_empty() {
            return None;
        }
        let data = self.data_lines.join("\n");
        let event = if self.event.is_empty() {
            "message".to_string()
        } else {
            std::mem::take(&mut self.event)
        };
        let id = std::mem::take(&mut self.id);
        self.data_lines.clear();
        Some(SseEventMessage {
            event,
            data,
            id,
            timestamp: chrono_now(),
        })
    }
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() % 86400;
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiline_data_and_event() {
        let mut p = SseParser::default();
        let frames = p.push(b"event: ping\ndata: hello\ndata: world\nid: 1\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event, "ping");
        assert_eq!(frames[0].data, "hello\nworld");
        assert_eq!(frames[0].id, "1");
    }

    #[test]
    fn default_event_name_is_message() {
        let mut p = SseParser::default();
        let frames = p.push(b"data: only\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].event, "message");
        assert_eq!(frames[0].data, "only");
    }

    #[test]
    fn ignores_comment_lines() {
        let mut p = SseParser::default();
        let frames = p.push(b": keep-alive\ndata: x\n\n");
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "x");
    }
}
