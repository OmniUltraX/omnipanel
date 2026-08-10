//! 客户端 ↔ 客户端：本机设备会话快照推送（数据变更时更新 OSS）。

use omnipanel_assistant::{push_conversations_json, validate_conversations_bundle_json};
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

/// 推送本机 AI 会话快照到 `sync/{userId}/devices/{deviceId}/ai-conversations/latest.json`。
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
    let uploaded =
        push_conversations_json(&auth, &me.id.to_string(), &identity.device_id, body).await?;

    Ok(ClientSyncPushConversationsResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}
