//! 本机空间检出与内容索引。一条记录一个文件，块 id 是内容哈希。
//! 未登录只写到本机，不上传，也不加密。保险库明文不在这一步写出。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::storage::{Storage, map_sqlite};
use crate::todo::TodoTaskQuery;

pub const SPACE_DIR: &str = "space";
pub const REPO_DIR: &str = "repo";
/// 单块上限。一条普通记录通常只有一块。
pub const CHUNK_SIZE: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRepoFile {
    pub path: String,
    pub size: u64,
    pub chunks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRepoIndex {
    pub id: String,
    pub files: Vec<SpaceRepoFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceRepoReport {
    pub index_id: String,
    pub file_count: u32,
    pub chunk_count: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KnowledgeCheckout<'a> {
    entry: &'a crate::knowledge::KnowledgeEntry,
    revisions: &'a [crate::knowledge::KnowledgeRevision],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TodoTaskCheckout<'a> {
    task: &'a crate::todo::TodoTask,
    steps: &'a [crate::todo::TodoStep],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TodoListCheckout<'a> {
    list: &'a crate::todo::TodoList,
    tasks: &'a [TodoTaskCheckout<'a>],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PluginCheckout {
    id: String,
    enabled: Option<bool>,
    state: Option<Value>,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// 按内容切块。空文件也有一块，避免路径从索引里消失。
pub fn split_chunks(bytes: &[u8]) -> Vec<(String, Vec<u8>)> {
    if bytes.is_empty() {
        return vec![(sha256_hex(bytes), Vec::new())];
    }
    bytes
        .chunks(CHUNK_SIZE)
        .map(|chunk| (sha256_hex(chunk), chunk.to_vec()))
        .collect()
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, err.to_string())
}

fn json_bytes<T: Serialize>(value: &T) -> OmniResult<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn is_safe_segment(id: &str) -> bool {
    !id.is_empty()
        && id != "."
        && id != ".."
        && !id.contains('\0')
        && !id.contains('/')
        && !id.contains('\\')
        && !id.contains("..")
}

fn record_file(dir: &str, id: &str) -> OmniResult<String> {
    if !is_safe_segment(id) {
        return Err(OmniError::invalid_input(format!("非法记录 id: {id}")));
    }
    Ok(format!("{dir}/{id}.json"))
}

/// 库能整份重写的目录。其余文件（数据库连接、保险库、未传入的布局）留在检出里。
const COLLECTED_PREFIXES: &[&str] = &[
    "connections",
    "sshkeys",
    "knowledge",
    "http",
    "workflows",
    "todos",
    "accounts",
    "skills",
    "plugins",
];

fn keep_uncollected(
    root: &Path,
    files: &mut BTreeMap<String, Vec<u8>>,
    extra: &BTreeMap<String, Vec<u8>>,
) -> OmniResult<()> {
    let space = root.join(SPACE_DIR);
    if !space.is_dir() {
        return Ok(());
    }
    let mut managed = BTreeSet::new();
    for prefix in COLLECTED_PREFIXES {
        managed.insert((*prefix).to_string());
    }
    for path in extra.keys() {
        if let Some(prefix) = path.split('/').next() {
            managed.insert(prefix.to_string());
        }
    }
    let mut found = Vec::new();
    walk_files(&space, &mut found)?;
    for path in found {
        let Some(rel) = rel_slash(&space, &path) else {
            continue;
        };
        if !is_safe_rel(&rel) {
            continue;
        }
        let prefix = rel.split('/').next().unwrap_or(rel.as_str());
        if managed.contains(prefix) || files.contains_key(&rel) {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(map_io)?;
        files.insert(rel, bytes);
    }
    Ok(())
}

fn stampable_space_path(path: &str) -> bool {
    const PREFIXES: &[&str] = &[
        "connections/",
        "sshkeys/",
        "knowledge/",
        "http/",
        "workflows/",
        "todos/",
        "accounts/",
        "skills/",
        "plugins/",
        "settings/",
        "tree/",
        "panels/",
        "workspaces/",
        "conversations/",
    ];
    path.ends_with(".json")
        && !path.contains("/assets/")
        && !path.contains("/pack/")
        && PREFIXES.iter().any(|prefix| path.starts_with(prefix))
}

fn attach_known_vault_files(files: &mut BTreeMap<String, Vec<u8>>) {
    for reference in ["space-gateway-key", "http-proxy-password", "embedding-api-key"] {
        attach_vault_file(files, reference);
    }
    let Some(bytes) = files.get("ai/providers.json").cloned() else {
        return;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let Some(list) = value
        .get("httpProviders")
        .or_else(|| value.get("http_providers"))
        .and_then(Value::as_array)
    else {
        return;
    };
    for item in list {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if id.is_empty() {
            continue;
        }
        attach_vault_file(files, &crate::ai_provider_key_ref(id));
    }
}

fn attach_vault_file(files: &mut BTreeMap<String, Vec<u8>>, reference: &str) {
    if reference.is_empty() || reference.contains('/') || reference.contains('\\') {
        return;
    }
    let Ok(secret) = crate::vault::Vault::get(reference) else {
        return;
    };
    if secret.trim().is_empty() {
        return;
    }
    let doc = serde_json::json!({ "reference": reference, "value": secret });
    let Ok(mut bytes) = serde_json::to_vec(&doc) else {
        return;
    };
    bytes.push(b'\n');
    files.insert(format!("vault/{reference}.json"), bytes);
}

fn space_id_in(files: &BTreeMap<String, Vec<u8>>) -> Option<String> {
    let bytes = files.get("meta.json")?;
    let value: Value = serde_json::from_slice(bytes).ok()?;
    let id = value.get("id").and_then(Value::as_str)?.trim().to_string();
    if id.is_empty() { None } else { Some(id) }
}

fn stamp_space_id_field(value: &mut Value, space_id: &str, previous: &str) -> bool {
    let Some(obj) = value.as_object_mut() else {
        return false;
    };
    let current = obj.get("spaceId").and_then(Value::as_str).unwrap_or("");
    if !current.is_empty() && current != previous {
        return false;
    }
    if current == space_id {
        return false;
    }
    obj.insert("spaceId".into(), Value::String(space_id.to_string()));
    true
}

fn stamp_space_ids(files: &mut BTreeMap<String, Vec<u8>>, space_id: &str, previous: &str) {
    if space_id.is_empty() {
        return;
    }
    let paths: Vec<String> = files.keys().cloned().collect();
    for path in paths {
        if !stampable_space_path(&path) {
            continue;
        }
        let Some(bytes) = files.get(&path).cloned() else {
            continue;
        };
        let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let mut changed = stamp_space_id_field(&mut value, space_id, previous);
        for key in ["entry", "workflow", "list"] {
            if let Some(child) = value.get_mut(key) {
                changed |= stamp_space_id_field(child, space_id, previous);
            }
        }
        if !changed {
            continue;
        }
        let Ok(mut out) = serde_json::to_vec(&value) else {
            continue;
        };
        out.push(b'\n');
        files.insert(path, out);
    }
}

fn collect_knowledge_assets(root: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
    let assets = root.join("knowledge").join("assets");
    if !assets.is_dir() {
        return Ok(());
    }
    let mut found = Vec::new();
    walk_files(&assets, &mut found)?;
    for path in found {
        let Some(rel) = rel_slash(&assets, &path) else {
            continue;
        };
        let mut parts = rel.split('/');
        let Some(id) = parts.next() else { continue };
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() || !is_safe_segment(id) {
            continue;
        }
        if rest.iter().any(|seg| !is_safe_segment(seg)) {
            continue;
        }
        let key = format!("knowledge/{id}/assets/{}", rest.join("/"));
        if !is_safe_rel(&key) || files.contains_key(&key) {
            continue;
        }
        let bytes = std::fs::read(&path).map_err(map_io)?;
        files.insert(key, bytes);
    }
    Ok(())
}

/// 桌面插件目录。开发包和正式包各看一处，目录不存在就跳过。
pub fn desktop_plugin_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for id in ["com.omnipanel.app", "com.omnipanel.app.dev"] {
        let dir = plugin_dir_for(id);
        if dir.as_ref().is_some_and(|path| path.is_dir()) {
            if let Some(path) = dir {
                out.push(path);
            }
        }
    }
    out
}

fn plugin_dir_for(id: &str) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        return std::env::var_os("APPDATA")
            .map(|appdata| PathBuf::from(appdata).join(id).join("plugins"));
    }
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(id)
                .join("plugins")
        });
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .map(|home| PathBuf::from(home).join(".local").join("share"))
            });
        return base.map(|dir| dir.join(id).join("plugins"));
    }
    #[allow(unreachable_code)]
    None
}

/// 签出里的旁加载插件目录抄回插件目录。
pub fn restore_plugin_packs(root: &Path, dest: &Path) -> OmniResult<()> {
    let base = root.join(SPACE_DIR).join("plugins");
    if !base.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(&base).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let pack = entry.path().join("pack");
        if !pack.is_dir() {
            continue;
        }
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_safe_segment(&id) {
            continue;
        }
        let target = dest.join(&id);
        let mut found = Vec::new();
        walk_files(&pack, &mut found)?;
        for path in found {
            let Some(rel) = rel_slash(&pack, &path) else {
                continue;
            };
            if rel.split('/').any(|seg| !is_safe_segment(seg)) {
                continue;
            }
            let file = target.join(rel);
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent).map_err(map_io)?;
            }
            std::fs::copy(&path, &file).map_err(map_io)?;
        }
    }
    Ok(())
}

/// 旁加载插件目录进仓库。来自插件中心的安装包不抄。
pub fn stage_plugin_packs(dir: &Path, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let plugin_dir = entry.path();
        if !plugin_dir.is_dir() {
            continue;
        }
        let Some(id) = plugin_dir.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_safe_segment(id) {
            continue;
        }
        let manifest = plugin_dir.join("plugin.json");
        let Ok(raw) = std::fs::read(&manifest) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&raw) else {
            continue;
        };
        let source = value
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if !matches!(source.as_str(), "file" | "sideload" | "dev" | "local") {
            continue;
        }
        let mut found = Vec::new();
        walk_files(&plugin_dir, &mut found)?;
        for path in found {
            let Some(rel) = rel_slash(&plugin_dir, &path) else {
                continue;
            };
            if rel.split('/').any(|seg| !is_safe_segment(seg)) {
                continue;
            }
            let key = format!("plugins/{id}/pack/{rel}");
            if files.contains_key(&key) {
                continue;
            }
            let bytes = std::fs::read(&path).map_err(map_io)?;
            if bytes.len() > 32 * 1024 * 1024 {
                continue;
            }
            files.insert(key, bytes);
        }
    }
    Ok(())
}

fn is_safe_rel(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\\')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn insert_file(
    files: &mut BTreeMap<String, Vec<u8>>,
    path: String,
    bytes: Vec<u8>,
) -> OmniResult<()> {
    if !is_safe_rel(&path) {
        return Err(OmniError::invalid_input(format!("非法空间路径: {path}")));
    }
    if files.insert(path.clone(), bytes).is_some() {
        return Err(OmniError::new(
            ErrorCode::Internal,
            format!("空间文件路径重复: {path}"),
        ));
    }
    Ok(())
}

fn write_bytes(path: &Path, bytes: &[u8]) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(map_io)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(map_io)?;
    std::fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

fn rel_slash(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let mut parts = Vec::new();
    for component in rel.components() {
        match component {
            std::path::Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
            _ => return None,
        }
    }
    Some(parts.join("/"))
}

fn walk_files(dir: &Path, out: &mut Vec<PathBuf>) -> OmniResult<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(map_io)? {
        let entry = entry.map_err(map_io)?;
        let path = entry.path();
        if path.is_dir() {
            walk_files(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

/// 用给定文件重建 `space/` 与 `repo/`。相同内容得到相同块 id 和索引 id。
pub fn build_space_repo(
    root: &Path,
    files: &BTreeMap<String, Vec<u8>>,
) -> OmniResult<SpaceRepoReport> {
    let space = root.join(SPACE_DIR);
    std::fs::create_dir_all(&space).map_err(map_io)?;

    let mut listed = Vec::with_capacity(files.len());
    let mut chunk_ids = BTreeSet::new();
    for (path, bytes) in files {
        if !is_safe_rel(path) {
            return Err(OmniError::invalid_input(format!("非法空间路径: {path}")));
        }
        let parts = split_chunks(bytes);
        let chunks: Vec<String> = parts.iter().map(|(id, _)| id.clone()).collect();
        for (chunk, body) in &parts {
            if chunk_ids.insert(chunk.clone()) {
                let chunk = chunk.as_str();
                let body = body.as_slice();
                let object = root
                    .join(REPO_DIR)
                    .join("objects")
                    .join(&chunk[..2])
                    .join(chunk);
                if !object.exists() {
                    write_bytes(&object, body)?;
                }
            }
        }
        write_bytes(&space.join(path), bytes)?;
        listed.push(SpaceRepoFile {
            path: path.clone(),
            size: bytes.len() as u64,
            chunks,
        });
    }

    let mut existing = Vec::new();
    walk_files(&space, &mut existing)?;
    for path in existing {
        let Some(rel) = rel_slash(&space, &path) else {
            continue;
        };
        if !files.contains_key(&rel) {
            std::fs::remove_file(&path).map_err(map_io)?;
        }
    }

    let body = serde_json::to_vec(&listed)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    let index = SpaceRepoIndex {
        id: sha256_hex(&body),
        files: listed,
    };
    let index_bytes = json_bytes(&index)?;
    write_bytes(
        &root
            .join(REPO_DIR)
            .join("indexes")
            .join(format!("{}.json", index.id)),
        &index_bytes,
    )?;
    write_bytes(
        &root.join(REPO_DIR).join("refs").join("latest"),
        format!("{}\n", index.id).as_bytes(),
    )?;

    Ok(SpaceRepoReport {
        index_id: index.id,
        file_count: u32::try_from(files.len()).unwrap_or(u32::MAX),
        chunk_count: u32::try_from(chunk_ids.len()).unwrap_or(u32::MAX),
    })
}

pub fn read_latest_index(root: &Path) -> OmniResult<SpaceRepoIndex> {
    let latest =
        std::fs::read_to_string(root.join(REPO_DIR).join("refs").join("latest")).map_err(map_io)?;
    let id = latest.trim();
    if id.len() < 2 || !id.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(OmniError::new(
            ErrorCode::Storage,
            "refs/latest 不是索引 id",
        ));
    }
    let bytes = std::fs::read(
        root.join(REPO_DIR)
            .join("indexes")
            .join(format!("{id}.json")),
    )
    .map_err(map_io)?;
    serde_json::from_slice(&bytes)
        .map_err(|err| OmniError::new(ErrorCode::Storage, err.to_string()))
}

/// 把创建设备 id 写进会同步的 JSON。已有值不覆盖；旧 `origin:` 标签抄一次后去掉。
/// `known` 是上一份索引里的路径。不在里面的新文件，才用这台电脑的设备 id。
pub fn stamp_file_origins(
    files: &mut BTreeMap<String, Vec<u8>>,
    stored: &BTreeMap<String, String>,
    known: Option<&BTreeSet<String>>,
    device_id: &str,
) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for (path, bytes) in files.iter_mut() {
        let Ok(mut value) = serde_json::from_slice::<Value>(bytes) else {
            continue;
        };
        if !value.is_object() {
            continue;
        }
        let is_new = known.is_some_and(|set| !set.contains(path));
        let stored_origin = stored.get(path).map(String::as_str).unwrap_or("");
        let (changed, settled) = stamp_origin_value(&mut value, stored_origin, device_id, is_new);
        if let Some(origin) = settled {
            out.insert(path.clone(), origin);
        }
        if changed {
            if let Ok(next) = serde_json::to_vec(&value) {
                *bytes = next;
            }
        }
    }
    out
}

/// 从检出文件读出已经写上的创建设备 id。
pub fn capture_checkout_origins(root: &Path) -> OmniResult<BTreeMap<String, String>> {
    let dir = root.join(SPACE_DIR);
    if !dir.is_dir() {
        return Ok(BTreeMap::new());
    }
    let mut found = Vec::new();
    walk_files(&dir, &mut found)?;
    let mut out = BTreeMap::new();
    for path in found {
        let Some(rel) = rel_slash(&dir, &path) else {
            continue;
        };
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if let Some(origin) = read_settled_origin(&value) {
            if !origin.is_empty() {
                out.insert(rel, origin);
            }
        }
    }
    Ok(out)
}

fn stamp_origin_value(
    value: &mut Value,
    stored: &str,
    device_id: &str,
    is_new: bool,
) -> (bool, Option<String>) {
    let Some(obj) = origin_object(value) else {
        return (false, None);
    };
    let incoming = read_origin_field(obj);
    let tags = tag_strings(obj);
    let mut settled = crate::tag::settle_origin_device_id(stored, &incoming, &tags);
    if settled.is_empty() && is_new {
        let id = device_id.trim();
        if !id.is_empty() {
            settled = id.to_string();
        }
    }
    let had_tag = tags.iter().any(|tag| is_origin_tag(tag));
    let field_key = origin_field_key(obj);
    let current = obj
        .get(field_key)
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let changed = had_tag || (!settled.is_empty() && current != settled);
    if changed {
        if !settled.is_empty() {
            if let Some(map) = obj.as_object_mut() {
                map.insert(field_key.to_string(), Value::String(settled.clone()));
                let other = if field_key == "originDeviceId" {
                    "origin_device_id"
                } else {
                    "originDeviceId"
                };
                map.remove(other);
            }
        }
        if let Some(arr) = obj.get_mut("tags").and_then(|item| item.as_array_mut()) {
            arr.retain(|tag| tag.as_str().is_none_or(|text| !is_origin_tag(text)));
        }
    }
    if settled.is_empty() {
        (changed, None)
    } else {
        (changed, Some(settled))
    }
}

fn origin_object(value: &mut Value) -> Option<&mut Value> {
    if value
        .get("entry")
        .and_then(|item| item.as_object())
        .is_some()
    {
        return value.get_mut("entry");
    }
    if value
        .get("workflow")
        .and_then(|item| item.as_object())
        .is_some()
        && value.get("steps").is_some()
    {
        return value.get_mut("workflow");
    }
    if value
        .get("list")
        .and_then(|item| item.as_object())
        .is_some()
        && value.get("tasks").is_some()
    {
        return value.get_mut("list");
    }
    if value.is_object() {
        return Some(value);
    }
    None
}

fn read_settled_origin(value: &Value) -> Option<String> {
    let obj = if value
        .get("entry")
        .and_then(|item| item.as_object())
        .is_some()
    {
        value.get("entry")?
    } else if value
        .get("workflow")
        .and_then(|item| item.as_object())
        .is_some()
        && value.get("steps").is_some()
    {
        value.get("workflow")?
    } else if value
        .get("list")
        .and_then(|item| item.as_object())
        .is_some()
        && value.get("tasks").is_some()
    {
        value.get("list")?
    } else {
        value
    };
    let origin = read_origin_field(obj);
    if origin.is_empty() {
        None
    } else {
        Some(origin)
    }
}

fn read_origin_field(obj: &Value) -> String {
    for key in ["originDeviceId", "origin_device_id"] {
        if let Some(text) = obj.get(key).and_then(|item| item.as_str()) {
            let text = text.trim();
            if !text.is_empty() {
                return text.to_string();
            }
        }
    }
    String::new()
}

fn origin_field_key(obj: &Value) -> &'static str {
    if obj.get("db_type").is_some() || obj.get("origin_device_id").is_some() {
        "origin_device_id"
    } else {
        "originDeviceId"
    }
}

fn tag_strings(obj: &Value) -> Vec<String> {
    obj.get("tags")
        .and_then(|item| item.as_array())
        .map(|tags| {
            tags.iter()
                .filter_map(|tag| tag.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn is_origin_tag(text: &str) -> bool {
    let text = text.trim();
    text.get(..7)
        .is_some_and(|head| head.eq_ignore_ascii_case("origin:"))
}

impl Storage {
    /// 从当前库收集会进仓库的固定记录。不含保险库明文、运行记录和本机绝对路径。
    pub fn collect_space_files(&self) -> OmniResult<BTreeMap<String, Vec<u8>>> {
        let mut files = BTreeMap::new();
        self.collect_connections(&mut files)?;
        self.collect_ssh_keys(&mut files)?;
        self.collect_knowledge(&mut files)?;
        self.collect_http(&mut files)?;
        self.collect_workflows(&mut files)?;
        self.collect_todos(&mut files)?;
        self.collect_accounts(&mut files)?;
        self.collect_skills(&mut files)?;
        self.collect_plugins(&mut files)?;
        Ok(files)
    }

    pub fn rebuild_space_repo(&self, root: &Path) -> OmniResult<SpaceRepoReport> {
        self.rebuild_space_repo_with(root, &BTreeMap::new())
    }

    /// 在库记录之外附加布局文件（侧栏、面板、工作区）。同路径以附加内容为准。
    pub fn rebuild_space_repo_with(
        &self,
        root: &Path,
        extra: &BTreeMap<String, Vec<u8>>,
    ) -> OmniResult<SpaceRepoReport> {
        self.rebuild_space_repo_for(root, extra, "")
    }

    /// 同 [`Self::rebuild_space_repo_with`]。`device_id` 只写给上一份索引里没有的新文件。
    pub fn rebuild_space_repo_for(
        &self,
        root: &Path,
        extra: &BTreeMap<String, Vec<u8>>,
        device_id: &str,
    ) -> OmniResult<SpaceRepoReport> {
        let mut files = self.collect_space_files()?;
        keep_uncollected(root, &mut files, extra)?;
        collect_knowledge_assets(root, &mut files)?;
        for (path, bytes) in extra {
            files.insert(path.clone(), bytes.clone());
        }
        #[cfg(not(test))]
        attach_known_vault_files(&mut files);
        let previous = self.local_space_id()?.unwrap_or_default();
        let adopted = space_id_in(&files).unwrap_or_else(|| previous.clone());
        if !adopted.is_empty() && adopted != previous {
            self.adopt_local_space_id(&adopted)?;
        }
        if !adopted.is_empty() {
            stamp_space_ids(&mut files, &adopted, &previous);
            let meta = serde_json::json!({ "id": adopted });
            files.insert("meta.json".into(), json_bytes(&meta)?);
        }
        let skip = self.local_only_paths()?;
        files.retain(|path, _| !skip.contains(path));
        let stored = self.resource_origins()?;
        let known = read_latest_index(root).ok().map(|index| {
            index
                .files
                .into_iter()
                .map(|file| file.path)
                .collect::<BTreeSet<_>>()
        });
        let settled = stamp_file_origins(&mut files, &stored, known.as_ref(), device_id);
        self.save_resource_origins(&settled)?;
        self.write_local_only_file(root)?;
        build_space_repo(root, &files)
    }

    fn collect_connections(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for conn in self.list_connections()? {
            insert_file(
                files,
                record_file("connections", &conn.id)?,
                json_bytes(&conn)?,
            )?;
        }
        Ok(())
    }

    fn collect_ssh_keys(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for key in self.list_ssh_keys()? {
            insert_file(files, record_file("sshkeys", &key.id)?, json_bytes(&key)?)?;
        }
        Ok(())
    }

    fn collect_knowledge(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for entry in self.list_knowledge(None, None)? {
            let revisions = self.list_knowledge_revisions(&entry.id)?;
            let doc = KnowledgeCheckout {
                entry: &entry,
                revisions: &revisions,
            };
            insert_file(
                files,
                record_file("knowledge", &entry.id)?,
                json_bytes(&doc)?,
            )?;
        }
        Ok(())
    }

    fn collect_http(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for req in self.http_list_requests(None)? {
            insert_file(
                files,
                record_file("http/requests", &req.id)?,
                json_bytes(&req)?,
            )?;
        }
        for col in self.http_list_collections()? {
            insert_file(
                files,
                record_file("http/collections", &col.id)?,
                json_bytes(&col)?,
            )?;
        }
        for env in self.http_list_environments()? {
            insert_file(
                files,
                record_file("http/environments", &env.id)?,
                json_bytes(&env)?,
            )?;
        }
        Ok(())
    }

    fn collect_workflows(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for workflow in self.workflow_list()? {
            let detail = self.workflow_get(&workflow.id)?;
            insert_file(
                files,
                record_file("workflows", &workflow.id)?,
                json_bytes(&detail)?,
            )?;
        }
        Ok(())
    }

    fn collect_todos(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for list in self.list_todo_lists()? {
            let tasks = self.list_todo_tasks(&TodoTaskQuery {
                view: "list".into(),
                list_id: Some(list.id.clone()),
                include_completed: true,
                today: None,
            })?;
            let owned = tasks
                .iter()
                .map(|task| {
                    let steps = self.list_todo_steps(&task.id)?;
                    Ok((task, steps))
                })
                .collect::<OmniResult<Vec<_>>>()?;
            let checkouts: Vec<TodoTaskCheckout<'_>> = owned
                .iter()
                .map(|(task, steps)| TodoTaskCheckout { task, steps })
                .collect();
            let doc = TodoListCheckout {
                list: &list,
                tasks: &checkouts,
            };
            insert_file(files, record_file("todos", &list.id)?, json_bytes(&doc)?)?;
        }
        Ok(())
    }

    fn collect_accounts(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for account in self.list_third_party_accounts()? {
            insert_file(
                files,
                record_file("accounts", &account.id)?,
                json_bytes(&account)?,
            )?;
        }
        Ok(())
    }

    fn collect_skills(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        for skill in self.list_skills_db()? {
            let body = crate::skill::skill_file_path(&skill.id)
                .ok()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .unwrap_or_default();
            let doc = serde_json::json!({
                "id": skill.id,
                "name": skill.name,
                "description": skill.description,
                "enabled": skill.enabled,
                "version": skill.version,
                "parentVersionId": skill.parent_version_id,
                "shareable": skill.shareable,
                "body": body,
            });
            insert_file(files, record_file("skills", &skill.id)?, json_bytes(&doc)?)?;
        }
        Ok(())
    }

    fn collect_plugins(&self, files: &mut BTreeMap<String, Vec<u8>>) -> OmniResult<()> {
        let mut plugins: BTreeMap<String, PluginCheckout> = BTreeMap::new();
        for (id, enabled) in self.plugin_enabled_list()? {
            plugins.insert(
                id.clone(),
                PluginCheckout {
                    id,
                    enabled: Some(enabled),
                    state: None,
                },
            );
        }
        let mut stmt = self
            .conn()
            .prepare("SELECT plugin_id, payload FROM plugin_state ORDER BY plugin_id")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(map_sqlite)?;
        for row in rows {
            let (id, payload) = row.map_err(map_sqlite)?;
            let state =
                Some(serde_json::from_str::<Value>(&payload).unwrap_or(Value::String(payload)));
            if let Some(item) = plugins.get_mut(&id) {
                item.state = state;
            } else {
                plugins.insert(
                    id.clone(),
                    PluginCheckout {
                        id,
                        enabled: None,
                        state,
                    },
                );
            }
        }
        drop(stmt);
        for (id, doc) in plugins {
            insert_file(files, record_file("plugins", &id)?, json_bytes(&doc)?)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{Connection, ConnectionKind};

    fn sample_conn(id: &str, name: &str) -> Connection {
        Connection {
            id: id.into(),
            kind: ConnectionKind::Ssh,
            name: name.into(),
            group: "default".into(),
            env_tag: "dev".into(),
            tags: vec![],
            config: "{}".into(),
            credential_ref: None,
            created_at: 1,
            updated_at: 1,
            origin_device_id: String::new(),
        }
    }

    #[test]
    fn same_bytes_share_one_chunk_and_keep_index_id() {
        let dir = tempfile::tempdir().unwrap();
        let mut files = BTreeMap::new();
        files.insert("connections/a.json".into(), b"{}".to_vec());
        files.insert("connections/b.json".into(), b"{}".to_vec());
        let first = build_space_repo(dir.path(), &files).unwrap();
        assert_eq!(first.file_count, 2);
        assert_eq!(first.chunk_count, 1);
        let again = build_space_repo(dir.path(), &files).unwrap();
        assert_eq!(again.index_id, first.index_id);
        let index = read_latest_index(dir.path()).unwrap();
        assert_eq!(index.files[0].chunks, index.files[1].chunks);
    }

    #[test]
    fn large_file_splits_and_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let bytes = vec![7u8; CHUNK_SIZE + 10];
        let mut files = BTreeMap::new();
        files.insert("connections/big.json".into(), bytes.clone());
        let report = build_space_repo(dir.path(), &files).unwrap();
        assert_eq!(report.chunk_count, 2);
        let index = read_latest_index(dir.path()).unwrap();
        let mut joined = Vec::new();
        for id in &index.files[0].chunks {
            let object = dir
                .path()
                .join(REPO_DIR)
                .join("objects")
                .join(&id[..2])
                .join(id);
            joined.extend(std::fs::read(object).unwrap());
        }
        assert_eq!(joined, bytes);
    }

    #[test]
    fn changing_one_connection_keeps_the_other_chunk() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_connection(&sample_conn("a", "alpha")).unwrap();
        storage.save_connection(&sample_conn("b", "beta")).unwrap();
        let dir = tempfile::tempdir().unwrap();
        storage.rebuild_space_repo(dir.path()).unwrap();
        let before = read_latest_index(dir.path()).unwrap();
        let b_chunk = before
            .files
            .iter()
            .find(|file| file.path == "connections/b.json")
            .unwrap()
            .chunks
            .clone();
        let todo_chunk = before
            .files
            .iter()
            .find(|file| file.path == "todos/todo-default.json")
            .unwrap()
            .chunks
            .clone();

        storage
            .save_connection(&sample_conn("a", "alpha-2"))
            .unwrap();
        storage.rebuild_space_repo(dir.path()).unwrap();
        let after = read_latest_index(dir.path()).unwrap();
        let b_after = after
            .files
            .iter()
            .find(|file| file.path == "connections/b.json")
            .unwrap();
        assert_eq!(b_after.chunks, b_chunk);
        let todo_after = after
            .files
            .iter()
            .find(|file| file.path == "todos/todo-default.json")
            .unwrap();
        assert_eq!(todo_after.chunks, todo_chunk);
        assert_ne!(after.id, before.id);

        storage.delete_connection("a").unwrap();
        storage.rebuild_space_repo(dir.path()).unwrap();
        let left = read_latest_index(dir.path()).unwrap();
        let paths: Vec<_> = left
            .files
            .iter()
            .map(|file| file.path.clone())
            .collect::<Vec<_>>();
        assert_eq!(
            paths,
            vec![
                "connections/b.json".to_string(),
                "todos/todo-default.json".to_string(),
            ]
        );
        assert!(
            !dir.path()
                .join(SPACE_DIR)
                .join("connections/a.json")
                .exists()
        );
    }

    #[test]
    fn unsafe_record_id_is_rejected() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_connection(&sample_conn("../outside", "nope"))
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        assert!(storage.rebuild_space_repo(dir.path()).is_err());
        assert!(!dir.path().join("outside.json").exists());
    }

    #[test]
    fn rebuild_keeps_files_the_database_does_not_own() {
        let storage = Storage::open_in_memory().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let databases = dir.path().join(SPACE_DIR).join("databases");
        let vault = dir.path().join(SPACE_DIR).join("vault");
        std::fs::create_dir_all(&databases).unwrap();
        std::fs::create_dir_all(&vault).unwrap();
        std::fs::write(databases.join("kept.json"), b"{\"id\":\"kept\"}").unwrap();
        std::fs::write(vault.join("secret.json"), b"secret").unwrap();

        storage.rebuild_space_repo(dir.path()).unwrap();

        assert_eq!(
            std::fs::read(dir.path().join(SPACE_DIR).join("databases/kept.json")).unwrap(),
            b"{\"id\":\"kept\"}"
        );
        assert_eq!(
            std::fs::read(dir.path().join(SPACE_DIR).join("vault/secret.json")).unwrap(),
            b"secret"
        );
        let index = read_latest_index(dir.path()).unwrap();
        let paths: Vec<_> = index.files.iter().map(|file| file.path.as_str()).collect();
        assert!(paths.contains(&"databases/kept.json"));
        assert!(paths.contains(&"vault/secret.json"));
    }

    #[test]
    fn stamp_keeps_an_existing_origin_and_strips_the_tag() {
        let mut files = BTreeMap::new();
        files.insert(
            "knowledge/a.json".into(),
            br#"{"entry":{"id":"a","tags":["origin:dev-a","topic:x"]},"revisions":[]}"#.to_vec(),
        );
        let settled = stamp_file_origins(&mut files, &BTreeMap::new(), None, "dev-now");
        assert_eq!(
            settled.get("knowledge/a.json").map(String::as_str),
            Some("dev-a")
        );
        let value: Value = serde_json::from_slice(&files["knowledge/a.json"]).unwrap();
        assert_eq!(value["entry"]["originDeviceId"], "dev-a");
        let tags = value["entry"]["tags"].as_array().unwrap();
        assert!(tags.iter().any(|tag| tag == "topic:x"));
        assert!(tags.iter().all(|tag| tag != "origin:dev-a"));
    }

    #[test]
    fn stamp_new_file_uses_this_device_only_when_an_index_exists() {
        let mut files = BTreeMap::new();
        files.insert(
            "http/requests/n.json".into(),
            br#"{"id":"n","name":"ping"}"#.to_vec(),
        );
        let untouched = stamp_file_origins(&mut files, &BTreeMap::new(), None, "dev-now");
        assert!(untouched.is_empty());
        let mut known = BTreeSet::new();
        known.insert("http/requests/old.json".to_string());
        let settled = stamp_file_origins(&mut files, &BTreeMap::new(), Some(&known), "dev-now");
        assert_eq!(settled["http/requests/n.json"], "dev-now");
    }
}
