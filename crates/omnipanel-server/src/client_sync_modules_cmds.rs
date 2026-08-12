//! 客户端间「各业务模块」同步：按设备快照。
//! 路径：`sync/{userId}/devices/{deviceId}/modules/latest.json`
//! 数据变更时上传本机快照；从其它设备导入由用户手动触发。

use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_assistant::{
    pull_conversations_json, pull_modules_json, push_modules_json, validate_modules_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    db_password_ref, load_database_connections, Connection, DbConnectionConfig, HttpCollection,
    HttpEnvironment, KnowledgeEntry, SavedHttpRequest, Vault,
};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use crate::auth_cmds::{auth_device_identity, auth_get_me};
use crate::assistant_cmds::build_auth_context;

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

/// 推送本机模块快照到 `sync/{userId}/devices/{deviceId}/modules/latest.json`。
pub async fn client_sync_push_modules(
    state: &crate::state::ServerState,
    request: ClientSyncPushModulesRequest,
) -> Result<ClientSyncPushModulesResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法同步模块数据到云端",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(request.token.clone()).await?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;

    let bundle = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &request)?
    };

    let conn_n = bundle.connections.len();
    let db_n = bundle.database_connections.len();
    let kn_n = bundle.knowledge.len();
    let http_n = bundle.http_requests.len();

    let body = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&body)?;
    let uploaded =
        push_modules_json(&auth, &me.id.to_string(), &identity.device_id, &body).await?;

    tracing::info!(
        object_key = %uploaded.object_key,
        bytes = uploaded.bytes,
        connections = conn_n,
        databases = db_n,
        knowledge = kn_n,
        http_requests = http_n,
        "client_sync_push_modules ok"
    );

    Ok(ClientSyncPushModulesResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
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
}

fn peek_item(
    id: impl Into<String>,
    label: impl Into<String>,
    detail: impl Into<String>,
    updated_at: f64,
    parent_id: impl Into<String>,
    kind: &str,
) -> ClientSyncPeekItem {
    ClientSyncPeekItem {
        id: id.into(),
        label: label.into(),
        detail: detail.into(),
        updated_at,
        parent_id: parent_id.into(),
        kind: kind.to_string(),
    }
}

fn connection_group_folder_id(group: &str) -> String {
    format!("__group__:{group}")
}

fn build_connection_peek_items(
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
        ));
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPeekRequest {
    pub token: String,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncPeekResult {
    pub device_id: String,
    pub modules_found: bool,
    pub conversations_found: bool,
    pub modules_updated_at: f64,
    pub conversations_updated_at: f64,
    pub connections: Vec<ClientSyncPeekItem>,
    pub databases: Vec<ClientSyncPeekItem>,
    pub knowledge: Vec<ClientSyncPeekItem>,
    pub http_requests: Vec<ClientSyncPeekItem>,
    pub http_collections: Vec<ClientSyncPeekItem>,
    pub workspaces: Vec<ClientSyncPeekItem>,
    pub conversations: Vec<ClientSyncPeekItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncImportSelection {
    #[serde(default)]
    pub connection_ids: Vec<String>,
    #[serde(default)]
    pub database_ids: Vec<String>,
    #[serde(default)]
    pub knowledge_ids: Vec<String>,
    #[serde(default)]
    pub http_request_ids: Vec<String>,
    #[serde(default)]
    pub http_collection_ids: Vec<String>,
    #[serde(default)]
    pub workspace_ids: Vec<String>,
    #[serde(default)]
    pub conversation_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncImportRequest {
    pub token: String,
    pub device_id: String,
    pub selection: ClientSyncImportSelection,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncImportResult {
    pub applied_connections: f64,
    pub applied_databases: f64,
    pub applied_knowledge: f64,
    pub applied_http_requests: f64,
    pub applied_workspaces: f64,
    /// 勾选的工作区 JSON，由前端写入 workspaceStore。
    pub workspaces_json: Option<String>,
    /// 选中的会话完整 JSON（数组），由前端 merge 进 aiStore。
    pub conversations_json: Option<String>,
}

fn id_set(ids: &[String]) -> HashSet<String> {
    ids.iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn filter_bundle(bundle: ClientSyncModulesBundle, sel: &ClientSyncImportSelection) -> ClientSyncModulesBundle {
    let conn_ids = id_set(&sel.connection_ids);
    let db_ids = id_set(&sel.database_ids);
    let kn_ids = id_set(&sel.knowledge_ids);
    let req_ids = id_set(&sel.http_request_ids);
    let col_ids = id_set(&sel.http_collection_ids);
    let ws_ids = id_set(&sel.workspace_ids);

    let connections: Vec<_> = bundle
        .connections
        .into_iter()
        .filter(|c| conn_ids.contains(&c.connection.id))
        .collect();
    let database_connections: Vec<_> = bundle
        .database_connections
        .into_iter()
        .filter(|c| db_ids.contains(&c.connection.id))
        .collect();
    let knowledge: Vec<_> = bundle
        .knowledge
        .into_iter()
        .filter(|k| kn_ids.contains(&k.id))
        .collect();
    let http_requests: Vec<_> = bundle
        .http_requests
        .into_iter()
        .filter(|r| req_ids.contains(&r.id))
        .collect();
    let referenced_cols: HashSet<String> = http_requests
        .iter()
        .filter_map(|r| r.collection_id.clone())
        .collect();
    let referenced_envs: HashSet<String> = http_requests
        .iter()
        .filter_map(|r| r.environment_id.clone())
        .collect();
    let http_collections: Vec<_> = bundle
        .http_collections
        .into_iter()
        .filter(|c| col_ids.contains(&c.id) || referenced_cols.contains(&c.id))
        .collect();
    let http_environments: Vec<_> = bundle
        .http_environments
        .into_iter()
        .filter(|e| referenced_envs.contains(&e.id))
        .collect();
    let workspaces: Vec<_> = bundle
        .workspaces
        .into_iter()
        .filter(|w| ws_ids.contains(&w.id))
        .collect();

    ClientSyncModulesBundle {
        schema_version: SCHEMA_VERSION,
        kind: MODULES_KIND.to_string(),
        updated_at: now_ms(),
        connections,
        deleted_connections: Vec::new(),
        database_connections,
        deleted_databases: Vec::new(),
        knowledge,
        deleted_knowledge: Vec::new(),
        http_collections,
        http_environments,
        http_requests,
        deleted_http_requests: Vec::new(),
        deleted_http_collections: Vec::new(),
        deleted_http_environments: Vec::new(),
        workspaces,
        deleted_workspaces: Vec::new(),
    }
}

/// 预览其它设备可同步数据（不含正文大字段以外的列表元数据）。
pub async fn client_sync_peek_device(
    _state: &crate::state::ServerState,
    request: ClientSyncPeekRequest,
) -> Result<ClientSyncPeekResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录，无法预览同步数据"));
    }
    let device_id = request.device_id.trim().to_string();
    if device_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "deviceId 不能为空"));
    }

    let identity = auth_device_identity().await?;
    if device_id == identity.device_id {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "不能预览本机设备，请选择其它客户端",
        ));
    }

    let me = auth_get_me(request.token.clone()).await?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;
    let user_id = me.id.to_string();

    let mut result = ClientSyncPeekResult {
        device_id: device_id.clone(),
        modules_found: false,
        conversations_found: false,
        modules_updated_at: 0.0,
        conversations_updated_at: 0.0,
        connections: Vec::new(),
        databases: Vec::new(),
        knowledge: Vec::new(),
        http_requests: Vec::new(),
        http_collections: Vec::new(),
        workspaces: Vec::new(),
        conversations: Vec::new(),
    };

    if let Some((_, bytes)) = pull_modules_json(&auth, &user_id, &device_id).await? {
        if validate_modules_bundle_json(&bytes).is_ok() {
            if let Ok(bundle) = serde_json::from_slice::<ClientSyncModulesBundle>(&bytes) {
                result.modules_found = true;
                result.modules_updated_at = bundle.updated_at;
                result.connections = build_connection_peek_items(&bundle.connections);
                result.databases = bundle
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
                        )
                    })
                    .collect();
                result.knowledge = bundle
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
                        )
                    })
                    .collect();
                result.http_collections = bundle
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
                        )
                    })
                    .collect();
                result.http_requests = bundle
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
                        )
                    })
                    .collect();
                result.workspaces = bundle
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
                        )
                    })
                    .collect();
            }
        }
    }

    if let Some((_, bytes)) = pull_conversations_json(&auth, &user_id, &device_id).await? {
        if let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) {
            result.conversations_found = true;
            result.conversations_updated_at = value
                .get("updatedAt")
                .or_else(|| value.get("updated_at"))
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            if let Some(arr) = value.get("conversations").and_then(|v| v.as_array()) {
                for c in arr {
                    let id = c.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
                    if id.is_empty() {
                        continue;
                    }
                    let title = c
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("未命名会话")
                        .to_string();
                    let msg_n = c
                        .get("messages")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    let updated_at = c
                        .get("updatedAt")
                        .or_else(|| c.get("updated_at"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    result.conversations.push(peek_item(
                        id,
                        title,
                        format!("{msg_n} 条消息"),
                        updated_at,
                        "",
                        "item",
                    ));
                }
            }
        }
    }

    Ok(result)
}

/// 从其它设备导入勾选的数据到本机。
pub async fn client_sync_import_from_device(
    state: &crate::state::ServerState,
    request: ClientSyncImportRequest,
) -> Result<ClientSyncImportResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录，无法导入同步数据"));
    }
    let device_id = request.device_id.trim().to_string();
    if device_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "deviceId 不能为空"));
    }

    let identity = auth_device_identity().await?;
    if device_id == identity.device_id {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "不能从本机导入，请选择其它客户端",
        ));
    }

    let me = auth_get_me(request.token.clone()).await?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;
    let user_id = me.id.to_string();
    let sel = &request.selection;

    let mut applied_connections = 0usize;
    let mut applied_databases = 0usize;
    let mut applied_knowledge = 0usize;
    let mut applied_http_requests = 0usize;
    let mut applied_workspaces = 0usize;
    let mut conversations_json: Option<String> = None;
    let mut workspaces_json: Option<String> = None;

    let need_modules = !sel.connection_ids.is_empty()
        || !sel.database_ids.is_empty()
        || !sel.knowledge_ids.is_empty()
        || !sel.http_request_ids.is_empty()
        || !sel.http_collection_ids.is_empty()
        || !sel.workspace_ids.is_empty();

    if need_modules {
        let Some((_, bytes)) = pull_modules_json(&auth, &user_id, &device_id).await? else {
            return Err(OmniError::new(
                ErrorCode::NotFound,
                "目标设备尚无模块同步快照",
            ));
        };
        validate_modules_bundle_json(&bytes)?;
        let bundle: ClientSyncModulesBundle = serde_json::from_slice(&bytes).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析目标设备模块快照失败").with_cause(e.to_string())
        })?;
        let filtered = filter_bundle(bundle, sel);
        applied_connections = filtered.connections.len();
        applied_databases = filtered.database_connections.len();
        applied_knowledge = filtered.knowledge.len();
        applied_http_requests = filtered.http_requests.len();
        applied_workspaces = filtered.workspaces.len();
        workspaces_json = serde_json::to_string(&filtered.workspaces).ok();

        if !filtered.database_connections.is_empty() {
            for item in &filtered.database_connections {
                let mut c = item.connection.clone();
                // 密码经 Vault 恢复；有 secret 时写入本机钥匙串
                if let Some(secret) = item.secret.as_deref().filter(|s| !s.is_empty()) {
                    c.password = secret.to_string();
                } else {
                    c.password.clear();
                }
                state.db_connections.save(c)?;
            }
        }

        {
            let storage = state.storage.lock().await;
            for item in &filtered.connections {
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
            for entry in &filtered.knowledge {
                storage.save_knowledge(entry)?;
            }
            for col in &filtered.http_collections {
                storage.http_save_collection(col)?;
            }
            for env in &filtered.http_environments {
                storage.http_save_environment(env)?;
            }
            for req in &filtered.http_requests {
                storage.http_save_request(req)?;
            }
        }
    }

    if !sel.conversation_ids.is_empty() {
        let Some((_, bytes)) = pull_conversations_json(&auth, &user_id, &device_id).await? else {
            return Err(OmniError::new(
                ErrorCode::NotFound,
                "目标设备尚无会话同步快照",
            ));
        };
        let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析目标设备会话快照失败").with_cause(e.to_string())
        })?;
        let want = id_set(&sel.conversation_ids);
        let selected: Vec<serde_json::Value> = value
            .get("conversations")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter(|c| {
                        c.get("id")
                            .and_then(|v| v.as_str())
                            .map(|id| want.contains(id))
                            .unwrap_or(false)
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        conversations_json = Some(serde_json::to_string(&selected).unwrap_or_else(|_| "[]".into()));
    }

    Ok(ClientSyncImportResult {
        applied_connections: applied_connections as f64,
        applied_databases: applied_databases as f64,
        applied_knowledge: applied_knowledge as f64,
        applied_http_requests: applied_http_requests as f64,
        applied_workspaces: applied_workspaces as f64,
        workspaces_json,
        conversations_json,
    })
}

