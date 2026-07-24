//! 账号登录：微信扫码 / 邮箱验证码 / GitHub OAuth；经 Tauri 后端代理，避免 WebView CORS。

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
use tauri::{AppHandle, State};
use tauri_plugin_shell::ShellExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use url::Url;

use crate::commands::proxy::build_http_client_for_url;
use crate::state::AppState;

const AUTH_API_BASE: &str = "https://mp.99.protected.fun";
const AUTH_MODULE_DIR: &str = "auth";
const DEVICE_IDENTITY_FILE: &str = "device.json";
/// OmniPanel 桌面端固定身份（文档约定；登录上报优先使用）。
const CLIENT_APP_ID: &str = "omni-client";
/// 服务端当前对桌面端落库的默认 app_id（历史登录 / 未识别 X-App-Id 时写入）。
/// 绑定出码按 app_id 精确查找，需与落库值一致，故作为回退。
const CLIENT_APP_ID_FALLBACK: &str = "default";
const CLIENT_APP_ROLE: &str = "client";
/// 桌面端接收 GitHub 授权成功回调的本机回环地址（成功页会跳转到此）。
const GITHUB_OAUTH_LOOPBACK_ADDR: &str = "127.0.0.1:27841";
const GITHUB_OAUTH_CANCEL_LOGIN: &str = "github-oauth-login";
const GITHUB_OAUTH_CANCEL_LINK: &str = "github-oauth-link";

static LOGIN_WAIT_CANCELS: LazyLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// 绑定出码成功时选用的 X-App-Id，供 wait SSE 复用（与落库 app_id 一致）。
static BINDING_APP_IDS: LazyLock<Mutex<HashMap<String, String>>> =
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

/// 邮箱验证码发送结果（开发模式可能直接返回 `code`）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthEmailCodeSent {
    pub email: String,
    pub code: String,
    pub expire_in_sec: u32,
    pub hint: String,
}

/// 单项账号绑定状态。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccountLinkStatus {
    pub bound: bool,
    #[serde(default)]
    pub openid: String,
    #[serde(default, rename = "githubId")]
    pub github_id: String,
    #[serde(default)]
    pub email: String,
}

/// 账号绑定状态汇总（GET /api/account/links）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthAccountLinks {
    pub wechat: AuthAccountLinkStatus,
    pub github: AuthAccountLinkStatus,
    pub email: AuthAccountLinkStatus,
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
    /// 对应接口字段 `github_id`。
    #[serde(rename = "githubId")]
    pub github_id: String,
}

#[derive(Debug, Deserialize)]
struct ApiUserResponse {
    id: Option<i64>,
    openid: Option<String>,
    nickname: Option<String>,
    #[serde(default, alias = "avatarUrl")]
    avatar_url: Option<String>,
    email: Option<String>,
    #[serde(default, alias = "githubId")]
    github_id: Option<String>,
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
struct ApiEmailSendResponse {
    email: Option<String>,
    code: Option<String>,
    expire_in_sec: Option<u32>,
    hint: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiTokenLoginResponse {
    token: Option<String>,
    #[serde(default)]
    user: Option<ApiUserResponse>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiAccountLinkStatusResponse {
    #[serde(default)]
    bound: bool,
    openid: Option<String>,
    #[serde(default, alias = "githubId")]
    github_id: Option<String>,
    email: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiAccountLinksResponse {
    wechat: Option<ApiAccountLinkStatusResponse>,
    github: Option<ApiAccountLinkStatusResponse>,
    email: Option<ApiAccountLinkStatusResponse>,
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
    apply_client_identity_headers_with_app(req, identity, CLIENT_APP_ID)
}

fn apply_client_identity_headers_with_app(
    req: reqwest::RequestBuilder,
    identity: &AuthDeviceIdentity,
    app_id: &str,
) -> reqwest::RequestBuilder {
    req.header("X-App-Id", app_id)
        .header("X-App-Role", CLIENT_APP_ROLE)
        .header("X-Device-Id", &identity.device_id)
        // HeaderValue 仅允许可见 ASCII；中文主机名等需降级，避免请求构建失败
        .header("X-Device-Name", ascii_header_value(&identity.device_name, "OmniPanel"))
        .header("X-Device-OS", ascii_header_value(&identity.os_type, "unknown"))
}

fn is_client_device_not_found(message: &str) -> bool {
    message.to_ascii_lowercase().contains("client device not found")
}

fn bindings_api_error(message: String) -> OmniError {
    if is_client_device_not_found(&message) {
        OmniError::new(
            ErrorCode::Internal,
            "本机客户端设备未落库或不匹配，请重新登录后再绑定助手端",
        )
        .with_cause(message)
    } else {
        OmniError::new(ErrorCode::Internal, message)
    }
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

fn remember_binding_app_id(bind_id: &str, app_id: &str) {
    BINDING_APP_IDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(bind_id.to_string(), app_id.to_string());
}

fn take_binding_app_id(bind_id: &str) -> String {
    BINDING_APP_IDS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(bind_id)
        .unwrap_or_else(|| CLIENT_APP_ID_FALLBACK.to_string())
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
        github_id: parsed.github_id.unwrap_or_default(),
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

/// 发送邮箱登录验证码（POST /api/login/email/send）。
#[tauri::command]
#[specta::specta]
pub async fn auth_login_email_send(
    state: State<'_, AppState>,
    email: String,
) -> Result<AuthEmailCodeSent, OmniError> {
    let email = email.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入有效邮箱"));
    }

    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/login/email/send");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = client
        .post(&url)
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "发送验证码失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取验证码响应失败").with_cause(e.to_string()))?;

    let parsed: ApiEmailSendResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析验证码响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Auth, error));
    }
    if !status.is_success() {
        return Err(parse_auth_error(
            &body,
            &format!("发送验证码失败 (HTTP {status})"),
        ));
    }

    Ok(AuthEmailCodeSent {
        email: parsed.email.unwrap_or(email),
        code: parsed.code.unwrap_or_default(),
        expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
        hint: parsed.hint.unwrap_or_default(),
    })
}

/// 邮箱验证码登录（POST /api/login/email）。
#[tauri::command]
#[specta::specta]
pub async fn auth_login_email(
    state: State<'_, AppState>,
    email: String,
    code: String,
) -> Result<AuthLoginSuccess, OmniError> {
    let email = email.trim().to_string();
    let code = code.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入有效邮箱"));
    }
    if code.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入验证码"));
    }

    let identity = load_or_create_device_identity()?;
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/login/email");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = apply_client_identity_headers(client.post(&url), &identity)
        .json(&serde_json::json!({ "email": email, "code": code }))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "邮箱登录失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取登录响应失败").with_cause(e.to_string()))?;

    map_token_login_response(&body, status, "邮箱登录失败")
}

/// GitHub OAuth 登录：系统浏览器授权，本机回环接收 `?token=`。
#[tauri::command]
#[specta::specta]
pub async fn auth_login_github(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AuthLoginSuccess, OmniError> {
    let identity = load_or_create_device_identity()?;
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/login/github");

    // 需要拿到 302 Location，不能自动跟随重定向
    let client = build_http_client_no_redirect(&url, &proxy_config, Duration::from_secs(30))
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))?;

    let resp = apply_client_identity_headers(client.get(&url), &identity)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "发起 GitHub 登录失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp.text().await.unwrap_or_default();

    if status.as_u16() == 503 || (!status.is_redirection() && !status.is_success()) {
        return Err(parse_auth_error(
            &body,
            if body.trim().is_empty() {
                "GitHub 登录未配置或不可用"
            } else {
                "发起 GitHub 登录失败"
            },
        ));
    }

    let authorize_url = location
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            parse_auth_error(
                &body,
                "GitHub 登录未返回授权地址（请确认服务端已配置 OAuth）",
            )
        })?;

    let authorize_url = Url::parse(&authorize_url).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "GitHub 授权地址无效").with_cause(e.to_string())
    })?;

    let cancel_rx = register_cancel(GITHUB_OAUTH_CANCEL_LOGIN);
    let result = async {
        // 先监听再开浏览器，避免已授权用户瞬间回调时端口尚未就绪
        let listener = TcpListener::bind(GITHUB_OAUTH_LOOPBACK_ADDR)
            .await
            .map_err(|e| {
                OmniError::new(
                    ErrorCode::Internal,
                    "无法启动 GitHub 回调监听（本机端口被占用，请稍后重试）",
                )
                .with_cause(format!("{GITHUB_OAUTH_LOOPBACK_ADDR}: {e}"))
            })?;
        open_system_browser(&app, &authorize_url)?;
        let token = wait_github_oauth_on_listener(listener, cancel_rx).await?;
        Ok(AuthLoginSuccess {
            token,
            openid: String::new(),
        })
    }
    .await;
    let _ = take_cancel(GITHUB_OAUTH_CANCEL_LOGIN);
    result
}

/// 取消进行中的 GitHub 登录等待。
#[tauri::command]
#[specta::specta]
pub async fn auth_login_github_cancel() -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(GITHUB_OAUTH_CANCEL_LOGIN) {
        let _ = tx.send(());
    }
    Ok(())
}

#[derive(Debug)]
enum GitHubOAuthCapture {
    LoginToken(String),
    Linked,
}

fn open_system_browser(app: &AppHandle, url: &Url) -> Result<(), OmniError> {
    #[allow(deprecated)] // shell::open 仍可用；后续可迁 tauri-plugin-opener
    let open_result = app.shell().open(url.as_str(), None);
    open_result.map_err(|e| {
        OmniError::new(
            ErrorCode::Internal,
            "无法打开系统浏览器，请检查默认浏览器设置",
        )
        .with_cause(e.to_string())
    })
}

fn parse_github_oauth_capture(url: &Url) -> Option<GitHubOAuthCapture> {
    if extract_query_from_url(url, "linked")
        .map(|v| v.eq_ignore_ascii_case("github"))
        .unwrap_or(false)
    {
        return Some(GitHubOAuthCapture::Linked);
    }
    extract_query_from_url(url, "token").map(GitHubOAuthCapture::LoginToken)
}

/// 在本机回环端口等待浏览器成功页跳转（`?token=`）。
async fn wait_github_oauth_on_listener(
    listener: TcpListener,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<String, OmniError> {
    let response = concat!(
        "HTTP/1.1 200 OK\r\n",
        "Content-Type: text/html; charset=utf-8\r\n",
        "Connection: close\r\n",
        "\r\n",
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>授权完成</title></head>",
        "<body style=\"font-family:sans-serif;padding:2rem;background:#0f1419;color:#e7ecf3\">",
        "<h1>授权完成</h1><p>可以关闭此页面，返回 OmniPanel。</p></body></html>"
    );

    let mut cancel_rx = cancel_rx;
    let deadline = tokio::time::sleep(Duration::from_secs(300));
    tokio::pin!(deadline);

    loop {
        tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                return Err(OmniError::new(ErrorCode::Internal, "GitHub 授权已取消"));
            }
            _ = &mut deadline => {
                return Err(OmniError::new(ErrorCode::Timeout, "GitHub 授权超时，请重试"));
            }
            accepted = listener.accept() => {
                let (mut stream, _) = accepted.map_err(|e| {
                    OmniError::new(ErrorCode::Io, "接收 GitHub 回调失败").with_cause(e.to_string())
                })?;
                let mut buf = vec![0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let req = String::from_utf8_lossy(&buf[..n]);
                let path_and_query = req
                    .lines()
                    .next()
                    .and_then(|line| line.split_whitespace().nth(1))
                    .unwrap_or("/");
                let parsed = Url::parse(&format!("http://{GITHUB_OAUTH_LOOPBACK_ADDR}{path_and_query}")).ok();
                let _ = stream.write_all(response.as_bytes()).await;
                let _ = stream.shutdown().await;

                let Some(url) = parsed else {
                    continue;
                };
                match parse_github_oauth_capture(&url) {
                    Some(GitHubOAuthCapture::LoginToken(token)) => return Ok(token),
                    Some(GitHubOAuthCapture::Linked) => {
                        return Err(OmniError::new(
                            ErrorCode::InvalidInput,
                            "收到了绑定回调而非登录凭证，请从登录入口重试",
                        ));
                    }
                    None => continue,
                }
            }
        }
    }
}

/// 轮询账号绑定状态，直到 GitHub 已绑定。
async fn poll_github_link_bound(
    client: &reqwest::Client,
    token: &str,
    cancel_rx: oneshot::Receiver<()>,
) -> Result<(), OmniError> {
    let url = auth_url("/api/account/links");
    let mut cancel_rx = cancel_rx;
    let deadline = tokio::time::sleep(Duration::from_secs(300));
    tokio::pin!(deadline);

    loop {
        let resp = client
            .get(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .send()
            .await;
        if let Ok(resp) = resp {
            let status = resp.status();
            let body = resp.text().await.unwrap_or_default();
            if status.as_u16() == 401 {
                return Err(OmniError::new(ErrorCode::Auth, "登录已失效，请重新登录")
                    .with_cause(body));
            }
            if status.is_success() {
                if let Ok(parsed) = serde_json::from_str::<ApiAccountLinksResponse>(&body) {
                    if parsed.github.as_ref().is_some_and(|g| g.bound) {
                        return Ok(());
                    }
                }
            }
        }

        tokio::select! {
            biased;
            _ = &mut cancel_rx => {
                return Err(OmniError::new(ErrorCode::Internal, "GitHub 绑定已取消"));
            }
            _ = &mut deadline => {
                return Err(OmniError::new(ErrorCode::Timeout, "GitHub 绑定超时，请重试"));
            }
            _ = tokio::time::sleep(Duration::from_millis(1500)) => {}
        }
    }
}

fn extract_query_from_url(url: &Url, key: &str) -> Option<String> {
    for (k, value) in url.query_pairs() {
        if k == key {
            let v = value.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    let fragment = url.fragment()?;
    let query = fragment.strip_prefix('?').unwrap_or(fragment);
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                let decoded = urlencoding::decode(v)
                    .unwrap_or_else(|_| v.into())
                    .trim()
                    .to_string();
                if !decoded.is_empty() {
                    return Some(decoded);
                }
            }
        }
    }
    None
}

fn parse_account_link_error(body: &str, status: reqwest::StatusCode, fallback: &str) -> OmniError {
    let code = serde_json::from_str::<ApiErrorBody>(body)
        .ok()
        .and_then(|b| b.error)
        .filter(|s| !s.is_empty());
    match (status.as_u16(), code.as_deref()) {
        (401, _) => OmniError::new(ErrorCode::Auth, "登录已失效，请重新登录")
            .with_cause(body.to_string()),
        (409, Some("already_bound")) => OmniError::new(
            ErrorCode::InvalidInput,
            "该身份已绑定其他账号，无法重复绑定",
        )
        .with_cause(body.to_string()),
        (409, Some("already_linked")) => OmniError::new(
            ErrorCode::InvalidInput,
            "当前账号已绑定此登录方式",
        )
        .with_cause(body.to_string()),
        (409, Some("not_linked")) => OmniError::new(
            ErrorCode::InvalidInput,
            "当前账号未绑定此登录方式",
        )
        .with_cause(body.to_string()),
        (409, Some("last_identity")) => OmniError::new(
            ErrorCode::InvalidInput,
            "至少保留一种登录方式，无法解绑",
        )
        .with_cause(body.to_string()),
        (409, Some(msg)) => {
            OmniError::new(ErrorCode::InvalidInput, msg.to_string()).with_cause(body.to_string())
        }
        (_, Some(msg)) if !status.is_success() => {
            // 业务失败（含绑定冲突文案）不要标成 Auth，避免前端误判为会话失效
            OmniError::new(ErrorCode::InvalidInput, msg.to_string()).with_cause(body.to_string())
        }
        _ if !status.is_success() => OmniError::new(
            ErrorCode::Connection,
            format!("{fallback} (HTTP {status})"),
        )
        .with_cause(body.to_string()),
        _ => OmniError::new(ErrorCode::Internal, fallback.to_string()).with_cause(body.to_string()),
    }
}

/// 查询账号绑定状态（GET /api/account/links）。
#[tauri::command]
#[specta::specta]
pub async fn auth_account_links(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthAccountLinks, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/account/links");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;
    let resp = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取账号绑定状态失败")
                .with_cause(format_reqwest_error(&e))
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取绑定状态响应失败").with_cause(e.to_string())
    })?;
    if !status.is_success() {
        return Err(parse_account_link_error(&body, status, "获取账号绑定状态失败"));
    }
    let parsed: ApiAccountLinksResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析绑定状态失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    Ok(AuthAccountLinks {
        wechat: AuthAccountLinkStatus {
            bound: parsed.wechat.as_ref().map(|x| x.bound).unwrap_or(false),
            openid: parsed
                .wechat
                .and_then(|x| x.openid)
                .unwrap_or_default(),
            github_id: String::new(),
            email: String::new(),
        },
        github: AuthAccountLinkStatus {
            bound: parsed.github.as_ref().map(|x| x.bound).unwrap_or(false),
            openid: String::new(),
            github_id: parsed
                .github
                .and_then(|x| x.github_id)
                .unwrap_or_default(),
            email: String::new(),
        },
        email: AuthAccountLinkStatus {
            bound: parsed.email.as_ref().map(|x| x.bound).unwrap_or(false),
            openid: String::new(),
            github_id: String::new(),
            email: parsed.email.and_then(|x| x.email).unwrap_or_default(),
        },
    })
}

/// 创建微信绑定二维码（POST /api/account/links/wechat/qrcode）。
#[tauri::command]
#[specta::specta]
pub async fn auth_link_wechat_qrcode(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthLoginQrcode, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/account/links/wechat/qrcode");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;
    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取微信绑定二维码失败")
                .with_cause(format_reqwest_error(&e))
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取微信绑定二维码响应失败").with_cause(e.to_string())
    })?;
    if !status.is_success() {
        return Err(parse_account_link_error(
            &body,
            status,
            "获取微信绑定二维码失败",
        ));
    }
    let parsed: ApiQrcodeResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析微信绑定二维码失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Auth, error));
    }
    let login_id = parsed
        .login_id
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "绑定二维码响应缺少 login_id"))?;
    let qrcode_url = parsed
        .qrcode_url
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "绑定二维码响应缺少 qrcode_url"))?;
    Ok(AuthLoginQrcode {
        login_id,
        scene: parsed.scene.unwrap_or_default(),
        ticket: parsed.ticket.unwrap_or_default(),
        qrcode_url,
        expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
    })
}

/// SSE 等待微信绑定成功（GET /api/account/links/wechat/wait）。
#[tauri::command]
#[specta::specta]
pub async fn auth_link_wechat_wait(
    state: State<'_, AppState>,
    token: String,
    login_id: String,
    expire_in_sec: Option<u32>,
) -> Result<(), OmniError> {
    let token = token.trim().to_string();
    let login_id = login_id.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    if login_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "login_id 不能为空"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url(&format!(
        "/api/account/links/wechat/wait?id={}",
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
        _ = cancel_rx => Err(OmniError::new(ErrorCode::Internal, "微信绑定等待已取消")),
        outcome = wait_sse_account_link(&client, &url, &token) => outcome,
    };
    let _ = take_cancel(&login_id);
    result
}

/// 取消微信绑定等待。
#[tauri::command]
#[specta::specta]
pub async fn auth_link_wechat_cancel_wait(login_id: String) -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(&login_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// 发送邮箱绑定验证码。
#[tauri::command]
#[specta::specta]
pub async fn auth_link_email_send(
    state: State<'_, AppState>,
    token: String,
    email: String,
) -> Result<AuthEmailCodeSent, OmniError> {
    let token = token.trim().to_string();
    let email = email.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    if email.is_empty() || !email.contains('@') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入有效邮箱"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/account/links/email/send");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;
    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "email": email }))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "发送绑定验证码失败")
                .with_cause(format_reqwest_error(&e))
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取验证码响应失败").with_cause(e.to_string())
    })?;
    if !status.is_success() {
        return Err(parse_account_link_error(&body, status, "发送绑定验证码失败"));
    }
    let parsed: ApiEmailSendResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析验证码响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Auth, error));
    }
    Ok(AuthEmailCodeSent {
        email: parsed.email.unwrap_or(email),
        code: parsed.code.unwrap_or_default(),
        expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
        hint: parsed.hint.unwrap_or_default(),
    })
}

/// 邮箱验证码绑定。
#[tauri::command]
#[specta::specta]
pub async fn auth_link_email(
    state: State<'_, AppState>,
    token: String,
    email: String,
    code: String,
) -> Result<AuthUserProfile, OmniError> {
    let token = token.trim().to_string();
    let email = email.trim().to_string();
    let code = code.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    if email.is_empty() || !email.contains('@') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入有效邮箱"));
    }
    if code.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入验证码"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/account/links/email");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;
    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({ "email": email, "code": code }))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "绑定邮箱失败")
                .with_cause(format_reqwest_error(&e))
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取绑定邮箱响应失败").with_cause(e.to_string())
    })?;
    if !status.is_success() {
        return Err(parse_account_link_error(&body, status, "绑定邮箱失败"));
    }
    let parsed: ApiUserResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析绑定邮箱响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Auth, error.clone()));
    }
    Ok(map_api_user(parsed))
}

/// GitHub OAuth 绑定：系统浏览器授权，轮询 `/api/account/links` 直到绑定成功。
#[tauri::command]
#[specta::specta]
pub async fn auth_link_github(
    app: AppHandle,
    state: State<'_, AppState>,
    token: String,
) -> Result<(), OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url("/api/account/links/github");
    let client = build_http_client_no_redirect(&url, &proxy_config, Duration::from_secs(30))
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))?;
    let resp = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "发起 GitHub 绑定失败")
                .with_cause(format_reqwest_error(&e))
        })?;
    let status = resp.status();
    let location = resp
        .headers()
        .get(reqwest::header::LOCATION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let body = resp.text().await.unwrap_or_default();
    if status.as_u16() == 503 || (!status.is_redirection() && !status.is_success()) {
        return Err(parse_account_link_error(
            &body,
            status,
            if body.trim().is_empty() {
                "GitHub 绑定未配置或不可用"
            } else {
                "发起 GitHub 绑定失败"
            },
        ));
    }
    let authorize_url = location
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            parse_account_link_error(
                &body,
                status,
                "GitHub 绑定未返回授权地址（请确认服务端已配置 OAuth）",
            )
        })?;
    let authorize_url = Url::parse(&authorize_url).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "GitHub 授权地址无效").with_cause(e.to_string())
    })?;

    open_system_browser(&app, &authorize_url)?;

    let poll_client =
        build_http_client_for_url(&auth_url("/api/account/links"), &proxy_config, Duration::from_secs(30))
            .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))?;

    let cancel_rx = register_cancel(GITHUB_OAUTH_CANCEL_LINK);
    let result = poll_github_link_bound(&poll_client, &token, cancel_rx).await;
    let _ = take_cancel(GITHUB_OAUTH_CANCEL_LINK);
    result
}

/// 取消进行中的 GitHub 绑定等待。
#[tauri::command]
#[specta::specta]
pub async fn auth_link_github_cancel() -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(GITHUB_OAUTH_CANCEL_LINK) {
        let _ = tx.send(());
    }
    Ok(())
}

async fn auth_unlink_path(
    state: &State<'_, AppState>,
    token: String,
    path: &str,
    fail_msg: &str,
) -> Result<AuthUserProfile, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let url = auth_url(path);
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;
    let resp = client
        .delete(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, fail_msg.to_string())
                .with_cause(format_reqwest_error(&e))
        })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, format!("读取{fail_msg}响应失败")).with_cause(e.to_string())
    })?;
    if !status.is_success() {
        return Err(parse_account_link_error(&body, status, fail_msg));
    }
    let parsed: ApiUserResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, format!("解析{fail_msg}响应失败"))
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::InvalidInput, error.clone()));
    }
    Ok(map_api_user(parsed))
}

/// 解绑微信（DELETE /api/account/links/wechat）。
#[tauri::command]
#[specta::specta]
pub async fn auth_unlink_wechat(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    auth_unlink_path(&state, token, "/api/account/links/wechat", "解绑微信失败").await
}

/// 解绑 GitHub（DELETE /api/account/links/github）。
#[tauri::command]
#[specta::specta]
pub async fn auth_unlink_github(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    auth_unlink_path(&state, token, "/api/account/links/github", "解绑 GitHub 失败").await
}

/// 解绑邮箱（DELETE /api/account/links/email）。
#[tauri::command]
#[specta::specta]
pub async fn auth_unlink_email(
    state: State<'_, AppState>,
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    auth_unlink_path(&state, token, "/api/account/links/email", "解绑邮箱失败").await
}

async fn wait_sse_account_link(
    client: &reqwest::Client,
    url: &str,
    token: &str,
) -> Result<(), OmniError> {
    let resp = client
        .get(url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(|e| {
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "微信绑定等待已断开，请刷新二维码")
            } else {
                OmniError::new(ErrorCode::Connection, "连接微信绑定等待通道失败").with_cause(cause)
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(parse_account_link_error(
            &body,
            status,
            "微信绑定等待失败",
        ));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| {
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "微信绑定等待已断开，请刷新二维码")
            } else {
                OmniError::new(ErrorCode::Io, "读取微信绑定等待流失败").with_cause(cause)
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

                if name == "link" {
                    return Ok(());
                }
                if name == "timeout" || name == "fail" {
                    let msg = serde_json::from_str::<ApiErrorBody>(&data)
                        .ok()
                        .and_then(|b| b.error)
                        .filter(|s| !s.is_empty())
                        .unwrap_or_else(|| {
                            if data.is_empty() {
                                "微信绑定等待已结束，请刷新二维码".to_string()
                            } else {
                                data
                            }
                        });
                    return Err(OmniError::new(
                        if name == "timeout" {
                            ErrorCode::Timeout
                        } else {
                            ErrorCode::Auth
                        },
                        msg,
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
        "微信绑定等待已结束，请刷新二维码",
    ))
}

fn map_token_login_response(
    body: &str,
    status: reqwest::StatusCode,
    fallback: &str,
) -> Result<AuthLoginSuccess, OmniError> {
    let parsed: ApiTokenLoginResponse = serde_json::from_str(body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, format!("解析{fallback}响应失败"))
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Auth, error));
    }
    if !status.is_success() {
        return Err(parse_auth_error(body, &format!("{fallback} (HTTP {status})")));
    }

    let token = parsed
        .token
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, format!("{fallback}：响应缺少 token")))?;

    let openid = parsed
        .user
        .as_ref()
        .and_then(|u| u.openid.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            parsed
                .user
                .as_ref()
                .and_then(|u| u.email.clone())
                .filter(|s| !s.is_empty())
        })
        .unwrap_or_default();

    Ok(AuthLoginSuccess { token, openid })
}

/// 与 [`build_http_client_for_url`] 相同，但不跟随重定向（用于捕获 OAuth Location）。
fn build_http_client_no_redirect(
    url: &str,
    proxy_config: &crate::state::ProxyConfig,
    timeout: Duration,
) -> Result<reqwest::Client, String> {
    use crate::commands::proxy::is_loopback_http_url;

    let mut builder = reqwest::Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none());

    if is_loopback_http_url(url) {
        builder = builder.no_proxy();
    } else if proxy_config.enabled && !proxy_config.host.is_empty() {
        let proxy_url = format!(
            "{}://{}:{}",
            proxy_config.protocol, proxy_config.host, proxy_config.port
        );
        let mut proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("Invalid proxy configuration: {e}"))?;
        if !proxy_config.username.is_empty() {
            proxy = proxy.basic_auth(&proxy_config.username, &proxy_config.password);
        }
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
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

    // 服务端按 X-App-Id 精确匹配已落库 client 设备；文档约定 omni-client，
    // 但历史登录可能写入 default，故按优先级尝试。
    let mut last_not_found: Option<String> = None;
    for app_id in [CLIENT_APP_ID, CLIENT_APP_ID_FALLBACK] {
        let resp = apply_client_identity_headers_with_app(
            client
                .post(&url)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}")),
            &identity,
            app_id,
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
            if is_client_device_not_found(&error) {
                last_not_found = Some(error);
                continue;
            }
            return Err(bindings_api_error(error));
        }
        if !status.is_success() {
            let msg = serde_json::from_str::<ApiErrorBody>(&body)
                .ok()
                .and_then(|b| b.error)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| format!("获取绑定二维码失败 (HTTP {status})"));
            if is_client_device_not_found(&msg) {
                last_not_found = Some(msg);
                continue;
            }
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

        remember_binding_app_id(&bind_id, app_id);
        return Ok(AuthBindingsQrcode {
            bind_id,
            qr_payload,
            expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
        });
    }

    Err(bindings_api_error(last_not_found.unwrap_or_else(|| {
        "client device not found".to_string()
    })))
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
    let app_id = take_binding_app_id(&bind_id);
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
        outcome = wait_sse_bound(&client, &url, &token, &identity, &app_id, &bind_id) => outcome,
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
    app_id: &str,
    bind_id: &str,
) -> Result<AuthBindingsBound, OmniError> {
    let resp = apply_client_identity_headers_with_app(
        client
            .get(url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
            .header(reqwest::header::ACCEPT, "text/event-stream"),
        identity,
        app_id,
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
