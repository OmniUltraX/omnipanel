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
}
