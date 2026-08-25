//! 账号登录：微信扫码 / 邮箱验证码 / GitHub OAuth；经 HTTP 后端代理，避免浏览器 CORS。

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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use url::Url;

use crate::http_client::{build_http_client_for_url, build_http_client_no_redirect, proxy_config};

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

/// 侧栏公开二维码地址（GET /api/public/qrcodes）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthPublicQrcodes {
    pub miniapp_url: String,
    pub h5_url: String,
    pub feedback_group_url: String,
}

/// 设备在线心跳结果（POST /api/presence）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthPresenceResult {
    pub ok: bool,
    #[specta(type = f64)]
    pub ttl_sec: i64,
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
    /// 最近登出时间（未登出可为空）。
    pub last_logout_at: String,
    pub user_agent: String,
    pub created_at: String,
    pub updated_at: String,
    /// `client` | `assistant`
    pub role: String,
    pub app_id: String,
    /// 平台标识（服务端 `platform`）。
    pub platform: String,
    /// 会话落库状态：`logged_in` | `logged_out`。
    pub login_status: String,
    /// Redis presence TTL 判定的实时在线状态。
    pub online: bool,
    /// 是否已完成同步密钥认证（服务端 `sync_trusted`）。
    #[serde(default)]
    pub sync_trusted: bool,
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

/// `/api/me` 返回的团队成员身份（含默认个人团队 `kind=personal`）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AuthTeamMembership {
    #[specta(type = f64)]
    pub id: i64,
    pub name: String,
    pub creator: String,
    /// `personal`：登录后默认个人团队；`custom`：用户创建的协作团队。
    pub kind: String,
    #[serde(rename = "teamOssKey")]
    pub team_oss_key: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(rename = "roleCode")]
    pub role_code: String,
    #[serde(rename = "userTeamName")]
    pub user_team_name: String,
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
    /// 对应接口字段 `oss_path`；非空时 AI 流式回复经 STS 上传到该 OSS 前缀。
    #[serde(default, rename = "ossPath")]
    pub oss_path: String,
    /// 当前用户所属团队；快照同步写入 `kind=personal` 的默认团队。
    #[serde(default)]
    pub teams: Vec<AuthTeamMembership>,
}

#[derive(Debug, Deserialize)]
struct ApiMeTeamItem {
    id: Option<i64>,
    name: Option<String>,
    creator: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default, alias = "teamOssKey")]
    team_oss_key: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    #[serde(default, alias = "roleCode")]
    role_code: Option<String>,
    #[serde(default, alias = "userTeamName")]
    user_team_name: Option<String>,
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
    #[serde(default, alias = "ossPath")]
    oss_path: Option<String>,
    #[serde(default)]
    teams: Option<Vec<ApiMeTeamItem>>,
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
    last_logout_at: Option<String>,
    user_agent: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    role: Option<String>,
    app_id: Option<String>,
    platform: Option<String>,
    login_status: Option<String>,
    #[serde(default)]
    online: Option<bool>,
    #[serde(default)]
    sync_trusted: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct ApiBindingsQrcodeResponse {
    bind_id: Option<String>,
    qr_payload: Option<String>,
    expire_in_sec: Option<u32>,
    wrap_token: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiPublicQrcodesResponse {
    miniapp_url: Option<String>,
    h5_url: Option<String>,
    feedback_group_url: Option<String>,
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

/// 绑定出码时「按 app_id 找不到本机设备」类错误（服务端文案不完全统一）。
/// 命中后应换下一个候选 X-App-Id 重试，而不是立刻失败。
fn is_binding_device_lookup_miss(message: &str) -> bool {
    let lower = message.to_ascii_lowercase();
    lower.contains("client device not found")
        || lower.contains("ticket not found")
        || lower.contains("device not found")
        || lower.contains("bind ticket not found")
}

fn bindings_api_error(message: String) -> OmniError {
    if is_binding_device_lookup_miss(&message) {
        let user_msg = if message.to_ascii_lowercase().contains("ticket") {
            "绑定凭证无效或本机设备未匹配，请刷新二维码；若仍失败请重新登录后再绑定助手端"
        } else {
            "本机客户端设备未落库或不匹配，请重新登录后再绑定助手端"
        };
        OmniError::new(ErrorCode::Internal, user_msg).with_cause(message)
    } else {
        OmniError::new(ErrorCode::Internal, message)
    }
}

/// 组装绑定出码用的 X-App-Id 候选：优先本机已落库的 app_id，再回退文档约定值。
async fn resolve_binding_app_id_candidates(
    client: &reqwest::Client,
    token: &str,
    identity: &AuthDeviceIdentity,
) -> Vec<String> {
    let mut candidates: Vec<String> = Vec::new();
    let push_unique = |list: &mut Vec<String>, app_id: &str| {
        let trimmed = app_id.trim();
        if trimmed.is_empty() {
            return;
        }
        if !list.iter().any(|item| item == trimmed) {
            list.push(trimmed.to_string());
        }
    };

    let url = auth_url("/api/devices");
    if let Ok(resp) = apply_client_identity_headers(
        client
            .get(&url)
            .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}")),
        identity,
    )
    .send()
    .await
    {
        if let Ok(body) = resp.text().await {
            if let Ok(parsed) = serde_json::from_str::<ApiDeviceListResponse>(&body) {
                for item in parsed.items.unwrap_or_default() {
                    let device_id = item.device_id.as_deref().unwrap_or("").trim();
                    if device_id != identity.device_id {
                        continue;
                    }
                    if let Some(app_id) = item.app_id.as_deref() {
                        push_unique(&mut candidates, app_id);
                    }
                }
            }
        }
    }

    push_unique(&mut candidates, CLIENT_APP_ID);
    push_unique(&mut candidates, CLIENT_APP_ID_FALLBACK);
    candidates
}

/// 微信 showqrcode 的 ticket 必须 UrlEncode，否则含特殊字符时会报 ticket not found。
fn normalize_wechat_qrcode_url(qrcode_url: &str, ticket: &str) -> String {
    let ticket = ticket.trim();
    if ticket.is_empty() {
        return qrcode_url.to_string();
    }
    format!(
        "https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket={}",
        urlencoding_encode(ticket)
    )
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
    let login_status = item
        .login_status
        .map(|s| s.trim().to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "logged_out".to_string());
    AuthDevice {
        id: item.id.unwrap_or(0),
        device_id: item.device_id.unwrap_or_default(),
        device_name: item.device_name.unwrap_or_default(),
        os_type: item.os_type.unwrap_or_default(),
        ip: item.ip.unwrap_or_default(),
        last_login_at: item.last_login_at.unwrap_or_default(),
        last_logout_at: item.last_logout_at.unwrap_or_default(),
        user_agent: item.user_agent.unwrap_or_default(),
        created_at: item.created_at.unwrap_or_default(),
        updated_at: item.updated_at.unwrap_or_default(),
        role,
        app_id: item
            .app_id
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "default".to_string()),
        platform: item.platform.unwrap_or_default(),
        login_status,
        online: item.online.unwrap_or(false),
        sync_trusted: item.sync_trusted.unwrap_or(false),
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
pub async fn auth_device_identity() -> Result<AuthDeviceIdentity, OmniError> {
    load_or_create_device_identity()
}

/// 获取当前用户设备列表。
pub async fn auth_list_devices(
    token: String,
) -> Result<Vec<AuthDevice>, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }

    let proxy_config = proxy_config();
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
        // 服务端对失效 token 常返回 {"error":"ticket not found"}，需归一为会话失效文案。
        return Err(parse_auth_error(&body, "登录已失效，请重新登录"));
    }

    let parsed: ApiDeviceListResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析设备列表失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        // 偶发与绑定同一文案；给设备列表页可读提示
        if is_binding_device_lookup_miss(&error) {
            return Err(OmniError::new(
                ErrorCode::Auth,
                "登录已失效，请重新登录",
            )
            .with_cause(error));
        }
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

/// 删除已授权设备（DELETE /api/devices/{device_id}?app_id=）。
pub async fn auth_delete_device(
    token: String,
    device_id: String,
    app_id: Option<String>,
) -> Result<(), OmniError> {
    let token = token.trim().to_string();
    let device_id = device_id.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    if device_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "device_id 不能为空"));
    }

    let app_id = app_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "default".to_string());

    let proxy_config = proxy_config();
    let identity = load_or_create_device_identity()?;
    let url = auth_url(&format!(
        "/api/devices/{}?app_id={}",
        urlencoding_encode(&device_id),
        urlencoding_encode(&app_id)
    ));
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

    // 成功体形如 { "status": "deleted", "device_id": "xxx", "app_id": "..." }；兼容空响应
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

fn map_api_team(item: ApiMeTeamItem) -> AuthTeamMembership {
    AuthTeamMembership {
        id: item.id.unwrap_or(0),
        name: item.name.unwrap_or_default(),
        creator: item.creator.unwrap_or_default(),
        kind: item.kind.unwrap_or_default(),
        team_oss_key: item.team_oss_key.unwrap_or_default(),
        created_at: item.created_at.unwrap_or_default(),
        updated_at: item.updated_at.unwrap_or_default(),
        role_code: item.role_code.unwrap_or_default(),
        user_team_name: item.user_team_name.unwrap_or_default(),
    }
}

fn map_api_user(parsed: ApiUserResponse) -> AuthUserProfile {
    AuthUserProfile {
        id: parsed.id.unwrap_or(0),
        openid: parsed.openid.unwrap_or_default(),
        nickname: parsed.nickname.unwrap_or_default(),
        avatar_url: parsed.avatar_url.unwrap_or_default(),
        email: parsed.email.unwrap_or_default(),
        github_id: parsed.github_id.unwrap_or_default(),
        oss_path: parsed.oss_path.unwrap_or_default(),
        teams: parsed
            .teams
            .unwrap_or_default()
            .into_iter()
            .map(map_api_team)
            .collect(),
    }
}

/// 快照同步目标：优先 `kind=personal` 的默认团队，否则取列表中第一个有效团队。
pub(crate) fn require_personal_team_id(profile: &AuthUserProfile) -> Result<i64, OmniError> {
    profile
        .teams
        .iter()
        .find(|t| t.kind.eq_ignore_ascii_case("personal") && t.id > 0)
        .or_else(|| profile.teams.iter().find(|t| t.id > 0))
        .map(|t| t.id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "当前账号没有可用团队，无法同步快照"))
}

/// 解析同步目标团队：缺省个人团队；显式 `team_id` 必须存在于 `me.teams`（成员校验）。
pub(crate) fn resolve_sync_team<'a>(
    request_team_id: Option<i64>,
    me: &'a AuthUserProfile,
) -> Result<&'a AuthTeamMembership, OmniError> {
    let id = match request_team_id {
        Some(id) if id > 0 => id,
        _ => require_personal_team_id(me)?,
    };
    me.teams.iter().find(|t| t.id == id).ok_or_else(|| {
        OmniError::new(
            ErrorCode::Auth,
            "无权访问该团队同步数据：你不是该团队成员",
        )
    })
}

/// 同步 blob 端到端密钥材料（内存派生 AES 密钥；不落盘、不上传）。
pub(crate) fn sync_blob_key_material(
    me: &AuthUserProfile,
    team: &AuthTeamMembership,
) -> Result<String, OmniError> {
    if team.kind.eq_ignore_ascii_case("personal") {
        let openid = me.openid.trim();
        if openid.is_empty() {
            return Err(OmniError::new(
                ErrorCode::Auth,
                "账号缺少 openid，无法派生同步密钥",
            ));
        }
        Ok(format!("omnipanel.sync.v1.personal:{openid}"))
    } else {
        let oss = team.team_oss_key.trim();
        if oss.is_empty() {
            return Err(OmniError::new(
                ErrorCode::Auth,
                "团队缺少 OSS 前缀，无法派生同步密钥",
            ));
        }
        Ok(format!(
            "omnipanel.sync.v1.team:{}:{}:omnipanel-client-sync-e2e-v1",
            team.id, oss
        ))
    }
}

/// push：获取或创建团队同步密钥并加密快照（v2）。
pub(crate) fn encrypt_sync_team_payload(
    team_id: i64,
    kind: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, OmniError> {
    let (team_key, _) = omnipanel_store::get_or_create_sync_team_key(team_id)?;
    omnipanel_store::encrypt_sync_team_blob(&team_key, team_id, kind, plaintext).map_err(Into::into)
}

/// pull：v2 优先团队密钥，兼容 v1 openid/team 派生；明文直通。
pub(crate) fn decode_sync_team_payload(
    me: &AuthUserProfile,
    team: &AuthTeamMembership,
    kind: &str,
    body: &[u8],
) -> Result<Vec<u8>, OmniError> {
    let team_key = omnipanel_store::load_sync_team_key(team.id)?;
    let legacy = sync_blob_key_material(me, team).ok();
    omnipanel_store::decode_sync_blob_with_sources(
        team_key.as_ref(),
        team.id,
        legacy.as_deref(),
        kind,
        body,
    )
    .map_err(Into::into)
}

/// 将服务端会话失效类英文文案（如 `ticket not found`）规范为可读中文。
fn normalize_session_error_message(message: &str, fallback: &str) -> String {
    let lower = message.trim().to_ascii_lowercase();
    if lower.is_empty()
        || lower.contains("ticket not found")
        || lower == "unauthorized"
        || lower.contains("invalid token")
        || lower.contains("missing token")
        || lower.contains("session expired")
    {
        return fallback.to_string();
    }
    message.trim().to_string()
}

fn parse_auth_error(body: &str, fallback: &str) -> OmniError {
    let msg = serde_json::from_str::<ApiErrorBody>(body)
        .ok()
        .and_then(|b| b.error)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| fallback.to_string());
    OmniError::new(
        ErrorCode::Auth,
        normalize_session_error_message(&msg, fallback),
    )
}

/// 获取当前用户信息（GET /api/me）。
pub async fn auth_get_me(
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }

    let proxy_config = proxy_config();
    let url = auth_url("/api/me");
    // /api/me 是轻量接口，8s 足够；启动期后台调用，避免网络不通时卡满 30s
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(8)).map_err(
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
pub async fn auth_update_profile(
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

    let proxy_config = proxy_config();
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
pub async fn auth_login_qrcode(
) -> Result<AuthLoginQrcode, OmniError> {
    let identity = load_or_create_device_identity()?;
    let proxy_config = proxy_config();
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

    let ticket = parsed.ticket.unwrap_or_default();
    Ok(AuthLoginQrcode {
        login_id,
        scene: parsed.scene.unwrap_or_default(),
        ticket: ticket.clone(),
        qrcode_url: normalize_wechat_qrcode_url(&qrcode_url, &ticket),
        expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
    })
}

/// 获取侧栏小程序 / H5 公开二维码图片地址。
pub async fn auth_public_qrcodes(
) -> Result<AuthPublicQrcodes, OmniError> {
    let proxy_config = proxy_config();
    let url = auth_url("/api/public/qrcodes");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let resp = client.get(&url).send().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "获取公开二维码失败")
            .with_cause(format_reqwest_error(&e))
    })?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, "读取公开二维码响应失败").with_cause(e.to_string()))?;

    let parsed: ApiPublicQrcodesResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析公开二维码响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("获取公开二维码失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    let miniapp_url = parsed
        .miniapp_url
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "公开二维码响应缺少 miniapp_url"))?;
    let h5_url = parsed
        .h5_url
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "公开二维码响应缺少 h5_url"))?;
    let feedback_group_url = parsed
        .feedback_group_url
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            OmniError::new(ErrorCode::Internal, "公开二维码响应缺少 feedback_group_url")
        })?;

    Ok(AuthPublicQrcodes {
        miniapp_url,
        h5_url,
        feedback_group_url,
    })
}

/// 刷新设备在线 presence（POST /api/presence）。
pub async fn auth_presence(
    token: String,
) -> Result<AuthPresenceResult, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }

    let proxy_config = proxy_config();
    let identity = load_or_create_device_identity()?;
    let url = auth_url("/api/presence");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(20)).map_err(
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
        OmniError::new(ErrorCode::Connection, "刷新在线状态失败")
            .with_cause(format_reqwest_error(&e))
    })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取 presence 响应失败").with_cause(e.to_string())
    })?;

    if status.as_u16() == 401 {
        return Err(parse_auth_error(&body, "登录已失效，请重新登录"));
    }

    #[derive(Debug, Deserialize)]
    struct ApiPresenceResponse {
        ok: Option<bool>,
        ttl_sec: Option<i64>,
        error: Option<String>,
    }

    let parsed: ApiPresenceResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析 presence 响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("刷新在线状态失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    Ok(AuthPresenceResult {
        ok: parsed.ok.unwrap_or(true),
        ttl_sec: parsed.ttl_sec.unwrap_or(180).max(30),
    })
}

/// 登出当前会话（POST /api/logout），服务端会立刻清除 presence。
pub async fn auth_logout(
    token: String,
) -> Result<(), OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Ok(());
    }

    let proxy_config = proxy_config();
    let identity = load_or_create_device_identity()?;
    let url = auth_url("/api/logout");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(15)).map_err(
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
        OmniError::new(ErrorCode::Connection, "登出失败")
            .with_cause(format_reqwest_error(&e))
    })?;

    let status = resp.status();
    // 401 / 已失效：本地照样清会话即可
    if status.as_u16() == 401 || status.is_success() {
        return Ok(());
    }
    let body = resp.text().await.unwrap_or_default();
    Err(OmniError::new(
        ErrorCode::Connection,
        format!("登出失败 (HTTP {status})"),
    )
    .with_cause(body))
}

/// 通过后端代理 SSE，等待扫码登录成功。
pub async fn auth_login_wait(
    login_id: String,
    expire_in_sec: Option<u32>,
) -> Result<AuthLoginSuccess, OmniError> {
    if login_id.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "login_id 不能为空"));
    }

    let proxy_config = proxy_config();
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
pub async fn auth_login_cancel_wait(login_id: String) -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(&login_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// 发送邮箱登录验证码（POST /api/login/email/send）。
pub async fn auth_login_email_send(
    email: String,
) -> Result<AuthEmailCodeSent, OmniError> {
    let email = email.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入有效邮箱"));
    }

    let proxy_config = proxy_config();
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
pub async fn auth_login_email(
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
    let proxy_config = proxy_config();
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
pub async fn auth_login_github(
) -> Result<AuthLoginSuccess, OmniError> {
    let identity = load_or_create_device_identity()?;
    let proxy_config = proxy_config();
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
        open_system_browser(&authorize_url)?;
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

fn open_system_browser(url: &Url) -> Result<(), OmniError> {
    let open_result = open::that(url.as_str());
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
pub async fn auth_account_links(
    token: String,
) -> Result<AuthAccountLinks, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = proxy_config();
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
pub async fn auth_link_wechat_qrcode(
    token: String,
) -> Result<AuthLoginQrcode, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = proxy_config();
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
    let ticket = parsed.ticket.unwrap_or_default();
    Ok(AuthLoginQrcode {
        login_id,
        scene: parsed.scene.unwrap_or_default(),
        ticket: ticket.clone(),
        qrcode_url: normalize_wechat_qrcode_url(&qrcode_url, &ticket),
        expire_in_sec: parsed.expire_in_sec.unwrap_or(300).max(1),
    })
}

/// SSE 等待微信绑定成功（GET /api/account/links/wechat/wait）。
pub async fn auth_link_wechat_wait(
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
    let proxy_config = proxy_config();
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
pub async fn auth_link_wechat_cancel_wait(login_id: String) -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(&login_id) {
        let _ = tx.send(());
    }
    Ok(())
}

/// 发送邮箱绑定验证码。
pub async fn auth_link_email_send(
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
    let proxy_config = proxy_config();
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
pub async fn auth_link_email(
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
    let proxy_config = proxy_config();
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
pub async fn auth_link_github(
    token: String,
) -> Result<(), OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = proxy_config();
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

    open_system_browser(&authorize_url)?;

    let poll_client =
        build_http_client_for_url(&auth_url("/api/account/links"), &proxy_config, Duration::from_secs(30))
            .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))?;

    let cancel_rx = register_cancel(GITHUB_OAUTH_CANCEL_LINK);
    let result = poll_github_link_bound(&poll_client, &token, cancel_rx).await;
    let _ = take_cancel(GITHUB_OAUTH_CANCEL_LINK);
    result
}

/// 取消进行中的 GitHub 绑定等待。
pub async fn auth_link_github_cancel() -> Result<(), OmniError> {
    if let Some(tx) = take_cancel(GITHUB_OAUTH_CANCEL_LINK) {
        let _ = tx.send(());
    }
    Ok(())
}

async fn auth_unlink_path(
    token: String,
    path: &str,
    fail_msg: &str,
) -> Result<AuthUserProfile, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    let proxy_config = proxy_config();
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
pub async fn auth_unlink_wechat(
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    auth_unlink_path(token, "/api/account/links/wechat", "解绑微信失败").await
}

/// 解绑 GitHub（DELETE /api/account/links/github）。
pub async fn auth_unlink_github(
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    auth_unlink_path(token, "/api/account/links/github", "解绑 GitHub 失败").await
}

/// 解绑邮箱（DELETE /api/account/links/email）。
pub async fn auth_unlink_email(
    token: String,
) -> Result<AuthUserProfile, OmniError> {
    auth_unlink_path(token, "/api/account/links/email", "解绑邮箱失败").await
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

/// 申请绑定助手端二维码 payload（客户端本地画码，非微信小程序码）。
pub async fn auth_bindings_qrcode(
    token: String,
) -> Result<AuthBindingsQrcode, OmniError> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }

    let identity = load_or_create_device_identity()?;
    let (assistant_sk, assistant_pk) = omnipanel_store::generate_pairing_keypair()?;
    let proxy_config = proxy_config();
    let url = auth_url("/api/bindings/qrcode");
    let client = build_http_client_for_url(&url, &proxy_config, Duration::from_secs(30)).map_err(
        |e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e),
    )?;

    let app_ids = resolve_binding_app_id_candidates(&client, &token, &identity).await;
    let mut last_not_found: Option<String> = None;
    let request_body = serde_json::json!({ "assistantPubkey": assistant_pk });
    for app_id in app_ids {
        let resp = apply_client_identity_headers_with_app(
            client
                .post(&url)
                .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .json(&request_body),
            &identity,
            &app_id,
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
            if is_binding_device_lookup_miss(&error) {
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
            if is_binding_device_lookup_miss(&msg) {
                last_not_found = Some(msg);
                continue;
            }
            return Err(OmniError::new(ErrorCode::Connection, msg).with_cause(body));
        }

        let bind_id = parsed
            .bind_id
            .filter(|s| !s.is_empty())
            .ok_or_else(|| OmniError::new(ErrorCode::Internal, "绑定二维码响应缺少 bind_id"))?;
        let wrap_token = parsed.wrap_token.filter(|s| !s.is_empty());
        let mut qr_payload = parsed
            .qr_payload
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| bind_id.clone());
        if let Some(wrap_token) = wrap_token.as_deref() {
            let (nonce_b64, enc_sk) =
                omnipanel_store::encrypt_bind_token_wrap(wrap_token, assistant_sk.as_slice())?;
            qr_payload = format!(
                "omni://assistant-bind?v=2&bind_id={}&enc_sk={}&nonce_b64={}",
                urlencoding::encode(&bind_id),
                urlencoding::encode(&enc_sk),
                urlencoding::encode(&nonce_b64),
            );
            let _ = omnipanel_store::store_assistant_binding_pubkey(&bind_id, &assistant_pk);
        }

        remember_binding_app_id(&bind_id, &app_id);
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
pub async fn auth_bindings_wait(
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
    let proxy_config = proxy_config();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binding_lookup_miss_matches_ticket_not_found() {
        assert!(is_binding_device_lookup_miss("ticket not found"));
        assert!(is_binding_device_lookup_miss("Ticket Not Found"));
        assert!(is_binding_device_lookup_miss("client device not found"));
        assert!(!is_binding_device_lookup_miss("missing token"));
    }

    #[test]
    fn normalize_session_error_maps_ticket_not_found() {
        assert_eq!(
            normalize_session_error_message("ticket not found", "登录已失效，请重新登录"),
            "登录已失效，请重新登录"
        );
        assert_eq!(
            normalize_session_error_message("other business error", "登录已失效，请重新登录"),
            "other business error"
        );
    }

    #[test]
    fn normalize_wechat_qrcode_url_encodes_special_chars() {
        let ticket = "abc+/=def";
        let url = normalize_wechat_qrcode_url("https://example.com/ignored", ticket);
        assert!(url.contains("ticket=abc%2B%2F%3Ddef"));
    }
}
