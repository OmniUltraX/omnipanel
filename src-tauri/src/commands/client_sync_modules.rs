//! 客户端默认团队「各业务模块」同步。
//! 路径：个人团队 OSS `modules/latest.json`（与手动团队同步共用）。

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_assistant::{
    pull_team_sync_json, push_team_sync_json, validate_modules_bundle_json, TEAM_MODULES_LATEST_LEAF,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    db_password_ref, load_database_connections, Connection, DbConnectionConfig, HttpCollection,
    HttpEnvironment, KnowledgeEntry, SavedHttpRequest, Vault,
};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::auth::{auth_device_identity, auth_get_me, require_personal_team_id};
use crate::commands::assistant::build_auth_context;
use crate::state::AppState;

const MODULES_KIND: &str = "workspace-modules";
const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncTombstone {
    pub id: String,
    pub deleted_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncConnectionItem {
    pub connection: Connection,
    /// 同账号多设备恢复用（SSH 密码等 Vault 明文）；仅账号级 sync 前缀。
    #[serde(default)]
    pub secret: Option<String>,
}

/// 数据库连接同步项：配置 + Vault 密码明文（同账号设备间恢复）。
/// 反序列化兼容旧快照（数组元素曾是裸 `DbConnectionConfig`）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncDatabaseItem {
    pub connection: DbConnectionConfig,
    #[serde(default)]
    pub secret: Option<String>,
}

impl<'de> Deserialize<'de> for ClientSyncDatabaseItem {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.get("connection").is_some() {
            #[derive(Deserialize)]
            #[serde(rename_all = "camelCase")]
            struct Wrapped {
                connection: DbConnectionConfig,
                #[serde(default)]
                secret: Option<String>,
            }
            let wrapped: Wrapped =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Self {
                connection: wrapped.connection,
                secret: wrapped.secret.filter(|s| !s.is_empty()),
            })
        } else {
            let connection: DbConnectionConfig =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Self {
                connection,
                secret: None,
            })
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncWorkspaceInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub window_form: Option<String>,
    #[serde(default)]
    pub updated_at: f64,
    /// 资源标签列表；上传时若为空会自动补当前设备名。
    #[serde(default)]
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncModulesBundle {
    pub schema_version: u32,
    pub kind: String,
    pub updated_at: f64,
    #[serde(default)]
    pub connections: Vec<ClientSyncConnectionItem>,
    #[serde(default)]
    pub deleted_connections: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub database_connections: Vec<ClientSyncDatabaseItem>,
    #[serde(default)]
    pub deleted_databases: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub knowledge: Vec<KnowledgeEntry>,
    #[serde(default)]
    pub deleted_knowledge: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub http_collections: Vec<HttpCollection>,
    #[serde(default)]
    pub http_environments: Vec<HttpEnvironment>,
    #[serde(default)]
    pub http_requests: Vec<SavedHttpRequest>,
    #[serde(default)]
    pub deleted_http_requests: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_collections: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_environments: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub workspaces: Vec<ClientSyncWorkspaceInfo>,
    #[serde(default)]
    pub deleted_workspaces: Vec<ClientSyncTombstone>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPushModulesRequest {
    pub token: String,
    #[serde(default)]
    pub workspaces_json: Option<String>,
    #[serde(default)]
    pub deleted_connections: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_databases: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_knowledge: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_requests: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_collections: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_http_environments: Vec<ClientSyncTombstone>,
    #[serde(default)]
    pub deleted_workspaces: Vec<ClientSyncTombstone>,
    /// 可选团队 ID；缺省回退到默认个人团队。
    #[serde(default)]
    pub team_id: Option<i64>,
}

/// 解析请求里的可选 `team_id`：有效则用之，否则回退到默认个人团队。
fn resolve_team_id(request_team_id: Option<i64>, me: &crate::commands::auth::AuthUserProfile) -> Result<i64, OmniError> {
    match request_team_id {
        Some(id) if id > 0 => Ok(id),
        _ => require_personal_team_id(me),
    }
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPushModulesResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: f64,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn parse_workspaces(raw: Option<&str>) -> Vec<ClientSyncWorkspaceInfo> {
    let Some(text) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    serde_json::from_str(text).unwrap_or_default()
}

fn collect_connection_items(
    storage: &omnipanel_store::Storage,
) -> Result<Vec<ClientSyncConnectionItem>, OmniError> {
    let list = storage.list_connections()?;
    let mut out = Vec::with_capacity(list.len());
    for connection in list {
        let secret = connection
            .credential_ref
            .as_deref()
            .and_then(|r| Vault::get(r).ok())
            .filter(|s| !s.is_empty());
        out.push(ClientSyncConnectionItem { connection, secret });
    }
    Ok(out)
}

fn collect_database_items() -> Result<Vec<ClientSyncDatabaseItem>, OmniError> {
    let list = load_database_connections()?;
    let mut out = Vec::with_capacity(list.len());
    for mut connection in list {
        let secret = Vault::get(&db_password_ref(&connection.id))
            .ok()
            .filter(|s| !s.is_empty());
        // 密码只走 secret 字段，配置体不落明文
        connection.password.clear();
        connection.has_password = secret.is_some();
        out.push(ClientSyncDatabaseItem { connection, secret });
    }
    Ok(out)
}

pub(crate) fn collect_local_bundle(
    storage: &omnipanel_store::Storage,
    request: &ClientSyncPushModulesRequest,
) -> Result<ClientSyncModulesBundle, OmniError> {
    Ok(ClientSyncModulesBundle {
        schema_version: SCHEMA_VERSION,
        kind: MODULES_KIND.to_string(),
        updated_at: now_ms(),
        connections: collect_connection_items(storage)?,
        deleted_connections: request.deleted_connections.clone(),
        database_connections: collect_database_items()?,
        deleted_databases: request.deleted_databases.clone(),
        knowledge: storage.list_knowledge(None, None)?,
        deleted_knowledge: request.deleted_knowledge.clone(),
        http_collections: storage.http_list_collections()?,
        http_environments: storage.http_list_environments()?,
        http_requests: storage.http_list_requests(None)?,
        deleted_http_requests: request.deleted_http_requests.clone(),
        deleted_http_collections: request.deleted_http_collections.clone(),
        deleted_http_environments: request.deleted_http_environments.clone(),
        workspaces: parse_workspaces(request.workspaces_json.as_deref()),
        deleted_workspaces: request.deleted_workspaces.clone(),
    })
}

/// 给 bundle 中尚未包含设备名的资源追加当前设备名标签（仅 push 上传 / peek 展示时用）。
///
/// 已有其他标签（如 Connection 的 `os:Ubuntu` 资源探测标签）的资源也会补上设备名，
/// 仅当 tags 中已存在相同设备名时跳过，避免重复。
pub(crate) fn tag_bundle_with_device(bundle: &mut ClientSyncModulesBundle, device_name: &str) {
    let push_if_absent = |tags: &mut Vec<String>| {
        if !tags.iter().any(|t| t.trim() == device_name) {
            tags.push(device_name.to_string());
        }
    };
    for c in &mut bundle.connections {
        push_if_absent(&mut c.connection.tags);
    }
    for d in &mut bundle.database_connections {
        push_if_absent(&mut d.connection.tags);
    }
    for k in &mut bundle.knowledge {
        push_if_absent(&mut k.tags);
    }
    for r in &mut bundle.http_requests {
        push_if_absent(&mut r.tags);
    }
    for col in &mut bundle.http_collections {
        push_if_absent(&mut col.tags);
    }
    for env in &mut bundle.http_environments {
        push_if_absent(&mut env.tags);
    }
    for w in &mut bundle.workspaces {
        push_if_absent(&mut w.tags);
    }
}

/// 推送本机模块快照到默认个人团队 OSS（`modules/latest.json`）。
#[tauri::command]
#[specta::specta]
pub async fn client_sync_push_modules(
    state: State<'_, AppState>,
    request: ClientSyncPushModulesRequest,
) -> Result<ClientSyncPushModulesResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法同步模块数据到云端",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), request.token.clone()).await?;
    let team_id = resolve_team_id(request.team_id, &me)?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;

    let mut bundle = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &request)?
    };
    // 上传前给 tags 为空的资源补当前设备名，便于多设备快照区分来源
    let device_name = identity.device_name.trim().to_string();
    if !device_name.is_empty() {
        tag_bundle_with_device(&mut bundle, &device_name);
    }

    let body = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&body)?;
    let uploaded = push_team_sync_json(&auth, team_id, TEAM_MODULES_LATEST_LEAF, &body).await?;

    Ok(ClientSyncPushModulesResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPullModulesResult {
    pub found: bool,
    pub object_key: Option<String>,
    pub bytes: f64,
    pub applied_connections: f64,
    pub applied_databases: f64,
    pub applied_knowledge: f64,
    pub applied_http_requests: f64,
    pub applied_workspaces: f64,
    /// 工作区 JSON，由前端写入 workspaceStore。
    pub workspaces_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPullModulesRequest {
    pub token: String,
    /// 可选团队 ID；缺省回退到默认个人团队。
    #[serde(default)]
    pub team_id: Option<i64>,
}

fn tombstone_ids(list: &[ClientSyncTombstone]) -> HashSet<String> {
    list.iter()
        .map(|t| t.id.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub(crate) async fn apply_modules_bundle(
    state: &AppState,
    bundle: &ClientSyncModulesBundle,
) -> Result<(usize, usize, usize, usize, usize, Option<String>), OmniError> {
    let remote_conn_ids: HashSet<String> = bundle
        .connections
        .iter()
        .map(|c| c.connection.id.clone())
        .collect();
    let remote_db_ids: HashSet<String> = bundle
        .database_connections
        .iter()
        .map(|c| c.connection.id.clone())
        .collect();
    let remote_kn_ids: HashSet<String> = bundle.knowledge.iter().map(|k| k.id.clone()).collect();
    let remote_req_ids: HashSet<String> = bundle.http_requests.iter().map(|r| r.id.clone()).collect();
    let remote_col_ids: HashSet<String> = bundle
        .http_collections
        .iter()
        .map(|c| c.id.clone())
        .collect();
    let remote_env_ids: HashSet<String> = bundle
        .http_environments
        .iter()
        .map(|e| e.id.clone())
        .collect();

    let deleted_conn = tombstone_ids(&bundle.deleted_connections);
    let deleted_db = tombstone_ids(&bundle.deleted_databases);
    let deleted_kn = tombstone_ids(&bundle.deleted_knowledge);
    let deleted_req = tombstone_ids(&bundle.deleted_http_requests);
    let deleted_col = tombstone_ids(&bundle.deleted_http_collections);
    let deleted_env = tombstone_ids(&bundle.deleted_http_environments);

    {
        let storage = state.storage.lock().await;
        for conn in storage.list_connections()? {
            if deleted_conn.contains(&conn.id) || !remote_conn_ids.contains(&conn.id) {
                storage.delete_connection(&conn.id)?;
                if let Some(ref cred) = conn.credential_ref {
                    let _ = Vault::delete(cred);
                }
            }
        }
        for entry in storage.list_knowledge(None, None)? {
            if deleted_kn.contains(&entry.id) || !remote_kn_ids.contains(&entry.id) {
                storage.delete_knowledge(&entry.id)?;
            }
        }
        for req in storage.http_list_requests(None)? {
            if deleted_req.contains(&req.id) || !remote_req_ids.contains(&req.id) {
                storage.http_delete_request(&req.id)?;
            }
        }
        for col in storage.http_list_collections()? {
            if deleted_col.contains(&col.id) || !remote_col_ids.contains(&col.id) {
                storage.http_delete_collection(&col.id)?;
            }
        }
        for env in storage.http_list_environments()? {
            if deleted_env.contains(&env.id) || !remote_env_ids.contains(&env.id) {
                storage.http_delete_environment(&env.id)?;
            }
        }
    }

    for db in state.db_connections.list()? {
        if deleted_db.contains(&db.id) || !remote_db_ids.contains(&db.id) {
            state.db_connections.delete(&db.id)?;
            let _ = Vault::delete(&db_password_ref(&db.id));
        }
    }

    for item in &bundle.database_connections {
        let mut c = item.connection.clone();
        if let Some(secret) = item.secret.as_deref().filter(|s| !s.is_empty()) {
            c.password = secret.to_string();
        } else {
            c.password.clear();
        }
        state.db_connections.save(c)?;
    }

    {
        let storage = state.storage.lock().await;
        for item in &bundle.connections {
            let mut conn = item.connection.clone();
            if let Some(secret) = item.secret.as_deref().filter(|s| !s.is_empty()) {
                let cred_ref = conn
                    .credential_ref
                    .clone()
                    .unwrap_or_else(|| format!("ssh-password-{}", conn.id));
                Vault::store(&cred_ref, secret)?;
                conn.credential_ref = Some(cred_ref);
            }
            storage.save_connection(&conn)?;
        }
        for entry in &bundle.knowledge {
            storage.save_knowledge(entry)?;
        }
        for col in &bundle.http_collections {
            storage.http_save_collection(col)?;
        }
        for env in &bundle.http_environments {
            storage.http_save_environment(env)?;
        }
        for req in &bundle.http_requests {
            storage.http_save_request(req)?;
        }
    }

    let applied_connections = bundle.connections.len();
    let applied_databases = bundle.database_connections.len();
    let applied_knowledge = bundle.knowledge.len();
    let applied_http_requests = bundle.http_requests.len();
    let applied_workspaces = bundle.workspaces.len();
    let workspaces_json = serde_json::to_string(&bundle.workspaces).ok();

    Ok((
        applied_connections,
        applied_databases,
        applied_knowledge,
        applied_http_requests,
        applied_workspaces,
        workspaces_json,
    ))
}

/// 从默认个人团队 OSS 拉取模块快照并应用到本机。
#[tauri::command]
#[specta::specta]
pub async fn client_sync_pull_modules(
    state: State<'_, AppState>,
    request: ClientSyncPullModulesRequest,
) -> Result<ClientSyncPullModulesResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法拉取模块同步数据",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), request.token.clone()).await?;
    let team_id = resolve_team_id(request.team_id, &me)?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;

    let Some((object_key, bytes)) =
        pull_team_sync_json(&auth, team_id, TEAM_MODULES_LATEST_LEAF).await?
    else {
        return Ok(ClientSyncPullModulesResult {
            found: false,
            object_key: None,
            bytes: 0.0,
            applied_connections: 0.0,
            applied_databases: 0.0,
            applied_knowledge: 0.0,
            applied_http_requests: 0.0,
            applied_workspaces: 0.0,
            workspaces_json: None,
        });
    };

    validate_modules_bundle_json(&bytes)?;
    let bundle: ClientSyncModulesBundle = serde_json::from_slice(&bytes).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析云端模块快照失败").with_cause(e.to_string())
    })?;

    let (
        applied_connections,
        applied_databases,
        applied_knowledge,
        applied_http_requests,
        applied_workspaces,
        workspaces_json,
    ) = apply_modules_bundle(&state, &bundle).await?;

    Ok(ClientSyncPullModulesResult {
        found: true,
        object_key: Some(object_key),
        bytes: bytes.len() as f64,
        applied_connections: applied_connections as f64,
        applied_databases: applied_databases as f64,
        applied_knowledge: applied_knowledge as f64,
        applied_http_requests: applied_http_requests as f64,
        applied_workspaces: applied_workspaces as f64,
        workspaces_json,
    })
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPeekItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub detail: String,
    pub updated_at: f64,
    /// 树形父节点 id；空表示根级。连接分组使用 `__group__:{name}` 虚拟节点。
    #[serde(default)]
    pub parent_id: String,
    /// `folder` | `item`（空视为 item）
    #[serde(default)]
    pub kind: String,
    /// 资源标签列表（来自对应资源的 tags 字段）。
    #[serde(default)]
    pub tags: Vec<String>,
}

pub(crate) fn peek_item(
    id: impl Into<String>,
    label: impl Into<String>,
    detail: impl Into<String>,
    updated_at: f64,
    parent_id: impl Into<String>,
    kind: &str,
    tags: Vec<String>,
) -> ClientSyncPeekItem {
    ClientSyncPeekItem {
        id: id.into(),
        label: label.into(),
        detail: detail.into(),
        updated_at,
        parent_id: parent_id.into(),
        kind: kind.to_string(),
        tags,
    }
}

pub(crate) fn connection_group_folder_id(group: &str) -> String {
    format!("__group__:{group}")
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ModulesBundlePeek {
    pub connections: Vec<ClientSyncPeekItem>,
    pub databases: Vec<ClientSyncPeekItem>,
    pub knowledge: Vec<ClientSyncPeekItem>,
    pub http_collections: Vec<ClientSyncPeekItem>,
    pub http_requests: Vec<ClientSyncPeekItem>,
    pub workspaces: Vec<ClientSyncPeekItem>,
}

pub(crate) fn build_peek_from_bundle(bundle: &ClientSyncModulesBundle) -> ModulesBundlePeek {
    ModulesBundlePeek {
        connections: build_connection_peek_items(&bundle.connections),
        databases: bundle
            .database_connections
            .iter()
            .map(|item| {
                peek_item(
                    item.connection.id.clone(),
                    item.connection.name.clone(),
                    item.connection.db_type.clone(),
                    0.0,
                    "",
                    "item",
                    item.connection.tags.clone(),
                )
            })
            .collect(),
        knowledge: bundle
            .knowledge
            .iter()
            .map(|k| {
                let kind = if k.node_type.trim().eq_ignore_ascii_case("folder") {
                    "folder"
                } else {
                    "item"
                };
                peek_item(
                    k.id.clone(),
                    k.title.clone(),
                    k.node_type.clone(),
                    k.updated_at as f64,
                    k.parent_id.trim().to_string(),
                    kind,
                    k.tags.clone(),
                )
            })
            .collect(),
        http_collections: bundle
            .http_collections
            .iter()
            .map(|c| {
                peek_item(
                    c.id.clone(),
                    c.name.clone(),
                    c.description.clone(),
                    c.updated_at as f64,
                    "",
                    "folder",
                    c.tags.clone(),
                )
            })
            .collect(),
        http_requests: bundle
            .http_requests
            .iter()
            .map(|r| {
                peek_item(
                    r.id.clone(),
                    r.name.clone(),
                    format!("{} {}", r.method, r.url),
                    r.updated_at as f64,
                    r.collection_id.clone().unwrap_or_default(),
                    "item",
                    r.tags.clone(),
                )
            })
            .collect(),
        workspaces: bundle
            .workspaces
            .iter()
            .map(|w| {
                peek_item(
                    w.id.clone(),
                    w.name.clone(),
                    w.description.clone(),
                    w.updated_at,
                    "",
                    "item",
                    w.tags.clone(),
                )
            })
            .collect(),
    }
}

pub(crate) fn build_connection_peek_items(
    connections: &[ClientSyncConnectionItem],
) -> Vec<ClientSyncPeekItem> {
    let mut groups: Vec<String> = connections
        .iter()
        .map(|c| c.connection.group.trim().to_string())
        .filter(|g| !g.is_empty())
        .collect();
    groups.sort();
    groups.dedup();

    let mut out = Vec::with_capacity(connections.len() + groups.len());
    for group in &groups {
        out.push(peek_item(
            connection_group_folder_id(group),
            group.clone(),
            "group",
            0.0,
            "",
            "folder",
            Vec::new(),
        ));
    }
    for c in connections {
        let group = c.connection.group.trim();
        let parent = if group.is_empty() {
            String::new()
        } else {
            connection_group_folder_id(group)
        };
        out.push(peek_item(
            c.connection.id.clone(),
            c.connection.name.clone(),
            c.connection.kind.as_str(),
            (c.connection.updated_at as f64) * 1000.0,
            parent,
            "item",
            c.connection.tags.clone(),
        ));
    }
    out
}

