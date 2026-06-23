//! Schema 树过滤显示持久化：`~/.omnipd/database/schema-filters.json`。

use std::collections::HashMap;
use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::paths;

/// 单个连接或库下的过滤项（与前端 `SchemaFilterState` 对应，可见项为列表）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaFilterRecord {
    pub ordered_names: Vec<String>,
    pub visible_names: Vec<String>,
    #[serde(default)]
    pub pinned_names: Vec<String>,
}

/// 全部连接的 Schema 过滤快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaFiltersSnapshot {
    #[serde(default)]
    pub database_filters: HashMap<String, SchemaFilterRecord>,
    #[serde(default)]
    pub table_filters: HashMap<String, SchemaFilterRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaFiltersFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(flatten)]
    snapshot: SchemaFiltersSnapshot,
}

fn default_version() -> u32 {
    1
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写 Schema 过滤配置失败").with_cause(err.to_string())
}

fn map_json(err: serde_json::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "解析 Schema 过滤配置失败").with_cause(err.to_string())
}

pub fn load_schema_filters() -> OmniResult<SchemaFiltersSnapshot> {
    let path = paths::database_schema_filters_path()?;
    load_schema_filters_from(&path)
}

pub fn load_schema_filters_from(path: &Path) -> OmniResult<SchemaFiltersSnapshot> {
    if !path.is_file() {
        return Ok(SchemaFiltersSnapshot::default());
    }
    let content = std::fs::read_to_string(path).map_err(map_io)?;
    if content.trim().is_empty() {
        return Ok(SchemaFiltersSnapshot::default());
    }
    let file: SchemaFiltersFile = serde_json::from_str(&content).map_err(map_json)?;
    Ok(file.snapshot)
}

pub fn save_schema_filters(snapshot: &SchemaFiltersSnapshot) -> OmniResult<()> {
    let path = paths::database_schema_filters_path()?;
    save_schema_filters_to(&path, snapshot)
}

pub fn save_schema_filters_to(path: &Path, snapshot: &SchemaFiltersSnapshot) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(map_io)?;
    }
    let file = SchemaFiltersFile {
        version: 1,
        snapshot: snapshot.clone(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(map_json)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(map_io)?;
    std::fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

/// 删除连接时清理其数据库/表过滤项。表过滤键格式为 `{connId}:{dbName}`。
pub fn prune_connection_filters(snapshot: &mut SchemaFiltersSnapshot, conn_id: &str) {
    snapshot.database_filters.remove(conn_id);
    let prefix = format!("{conn_id}:");
    snapshot
        .table_filters
        .retain(|key, _| !key.starts_with(&prefix));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_reload_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schema-filters.json");
        let mut snapshot = SchemaFiltersSnapshot::default();
        snapshot.database_filters.insert(
            "conn-1".into(),
            SchemaFilterRecord {
                ordered_names: vec!["app".into()],
                visible_names: vec!["app".into()],
                pinned_names: vec![],
            },
        );
        snapshot.table_filters.insert(
            "conn-1:app".into(),
            SchemaFilterRecord {
                ordered_names: vec!["users".into()],
                visible_names: vec![],
                pinned_names: vec![],
            },
        );
        save_schema_filters_to(&path, &snapshot).unwrap();
        let loaded = load_schema_filters_from(&path).unwrap();
        assert_eq!(loaded.database_filters.len(), 1);
        assert_eq!(loaded.table_filters.len(), 1);

        prune_connection_filters(&mut snapshot, "conn-1");
        assert!(snapshot.database_filters.is_empty());
        assert!(snapshot.table_filters.is_empty());
    }
}
