//! 团队管理：经 Tauri 后端代理调用 mp.99.protected.fun 团队 API。

use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::proxy::build_http_client_for_url;
use crate::state::AppState;

const AUTH_API_BASE: &str = "https://mp.99.protected.fun";

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSummary {
    #[specta(type = f64)]
    pub id: i64,
    pub name: String,
    pub creator: String,
    /// `personal` 默认个人团队；`custom` 协作团队。缺省为空以兼容旧接口。
    #[serde(default)]
    pub kind: String,
    pub role_code: String,
    pub user_team_name: String,
    pub team_oss_key: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamCreated {
    #[specta(type = f64)]
    pub id: i64,
    pub name: String,
    pub creator: String,
    pub team_oss_key: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamMember {
    #[specta(type = f64)]
    pub id: i64,
    #[specta(type = f64)]
    pub team_id: i64,
    pub email: String,
    pub role_code: String,
    pub user_team_name: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 管理员生成的一次性 6 位数字邀请码。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamInvite {
    pub code: String,
    /// ISO-8601 过期时间；空表示服务端未返回（仍一次性失效）。
    #[serde(default)]
    pub expires_at: String,
}

#[derive(Debug, Deserialize)]
struct ApiErrorBody {
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiMyTeamListResponse {
    items: Option<Vec<ApiMyTeamItem>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiMyTeamItem {
    id: Option<i64>,
    name: Option<String>,
    creator: Option<String>,
    role_code: Option<String>,
    user_team_name: Option<String>,
    team_oss_key: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiTeamResponse {
    id: Option<i64>,
    name: Option<String>,
    creator: Option<String>,
    team_oss_key: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiTeamMemberListResponse {
    items: Option<Vec<ApiTeamMemberItem>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ApiTeamMemberItem {
    id: Option<i64>,
    team_id: Option<i64>,
    email: Option<String>,
    role_code: Option<String>,
    user_team_name: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
struct ApiTeamCreateBody<'a> {
    name: &'a str,
}

#[derive(Debug, Serialize)]
struct ApiTeamAddMemberBody<'a> {
    email: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    role_code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_team_name: Option<&'a str>,
}

#[derive(Debug, Serialize)]
struct ApiTeamUpdateMemberBody<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    role_code: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_team_name: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct ApiTeamInviteResponse {
    code: Option<serde_json::Value>,
    #[serde(alias = "inviteCode")]
    invite_code: Option<serde_json::Value>,
    #[serde(alias = "expiresAt")]
    expires_at: Option<serde_json::Value>,
    error: Option<String>,
}

#[derive(Debug, Serialize)]
struct ApiTeamJoinBody<'a> {
    code: &'a str,
}

#[derive(Debug, Deserialize)]
struct ApiTeamJoinResponse {
    id: Option<i64>,
    name: Option<String>,
    creator: Option<String>,
    role_code: Option<String>,
    user_team_name: Option<String>,
    team_oss_key: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
    error: Option<String>,
    team: Option<ApiMyTeamItem>,
    item: Option<ApiMyTeamItem>,
}

fn auth_url(path: &str) -> String {
    format!("{}{}", AUTH_API_BASE.trim_end_matches('/'), path)
}

fn format_reqwest_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        return "请求超时".to_string();
    }
    if err.is_connect() {
        return "无法连接服务器".to_string();
    }
    err.to_string()
}

fn normalize_session_error_message(message: &str, fallback: &str) -> String {
    let lower = message.trim().to_ascii_lowercase();
    if lower.is_empty()
        || lower.contains("ticket not found")
        || lower == "unauthorized"
        || lower.contains("missing token")
        || lower.contains("invalid token")
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

fn parse_api_error(body: &str, status: reqwest::StatusCode, fallback: &str) -> OmniError {
    if status.as_u16() == 401 {
        return parse_auth_error(body, "登录已失效，请重新登录");
    }
    let msg = serde_json::from_str::<ApiErrorBody>(body)
        .ok()
        .and_then(|b| b.error)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("{fallback} (HTTP {status})"));
    OmniError::new(ErrorCode::Internal, msg).with_cause(body.to_string())
}

fn require_token(token: &str) -> Result<String, OmniError> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    Ok(trimmed)
}

fn normalize_email(email: &str) -> Result<String, OmniError> {
    let email = email.trim().to_string();
    if email.is_empty() || !email.contains('@') {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请输入有效邮箱"));
    }
    Ok(email)
}

fn digits_from_json(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.chars().filter(|c| c.is_ascii_digit()).collect(),
        Some(serde_json::Value::Number(n)) => n
            .to_string()
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect(),
        _ => String::new(),
    }
}

fn json_to_expires_at(value: Option<&serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn normalize_invite_code(code: &str) -> Result<String, OmniError> {
    let digits: String = code.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() != 6 {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "请输入 6 位数字邀请码",
        ));
    }
    Ok(digits)
}

fn map_team_summary(item: ApiMyTeamItem) -> TeamSummary {
    TeamSummary {
        id: item.id.unwrap_or(0),
        name: item.name.unwrap_or_default(),
        creator: item.creator.unwrap_or_default(),
        kind: item.kind.unwrap_or_default(),
        role_code: item.role_code.unwrap_or_default(),
        user_team_name: item.user_team_name.unwrap_or_default(),
        team_oss_key: item.team_oss_key.unwrap_or_default(),
        created_at: item.created_at.unwrap_or_default(),
        updated_at: item.updated_at.unwrap_or_default(),
    }
}

fn map_team_created(item: ApiTeamResponse) -> TeamCreated {
    TeamCreated {
        id: item.id.unwrap_or(0),
        name: item.name.unwrap_or_default(),
        creator: item.creator.unwrap_or_default(),
        team_oss_key: item.team_oss_key.unwrap_or_default(),
        created_at: item.created_at.unwrap_or_default(),
        updated_at: item.updated_at.unwrap_or_default(),
    }
}

fn map_team_member(item: ApiTeamMemberItem) -> TeamMember {
    TeamMember {
        id: item.id.unwrap_or(0),
        team_id: item.team_id.unwrap_or(0),
        email: item.email.unwrap_or_default(),
        role_code: item.role_code.unwrap_or_default(),
        user_team_name: item.user_team_name.unwrap_or_default(),
        created_at: item.created_at.unwrap_or_default(),
        updated_at: item.updated_at.unwrap_or_default(),
    }
}

async fn build_auth_client(
    state: &State<'_, AppState>,
    url: &str,
) -> Result<reqwest::Client, OmniError> {
    let proxy_config = state.proxy_config.lock().await.clone();
    build_http_client_for_url(url, &proxy_config, Duration::from_secs(30))
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))
}

/// 当前用户加入的团队列表（GET /api/teams）。
#[tauri::command]
#[specta::specta]
pub async fn team_list(
    state: State<'_, AppState>,
    token: String,
) -> Result<Vec<TeamSummary>, OmniError> {
    let token = require_token(&token)?;
    let url = auth_url("/api/teams");
    let client = build_auth_client(&state, &url).await?;

    let resp = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取团队列表失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取团队列表响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "获取团队列表失败"));
    }

    let parsed: ApiMyTeamListResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析团队列表失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }

    Ok(parsed
        .items
        .unwrap_or_default()
        .into_iter()
        .map(map_team_summary)
        .collect())
}

/// 创建团队（POST /api/teams）。
#[tauri::command]
#[specta::specta]
pub async fn team_create(
    state: State<'_, AppState>,
    token: String,
    name: String,
) -> Result<TeamCreated, OmniError> {
    let token = require_token(&token)?;
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队名称不能为空"));
    }

    let url = auth_url("/api/teams");
    let client = build_auth_client(&state, &url).await?;
    let payload = ApiTeamCreateBody { name: &name };

    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "创建团队失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取创建团队响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "创建团队失败"));
    }

    let parsed: ApiTeamResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析创建团队响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.as_ref().filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error.clone()));
    }

    Ok(map_team_created(parsed))
}

/// 解散团队（DELETE /api/teams/{team_id}，仅 creator）。
#[tauri::command]
#[specta::specta]
pub async fn team_dissolve(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
) -> Result<(), OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }

    let url = auth_url(&format!("/api/teams/{team_id}"));
    let client = build_auth_client(&state, &url).await?;

    let resp = client
        .delete(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "解散团队失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取解散团队响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "解散团队失败"));
    }

    Ok(())
}

/// 团队成员列表（GET /api/teams/{team_id}/members）。
#[tauri::command]
#[specta::specta]
pub async fn team_list_members(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
) -> Result<Vec<TeamMember>, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }

    let url = auth_url(&format!("/api/teams/{team_id}/members"));
    let client = build_auth_client(&state, &url).await?;

    let resp = client
        .get(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "获取团队成员失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取团队成员响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "获取团队成员失败"));
    }

    let parsed: ApiTeamMemberListResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析团队成员失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }

    Ok(parsed
        .items
        .unwrap_or_default()
        .into_iter()
        .map(map_team_member)
        .collect())
}

/// 添加团队成员（POST /api/teams/{team_id}/members，按邮箱匹配已注册用户）。
#[tauri::command]
#[specta::specta]
pub async fn team_add_member(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
    email: String,
    role_code: Option<String>,
    user_team_name: Option<String>,
) -> Result<TeamMember, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }
    let email = normalize_email(&email)?;
    let role_code = role_code
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let user_team_name = user_team_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let url = auth_url(&format!("/api/teams/{team_id}/members"));
    let client = build_auth_client(&state, &url).await?;
    let payload = ApiTeamAddMemberBody {
        email: &email,
        role_code: role_code.as_deref(),
        user_team_name: user_team_name.as_deref(),
    };

    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "添加团队成员失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取添加成员响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "添加团队成员失败"));
    }

    let parsed: ApiTeamMemberItem = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析添加成员响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    Ok(map_team_member(parsed))
}

/// 更新团队成员（PATCH /api/teams/{team_id}/members/{email}）。
#[tauri::command]
#[specta::specta]
pub async fn team_update_member(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
    email: String,
    role_code: Option<String>,
    user_team_name: Option<String>,
) -> Result<TeamMember, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }
    let email = normalize_email(&email)?;
    let role_code = role_code
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let user_team_name = user_team_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let encoded_email = urlencoding::encode(&email);
    let url = auth_url(&format!("/api/teams/{team_id}/members/{encoded_email}"));
    let client = build_auth_client(&state, &url).await?;
    let payload = ApiTeamUpdateMemberBody {
        role_code: role_code.as_deref(),
        user_team_name: user_team_name.as_deref(),
    };

    let resp = client
        .patch(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "更新团队成员失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取更新成员响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "更新团队成员失败"));
    }

    let parsed: ApiTeamMemberItem = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析更新成员响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    Ok(map_team_member(parsed))
}

/// 移除团队成员（DELETE /api/teams/{team_id}/members/{email}）。
#[tauri::command]
#[specta::specta]
pub async fn team_remove_member(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
    email: String,
) -> Result<(), OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }
    let email = normalize_email(&email)?;

    let encoded_email = urlencoding::encode(&email);
    let url = auth_url(&format!("/api/teams/{team_id}/members/{encoded_email}"));
    let client = build_auth_client(&state, &url).await?;

    let resp = client
        .delete(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "移除团队成员失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取移除成员响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "移除团队成员失败"));
    }

    Ok(())
}

/// 生成一次性 6 位数字邀请码（POST /api/teams/{team_id}/invites，仅 creator/manager）。
/// 同一团队再次生成会使尚未使用的旧码失效；兑换成功后立即作废。
#[tauri::command]
#[specta::specta]
pub async fn team_create_invite(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
) -> Result<TeamInvite, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }

    let url = auth_url(&format!("/api/teams/{team_id}/invites"));
    let client = build_auth_client(&state, &url).await?;

    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "生成邀请码失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取邀请码响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "生成邀请码失败"));
    }

    let parsed: ApiTeamInviteResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析邀请码响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }

    let raw = digits_from_json(parsed.code.as_ref());
    let code = if raw.len() == 6 {
        raw
    } else {
        digits_from_json(parsed.invite_code.as_ref())
    };
    if code.len() != 6 {
        return Err(OmniError::new(ErrorCode::Internal, "邀请码响应无效")
            .with_cause(body));
    }

    let expires_at = json_to_expires_at(parsed.expires_at.as_ref());

    Ok(TeamInvite { code, expires_at })
}

/// 凭邀请码加入团队（POST /api/teams/join）。码被使用后立即失效。
#[tauri::command]
#[specta::specta]
pub async fn team_join_by_invite(
    state: State<'_, AppState>,
    token: String,
    code: String,
) -> Result<TeamSummary, OmniError> {
    let token = require_token(&token)?;
    let code = normalize_invite_code(&code)?;

    let url = auth_url("/api/teams/join");
    let client = build_auth_client(&state, &url).await?;
    let payload = ApiTeamJoinBody { code: &code };

    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .json(&payload)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "加入团队失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取加入团队响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        return Err(parse_api_error(&body, status, "加入团队失败"));
    }

    let parsed: ApiTeamJoinResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析加入团队响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;

    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Internal, error));
    }

    let nested = parsed.team.or(parsed.item);
    Ok(TeamSummary {
        id: parsed.id.or_else(|| nested.as_ref().and_then(|t| t.id)).unwrap_or(0),
        name: parsed
            .name
            .or_else(|| nested.as_ref().and_then(|t| t.name.clone()))
            .unwrap_or_default(),
        creator: parsed
            .creator
            .or_else(|| nested.as_ref().and_then(|t| t.creator.clone()))
            .unwrap_or_default(),
        kind: parsed
            .kind
            .or_else(|| nested.as_ref().and_then(|t| t.kind.clone()))
            .unwrap_or_default(),
        role_code: parsed
            .role_code
            .or_else(|| nested.as_ref().and_then(|t| t.role_code.clone()))
            .unwrap_or_default(),
        user_team_name: parsed
            .user_team_name
            .or_else(|| nested.as_ref().and_then(|t| t.user_team_name.clone()))
            .unwrap_or_default(),
        team_oss_key: parsed
            .team_oss_key
            .or_else(|| nested.as_ref().and_then(|t| t.team_oss_key.clone()))
            .unwrap_or_default(),
        created_at: parsed
            .created_at
            .or_else(|| nested.as_ref().and_then(|t| t.created_at.clone()))
            .unwrap_or_default(),
        updated_at: parsed
            .updated_at
            .or_else(|| nested.as_ref().and_then(|t| t.updated_at.clone()))
            .unwrap_or_default(),
    })
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamMeshAuth {
    pub auth_key: String,
    pub control_server_url: String,
    pub hostname: String,
    pub listen_port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiTeamMeshAuthResponse {
    auth_key: Option<String>,
    control_server_url: Option<String>,
    hostname: Option<String>,
    listen_port: Option<u16>,
    error: Option<String>,
    code: Option<String>,
}

/// 向 omniserver 申请当前团队的 Headscale preauth key。
#[tauri::command]
#[specta::specta]
pub async fn team_mesh_auth_key(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
) -> Result<TeamMeshAuth, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }

    let url = auth_url(&format!("/api/teams/{team_id}/mesh/auth-key"));
    let client = build_auth_client(&state, &url).await?;
    let identity = crate::commands::auth::auth_device_identity().await?;

    let resp = client
        .post(&url)
        .header(reqwest::header::AUTHORIZATION, format!("Bearer {token}"))
        .header("X-App-Id", "omni-client")
        .header("X-Device-Id", identity.device_id)
        .json(&serde_json::json!({}))
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "申请 mesh 入网凭证失败")
                .with_cause(format_reqwest_error(&e))
        })?;

    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取 mesh 凭证响应失败").with_cause(e.to_string())
    })?;

    if !status.is_success() {
        let parsed: Result<ApiTeamMeshAuthResponse, _> = serde_json::from_str(&body);
        if status.as_u16() == 503
            || parsed
                .as_ref()
                .ok()
                .and_then(|p| p.code.as_deref())
                .is_some_and(|c| c.eq_ignore_ascii_case("mesh_unavailable"))
        {
            return Err(OmniError::new(ErrorCode::Connection, "团队 mesh 暂不可用")
                .with_cause(body));
        }
        return Err(parse_api_error(&body, status, "申请 mesh 入网凭证失败"));
    }

    let parsed: ApiTeamMeshAuthResponse = serde_json::from_str(&body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析 mesh 凭证响应失败")
            .with_cause(format!("{e}; body={body}"))
    })?;
    if let Some(error) = parsed.error.filter(|s| !s.is_empty()) {
        return Err(OmniError::new(ErrorCode::Connection, error));
    }
    let auth_key = parsed.auth_key.unwrap_or_default().trim().to_string();
    let control_server_url = parsed
        .control_server_url
        .unwrap_or_default()
        .trim()
        .to_string();
    let hostname = parsed.hostname.unwrap_or_default().trim().to_string();
    if auth_key.is_empty() || control_server_url.is_empty() {
        return Err(OmniError::new(ErrorCode::Internal, "mesh 凭证响应不完整")
            .with_cause(body));
    }
    Ok(TeamMeshAuth {
        auth_key,
        control_server_url,
        hostname,
        listen_port: parsed.listen_port.unwrap_or(42424),
    })
}
