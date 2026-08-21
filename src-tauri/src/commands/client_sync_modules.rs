//! 客户端选定团队「各业务模块」同步。
//! 路径：团队 OSS `modules/latest.json`；上传前端到端加密，密码不进快照（个人凭据走 secrets vault）。

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_assistant::{
    pull_team_sync_json, push_team_sync_json, validate_modules_bundle_json, TEAM_MODULES_LATEST_LEAF,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    db_password_ref, decode_sync_blob_or_legacy, encrypt_sync_blob, load_database_connections,
    Connection, DbConnectionConfig, HttpCollection, HttpEnvironment, KnowledgeEntry,
    SavedHttpRequest, Vault, SYNC_KIND_MODULES,
};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::auth::{
    auth_device_identity, auth_get_me, resolve_sync_team, sync_blob_key_material,
};
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
    /// SSH 侧栏文件夹布局（前端 IndexedDB 快照 JSON）。旧快照缺此字段则为空。
    #[serde(default)]
    pub ssh_sidebar_tree_json: Option<String>,
    /// 其他模块侧栏文件夹布局 JSON：`{ docker, database, protocol }`。旧快照缺此字段则为空。
    #[serde(default)]
    pub folder_trees_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPushModulesRequest {
    pub token: String,
    #[serde(default)]
    pub workspaces_json: Option<String>,
    /// SSH 侧栏文件夹布局 JSON；由前端从 sshSidebarTreeStore 序列化。
    #[serde(default)]
    pub ssh_sidebar_tree_json: Option<String>,
    /// 其他模块侧栏文件夹布局 JSON；由前端从 Docker/数据库/协议 store 序列化。
    #[serde(default)]
    pub folder_trees_json: Option<String>,
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

/// 上传前剥离连接/数据库明文密码：个人凭据走 secrets vault，协作团队不同步密码。
pub(crate) fn strip_bundle_secrets(bundle: &mut ClientSyncModulesBundle) {
    for item in &mut bundle.connections {
        item.secret = None;
    }
    for item in &mut bundle.database_connections {
        item.secret = None;
        item.connection.password.clear();
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

fn parse_json_object_string(raw: Option<&str>) -> Option<String> {
    let text = raw.map(str::trim).filter(|s| !s.is_empty())?;
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(_)) => Some(text.to_string()),
        _ => None,
    }
}

fn collect_connection_items(
    storage: &omnipanel_store::Storage,
) -> Result<Vec<ClientSyncConnectionItem>, OmniError> {
    let list = storage.list_connections()?;
    let mut out = Vec::with_capacity(list.len());
    for connection in list {
        // 密码不进 modules 快照；个人多设备凭据走 secrets vault。
        out.push(ClientSyncConnectionItem {
            connection,
            secret: None,
        });
    }
    Ok(out)
}

fn collect_database_items() -> Result<Vec<ClientSyncDatabaseItem>, OmniError> {
    let list = load_database_connections()?;
    let mut out = Vec::with_capacity(list.len());
    for mut connection in list {
        let has_password = Vault::get(&db_password_ref(&connection.id))
            .ok()
            .filter(|s| !s.is_empty())
            .is_some();
        // 配置体与 secret 均不落明文；仅同步 has_password 元数据。
        connection.password.clear();
        connection.has_password = has_password;
        out.push(ClientSyncDatabaseItem {
            connection,
            secret: None,
        });
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
        ssh_sidebar_tree_json: parse_json_object_string(request.ssh_sidebar_tree_json.as_deref()),
        folder_trees_json: parse_json_object_string(request.folder_trees_json.as_deref()),
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
    let team = resolve_sync_team(request.team_id, &me)?;
    let team_id = team.id;
    let key_material = sync_blob_key_material(&me, team)?;
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
    strip_bundle_secrets(&mut bundle);

    let plaintext = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&plaintext)?;
    let body = encrypt_sync_blob(&key_material, SYNC_KIND_MODULES, &plaintext)?;
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
    /// SSH 侧栏文件夹布局 JSON，由前端写入 sshSidebarTreeStore。
    pub ssh_sidebar_tree_json: Option<String>,
    /// 其他模块侧栏文件夹布局 JSON，由前端写入 Docker/数据库/协议 store。
    pub folder_trees_json: Option<String>,
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
) -> Result<(usize, usize, usize, usize, usize, Option<String>, Option<String>, Option<String>), OmniError> {
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

    // 分类清理：仅当远端该分类有资源或有墓碑时才整表对齐删除。
    // 避免「只有工作区 / 空连接列表」的快照把本机已有连接清光。
    let replace_conn = !remote_conn_ids.is_empty() || !deleted_conn.is_empty();
    let replace_db = !remote_db_ids.is_empty() || !deleted_db.is_empty();
    let replace_kn = !remote_kn_ids.is_empty() || !deleted_kn.is_empty();
    let replace_req = !remote_req_ids.is_empty() || !deleted_req.is_empty();
    let replace_col = !remote_col_ids.is_empty() || !deleted_col.is_empty();
    let replace_env = !remote_env_ids.is_empty() || !deleted_env.is_empty();

    {
        let storage = state.storage.lock().await;
        if replace_conn {
            for conn in storage.list_connections()? {
                if deleted_conn.contains(&conn.id) || !remote_conn_ids.contains(&conn.id) {
                    storage.delete_connection(&conn.id)?;
                    if let Some(ref cred) = conn.credential_ref {
                        let _ = Vault::delete(cred);
                    }
                }
            }
        } else {
            for id in &deleted_conn {
                storage.delete_connection(id)?;
            }
        }
        if replace_kn {
            for entry in storage.list_knowledge(None, None)? {
                if deleted_kn.contains(&entry.id) || !remote_kn_ids.contains(&entry.id) {
                    storage.delete_knowledge(&entry.id)?;
                }
            }
        } else {
            for id in &deleted_kn {
                storage.delete_knowledge(id)?;
            }
        }
        if replace_req {
            for req in storage.http_list_requests(None)? {
                if deleted_req.contains(&req.id) || !remote_req_ids.contains(&req.id) {
                    storage.http_delete_request(&req.id)?;
                }
            }
        } else {
            for id in &deleted_req {
                storage.http_delete_request(id)?;
            }
        }
        if replace_col {
            for col in storage.http_list_collections()? {
                if deleted_col.contains(&col.id) || !remote_col_ids.contains(&col.id) {
                    storage.http_delete_collection(&col.id)?;
                }
            }
        } else {
            for id in &deleted_col {
                storage.http_delete_collection(id)?;
            }
        }
        if replace_env {
            for env in storage.http_list_environments()? {
                if deleted_env.contains(&env.id) || !remote_env_ids.contains(&env.id) {
                    storage.http_delete_environment(&env.id)?;
                }
            }
        } else {
            for id in &deleted_env {
                storage.http_delete_environment(id)?;
            }
        }
    }

    if replace_db {
        for db in state.db_connections.list()? {
            if deleted_db.contains(&db.id) || !remote_db_ids.contains(&db.id) {
                state.db_connections.delete(&db.id)?;
                let _ = Vault::delete(&db_password_ref(&db.id));
            }
        }
    } else {
        for id in &deleted_db {
            let _ = state.db_connections.delete(id);
            let _ = Vault::delete(&db_password_ref(id));
        }
    }

    for item in &bundle.database_connections {
        let mut c = item.connection.clone();
        // 密码不从 modules 导入（含历史明文 secret）；个人凭据走 secrets vault。
        c.password.clear();
        state.db_connections.save(c)?;
    }

    {
        let storage = state.storage.lock().await;
        for item in &bundle.connections {
            // 不从 modules 的 secret 写入本地 Vault。
            storage.save_connection(&item.connection)?;
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
    let ssh_sidebar_tree_json = bundle.ssh_sidebar_tree_json.clone();
    let folder_trees_json = bundle.folder_trees_json.clone();

    Ok((
        applied_connections,
        applied_databases,
        applied_knowledge,
        applied_http_requests,
        applied_workspaces,
        workspaces_json,
        ssh_sidebar_tree_json,
        folder_trees_json,
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
    let team = resolve_sync_team(request.team_id, &me)?;
    let team_id = team.id;
    let key_material = sync_blob_key_material(&me, team)?;
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
            ssh_sidebar_tree_json: None,
            folder_trees_json: None,
        });
    };

    let plaintext = decode_sync_blob_or_legacy(&key_material, SYNC_KIND_MODULES, &bytes)?;
    validate_modules_bundle_json(&plaintext)?;
    let bundle: ClientSyncModulesBundle = serde_json::from_slice(&plaintext).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析云端模块快照失败").with_cause(e.to_string())
    })?;

    let (
        applied_connections,
        applied_databases,
        applied_knowledge,
        applied_http_requests,
        applied_workspaces,
        workspaces_json,
        ssh_sidebar_tree_json,
        folder_trees_json,
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
        ssh_sidebar_tree_json,
        folder_trees_json,
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

#[derive(Clone, Default)]
struct SidebarTreePeek {
    folders: Vec<(String, String, String)>, // id, name, parent_id
    connection_folder_id: HashMap<String, String>,
}

fn json_parent_id(value: &serde_json::Value) -> String {
    value
        .get("parentId")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_string()
}

fn parse_sidebar_tree_object(value: &serde_json::Value) -> SidebarTreePeek {
    let mut out = SidebarTreePeek::default();
    let Some(obj) = value.as_object() else {
        return out;
    };
    if let Some(folders) = obj.get("folders").and_then(|v| v.as_array()) {
        for folder in folders {
            let id = folder
                .get("id")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let Some(id) = id else {
                continue;
            };
            let name = folder
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            out.folders
                .push((id.to_string(), name, json_parent_id(folder)));
        }
    }
    let map = obj
        .get("connectionFolderId")
        .or_else(|| obj.get("connectionParents"))
        .and_then(|v| v.as_object());
    if let Some(map) = map {
        for (conn_id, folder_id) in map {
            let Some(folder_id) = folder_id.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            out.connection_folder_id
                .insert(conn_id.clone(), folder_id.to_string());
        }
    }
    out
}

fn parse_sidebar_tree_json(raw: Option<&str>) -> Option<SidebarTreePeek> {
    let text = raw.map(str::trim).filter(|s| !s.is_empty())?;
    let value = serde_json::from_str::<serde_json::Value>(text).ok()?;
    Some(parse_sidebar_tree_object(&value))
}

fn parse_folder_trees_json(raw: Option<&str>) -> serde_json::Map<String, serde_json::Value> {
    let Some(text) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return serde_json::Map::new();
    };
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn parse_protocol_layout_object(value: &serde_json::Value) -> SidebarTreePeek {
    let mut out = parse_sidebar_tree_object(value);
    let Some(obj) = value.as_object() else {
        return out;
    };
    for key in ["collectionParents", "requestParents", "entryParents"] {
        let Some(map) = obj.get(key).and_then(|v| v.as_object()) else {
            continue;
        };
        for (id, folder_id) in map {
            let Some(folder_id) = folder_id.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                continue;
            };
            out.connection_folder_id
                .insert(id.clone(), folder_id.to_string());
        }
    }
    out
}

fn emit_tree_folders(tree: &SidebarTreePeek, detail: &str, out: &mut Vec<ClientSyncPeekItem>) {
    for (id, name, parent) in &tree.folders {
        out.push(peek_item(
            id.clone(),
            name.clone(),
            detail,
            0.0,
            parent.clone(),
            "folder",
            Vec::new(),
        ));
    }
}

pub(crate) fn build_peek_from_bundle(bundle: &ClientSyncModulesBundle) -> ModulesBundlePeek {
    let folder_trees = parse_folder_trees_json(bundle.folder_trees_json.as_deref());
    let ssh_tree = parse_sidebar_tree_json(bundle.ssh_sidebar_tree_json.as_deref());
    let docker_tree = folder_trees
        .get("docker")
        .map(parse_sidebar_tree_object);
    let database_tree = folder_trees
        .get("database")
        .map(parse_sidebar_tree_object);
    let protocol_tree = folder_trees
        .get("protocol")
        .map(parse_protocol_layout_object);

    ModulesBundlePeek {
        connections: build_connection_peek_items(
            &bundle.connections,
            ssh_tree.as_ref(),
            docker_tree.as_ref(),
        ),
        databases: build_database_peek_items(&bundle.database_connections, database_tree.as_ref()),
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
        http_collections: build_http_collection_peek_items(
            &bundle.http_collections,
            protocol_tree.as_ref(),
        ),
        http_requests: build_http_request_peek_items(&bundle.http_requests, protocol_tree.as_ref()),
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

fn build_http_collection_peek_items(
    collections: &[HttpCollection],
    protocol_tree: Option<&SidebarTreePeek>,
) -> Vec<ClientSyncPeekItem> {
    let mut out = Vec::with_capacity(collections.len() + protocol_tree.map(|t| t.folders.len()).unwrap_or(0));
    if let Some(tree) = protocol_tree {
        emit_tree_folders(tree, "layout-folder", &mut out);
    }
    for c in collections {
        let parent = protocol_tree
            .and_then(|tree| tree.connection_folder_id.get(&c.id))
            .cloned()
            .unwrap_or_default();
        out.push(peek_item(
            c.id.clone(),
            c.name.clone(),
            c.description.clone(),
            c.updated_at as f64,
            parent,
            "folder",
            c.tags.clone(),
        ));
    }
    out
}

fn build_http_request_peek_items(
    requests: &[SavedHttpRequest],
    protocol_tree: Option<&SidebarTreePeek>,
) -> Vec<ClientSyncPeekItem> {
    requests
        .iter()
        .map(|r| {
            let parent = protocol_tree
                .and_then(|tree| tree.connection_folder_id.get(&r.id))
                .cloned()
                .or_else(|| r.collection_id.clone())
                .unwrap_or_default();
            peek_item(
                r.id.clone(),
                r.name.clone(),
                format!("{} {}", r.method, r.url),
                r.updated_at as f64,
                parent,
                "item",
                r.tags.clone(),
            )
        })
        .collect()
}

fn build_database_peek_items(
    databases: &[ClientSyncDatabaseItem],
    tree: Option<&SidebarTreePeek>,
) -> Vec<ClientSyncPeekItem> {
    let mut out = Vec::with_capacity(databases.len() + tree.map(|t| t.folders.len()).unwrap_or(0));
    if let Some(tree) = tree {
        emit_tree_folders(tree, "folder", &mut out);
    }
    for item in databases {
        let parent = tree
            .and_then(|t| t.connection_folder_id.get(&item.connection.id))
            .cloned()
            .unwrap_or_default();
        out.push(peek_item(
            item.connection.id.clone(),
            item.connection.name.clone(),
            item.connection.db_type.clone(),
            0.0,
            parent,
            "item",
            item.connection.tags.clone(),
        ));
    }
    out
}

fn build_connection_peek_items(
    connections: &[ClientSyncConnectionItem],
    ssh_tree: Option<&SidebarTreePeek>,
    docker_tree: Option<&SidebarTreePeek>,
) -> Vec<ClientSyncPeekItem> {
    let mut out = Vec::with_capacity(connections.len() + 8);
    if let Some(tree) = ssh_tree {
        emit_tree_folders(tree, "folder", &mut out);
    }
    if let Some(tree) = docker_tree {
        emit_tree_folders(tree, "folder", &mut out);
    }

    let mut used_groups: HashSet<String> = HashSet::new();
    for c in connections {
        let kind = c.connection.kind.as_str();
        let tree_parent = match kind {
            "ssh" => ssh_tree.and_then(|t| t.connection_folder_id.get(&c.connection.id)),
            "docker" => docker_tree.and_then(|t| t.connection_folder_id.get(&c.connection.id)),
            _ => None,
        };
        if tree_parent.is_some() || ((kind == "ssh" && ssh_tree.is_some()) || (kind == "docker" && docker_tree.is_some()))
        {
            continue;
        }
        let group = c.connection.group.trim();
        if !group.is_empty() {
            used_groups.insert(group.to_string());
        }
    }
    let mut groups: Vec<String> = used_groups.into_iter().collect();
    groups.sort();
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
        let kind = c.connection.kind.as_str();
        let parent = match kind {
            "ssh" => ssh_tree
                .and_then(|t| t.connection_folder_id.get(&c.connection.id).cloned())
                .unwrap_or_default(),
            "docker" => docker_tree
                .and_then(|t| t.connection_folder_id.get(&c.connection.id).cloned())
                .unwrap_or_default(),
            _ => {
                let group = c.connection.group.trim();
                if group.is_empty() {
                    String::new()
                } else {
                    connection_group_folder_id(group)
                }
            }
        };
        out.push(peek_item(
            c.connection.id.clone(),
            c.connection.name.clone(),
            kind,
            (c.connection.updated_at as f64) * 1000.0,
            parent,
            "item",
            c.connection.tags.clone(),
        ));
    }
    out
}

