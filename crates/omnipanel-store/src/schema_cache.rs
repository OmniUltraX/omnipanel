//! Schema 树节点缓存：`~/.omnipd/database/schema-cache.json`。
//! 仅在用户点击刷新时从数据库拉取并写入；平时 UI 只读此文件。

use std::collections::HashMap;
use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::paths;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub is_pk: bool,
    pub is_fk: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheIndex {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheTable {
    pub name: String,
    #[serde(default)]
    pub columns: Vec<SchemaCacheColumn>,
    #[serde(default)]
    pub indexes: Vec<SchemaCacheIndex>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheRoutine {
    pub name: String,
    pub routine_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheUser {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheDatabase {
    pub name: String,
    #[serde(default)]
    pub tables: Vec<SchemaCacheTable>,
    #[serde(default)]
    pub views: Vec<SchemaCacheTable>,
    #[serde(default)]
    pub routines: Vec<SchemaCacheRoutine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_error: Option<String>,
    /// 是否已拉取该库下的表/视图/例程（连接级浅刷新为 false，展开库后再 true）。
    #[serde(default)]
    pub objects_loaded: bool,
    /// Redis：key 条数；其它引擎忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub key_count: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheConnection {
    #[serde(default)]
    pub databases: Vec<SchemaCacheDatabase>,
    #[serde(default)]
    pub users: Vec<SchemaCacheUser>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub refreshed_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 全部连接的 Schema 缓存快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheSnapshot {
    #[serde(default)]
    pub connections: HashMap<String, SchemaCacheConnection>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaCacheFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(flatten)]
    snapshot: SchemaCacheSnapshot,
}

fn default_version() -> u32 {
    1
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写 Schema 缓存失败").with_cause(err.to_string())
}

fn map_json(err: serde_json::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "解析 Schema 缓存失败").with_cause(err.to_string())
}

pub fn load_schema_cache() -> OmniResult<SchemaCacheSnapshot> {
    let path = paths::database_schema_cache_path()?;
    load_schema_cache_from(&path)
}

pub fn load_schema_cache_from(path: &Path) -> OmniResult<SchemaCacheSnapshot> {
    if !path.is_file() {
        return Ok(SchemaCacheSnapshot::default());
    }
    let content = std::fs::read_to_string(path).map_err(map_io)?;
    if content.trim().is_empty() {
        return Ok(SchemaCacheSnapshot::default());
    }
    let file: SchemaCacheFile = serde_json::from_str(&content).map_err(map_json)?;
    Ok(file.snapshot)
}

pub fn save_schema_cache(snapshot: &SchemaCacheSnapshot) -> OmniResult<()> {
    let path = paths::database_schema_cache_path()?;
    save_schema_cache_to(&path, snapshot)
}

/// 增量写入单连接 Schema 缓存（读-合并-写），避免前端每次传整包快照。
pub fn patch_schema_cache_connection(
    conn_id: &str,
    entry: SchemaCacheConnection,
) -> OmniResult<SchemaCacheConnection> {
    let path = paths::database_schema_cache_path()?;
    let mut snapshot = load_schema_cache_from(&path)?;
    let previous = snapshot.connections.get(conn_id).cloned();
    let mut merged = merge_schema_cache_connection(previous.as_ref(), entry);
    let _ = sanitize_bloated_schema_cache_entry(&mut merged);
    snapshot
        .connections
        .insert(conn_id.to_string(), merged.clone());
    save_schema_cache_to(&path, &snapshot)?;
    Ok(merged)
}

pub fn save_schema_cache_to(path: &Path, snapshot: &SchemaCacheSnapshot) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(map_io)?;
    }
    let file = SchemaCacheFile {
        version: 1,
        snapshot: snapshot.clone(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(map_json)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(map_io)?;
    std::fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

/// 删除连接时清理其 Schema 缓存。
pub fn prune_connection_cache(snapshot: &mut SchemaCacheSnapshot, conn_id: &str) {
    snapshot.connections.remove(conn_id);
}

const SCHEMA_CACHE_BLOAT_TABLE_THRESHOLD: usize = 500;

fn database_has_bloated_object_list(db: &SchemaCacheDatabase) -> bool {
    db.tables.len() > SCHEMA_CACHE_BLOAT_TABLE_THRESHOLD
        || db.views.len() > SCHEMA_CACHE_BLOAT_TABLE_THRESHOLD
}

fn strip_database_object_lists(db: &mut SchemaCacheDatabase) -> bool {
    let had_objects = !db.tables.is_empty() || !db.views.is_empty() || !db.routines.is_empty();
    db.tables.clear();
    db.views.clear();
    db.routines.clear();
    had_objects
}

/// Redis 连接：清空各逻辑库下的 key 列表，仅保留库名元信息。
pub fn sanitize_redis_schema_cache_entry(entry: &mut SchemaCacheConnection) -> bool {
    let mut changed = false;
    for db in &mut entry.databases {
        if strip_database_object_lists(db) {
            changed = true;
        }
    }
    changed
}

/// 清除异常膨胀的对象列表（如历史 Redis KEYS 全量缓存）。
pub fn sanitize_bloated_schema_cache_entry(entry: &mut SchemaCacheConnection) -> bool {
    let mut changed = false;
    for db in &mut entry.databases {
        if database_has_bloated_object_list(db) && strip_database_object_lists(db) {
            changed = true;
        }
    }
    changed
}

fn database_has_loaded_objects(db: &SchemaCacheDatabase) -> bool {
    db.objects_loaded || !db.tables.is_empty() || !db.views.is_empty() || !db.routines.is_empty()
}

/// 连接级浅刷新合并：保留本地已加载的库对象，仅更新库名列表 / 用户 / 错误。
pub fn merge_schema_cache_connection(
    previous: Option<&SchemaCacheConnection>,
    incoming: SchemaCacheConnection,
) -> SchemaCacheConnection {
    if let Some(err) = incoming.error.clone() {
        // 刷新失败：保留旧库表缓存，只挂上错误，避免整棵树被清空
        if let Some(prev) = previous {
            return SchemaCacheConnection {
                databases: prev.databases.clone(),
                users: prev.users.clone(),
                refreshed_at: incoming.refreshed_at.or(prev.refreshed_at),
                error: Some(err),
            };
        }
        return incoming;
    }
    let Some(prev) = previous else {
        return incoming;
    };

    let prev_by_name: HashMap<&str, &SchemaCacheDatabase> = prev
        .databases
        .iter()
        .map(|db| (db.name.as_str(), db))
        .collect();

    let databases = incoming
        .databases
        .into_iter()
        .map(|db| {
            if db.objects_loaded || database_has_loaded_objects(&db) {
                return db;
            }
            if let Some(old) = prev_by_name.get(db.name.as_str()) {
                if database_has_loaded_objects(old) {
                    let mut kept = (*old).clone();
                    kept.objects_loaded = true;
                    return kept;
                }
            }
            db
        })
        .collect();

    SchemaCacheConnection {
        databases,
        users: if incoming.users.is_empty() {
            prev.users.clone()
        } else {
            incoming.users
        },
        refreshed_at: incoming.refreshed_at.or(prev.refreshed_at),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_reload_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schema-cache.json");
        let mut snapshot = SchemaCacheSnapshot {
            connections: HashMap::from([
                (
                    "c1".into(),
                    SchemaCacheConnection {
                        databases: vec![SchemaCacheDatabase {
                            name: "app".into(),
                            tables: vec![SchemaCacheTable {
                                name: "users".into(),
                                columns: vec![],
                                indexes: vec![],
                                comment: None,
                            }],
                            views: vec![],
                            routines: vec![],
                            load_error: None,
                            objects_loaded: true,
                            key_count: None,
                        }],
                        users: vec![],
                        refreshed_at: Some(1),
                        error: None,
                    },
                ),
                ("c2".into(), SchemaCacheConnection::default()),
            ]),
        };
        save_schema_cache_to(&path, &snapshot).unwrap();
        let loaded = load_schema_cache_from(&path).unwrap();
        assert_eq!(loaded.connections.len(), 2);

        prune_connection_cache(&mut snapshot, "c1");
        assert!(!snapshot.connections.contains_key("c1"));
    }

    #[test]
    fn sanitize_redis_and_bloated_entries() {
        let mut entry = SchemaCacheConnection {
            databases: vec![
                SchemaCacheDatabase {
                    name: "0".into(),
                    tables: vec![SchemaCacheTable {
                        name: "user:1".into(),
                        columns: vec![],
                        indexes: vec![],
                        comment: None,
                    }],
                    views: vec![],
                    routines: vec![],
                    load_error: None,
                    objects_loaded: true,
                    key_count: Some(1),
                },
                SchemaCacheDatabase {
                    name: "11".into(),
                    tables: (0..600)
                        .map(|i| SchemaCacheTable {
                            name: format!("key_{i}"),
                            columns: vec![],
                            indexes: vec![],
                            comment: None,
                        })
                        .collect(),
                    views: vec![],
                    routines: vec![],
                    load_error: None,
                    objects_loaded: true,
                    key_count: None,
                },
            ],
            users: vec![],
            refreshed_at: Some(1),
            error: None,
        };
        assert!(sanitize_redis_schema_cache_entry(&mut entry));
        assert!(entry.databases.iter().all(|db| db.tables.is_empty()));

        entry.databases[1].tables = (0..600)
            .map(|i| SchemaCacheTable {
                name: format!("key_{i}"),
                columns: vec![],
                indexes: vec![],
                comment: None,
            })
            .collect();
        assert!(sanitize_bloated_schema_cache_entry(&mut entry));
        assert!(entry.databases[1].tables.is_empty());
    }
}
