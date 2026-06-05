use omnipanel_error::{ErrorCode, OmniError};
use reqwest::Client;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 按面板地址复用带 Cookie 的 HTTP 客户端（文档要求保存 cookie 并在后续请求附带）。
static CLIENTS: LazyLock<Mutex<HashMap<String, Client>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

/// 生成 request_token：`md5(string(request_time) + md5(api_sk))`（小写 hex）。
pub fn build_request_token(api_sk: &str, request_time: i64) -> String {
    let api_key_md5 = format!("{:x}", md5::compute(api_sk));
    let payload = format!("{request_time}{api_key_md5}");
    format!("{:x}", md5::compute(payload))
}

/// 规范化面板地址为 origin（无尾部斜杠）。未带协议时默认 http。
pub fn normalize_base_url(host: &str) -> Result<String, OmniError> {
    let mut normalized = host.trim().trim_end_matches('/').to_string();
    if normalized.is_empty() {
        return Err(OmniError::invalid_input("宝塔面板地址不能为空"));
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

fn client_for_host(host: &str) -> Result<Client, OmniError> {
    let base = normalize_base_url(host)?;
    let mut map = CLIENTS
        .lock()
        .map_err(|_| OmniError::internal("宝塔 HTTP 客户端锁失败"))?;
    if let Some(client) = map.get(&base) {
        return Ok(client.clone());
    }
    let client = Client::builder()
        .cookie_store(true)
        .timeout(Duration::from_secs(60))
        .danger_accept_invalid_certs(true)
        .build()
        .map_err(|e| OmniError::internal("创建 HTTP 客户端失败").with_cause(e.to_string()))?;
    map.insert(base, client.clone());
    Ok(client)
}

fn value_to_form_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => Some(value.to_string()),
    }
}

fn build_form_params(api_sk: &str, extra: &Map<String, Value>) -> Vec<(String, String)> {
    let request_time = current_timestamp();
    let request_token = build_request_token(api_sk, request_time);
    let mut params = vec![
        ("request_time".to_string(), request_time.to_string()),
        ("request_token".to_string(), request_token),
    ];
    for (key, value) in extra {
        if let Some(text) = value_to_form_string(value) {
            params.push((key.clone(), text));
        }
    }
    params
}

fn parse_response_value(text: &str) -> Result<Value, OmniError> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<!doctype") || lower.starts_with("<html") {
        return Err(
            OmniError::internal("宝塔面板返回了 HTML 页面而非 JSON").with_cause(truncate_text(
                trimmed, 300,
            )),
        );
    }

    let value: Value = serde_json::from_str(trimmed).map_err(|e| {
        OmniError::internal("宝塔面板响应不是合法 JSON").with_cause(format!(
            "{}; body: {}",
            e,
            truncate_text(trimmed, 300)
        ))
    })?;

    if let Value::Object(obj) = &value {
        if obj.get("status").and_then(|v| v.as_bool()) == Some(false) {
            let message = obj
                .get("msg")
                .and_then(|v| v.as_str())
                .unwrap_or("宝塔 API 错误");
            return Err(OmniError::new(ErrorCode::Connection, message));
        }
    }

    Ok(value)
}

/// 向宝塔面板发起 API 请求。`path` 含 query，如 `/system?action=GetSystemTotal`。
/// `body` 为额外表单字段（JSON 对象），签名参数由本模块自动附加。
pub async fn request(
    host: &str,
    api_sk: &str,
    path: &str,
    body: Option<Map<String, Value>>,
) -> Result<Value, OmniError> {
    let base = normalize_base_url(host)?;
    let client = client_for_host(host)?;

    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let url = format!("{base}{path}");

    let extra = body.unwrap_or_default();
    let form = build_form_params(api_sk, &extra);

    let resp = client
        .post(&url)
        .header("Accept", "application/json, text/plain, */*")
        .form(&form)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "宝塔面板请求失败").with_cause(e.to_string())
        })?;

    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).into_owned();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err(OmniError::new(ErrorCode::Auth, "API 接口密钥错误").with_cause(text));
    }

    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("宝塔 API 错误 ({status})"),
        )
        .with_cause(truncate_text(&text, 300)));
    }

    parse_response_value(&text)
}

/// 连通性测试（官方文档：/system?action=GetSystemTotal）。
pub async fn test_connection(host: &str, api_sk: &str) -> Result<Value, OmniError> {
    request(host, api_sk, "/system?action=GetSystemTotal", None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_token_matches_md5_spec() {
        let token = build_request_token("test-key", 1_700_000_000);
        assert_eq!(token.len(), 32);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
    }

    #[test]
    fn request_token_uses_api_key_md5_prefix() {
        let api_sk = "MM4S7NHzUbb2H1YhzbMux4Fk4JxP3v45";
        let request_time = 1_555_486_123_i64;
        let api_key_md5 = format!("{:x}", md5::compute(api_sk));
        let expected = format!("{:x}", md5::compute(format!("{request_time}{api_key_md5}")));
        assert_eq!(build_request_token(api_sk, request_time), expected);
    }
}
