//! 客户端间「各业务模块」同步：连接 / 数据库 / 知识库 / HTTP / 工作区。
//! 路径：`sync/{userId}/v1/modules/latest.json`（与助手快照、AI 会话 blob 独立）。

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_assistant::{
    modules_latest_object_key, pull_modules_json, push_modules_json, validate_modules_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    load_database_connections, save_database_connections, Connection, DbConnectionConfig,
    HttpCollection, HttpEnvironment, KnowledgeEntry, SavedHttpRequest, Vault,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::auth::{auth_device_identity, auth_get_me};
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
    pub database_connections: Vec<DbConnectionConfig>,
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
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPushModulesResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPullModulesRequest {
    pub token: String,
    #[serde(default)]
    pub workspaces_json: Option<String>,
    #[serde(default)]
    pub deleted_workspaces: Vec<ClientSyncTombstone>,
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
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPullModulesResult {
    pub found: bool,
    pub object_key: String,
    pub applied: bool,
    pub workspaces_json: Option<String>,
    pub connection_count: f64,
    pub database_count: f64,
    pub knowledge_count: f64,
    pub http_request_count: f64,
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn tombstone_map(list: &[ClientSyncTombstone]) -> HashMap<String, f64> {
    let mut map = HashMap::new();
    for t in list {
        let id = t.id.trim();
        if id.is_empty() {
            continue;
        }
        let at = if t.deleted_at > 0.0 {
            t.deleted_at
        } else {
            0.0
        };
        let prev = map.get(id).copied().unwrap_or(0.0);
        if at >= prev {
            map.insert(id.to_string(), at);
        }
    }
    map
}

fn merge_tombstones(a: &[ClientSyncTombstone], b: &[ClientSyncTombstone]) -> Vec<ClientSyncTombstone> {
    let mut map = tombstone_map(a);
    for (id, at) in tombstone_map(b) {
        let prev = map.get(&id).copied().unwrap_or(0.0);
        if at >= prev {
            map.insert(id, at);
        }
    }
    let mut out: Vec<_> = map
        .into_iter()
        .map(|(id, deleted_at)| ClientSyncTombstone { id, deleted_at })
        .collect();
    out.sort_by(|x, y| x.id.cmp(&y.id));
    out
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

fn collect_local_bundle(
    storage: &omnipanel_store::Storage,
    request: &ClientSyncPushModulesRequest,
) -> Result<ClientSyncModulesBundle, OmniError> {
    Ok(ClientSyncModulesBundle {
        schema_version: SCHEMA_VERSION,
        kind: MODULES_KIND.to_string(),
        updated_at: now_ms(),
        connections: collect_connection_items(storage)?,
        deleted_connections: request.deleted_connections.clone(),
        database_connections: load_database_connections()?,
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

fn merge_by_updated_ms<T, FId, FAt>(
    local: Vec<T>,
    remote: Vec<T>,
    deleted: &HashMap<String, f64>,
    id_of: FId,
    updated_at_ms: FAt,
) -> Vec<T>
where
    FId: Fn(&T) -> String,
    FAt: Fn(&T) -> f64,
{
    let mut map: HashMap<String, (f64, T)> = HashMap::new();
    for item in local.into_iter().chain(remote) {
        let id = id_of(&item);
        if id.is_empty() {
            continue;
        }
        let at = updated_at_ms(&item);
        let deleted_at = deleted.get(&id).copied().unwrap_or(0.0);
        if deleted_at > 0.0 && at <= deleted_at {
            continue;
        }
        match map.get(&id) {
            Some((prev_at, _)) if *prev_at >= at => {}
            _ => {
                map.insert(id, (at, item));
            }
        }
    }
    map.into_values().map(|(_, v)| v).collect()
}

fn merge_bundles(
    local: ClientSyncModulesBundle,
    remote: ClientSyncModulesBundle,
) -> ClientSyncModulesBundle {
    let deleted_connections =
        merge_tombstones(&local.deleted_connections, &remote.deleted_connections);
    let deleted_databases = merge_tombstones(&local.deleted_databases, &remote.deleted_databases);
    let deleted_knowledge = merge_tombstones(&local.deleted_knowledge, &remote.deleted_knowledge);
    let deleted_http_requests =
        merge_tombstones(&local.deleted_http_requests, &remote.deleted_http_requests);
    let deleted_http_collections =
        merge_tombstones(&local.deleted_http_collections, &remote.deleted_http_collections);
    let deleted_http_environments =
        merge_tombstones(&local.deleted_http_environments, &remote.deleted_http_environments);
    let deleted_workspaces =
        merge_tombstones(&local.deleted_workspaces, &remote.deleted_workspaces);

    let conn_del = tombstone_map(&deleted_connections);
    let db_del = tombstone_map(&deleted_databases);
    let kn_del = tombstone_map(&deleted_knowledge);
    let http_req_del = tombstone_map(&deleted_http_requests);
    let http_col_del = tombstone_map(&deleted_http_collections);
    let http_env_del = tombstone_map(&deleted_http_environments);
    let ws_del = tombstone_map(&deleted_workspaces);

    let connections = merge_by_updated_ms(
        local.connections,
        remote.connections,
        &conn_del,
        |c| c.connection.id.clone(),
        |c| (c.connection.updated_at as f64) * 1000.0,
    );

    let database_connections = {
        let mut map: HashMap<String, DbConnectionConfig> = HashMap::new();
        for c in local.database_connections {
            if db_del.get(&c.id).copied().unwrap_or(0.0) <= 0.0 {
                map.insert(c.id.clone(), c);
            }
        }
        for c in remote.database_connections {
            if db_del.get(&c.id).copied().unwrap_or(0.0) <= 0.0 {
                map.insert(c.id.clone(), c);
            }
        }
        map.into_values().collect()
    };

    let knowledge = merge_by_updated_ms(
        local.knowledge,
        remote.knowledge,
        &kn_del,
        |k| k.id.clone(),
        |k| k.updated_at as f64,
    );
    let http_collections = merge_by_updated_ms(
        local.http_collections,
        remote.http_collections,
        &http_col_del,
        |c| c.id.clone(),
        |c| c.updated_at as f64,
    );
    let http_environments = merge_by_updated_ms(
        local.http_environments,
        remote.http_environments,
        &http_env_del,
        |e| e.id.clone(),
        |e| e.updated_at as f64,
    );
    let http_requests = merge_by_updated_ms(
        local.http_requests,
        remote.http_requests,
        &http_req_del,
        |r| r.id.clone(),
        |r| r.updated_at as f64,
    );
    let workspaces = merge_by_updated_ms(
        local.workspaces,
        remote.workspaces,
        &ws_del,
        |w| w.id.clone(),
        |w| if w.updated_at > 0.0 { w.updated_at } else { 1.0 },
    );

    ClientSyncModulesBundle {
        schema_version: SCHEMA_VERSION,
        kind: MODULES_KIND.to_string(),
        updated_at: now_ms().max(local.updated_at).max(remote.updated_at),
        connections,
        deleted_connections,
        database_connections,
        deleted_databases,
        knowledge,
        deleted_knowledge,
        http_collections,
        http_environments,
        http_requests,
        deleted_http_requests,
        deleted_http_collections,
        deleted_http_environments,
        workspaces,
        deleted_workspaces,
    }
}

fn apply_bundle(
    storage: &omnipanel_store::Storage,
    bundle: &ClientSyncModulesBundle,
) -> Result<(), OmniError> {
    let conn_del: HashSet<_> = bundle
        .deleted_connections
        .iter()
        .map(|t| t.id.clone())
        .collect();
    for id in &conn_del {
        let _ = storage.delete_connection(id);
        let _ = Vault::delete(&format!("ssh-password-{id}"));
    }
    for item in &bundle.connections {
        if conn_del.contains(&item.connection.id) {
            continue;
        }
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

    let db_del: HashSet<_> = bundle.deleted_databases.iter().map(|t| t.id.clone()).collect();
    let dbs: Vec<_> = bundle
        .database_connections
        .iter()
        .filter(|c| !db_del.contains(&c.id))
        .cloned()
        .collect();
    save_database_connections(&dbs)?;

    let kn_del: HashSet<_> = bundle.deleted_knowledge.iter().map(|t| t.id.clone()).collect();
    for id in &kn_del {
        let _ = storage.delete_knowledge(id);
    }
    for entry in &bundle.knowledge {
        if !kn_del.contains(&entry.id) {
            storage.save_knowledge(entry)?;
        }
    }

    let col_del: HashSet<_> = bundle
        .deleted_http_collections
        .iter()
        .map(|t| t.id.clone())
        .collect();
    let env_del: HashSet<_> = bundle
        .deleted_http_environments
        .iter()
        .map(|t| t.id.clone())
        .collect();
    let req_del: HashSet<_> = bundle
        .deleted_http_requests
        .iter()
        .map(|t| t.id.clone())
        .collect();
    for id in &col_del {
        let _ = storage.http_delete_collection(id);
    }
    for id in &env_del {
        let _ = storage.http_delete_environment(id);
    }
    for id in &req_del {
        let _ = storage.http_delete_request(id);
    }
    for col in &bundle.http_collections {
        if !col_del.contains(&col.id) {
            storage.http_save_collection(col)?;
        }
    }
    for env in &bundle.http_environments {
        if !env_del.contains(&env.id) {
            storage.http_save_environment(env)?;
        }
    }
    for req in &bundle.http_requests {
        if !req_del.contains(&req.id) {
            storage.http_save_request(req)?;
        }
    }
    Ok(())
}

fn push_request_from_pull(request: &ClientSyncPullModulesRequest) -> ClientSyncPushModulesRequest {
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

/// 推送各模块数据到 `sync/{userId}/v1/modules/latest.json`。
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
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;

    let bundle = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &request)?
    };
    let bundle = match pull_modules_json(&auth, &me.id.to_string()).await? {
        Some((_, bytes)) if validate_modules_bundle_json(&bytes).is_ok() => {
            match serde_json::from_slice::<ClientSyncModulesBundle>(&bytes) {
                Ok(remote) => merge_bundles(bundle, remote),
                Err(_) => bundle,
            }
        }
        _ => bundle,
    };

    let body = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&body)?;
    let uploaded = push_modules_json(&auth, &me.id.to_string(), &body).await?;

    Ok(ClientSyncPushModulesResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

/// 拉取并合并应用到本机存储；返回合并后的工作区供前端写入。
#[tauri::command]
#[specta::specta]
pub async fn client_sync_pull_modules(
    state: State<'_, AppState>,
    request: ClientSyncPullModulesRequest,
) -> Result<ClientSyncPullModulesResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法拉取云端模块数据",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), request.token.clone()).await?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;
    let object_key = modules_latest_object_key(&me.id.to_string());
    let push_req = push_request_from_pull(&request);

    let local = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &push_req)?
    };

    let Some((_, bytes)) = pull_modules_json(&auth, &me.id.to_string()).await? else {
        return Ok(ClientSyncPullModulesResult {
            found: false,
            object_key,
            applied: false,
            workspaces_json: serde_json::to_string(&local.workspaces).ok(),
            connection_count: local.connections.len() as f64,
            database_count: local.database_connections.len() as f64,
            knowledge_count: local.knowledge.len() as f64,
            http_request_count: local.http_requests.len() as f64,
        });
    };

    validate_modules_bundle_json(&bytes)?;
    let remote: ClientSyncModulesBundle = serde_json::from_slice(&bytes).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析云端模块同步数据失败").with_cause(e.to_string())
    })?;
    let merged = merge_bundles(local, remote);

    {
        let storage = state.storage.lock().await;
        apply_bundle(&storage, &merged)?;
    }

    let body = serde_json::to_vec(&merged).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化合并后模块数据失败").with_cause(e.to_string())
    })?;
    let _ = push_modules_json(&auth, &me.id.to_string(), &body).await;

    Ok(ClientSyncPullModulesResult {
        found: true,
        object_key,
        applied: true,
        workspaces_json: serde_json::to_string(&merged.workspaces).ok(),
        connection_count: merged.connections.len() as f64,
        database_count: merged.database_connections.len() as f64,
        knowledge_count: merged.knowledge.len() as f64,
        http_request_count: merged.http_requests.len() as f64,
    })
}
