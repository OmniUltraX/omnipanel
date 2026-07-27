//! 助手端同步：采集本机脱敏元数据并上传 OSS。

use omnipanel_assistant::{
    fetch_oss_sts, push_snapshot, sanitize_connection_meta, sanitize_db_connection_meta,
    sanitize_http_request_meta, sanitize_knowledge_meta, sanitize_task_meta, upload_object_bytes,
    AuthContext, CollectContext, OssUploadResult, PushOptions, PushSnapshotResult,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{load_database_connections, ConnectionKind};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tauri::State;

use crate::commands::auth::{auth_device_identity, auth_get_me};
use crate::commands::proxy::build_http_client_for_url;
use crate::state::AppState;

const AUTH_API_BASE: &str = "https://mp.99.protected.fun";
const CLIENT_APP_ID: &str = "omni-client";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPushRequest {
    pub token: String,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub bind_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantUploadTextRequest {
    pub token: String,
    /// OSS object key，如 `omniminiapp/agent_chat_message/.../0.txt`（会去掉桶名前缀）。
    pub object_key: String,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantUploadTextResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: f64,
}

/// 推送客户端元数据快照到 OSS（`dry_run=true` 时只组装不上传）。
#[tauri::command]
#[specta::specta]
pub async fn assistant_push_snapshot(
    state: State<'_, AppState>,
    request: AssistantPushRequest,
) -> Result<PushSnapshotResult, OmniError> {
    if request.token.trim().is_empty() && !request.dry_run {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法同步到助手端",
        ));
    }

    let identity = auth_device_identity().await?;
    let user_id = if request.token.trim().is_empty() {
        None
    } else {
        auth_get_me(state.clone(), request.token.clone())
            .await
            .ok()
            .map(|me| me.id.to_string())
    };

    let ctx = build_collect_context(&state, &identity.device_id, user_id, request.bind_id).await?;

    if request.dry_run {
        return push_snapshot(
            ctx,
            None,
            PushOptions {
                dry_run: true,
                object_key_override: None,
            },
        )
        .await;
    }

    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;

    push_snapshot(
        ctx,
        Some(&auth),
        PushOptions {
            dry_run: false,
            object_key_override: None,
        },
    )
    .await
}

/// 使用现有助手 STS，将文本写入 OSS（聊天记录分片等）。
#[tauri::command]
#[specta::specta]
pub async fn assistant_upload_oss_text(
    state: State<'_, AppState>,
    request: AssistantUploadTextRequest,
) -> Result<AssistantUploadTextResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法上传到 OSS",
        ));
    }
    if request.object_key.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "object_key 不能为空",
        ));
    }

    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;
    let sts = fetch_oss_sts(&auth).await?;
    let uploaded: OssUploadResult = upload_object_bytes(
        &auth.http,
        &sts,
        &request.object_key,
        request.contents.as_bytes(),
        "text/plain; charset=utf-8",
    )
    .await?;

    Ok(AssistantUploadTextResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

async fn build_auth_context(
    state: &State<'_, AppState>,
    token: &str,
    device_id: &str,
) -> Result<AuthContext, OmniError> {
    let proxy_config = state.proxy_config.lock().await.clone();
    let http = build_http_client_for_url(AUTH_API_BASE, &proxy_config, Duration::from_secs(30))
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))?;

    Ok(AuthContext {
        api_base: AUTH_API_BASE.to_string(),
        access_token: token.to_string(),
        app_id: CLIENT_APP_ID.to_string(),
        device_id: device_id.to_string(),
        device_public_key: String::new(),
        http,
    })
}

fn enum_wire_str<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

async fn build_collect_context(
    state: &State<'_, AppState>,
    client_device_id: &str,
    user_id: Option<String>,
    bind_id: Option<String>,
) -> Result<CollectContext, OmniError> {
    let storage = state.storage.lock().await;

    let ssh = storage.list_connections_by_kind(ConnectionKind::Ssh)?;
    let docker = storage.list_connections_by_kind(ConnectionKind::Docker)?;
    let files = storage.list_connections_by_kind(ConnectionKind::File)?;
    let panels = storage.list_connections_by_kind(ConnectionKind::Panel)?;
    let knowledge = storage.list_knowledge(None, None)?;
    let http_requests = storage.http_list_requests(None)?;
    let tasks = storage.task_list(None, 5)?;

    drop(storage);

    let db_connections = load_database_connections().unwrap_or_default();

    let mut docker_instances: Vec<_> = docker
        .iter()
        .map(|c| {
            sanitize_connection_meta(
                &c.id,
                c.kind.as_str(),
                &c.name,
                &c.group,
                &c.env_tag,
                &c.tags,
                &c.config,
            )
        })
        .collect();
    if !docker_instances
        .iter()
        .any(|v| v.get("id").and_then(|x| x.as_str()) == Some("__local__"))
    {
        docker_instances.insert(
            0,
            serde_json::json!({
                "id": "__local__",
                "kind": "docker",
                "name": "Local Docker",
                "group": "",
                "envTag": "dev",
                "tags": [],
                "config": { "source": "local" }
            }),
        );
    }

    let mut file_connections: Vec<_> = files
        .iter()
        .map(|c| {
            sanitize_connection_meta(
                &c.id,
                c.kind.as_str(),
                &c.name,
                &c.group,
                &c.env_tag,
                &c.tags,
                &c.config,
            )
        })
        .collect();
    if !file_connections
        .iter()
        .any(|v| v.get("id").and_then(|x| x.as_str()) == Some("__local__"))
    {
        file_connections.insert(
            0,
            serde_json::json!({
                "id": "__local__",
                "kind": "file",
                "name": "本机文件",
                "group": "",
                "envTag": "dev",
                "tags": [],
                "config": { "protocol": "local" }
            }),
        );
    }

    Ok(CollectContext {
        client_device_id: client_device_id.to_string(),
        bind_id,
        user_id,
        terminal_hosts: ssh
            .iter()
            .map(|c| {
                sanitize_connection_meta(
                    &c.id,
                    c.kind.as_str(),
                    &c.name,
                    &c.group,
                    &c.env_tag,
                    &c.tags,
                    &c.config,
                )
            })
            .collect(),
        database_connections: db_connections
            .iter()
            .map(|c| {
                sanitize_db_connection_meta(
                    &c.id,
                    &c.name,
                    &c.db_type,
                    &c.host,
                    c.port,
                    &c.user,
                    &c.database,
                    c.ssl,
                    &c.status,
                    c.enabled,
                )
            })
            .collect(),
        docker_instances,
        file_connections,
        server_panels: panels
            .iter()
            .map(|c| {
                sanitize_connection_meta(
                    &c.id,
                    c.kind.as_str(),
                    &c.name,
                    &c.group,
                    &c.env_tag,
                    &c.tags,
                    &c.config,
                )
            })
            .collect(),
        knowledge_documents: knowledge
            .iter()
            .map(|e| {
                sanitize_knowledge_meta(
                    &e.id,
                    &e.kind,
                    &e.title,
                    &e.tags,
                    &e.risk_level,
                    &e.source,
                    &e.env_tag,
                    &e.language,
                    &e.node_type,
                    &e.parent_id,
                    &e.resource_type,
                    &e.resource_id,
                    e.updated_at,
                )
            })
            .collect(),
        protocol_requests: http_requests
            .iter()
            .map(|r| {
                sanitize_http_request_meta(
                    &r.id,
                    &r.name,
                    &r.method,
                    &r.url,
                    r.collection_id.as_deref(),
                    r.environment_id.as_deref(),
                    r.updated_at,
                )
            })
            .collect(),
        recent_tasks: tasks
            .iter()
            .map(|t| {
                sanitize_task_meta(
                    &t.id,
                    &enum_wire_str(&t.task_type),
                    &t.title,
                    &t.resource_id,
                    &t.resource_name,
                    &t.env_tag,
                    &enum_wire_str(&t.risk),
                    &enum_wire_str(&t.status),
                    &enum_wire_str(&t.source),
                    t.updated_at,
                )
            })
            .collect(),
    })
}
