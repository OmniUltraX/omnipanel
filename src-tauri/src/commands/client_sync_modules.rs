//! 客户端选定团队「各业务模块」同步。
//! 路径：团队 OSS `modules/latest.json`；上传前端到端加密（sync_key_v2），凭据随快照一并同步。

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_assistant::{
    pull_team_sync_json, push_team_sync_json, validate_modules_bundle_json, TEAM_MODULES_LATEST_LEAF,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    db_password_ref, load_database_connections, ssh_key_passphrase_ref, ssh_key_private_ref,
    ssh_passphrase_ref, ssh_pem_ref, ssh_password_ref, Connection, ConnectionKind, DbConnectionConfig,
    HttpCollection, HttpEnvironment, KnowledgeEntry, SavedHttpRequest, SshKeyRecord, Vault,
    SYNC_KIND_MODULES,
};
use serde::{Deserialize, Deserializer, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::auth::{
    auth_device_identity, auth_get_me, decode_sync_team_payload, encrypt_sync_team_payload,
    resolve_sync_team,
};
use crate::commands::assistant::build_auth_context;
use crate::commands::ssh::materialize_ssh_connection_keys_for_sync;
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
    /// 首页自定义面板 JSON：`{ customPanels, deletedIds }`。旧快照缺此字段则为空。
    #[serde(default)]
    pub custom_panels_json: Option<String>,
    /// 已删除的自定义面板（前端 tombstone）。
    #[serde(default)]
    pub deleted_custom_panels: Vec<ClientSyncTombstone>,
    /// 连接相关 Vault 凭据（团队 sync_key_v2 加密后随快照同步）。
    #[serde(default)]
    pub vault_secrets: Vec<ClientSyncVaultSecret>,
    /// SSH 密钥库元数据（私钥在 vault_secrets 中同步）。
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

const SIDEBAR_TREE_ROOT_KEY: &str = "__root__";
/// OpenSSH 配置导入主机的分组标识；侧栏树为唯一布局来源，预览不再用 legacy group 文件夹表示。
const OPENSSH_CONFIG_GROUP: &str = "~/.ssh/config";

fn rewrite_json_option(raw: &mut Option<String>, mutator: impl FnOnce(&mut serde_json::Value)) {
    let Some(text) = raw.as_mut() else {
        return;
    };
    if text.trim().is_empty() {
        return;
    }
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(text) else {
        return;
    };
    mutator(&mut value);
    if let Ok(next) = serde_json::to_string(&value) {
        *text = next;
    }
}

/// 修剪侧栏布局 JSON 中已删除资源的引用，并补齐仍存在的连接节点。
fn normalize_sidebar_tree_json(tree: &mut serde_json::Value, valid_ids: &HashSet<String>) {
    let Some(obj) = tree.as_object_mut() else {
        return;
    };

    let dismissed: HashSet<String> = obj
        .get("dismissedAutoFolders")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !dismissed.is_empty() {
        let mut removed_folder_ids: HashSet<String> = HashSet::new();
        if let Some(folders) = obj.get_mut("folders").and_then(|v| v.as_array_mut()) {
            folders.retain(|folder| {
                let name = folder
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if dismissed.contains(name) {
                    if let Some(id) = folder.get("id").and_then(|v| v.as_str()) {
                        removed_folder_ids.insert(id.to_string());
                    }
                    false
                } else {
                    true
                }
            });
        }
        if !removed_folder_ids.is_empty() {
            for key in ["connectionFolderId", "connectionParents"] {
                if let Some(map) = obj.get_mut(key).and_then(|v| v.as_object_mut()) {
                    map.retain(|_, folder_id| {
                        folder_id
                            .as_str()
                            .map(|id| !removed_folder_ids.contains(id))
                            .unwrap_or(true)
                    });
                }
            }
            if let Some(order) = obj.get_mut("orderByParent").and_then(|v| v.as_object_mut()) {
                for (_, arr) in order.iter_mut() {
                    if let Some(items) = arr.as_array_mut() {
                        items.retain(|item| {
                            let Some(key) = item.as_str() else {
                                return false;
                            };
                            if let Some(id) = key.strip_prefix("f:") {
                                return !removed_folder_ids.contains(id);
                            }
                            true
                        });
                    }
                }
                for folder_id in &removed_folder_ids {
                    order.remove(folder_id);
                }
            }
        }
    }

    for key in ["connectionFolderId", "connectionParents"] {
        if let Some(map) = obj.get_mut(key).and_then(|v| v.as_object_mut()) {
            map.retain(|conn_id, _| valid_ids.contains(conn_id));
        }
    }

    let mut folder_for_conn: HashMap<String, String> = HashMap::new();
    if let Some(map) = obj
        .get("connectionFolderId")
        .or_else(|| obj.get("connectionParents"))
        .and_then(|v| v.as_object())
    {
        for (conn_id, folder_id) in map {
            if let Some(fid) = folder_id.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                if valid_ids.contains(conn_id) {
                    folder_for_conn.insert(conn_id.clone(), fid.to_string());
                }
            }
        }
    }

    if !obj.contains_key("orderByParent") {
        obj.insert(
            "orderByParent".to_string(),
            serde_json::json!({ SIDEBAR_TREE_ROOT_KEY: [] }),
        );
    }
    if let Some(order) = obj.get_mut("orderByParent").and_then(|v| v.as_object_mut()) {
        for (_, arr) in order.iter_mut() {
            if let Some(items) = arr.as_array_mut() {
                items.retain(|item| {
                    let Some(key) = item.as_str() else {
                        return false;
                    };
                    if let Some(id) = key.strip_prefix("c:") {
                        return valid_ids.contains(id);
                    }
                    true
                });
            }
        }

        for conn_id in valid_ids {
            let conn_key = format!("c:{conn_id}");
            let parent_key = folder_for_conn
                .get(conn_id.as_str())
                .map(|s| s.as_str())
                .unwrap_or(SIDEBAR_TREE_ROOT_KEY);
            let parent_arr = order
                .entry(parent_key.to_string())
                .or_insert_with(|| serde_json::json!([]));
            let Some(items) = parent_arr.as_array_mut() else {
                continue;
            };
            if !items.iter().any(|item| item.as_str() == Some(conn_key.as_str())) {
                items.push(serde_json::Value::String(conn_key));
            }
        }
    }
}

fn normalize_protocol_layout_json(
    tree: &mut serde_json::Value,
    valid_collection_ids: &HashSet<String>,
    valid_request_ids: &HashSet<String>,
) {
    normalize_sidebar_tree_json(tree, valid_collection_ids);
    let Some(obj) = tree.as_object_mut() else {
        return;
    };
    if let Some(map) = obj.get_mut("collectionParents").and_then(|v| v.as_object_mut()) {
        map.retain(|id, _| valid_collection_ids.contains(id));
    }
    if let Some(map) = obj.get_mut("requestParents").and_then(|v| v.as_object_mut()) {
        map.retain(|id, _| valid_request_ids.contains(id));
    }
    if let Some(map) = obj.get_mut("entryParents").and_then(|v| v.as_object_mut()) {
        map.retain(|id, _| valid_request_ids.contains(id));
    }
}

/// 上传前对齐各模块侧栏布局与 bundle 内资源 ID，避免 OSS 快照与本机 UI 不一致。
pub(crate) fn normalize_modules_bundle_layouts(bundle: &mut ClientSyncModulesBundle) {
    let ssh_ids: HashSet<String> = bundle
        .connections
        .iter()
        .filter(|c| c.connection.kind == ConnectionKind::Ssh)
        .map(|c| c.connection.id.clone())
        .collect();
    let docker_ids: HashSet<String> = bundle
        .connections
        .iter()
        .filter(|c| c.connection.kind == ConnectionKind::Docker)
        .map(|c| c.connection.id.clone())
        .collect();
    let db_ids: HashSet<String> = bundle
        .database_connections
        .iter()
        .map(|d| d.connection.id.clone())
        .collect();
    let http_collection_ids: HashSet<String> =
        bundle.http_collections.iter().map(|c| c.id.clone()).collect();
    let http_request_ids: HashSet<String> =
        bundle.http_requests.iter().map(|r| r.id.clone()).collect();

    rewrite_json_option(&mut bundle.ssh_sidebar_tree_json, |tree| {
        normalize_sidebar_tree_json(tree, &ssh_ids);
    });

    rewrite_json_option(&mut bundle.folder_trees_json, |folder_trees| {
        let Some(map) = folder_trees.as_object_mut() else {
            return;
        };
        if let Some(docker) = map.get_mut("docker") {
            normalize_sidebar_tree_json(docker, &docker_ids);
        }
        if let Some(database) = map.get_mut("database") {
            normalize_sidebar_tree_json(database, &db_ids);
        }
        if let Some(protocol) = map.get_mut("protocol") {
            normalize_protocol_layout_json(protocol, &http_collection_ids, &http_request_ids);
        }
    });
}

/// 上传/预览对齐：修剪布局 → 补设备标签。
pub(crate) fn finalize_modules_bundle_for_upload(
    bundle: &mut ClientSyncModulesBundle,
    device_name: &str,
) {
    normalize_modules_bundle_layouts(bundle);
    if !device_name.is_empty() {
        tag_bundle_with_device(bundle, device_name);
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

pub(crate) fn collect_local_bundle(
    storage: &omnipanel_store::Storage,
    request: &ClientSyncPushModulesRequest,
) -> Result<ClientSyncModulesBundle, OmniError> {
    let _ = materialize_ssh_connection_keys_for_sync(storage);
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
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;

    let mut bundle = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &request)?
    };
    let device_name = identity.device_name.trim().to_string();
    finalize_modules_bundle_for_upload(&mut bundle, &device_name);

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

pub(crate) async fn apply_modules_bundle(
    state: &AppState,
    bundle: &ClientSyncModulesBundle,
) -> Result<(usize, usize, usize, usize, usize, Option<String>, Option<String>, Option<String>, Option<String>), OmniError> {
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
        c.password.clear();
        if let Some(pw) = item.secret.as_deref().filter(|s| !s.is_empty()) {
            restore_vault_secret(&db_password_ref(&c.id), pw);
            c.has_password = true;
        }
        state.db_connections.save(c)?;
    }

    {
        let storage = state.storage.lock().await;
        for item in &bundle.connections {
            storage.save_connection(&item.connection)?;
            if let Some(pw) = item.secret.as_deref().filter(|s| !s.is_empty()) {
                restore_vault_secret(&ssh_password_ref(&item.connection.id), pw);
            }
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

    let ssh_touched = replace_conn
        || !deleted_conn.is_empty()
        || bundle
            .connections
            .iter()
            .any(|item| item.connection.kind == ConnectionKind::Ssh);
    if ssh_touched {
        state
            .ssh_pool
            .reload_hosts(state.storage.clone(), state.app_handle.clone(), false)
            .await;
    }

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
            custom_panels_json: None,
        });
    };

    let plaintext = decode_sync_team_payload(&me, team, SYNC_KIND_MODULES, &bytes)?;
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
        custom_panels_json,
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
        custom_panels_json,
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
    pub custom_panels: Vec<ClientSyncPeekItem>,
}

#[derive(Clone, Default)]
struct SidebarTreePeek {
    folders: Vec<(String, String, String)>, // id, name, parent_id
    connection_folder_id: HashMap<String, String>,
    dismissed_folder_names: HashSet<String>,
}

fn parse_dismissed_folder_names(value: &serde_json::Value) -> HashSet<String> {
    value
        .get("dismissedAutoFolders")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::trim).filter(|s| !s.is_empty()))
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn prune_dismissed_sidebar_folders(tree: &mut SidebarTreePeek) {
    if tree.dismissed_folder_names.is_empty() {
        return;
    }
    let mut removed_ids: HashSet<String> = HashSet::new();
    tree.folders.retain(|(id, name, _)| {
        if tree.dismissed_folder_names.contains(name.as_str()) {
            removed_ids.insert(id.clone());
            false
        } else {
            true
        }
    });
    if removed_ids.is_empty() {
        return;
    }
    tree.connection_folder_id
        .retain(|_, folder_id| !removed_ids.contains(folder_id));
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
    out.dismissed_folder_names = parse_dismissed_folder_names(value);
    prune_dismissed_sidebar_folders(&mut out);
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
        if tree.dismissed_folder_names.contains(name.as_str()) {
            continue;
        }
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

pub(crate) fn dismissed_ssh_folder_names_from_bundle(
    bundle: &ClientSyncModulesBundle,
) -> HashSet<String> {
    let Some(text) = bundle
        .ssh_sidebar_tree_json
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return HashSet::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return HashSet::new();
    };
    parse_dismissed_folder_names(&value)
}

/// 本机已 dismiss 的 SSH 侧栏文件夹，不再出现在团队数据预览（含云端残留项）。
pub(crate) fn filter_dismissed_ssh_layout_folders(
    items: &mut Vec<ClientSyncPeekItem>,
    dismissed: &HashSet<String>,
) {
    if dismissed.is_empty() {
        return;
    }
    let removed_ids: HashSet<String> = items
        .iter()
        .filter(|item| item.kind == "folder" && dismissed.contains(item.label.as_str()))
        .map(|item| item.id.clone())
        .collect();
    items.retain(|item| {
        if item.kind == "folder" && dismissed.contains(item.label.as_str()) {
            return false;
        }
        if let Some(group) = item.id.strip_prefix("__group__:") {
            if dismissed.contains(group) {
                return false;
            }
        }
        true
    });
    for item in items.iter_mut() {
        if removed_ids.contains(item.parent_id.as_str()) {
            item.parent_id.clear();
        }
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
        custom_panels: parse_custom_panels_peek(bundle.custom_panels_json.as_deref()),
    }
}

fn parse_custom_panels_peek(raw: Option<&str>) -> Vec<ClientSyncPeekItem> {
    let Some(text) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(map) = value.get("customPanels").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut items = Vec::with_capacity(map.len());
    for (id, panel) in map {
        let label = panel
            .get("label")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(id);
        let created_at = panel.get("createdAt").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let widget_n = panel
            .get("widgets")
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0);
        items.push(peek_item(
            id.clone(),
            label,
            format!("{widget_n}"),
            created_at,
            "",
            "item",
            Vec::new(),
        ));
    }
    items
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
        if group == OPENSSH_CONFIG_GROUP {
            continue;
        }
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
                if group.is_empty() || group == OPENSSH_CONFIG_GROUP {
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

