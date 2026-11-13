//! 侧栏文件夹按结构合并。整份 JSON 互相覆盖会把另一台的分组丢掉。

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value};

#[derive(Clone)]
struct LayoutFolder {
    id: String,
    name: String,
    parent_id: Option<String>,
}

pub fn merge_layout_document(path: &str, local: &[u8], remote: &[u8]) -> Option<Vec<u8>> {
    let local_value = parse_json(local)?;
    let remote_value = parse_json(remote)?;
    let merged = if path == "tree/ssh.json" {
        merge_ssh_tree(&remote_value, &local_value)?
    } else if path == "tree/folders.json" {
        merge_folders_document(&remote_value, &local_value)?
    } else {
        return None;
    };
    let mut bytes = serde_json::to_vec(&merged).ok()?;
    bytes.push(b'\n');
    Some(bytes)
}

fn parse_json(bytes: &[u8]) -> Option<Value> {
    let text = std::str::from_utf8(bytes).ok()?.trim();
    if text.is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn merge_folders_document(remote: &Value, local: &Value) -> Option<Value> {
    let remote_obj = remote.as_object()?;
    let local_obj = local.as_object()?;
    let mut out = remote_obj.clone();
    let mut keys = BTreeSet::new();
    keys.extend(remote_obj.keys().cloned());
    keys.extend(local_obj.keys().cloned());
    for key in keys {
        let merged = match (remote_obj.get(&key), local_obj.get(&key)) {
            (Some(remote_node), Some(local_node)) => match key.as_str() {
                "docker" => merge_placement_tree(remote_node, local_node)?,
                "database" => merge_database_tree(remote_node, local_node)?,
                "protocol" => merge_protocol_tree(remote_node, local_node)?,
                _ => remote_node.clone(),
            },
            (None, Some(local_node)) => local_node.clone(),
            (Some(remote_node), None) => remote_node.clone(),
            (None, None) => continue,
        };
        out.insert(key, merged);
    }
    Some(Value::Object(out))
}

fn merge_ssh_tree(remote: &Value, local: &Value) -> Option<Value> {
    let mut merged = merge_placement_tree(remote, local)?;
    let obj = merged.as_object_mut()?;
    let groups = bool_field(remote, "groupsMigrated") || bool_field(local, "groupsMigrated");
    obj.insert("groupsMigrated".into(), Value::Bool(groups));
    obj.insert(
        "dismissedAutoFolders".into(),
        Value::Array(union_strings(
            string_array(remote, "dismissedAutoFolders"),
            string_array(local, "dismissedAutoFolders"),
        )),
    );
    Some(merged)
}

fn merge_placement_tree(remote: &Value, local: &Value) -> Option<Value> {
    if folder_count(remote) == 0 && folder_count(local) > 0 {
        return Some(local.clone());
    }
    if folder_count(local) == 0 {
        return Some(remote.clone());
    }
    let (folders, alias) = coalesce_folders(&folders_of(remote), &folders_of(local));
    let mut obj = remote.as_object().cloned().unwrap_or_default();
    obj.insert("folders".into(), folders_value(&folders));
    obj.insert(
        "connectionFolderId".into(),
        Value::Object(merge_id_map(
            object_map(remote, "connectionFolderId"),
            object_map(local, "connectionFolderId"),
            &alias,
        )),
    );
    obj.insert(
        "orderByParent".into(),
        Value::Object(merge_order_map(
            order_map(remote, "orderByParent"),
            order_map(local, "orderByParent"),
            &alias,
        )),
    );
    Some(Value::Object(obj))
}

fn merge_database_tree(remote: &Value, local: &Value) -> Option<Value> {
    if folder_count(remote) == 0 && folder_count(local) > 0 {
        return Some(local.clone());
    }
    if folder_count(local) == 0 {
        return Some(remote.clone());
    }
    let (folders, alias) = coalesce_folders(&folders_of(remote), &folders_of(local));
    let mut obj = remote.as_object().cloned().unwrap_or_default();
    obj.insert("folders".into(), folders_value(&folders));
    obj.insert(
        "connectionParents".into(),
        Value::Object(merge_nullable_id_map(
            nullable_map(remote, "connectionParents"),
            nullable_map(local, "connectionParents"),
            &alias,
        )),
    );
    Some(Value::Object(obj))
}

fn merge_protocol_tree(remote: &Value, local: &Value) -> Option<Value> {
    if folder_count(remote) == 0 && folder_count(local) > 0 {
        return Some(local.clone());
    }
    if folder_count(local) == 0 {
        return Some(remote.clone());
    }
    let (folders, alias) = coalesce_folders(&folders_of(remote), &folders_of(local));
    let mut obj = remote.as_object().cloned().unwrap_or_default();
    obj.insert("folders".into(), folders_value(&folders));
    for field in ["collectionParents", "requestParents", "entryParents"] {
        obj.insert(
            field.into(),
            Value::Object(merge_nullable_id_map(
                nullable_map(remote, field),
                nullable_map(local, field),
                &alias,
            )),
        );
    }
    obj.insert(
        "siblingOrder".into(),
        Value::Object(merge_order_map(
            order_map(remote, "siblingOrder"),
            order_map(local, "siblingOrder"),
            &alias,
        )),
    );
    for field in ["expandedFolderIds", "expandedCollectionIds"] {
        let mut ids = union_strings(string_array(remote, field), string_array(local, field));
        for id in &mut ids {
            if let Some(canon) = alias.get(id.as_str().unwrap_or("")) {
                *id = Value::String(canon.clone());
            }
        }
        obj.insert(field.into(), Value::Array(dedupe_strings(ids)));
    }
    Some(Value::Object(obj))
}

fn coalesce_folders(
    remote: &[LayoutFolder],
    local: &[LayoutFolder],
) -> (Vec<LayoutFolder>, BTreeMap<String, String>) {
    let mut folders = remote.to_vec();
    let mut alias = BTreeMap::new();
    let mut name_index = BTreeMap::new();
    for folder in &folders {
        name_index.insert(
            name_key(folder.parent_id.as_deref(), &folder.name),
            folder.id.clone(),
        );
    }
    let remote_ids: BTreeSet<String> = remote.iter().map(|folder| folder.id.clone()).collect();
    let mut pending: Vec<LayoutFolder> = local
        .iter()
        .filter(|folder| !remote_ids.contains(&folder.id))
        .cloned()
        .collect();
    let mut spins = pending.len().saturating_add(1);
    while !pending.is_empty() && spins > 0 {
        spins -= 1;
        let batch = std::mem::take(&mut pending);
        let batch_len = batch.len();
        let known: BTreeSet<String> = folders.iter().map(|folder| folder.id.clone()).collect();
        let mut deferred = Vec::new();
        for folder in batch {
            let parent_ready = match folder.parent_id.as_deref() {
                None => true,
                Some(parent) => known.contains(parent) || alias.contains_key(parent),
            };
            if !parent_ready {
                deferred.push(folder);
                continue;
            }
            place_folder(&mut folders, &mut alias, &mut name_index, folder);
        }
        if deferred.is_empty() {
            break;
        }
        // 父文件夹还没出现，或互相引用：不再等，按现有 parentId 挂上。
        if deferred.len() == batch_len {
            for folder in deferred {
                place_folder(&mut folders, &mut alias, &mut name_index, folder);
            }
            break;
        }
        pending = deferred;
    }
    (folders, alias)
}

fn place_folder(
    folders: &mut Vec<LayoutFolder>,
    alias: &mut BTreeMap<String, String>,
    name_index: &mut BTreeMap<String, String>,
    folder: LayoutFolder,
) {
    if folders.iter().any(|have| have.id == folder.id) {
        return;
    }
    let canonical_parent = folder
        .parent_id
        .as_ref()
        .map(|parent| alias.get(parent).cloned().unwrap_or_else(|| parent.clone()));
    let key = name_key(canonical_parent.as_deref(), &folder.name);
    if let Some(existing) = name_index.get(&key) {
        alias.insert(folder.id, existing.clone());
        return;
    }
    let placed = LayoutFolder {
        id: folder.id,
        name: folder.name,
        parent_id: canonical_parent,
    };
    name_index.insert(key, placed.id.clone());
    folders.push(placed);
}

fn name_key(parent: Option<&str>, name: &str) -> String {
    format!("{}\u{1}{}", parent.unwrap_or(""), name)
}

fn folder_count(value: &Value) -> usize {
    value
        .get("folders")
        .and_then(Value::as_array)
        .map(Vec::len)
        .unwrap_or(0)
}

fn folders_of(value: &Value) -> Vec<LayoutFolder> {
    let Some(list) = value.get("folders").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in list {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        let name = item
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let parent_id = item
            .get("parentId")
            .and_then(Value::as_str)
            .filter(|parent| !parent.is_empty())
            .map(str::to_string);
        out.push(LayoutFolder {
            id: id.to_string(),
            name,
            parent_id,
        });
    }
    out
}

fn folders_value(folders: &[LayoutFolder]) -> Value {
    Value::Array(
        folders
            .iter()
            .map(|folder| {
                serde_json::json!({
                    "id": folder.id,
                    "name": folder.name,
                    "parentId": folder.parent_id,
                })
            })
            .collect(),
    )
}

fn object_map(value: &Value, field: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let Some(obj) = value.get(field).and_then(Value::as_object) else {
        return out;
    };
    for (key, item) in obj {
        if let Some(text) = item.as_str() {
            if !text.is_empty() {
                out.insert(key.clone(), text.to_string());
            }
        }
    }
    out
}

fn nullable_map(value: &Value, field: &str) -> BTreeMap<String, Option<String>> {
    let mut out = BTreeMap::new();
    let Some(obj) = value.get(field).and_then(Value::as_object) else {
        return out;
    };
    for (key, item) in obj {
        if item.is_null() {
            out.insert(key.clone(), None);
        } else if let Some(text) = item.as_str() {
            out.insert(
                key.clone(),
                if text.is_empty() {
                    None
                } else {
                    Some(text.to_string())
                },
            );
        }
    }
    out
}

fn order_map(value: &Value, field: &str) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::new();
    let Some(obj) = value.get(field).and_then(Value::as_object) else {
        return out;
    };
    for (key, item) in obj {
        let Some(list) = item.as_array() else {
            continue;
        };
        out.insert(
            key.clone(),
            list.iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect(),
        );
    }
    out
}

fn merge_id_map(
    remote: BTreeMap<String, String>,
    local: BTreeMap<String, String>,
    alias: &BTreeMap<String, String>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for (id, folder) in &remote {
        out.insert(id.clone(), Value::String(canon(alias, folder)));
    }
    for (id, folder) in local {
        if out.contains_key(&id) {
            continue;
        }
        out.insert(id, Value::String(canon(alias, &folder)));
    }
    out
}

fn merge_nullable_id_map(
    remote: BTreeMap<String, Option<String>>,
    local: BTreeMap<String, Option<String>>,
    alias: &BTreeMap<String, String>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for (id, folder) in &remote {
        out.insert(id.clone(), nullable_folder(alias, folder.as_deref()));
    }
    for (id, folder) in local {
        if out.contains_key(&id) {
            continue;
        }
        out.insert(id, nullable_folder(alias, folder.as_deref()));
    }
    out
}

fn nullable_folder(alias: &BTreeMap<String, String>, folder: Option<&str>) -> Value {
    match folder {
        Some(folder) => Value::String(canon(alias, folder)),
        None => Value::Null,
    }
}

fn merge_order_map(
    remote: BTreeMap<String, Vec<String>>,
    local: BTreeMap<String, Vec<String>>,
    alias: &BTreeMap<String, String>,
) -> Map<String, Value> {
    let mut keys = BTreeSet::new();
    keys.extend(remote.keys().cloned());
    keys.extend(local.keys().cloned());
    let mut grouped: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for key in keys {
        let canon_key = canon_order_key(alias, &key);
        let mut list = grouped.remove(&canon_key).unwrap_or_default();
        if let Some(items) = remote.get(&key) {
            push_unique(&mut list, items.iter().map(|item| remap_node(alias, item)));
        }
        if let Some(items) = local.get(&key) {
            push_unique(&mut list, items.iter().map(|item| remap_node(alias, item)));
        }
        grouped.insert(canon_key, list);
    }
    grouped
        .into_iter()
        .map(|(key, list)| {
            (
                key,
                Value::Array(list.into_iter().map(Value::String).collect()),
            )
        })
        .collect()
}

fn canon(alias: &BTreeMap<String, String>, id: &str) -> String {
    alias.get(id).cloned().unwrap_or_else(|| id.to_string())
}

fn canon_order_key(alias: &BTreeMap<String, String>, key: &str) -> String {
    if key == "__root__" || key == "root" {
        return key.to_string();
    }
    remap_node(alias, key)
}

fn remap_node(alias: &BTreeMap<String, String>, key: &str) -> String {
    if let Some(canon) = alias.get(key) {
        return canon.clone();
    }
    for prefix in ["f:", "folder:"] {
        if let Some(id) = key.strip_prefix(prefix) {
            if let Some(canon) = alias.get(id) {
                return format!("{prefix}{canon}");
            }
        }
    }
    key.to_string()
}

fn push_unique(out: &mut Vec<String>, items: impl Iterator<Item = String>) {
    for item in items {
        if !out.iter().any(|have| have == &item) {
            out.push(item);
        }
    }
}

fn bool_field(value: &Value, field: &str) -> bool {
    value.get(field).and_then(Value::as_bool).unwrap_or(false)
}

fn string_array(value: &Value, field: &str) -> Vec<Value> {
    value
        .get(field)
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| item.as_str().map(|text| Value::String(text.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn union_strings(remote: Vec<Value>, local: Vec<Value>) -> Vec<Value> {
    dedupe_strings(remote.into_iter().chain(local).collect())
}

fn dedupe_strings(values: Vec<Value>) -> Vec<Value> {
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for value in values {
        let Some(text) = value.as_str() else {
            continue;
        };
        if seen.insert(text.to_string()) {
            out.push(Value::String(text.to_string()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ssh_tree_keeps_both_folders_and_coalesces_same_name() {
        let remote = br#"{
            "folders":[{"id":"b","name":"~/.ssh/config","parentId":null}],
            "connectionFolderId":{"h2":"b"},
            "orderByParent":{"__root__":["f:b"],"b":["c:h2"]},
            "groupsMigrated":true,
            "dismissedAutoFolders":[]
        }"#;
        let local = br#"{
            "folders":[
                {"id":"a","name":"~/.ssh/config","parentId":null},
                {"id":"w","name":"Warpgate","parentId":null}
            ],
            "connectionFolderId":{"h1":"w","h2":"a"},
            "orderByParent":{"__root__":["f:a","f:w"],"w":["c:h1"],"a":["c:h2"]},
            "groupsMigrated":true,
            "dismissedAutoFolders":["gone"]
        }"#;
        let merged = merge_layout_document("tree/ssh.json", local, remote).expect("merge");
        let value: Value = serde_json::from_slice(&merged).expect("json");
        let names: Vec<&str> = value["folders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|folder| folder["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["~/.ssh/config", "Warpgate"]);
        assert_eq!(value["connectionFolderId"]["h1"], "w");
        assert_eq!(value["connectionFolderId"]["h2"], "b");
        assert!(
            value["dismissedAutoFolders"]
                .as_array()
                .unwrap()
                .iter()
                .any(|item| item == "gone")
        );
    }
}
