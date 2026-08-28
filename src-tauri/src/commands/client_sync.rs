//! 客户端团队快照：AI 会话推送/拉取。
//! 写入选定团队 OSS：`ai-conversations/latest.json`（`POST /api/teams/{id}/oss/sts`）。
//! `team_id` 缺省时回退到 `/api/me.teams` 中 `kind=personal` 的默认团队。
//! 上传前整包端到端加密；拉取时解密（兼容历史明文）。

use omnipanel_assistant::{
    TEAM_CONVERSATIONS_LATEST_LEAF, pull_team_sync_json, push_team_sync_json,
    validate_conversations_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::SYNC_KIND_CONVERSATIONS;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::assistant::build_auth_context;
use crate::commands::auth::{
    auth_device_identity, auth_get_me, decode_sync_team_payload, encrypt_sync_team_payload,
    resolve_sync_team,
};
use crate::state::AppState;

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
#[tauri::command]
#[specta::specta]
pub async fn client_sync_push_conversations(
    state: State<'_, AppState>,
    request: ClientSyncPushConversationsRequest,
) -> Result<ClientSyncPushConversationsResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法同步会话到云端",
        ));
    }
    let plaintext = request.body_json.as_bytes();
    validate_conversations_bundle_json(plaintext)?;

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), request.token.clone()).await?;
    let team = resolve_sync_team(request.team_id, &me)?;
    let team_id = team.id;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;
    let body = encrypt_sync_team_payload(team_id, SYNC_KIND_CONVERSATIONS, plaintext)?;
    let uploaded =
        push_team_sync_json(&auth, team.id, TEAM_CONVERSATIONS_LATEST_LEAF, &body).await?;

    Ok(ClientSyncPushConversationsResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

/// 从选定团队 OSS 拉取 AI 会话快照。
#[tauri::command]
#[specta::specta]
pub async fn client_sync_pull_conversations(
    state: State<'_, AppState>,
    request: ClientSyncPullConversationsRequest,
) -> Result<ClientSyncPullConversationsResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法拉取会话同步数据",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), request.token.clone()).await?;
    let team = resolve_sync_team(request.team_id, &me)?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;

    let Some((object_key, bytes)) =
        pull_team_sync_json(&auth, team.id, TEAM_CONVERSATIONS_LATEST_LEAF).await?
    else {
        return Ok(ClientSyncPullConversationsResult {
            found: false,
            object_key: None,
            body_json: None,
            bytes: 0.0,
        });
    };

    let plaintext = decode_sync_team_payload(&me, team, SYNC_KIND_CONVERSATIONS, &bytes)?;
    validate_conversations_bundle_json(&plaintext)?;
    let body_json = String::from_utf8(plaintext).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "云端会话快照编码无效").with_cause(e.to_string())
    })?;

    Ok(ClientSyncPullConversationsResult {
        found: true,
        object_key: Some(object_key),
        body_json: Some(body_json),
        bytes: bytes.len() as f64,
    })
}
