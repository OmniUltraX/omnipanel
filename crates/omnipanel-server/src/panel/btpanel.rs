use base64::{Engine as _, engine::general_purpose::STANDARD};
use omnipanel_error::{ErrorCode, OmniError};
use reqwest::Client;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// 按面板地址复用带 Cookie 的 HTTP 客户端（文档要求保存 cookie 并在后续请求附带）。
static CLIENTS: LazyLock<Mutex<HashMap<String, Client>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 缓存各面板安全入口（`admin_path.pl`），避免每个图标重复读文件。
static ENTRANCES: LazyLock<Mutex<HashMap<String, Option<String>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 按面板 origin 熔断，避免鉴权失败后继续打验证计数。
static AUTH_GATES: LazyLock<Mutex<HashMap<String, (Instant, String)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const AUTH_COOLDOWN: Duration = Duration::from_secs(15);

fn gate_key(base: &str) -> String {
    base.trim().trim_end_matches('/').to_ascii_lowercase()
}

fn is_bt_auth_or_lockout_message(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    msg.contains("密钥")
        || msg.contains("校验")
        || msg.contains("验证")
        || msg.contains("权限")
        || msg.contains("白名单")
        || lower.contains("api key")
        || lower.contains("unauthorized")
        || (msg.contains("禁止") && (msg.contains("小时") || msg.contains("分钟")))
        || (msg.contains("连续") && msg.contains("失败"))
}

fn is_bt_lockout_message(msg: &str) -> bool {
    (msg.contains("连续") && msg.contains("验证失败"))
        || (msg.contains("禁止") && (msg.contains("小时") || msg.contains("分钟")))
}

fn parse_lockout_duration(msg: &str) -> Duration {
    if let Some(rest) = msg.split("禁止").nth(1) {
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(n) = digits.parse::<u64>() {
            if rest.contains("小时") {
                return Duration::from_secs(n.min(24) * 3600);
            }
            if rest.contains("分钟") {
                return Duration::from_secs(n.min(24 * 60) * 60);
            }
        }
    }
    Duration::from_secs(3600)
}

fn assert_not_locked(base: &str) -> Result<(), OmniError> {
    let key = gate_key(base);
    let mut map = AUTH_GATES
        .lock()
        .map_err(|_| OmniError::internal("宝塔熔断锁失败"))?;
    if let Some((until, message)) = map.get(&key) {
        if Instant::now() >= *until {
            map.remove(&key);
            return Ok(());
        }
        return Err(OmniError::new(ErrorCode::Auth, message.clone()));
    }
    Ok(())
}

fn trip_auth_failure(base: &str, message: &str) {
    if !is_bt_auth_or_lockout_message(message) {
        return;
    }
    let enriched = enrich_auth_message(message);
    let until = if is_bt_lockout_message(message) {
        Instant::now() + parse_lockout_duration(message)
    } else {
        Instant::now() + AUTH_COOLDOWN
    };
    let key = gate_key(base);
    if let Ok(mut map) = AUTH_GATES.lock() {
        if let Some((existing, _)) = map.get(&key) {
            if *existing >= until {
                return;
            }
        }
        map.insert(key, (until, enriched));
    }
}

fn enrich_auth_message(message: &str) -> String {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return "宝塔 API 鉴权失败".to_string();
    }
    if trimmed.contains("密钥校验失败") || trimmed.contains("接口密钥错误") {
        return format!(
            "{trimmed}。若密钥确认无误，请检查：① 面板地址是否为 https://主机:端口；② IP 白名单是否包含本机出口 IP（可临时填 *）；③ 是否刚触发过验证失败熔断（请等待数秒后重试）。"
        );
    }
    trimmed.to_string()
}

fn clear_auth_gate(base: &str) {
    if let Ok(mut map) = AUTH_GATES.lock() {
        map.remove(&gate_key(base));
    }
}

/// 生成 request_token：`md5(string(request_time) + md5(api_sk))`（小写 hex）。
pub fn build_request_token(api_sk: &str, request_time: i64) -> String {
    let api_key_md5 = format!("{:x}", md5::compute(api_sk));
    let payload = format!("{request_time}{api_key_md5}");
    format!("{:x}", md5::compute(payload))
}

/// 规范化面板地址为 origin（scheme://host:port，无安全入口路径）。未带协议时默认 http。
pub fn normalize_base_url(host: &str) -> Result<String, OmniError> {
    let mut normalized = host.trim().to_string();
    if normalized.is_empty() {
        return Err(OmniError::invalid_input("宝塔面板地址不能为空"));
    }
    if !normalized.starts_with("http://") && !normalized.starts_with("https://") {
        normalized = format!("http://{normalized}");
    }
    let rest_start = normalized.find("://").map(|i| i + 3).unwrap_or(0);
    let origin = match normalized[rest_start..].find('/') {
        Some(i) => normalized[..rest_start + i]
            .trim_end_matches('/')
            .to_string(),
        None => normalized.trim_end_matches('/').to_string(),
    };
    Ok(origin)
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

fn format_reqwest_error(err: &reqwest::Error) -> String {
    match std::error::Error::source(err) {
        Some(src) => format!("{err}: {src}"),
        None => err.to_string(),
    }
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
        return Err(OmniError::internal("宝塔面板返回了 HTML 页面而非 JSON")
            .with_cause(truncate_text(trimmed, 300)));
    }

    let value: Value = serde_json::from_str(trimmed).map_err(|e| {
        OmniError::internal("宝塔面板响应不是合法 JSON").with_cause(format!(
            "{}; body: {}",
            e,
            truncate_text(trimmed, 300)
        ))
    })?;

    // 注意：部分接口（如 GetSSL）用 status:false 表示业务状态而非请求失败，
    // 由前端按接口语义判断；此处仅做 JSON 解析。
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
    request_with_method(host, api_sk, HttpMethod::Post, path, body).await
}

/// 官方 Java 等文档标注为 GET 的接口：鉴权与业务参数走 query。
pub async fn request_get(
    host: &str,
    api_sk: &str,
    path: &str,
    query: Option<Map<String, Value>>,
) -> Result<Value, OmniError> {
    request_with_method(host, api_sk, HttpMethod::Get, path, query).await
}

enum HttpMethod {
    Get,
    Post,
}

async fn request_with_method(
    host: &str,
    api_sk: &str,
    method: HttpMethod,
    path: &str,
    fields: Option<Map<String, Value>>,
) -> Result<Value, OmniError> {
    let base = normalize_base_url(host)?;
    assert_not_locked(&base)?;
    let client = client_for_host(host)?;

    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let url = format!("{base}{path}");

    let extra = fields.unwrap_or_default();
    let form = build_form_params(api_sk, &extra);

    let req = match method {
        HttpMethod::Get => client
            .get(&url)
            .header("Accept", "application/json, text/plain, */*")
            .query(&form),
        HttpMethod::Post => client
            .post(&url)
            .header("Accept", "application/json, text/plain, */*")
            .form(&form),
    };

    let resp = req.send().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "宝塔面板请求失败")
            .with_cause(format_reqwest_error(&e))
    })?;

    let status = resp.status();
    let bytes = resp.bytes().await.unwrap_or_default();
    let text = String::from_utf8_lossy(&bytes).into_owned();

    if status == reqwest::StatusCode::UNAUTHORIZED {
        trip_auth_failure(&base, "API 接口密钥错误");
        return Err(OmniError::new(ErrorCode::Auth, "API 接口密钥错误").with_cause(text));
    }

    if !status.is_success() {
        if is_bt_auth_or_lockout_message(&text) {
            trip_auth_failure(&base, &text);
        }
        return Err(
            OmniError::new(ErrorCode::Connection, format!("宝塔 API 错误 ({status})"))
                .with_cause(truncate_text(&text, 300)),
        );
    }

    let value = parse_response_value(&text)?;
    let auth_fail = value.get("status") == Some(&Value::Bool(false))
        && value
            .get("msg")
            .and_then(|m| m.as_str())
            .is_some_and(is_bt_auth_or_lockout_message);
    if auth_fail {
        if let Some(msg) = value.get("msg").and_then(|m| m.as_str()) {
            trip_auth_failure(&base, msg);
        }
    } else {
        clear_auth_gate(&base);
    }
    Ok(value)
}

/// 连通性测试（官方文档：/system?action=GetSystemTotal）。
pub async fn test_connection(host: &str, api_sk: &str) -> Result<Value, OmniError> {
    let base = normalize_base_url(host)?;
    clear_auth_gate(&base);
    request(host, api_sk, "/system?action=GetSystemTotal", None).await
}

fn looks_like_html(content_type: &str, bytes: &[u8]) -> bool {
    if content_type.to_ascii_lowercase().contains("text/html") {
        return true;
    }
    matches!(
        std::str::from_utf8(bytes)
            .map(|s| s.trim_start().to_ascii_lowercase())
            .as_deref(),
        Ok(s) if s.starts_with("<!doctype") || s.starts_with("<html")
    )
}

fn looks_like_png(bytes: &[u8]) -> bool {
    bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1a, b'\n']
}

fn bytes_to_image_data_url(content_type: &str, bytes: &[u8]) -> Result<String, OmniError> {
    if bytes.is_empty() {
        return Err(OmniError::not_found("宝塔图标为空"));
    }
    if looks_like_html(content_type, bytes) {
        return Err(OmniError::internal("宝塔图标返回了 HTML 而非图片")
            .with_cause(truncate_text(std::str::from_utf8(bytes).unwrap_or(""), 300)));
    }
    // JSON 错误包
    if bytes.first() == Some(&b'{') {
        if let Ok(text) = std::str::from_utf8(bytes) {
            if let Ok(value) = serde_json::from_str::<Value>(text) {
                let msg = value
                    .get("msg")
                    .or_else(|| value.get("message"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("下载图标失败");
                return Err(OmniError::new(ErrorCode::NotFound, msg));
            }
        }
    }

    let mime = {
        let ct = content_type
            .split(';')
            .next()
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if ct.starts_with("image/") {
            ct
        } else if looks_like_png(bytes) {
            "image/png".to_string()
        } else {
            "image/png".to_string()
        }
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

/// GET 面板静态路径（地址已含安全入口，或面板未开启入口时可用）。
async fn fetch_static_bytes(host: &str, path: &str) -> Result<(String, Vec<u8>), OmniError> {
    let base = normalize_base_url(host)?;
    let client = client_for_host(host)?;
    let path = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    };
    let url = format!("{base}{path}");

    let resp = client
        .get(&url)
        .header("Accept", "image/*,*/*;q=0.8")
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "宝塔静态资源请求失败").with_cause(e.to_string())
        })?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = resp.bytes().await.unwrap_or_default().to_vec();

    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("宝塔静态资源错误 ({status})"),
        )
        .with_cause(truncate_text(
            std::str::from_utf8(&bytes).unwrap_or(""),
            300,
        )));
    }
    Ok((content_type, bytes))
}

/// 通过鉴权 API 下载服务器上的文件字节（绕过安全入口对 /static 的拦截）。
async fn download_file_bytes(
    host: &str,
    api_sk: &str,
    filename: &str,
) -> Result<(String, Vec<u8>), OmniError> {
    let base = normalize_base_url(host)?;
    let client = client_for_host(host)?;

    let mut extra = Map::new();
    extra.insert("filename".to_string(), Value::String(filename.to_string()));
    extra.insert("path".to_string(), Value::String(filename.to_string()));
    let form = build_form_params(api_sk, &extra);

    // 不同版本下载入口不一，按序尝试
    let candidates = [
        format!("{base}/files?action=download"),
        format!("{base}/download"),
        format!("{base}/files?action=GetFileBody"),
    ];

    let mut last_err = OmniError::not_found("下载图标失败");
    for url in candidates {
        let resp = match client
            .post(&url)
            .header("Accept", "image/*,application/octet-stream,*/*")
            .form(&form)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = OmniError::new(ErrorCode::Connection, "宝塔下载图标失败")
                    .with_cause(e.to_string());
                continue;
            }
        };

        let status = resp.status();
        let content_type = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = resp.bytes().await.unwrap_or_default().to_vec();

        if !status.is_success() || bytes.is_empty() || looks_like_html(&content_type, &bytes) {
            last_err = OmniError::new(
                ErrorCode::Connection,
                format!("宝塔下载图标失败 ({status})"),
            )
            .with_cause(truncate_text(
                std::str::from_utf8(&bytes).unwrap_or(""),
                300,
            ));
            continue;
        }

        // GetFileBody 可能返回 JSON：{ status, data }，data 为乱码文本时不可用
        if content_type.to_ascii_lowercase().contains("json") || bytes.first() == Some(&b'{') {
            if let Ok(value) = serde_json::from_slice::<Value>(&bytes) {
                // 明确失败
                if value.get("status") == Some(&Value::Bool(false)) {
                    last_err = OmniError::not_found(
                        value
                            .get("msg")
                            .and_then(|v| v.as_str())
                            .unwrap_or("图标文件不存在"),
                    );
                    continue;
                }
                // 少数版本可能把 base64 放在 data
                if let Some(data) = value.get("data").and_then(|v| v.as_str()) {
                    let trimmed = data.trim();
                    if let Ok(decoded) = STANDARD.decode(trimmed) {
                        if looks_like_png(&decoded) {
                            return Ok(("image/png".to_string(), decoded));
                        }
                    }
                }
                last_err = OmniError::internal("宝塔 GetFileBody 未返回可用图标二进制");
                continue;
            }
        }

        if looks_like_png(&bytes) || content_type.to_ascii_lowercase().starts_with("image/") {
            return Ok((content_type, bytes));
        }

        last_err = OmniError::internal("宝塔下载内容不是有效图片");
    }

    Err(last_err)
}

/// 读取宝塔安全入口（`data/admin_path.pl`），如 `/abcd1234`。结果按面板地址缓存。
async fn resolve_security_entrance(host: &str, api_sk: &str) -> Option<String> {
    let base = normalize_base_url(host).ok()?;
    if let Ok(map) = ENTRANCES.lock() {
        if let Some(cached) = map.get(&base) {
            return cached.clone();
        }
    }

    let mut extra = Map::new();
    extra.insert(
        "path".to_string(),
        Value::String("/www/server/panel/data/admin_path.pl".to_string()),
    );
    let resolved = async {
        let value = request(host, api_sk, "/files?action=GetFileBody", Some(extra))
            .await
            .ok()?;
        let raw = value
            .get("data")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .trim_matches(['\r', '\n', ' ', '"', '\''])
            .to_string();
        if raw.is_empty() || raw == "/" {
            return None;
        }
        let entrance = if raw.starts_with('/') {
            raw
        } else {
            format!("/{raw}")
        };
        // 拒绝异常路径
        if entrance.contains("..") || entrance.len() > 64 {
            return None;
        }
        Some(entrance)
    }
    .await;

    if let Ok(mut map) = ENTRANCES.lock() {
        map.insert(base, resolved.clone());
    }
    resolved
}

fn is_safe_icon_token(name: &str) -> bool {
    !name.is_empty()
        && !name.contains("..")
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

/// 从接口返回的 icon 字段提取安全文件名（如 `ico-redis.png`）。
fn soft_icon_basename(icon_file: &str) -> Option<String> {
    let normalized = icon_file.trim().replace('\\', "/");
    let name = normalized.rsplit('/').next().unwrap_or("").trim();
    if is_safe_icon_token(name) {
        Some(name.to_string())
    } else {
        None
    }
}

/// 获取宝塔应用商店图标，返回 data URL。
///
/// 覆盖 Docker 商店（`dkapp/ico-dkapp_*`）与软件商店（`soft_ico/ico-*`）。
/// 面板开启「安全入口」时，直接 GET `/static/...` 会返回 HTML。
/// 策略：先读 admin_path 拼 `{入口}/static/...`，再回退鉴权下载磁盘文件。
pub async fn fetch_docker_app_icon(
    host: &str,
    api_sk: &str,
    app_name: &str,
    icon_file: Option<&str>,
) -> Result<String, OmniError> {
    let name = app_name.trim();
    if name.is_empty() {
        return Err(OmniError::invalid_input("应用名称不能为空"));
    }
    let base = normalize_base_url(host)?;
    assert_not_locked(&base)?;
    // 仅允许安全的文件名片段，避免路径穿越
    if !is_safe_icon_token(name) {
        return Err(OmniError::invalid_input("非法的应用名称"));
    }

    let icon_hint = icon_file.map(str::trim).filter(|s| !s.is_empty());
    let soft_file = icon_hint.and_then(soft_icon_basename);
    let mut static_rels: Vec<String> = Vec::new();
    let mut disk_paths: Vec<String> = Vec::new();

    // 接口已给相对路径时优先原样尝试（如 /static/img/soft_ico/dkapp/...）
    if let Some(hint) = icon_hint {
        if hint.starts_with("/static/") && !hint.contains("..") {
            static_rels.push(hint.to_string());
        }
    }

    if let Some(file) = soft_file.as_deref() {
        let is_dkapp = file.starts_with("ico-dkapp_")
            || icon_hint.is_some_and(|h| h.contains("/dkapp/") || h.contains("\\dkapp\\"));
        if is_dkapp {
            static_rels.push(format!("/static/img/soft_ico/dkapp/{file}"));
            disk_paths.push(format!(
                "/www/server/panel/BTPanel/static/img/soft_ico/dkapp/{file}"
            ));
        } else {
            static_rels.push(format!("/static/img/soft_ico/{file}"));
            disk_paths.push(format!(
                "/www/server/panel/BTPanel/static/img/soft_ico/{file}"
            ));
        }
    }

    // Docker 应用商店
    static_rels.push(format!("/static/img/soft_ico/dkapp/ico-dkapp_{name}.png"));
    disk_paths.extend([
        format!("/www/server/panel/BTPanel/static/img/soft_ico/dkapp/ico-dkapp_{name}.png"),
        format!("/www/dk_project/dk_app/apps/{name}/ico-dkapp_{name}.png"),
        format!("/www/server/panel/data/dk_app/apps/{name}/ico-dkapp_{name}.png"),
    ]);

    // 软件商店常见命名：ico-{name}.png
    if soft_file.is_none() {
        static_rels.push(format!("/static/img/soft_ico/ico-{name}.png"));
        disk_paths.push(format!(
            "/www/server/panel/BTPanel/static/img/soft_ico/ico-{name}.png"
        ));
    }

    let mut last_err = OmniError::not_found("未找到应用图标");
    let entrance = resolve_security_entrance(host, api_sk).await;

    for static_rel in &static_rels {
        // 先带安全入口，再直取 /static（地址本身已含入口或未开启入口时）
        let candidates: Vec<String> = match &entrance {
            Some(ent) => vec![format!("{ent}{static_rel}"), static_rel.clone()],
            None => vec![static_rel.clone()],
        };
        for path in candidates {
            match fetch_static_bytes(host, &path).await {
                Ok((ct, bytes)) => match bytes_to_image_data_url(&ct, &bytes) {
                    Ok(url) => return Ok(url),
                    Err(err) => last_err = err,
                },
                Err(err) => last_err = err,
            }
        }
    }

    // 鉴权下载磁盘上的图标文件
    for path in disk_paths {
        match download_file_bytes(host, api_sk, &path).await {
            Ok((ct, bytes)) => match bytes_to_image_data_url(&ct, &bytes) {
                Ok(url) => return Ok(url),
                Err(err) => last_err = err,
            },
            Err(err) => last_err = err,
        }
    }

    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_token_matches_md5_spec() {
        let token = build_request_token("test-key", 1_700_000_000);
        assert_eq!(token.len(), 32);
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase())
        );
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
