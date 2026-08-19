//! 团队 OSS 数据同步：分享自定义面板、团队模块快照等。

use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Utc;
use omnipanel_assistant::{
    load_team_share_index, notify_team_share_created, pull_team_sync_json, push_team_sync_json,
    save_team_share_index, team_share_item_key, validate_team_share_bundle_json, TeamShareIndexItem,
    TEAM_MODULES_LATEST_LEAF, TEAM_SYNC_SCHEMA_VERSION,
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
    build_peek_from_bundle, collect_local_bundle, ClientSyncModulesBundle,
    ClientSyncPeekItem, ClientSyncPushModulesRequest,
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
    #[serde(default)]
    pub excluded_connections: Vec<String>,
    #[serde(default)]
    pub excluded_databases: Vec<String>,
    #[serde(default)]
    pub excluded_knowledge: Vec<String>,
    #[serde(default)]
    pub excluded_http_requests: Vec<String>,
    #[serde(default)]
    pub excluded_http_collections: Vec<String>,
    #[serde(default)]
    pub excluded_workspaces: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPeekModulesRequest {
    pub token: String,
    #[specta(type = f64)]
    pub team_id: i64,
    #[serde(default)]
    pub workspaces_json: Option<String>,
    #[serde(default)]
    pub excluded_connections: Vec<String>,
    #[serde(default)]
    pub excluded_databases: Vec<String>,
    #[serde(default)]
    pub excluded_knowledge: Vec<String>,
    #[serde(default)]
    pub excluded_http_requests: Vec<String>,
    #[serde(default)]
    pub excluded_http_collections: Vec<String>,
    #[serde(default)]
    pub excluded_workspaces: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum TeamSyncPeekSyncStatus {
    Synced,
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPeekItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub detail: String,
    pub updated_at: f64,
    #[serde(default)]
    pub parent_id: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_status: Option<TeamSyncPeekSyncStatus>,
    pub excluded: bool,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPeekModule {
    pub key: String,
    pub items: Vec<TeamSyncPeekItem>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamSyncPeekResult {
    pub remote_found: bool,
    pub local_updated_at: f64,
    pub remote_updated_at: f64,
    pub modules: Vec<TeamSyncPeekModule>,
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
        team_id: None,
    }
}

fn to_peek_modules_request(request: &TeamSyncPeekModulesRequest) -> ClientSyncPushModulesRequest {
    ClientSyncPushModulesRequest {
        token: request.token.clone(),
        workspaces_json: request.workspaces_json.clone(),
        deleted_connections: Vec::new(),
        deleted_databases: Vec::new(),
        deleted_knowledge: Vec::new(),
        deleted_http_requests: Vec::new(),
        deleted_http_collections: Vec::new(),
        deleted_http_environments: Vec::new(),
        deleted_workspaces: Vec::new(),
        team_id: None,
    }
}

fn parse_id_set(ids: &[String]) -> HashSet<String> {
    ids.iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[derive(Debug, Clone, Default)]
struct TeamSyncExclusionSets {
    connections: HashSet<String>,
    databases: HashSet<String>,
    knowledge: HashSet<String>,
    http_requests: HashSet<String>,
    http_collections: HashSet<String>,
    workspaces: HashSet<String>,
}

fn parse_exclusions(
    excluded_connections: &[String],
    excluded_databases: &[String],
    excluded_knowledge: &[String],
    excluded_http_requests: &[String],
    excluded_http_collections: &[String],
    excluded_workspaces: &[String],
) -> TeamSyncExclusionSets {
    TeamSyncExclusionSets {
        connections: parse_id_set(excluded_connections),
        databases: parse_id_set(excluded_databases),
        knowledge: parse_id_set(excluded_knowledge),
        http_requests: parse_id_set(excluded_http_requests),
        http_collections: parse_id_set(excluded_http_collections),
        workspaces: parse_id_set(excluded_workspaces),
    }
}

fn exclusions_from_push(request: &TeamSyncPushModulesRequest) -> TeamSyncExclusionSets {
    parse_exclusions(
        &request.excluded_connections,
        &request.excluded_databases,
        &request.excluded_knowledge,
        &request.excluded_http_requests,
        &request.excluded_http_collections,
        &request.excluded_workspaces,
    )
}

fn exclusions_from_peek(request: &TeamSyncPeekModulesRequest) -> TeamSyncExclusionSets {
    parse_exclusions(
        &request.excluded_connections,
        &request.excluded_databases,
        &request.excluded_knowledge,
        &request.excluded_http_requests,
        &request.excluded_http_collections,
        &request.excluded_workspaces,
    )
}

fn knowledge_excluded_ids(
    bundle: &ClientSyncModulesBundle,
    direct: &HashSet<String>,
) -> HashSet<String> {
    let mut out = direct.clone();
    loop {
        let mut changed = false;
        for entry in &bundle.knowledge {
            if out.contains(&entry.id) {
                continue;
            }
            let parent = entry.parent_id.trim();
            if !parent.is_empty() && out.contains(parent) {
                out.insert(entry.id.clone());
                changed = true;
            }
        }
        if !changed {
            break;
        }
    }
    out
}

fn apply_team_sync_exclusions(
    mut bundle: ClientSyncModulesBundle,
    ex: &TeamSyncExclusionSets,
) -> ClientSyncModulesBundle {
    bundle
        .connections
        .retain(|c| !ex.connections.contains(&c.connection.id));
    bundle
        .database_connections
        .retain(|c| !ex.databases.contains(&c.connection.id));
    bundle.workspaces.retain(|w| !ex.workspaces.contains(&w.id));

    bundle
        .http_collections
        .retain(|c| !ex.http_collections.contains(&c.id));
    bundle.http_requests.retain(|r| {
        !ex.http_requests.contains(&r.id)
            && !r
                .collection_id
                .as_ref()
                .map(|id| ex.http_collections.contains(id))
                .unwrap_or(false)
    });

    let kn_excluded = knowledge_excluded_ids(&bundle, &ex.knowledge);
    bundle.knowledge.retain(|k| !kn_excluded.contains(&k.id));

    bundle
}

fn is_peek_sync_leaf(module_key: &str, item: &ClientSyncPeekItem) -> bool {
    if item.id.starts_with("__module__:") || item.id.starts_with("__group__:") {
        return false;
    }
    match module_key {
        "knowledge" | "http" => true,
        _ => item.kind != "folder",
    }
}

fn is_peek_structure_node(item: &TeamSyncPeekItem) -> bool {
    item.kind == "folder" || item.id.starts_with("__group__:")
}

fn align_peek_parent_id(
    module_key: &str,
    local: &ClientSyncPeekItem,
    remote: Option<&ClientSyncPeekItem>,
) -> String {
    let local_parent = local.parent_id.trim();
    let remote_parent = remote.map(|item| item.parent_id.trim()).unwrap_or("");
    match module_key {
        "connections" => {
            if local_parent.starts_with("__group__:") {
                return local.parent_id.clone();
            }
            if remote_parent.starts_with("__group__:") {
                return remote
                    .map(|item| item.parent_id.clone())
                    .unwrap_or_default();
            }
            local.parent_id.clone()
        }
        "knowledge" | "http" => {
            if !local_parent.is_empty() {
                return local.parent_id.clone();
            }
            if !remote_parent.is_empty() {
                return remote
                    .map(|item| item.parent_id.clone())
                    .unwrap_or_default();
            }
            local.parent_id.clone()
        }
        _ => local.parent_id.clone(),
    }
}

fn align_peek_item(
    module_key: &str,
    local: &ClientSyncPeekItem,
    remote: Option<&ClientSyncPeekItem>,
) -> ClientSyncPeekItem {
    let parent_id = align_peek_parent_id(module_key, local, remote);
    let (label, detail, updated_at) = match remote {
        Some(remote_item) if remote_item.updated_at > local.updated_at => (
            remote_item.label.clone(),
            remote_item.detail.clone(),
            remote_item.updated_at,
        ),
        _ => (
            local.label.clone(),
            local.detail.clone(),
            local.updated_at,
        ),
    };
    ClientSyncPeekItem {
        id: local.id.clone(),
        label,
        detail,
        updated_at,
        parent_id,
        kind: local.kind.clone(),
    }
}

fn compute_sync_status(
    in_local: bool,
    in_remote: bool,
    excluded: bool,
) -> Option<TeamSyncPeekSyncStatus> {
    if excluded {
        return Some(TeamSyncPeekSyncStatus::Local);
    }
    match (in_local, in_remote) {
        (true, true) => Some(TeamSyncPeekSyncStatus::Synced),
        (true, false) => Some(TeamSyncPeekSyncStatus::Local),
        (false, true) => Some(TeamSyncPeekSyncStatus::Remote),
        (false, false) => None,
    }
}

fn to_team_peek_item(
    item: &ClientSyncPeekItem,
    module_key: &str,
    in_local: bool,
    in_remote: bool,
    ex: &TeamSyncExclusionSets,
    knowledge_excluded: &HashSet<String>,
) -> TeamSyncPeekItem {
    let excluded = is_peek_item_excluded(module_key, item, ex, knowledge_excluded);
    let sync_status = if is_peek_sync_leaf(module_key, item) {
        compute_sync_status(in_local, in_remote, excluded)
    } else {
        None
    };
    TeamSyncPeekItem {
        id: item.id.clone(),
        label: item.label.clone(),
        detail: item.detail.clone(),
        updated_at: item.updated_at,
        parent_id: item.parent_id.clone(),
        kind: item.kind.clone(),
        sync_status,
        excluded,
    }
}

fn ensure_structure_nodes(
    module_key: &str,
    items: &mut Vec<TeamSyncPeekItem>,
    local_by_id: &HashMap<String, ClientSyncPeekItem>,
    remote_by_id: &HashMap<String, ClientSyncPeekItem>,
    ex: &TeamSyncExclusionSets,
    knowledge_excluded: &HashSet<String>,
) {
    loop {
        let ids: HashSet<String> = items.iter().map(|item| item.id.clone()).collect();
        let mut added = false;
        let parent_ids: Vec<String> = items
            .iter()
            .map(|item| item.parent_id.trim().to_string())
            .filter(|parent| !parent.is_empty() && !ids.contains(parent))
            .collect();
        for parent_id in parent_ids {
            if ids.contains(&parent_id) {
                continue;
            }
            if let Some(src) = local_by_id
                .get(&parent_id)
                .or_else(|| remote_by_id.get(&parent_id))
            {
                let in_local = local_by_id.contains_key(&parent_id);
                let in_remote = remote_by_id.contains_key(&parent_id);
                items.push(to_team_peek_item(
                    src,
                    module_key,
                    in_local,
                    in_remote,
                    ex,
                    knowledge_excluded,
                ));
                added = true;
                continue;
            }
            if parent_id.starts_with("__group__:") {
                let label = parent_id
                    .strip_prefix("__group__:")
                    .unwrap_or("")
                    .to_string();
                items.push(TeamSyncPeekItem {
                    id: parent_id.clone(),
                    label,
                    detail: "group".to_string(),
                    updated_at: 0.0,
                    parent_id: String::new(),
                    kind: "folder".to_string(),
                    sync_status: None,
                    excluded: false,
                });
                added = true;
            }
        }
        if !added {
            break;
        }
    }
}

fn item_depth(items: &[TeamSyncPeekItem], id: &str) -> usize {
    let by_id: HashMap<String, &TeamSyncPeekItem> =
        items.iter().map(|item| (item.id.clone(), item)).collect();
    let mut depth = 0usize;
    let mut current = id.to_string();
    let mut visited = HashSet::new();
    while let Some(item) = by_id.get(&current) {
        if !visited.insert(current.clone()) {
            break;
        }
        let parent = item.parent_id.trim();
        if parent.is_empty() || parent.starts_with("__module__:") {
            break;
        }
        depth += 1;
        current = parent.to_string();
    }
    depth
}

fn aggregate_sync_status(statuses: &[TeamSyncPeekSyncStatus]) -> Option<TeamSyncPeekSyncStatus> {
    if statuses.is_empty() {
        return None;
    }
    if statuses
        .iter()
        .all(|status| *status == TeamSyncPeekSyncStatus::Synced)
    {
        return Some(TeamSyncPeekSyncStatus::Synced);
    }
    if statuses
        .iter()
        .all(|status| *status == TeamSyncPeekSyncStatus::Local)
    {
        return Some(TeamSyncPeekSyncStatus::Local);
    }
    if statuses
        .iter()
        .all(|status| *status == TeamSyncPeekSyncStatus::Remote)
    {
        return Some(TeamSyncPeekSyncStatus::Remote);
    }
    None
}

fn collect_sync_statuses_under(
    id: &str,
    children_by_parent: &HashMap<String, Vec<String>>,
    items_by_id: &HashMap<String, &TeamSyncPeekItem>,
) -> Vec<TeamSyncPeekSyncStatus> {
    let mut out = Vec::new();
    let Some(children) = children_by_parent.get(id) else {
        return out;
    };
    for child_id in children {
        let Some(child) = items_by_id.get(child_id.as_str()) else {
            continue;
        };
        if child.id.starts_with("__group__:") {
            out.extend(collect_sync_statuses_under(
                child_id,
                children_by_parent,
                items_by_id,
            ));
            continue;
        }
        if let Some(status) = child.sync_status {
            out.push(status);
            continue;
        }
        if is_peek_structure_node(child) {
            out.extend(collect_sync_statuses_under(
                child_id,
                children_by_parent,
                items_by_id,
            ));
        }
    }
    out
}

fn apply_structure_sync_status(items: &mut [TeamSyncPeekItem]) {
    let items_by_id: HashMap<String, &TeamSyncPeekItem> =
        items.iter().map(|item| (item.id.clone(), item)).collect();
    let mut children_by_parent: HashMap<String, Vec<String>> = HashMap::new();
    for item in items.iter() {
        let parent = item.parent_id.trim();
        if parent.is_empty() {
            continue;
        }
        children_by_parent
            .entry(parent.to_string())
            .or_default()
            .push(item.id.clone());
    }

    let mut structure_ids: Vec<String> = items
        .iter()
        .filter(|item| item.id.starts_with("__group__:"))
        .map(|item| item.id.clone())
        .collect();
    structure_ids.sort_by_key(|id| std::cmp::Reverse(item_depth(items, id)));

    let mut aggregated: HashMap<String, TeamSyncPeekSyncStatus> = HashMap::new();
    for id in structure_ids {
        if id.starts_with("__module__:") {
            continue;
        }
        let statuses = collect_sync_statuses_under(&id, &children_by_parent, &items_by_id);
        if let Some(status) = aggregate_sync_status(&statuses) {
            aggregated.insert(id, status);
        }
    }

    for item in items.iter_mut() {
        if let Some(status) = aggregated.get(&item.id) {
            item.sync_status = Some(*status);
        }
    }
}

fn merge_peek_items(
    module_key: &str,
    local_items: Vec<ClientSyncPeekItem>,
    remote_items: Vec<ClientSyncPeekItem>,
    ex: &TeamSyncExclusionSets,
    knowledge_excluded: &HashSet<String>,
) -> Vec<TeamSyncPeekItem> {
    let local_by_id: HashMap<String, ClientSyncPeekItem> = local_items
        .iter()
        .cloned()
        .map(|item| (item.id.clone(), item))
        .collect();
    let remote_by_id: HashMap<String, ClientSyncPeekItem> = remote_items
        .iter()
        .cloned()
        .map(|item| (item.id.clone(), item))
        .collect();

    let mut out: Vec<TeamSyncPeekItem> = local_items
        .iter()
        .map(|item| {
            let remote_item = remote_by_id.get(&item.id);
            let aligned = align_peek_item(module_key, item, remote_item);
            to_team_peek_item(
                &aligned,
                module_key,
                true,
                remote_item.is_some(),
                ex,
                knowledge_excluded,
            )
        })
        .collect();

    for item in &remote_items {
        if local_by_id.contains_key(&item.id) {
            continue;
        }
        out.push(to_team_peek_item(
            item,
            module_key,
            false,
            true,
            ex,
            knowledge_excluded,
        ));
    }

    ensure_structure_nodes(
        module_key,
        &mut out,
        &local_by_id,
        &remote_by_id,
        ex,
        knowledge_excluded,
    );
    apply_structure_sync_status(&mut out);
    out
}

fn is_peek_item_excluded(
    module_key: &str,
    item: &ClientSyncPeekItem,
    ex: &TeamSyncExclusionSets,
    knowledge_excluded: &HashSet<String>,
) -> bool {
    if item.id.starts_with("__module__:") || item.id.starts_with("__group__:") {
        return false;
    }
    match module_key {
        "connections" => ex.connections.contains(&item.id),
        "databases" => ex.databases.contains(&item.id),
        "knowledge" => knowledge_excluded.contains(&item.id),
        "http" => {
            if item.kind == "folder" {
                ex.http_collections.contains(&item.id)
            } else {
                ex.http_requests.contains(&item.id)
            }
        }
        "workspaces" => ex.workspaces.contains(&item.id),
        _ => false,
    }
}

fn module_folder_id(key: &str) -> String {
    format!("__module__:{key}")
}

fn nest_items_under_module(
    module_key: &str,
    items: Vec<TeamSyncPeekItem>,
) -> Vec<TeamSyncPeekItem> {
    if items.is_empty() {
        return Vec::new();
    }
    let module_id = module_folder_id(module_key);
    let mut out = Vec::with_capacity(items.len() + 1);
    out.push(TeamSyncPeekItem {
        id: module_id.clone(),
        label: module_key.to_string(),
        detail: String::new(),
        updated_at: 0.0,
        parent_id: String::new(),
        kind: "folder".to_string(),
        sync_status: None,
        excluded: false,
    });
    for mut item in items {
        if item.id == module_id {
            continue;
        }
        if item.id.starts_with("__group__:") && item.parent_id.trim().is_empty() {
            item.parent_id = module_id.clone();
        } else if item.parent_id.trim().is_empty() {
            item.parent_id = module_id.clone();
        }
        out.push(item);
    }
    out
}

fn build_team_peek_modules(
    local: &ClientSyncModulesBundle,
    remote: Option<&ClientSyncModulesBundle>,
    ex: &TeamSyncExclusionSets,
) -> TeamSyncPeekResult {
    let local_peek = build_peek_from_bundle(local);
    let remote_peek = remote.map(build_peek_from_bundle);
    let remote_found = remote.is_some();
    let remote_updated_at = remote.map(|b| b.updated_at).unwrap_or(0.0);
    let knowledge_excluded = knowledge_excluded_ids(local, &ex.knowledge);

    let remote_connections = remote_peek
        .as_ref()
        .map(|peek| peek.connections.clone())
        .unwrap_or_default();
    let remote_databases = remote_peek
        .as_ref()
        .map(|peek| peek.databases.clone())
        .unwrap_or_default();
    let remote_knowledge = remote_peek
        .as_ref()
        .map(|peek| peek.knowledge.clone())
        .unwrap_or_default();
    let remote_workspaces = remote_peek
        .as_ref()
        .map(|peek| peek.workspaces.clone())
        .unwrap_or_default();
    let remote_http: Vec<ClientSyncPeekItem> = remote_peek
        .map(|peek| {
            peek.http_collections
                .into_iter()
                .chain(peek.http_requests)
                .collect()
        })
        .unwrap_or_default();

    let local_http: Vec<ClientSyncPeekItem> = local_peek
        .http_collections
        .into_iter()
        .chain(local_peek.http_requests)
        .collect();

    let modules = vec![
        TeamSyncPeekModule {
            key: "connections".to_string(),
            items: nest_items_under_module(
                "connections",
                merge_peek_items(
                    "connections",
                    local_peek.connections,
                    remote_connections,
                    ex,
                    &knowledge_excluded,
                ),
            ),
        },
        TeamSyncPeekModule {
            key: "databases".to_string(),
            items: nest_items_under_module(
                "databases",
                merge_peek_items(
                    "databases",
                    local_peek.databases,
                    remote_databases,
                    ex,
                    &knowledge_excluded,
                ),
            ),
        },
        TeamSyncPeekModule {
            key: "knowledge".to_string(),
            items: nest_items_under_module(
                "knowledge",
                merge_peek_items(
                    "knowledge",
                    local_peek.knowledge,
                    remote_knowledge,
                    ex,
                    &knowledge_excluded,
                ),
            ),
        },
        TeamSyncPeekModule {
            key: "http".to_string(),
            items: nest_items_under_module(
                "http",
                merge_peek_items(
                    "http",
                    local_http,
                    remote_http,
                    ex,
                    &knowledge_excluded,
                ),
            ),
        },
        TeamSyncPeekModule {
            key: "workspaces".to_string(),
            items: nest_items_under_module(
                "workspaces",
                merge_peek_items(
                    "workspaces",
                    local_peek.workspaces,
                    remote_workspaces,
                    ex,
                    &knowledge_excluded,
                ),
            ),
        },
    ];

    TeamSyncPeekResult {
        remote_found,
        local_updated_at: local.updated_at,
        remote_updated_at,
        modules,
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
    let exclusions = exclusions_from_push(&request);
    let bundle = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &modules_request)?
    };
    let bundle = apply_team_sync_exclusions(bundle, &exclusions);
    let body = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化团队模块同步数据失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&body)?;

    let uploaded = push_team_sync_json(&auth, request.team_id, TEAM_MODULES_LATEST_LEAF, &body).await?;

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
    let pulled = pull_team_sync_json(&auth, team_id, TEAM_MODULES_LATEST_LEAF).await?;
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

/// 预览本机模块数据与团队 OSS 快照的对比（树形结构 + 已同步标记）。
#[tauri::command]
#[specta::specta]
pub async fn team_sync_peek_modules(
    state: State<'_, AppState>,
    request: TeamSyncPeekModulesRequest,
) -> Result<TeamSyncPeekResult, OmniError> {
    let token = require_token(&request.token)?;
    if request.team_id <= 0 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "团队 ID 无效"));
    }

    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &token, &identity.device_id).await?;
    let modules_request = to_peek_modules_request(&request);
    let exclusions = exclusions_from_peek(&request);
    let local = {
        let storage = state.storage.lock().await;
        collect_local_bundle(&storage, &modules_request)?
    };

    let remote = if let Ok(Some((_, body))) =
        pull_team_sync_json(&auth, request.team_id, TEAM_MODULES_LATEST_LEAF).await
    {
        if validate_modules_bundle_json(&body).is_ok() {
            serde_json::from_slice::<ClientSyncModulesBundle>(&body).ok()
        } else {
            None
        }
    } else {
        None
    };

    Ok(build_team_peek_modules(&local, remote.as_ref(), &exclusions))
}
