//! 重复资源扫描与合并。
//!
//! 身份按端点而不是显示名：同主机的两条 SSH、同一库的两条数据库连接、
//! 指纹相同的密钥、方法+地址+正文完全一样的已保存 HTTP 请求，各自成组。
//! 合并时保留用户指定的一条，把标签、空字段、凭据和引用改挂过去，再删除其余项。

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use omnipanel_error::{OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::connection::{Connection, ConnectionKind};
use crate::database::{
    BUILTIN_FILE_INDEX_CONN_ID, BUILTIN_META_DB_CONN_ID, DatabaseConnectionStore, DbConnectionConfig,
    load_database_connections, save_database_connections,
};
use crate::ssh_keys::{ssh_key_passphrase_ref, ssh_key_private_ref};
use crate::ssh_vault::{db_password_ref, ssh_passphrase_ref, ssh_password_ref, ssh_pem_ref};
use crate::storage::{Storage, map_sqlite};
use crate::tag::TaggableKind;
use crate::vault::Vault;

const SECRET_KEYS: &[&str] = &[
    "password",
    "passphrase",
    "pem",
    "privatekey",
    "private_key",
    "privatekeypath",
    "secret",
    "token",
    "apikey",
    "accesskeysecret",
    "authorization",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeMember {
    pub id: String,
    pub name: String,
    pub summary: String,
    pub group: String,
    pub env_tag: String,
    pub updated_at: i64,
    pub has_secret: bool,
    pub protected: bool,
    pub preferred: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeGroup {
    pub fingerprint: String,
    pub store: String,
    pub kind: String,
    pub label: String,
    pub members: Vec<DedupeMember>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeScan {
    pub groups: Vec<DedupeGroup>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeRewrite {
    pub from: String,
    pub to: String,
    pub store: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeRefCount {
    pub table: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeApplyReport {
    pub removed: u32,
    pub kept: u32,
    pub rewrites: Vec<DedupeRewrite>,
    pub references: Vec<DedupeRefCount>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DedupePlan {
    #[serde(default)]
    groups: Vec<DedupePlanGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DedupePlanGroup {
    keep_id: String,
    #[serde(default)]
    drop_ids: Vec<String>,
}

#[derive(Clone)]
struct PlannedGroup {
    store: String,
    keep_id: String,
    drop_ids: Vec<String>,
}

pub fn scan_resource_duplicates(
    storage: &Storage,
    databases: &[DbConnectionConfig],
) -> OmniResult<DedupeScan> {
    let connections = storage.list_connections()?;
    let ssh_endpoint = ssh_endpoint_index(&connections);
    let mut buckets: BTreeMap<(String, String), Vec<DedupeMember>> = BTreeMap::new();
    let mut labels: HashMap<(String, String), String> = HashMap::new();

    for conn in &connections {
        let Some((fingerprint, label)) = connection_fingerprint(conn, &ssh_endpoint) else {
            continue;
        };
        let key = ("connection".to_string(), fingerprint);
        labels.entry(key.clone()).or_insert(label);
        buckets
            .entry(key)
            .or_default()
            .push(connection_member(conn, &ssh_endpoint));
    }

    for conn in databases {
        let Some((fingerprint, label)) = database_fingerprint(conn) else {
            continue;
        };
        let key = ("database".to_string(), fingerprint);
        labels.entry(key.clone()).or_insert(label);
        buckets.entry(key).or_default().push(database_member(conn));
    }

    for key in storage.list_ssh_keys().unwrap_or_default() {
        let fingerprint = key.fingerprint.trim().to_ascii_lowercase();
        if fingerprint.is_empty() {
            continue;
        }
        let label = if key.comment.trim().is_empty() {
            fingerprint.clone()
        } else {
            format!("{fingerprint} · {}", key.comment.trim())
        };
        let map_key = ("ssh-key".to_string(), fingerprint);
        labels.entry(map_key.clone()).or_insert(label);
        let has_secret = vault_present(&ssh_key_private_ref(&key.id));
        buckets.entry(map_key).or_default().push(DedupeMember {
            id: key.id.clone(),
            name: key.name.clone(),
            summary: key.key_type.clone(),
            group: String::new(),
            env_tag: String::new(),
            updated_at: key.updated_at,
            has_secret,
            protected: false,
            preferred: false,
        });
    }

    for req in storage.http_list_requests(None).unwrap_or_default() {
        let Some(fingerprint) = http_fingerprint(&req.method, &req.url, &req.body, &req.auth_type)
        else {
            continue;
        };
        let label = format!("{} {}", req.method.to_ascii_uppercase(), norm_url(&req.url));
        let key = ("http-request".to_string(), fingerprint);
        labels.entry(key.clone()).or_insert(label);
        buckets.entry(key).or_default().push(DedupeMember {
            id: req.id.clone(),
            name: req.name.clone(),
            summary: req.url.clone(),
            group: String::new(),
            env_tag: String::new(),
            updated_at: req.updated_at,
            has_secret: !req.auth_value.trim().is_empty(),
            protected: false,
            preferred: false,
        });
    }

    let mut groups = Vec::new();
    for ((store, fingerprint), mut members) in buckets {
        if members.len() < 2 {
            continue;
        }
        mark_preferred(&mut members);
        let kind = match store.as_str() {
            "ssh-key" => "ssh-key",
            "http-request" => "http-request",
            "database" => "database",
            _ => members_kind(&connections, &members),
        }
        .to_string();
        groups.push(DedupeGroup {
            label: labels
                .remove(&(store.clone(), fingerprint.clone()))
                .unwrap_or_else(|| fingerprint.clone()),
            fingerprint,
            store,
            kind,
            members,
        });
    }
    Ok(DedupeScan { groups })
}

pub fn apply_resource_dedupe(
    storage: &Storage,
    databases: Option<&DatabaseConnectionStore>,
    plan_json: &str,
) -> OmniResult<DedupeApplyReport> {
    let plan: DedupePlan = serde_json::from_str(plan_json)
        .map_err(|err| OmniError::invalid_input(format!("清理计划不是合法 JSON: {err}")))?;
    let db_list = match databases {
        Some(store) => store.list()?,
        None => load_database_connections().unwrap_or_default(),
    };
    let scan = scan_resource_duplicates(storage, &db_list)?;
    let planned = resolve_plan(&scan, &plan)?;

    let mut report = DedupeApplyReport {
        removed: 0,
        kept: 0,
        rewrites: Vec::new(),
        references: Vec::new(),
    };
    let sqlite_groups: Vec<_> = planned
        .iter()
        .filter(|group| group.store != "database")
        .cloned()
        .collect();
    let database_groups: Vec<_> = planned
        .iter()
        .filter(|group| group.store == "database")
        .cloned()
        .collect();

    if !sqlite_groups.is_empty() {
        apply_sqlite(storage, &sqlite_groups, &mut report)?;
    }
    if !database_groups.is_empty() {
        apply_databases(databases, &db_list, &database_groups, &mut report)?;
    }
    if report.removed == 0 {
        return Err(OmniError::invalid_input("没有可清理的重复项"));
    }
    Ok(report)
}

fn apply_sqlite(
    storage: &Storage,
    groups: &[PlannedGroup],
    report: &mut DedupeApplyReport,
) -> OmniResult<()> {
    let pairs: Vec<(String, String, String)> = groups
        .iter()
        .flat_map(|group| {
            group.drop_ids.iter().map(|drop_id| {
                (
                    drop_id.clone(),
                    group.keep_id.clone(),
                    group.store.clone(),
                )
            })
        })
        .collect();
    let copied_secrets = copy_secrets_for_groups(storage, groups)?;

    storage
        .conn()
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(map_sqlite)?;
    let applied = (|| -> OmniResult<()> {
        for group in groups {
            match group.store.as_str() {
                "connection" => merge_connection_group(storage, group)?,
                "http-request" => merge_http_group(storage, group)?,
                "ssh-key" => {}
                other => {
                    return Err(OmniError::invalid_input(format!("未知资源存储: {other}")));
                }
            }
        }
        let refs = retarget_references(storage, &pairs)?;
        report.references.extend(refs);
        for group in groups {
            for drop_id in &group.drop_ids {
                match group.store.as_str() {
                    "connection" => storage.delete_connection(drop_id)?,
                    "http-request" => storage.http_delete_request(drop_id)?,
                    "ssh-key" => {
                        storage
                            .conn()
                            .execute("DELETE FROM ssh_keys WHERE id = ?1", [drop_id.as_str()])
                            .map_err(map_sqlite)?;
                    }
                    _ => {}
                }
                report.rewrites.push(DedupeRewrite {
                    from: drop_id.clone(),
                    to: group.keep_id.clone(),
                    store: group.store.clone(),
                });
                report.removed += 1;
            }
            report.kept += 1;
        }
        Ok(())
    })();
    match applied {
        Ok(()) => storage
            .conn()
            .execute_batch("COMMIT")
            .map_err(map_sqlite)?,
        Err(err) => {
            let _ = storage.conn().execute_batch("ROLLBACK");
            return Err(err);
        }
    }
    for (from, to) in copied_secrets {
        if vault_present(&to) || !vault_present(&from) {
            let _ = Vault::delete(&from);
        }
    }
    Ok(())
}

fn apply_databases(
    databases: Option<&DatabaseConnectionStore>,
    listed: &[DbConnectionConfig],
    groups: &[PlannedGroup],
    report: &mut DedupeApplyReport,
) -> OmniResult<()> {
    if let Some(store) = databases {
        for group in groups {
            let Some(mut keeper) = store
                .list()?
                .into_iter()
                .find(|conn| conn.id == group.keep_id)
            else {
                return Err(OmniError::invalid_input(format!(
                    "找不到要保留的数据库连接 {}",
                    group.keep_id
                )));
            };
            let drops: Vec<_> = store
                .list()?
                .into_iter()
                .filter(|conn| group.drop_ids.iter().any(|id| id == &conn.id))
                .collect();
            merge_db_fields(&mut keeper, &drops);
            for drop in &drops {
                copy_vault(&db_password_ref(&drop.id), &db_password_ref(&keeper.id));
            }
            if vault_present(&db_password_ref(&keeper.id)) {
                keeper.has_password = true;
            }
            keeper.password.clear();
            store.save(keeper)?;
            for drop in &drops {
                store.delete(&drop.id)?;
                report.rewrites.push(DedupeRewrite {
                    from: drop.id.clone(),
                    to: group.keep_id.clone(),
                    store: "database".into(),
                });
                report.removed += 1;
            }
            report.kept += 1;
        }
        return Ok(());
    }

    let mut next = listed.to_vec();
    for group in groups {
        let Some(index) = next.iter().position(|conn| conn.id == group.keep_id) else {
            return Err(OmniError::invalid_input(format!(
                "找不到要保留的数据库连接 {}",
                group.keep_id
            )));
        };
        let drops: Vec<_> = next
            .iter()
            .filter(|conn| group.drop_ids.iter().any(|id| id == &conn.id))
            .cloned()
            .collect();
        merge_db_fields(&mut next[index], &drops);
        for drop in &drops {
            copy_vault(&db_password_ref(&drop.id), &db_password_ref(&group.keep_id));
        }
        if vault_present(&db_password_ref(&group.keep_id)) {
            next[index].has_password = true;
        }
        next[index].password.clear();
        next.retain(|conn| !group.drop_ids.iter().any(|id| id == &conn.id));
        for drop in &drops {
            let _ = Vault::delete(&db_password_ref(&drop.id));
            report.rewrites.push(DedupeRewrite {
                from: drop.id.clone(),
                to: group.keep_id.clone(),
                store: "database".into(),
            });
            report.removed += 1;
        }
        report.kept += 1;
    }
    save_database_connections(&next)
}

fn resolve_plan(scan: &DedupeScan, plan: &DedupePlan) -> OmniResult<Vec<PlannedGroup>> {
    let mut by_id: HashMap<&str, (&DedupeGroup, &DedupeMember)> = HashMap::new();
    for group in &scan.groups {
        for member in &group.members {
            by_id.insert(member.id.as_str(), (group, member));
        }
    }
    let mut seen = HashSet::new();
    let mut planned = Vec::new();
    for item in &plan.groups {
        let keep_id = item.keep_id.trim();
        if !id_ok(keep_id) {
            return Err(OmniError::invalid_input("保留项 id 非法"));
        }
        let Some((group, _)) = by_id.get(keep_id) else {
            return Err(OmniError::invalid_input(format!(
                "保留项不在重复分组里: {keep_id}"
            )));
        };
        if !seen.insert(keep_id.to_string()) {
            return Err(OmniError::invalid_input(format!(
                "保留项重复出现: {keep_id}"
            )));
        }
        let mut drop_ids = Vec::new();
        for raw in &item.drop_ids {
            let drop_id = raw.trim();
            if drop_id.is_empty() || drop_id == keep_id {
                continue;
            }
            if !id_ok(drop_id) {
                return Err(OmniError::invalid_input(format!("待删除 id 非法: {drop_id}")));
            }
            let Some((drop_group, member)) = by_id.get(drop_id) else {
                return Err(OmniError::invalid_input(format!(
                    "待删除项不在重复分组里: {drop_id}"
                )));
            };
            if drop_group.fingerprint != group.fingerprint || drop_group.store != group.store {
                return Err(OmniError::invalid_input(format!(
                    "{drop_id} 与保留项不是同一组重复资源"
                )));
            }
            if member.protected {
                return Err(OmniError::invalid_input(format!(
                    "内置资源不能删除: {}",
                    member.name
                )));
            }
            if !seen.insert(drop_id.to_string()) {
                return Err(OmniError::invalid_input(format!(
                    "待删除项重复出现: {drop_id}"
                )));
            }
            drop_ids.push(drop_id.to_string());
        }
        if drop_ids.is_empty() {
            continue;
        }
        planned.push(PlannedGroup {
            store: group.store.clone(),
            keep_id: keep_id.to_string(),
            drop_ids,
        });
    }
    if planned.is_empty() {
        return Err(OmniError::invalid_input("没有选中要清理的重复项"));
    }
    Ok(planned)
}

fn merge_connection_group(storage: &Storage, group: &PlannedGroup) -> OmniResult<()> {
    let Some(mut keeper) = storage.get_connection(&group.keep_id)? else {
        return Err(OmniError::invalid_input(format!(
            "找不到要保留的连接 {}",
            group.keep_id
        )));
    };
    let mut tags = tag_paths(storage, &keeper.id);
    tags.extend(keeper.tags.iter().cloned());
    let mut config = parse_json(&keeper.config);
    for drop_id in &group.drop_ids {
        let Some(drop) = storage.get_connection(drop_id)? else {
            continue;
        };
        if keeper.group.trim().is_empty() && !drop.group.trim().is_empty() {
            keeper.group = drop.group.clone();
        }
        if env_is_blank(&keeper.env_tag) && !env_is_blank(&drop.env_tag) {
            keeper.env_tag = drop.env_tag.clone();
        }
        if keeper.credential_ref.as_deref().unwrap_or("").is_empty() {
            if let Some(reference) = drop.credential_ref.as_deref() {
                keeper.credential_ref = Some(retarget_ref(reference, drop_id, &keeper.id));
            }
        }
        tags.extend(tag_paths(storage, drop_id));
        tags.extend(drop.tags.iter().cloned());
        merge_json(&mut config, &parse_json(&drop.config));
        rewrite_json_ids(&mut config, &[(drop_id.clone(), keeper.id.clone())]);
    }
    keeper.tags = unique_strings(tags);
    keeper.config = config.to_string();
    keeper.updated_at = now_secs();
    storage.save_connection(&keeper)
}

fn merge_http_group(storage: &Storage, group: &PlannedGroup) -> OmniResult<()> {
    let requests = storage.http_list_requests(None)?;
    let Some(mut keeper) = requests.iter().find(|req| req.id == group.keep_id).cloned() else {
        return Err(OmniError::invalid_input(format!(
            "找不到要保留的 HTTP 请求 {}",
            group.keep_id
        )));
    };
    for drop_id in &group.drop_ids {
        let Some(drop) = requests.iter().find(|req| &req.id == drop_id) else {
            continue;
        };
        keeper.tags.extend(drop.tags.iter().cloned());
        if keeper.auth_value.trim().is_empty() && !drop.auth_value.trim().is_empty() {
            keeper.auth_type = drop.auth_type.clone();
            keeper.auth_value = drop.auth_value.clone();
        }
    }
    keeper.tags = unique_strings(keeper.tags);
    keeper.updated_at = now_secs();
    storage.http_save_request(&keeper)
}

fn merge_db_fields(keeper: &mut DbConnectionConfig, drops: &[DbConnectionConfig]) {
    for drop in drops {
        if keeper.group.trim().is_empty() && !drop.group.trim().is_empty() {
            keeper.group = drop.group.clone();
        }
        if keeper.status.trim().is_empty() {
            keeper.status = drop.status.clone();
        }
        keeper.tags.extend(drop.tags.iter().cloned());
        if !keeper.ssl && drop.ssl {
            keeper.ssl = true;
        }
        if keeper.sid.trim().is_empty() && !drop.sid.trim().is_empty() {
            keeper.sid = drop.sid.clone();
        }
    }
    keeper.tags = unique_strings(std::mem::take(&mut keeper.tags));
    keeper.password.clear();
}

fn retarget_references(
    storage: &Storage,
    pairs: &[(String, String, String)],
) -> OmniResult<Vec<DedupeRefCount>> {
    let conn = storage.conn();
    let mut counts: BTreeMap<&'static str, u32> = BTreeMap::new();
    let id_pairs: Vec<(String, String)> = pairs
        .iter()
        .map(|(from, to, _)| (from.clone(), to.clone()))
        .collect();
    let mut rewrite_connection_config = false;
    for (from, to, store) in pairs {
        let moved = move_tag_links_raw(conn, from, to)?;
        add_count(&mut counts, "resource_tag_links", moved);
        if store == "connection" || store == "database" {
            for (table, column) in EXACT_COLUMNS {
                let changed = retarget_eq(conn, table, column, from, to)?;
                add_count(&mut counts, table, changed);
            }
            rewrite_connection_config = true;
        }
        if store == "ssh-key" {
            rewrite_connection_config = true;
        }
        if store == "http-request" {
            let changed = retarget_eq(conn, "http_history", "request_id", from, to)?;
            add_count(&mut counts, "http_history", changed);
        }
    }
    if rewrite_connection_config {
        let configs = rewrite_json_column(conn, "connections", "config", &id_pairs)?;
        add_count(&mut counts, "connections_config", configs);
    }
    for (table, column) in JSON_COLUMNS {
        let changed = rewrite_json_column(conn, table, column, &id_pairs)?;
        add_count(&mut counts, table, changed);
    }
    Ok(counts
        .into_iter()
        .filter(|(_, count)| *count > 0)
        .map(|(table, count)| DedupeRefCount {
            table: table.to_string(),
            count,
        })
        .collect())
}

const EXACT_COLUMNS: &[(&str, &str)] = &[
    ("resource_observations", "resource_id"),
    ("knowledge_entries", "resource_id"),
    ("skill_applications", "resource_id"),
    ("task_events", "resource_id"),
    ("tasks", "resource_id"),
    ("sql_executions", "connection_id"),
    ("file_transfer_jobs", "src_connection_id"),
    ("file_transfer_jobs", "dst_connection_id"),
    ("workflows", "target"),
];

const JSON_COLUMNS: &[(&str, &str)] = &[
    ("terminal_history_blocks", "payload"),
    ("task_events", "detail"),
    ("resource_observations", "payload"),
    ("ai_traces", "payload"),
];

fn copy_secrets_for_groups(
    storage: &Storage,
    groups: &[PlannedGroup],
) -> OmniResult<Vec<(String, String)>> {
    let mut copied = Vec::new();
    for group in groups {
        match group.store.as_str() {
            "connection" => {
                let Some(keeper) = storage.get_connection(&group.keep_id)? else {
                    continue;
                };
                for drop_id in &group.drop_ids {
                    let Some(drop) = storage.get_connection(drop_id)? else {
                        continue;
                    };
                    for reference in secret_refs(&drop.kind, drop_id) {
                        let target = retarget_ref(&reference, drop_id, &group.keep_id);
                        copy_vault(&reference, &target);
                        copied.push((reference, target));
                    }
                    if let Some(reference) = drop.credential_ref.clone() {
                        if !reference.contains(drop_id) {
                            continue;
                        }
                        let target = if keeper.credential_ref.as_deref().unwrap_or("").is_empty() {
                            retarget_ref(&reference, drop_id, &group.keep_id)
                        } else {
                            keeper.credential_ref.clone().unwrap_or_default()
                        };
                        if !target.is_empty() {
                            copy_vault(&reference, &target);
                            copied.push((reference, target));
                        }
                    }
                }
            }
            "ssh-key" => {
                for drop_id in &group.drop_ids {
                    let private_target = ssh_key_private_ref(&group.keep_id);
                    let pass_target = ssh_key_passphrase_ref(&group.keep_id);
                    copy_vault(&ssh_key_private_ref(drop_id), &private_target);
                    copy_vault(&ssh_key_passphrase_ref(drop_id), &pass_target);
                    copied.push((ssh_key_private_ref(drop_id), private_target));
                    copied.push((ssh_key_passphrase_ref(drop_id), pass_target));
                }
            }
            _ => {}
        }
    }
    Ok(copied)
}

fn secret_refs(kind: &ConnectionKind, id: &str) -> Vec<String> {
    match kind {
        ConnectionKind::Ssh => vec![
            ssh_password_ref(id),
            ssh_pem_ref(id),
            ssh_passphrase_ref(id),
        ],
        ConnectionKind::File => vec![format!("file-cred-{id}")],
        ConnectionKind::Panel => vec![format!("panel-key-{id}")],
        ConnectionKind::Docker => vec![
            format!("docker-ssh-password-{id}"),
            format!("docker-ssh-pem-{id}"),
            format!("docker-onepanel-{id}"),
            format!("docker-btpanel-{id}"),
            format!("docker-btpanel-session-{id}"),
        ],
        ConnectionKind::Database => vec![db_password_ref(id)],
        ConnectionKind::Cloud | ConnectionKind::Protocol | ConnectionKind::Service => Vec::new(),
    }
}

fn connection_member(conn: &Connection, ssh_endpoint: &HashMap<String, String>) -> DedupeMember {
    let protected = is_protected(&conn.id);
    DedupeMember {
        id: conn.id.clone(),
        name: conn.name.clone(),
        summary: connection_fingerprint(conn, ssh_endpoint)
            .map(|(_, label)| label)
            .unwrap_or_else(|| conn.kind.as_str().to_string()),
        group: conn.group.clone(),
        env_tag: conn.env_tag.clone(),
        updated_at: conn.updated_at,
        has_secret: connection_has_secret(conn),
        protected,
        preferred: false,
    }
}

fn database_member(conn: &DbConnectionConfig) -> DedupeMember {
    DedupeMember {
        id: conn.id.clone(),
        name: conn.name.clone(),
        summary: format!(
            "{} {}@{}:{} / {}",
            conn.db_type, conn.user, conn.host, conn.port, conn.database
        ),
        group: conn.group.clone(),
        env_tag: String::new(),
        updated_at: 0,
        has_secret: conn.has_password || vault_present(&db_password_ref(&conn.id)),
        protected: is_protected(&conn.id),
        preferred: false,
    }
}

fn mark_preferred(members: &mut [DedupeMember]) {
    let mut best: Option<usize> = None;
    for (index, member) in members.iter().enumerate() {
        let replace = match best {
            None => true,
            Some(prev) => {
                let other = &members[prev];
                member.protected && !other.protected
                    || member.protected == other.protected
                        && member.has_secret
                        && !other.has_secret
                    || member.protected == other.protected
                        && member.has_secret == other.has_secret
                        && member.updated_at > other.updated_at
            }
        };
        if replace {
            best = Some(index);
        }
    }
    if let Some(index) = best {
        members[index].preferred = true;
    }
    members.sort_by(|left, right| {
        right
            .preferred
            .cmp(&left.preferred)
            .then(right.updated_at.cmp(&left.updated_at))
            .then(left.name.cmp(&right.name))
    });
}

fn members_kind(connections: &[Connection], members: &[DedupeMember]) -> &'static str {
    let id = members.first().map(|member| member.id.as_str()).unwrap_or("");
    connections
        .iter()
        .find(|conn| conn.id == id)
        .map(|conn| conn.kind.as_str())
        .unwrap_or("connection")
}

fn connection_fingerprint(
    conn: &Connection,
    ssh_endpoint: &HashMap<String, String>,
) -> Option<(String, String)> {
    let cfg = parse_json(&conn.config);
    match conn.kind {
        ConnectionKind::Ssh => ssh_fingerprint(&cfg),
        ConnectionKind::Database => db_cfg_fingerprint(&cfg),
        ConnectionKind::Docker => docker_fingerprint(&cfg, ssh_endpoint),
        ConnectionKind::Panel => {
            let address = str_field(&cfg, &["address", "url", "host"])?;
            let service = str_field(&cfg, &["serviceType", "service_type", "type"])
                .unwrap_or("panel")
                .to_ascii_lowercase();
            let label = norm_url(address);
            Some((format!("panel|{service}|{label}"), label))
        }
        ConnectionKind::Cloud => {
            let provider = str_field(&cfg, &["pluginId", "provider"])?
                .trim()
                .to_ascii_lowercase();
            let access = str_field(&cfg, &["accessKeyId", "access_key_id"])?
                .trim()
                .to_ascii_lowercase();
            if provider.is_empty() || access.is_empty() {
                return None;
            }
            Some((
                format!("cloud|{provider}|{access}"),
                format!("{provider} · {access}"),
            ))
        }
        ConnectionKind::Protocol => protocol_fingerprint(&cfg),
        ConnectionKind::File => file_fingerprint(&cfg, ssh_endpoint),
        ConnectionKind::Service => {
            let plugin = str_field(&cfg, &["pluginId"]).unwrap_or("service");
            let host = norm_host(&str_field(&cfg, &["host"])?);
            if host.is_empty() {
                return None;
            }
            let port = port_field(&cfg, 0);
            let context = str_field(&cfg, &["contextPath"]).unwrap_or("").trim();
            Some((
                format!("service|{plugin}|{host}|{port}|{context}"),
                format!("{plugin} {host}:{port}{context}"),
            ))
        }
    }
}

fn ssh_fingerprint(cfg: &Value) -> Option<(String, String)> {
    let host = norm_host(&str_field(cfg, &["host"])?);
    if host.is_empty() {
        return None;
    }
    let port = port_field(cfg, 22);
    let user = str_field(cfg, &["user", "username"])
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let label = if user.is_empty() {
        format!("{host}:{port}")
    } else {
        format!("{user}@{host}:{port}")
    };
    Some((format!("ssh|{host}|{port}|{user}"), label))
}

fn database_fingerprint(conn: &DbConnectionConfig) -> Option<(String, String)> {
    db_parts(
        &conn.db_type,
        &conn.host,
        conn.port,
        &conn.database,
        &conn.user,
    )
}

fn db_cfg_fingerprint(cfg: &Value) -> Option<(String, String)> {
    let engine = str_field(cfg, &["db_type", "dbType", "engine", "type"]).unwrap_or("database");
    let host = str_field(cfg, &["host"]).unwrap_or("");
    let database = str_field(cfg, &["database", "db"]).unwrap_or("");
    let user = str_field(cfg, &["user", "username"]).unwrap_or("");
    let port = port_field(cfg, 0);
    db_parts(engine, host, port, database, user)
}

fn db_parts(
    engine: &str,
    host: &str,
    port: u16,
    database: &str,
    user: &str,
) -> Option<(String, String)> {
    let engine = engine.trim().to_ascii_lowercase();
    if engine.is_empty() {
        return None;
    }
    if engine == "sqlite" {
        let path = norm_path(database);
        if path.is_empty() {
            return None;
        }
        return Some((format!("db|sqlite|{path}"), path));
    }
    let host = norm_host(host);
    if host.is_empty() {
        return None;
    }
    let database = database.trim().to_ascii_lowercase();
    let user = user.trim().to_ascii_lowercase();
    let label = format!("{engine} {user}@{host}:{port}/{database}");
    Some((
        format!("db|{engine}|{host}|{port}|{database}|{user}"),
        label,
    ))
}

fn docker_fingerprint(cfg: &Value, ssh_endpoint: &HashMap<String, String>) -> Option<(String, String)> {
    let source = str_field(cfg, &["source"])
        .unwrap_or("local-engine")
        .trim()
        .to_ascii_lowercase();
    match source.as_str() {
        "" | "local-engine" => Some(("docker|local".into(), "本地 Engine".into())),
        "ssh-engine" => {
            if let Some(bound) = str_field(cfg, &["boundSshConnectionId"]) {
                if let Some(endpoint) = ssh_endpoint.get(bound) {
                    return Some((
                        format!("docker|ssh|{endpoint}"),
                        format!("SSH Engine · {endpoint}"),
                    ));
                }
            }
            let ssh = cfg.get("ssh").cloned().unwrap_or(Value::Null);
            ssh_fingerprint(&ssh).map(|(fp, label)| (format!("docker|ssh|{fp}"), label))
        }
        "remote-engine" => {
            let host = str_field(cfg, &["host", "url"])?;
            let label = norm_url(host);
            Some((format!("docker|remote|{label}"), label))
        }
        _ => {
            let url = cfg
                .pointer("/onepanel/baseUrl")
                .or_else(|| cfg.pointer("/btpanel/baseUrl"))
                .and_then(Value::as_str)
                .or_else(|| str_field(cfg, &["host", "url"]))?;
            let label = norm_url(url);
            if label.is_empty() {
                return None;
            }
            Some((format!("docker|panel|{source}|{label}"), label))
        }
    }
}

fn file_fingerprint(cfg: &Value, ssh_endpoint: &HashMap<String, String>) -> Option<(String, String)> {
    let protocol = str_field(cfg, &["protocol"])
        .unwrap_or("file")
        .to_ascii_lowercase();
    if let Some(ssh_id) = str_field(cfg, &["sshConnectionId"]) {
        if let Some(endpoint) = ssh_endpoint.get(ssh_id) {
            return Some((
                format!("file|{protocol}|{endpoint}"),
                format!("{protocol} · {endpoint}"),
            ));
        }
    }
    let host = norm_host(&str_field(cfg, &["host"]).unwrap_or(""));
    let path = norm_path(&str_field(cfg, &["rootPath", "path"]).unwrap_or(""));
    if host.is_empty() && path.is_empty() {
        return None;
    }
    Some((
        format!("file|{protocol}|{host}|{path}"),
        format!("{protocol} {host}{path}"),
    ))
}

fn protocol_fingerprint(cfg: &Value) -> Option<(String, String)> {
    let kind = str_field(cfg, &["protocol", "type", "kind"])
        .unwrap_or("protocol")
        .to_ascii_lowercase();
    if let Some(url) = str_field(cfg, &["url", "address"]) {
        let label = norm_url(url);
        if label.is_empty() {
            return None;
        }
        return Some((format!("protocol|{kind}|{label}"), format!("{kind} {label}")));
    }
    let host = norm_host(&str_field(cfg, &["host"])?);
    if host.is_empty() {
        return None;
    }
    let port = port_field(cfg, 0);
    Some((
        format!("protocol|{kind}|{host}|{port}"),
        format!("{kind} {host}:{port}"),
    ))
}

fn http_fingerprint(method: &str, url: &str, body: &str, auth_type: &str) -> Option<String> {
    let url = norm_url(url);
    if url.is_empty() {
        return None;
    }
    let method = method.trim().to_ascii_uppercase();
    let auth = auth_type.trim().to_ascii_lowercase();
    Some(format!(
        "http|{method}|{url}|{auth}|{}",
        body.trim()
    ))
}

fn ssh_endpoint_index(connections: &[Connection]) -> HashMap<String, String> {
    let mut index = HashMap::new();
    for conn in connections {
        if conn.kind != ConnectionKind::Ssh {
            continue;
        }
        if let Some((fingerprint, _)) = ssh_fingerprint(&parse_json(&conn.config)) {
            index.insert(conn.id.clone(), fingerprint);
        }
    }
    index
}

fn connection_has_secret(conn: &Connection) -> bool {
    secret_refs(&conn.kind, &conn.id)
        .into_iter()
        .any(|reference| vault_present(&reference))
        || conn
            .credential_ref
            .as_deref()
            .is_some_and(|reference| vault_present(reference))
}

fn tag_paths(storage: &Storage, id: &str) -> Vec<String> {
    storage
        .resource_list_tags(TaggableKind::Connection, id)
        .unwrap_or_default()
        .into_iter()
        .map(|item| item.tag.path)
        .collect()
}

fn move_tag_links_raw(
    conn: &rusqlite::Connection,
    from: &str,
    to: &str,
) -> OmniResult<u32> {
    if !table_exists(conn, "resource_tag_links") {
        return Ok(0);
    }
    conn.execute(
        "INSERT OR IGNORE INTO resource_tag_links (tag_id, resource_kind, resource_id, source, created_at)
         SELECT tag_id, resource_kind, ?1, source, created_at FROM resource_tag_links WHERE resource_id = ?2",
        params![to, from],
    )
    .map_err(map_sqlite)?;
    let changed = conn
        .execute(
            "DELETE FROM resource_tag_links WHERE resource_id = ?1",
            [from],
        )
        .map_err(map_sqlite)?;
    Ok(changed as u32)
}

fn retarget_eq(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
    from: &str,
    to: &str,
) -> OmniResult<u32> {
    if !table_exists(conn, table) || !column_exists(conn, table, column) {
        return Ok(0);
    }
    let sql = format!("UPDATE {table} SET {column} = ?1 WHERE {column} = ?2");
    let changed = conn.execute(&sql, params![to, from]).map_err(map_sqlite)?;
    Ok(changed as u32)
}

fn rewrite_json_column(
    conn: &rusqlite::Connection,
    table: &str,
    column: &str,
    pairs: &[(String, String)],
) -> OmniResult<u32> {
    if pairs.is_empty() || !table_exists(conn, table) || !column_exists(conn, table, column) {
        return Ok(0);
    }
    let mut changed = 0u32;
    for (from, _) in pairs {
        let needle = format!("%\"{from}\"%");
        let sql = format!("SELECT rowid, {column} FROM {table} WHERE {column} LIKE ?1");
        let mut stmt = conn.prepare(&sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(params![needle], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(map_sqlite)?;
        let pending: Vec<(i64, String)> = rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;
        drop(stmt);
        for (rowid, text) in pending {
            let Some(next) = replace_quoted(&text, pairs) else {
                continue;
            };
            let update = format!("UPDATE {table} SET {column} = ?1 WHERE rowid = ?2");
            conn.execute(&update, params![next, rowid])
                .map_err(map_sqlite)?;
            changed += 1;
        }
    }
    Ok(changed)
}

fn replace_quoted(text: &str, pairs: &[(String, String)]) -> Option<String> {
    let mut out = text.to_string();
    let mut changed = false;
    for (from, to) in pairs {
        let needle = format!("\"{from}\"");
        let replacement = format!("\"{to}\"");
        if out.contains(&needle) {
            out = out.replace(&needle, &replacement);
            changed = true;
        }
    }
    changed.then_some(out)
}

fn table_exists(conn: &rusqlite::Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}

fn column_exists(conn: &rusqlite::Connection, table: &str, column: &str) -> bool {
    let sql = format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name = ?1");
    conn.query_row(&sql, [column], |_| Ok(())).is_ok()
}

fn add_count(counts: &mut BTreeMap<&'static str, u32>, table: &'static str, amount: u32) {
    if amount == 0 {
        return;
    }
    *counts.entry(table).or_insert(0) += amount;
}

fn merge_json(keep: &mut Value, extra: &Value) {
    let Some(extra) = extra.as_object() else {
        return;
    };
    if !keep.is_object() {
        *keep = json!({});
    }
    let Some(target) = keep.as_object_mut() else {
        return;
    };
    for (key, value) in extra {
        if is_secret_key(key) {
            continue;
        }
        match target.get(key) {
            None => {
                target.insert(key.clone(), value.clone());
            }
            Some(existing) if is_empty_value(existing) && !is_empty_value(value) => {
                target.insert(key.clone(), value.clone());
            }
            Some(Value::Object(_)) if value.is_object() => {
                let mut nested = target.get(key).cloned().unwrap_or(json!({}));
                merge_json(&mut nested, value);
                target.insert(key.clone(), nested);
            }
            Some(Value::Array(current)) if value.is_array() => {
                let mut merged = current.clone();
                if let Some(items) = value.as_array() {
                    for item in items {
                        if !merged.contains(item) {
                            merged.push(item.clone());
                        }
                    }
                }
                target.insert(key.clone(), Value::Array(merged));
            }
            _ => {}
        }
    }
}

fn rewrite_json_ids(value: &mut Value, pairs: &[(String, String)]) {
    match value {
        Value::String(text) => {
            if let Some(next) = pairs.iter().find(|(from, _)| from == text) {
                *text = next.1.clone();
            }
        }
        Value::Array(items) => {
            for item in items {
                rewrite_json_ids(item, pairs);
            }
        }
        Value::Object(map) => {
            for item in map.values_mut() {
                rewrite_json_ids(item, pairs);
            }
        }
        _ => {}
    }
}

fn is_secret_key(key: &str) -> bool {
    let key = key.to_ascii_lowercase();
    SECRET_KEYS.iter().any(|item| *item == key)
}

fn is_empty_value(value: &Value) -> bool {
    match value {
        Value::Null => true,
        Value::String(text) => text.trim().is_empty(),
        Value::Array(items) => items.is_empty(),
        Value::Object(map) => map.is_empty(),
        _ => false,
    }
}

fn parse_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| json!({}))
}

fn str_field<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    for key in keys {
        if let Some(text) = value.get(*key).and_then(Value::as_str) {
            let text = text.trim();
            if !text.is_empty() {
                return Some(text);
            }
        }
    }
    None
}

fn port_field(value: &Value, default: u16) -> u16 {
    match value.get("port") {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(default as u64) as u16,
        Some(Value::String(text)) => text.trim().parse().unwrap_or(default),
        _ => default,
    }
}

fn norm_host(raw: &str) -> String {
    let mut host = raw.trim().trim_matches(|ch| ch == '[' || ch == ']').trim();
    host = host
        .strip_prefix("tcp://")
        .or_else(|| host.strip_prefix("ssh://"))
        .unwrap_or(host);
    if let Some((_, rest)) = host.rsplit_once('@') {
        host = rest;
    }
    host.trim_end_matches('.').trim().to_ascii_lowercase()
}

fn norm_url(raw: &str) -> String {
    let mut text = raw.trim().trim_end_matches('/').to_ascii_lowercase();
    if let Some(rest) = text.strip_prefix("tcp://") {
        text = rest.to_string();
    }
    text
}

fn norm_path(raw: &str) -> String {
    raw.trim().replace('\\', "/").to_ascii_lowercase()
}

fn env_is_blank(tag: &str) -> bool {
    let tag = tag.trim();
    tag.is_empty() || tag == "unknown"
}

fn unique_strings(items: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for item in items {
        let trimmed = item.trim();
        if trimmed.is_empty() || !seen.insert(trimmed.to_string()) {
            continue;
        }
        out.push(trimmed.to_string());
    }
    out
}

fn id_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 200
        && id
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':' | '.'))
}

fn is_protected(id: &str) -> bool {
    id == BUILTIN_META_DB_CONN_ID
        || id == BUILTIN_FILE_INDEX_CONN_ID
        || id == "docker-local"
        || id == "local-terminal"
}

fn vault_present(reference: &str) -> bool {
    Vault::get(reference)
        .ok()
        .is_some_and(|value| !value.trim().is_empty())
}

fn copy_vault(from: &str, to: &str) {
    if from == to || vault_present(to) {
        return;
    }
    if let Ok(value) = Vault::get(from) {
        if !value.trim().is_empty() {
            let _ = Vault::store(to, &value);
        }
    }
}

fn retarget_ref(reference: &str, from: &str, to: &str) -> String {
    if reference.contains(from) {
        reference.replace(from, to)
    } else {
        reference.to_string()
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ssh(id: &str, name: &str, host: &str, updated_at: i64) -> Connection {
        Connection {
            id: id.into(),
            kind: ConnectionKind::Ssh,
            name: name.into(),
            group: String::new(),
            env_tag: "dev".into(),
            tags: vec![format!("from-{id}")],
            config: json!({ "host": host, "port": 22, "user": "root" }).to_string(),
            credential_ref: None,
            created_at: 1,
            updated_at,
        }
    }

    #[test]
    fn groups_same_ssh_endpoint_and_rewrites_references() {
        let storage = Storage::open_in_memory().expect("memory");
        storage
            .save_connection(&ssh("ssh-keep", "生产 A", "10.0.0.8", 10))
            .unwrap();
        storage
            .save_connection(&ssh("ssh-drop", "生产 A 副本", "10.0.0.8", 20))
            .unwrap();
        storage
            .save_connection(&ssh("ssh-other", "别的机器", "10.0.0.9", 10))
            .unwrap();
        let docker = Connection {
            id: "docker-bound".into(),
            kind: ConnectionKind::Docker,
            name: "远端引擎".into(),
            group: String::new(),
            env_tag: "dev".into(),
            tags: vec![],
            config: json!({
                "source": "ssh-engine",
                "boundSshConnectionId": "ssh-drop"
            })
            .to_string(),
            credential_ref: None,
            created_at: 1,
            updated_at: 1,
        };
        storage.save_connection(&docker).unwrap();
        storage
            .conn()
            .execute(
                "INSERT INTO sql_executions (
                    id, executed_at, connection_id, connection_name, database_name, env_tag,
                    tab_id, sql, display_name, status, rows_affected, row_count, error, pinned,
                    result_truncated, normalized_sql
                ) VALUES ('e1', 1, 'ssh-drop', '生产 A 副本', '', 'dev', '', 'select 1', '', 'ok', 0, 0, '', 0, 0, 'select 1')",
                [],
            )
            .unwrap();

        let scan = scan_resource_duplicates(&storage, &[]).unwrap();
        assert_eq!(scan.groups.len(), 1);
        assert_eq!(scan.groups[0].kind, "ssh");
        assert!(scan.groups[0].members.iter().any(|member| member.id == "ssh-drop" && member.preferred));

        let report = apply_resource_dedupe(
            &storage,
            None,
            r#"{"groups":[{"keepId":"ssh-keep","dropIds":["ssh-drop"]}]}"#,
        )
        .unwrap();
        assert_eq!(report.removed, 1);
        assert!(storage.get_connection("ssh-drop").unwrap().is_none());
        assert!(storage.get_connection("ssh-other").unwrap().is_some());
        let keeper = storage.get_connection("ssh-keep").unwrap().unwrap();
        assert!(keeper.tags.iter().any(|tag| tag == "from-ssh-drop"));
        let bound = storage.get_connection("docker-bound").unwrap().unwrap();
        assert!(bound.config.contains("ssh-keep"));
        assert!(!bound.config.contains("ssh-drop"));
        let connection_id: String = storage
            .conn()
            .query_row(
                "SELECT connection_id FROM sql_executions WHERE id = 'e1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(connection_id, "ssh-keep");
    }

    #[test]
    fn refuses_to_drop_unrelated_or_protected_ids() {
        let storage = Storage::open_in_memory().expect("memory");
        storage
            .save_connection(&ssh("ssh-a", "A", "10.1.1.1", 1))
            .unwrap();
        storage
            .save_connection(&ssh("ssh-b", "B", "10.1.1.1", 2))
            .unwrap();
        let err = apply_resource_dedupe(
            &storage,
            None,
            r#"{"groups":[{"keepId":"ssh-a","dropIds":["ssh-missing"]}]}"#,
        )
        .unwrap_err();
        assert_eq!(err.code, omnipanel_error::ErrorCode::InvalidInput);
    }
}
