//! 团队 OSS 数据同步：分享自定义面板、团队模块快照等。

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;
use omnipanel_assistant::{
    load_team_share_index, notify_team_share_created, pull_team_sync_json, push_team_sync_json,
    save_team_share_index, team_share_item_key, validate_team_share_bundle_json, TeamShareIndexItem,
    TEAM_SYNC_SCHEMA_VERSION,
};
use omnipanel_assistant::validate_modules_bundle_json;
use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use specta::Type;
use tauri::State;

use crate::commands::assistant::build_auth_context;
use crate::commands::auth::{auth_device_identity, auth_get_me};
use crate::commands::client_sync_modules::{
    collect_local_bundle, ClientSyncPushModulesRequest,
};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamShareTarget {
    #[specta(type = f64)]
    pub team_id: i64,
    pub union_id: String,
    pub display_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharePushRequest {
    pub token: String,
    pub snapshot_json: String,
    pub targets: Vec<TeamShareTarget>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSharePushResult {
    pub share_count: f64,
    pub object_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamShareSummary {
    pub share_id: String,
    pub object_key: String,
    #[specta(type = f64)]
    pub team_id: f64,
    pub from_union_id: String,
    pub from_display_name: String,
    pub panel_label: String,
    pub created_at: String,
    pub recipient_union_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPushModulesRequest {
    pub token: String,
    #[specta(type = f64)]
    pub team_id: i64,
    #[serde(default)]
    pub workspaces_json: Option<String>,
    #[serde(default)]
    pub deleted_connections: Vec<crate::commands::client_sync_modules::ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_databases: Vec<crate::commands::client_sync_modules::ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_knowledge: Vec<crate::commands::client_sync_modules::ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_requests: Vec<crate::commands::client_sync_modules::ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_collections: Vec<crate::commands::client_sync_modules::ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_environments: Vec<crate::commands::client_sync_modules::ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_workspaces: Vec<crate::commands::client_sync_modules::ClientSyncTombstone>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPushModulesResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: f64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPullModulesResult {
    pub object_key: String,
    pub body_json: String,
    pub bytes: f64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncFetchShareResult {
    pub object_key: String,
    pub body_json: String,
}

fn unique_share_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{millis:x}-{:x}", std::process::id())
}

fn panel_label_from_snapshot(snapshot: &Value) -> String {
    snapshot
        .get("label")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Custom Panel")
        .to_string()
}

fn require_token(token: &str) -> Result<String, OmniError> {
    let trimmed = token.trim().to_string();
    if trimmed.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少登录凭证"));
    }
    Ok(trimmed)
}

fn to_modules_push_request(request: &TeamSyncPushModulesRequest) -> ClientSyncPushModulesRequest {
    ClientSyncPushModulesRequest {
        token: request.token.clone(),
        workspaces_json: request.workspaces_json.clone(),
        deleted_connections: request.deleted_connections.clone(),
        deleted_databases: request.deleted_databases.clone(),
        deleted_knowledge: request.deleted_knowledge.clone(),
        deleted_http_requests: request.deleted_http_requests.clone(),
        deleted_http_collections: request.deleted_http_collections.clone(),
        deleted_http_environments: request.deleted_http_environments.clone(),
        deleted_workspaces: request.deleted_workspaces.clone(),
    }
}

/// 将自定义面板分享给团队成员（写入团队 OSS + 更新索引 + 通知）。
#[tauri::command]
#[specta::specta]
pub async fn team_share_push(
    state: State<'_, AppState>,
    request: TeamSharePushRequest,
) -> Result<TeamSharePushResult, OmniError> {
    let token = require_token(&request.token)?;
    if request.targets.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "请选择分享对象"));
    }
    let snapshot: Value = serde_json::from_str(&request.snapshot_json).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "分享快照 JSON 无效").with_cause(e.to_string())
    })?;
    let panel_label = panel_label_from_snapshot(&snapshot);

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), token.clone()).await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let from_union_id = me.openid.trim().to_string();
    if from_union_id.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "缺少用户 UnionID"));
    }
    let from_display_name = me.nickname.trim().to_string();

    let mut grouped: HashMap<i64, Vec<TeamShareTarget>> = HashMap::new();
    for target in request.targets {
        if target.team_id <= 0 || target.union_id.trim().is_empty() {
            continue;
        }
        grouped.entry(target.team_id).or_default().push(target);
    }
    if grouped.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "分享对象无效"));
    }

    let created_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let mut object_keys = Vec::new();

    for (team_id, targets) in grouped {
        let share_id = unique_share_id();
        let leaf = team_share_item_key(&share_id);
        let recipient_union_ids: Vec<String> = targets
            .iter()
            .map(|t| t.union_id.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();
        let recipients: Vec<Value> = targets
            .iter()
            .map(|t| {
                json!({
                    "teamId": t.team_id,
                    "unionId": t.union_id,
                    "displayName": t.display_name,
                })
            })
            .collect();

        let envelope = json!({
            "schemaVersion": TEAM_SYNC_SCHEMA_VERSION,
            "kind": "team-custom-panel-share",
            "shareId": share_id,
            "teamId": team_id,
            "fromUnionId": from_union_id,
            "fromDisplayName": from_display_name,
            "createdAt": created_at,
            "recipients": recipients,
            "snapshot": snapshot,
        });
        let body = serde_json::to_vec(&envelope).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "序列化团队分享失败").with_cause(e.to_string())
        })?;
        validate_team_share_bundle_json(&body)?;
        let uploaded = push_team_sync_json(&auth, team_id, &leaf, &body).await?;

        let mut index = load_team_share_index(&auth, team_id).await?;
        index.updated_at = created_at.clone();
        index.items.push(TeamShareIndexItem {
            share_id: share_id.clone(),
            object_key: uploaded.object_key.clone(),
            from_union_id: from_union_id.clone(),
            from_display_name: from_display_name.clone(),
            panel_label: panel_label.clone(),
            created_at: created_at.clone(),
            recipient_union_ids: recipient_union_ids.clone(),
        });
        save_team_share_index(&auth, team_id, &index).await?;

        if let Err(e) = notify_team_share_created(
            &auth,
            team_id,
            &share_id,
            &uploaded.object_key,
            &recipient_union_ids,
        )
        .await
        {
            tracing::warn!(team_id, share_id = %share_id, error = %e, "team share notify failed");
        }

        object_keys.push(uploaded.object_key);
    }

    Ok(TeamSharePushResult {
        share_count: object_keys.len() as f64,
        object_keys,
    })
}

/// 列出团队 OSS 中的自定义面板分享索引。
#[tauri::command]
#[specta::specta]
pub async fn team_sync_list_shares(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
) -> Result<Vec<TeamShareSummary>, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let index = load_team_share_index(&auth, team_id).await?;

    Ok(index
        .items
        .into_iter()
        .map(|item| TeamShareSummary {
            share_id: item.share_id,
            object_key: item.object_key,
            team_id: team_id as f64,
            from_union_id: item.from_union_id,
            from_display_name: item.from_display_name,
            panel_label: item.panel_label,
            created_at: item.created_at,
            recipient_union_ids: item.recipient_union_ids,
        })
        .collect())
}

/// 拉取团队 OSS 中指定分享的完整 JSON。
#[tauri::command]
#[specta::specta]
pub async fn team_sync_fetch_share(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
    share_id: String,
) -> Result<TeamSyncFetchShareResult, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }
    let share_id = share_id.trim().to_string();
    if share_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "分享 ID 无效"));
    }

    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let leaf = team_share_item_key(&share_id);
    let pulled = pull_team_sync_json(&auth, team_id, &leaf).await?;
    let Some((object_key, body)) = pulled else {
        return Err(OmniError::new(ErrorCode::NotFound, "分享不存在或已被删除"));
    };
    validate_team_share_bundle_json(&body)?;
    let body_json = String::from_utf8(body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "分享内容编码无效").with_cause(e.to_string())
    })?;
    Ok(TeamSyncFetchShareResult {
        object_key,
        body_json,
    })
}

/// 推送本机模块快照到团队 OSS（`modules/latest.json`）。
#[tauri::command]
#[specta::specta]
pub async fn team_sync_push_modules(
    state: State<'_, AppState>,
    request: TeamSyncPushModulesRequest,
) -> Result<TeamSyncPushModulesResult, OmniError> {
    let token = require_token(&request.token)?;
    if request.team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }

    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let modules_request = to_modules_push_request(&request);
    let bundle = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &modules_request)?
    };
    let body = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化团队模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&body)?;

    let uploaded = push_team_sync_json(&auth, request.team_id, "modules/latest.json", &body).await?;

    Ok(TeamSyncPushModulesResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

/// 从团队 OSS 拉取模块快照（`modules/latest.json`）。
#[tauri::command]
#[specta::specta]
pub async fn team_sync_pull_modules(
    state: State<'_, AppState>,
    token: String,
    team_id: i64,
) -> Result<TeamSyncPullModulesResult, OmniError> {
    let token = require_token(&token)?;
    if team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }

    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let pulled = pull_team_sync_json(&auth, team_id, "modules/latest.json").await?;
    let Some((object_key, body)) = pulled else {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            "团队尚未上传模块同步数据",
        ));
    };
    validate_modules_bundle_json(&body)?;
    let bytes = body.len() as f64;
    let body_json = String::from_utf8(body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "团队模块同步内容编码无效").with_cause(e.to_string())
    })?;
    Ok(TeamSyncPullModulesResult {
        object_key,
        body_json,
        bytes,
    })
}
