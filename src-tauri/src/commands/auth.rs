//! 微信服务号扫码登录：经 Tauri 后端代理，避免 WebView CORS。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::module_dir;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;
use tokio::sync::oneshot;

use crate::commands::proxy::build_http_client_for_url;
use crate::state::AppState;

const AUTH_API_BASE: &str = "https://mp.99.protected.fun";
const AUTH_MODULE_DIR: &str = "auth";
const DEVICE_IDENTITY_FILE: &str = "device.json";
/// OmniPanel 桌面端固定身份（落库 / 出码均需）。
const CLIENT_APP_ID: &str = "omni-client";
const CLIENT_APP_ROLE: &str = "client";

static LOGIN_WAIT_CANCELS: LazyLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthLoginQrcode {
    pub login_id: String,
    pub scene: String,
    pub ticket: String,
    pub qrcode_url: String,
    pub expire_in_sec: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthLoginSuccess {
    pub token: String,
    pub openid: String,
}

/// 本机设备身份（登录上报与「本机」标记共用）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthDeviceIdentity {
    pub device_id: String,
    pub device_name: String,
    pub os_type: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthDevice {
    #[specta(type = f64)]
    pub id: i64,
    pub device_id: String,
    pub device_name: String,
    pub os_type: String,
    pub ip: String,
    pub last_login_at: String,
    pub user_agent: String,
    pub created_at: String,
    pub updated_at: String,
    /// `client` | `assistant`
    pub role: String,
    pub app_id: String,
}

/// 绑定助手端：本地画码用的 payload（非微信小程序码）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthBindingsQrcode {
    pub bind_id: String,
    pub qr_payload: String,
    pub expire_in_sec: u32,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthBindingsBound {
    pub bind_id: String,
}

/// 当前用户资料（GET/PATCH /api/me）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthUserProfile {
    #[specta(type = f64)]
    pub id: i64,
    pub openid: String,
    pub nickname: String,
    /// 对应接口字段 `avatar_url`。
    #[serde(rename = "avatarUrl")]
    pub avatar_url: String,
    pub email: String,
}

#[derive(Debug, Deserialize)]
struct ApiUserResponse {
    id: Option<i64>,
    openid: Option<String>,
    nickname: Option<String>,
    #[serde(default, alias = "avatarUrl")]
    avatar_url: Option<String>,
    email: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiQrcodeResponse {
    login_id: Option<String>,
    scene: Option<String>,
    ticket: Option<String>,
    qrcode_url: Option<String>,
    expire_in_sec: Option<u32>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiLoginPayload {
    token: Option<String>,
    openid: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiDeviceListResponse {
    items: Option<Vec<ApiDeviceView>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiDeviceView {
    id: Option<i64>,
    device_id: Option<String>,
    device_name: Option<String>,
    os_type: Option<String>,
    ip: Option<String>,
    last_login_at: Option<String>,
    user_agent: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    role: Option<String>,
    app_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiBindingsQrcodeResponse {
    bind_id: Option<String>,
    qr_payload: Option<String>,
    expire_in_sec: Option<u32>,
    error: Option<String>,
}

fn auth_url(path: &str) -> String {
    format!("{}{}", AUTH_API_BASE.trim_end_matches('/'), path)
}

/// 客户端身份 Header（登录落库 / 绑定出码共用）。
fn apply_client_identity_headers(
    req: reqwest::RequestBuilder,
    identity: &AuthDeviceIdentity,
) -> reqwest::RequestBuilder {
    req.header("X-App-Id", CLIENT_APP_ID)
        .header("X-App-Role", CLIENT_APP_ROLE)
        .header("X-Device-Id", &identity.device_id)
        // HeaderValue 仅允许可见 ASCII；中文主机名等需降级，避免请求构建失败
        .header("X-Device-Name", ascii_header_value(&identity.device_name, "OmniPanel"))
        .header("X-Device-OS", ascii_header_value(&identity.os_type, "unknown"))
}

fn ascii_header_value(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }
    if trimmed.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
        return trimmed.to_string();
    }
    let filtered: String = trimmed
        .chars()
        .map(|c| if c.is_ascii() && !c.is_control() { c } else { '_' })
        .collect();
    let filtered = filtered.trim_matches('_').trim();
    if filtered.is_empty() {
        fallback.to_string()
    } else {
        filtered.to_string()
    }
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts = vec![err.to_string()];
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !parts.iter().any(|p| p == &text) {
            parts.push(text);
        }
        source = cause.source();
    }
    parts.join(" | ")
}

fn device_identity_path() -> Result<PathBuf, OmniError> {
    Ok(module_dir(AUTH_MODULE_DIR)?.join(DEVICE_IDENTITY_FILE))
}

fn local_hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "OmniPanel".to_string())
}

fn local_os_type() -> String {
    match std::env::consts::OS {
        "windows" => "windows".to_string(),
        "macos" => "macos".to_string(),
        "linux" => "linux".to_string(),
        other => other.to_string(),
    }
}

fn new_device_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seed = format!(
        "omnipanel-{}-{}-{}-{}",
        local_os_type(),
        std::process::id(),
        nanos,
        local_hostname()
    );
    format!("{:x}", md5::compute(seed.as_bytes()))
}

fn load_or_create_device_identity() -> Result<AuthDeviceIdentity, OmniError> {
    let path = device_identity_path()?;
    if path.exists() {
        let raw = fs::read_to_string(&path).map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取本机设备身份失败").with_cause(e.to_string())
        })?;
        if let Ok(mut identity) = serde_json::from_str::<AuthDeviceIdentity>(&raw) {
            let mut changed = false;
            if identity.device_id.trim().is_empty() {
                identity.device_id = new_device_id();
                changed = true;
            }
            let current_name = local_hostname();
            let current_os = local_os_type();
            if identity.device_name != current_name {
                identity.device_name = current_name;
                changed = true;
            }
            if identity.os_type != current_os {
                identity.os_type = current_os;
                changed = true;
            }
            if changed {
                save_device_identity(&identity)?;
            }
            return Ok(identity);
        }
    }

    let identity = AuthDeviceIdentity {
        device_id: new_device_id(),
        device_name: local_hostname(),
        os_type: local_os_type(),
    };
    save_device_identity(&identity)?;
    Ok(identity)
}

fn save_device_identity(identity: &AuthDeviceIdentity) -> Result<(), OmniError> {
    let path = device_identity_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            OmniError::new(ErrorCode::Io, "创建设备身份目录失败").with_cause(e.to_string())
        })?;
    }
    let raw = serde_json::to_string_pretty(identity).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化设备身份失败").with_cause(e.to_string())
    })?;
    fs::write(&path, raw).map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入本机设备身份失败").with_cause(e.to_string())
    })?;
    Ok(())
}

fn map_api_device(item: ApiDeviceView) -> AuthDevice {
    let role = item
        .role
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "client".to_string());
    AuthDevice {
        id: item.id.unwrap_or(0),
        device_id: item.device_id.unwrap_or_default(),
        device_name: item.device_name.unwrap_or_default(),
        os_type: item.os_type.unwrap_or_default(),
        ip: item.ip.unwrap_or_default(),
        last_login_at: item.last_login_at.unwrap_or_default(),
        user_agent: item.user_agent.unwrap_or_default(),
        created_at: item.created_at.unwrap_or_default(),
        updated_at: item.updated_at.unwrap_or_default(),
        role,
        app_id: item
            .app_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "default".to_string()),
    }
}

fn take_cancel(login_id: &str) -> Option<oneshot::Sender<()>> {
    LOGIN_WAIT_CANCELS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(login_id)
}

fn register_cancel(login_id: &str) -> oneshot::Receiver<()> {
    let (tx, rx) = oneshot::channel();
    let mut map = LOGIN_WAIT_CANCELS
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    if let Some(prev) = map.insert(login_id.to_string(), tx) {
        let _ = prev.send(());
    }
    rx
}

/// 读取本机设备身份（用于列表「本机」标记）。
#[tauri::command]
#[specta::specta]
pub async fn auth_device_identity() -> Result<AuthDeviceIdentity, OmniError> {
    load_or_create_device_identity()
}

/// 获取当前用户设备列表。
#[tauri::command]
#[specta::specta]
pub async fn auth_list_devices(
    state: State<'_, AppState>,
    token: String,
) -> Result<Vec<AuthDevice>, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }

    let proxy_config = state.proxy_config.lock().await.clone();
    let identity = load_or_create_device_identity()?;
    let url = auth_url("/api/devices");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = apply_client_identity_headers(
        client
            .get(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}")),
        &identity,
    )
    .send()
    .await
    .map_err(|e| {
        OmniError::new(ErrorCode::Connection, "获取设备列表失败")
            .with_cause(format_reqwest_error(&e))
    })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取设备列表响应失败").with_cause(e.to_string())
    })?;

    if status.as_u16() == 401 {
        let msg = serde_json::from_str::<ApiErrorBody>(&body)
            .ok()
            .and_then(|b| b.error)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "登录已失效，请重新登录".to_string());
        return Err(OmniError::new(ErrorCode::Auth, msg));
    }

    let parsed: ApiDeviceListResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析设备列表失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("获取设备列表失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    Ok(parsed
        .items
        .unwrap_or_default()
        .into_iter()
        .map(map_api_device)
        .collect())
}

/// 删除已授权设备（DELETE /api/devices/{device_id}）。
#[tauri::command]
#[specta::specta]
pub async fn auth_delete_device(
    state: State<'_, AppState>,
    token: String,
    device_id: String,
) -> Result<(), OmniError> {
    let token = token.trim().to_string();
    let device_id = device_id.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    if device_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "device_id 不能为空"));
    }

    let proxy_config = state.proxy_config.lock().await.clone();
    let identity = load_or_create_device_identity()?;
    let url = auth_url(&format!("/api/devices/{}", urlencoding_encode(&device_id)));
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = apply_client_identity_headers(
        client
            .delete(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}")),
        &identity,
    )
    .send()
    .await
    .map_err(|e| {
        OmniError::new(ErrorCode::Connection, "删除设备失败")
            .with_cause(format_reqwest_error(&e))
    })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取删除设备响应失败").with_cause(e.to_string())
    })?;

    if status.as_u16() == 401 {
        return Err(parse_auth_error(&body, "登录已失效，请重新登录"));
    }

    if !status.is_success() {
        let msg = serde_json::from_str::<ApiErrorBody>(&body)
            .ok()
            .and_then(|b| b.error)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("删除设备失败 (HTTP {status})"));
        return Err(OmniError::new(ErrorCode::Connection, msg).with_cause(body));
    }

    // 成功体形如 { "status": "deleted", "device_id": "xxx" }；兼容空响应
    if !body.trim().is_empty() {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) {
            if let Some(error) = value.get("error").and_then(|v| v.as_str()).filter(|s| !s.is_empty())
            {
                return Err(OmniError::new(ErrorCode::Internal, error.to_string()));
            }
        }
    }

    Ok(())
}

fn map_api_user(parsed: ApiUserResponse) -> AuthUserProfile {
    AuthUserProfile {
        id: parsed.id.unwrap_or(0),
        openid: parsed.openid.unwrap_or_default(),
        nickname: parsed.nickname.unwrap_or_default(),
        avatar_url: parsed.avatar_url.unwrap_or_default(),
        email: parsed.email.unwrap_or_default(),
    }
}

fn parse_auth_error(body: &str, fallback: &str) -> OmniError {
    let msg = serde_json::from_str::<ApiErrorBody>(body)
        .ok()
        .and_then(|b| b.error)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string());
    OmniError::new(ErrorCode::Auth, msg)
}

/// 获取当前用户信息（GET /api/me）。
#[tauri::command]
#[specta::specta]
pub async fn auth_get_me(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }

    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/me");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取用户信息失败").with_cause(e.to_string())
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取用户信息响应失败").with_cause(e.to_string())
    })?;

    if status.as_u16() == 401 {
        return Err(parse_auth_error(&body, "登录已失效，请重新登录"));
    }

    let parsed: ApiUserResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析用户信息失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error.clone()));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("获取用户信息失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    Ok(map_api_user(parsed))
}

/// 更新当前用户信息（PATCH /api/me）。`nickname` / `avatar_url` 至少传一个；空字符串表示清空。
#[tauri::command]
#[specta::specta]
pub async fn auth_update_profile(
    state: State<'_, AppState>,
    token: String,
    nickname: Option<String>,
    avatar_url: Option<String>,
) -> Result<AuthUserProfile, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    if nickname.is_none() && avatar_url.is_none() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "请至少提供 nickname 或 avatar_url",
        ));
    }

    let mut body_json = serde_json::Map::new();
    if let Some(value) = nickname {
        body_json.insert("nickname".to_string(), serde_json::Value::String(value));
    }
    if let Some(value) = avatar_url {
        body_json.insert("avatar_url".to_string(), serde_json::Value::String(value));
    }

    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/me");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = client
        .patch(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .json(&body_json)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "更新用户信息失败").with_cause(e.to_string())
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取更新资料响应失败").with_cause(e.to_string())
    })?;

    if status.as_u16() == 401 {
        return Err(parse_auth_error(&body, "登录已失效，请重新登录"));
    }

    let parsed: ApiUserResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析更新资料响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error.clone()));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("更新用户信息失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    Ok(map_api_user(parsed))
}

/// 获取微信扫码登录二维码。
#[tauri::command]
#[specta::specta]
pub async fn auth_login_qrcode(
    state: State<'_, AppState>,
) -> Result<AuthLoginQrcode, OmniError> {
    let identity = load_or_create_device_identity()?;
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/login/qrcode");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = apply_client_identity_headers(client.get(&url), &identity)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取登录二维码失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取二维码响应失败").with_cause(e.to_string()))?;

    let parsed: ApiQrcodeResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析二维码响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("获取登录二维码失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    let login_id = parsed
        .login_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "二维码响应缺少 login_id"))?;
    let qrcode_url = parsed
        .qrcode_url
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "二维码响应缺少 qrcode_url"))?;

    Ok(AuthLoginQrcode {
        login_id,
        scene: parsed.scene.unwrap_or_default(),
        ticket: parsed.ticket.unwrap_or_default(),
        qrcode_url,
        expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
    })
}

/// 通过后端代理 SSE，等待扫码登录成功。
#[tauri::command]
#[specta::specta]
pub async fn auth_login_wait(
    state: State<'_, AppState>,
    login_id: String,
    expire_in_sec: Option<u32>,
) -> Result<AuthLoginSuccess, OmniError> {
    if login_id.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "login_id 不能为空"));
    }

    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url(&format!(
        "/api/login/wait?id={}",
        urlencoding_encode(&login_id)
    ));
    let timeout_secs = u64::from(expire_in_sec.unwrap_or(300).saturating_add(30).max(60));
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(timeout_secs))
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e)
        })?;

    let cancel_rx = register_cancel(&login_id);

    let result = tokio::select! {
        biased;
        _ = cancel_rx => {
            Err(OmniError::new(ErrorCode::Internal, "登录等待已取消"))
        }
        outcome = wait_sse_login(&client, &url) => outcome,
    };

    let _ = take_cancel(&login_id);
    result
}

/// 取消进行中的登录等待（刷新二维码 / 关闭面板时调用）。
#[tauri::command]
#[specta::specta]
pub async fn auth_login_cancel_wait(login_id: String) -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(&login_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// 申请绑定助手端二维码 payload（客户端本地画码，非微信小程序码）。
#[tauri::command]
#[specta::specta]
pub async fn auth_bindings_qrcode(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthBindingsQrcode, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }

    let identity = load_or_create_device_identity()?;
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/bindings/qrcode");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = apply_client_identity_headers(
        client
            .post(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}")),
        &identity,
    )
    .send()
    .await
    .map_err(|e| {
        OmniError::new(ErrorCode::Connection, "获取绑定二维码失败")
            .with_cause(format_reqwest_error(&e))
    })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取绑定二维码响应失败").with_cause(e.to_string())
    })?;

    if status.as_u16() == 401 {
        return Err(parse_auth_error(&body, "登录已失效，请重新登录"));
    }

    let parsed: ApiBindingsQrcodeResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析绑定二维码响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }
    if !status.is_success() {
        let msg = serde_json::from_str::<ApiErrorBody>(&body)
            .ok()
            .and_then(|b| b.error)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("获取绑定二维码失败 (HTTP {status})"));
        return Err(OmniError::new(ErrorCode::Connection, msg).with_cause(body));
    }

    let bind_id = parsed
        .bind_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "绑定二维码响应缺少 bind_id"))?;
    let qr_payload = parsed
        .qr_payload
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| bind_id.clone());

    Ok(AuthBindingsQrcode {
        bind_id,
        qr_payload,
        expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
    })
}

/// 通过后端代理 SSE，等待小程序扫码确认绑定（事件 `bound`）。
#[tauri::command]
#[specta::specta]
pub async fn auth_bindings_wait(
    state: State<'_, AppState>,
    token: String,
    bind_id: String,
    expire_in_sec: Option<u32>,
) -> Result<AuthBindingsBound, OmniError> {
    let token = token.trim().to_string();
    let bind_id = bind_id.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    if bind_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "bind_id 不能为空"));
    }

    let identity = load_or_create_device_identity()?;
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url(&format!(
        "/api/bindings/wait?id={}",
        urlencoding_encode(&bind_id)
    ));
    let timeout_secs = u64::from(expire_in_sec.unwrap_or(300).saturating_add(30).max(60));
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(timeout_secs))
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e)
        })?;

    let cancel_rx = register_cancel(&bind_id);

    let result = tokio::select! {
        biased;
        _ = cancel_rx => {
            Err(OmniError::new(ErrorCode::Internal, "绑定等待已取消"))
        }
        outcome = wait_sse_bound(&client, &url, &token, &identity, &bind_id) => outcome,
    };

    let _ = take_cancel(&bind_id);
    result
}

/// 取消进行中的绑定等待（刷新二维码 / 关闭弹窗时调用）。
#[tauri::command]
#[specta::specta]
pub async fn auth_bindings_cancel_wait(bind_id: String) -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(&bind_id) {
        let _ = tx.send(());
    }
    Ok(())
}

fn is_benign_sse_disconnect(cause: &str) -> bool {
    let lower = cause.to_ascii_lowercase();
    lower.contains("decoding response body")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("broken pipe")
        || lower.contains("unexpected eof")
        || lower.contains("error sending request")
}

async fn wait_sse_login(client: &reqwest::Client, url: &str) -> Result<AuthLoginSuccess, OmniError> {
    let resp = client
        .get(url)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(|e| {
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "登录等待已断开，请刷新二维码")
            } else {
                OmniError::new(ErrorCode::Connection, "连接登录等待通道失败").with_cause(cause)
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("登录等待失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            let cause = e.to_string();
            // 取消/代理中断/服务端提前关流时常见，按可恢复断开处理（不附带底层 cause，避免控制台刷屏）
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "登录等待已断开，请刷新二维码")
            } else {
                OmniError::new(ErrorCode::Io, "读取登录等待流失败").with_cause(cause)
            }
        })?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buffer.find('\n') {
            let mut line = buffer[..idx].to_string();
            buffer.drain(..=idx);
            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() {
                let data = data_lines.join("\n");
                let name = if event_name.is_empty() {
                    "message".to_string()
                } else {
                    std::mem::take(&mut event_name)
                };
                data_lines.clear();

                if name == "login" && !data.is_empty() {
                    let payload: ApiLoginPayload = serde_json::from_str(&data).map_err(|e| {
                        OmniError::new(ErrorCode::Internal, "解析登录事件失败")
                            .with_cause(format!("{e}; data={data}"))
                    })?;
                    let token = payload
                        .token
                        .filter(|s| !s.is_empty())
                        .ok_or_else(|| OmniError::new(ErrorCode::Auth, "登录响应缺少 token"))?;
                    let openid = payload.openid.unwrap_or_default();
                    return Ok(AuthLoginSuccess { token, openid });
                }
                // timeout / fail / ping 等事件：继续等或在 fail 时退出
                if name == "timeout" || name == "fail" {
                    return Err(OmniError::new(
                        ErrorCode::Timeout,
                        if data.is_empty() {
                            "登录等待已结束，请刷新二维码".to_string()
                        } else {
                            data
                        },
                    ));
                }
                continue;
            }

            if let Some(rest) = line.strip_prefix("event:") {
                event_name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }
    }

    Err(OmniError::new(
        ErrorCode::Timeout,
        "登录等待已结束，请刷新二维码",
    ))
}

async fn wait_sse_bound(
    client: &reqwest::Client,
    url: &str,
    token: &str,
    identity: &AuthDeviceIdentity,
    bind_id: &str,
) -> Result<AuthBindingsBound, OmniError> {
    let resp = apply_client_identity_headers(
        client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .header(reqwest::header::ACCEPT, "text/event-stream"),
        identity,
    )
    .send()
    .await
    .map_err(|e| {
        let cause = e.to_string();
        if is_benign_sse_disconnect(&cause) {
            OmniError::new(ErrorCode::Timeout, "绑定等待已断开，请刷新二维码")
        } else {
            OmniError::new(ErrorCode::Connection, "连接绑定等待通道失败").with_cause(cause)
        }
    })?;

    let status = resp.status();
    if status.as_u16() == 401 {
        let body = resp.text().await.unwrap_or_default();
        return Err(parse_auth_error(&body, "登录已失效，请重新登录"));
    }
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = serde_json::from_str::<ApiErrorBody>(&body)
            .ok()
            .and_then(|b| b.error)
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("绑定等待失败 (HTTP {status})"));
        return Err(OmniError::new(ErrorCode::Connection, msg).with_cause(body));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "绑定等待已断开，请刷新二维码")
            } else {
                OmniError::new(ErrorCode::Io, "读取绑定等待流失败").with_cause(cause)
            }
        })?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buffer.find('\n') {
            let mut line = buffer[..idx].to_string();
            buffer.drain(..=idx);
            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() {
                let data = data_lines.join("\n");
                let name = if event_name.is_empty() {
                    "message".to_string()
                } else {
                    std::mem::take(&mut event_name)
                };
                data_lines.clear();

                if name == "bound" {
                    return Ok(AuthBindingsBound {
                        bind_id: bind_id.to_string(),
                    });
                }
                if name == "timeout" || name == "fail" {
                    return Err(OmniError::new(
                        ErrorCode::Timeout,
                        if data.is_empty() {
                            "绑定等待已结束，请刷新二维码".to_string()
                        } else {
                            data
                        },
                    ));
                }
                continue;
            }

            if let Some(rest) = line.strip_prefix("event:") {
                event_name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }
    }

    Err(OmniError::new(
        ErrorCode::Timeout,
        "绑定等待已结束，请刷新二维码",
    ))
}

fn urlencoding_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        }
    }
    out
}
