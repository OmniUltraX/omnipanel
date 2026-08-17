//! 客户端账号级 AI 会话快照推送/拉取。

use omnipanel_assistant::{
    pull_conversations_json, push_conversations_json, validate_conversations_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::auth_cmds::{auth_device_identity, auth_get_me};
use crate::assistant_cmds::build_auth_context;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPushConversationsRequest {
    pub token: String,
    /// 前端组装的 bundle JSON（含 schemaVersion / conversations / deleted）。
    pub body_json: String,
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
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPullConversationsResult {
    pub found: bool,
    pub object_key: Option<String>,
    pub body_json: Option<String>,
    pub bytes: f64,
}

/// 推送本机 AI 会话快照到 `sync/{userId}/ai-conversations/latest.json`。
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
    let auth = build_auth_context(&request.token, &identity.device_id).await?;
    let uploaded = push_conversations_json(&auth, &me.id.to_string(), body).await?;

    Ok(ClientSyncPushConversationsResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

/// 从云端拉取账号 AI 会话快照。
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
    let auth = build_auth_context(&request.token, &identity.device_id).await?;

    let Some((object_key, bytes)) = pull_conversations_json(&auth, &me.id.to_string()).await?
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
