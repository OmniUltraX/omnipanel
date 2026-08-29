//! 客户端选定团队「各业务模块」同步。
//! 路径：团队 OSS `modules/latest.json`；上传前端到端加密（sync_key_v2），凭据随快照一并同步。

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::assistant_cmds::build_auth_context;
use crate::auth_cmds::{
    auth_device_identity, auth_get_me, decode_sync_team_payload, encrypt_sync_team_payload,
    resolve_sync_team,
};
use omnipanel_assistant::{
    TEAM_MODULES_LATEST_LEAF, pull_team_sync_json, push_team_sync_json,
    validate_modules_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    Connection, ConnectionKind, DbConnectionConfig, HttpCollection, HttpEnvironment,
    KnowledgeEntry, SYNC_KIND_MODULES, SavedHttpRequest, SshKeyRecord, Vault, db_password_ref,
    load_database_connections, migrate_device_tags_to_creator, ssh_key_passphrase_ref,
    ssh_key_private_ref, ssh_passphrase_ref, ssh_password_ref, ssh_pem_ref,
};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;

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
pub struct ClientSyncVaultSecret {
    pub reference: String,
    pub value: String,
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
    /// 资源标签列表；工作区创建时打 `creator: <设备名>` 标记创建设备。
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
    /// 首页自定义面板 JSON：`{ customPanels, deletedIds }`。旧快照缺此字段则为空。
    #[serde(default)]
    pub custom_panels_json: Option<String>,
    /// 已删除的自定义面板（前端 tombstone）。
    #[serde(default)]
    pub deleted_custom_panels: Vec<ClientSyncTombstone>,
    /// 连接相关 Vault 凭据（团队 sync_key_v2 加密后随快照同步）。
    #[serde(default)]
    pub vault_secrets: Vec<ClientSyncVaultSecret>,
    #[serde(default)]
    pub ssh_keys: Vec<SshKeyRecord>,
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
    /// 首页自定义面板 JSON；由前端从 dashboardStore 序列化。
    #[serde(default)]
    pub custom_panels_json: Option<String>,
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
    #[serde(default)]
    pub deleted_custom_panels: Vec<ClientSyncTombstone>,
    /// 可选团队 ID；缺省回退到默认个人团队。
    #[serde(default)]
    pub team_id: Option<i64>,
}

/// 无业务资源且无删除墓碑的「空洞」快照（典型：新空设备误推）。
/// 仅有工作区不算有效业务快照，避免误判为可整表覆盖。
fn bundle_is_vacuous_empty(bundle: &ClientSyncModulesBundle) -> bool {
    bundle.connections.is_empty()
        && bundle.database_connections.is_empty()
        && bundle.knowledge.is_empty()
        && bundle.http_collections.is_empty()
        && bundle.http_environments.is_empty()
        && bundle.http_requests.is_empty()
        && bundle.deleted_connections.is_empty()
        && bundle.deleted_databases.is_empty()
        && bundle.deleted_knowledge.is_empty()
        && bundle.deleted_http_requests.is_empty()
        && bundle.deleted_http_collections.is_empty()
        && bundle.deleted_http_environments.is_empty()
        && bundle.deleted_workspaces.is_empty()
        && bundle.deleted_custom_panels.is_empty()
        && !custom_panels_bundle_nonempty(bundle)
}

fn bundle_has_resources(bundle: &ClientSyncModulesBundle) -> bool {
    !bundle.connections.is_empty()
        || !bundle.database_connections.is_empty()
        || !bundle.knowledge.is_empty()
        || !bundle.http_collections.is_empty()
        || !bundle.http_environments.is_empty()
        || !bundle.http_requests.is_empty()
        || custom_panels_bundle_nonempty(bundle)
}

fn custom_panels_bundle_nonempty(bundle: &ClientSyncModulesBundle) -> bool {
    if !bundle.deleted_custom_panels.is_empty() {
        return true;
    }
    let Some(raw) = bundle
        .custom_panels_json
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        return false;
    };
    let has_panels = value
        .get("customPanels")
        .and_then(|v| v.as_object())
        .map(|m| !m.is_empty())
        .unwrap_or(false);
    let has_deleted = value
        .get("deletedIds")
        .and_then(|v| v.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    has_panels || has_deleted
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

fn push_vault_secret(out: &mut Vec<ClientSyncVaultSecret>, reference: String) {
    if out.iter().any(|entry| entry.reference == reference) {
        return;
    }
    if let Ok(value) = Vault::get(&reference) {
        if value.is_empty() {
            return;
        }
        out.push(ClientSyncVaultSecret { reference, value });
    }
}

fn collect_connection_vault_secrets(conn: &Connection, out: &mut Vec<ClientSyncVaultSecret>) {
    match conn.kind {
        ConnectionKind::Ssh => {
            push_vault_secret(out, ssh_password_ref(&conn.id));
            push_vault_secret(out, ssh_pem_ref(&conn.id));
            push_vault_secret(out, ssh_passphrase_ref(&conn.id));
        }
        ConnectionKind::File => {
            push_vault_secret(out, format!("file-cred-{}", conn.id));
        }
        ConnectionKind::Panel => {
            push_vault_secret(out, format!("panel-key-{}", conn.id));
            if let Some(r) = conn.credential_ref.as_deref() {
                if !r.is_empty() {
                    push_vault_secret(out, r.to_string());
                }
            }
        }
        ConnectionKind::Cloud => {
            if let Some(r) = conn.credential_ref.as_deref() {
                if !r.is_empty() {
                    push_vault_secret(out, r.to_string());
                }
            }
        }
        ConnectionKind::Docker => {
            push_vault_secret(out, format!("docker-ssh-password-{}", conn.id));
            push_vault_secret(out, format!("docker-ssh-pem-{}", conn.id));
            push_vault_secret(out, format!("docker-onepanel-{}", conn.id));
            push_vault_secret(out, format!("docker-btpanel-{}", conn.id));
            push_vault_secret(out, format!("docker-btpanel-session-{}", conn.id));
        }
        _ => {}
    }
}

fn collect_bundle_vault_secrets(
    connections: &[ClientSyncConnectionItem],
    ssh_keys: &[SshKeyRecord],
) -> Vec<ClientSyncVaultSecret> {
    let mut out = Vec::new();
    for item in connections {
        collect_connection_vault_secrets(&item.connection, &mut out);
    }
    for key in ssh_keys {
        push_vault_secret(&mut out, ssh_key_private_ref(&key.id));
        push_vault_secret(&mut out, ssh_key_passphrase_ref(&key.id));
    }
    out
}

fn restore_vault_secret(reference: &str, value: &str) {
    let reference = reference.trim();
    let value = value.trim();
    if reference.is_empty() || value.is_empty() {
        return;
    }
    let _ = Vault::store(reference, value);
}

fn collect_connection_items(
    storage: &omnipanel_store::Storage,
) -> Result<Vec<ClientSyncConnectionItem>, OmniError> {
    let list = storage.list_connections()?;
    let mut out = Vec::with_capacity(list.len());
    for connection in list {
        let secret = Vault::get(&ssh_password_ref(&connection.id))
            .ok()
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
    let connections = collect_connection_items(storage)?;
    let database_connections = collect_database_items()?;
    let ssh_keys = storage.list_ssh_keys()?;
    let vault_secrets = collect_bundle_vault_secrets(&connections, &ssh_keys);
    Ok(ClientSyncModulesBundle {
        schema_version: SCHEMA_VERSION,
        kind: MODULES_KIND.to_string(),
        updated_at: now_ms(),
        connections,
        deleted_connections: request.deleted_connections.clone(),
        database_connections,
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
        custom_panels_json: parse_json_object_string(request.custom_panels_json.as_deref()),
        deleted_custom_panels: request.deleted_custom_panels.clone(),
        vault_secrets,
        ssh_keys,
    })
}

/// 推送本机模块快照到默认个人团队 OSS（`modules/latest.json`）。
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
    let team = resolve_sync_team(request.team_id, &me)?;
    let team_id = team.id;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;

    let bundle = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &request)?
    };

    // 新空设备误推会覆盖云端真实快照；无资源且无墓碑时若远端仍有数据则跳过上传。
    if bundle_is_vacuous_empty(&bundle) {
        if let Some((object_key, bytes)) =
            pull_team_sync_json(&auth, team_id, TEAM_MODULES_LATEST_LEAF).await?
        {
            if let Ok(plain) = decode_sync_team_payload(&me, team, SYNC_KIND_MODULES, &bytes) {
                if let Ok(remote) = serde_json::from_slice::<ClientSyncModulesBundle>(&plain) {
                    if bundle_has_resources(&remote) {
                        return Ok(ClientSyncPushModulesResult {
                            object_key,
                            etag: None,
                            bytes: bytes.len() as f64,
                        });
                    }
                }
            }
        }
    }

    let plaintext = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&plaintext)?;
    let body = encrypt_sync_team_payload(team_id, SYNC_KIND_MODULES, &plaintext)?;
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
    /// 首页自定义面板 JSON，由前端写入 dashboardStore。
    pub custom_panels_json: Option<String>,
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

async fn apply_modules_bundle(
    state: &crate::state::ServerState,
    bundle: &ClientSyncModulesBundle,
) -> Result<
    (
        usize,
        usize,
        usize,
        usize,
        usize,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    OmniError,
> {
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
    let remote_req_ids: HashSet<String> =
        bundle.http_requests.iter().map(|r| r.id.clone()).collect();
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

    // 名称/备注为设备本地字段，不参与云端同步：应用云端快照时保留本地已有资源的名称/备注。
    let (local_conn_names, local_kn_titles, local_req_names, local_col_meta, local_env_names) = {
        let storage = state.storage.lock().await;
        (
            storage
                .list_connections()?
                .into_iter()
                .map(|c| (c.id, c.name))
                .collect::<HashMap<String, String>>(),
            storage
                .list_knowledge(None, None)?
                .into_iter()
                .map(|e| (e.id, e.title))
                .collect::<HashMap<String, String>>(),
            storage
                .http_list_requests(None)?
                .into_iter()
                .map(|r| (r.id, r.name))
                .collect::<HashMap<String, String>>(),
            storage
                .http_list_collections()?
                .into_iter()
                .map(|c| (c.id, (c.name, c.description)))
                .collect::<HashMap<String, (String, String)>>(),
            storage
                .http_list_environments()?
                .into_iter()
                .map(|e| (e.id, e.name))
                .collect::<HashMap<String, String>>(),
        )
    };
    let local_db_names: HashMap<String, String> = state
        .db_connections
        .list()?
        .into_iter()
        .map(|c| (c.id, c.name))
        .collect();

    for item in &bundle.database_connections {
        let mut c = item.connection.clone();
        c.password.clear();
        if let Some(pw) = item.secret.as_deref().filter(|s| !s.is_empty()) {
            restore_vault_secret(&db_password_ref(&c.id), pw);
            c.has_password = true;
        }
        if let Some(name) = local_db_names.get(&c.id) {
            c.name = name.clone();
        }
        state.db_connections.save(c)?;
    }

    {
        let storage = state.storage.lock().await;
        for item in &bundle.connections {
            let mut conn = item.connection.clone();
            if let Some(name) = local_conn_names.get(&conn.id) {
                conn.name = name.clone();
            }
            storage.save_connection(&conn)?;
            if let Some(pw) = item.secret.as_deref().filter(|s| !s.is_empty()) {
                restore_vault_secret(&ssh_password_ref(&conn.id), pw);
            }
        }
        for entry in &bundle.knowledge {
            let mut e = entry.clone();
            if let Some(title) = local_kn_titles.get(&e.id) {
                e.title = title.clone();
            }
            storage.save_knowledge(&e)?;
        }
        for col in &bundle.http_collections {
            let mut c = col.clone();
            if let Some((name, description)) = local_col_meta.get(&c.id) {
                c.name = name.clone();
                c.description = description.clone();
            }
            storage.http_save_collection(&c)?;
        }
        for env in &bundle.http_environments {
            let mut e = env.clone();
            if let Some(name) = local_env_names.get(&e.id) {
                e.name = name.clone();
            }
            storage.http_save_environment(&e)?;
        }
        for req in &bundle.http_requests {
            let mut r = req.clone();
            if let Some(name) = local_req_names.get(&r.id) {
                r.name = name.clone();
            }
            storage.http_save_request(&r)?;
        }
    }

    for entry in &bundle.vault_secrets {
        restore_vault_secret(&entry.reference, &entry.value);
    }

    {
        let storage = state.storage.lock().await;
        for key in &bundle.ssh_keys {
            storage.save_ssh_key_record(key)?;
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
    let custom_panels_json = bundle.custom_panels_json.clone();

    Ok((
        applied_connections,
        applied_databases,
        applied_knowledge,
        applied_http_requests,
        applied_workspaces,
        workspaces_json,
        ssh_sidebar_tree_json,
        folder_trees_json,
        custom_panels_json,
    ))
}

/// 从默认个人团队 OSS 拉取模块快照并应用到本机。
pub async fn client_sync_pull_modules(
    state: &crate::state::ServerState,
    request: ClientSyncPullModulesRequest,
) -> Result<ClientSyncPullModulesResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法拉取模块同步数据",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(request.token.clone()).await?;
    let team = resolve_sync_team(request.team_id, &me)?;
    let team_id = team.id;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;

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
            custom_panels_json: None,
        });
    };

    let plaintext = decode_sync_team_payload(&me, team, SYNC_KIND_MODULES, &bytes)?;
    validate_modules_bundle_json(&plaintext)?;
    let bundle: ClientSyncModulesBundle = serde_json::from_slice(&plaintext).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析云端模块快照失败").with_cause(e.to_string())
    })?;

    // 空洞快照（无资源无墓碑）视为无效，避免把本机已有数据整表清空。
    if bundle_is_vacuous_empty(&bundle) {
        return Ok(ClientSyncPullModulesResult {
            found: false,
            object_key: Some(object_key),
            bytes: bytes.len() as f64,
            applied_connections: 0.0,
            applied_databases: 0.0,
            applied_knowledge: 0.0,
            applied_http_requests: 0.0,
            applied_workspaces: 0.0,
            workspaces_json: None,
            ssh_sidebar_tree_json: None,
            folder_trees_json: None,
            custom_panels_json: None,
        });
    }

    let (
        applied_connections,
        applied_databases,
        applied_knowledge,
        applied_http_requests,
        applied_workspaces,
        workspaces_json,
        ssh_sidebar_tree_json,
        folder_trees_json,
        custom_panels_json,
    ) = apply_modules_bundle(state, &bundle).await?;

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
        custom_panels_json,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncMigrateDeviceTagsRequest {
    /// 账号设备名列表（前端 authListDevices 获取），用于识别资源上的旧设备名标签。
    #[serde(default)]
    pub device_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncMigrateDeviceTagsResult {
    /// 是否有任何资源标签被改写（供前端决定是否回推云端快照）。
    pub changed: bool,
    pub connections: f64,
    pub databases: f64,
    pub knowledge: f64,
    pub http_requests: f64,
    pub http_collections: f64,
    pub http_environments: f64,
}

/// 将本机资源上的旧设备名标签迁移为 `creator:` 标签（幂等，可重复执行）。
///
/// 工作区标签存于前端 localStorage，由前端迁移编排器一并处理。
pub async fn client_sync_migrate_device_tags(
    state: &crate::state::ServerState,
    request: ClientSyncMigrateDeviceTagsRequest,
) -> Result<ClientSyncMigrateDeviceTagsResult, OmniError> {
    let current = crate::auth_cmds::current_device_name();
    let mut device_names = request.device_names;
    if !device_names.iter().any(|n| n.trim() == current.trim()) {
        device_names.push(current.clone());
    }

    let mut result = ClientSyncMigrateDeviceTagsResult {
        changed: false,
        connections: 0.0,
        databases: 0.0,
        knowledge: 0.0,
        http_requests: 0.0,
        http_collections: 0.0,
        http_environments: 0.0,
    };

    {
        let storage = state.storage.lock().await;
        for mut conn in storage.list_connections()? {
            if migrate_device_tags_to_creator(&mut conn.tags, &device_names, &current) {
                storage.save_connection(&conn)?;
                result.connections += 1.0;
            }
        }
        for mut entry in storage.list_knowledge(None, None)? {
            if migrate_device_tags_to_creator(&mut entry.tags, &device_names, &current) {
                storage.save_knowledge(&entry)?;
                result.knowledge += 1.0;
            }
        }
        for mut req in storage.http_list_requests(None)? {
            if migrate_device_tags_to_creator(&mut req.tags, &device_names, &current) {
                storage.http_save_request(&req)?;
                result.http_requests += 1.0;
            }
        }
        for mut col in storage.http_list_collections()? {
            if migrate_device_tags_to_creator(&mut col.tags, &device_names, &current) {
                storage.http_save_collection(&col)?;
                result.http_collections += 1.0;
            }
        }
        for mut env in storage.http_list_environments()? {
            if migrate_device_tags_to_creator(&mut env.tags, &device_names, &current) {
                storage.http_save_environment(&env)?;
                result.http_environments += 1.0;
            }
        }
    }

    for mut db in state.db_connections.list()? {
        if migrate_device_tags_to_creator(&mut db.tags, &device_names, &current) {
            state.db_connections.save(db)?;
            result.databases += 1.0;
        }
    }

    result.changed = result.connections > 0.0
        || result.databases > 0.0
        || result.knowledge > 0.0
        || result.http_requests > 0.0
        || result.http_collections > 0.0
        || result.http_environments > 0.0;
    Ok(result)
}
