use base64::{Engine as _, engine::general_purpose::STANDARD};
use omnipanel_error::{ErrorCode, OmniError};
use reqwest::Method;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// 生成 1Panel-Token：`md5('1panel' + API-Key + UnixTimestamp)`（小写 hex）。
pub fn build_token(api_key: &str, timestamp: i64) -> String {
    let payload = format!("1panel{api_key}{timestamp}");
    format!("{:x}", md5::compute(payload))
}

/// 规范化面板地址为 origin（无尾部斜杠）。未带协议时默认 http。
pub fn normalize_base_url(host: &str) -> Result<String, OmniError> {
    let mut normalized = host.trim().trim_end_matches('/').to_string();
    if normalized.is_empty() {
        return Err(OmniError::invalid_input("1Panel 地址不能为空"));
    }
    if !normalized.starts_with("http://") && !normalized.starts_with("https://") {
        normalized = format!("http://{normalized}");
    }
    Ok(normalized)
}

fn current_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn truncate_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    format!("{}…", &text[..max])
}

fn parse_response_text(text: &str) -> Result<Value, OmniError> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<!doctype") || lower.starts_with("<html") {
        return Err(OmniError::internal("1Panel 返回了 HTML 页面而非 JSON")
            .with_cause(truncate_text(trimmed, 300)));
    }

    serde_json::from_str(trimmed).map_err(|e| {
        OmniError::internal("1Panel 响应不是合法 JSON").with_cause(format!(
            "{}; body: {}",
            e,
            truncate_text(trimmed, 300)
        ))
    })
}

/// 从 Content-Disposition 解析附件文件名。
fn parse_content_disposition_filename(header: &str) -> Option<String> {
    let header = header.trim();
    if header.is_empty() {
        return None;
    }

    // filename*=utf-8''example.com.zip
    if let Some(idx) = header.to_ascii_lowercase().find("filename*=") {
        let mut value = header[idx + "filename*=".len()..].trim();
        if let Some(end) = value.find(';') {
            value = &value[..end];
        }
        value = value.trim().trim_matches('"');
        if let Some(encoded) = value.split("''").nth(1) {
            let decoded = percent_decode(encoded);
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    // filename="example.com.zip" / filename=example.com.zip
    if let Some(idx) = header.to_ascii_lowercase().find("filename=") {
        let mut value = header[idx + "filename=".len()..].trim();
        if let Some(end) = value.find(';') {
            value = &value[..end];
        }
        value = value.trim().trim_matches('"');
        if !value.is_empty() {
            return Some(value.to_string());
        }
    }

    None
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = &input[i + 1..i + 3];
            if let Ok(v) = u8::from_str_radix(hex, 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

async fn send_request(
    host: &str,
    api_key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<(reqwest::StatusCode, String, Vec<u8>, Option<String>), OmniError> {
    let base = normalize_base_url(host)?;
    let timestamp = current_timestamp();
    let token = build_token(api_key, timestamp);

    let method = method
        .parse::<Method>()
        .map_err(|_| OmniError::invalid_input(format!("不支持的 HTTP 方法：{method}")))?;

    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let url = format!("{base}/api/v2{path}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| OmniError::internal("创建 HTTP 客户端失败").with_cause(e.to_string()))?;

    let mut req = client
        .request(method.clone(), &url)
        .header("Accept", "application/json, text/plain, */*")
        .header("1Panel-Token", token)
        .header("1Panel-Timestamp", timestamp.to_string());

    match body {
        Some(value) => {
            req = req.json(&value);
        }
        None if matches!(method, Method::POST | Method::PUT | Method::PATCH) => {
            req = req.json(&serde_json::json!({}));
        }
        None => {}
    }

    let resp = req.send().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "1Panel 请求失败").with_cause(e.to_string())
    })?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let filename = resp
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_content_disposition_filename);
    let bytes = resp.bytes().await.unwrap_or_default().to_vec();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Err(OmniError::new(ErrorCode::Auth, "API 接口密钥错误").with_cause(text));
    }

    if !status.is_success() {
        return Err(
            OmniError::new(ErrorCode::Connection, format!("1Panel API 错误 ({status})"))
                .with_cause(truncate_text(
                    std::str::from_utf8(&bytes).unwrap_or(""),
                    300,
                )),
        );
    }

    Ok((status, content_type, bytes, filename))
}

/// 向 1Panel 发起 API 请求。`path` 不含 `/api/v2` 前缀，可含 query string。
pub async fn request(
    host: &str,
    api_key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<Value, OmniError> {
    let (_, _, bytes, _) = send_request(host, api_key, method, path, body).await?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    parse_response_text(&text)
}

/// 原始文本响应（用于日志下载等非 JSON 接口）。
pub async fn request_text(
    host: &str,
    api_key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<String, OmniError> {
    let (_, content_type, bytes, _) = send_request(host, api_key, method, path, body).await?;
    if bytes.is_empty() {
        return Ok(String::new());
    }

    let text = String::from_utf8_lossy(&bytes).into_owned();
    let trimmed = text.trim();
    if content_type.contains("json") && trimmed.starts_with('{') {
        let value: Value = serde_json::from_str(trimmed).map_err(|e| {
            OmniError::internal("1Panel 响应不是合法 JSON").with_cause(e.to_string())
        })?;
        if let Some(code) = value.get("code").and_then(|v| v.as_i64())
            && code != 200
        {
            let message = value
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("1Panel API 错误");
            return Err(OmniError::new(ErrorCode::Connection, message));
        }
        if let Some(data) = value.get("data")
            && let Some(s) = data.as_str()
        {
            return Ok(s.to_string());
        }
    }

    Ok(text)
}

/// 二进制响应（证书 zip 下载等）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OnePanelBinaryPayload {
    pub content_base64: String,
    pub content_type: String,
    pub filename: Option<String>,
}

/// 原始二进制响应（Base64 编码，避免跨 IPC 损坏）。
pub async fn request_bytes(
    host: &str,
    api_key: &str,
    method: &str,
    path: &str,
    body: Option<Value>,
) -> Result<OnePanelBinaryPayload, OmniError> {
    let (_, content_type, bytes, filename) =
        send_request(host, api_key, method, path, body).await?;
    if bytes.is_empty() {
        return Err(OmniError::not_found("1Panel 返回空文件"));
    }

    // 错误时 1Panel 仍可能返回 JSON envelope
    if content_type.contains("json") {
        if let Ok(text) = std::str::from_utf8(&bytes) {
            let trimmed = text.trim();
            if trimmed.starts_with('{') {
                let value: Value = serde_json::from_str(trimmed).map_err(|e| {
                    OmniError::internal("1Panel 响应不是合法 JSON").with_cause(e.to_string())
                })?;
                if let Some(code) = value.get("code").and_then(|v| v.as_i64())
                    && code != 200
                {
                    let message = value
                        .get("message")
                        .and_then(|v| v.as_str())
                        .unwrap_or("1Panel API 错误");
                    return Err(OmniError::new(ErrorCode::Connection, message));
                }
            }
        }
    }

    Ok(OnePanelBinaryPayload {
        content_base64: STANDARD.encode(&bytes),
        content_type,
        filename,
    })
}

/// 连通性测试（官方文档示例接口 POST /toolbox/device/base）。
pub async fn test_connection(host: &str, api_key: &str) -> Result<Value, OmniError> {
    request(host, api_key, "POST", "/toolbox/device/base", None).await
}

fn resolve_icon_value(base: &str, data: &Value) -> Result<String, OmniError> {
    match data {
        Value::String(s) => {
            let s = s.trim();
            if s.is_empty() {
                return Err(OmniError::not_found("应用图标为空"));
            }
            if s.starts_with("data:") || s.starts_with("http://") || s.starts_with("https://") {
                return Ok(s.to_string());
            }
            if s.starts_with('/') {
                return Ok(format!("{base}{s}"));
            }
            Ok(format!("data:image/png;base64,{s}"))
        }
        Value::Object(obj) => {
            if let Some(icon) = obj.get("icon").and_then(|v| v.as_str()) {
                return resolve_icon_value(base, &Value::String(icon.to_string()));
            }
            Err(OmniError::not_found("应用图标数据格式不支持"))
        }
        _ => Err(OmniError::not_found("应用图标数据为空")),
    }
}

fn icon_bytes_to_data_url(
    base: &str,
    content_type: &str,
    bytes: &[u8],
) -> Result<String, OmniError> {
    if bytes.is_empty() {
        return Err(OmniError::not_found("应用图标为空"));
    }

    if let Ok(text) = std::str::from_utf8(bytes) {
        let trimmed = text.trim();
        if trimmed.starts_with('{') {
            let value: Value = serde_json::from_str(trimmed).map_err(|e| {
                OmniError::internal("应用图标响应不是合法 JSON").with_cause(e.to_string())
            })?;
            if let Some(code) = value.get("code").and_then(|v| v.as_i64())
                && code != 200
            {
                let message = value
                    .get("message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("获取应用图标失败");
                return Err(OmniError::new(ErrorCode::Connection, message));
            }
            if let Some(data) = value.get("data") {
                return resolve_icon_value(base, data);
            }
        }
        if trimmed.starts_with("data:image") {
            return Ok(trimmed.to_string());
        }
        if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
            return Ok(trimmed.to_string());
        }
    }

    let mime = if content_type.is_empty() {
        "image/png".to_string()
    } else {
        content_type.to_string()
    };

    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// GET /apps/icon/:key — 获取应用图标，返回可用于 `<img src>` 的 data URL 或绝对 URL。
pub async fn fetch_app_icon(host: &str, api_key: &str, app_key: &str) -> Result<String, OmniError> {
    let key = app_key.trim();
    if key.is_empty() {
        return Err(OmniError::invalid_input("应用 key 不能为空"));
    }

    let base = normalize_base_url(host)?;
    let timestamp = current_timestamp();
    let token = build_token(api_key, timestamp);
    let url = format!("{base}/api/v2/apps/icon/{key}");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| OmniError::internal("创建 HTTP 客户端失败").with_cause(e.to_string()))?;

    let resp = client
        .get(&url)
        .header("Accept", "application/json, image/*, */*")
        .header("1Panel-Token", token)
        .header("1Panel-Timestamp", timestamp.to_string())
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取应用图标失败").with_cause(e.to_string())
        })?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_string();

    let bytes = resp.bytes().await.unwrap_or_default();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(OmniError::new(ErrorCode::Auth, "API 接口密钥错误"));
    }

    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("获取应用图标失败 ({status})"),
        )
        .with_cause(truncate_text(
            std::str::from_utf8(&bytes).unwrap_or(""),
            300,
        )));
    }

    icon_bytes_to_data_url(&base, &content_type, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_matches_md5_spec() {
        let token = build_token("test-key", 1_700_000_000);
        assert_eq!(token.len(), 32);
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
        );
    }
}
