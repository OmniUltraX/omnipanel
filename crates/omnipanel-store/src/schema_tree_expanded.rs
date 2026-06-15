//! Schema 树展开状态持久化：`~/.omnipd/database/schema-tree-expanded.json`。

use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::paths;

/// Schema 树已展开节点 id 快照（与前端 `expanded` Set 的 key 一致）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTreeExpandedSnapshot {
    #[serde(default)]
    pub expanded_node_ids: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchemaTreeExpandedFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(flatten)]
    snapshot: SchemaTreeExpandedSnapshot,
}

fn default_version() -> u32 {
    1
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写 Schema 树展开状态失败").with_cause(err.to_string())
}

fn map_json(err: serde_json::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "解析 Schema 树展开状态失败").with_cause(err.to_string())
}

pub fn load_schema_tree_expanded() -> OmniResult<SchemaTreeExpandedSnapshot> {
    let path = paths::database_schema_tree_expanded_path()?;
    load_schema_tree_expanded_from(&path)
}

pub fn load_schema_tree_expanded_from(path: &Path) -> OmniResult<SchemaTreeExpandedSnapshot> {
    if !path.is_file() {
        return Ok(SchemaTreeExpandedSnapshot::default());
    }
    let content = std::fs::read_to_string(path).map_err(map_io)?;
    if content.trim().is_empty() {
        return Ok(SchemaTreeExpandedSnapshot::default());
    }
    let file: SchemaTreeExpandedFile = serde_json::from_str(&content).map_err(map_json)?;
    Ok(file.snapshot)
}

pub fn save_schema_tree_expanded(snapshot: &SchemaTreeExpandedSnapshot) -> OmniResult<()> {
    let path = paths::database_schema_tree_expanded_path()?;
    save_schema_tree_expanded_to(&path, snapshot)
}

pub fn save_schema_tree_expanded_to(
    path: &Path,
    snapshot: &SchemaTreeExpandedSnapshot,
) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(map_io)?;
    }
    let file = SchemaTreeExpandedFile {
        version: 1,
        snapshot: snapshot.clone(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(map_json)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(map_io)?;
    std::fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

fn node_belongs_to_connection(node_id: &str, conn_id: &str) -> bool {
    if let Some(rest) = node_id.strip_prefix("conn:") {
        return rest == conn_id;
    }
    if let Some(rest) = node_id.strip_prefix("db:") {
        return rest.starts_with(&format!("{conn_id}:"));
    }
    if let Some(rest) = node_id.strip_prefix("tbl:") {
        return rest.starts_with(&format!("{conn_id}:"));
    }
    false
}

/// 删除连接时清理其相关的展开节点 id。
pub fn prune_connection_expanded(snapshot: &mut SchemaTreeExpandedSnapshot, conn_id: &str) {
    snapshot
        .expanded_node_ids
        .retain(|id| !node_belongs_to_connection(id, conn_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_reload_and_prune() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("schema-tree-expanded.json");
        let mut snapshot = SchemaTreeExpandedSnapshot {
            expanded_node_ids: vec![
                "grp:g1".into(),
                "conn:c1".into(),
                "db:c1:app".into(),
                "tbl:c1:app:users".into(),
                "conn:c2".into(),
            ],
        };
        save_schema_tree_expanded_to(&path, &snapshot).unwrap();
        let loaded = load_schema_tree_expanded_from(&path).unwrap();
        assert_eq!(loaded.expanded_node_ids.len(), 5);

        prune_connection_expanded(&mut snapshot, "c1");
        assert_eq!(
            snapshot.expanded_node_ids,
            vec!["grp:g1".to_string(), "conn:c2".to_string()]
        );
    }
}
