//! 客户端 ↔ 客户端（同账号）同步：与助手端快照路径完全独立。

use omnipanel_assistant::{
    pull_conversations_json, push_conversations_json, validate_conversations_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::auth::{auth_device_identity, auth_get_me};
use crate::commands::assistant::build_auth_context;
use crate::state::AppState;

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
    pub object_key: String,
    pub body_json: Option<String>,
}

/// 推送 AI 会话同步 blob 到 `sync/{userId}/v1/ai-conversations/latest.json`。
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
    let body = request.body_json.as_bytes();
    validate_conversations_bundle_json(body)?;

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), request.token.clone()).await?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;
    let uploaded = push_conversations_json(&auth, &me.id.to_string(), body).await?;

    Ok(ClientSyncPushConversationsResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

/// 拉取账号级 AI 会话同步 blob；尚无对象时 `found=false`。
#[tauri::command]
#[specta::specta]
pub async fn client_sync_pull_conversations(
    state: State<'_, AppState>,
    request: ClientSyncPullConversationsRequest,
) -> Result<ClientSyncPullConversationsResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法拉取云端会话",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), request.token.clone()).await?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;
    let pulled = pull_conversations_json(&auth, &me.id.to_string()).await?;

    match pulled {
        Some((object_key, bytes)) => {
            validate_conversations_bundle_json(&bytes)?;
            let body_json = String::from_utf8(bytes).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "云端会话 JSON 不是合法 UTF-8")
                    .with_cause(e.to_string())
            })?;
            Ok(ClientSyncPullConversationsResult {
                found: true,
                object_key,
                body_json: Some(body_json),
            })
        }
        None => Ok(ClientSyncPullConversationsResult {
            found: false,
            object_key: omnipanel_assistant::conversations_latest_object_key(&me.id.to_string()),
            body_json: None,
        }),
    }
}
