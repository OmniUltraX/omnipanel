//! 客户端团队快照：AI 会话推送/拉取。
//! 写入选定团队 OSS：`ai-conversations/latest.json`（`POST /api/teams/{id}/oss/sts`）。
//! `team_id` 缺省时回退到 `/api/me.teams` 中 `kind=personal` 的默认团队。

use omnipanel_assistant::{
    pull_team_sync_json, push_team_sync_json, validate_conversations_bundle_json,
    TEAM_CONVERSATIONS_LATEST_LEAF,
};
use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::auth_cmds::{auth_device_identity, auth_get_me, require_personal_team_id, AuthUserProfile};
use crate::assistant_cmds::build_auth_context;

/// 解析请求里的可选 `team_id`：有效则用之，否则回退到默认个人团队。
fn resolve_team_id(request_team_id: Option<i64>, me: &AuthUserProfile) -> Result<i64, OmniError> {
    match request_team_id {
        Some(id) if id > 0 => Ok(id),
        _ => require_personal_team_id(me),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPushConversationsRequest {
    pub token: String,
    /// 前端组装的 bundle JSON（含 schemaVersion / conversations / deleted）。
    pub body_json: String,
    /// 可选团队 ID；缺省回退到默认个人团队。
    #[serde(default)]
    pub team_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPushConversationsResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPullConversationsRequest {
    pub token: String,
    /// 可选团队 ID；缺省回退到默认个人团队。
    #[serde(default)]
    pub team_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPullConversationsResult {
    pub found: bool,
    pub object_key: Option<String>,
    pub body_json: Option<String>,
    pub bytes: f64,
}

/// 推送本机 AI 会话快照到选定团队 OSS（`ai-conversations/latest.json`）。
pub async fn client_sync_push_conversations(
    _state: &crate::state::ServerState,
    request: ClientSyncPushConversationsRequest,
) -> Result<ClientSyncPushConversationsResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法同步会话到云端",
        ));
    }
    let body = request.body_json.as_bytes();
    validate_conversations_bundle_json(body)?;

    let identity = auth_device_identity().await?;
    let me = auth_get_me(request.token.clone()).await?;
    let team_id = resolve_team_id(request.team_id, &me)?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;
    let uploaded = push_team_sync_json(&auth, team_id, TEAM_CONVERSATIONS_LATEST_LEAF, body).await?;

    Ok(ClientSyncPushConversationsResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

/// 从选定团队 OSS 拉取 AI 会话快照。
pub async fn client_sync_pull_conversations(
    _state: &crate::state::ServerState,
    request: ClientSyncPullConversationsRequest,
) -> Result<ClientSyncPullConversationsResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法拉取会话同步数据",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(request.token.clone()).await?;
    let team_id = resolve_team_id(request.team_id, &me)?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;

    let Some((object_key, bytes)) =
        pull_team_sync_json(&auth, team_id, TEAM_CONVERSATIONS_LATEST_LEAF).await?
    else {
        return Ok(ClientSyncPullConversationsResult {
            found: false,
            object_key: None,
            body_json: None,
            bytes: 0.0,
        });
    };

    validate_conversations_bundle_json(&bytes)?;
    let body_json = String::from_utf8(bytes.clone()).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "云端会话快照编码无效").with_cause(e.to_string())
    })?;

    Ok(ClientSyncPullConversationsResult {
        found: true,
        object_key: Some(object_key),
        body_json: Some(body_json),
        bytes: bytes.len() as f64,
    })
}
