//! 空间仓库同步：按路径合并、加密块、锁和冲突历史。
//! 远端只收缺的块；`refs/latest` 在块都写完之后才改。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::space_repo::{
    REPO_DIR, SPACE_DIR, SpaceRepoIndex, build_space_repo, read_latest_index, sha256_hex,
};
use crate::storage::Storage;
use crate::vault::Vault;

const LOCK_TTL_MS: i64 = 65_000;

const FIXED_PREFIXES: &[&str] = &[
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

#[async_trait]
pub trait SpaceRepoRemote: Send {
    async fn get(&mut self, key: &str) -> OmniResult<Option<Vec<u8>>>;
    async fn put(&mut self, key: &str, bytes: &[u8]) -> OmniResult<()>;
    async fn delete(&mut self, key: &str) -> OmniResult<()>;
    async fn list(&mut self, prefix: &str) -> OmniResult<Vec<String>>;

    /// 对象在不在。默认会把整段下下来，远端实现应改成 HEAD。
    async fn exists(&mut self, key: &str) -> OmniResult<bool> {
        Ok(self.get(key).await?.is_some())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSyncReport {
    pub skipped: bool,
    pub index_id: String,
    pub uploaded_chunks: u32,
    pub conflicts: u32,
    pub applied_connections: u32,
    pub file_count: u32,
    pub ssh_sidebar_tree_json: Option<String>,
    pub folder_trees_json: Option<String>,
    pub custom_panels_json: Option<String>,
    pub workspaces_json: Option<String>,
    pub conversations_json: Option<String>,
    pub settings_json: Option<String>,
}

impl SpaceSyncReport {
    pub fn local_only(index_id: impl Into<String>) -> Self {
        Self {
            skipped: true,
            index_id: index_id.into(),
            uploaded_chunks: 0,
            conflicts: 0,
            applied_connections: 0,
            file_count: 0,
            ssh_sidebar_tree_json: None,
            folder_trees_json: None,
            custom_panels_json: None,
            workspaces_json: None,
            conversations_json: None,
            settings_json: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceSyncRequest {
    #[serde(default)]
    pub token: String,
    #[serde(default)]
    pub team_id: Option<i64>,
    #[serde(default)]
    pub ssh_sidebar_tree_json: Option<String>,
    #[serde(default)]
    pub folder_trees_json: Option<String>,
    #[serde(default)]
    pub custom_panels_json: Option<String>,
    #[serde(default)]
    pub workspaces_json: Option<String>,
    #[serde(default)]
    pub conversations_json: Option<String>,
    #[serde(default)]
    pub settings_json: Option<String>,
}

#[derive(Clone, Copy)]
pub struct LayoutInput<'a> {
    pub ssh_sidebar_tree_json: Option<&'a str>,
    pub folder_trees_json: Option<&'a str>,
    pub custom_panels_json: Option<&'a str>,
    pub workspaces_json: Option<&'a str>,
    pub conversations_json: Option<&'a str>,
    pub settings_json: Option<&'a str>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepoLock {
    device_id: String,
    expires_at_ms: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictRecord {
    path: String,
    recorded_at: i64,
    body_b64: String,
}

struct MergePick {
    path: String,
    /// None 表示这个路径从检出里删除。
    chunks: Option<Vec<String>>,
    conflict: bool,
}

pub fn layout_files(
    input: LayoutInput<'_>,
) -> OmniResult<(BTreeMap<String, Vec<u8>>, BTreeSet<String>)> {
    let mut files = BTreeMap::new();
    let mut managed = FIXED_PREFIXES
        .iter()
        .map(|prefix| (*prefix).to_string())
        .collect::<BTreeSet<_>>();
    if let Some(raw) = input.ssh_sidebar_tree_json {
        managed.insert("tree".into());
        if !raw.trim().is_empty() {
            files.insert("tree/ssh.json".into(), raw.as_bytes().to_vec());
        }
    }
    if let Some(raw) = input.folder_trees_json {
        managed.insert("tree".into());
        if !raw.trim().is_empty() {
            files.insert("tree/folders.json".into(), raw.as_bytes().to_vec());
        }
    }
    if let Some(raw) = input.custom_panels_json {
        managed.insert("panels".into());
        if !raw.trim().is_empty() {
            files.insert("panels/custom.json".into(), raw.as_bytes().to_vec());
        }
    }
    if let Some(raw) = input.workspaces_json {
        managed.insert("workspaces".into());
        if !raw.trim().is_empty() {
            let list: Vec<Value> = serde_json::from_str(raw).map_err(|err| {
                OmniError::new(ErrorCode::InvalidInput, "工作区 JSON 无法解析")
                    .with_cause(err.to_string())
            })?;
            for item in list {
                let Some(id) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if id.is_empty() || id.contains('/') || id.contains('\\') || id.contains("..") {
                    continue;
                }
                let mut bytes = serde_json::to_vec(&item)
                    .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
                bytes.push(b'\n');
                files.insert(format!("workspaces/{id}.json"), bytes);
            }
        }
    }
    if let Some(raw) = input.conversations_json {
        managed.insert("conversations".into());
        if !raw.trim().is_empty() {
            let list: Vec<Value> = serde_json::from_str(raw).map_err(|err| {
                OmniError::new(ErrorCode::InvalidInput, "会话 JSON 无法解析")
                    .with_cause(err.to_string())
            })?;
            for item in list {
                let Some(id) = item.get("id").and_then(Value::as_str) else {
                    continue;
                };
                if !safe_key(&format!("conversations/{id}.json")) {
                    continue;
                }
                let mut bytes = serde_json::to_vec(&item)
                    .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
                bytes.push(b'\n');
                files.insert(format!("conversations/{id}.json"), bytes);
            }
        }
    }
    if let Some(raw) = input.settings_json {
        managed.insert("settings".into());
        if !raw.trim().is_empty() {
            files.insert("settings/app.json".into(), stage_settings(raw)?);
        }
    }
    Ok((files, managed))
}

const SPACE_GATEWAY_KEY_REF: &str = "space-gateway-key";

fn stage_settings(raw: &str) -> OmniResult<Vec<u8>> {
    let mut value: Value = serde_json::from_str(raw).map_err(|err| {
        OmniError::new(ErrorCode::InvalidInput, "应用设置 JSON 无法解析")
            .with_cause(err.to_string())
    })?;
    if let Some(obj) = value.as_object_mut() {
        obj.remove("fileIndexStorageDir");
        obj.remove("closeBehavior");
        obj.remove("aiDockWidth");
        if let Some(proxy) = obj.get_mut("proxy").and_then(Value::as_object_mut) {
            proxy.remove("password");
        }
        if let Some(key) = obj
            .remove("aiGatewayApiKey")
            .and_then(|item| item.as_str().map(str::to_string))
        {
            if !key.trim().is_empty() {
                Vault::store(SPACE_GATEWAY_KEY_REF, key.trim())?;
            }
        }
    }
    let mut bytes = serde_json::to_vec(&value)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn attach_layouts(root: &Path, report: &mut SpaceSyncReport) {
    report.ssh_sidebar_tree_json = read_text(root, "tree/ssh.json");
    report.folder_trees_json = read_text(root, "tree/folders.json");
    report.custom_panels_json = read_text(root, "panels/custom.json");
    report.workspaces_json = read_workspaces(root);
    report.conversations_json = read_conversations(root);
    report.settings_json =
        read_text(root, "settings/app.json").map(|text| inject_gateway_key(&text));
}

fn inject_gateway_key(raw: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<Value>(raw) else {
        return raw.to_string();
    };
    let Some(obj) = value.as_object_mut() else {
        return raw.to_string();
    };
    if let Ok(key) = Vault::get(SPACE_GATEWAY_KEY_REF) {
        if !key.trim().is_empty() {
            obj.insert("aiGatewayApiKey".into(), Value::String(key));
        }
    }
    serde_json::to_string(&value).unwrap_or_else(|_| raw.to_string())
}

fn read_text(root: &Path, rel: &str) -> Option<String> {
    std::fs::read_to_string(root.join(SPACE_DIR).join(rel))
        .ok()
        .filter(|text| !text.trim().is_empty())
}

fn read_workspaces(root: &Path) -> Option<String> {
    let dir = root.join(SPACE_DIR).join("workspaces");
    if !dir.is_dir() {
        return None;
    }
    let mut items = Vec::new();
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .collect();
    paths.sort();
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            items.push(value);
        }
    }
    if items.is_empty() {
        None
    } else {
        serde_json::to_string(&items).ok()
    }
}

fn read_conversations(root: &Path) -> Option<String> {
    let dir = root.join(SPACE_DIR).join("conversations");
    if !dir.is_dir() {
        return None;
    }
    let mut items = Vec::new();
    let entries = std::fs::read_dir(&dir).ok()?;
    let mut paths: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("json"))
        .collect();
    paths.sort();
    for path in paths {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            items.push(value);
        }
    }
    serde_json::to_string(&items).ok()
}

/// 把旧的 `modules/latest.json` 明文拆成文件。已有本地文件的路径不在这里决定胜负。
pub fn legacy_module_files(bundle: &Value) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    if let Some(list) = bundle.get("connections").and_then(Value::as_array) {
        for item in list {
            let record = item.get("connection").unwrap_or(item);
            push_record(&mut files, "connections", record);
        }
    }
    if let Some(list) = bundle.get("databaseConnections").and_then(Value::as_array) {
        for item in list {
            let record = item.get("connection").unwrap_or(item);
            push_record(&mut files, "databases", record);
        }
    }
    if let Some(list) = bundle.get("knowledge").and_then(Value::as_array) {
        for item in list {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            let wrapped = serde_json::json!({ "entry": item, "revisions": [] });
            push_named(&mut files, &format!("knowledge/{id}.json"), &wrapped);
        }
    }
    push_list(&mut files, bundle, "httpRequests", "http/requests");
    push_list(&mut files, bundle, "httpCollections", "http/collections");
    push_list(&mut files, bundle, "httpEnvironments", "http/environments");
    push_list(&mut files, bundle, "sshKeys", "sshkeys");
    push_list(&mut files, bundle, "workspaces", "workspaces");
    if let Some(raw) = bundle.get("sshSidebarTreeJson").and_then(Value::as_str) {
        if !raw.trim().is_empty() {
            files.insert("tree/ssh.json".into(), raw.as_bytes().to_vec());
        }
    }
    if let Some(raw) = bundle.get("folderTreesJson").and_then(Value::as_str) {
        if !raw.trim().is_empty() {
            files.insert("tree/folders.json".into(), raw.as_bytes().to_vec());
        }
    }
    if let Some(raw) = bundle.get("customPanelsJson").and_then(Value::as_str) {
        if !raw.trim().is_empty() {
            files.insert("panels/custom.json".into(), raw.as_bytes().to_vec());
        }
    }
    if let Some(list) = bundle.get("vaultSecrets").and_then(Value::as_array) {
        for item in list {
            let Some(reference) = item.get("reference").and_then(Value::as_str) else {
                continue;
            };
            push_named(&mut files, &format!("vault/{reference}.json"), item);
        }
    }
    files
}

/// 把旧的会话整包拆成一条一个文件。已经删掉的 id 不写回来。
pub fn legacy_conversation_files(bundle: &Value) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut deleted = BTreeSet::new();
    if let Some(list) = bundle.get("deleted").and_then(Value::as_array) {
        for item in list {
            if let Some(id) = item.get("id").and_then(Value::as_str) {
                deleted.insert(id.to_string());
            }
        }
    }
    let Some(list) = bundle.get("conversations").and_then(Value::as_array) else {
        return files;
    };
    for item in list {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            continue;
        };
        if deleted.contains(id) {
            continue;
        }
        push_named(&mut files, &format!("conversations/{id}.json"), item);
    }
    files
}

fn push_list(files: &mut BTreeMap<String, Vec<u8>>, bundle: &Value, field: &str, dir: &str) {
    let Some(list) = bundle.get(field).and_then(Value::as_array) else {
        return;
    };
    for item in list {
        push_record(files, dir, item);
    }
}

fn push_record(files: &mut BTreeMap<String, Vec<u8>>, dir: &str, record: &Value) {
    let Some(id) = record.get("id").and_then(Value::as_str) else {
        return;
    };
    push_named(files, &format!("{dir}/{id}.json"), record);
}

fn push_named(files: &mut BTreeMap<String, Vec<u8>>, path: &str, record: &Value) {
    if !safe_key(path) {
        return;
    }
    let Ok(mut bytes) = serde_json::to_vec(record) else {
        return;
    };
    bytes.push(b'\n');
    files.insert(path.to_string(), bytes);
}

fn safe_key(path: &str) -> bool {
    !path.is_empty()
        && !path.starts_with('/')
        && !path.contains('\\')
        && !path.contains('\0')
        && path
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
}

fn prefix_of(path: &str) -> &str {
    path.split('/').next().unwrap_or(path)
}

fn read_local_only_file(root: &Path) -> BTreeSet<String> {
    let Ok(text) = std::fs::read_to_string(root.join(REPO_DIR).join("local-only.txt")) else {
        return BTreeSet::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|path| !path.is_empty() && safe_key(path))
        .map(str::to_string)
        .collect()
}

/// 云端索引还没有的目录，用旧快照补缺。已有的目录不再回灌，避免把删掉的记录救回来。
fn supplement_missing_prefixes(
    files: &mut BTreeMap<String, Vec<u8>>,
    legacy: &BTreeMap<String, Vec<u8>>,
    remote: &SpaceRepoIndex,
) {
    let prefixes = remote
        .files
        .iter()
        .map(|file| prefix_of(&file.path).to_string())
        .collect::<BTreeSet<_>>();
    for (path, bytes) in legacy {
        if prefixes.contains(prefix_of(path)) {
            continue;
        }
        files.entry(path.clone()).or_insert_with(|| bytes.clone());
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub fn seal_bytes(key: &[u8; 32], plain: &[u8]) -> OmniResult<Vec<u8>> {
    let mut nonce = [0u8; 12];
    getrandom::getrandom(&mut nonce)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    let encrypted = cipher
        .encrypt(Nonce::from_slice(&nonce), plain)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    let mut out = nonce.to_vec();
    out.extend(encrypted);
    Ok(out)
}

pub fn open_bytes(key: &[u8; 32], blob: &[u8]) -> OmniResult<Vec<u8>> {
    if blob.len() < 12 {
        return Err(OmniError::new(ErrorCode::Storage, "空间密文过短"));
    }
    let (nonce, ciphertext) = blob.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| OmniError::new(ErrorCode::Auth, "解开空间块失败，本机密钥和云端数据对不上"))
}

fn chunks_of(index: Option<&SpaceRepoIndex>, path: &str) -> Option<Vec<String>> {
    index.and_then(|index| {
        index
            .files
            .iter()
            .find(|file| file.path == path)
            .map(|file| file.chunks.clone())
    })
}

fn is_layout_path(path: &str) -> bool {
    path == "tree/ssh.json" || path == "tree/folders.json"
}

fn merge_paths(
    base: Option<&SpaceRepoIndex>,
    local: &SpaceRepoIndex,
    remote: &SpaceRepoIndex,
    managed: &BTreeSet<String>,
    root: &Path,
) -> Vec<MergePick> {
    let mut paths = BTreeSet::new();
    for index in [base, Some(local), Some(remote)].into_iter().flatten() {
        for file in &index.files {
            paths.insert(file.path.clone());
        }
    }
    let local_only = read_local_only_file(root);
    let mut picks = Vec::new();
    for path in paths {
        let owned = managed.contains(prefix_of(&path));
        let base_chunks = chunks_of(base, &path);
        let local_chunks = chunks_of(Some(local), &path);
        let remote_chunks = chunks_of(Some(remote), &path);
        if local_only.contains(&path) {
            picks.push(MergePick {
                path,
                chunks: remote_chunks,
                conflict: false,
            });
            continue;
        }
        if !owned && local_chunks.is_none() && remote_chunks.is_some() {
            picks.push(MergePick {
                path,
                chunks: remote_chunks,
                conflict: false,
            });
            continue;
        }
        if !owned && remote_chunks.is_none() && local_chunks.is_some() {
            picks.push(MergePick {
                path,
                chunks: local_chunks,
                conflict: false,
            });
            continue;
        }
        let pick = match (base_chunks, local_chunks, remote_chunks) {
            (_, Some(local_chunks), Some(remote_chunks)) if local_chunks == remote_chunks => {
                MergePick {
                    path,
                    chunks: Some(local_chunks),
                    conflict: false,
                }
            }
            (Some(base_chunks), Some(local_chunks), Some(remote_chunks))
                if local_chunks == base_chunks && remote_chunks != base_chunks =>
            {
                MergePick {
                    path,
                    chunks: Some(remote_chunks),
                    conflict: false,
                }
            }
            (Some(base_chunks), Some(local_chunks), Some(remote_chunks))
                if remote_chunks == base_chunks && local_chunks != base_chunks =>
            {
                MergePick {
                    path,
                    chunks: Some(local_chunks),
                    conflict: false,
                }
            }
            (_, Some(_), Some(remote_chunks)) => MergePick {
                path,
                chunks: Some(remote_chunks),
                conflict: true,
            },
            (Some(base_chunks), None, Some(remote_chunks)) if remote_chunks == base_chunks => {
                MergePick {
                    path,
                    chunks: None,
                    conflict: false,
                }
            }
            (_, None, Some(remote_chunks)) => MergePick {
                path,
                chunks: Some(remote_chunks),
                conflict: true,
            },
            (Some(base_chunks), Some(local_chunks), None) if local_chunks == base_chunks => {
                MergePick {
                    path,
                    chunks: None,
                    conflict: false,
                }
            }
            (_, Some(local_chunks), None) => MergePick {
                path,
                chunks: Some(local_chunks),
                conflict: true,
            },
            _ => MergePick {
                path,
                chunks: None,
                conflict: false,
            },
        };
        picks.push(pick);
    }
    picks
}

fn read_local_object(root: &Path, id: &str) -> Option<Vec<u8>> {
    if id.len() < 2 {
        return None;
    }
    std::fs::read(root.join(REPO_DIR).join("objects").join(&id[..2]).join(id)).ok()
}

fn read_base(root: &Path) -> Option<SpaceRepoIndex> {
    let id = std::fs::read_to_string(root.join(REPO_DIR).join("refs").join("base")).ok()?;
    let id = id.trim();
    if id.len() < 2 {
        return None;
    }
    let bytes = std::fs::read(
        root.join(REPO_DIR)
            .join("indexes")
            .join(format!("{id}.json")),
    )
    .ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_base(root: &Path, id: &str) -> OmniResult<()> {
    let path = root.join(REPO_DIR).join("refs").join("base");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    }
    std::fs::write(path, format!("{id}\n"))
        .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))
}

fn write_conflict(root: &Path, path: &str, body: &[u8], now: i64) -> OmniResult<()> {
    let record = ConflictRecord {
        path: path.to_string(),
        recorded_at: now,
        body_b64: B64.encode(body),
    };
    let name = format!("{now}-{}", sha256_hex(path.as_bytes()));
    let file = root
        .join(REPO_DIR)
        .join("conflicts")
        .join(format!("{name}.json"));
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    }
    let bytes = serde_json::to_vec(&record)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    std::fs::write(file, bytes).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceConflict {
    pub id: String,
    pub path: String,
    #[specta(type = f64)]
    pub recorded_at: i64,
}

pub fn list_space_conflicts(root: &Path) -> OmniResult<Vec<SpaceConflict>> {
    let dir = root.join(REPO_DIR).join("conflicts");
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in
        std::fs::read_dir(&dir).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?
    {
        let entry = entry.map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if !safe_conflict_id(id) {
            continue;
        }
        let Ok(bytes) = std::fs::read(entry.path()) else {
            continue;
        };
        let Ok(record) = serde_json::from_slice::<ConflictRecord>(&bytes) else {
            continue;
        };
        out.push(SpaceConflict {
            id: id.to_string(),
            path: record.path,
            recorded_at: record.recorded_at,
        });
    }
    out.sort_by(|a, b| b.recorded_at.cmp(&a.recorded_at).then(a.path.cmp(&b.path)));
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceConflictView {
    pub id: String,
    pub path: String,
    #[specta(type = f64)]
    pub recorded_at: i64,
    /// 本机没被采用的正文。
    pub saved: String,
    /// 当前检出里的正文。没有文件时为空。
    pub current: String,
}

fn read_conflict_record(root: &Path, id: &str) -> OmniResult<(String, ConflictRecord)> {
    if !safe_conflict_id(id) {
        return Err(OmniError::invalid_input("冲突记录 id 无效"));
    }
    let path = root
        .join(REPO_DIR)
        .join("conflicts")
        .join(format!("{id}.json"));
    let bytes =
        std::fs::read(&path).map_err(|_| OmniError::new(ErrorCode::NotFound, "冲突记录不存在"))?;
    let record = serde_json::from_slice::<ConflictRecord>(&bytes)
        .map_err(|err| OmniError::new(ErrorCode::Storage, err.to_string()))?;
    Ok((id.to_string(), record))
}

fn decode_conflict_body(record: &ConflictRecord) -> OmniResult<Vec<u8>> {
    B64.decode(record.body_b64.trim()).map_err(|err| {
        OmniError::new(ErrorCode::Storage, "冲突正文无法解码").with_cause(err.to_string())
    })
}

pub fn read_space_conflict(root: &Path, id: &str) -> OmniResult<SpaceConflictView> {
    let (id, record) = read_conflict_record(root, id)?;
    let saved = String::from_utf8_lossy(&decode_conflict_body(&record)?).into_owned();
    let current = if safe_key(&record.path) {
        std::fs::read(root.join(SPACE_DIR).join(&record.path))
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    } else {
        String::new()
    };
    Ok(SpaceConflictView {
        id,
        path: record.path,
        recorded_at: record.recorded_at,
        saved,
        current,
    })
}

/// 把没被采用的正文写回检出，并删掉冲突记录。
pub fn restore_space_conflict(root: &Path, id: &str) -> OmniResult<String> {
    let (id, record) = read_conflict_record(root, id)?;
    if !safe_key(&record.path) {
        return Err(OmniError::invalid_input("冲突路径无效"));
    }
    let body = decode_conflict_body(&record)?;
    let file = root.join(SPACE_DIR).join(&record.path);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    }
    std::fs::write(&file, body).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    delete_space_conflict(root, &id)?;
    Ok(record.path)
}

pub fn delete_space_conflict(root: &Path, id: &str) -> OmniResult<()> {
    if !safe_conflict_id(id) {
        return Err(OmniError::invalid_input("冲突记录 id 无效"));
    }
    let path = root
        .join(REPO_DIR)
        .join("conflicts")
        .join(format!("{id}.json"));
    if path.is_file() {
        std::fs::remove_file(path).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    }
    Ok(())
}

fn safe_conflict_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 96 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

async fn acquire_lock<R: SpaceRepoRemote + ?Sized>(
    remote: &mut R,
    device_id: &str,
    now: i64,
) -> OmniResult<()> {
    if device_id.trim().is_empty() {
        return Err(OmniError::invalid_input("设备 id 为空"));
    }
    if let Some(bytes) = remote.get("refs/lock").await? {
        if let Ok(lock) = serde_json::from_slice::<RepoLock>(&bytes) {
            if lock.expires_at_ms > now && lock.device_id != device_id {
                return Err(OmniError::new(
                    ErrorCode::Timeout,
                    "另一台电脑正在同步，请稍后再试",
                ));
            }
        }
    }
    let lock = RepoLock {
        device_id: device_id.to_string(),
        expires_at_ms: now + LOCK_TTL_MS,
    };
    let bytes = serde_json::to_vec(&lock)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    remote.put("refs/lock", &bytes).await
}

async fn release_lock<R: SpaceRepoRemote + ?Sized>(remote: &mut R, device_id: &str) {
    let Ok(Some(bytes)) = remote.get("refs/lock").await else {
        return;
    };
    if serde_json::from_slice::<RepoLock>(&bytes)
        .ok()
        .is_some_and(|lock| lock.device_id == device_id)
    {
        let _ = remote.delete("refs/lock").await;
    }
}

async fn load_remote_index<R: SpaceRepoRemote + ?Sized>(
    remote: &mut R,
    key: &[u8; 32],
) -> OmniResult<Option<SpaceRepoIndex>> {
    let Some(raw) = remote.get("refs/latest").await? else {
        return Ok(None);
    };
    let id = String::from_utf8_lossy(&raw).trim().to_string();
    if id.len() < 2 {
        return Ok(None);
    }
    let Some(blob) = remote.get(&format!("indexes/{id}.json")).await? else {
        return Ok(None);
    };
    let plain = open_bytes(key, &blob)?;
    let index = serde_json::from_slice(&plain)
        .map_err(|err| OmniError::new(ErrorCode::Storage, err.to_string()))?;
    Ok(Some(index))
}

async fn plaintext_chunk<R: SpaceRepoRemote + ?Sized>(
    remote: &mut R,
    root: &Path,
    key: &[u8; 32],
    id: &str,
    cache: &mut BTreeMap<String, Vec<u8>>,
) -> OmniResult<Vec<u8>> {
    if let Some(bytes) = cache.get(id) {
        return Ok(bytes.clone());
    }
    if let Some(bytes) = read_local_object(root, id) {
        cache.insert(id.to_string(), bytes.clone());
        return Ok(bytes);
    }
    let Some(blob) = remote.get(&format!("objects/{}/{id}", &id[..2])).await? else {
        return Err(OmniError::new(
            ErrorCode::Storage,
            format!("缺少空间块 {id}"),
        ));
    };
    let plain = open_bytes(key, &blob)?;
    cache.insert(id.to_string(), plain.clone());
    Ok(plain)
}

pub async fn sync_local_repo<R: SpaceRepoRemote>(
    root: &Path,
    remote: &mut R,
    key: &[u8; 32],
    device_id: &str,
    legacy: &BTreeMap<String, Vec<u8>>,
    managed: &BTreeSet<String>,
) -> OmniResult<SpaceSyncReport> {
    let now = now_ms();
    acquire_lock(remote, device_id, now).await?;
    let result = sync_locked(root, remote, key, device_id, legacy, managed, now).await;
    release_lock(remote, device_id).await;
    result
}

async fn sync_locked<R: SpaceRepoRemote>(
    root: &Path,
    remote: &mut R,
    key: &[u8; 32],
    device_id: &str,
    legacy: &BTreeMap<String, Vec<u8>>,
    managed: &BTreeSet<String>,
    now: i64,
) -> OmniResult<SpaceSyncReport> {
    let _ = device_id;
    let local = read_latest_index(root)?;
    let remote_index = load_remote_index(remote, key).await?;
    let mut files = read_space_files(root)?;
    let mut conflicts = 0u32;

    if remote_index.is_none() {
        for (path, bytes) in legacy {
            files.entry(path.clone()).or_insert_with(|| bytes.clone());
        }
    } else if let Some(remote_index) = remote_index.as_ref() {
        let base = read_base(root);
        let picks = merge_paths(base.as_ref(), &local, remote_index, managed, root);
        let mut cache = BTreeMap::new();
        for pick in picks {
            match pick.chunks {
                None => {
                    if pick.conflict {
                        if let Some(body) = files.get(&pick.path) {
                            write_conflict(root, &pick.path, body, now)?;
                            conflicts += 1;
                        }
                    }
                    files.remove(&pick.path);
                }
                Some(chunks) => {
                    let local_chunks = local
                        .files
                        .iter()
                        .find(|file| file.path == pick.path)
                        .map(|file| file.chunks.clone());
                    if local_chunks.as_ref() == Some(&chunks) {
                        if pick.conflict {
                            conflicts += 1;
                        }
                        continue;
                    }
                    let mut body = Vec::new();
                    for id in &chunks {
                        body.extend(plaintext_chunk(remote, root, key, id, &mut cache).await?);
                    }
                    if is_layout_path(&pick.path) {
                        if let Some(local_body) = files.get(&pick.path) {
                            if let Some(merged) = crate::space_layout_merge::merge_layout_document(
                                &pick.path, local_body, &body,
                            ) {
                                files.insert(pick.path, merged);
                                continue;
                            }
                        }
                    }
                    if pick.conflict {
                        if let Some(saved) = files.get(&pick.path).cloned() {
                            write_conflict(root, &pick.path, &saved, now)?;
                        }
                        conflicts += 1;
                    }
                    files.insert(pick.path, body);
                }
            }
        }
        supplement_missing_prefixes(&mut files, legacy, remote_index);
    }

    let built = build_space_repo(root, &files)?;
    let index_id = built.index_id;
    // 远端索引里出现过的块，当时已经先于索引传完。官方 OSS 删不掉，不必再逐个询问。
    let known_chunks = remote_index.as_ref().map(|index| {
        index
            .files
            .iter()
            .flat_map(|file| file.chunks.iter().cloned())
            .collect::<BTreeSet<_>>()
    });
    let mut uploaded = 0u32;
    for (id, plain) in chunks_of_index(root)? {
        if known_chunks.as_ref().is_some_and(|set| set.contains(&id)) {
            continue;
        }
        let object = format!("objects/{}/{id}", &id[..2]);
        if !remote.exists(&object).await? {
            let sealed = seal_bytes(key, &plain)?;
            remote.put(&object, &sealed).await?;
            uploaded += 1;
        }
    }
    let index = read_latest_index(root)?;
    let index_bytes = serde_json::to_vec(&index)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    let sealed_index = seal_bytes(key, &index_bytes)?;
    remote
        .put(&format!("indexes/{index_id}.json"), &sealed_index)
        .await?;
    remote
        .put("refs/latest", format!("{index_id}\n").as_bytes())
        .await?;
    write_base(root, &index_id)?;
    gc_remote(remote, &index).await?;
    gc_local(root, &index)?;

    Ok(SpaceSyncReport {
        skipped: false,
        index_id,
        uploaded_chunks: uploaded,
        conflicts,
        applied_connections: 0,
        file_count: u32::try_from(index.files.len()).unwrap_or(u32::MAX),
        ssh_sidebar_tree_json: None,
        folder_trees_json: None,
        custom_panels_json: None,
        workspaces_json: None,
        conversations_json: None,
        settings_json: None,
    })
}

fn chunks_of_index(root: &Path) -> OmniResult<Vec<(String, Vec<u8>)>> {
    let index = read_latest_index(root)?;
    let mut out = Vec::new();
    let mut seen = BTreeSet::new();
    for file in &index.files {
        for id in &file.chunks {
            if !seen.insert(id.clone()) {
                continue;
            }
            let bytes = read_local_object(root, id)
                .ok_or_else(|| OmniError::new(ErrorCode::Storage, format!("本地缺少块 {id}")))?;
            out.push((id.clone(), bytes));
        }
    }
    Ok(out)
}

fn read_space_files(root: &Path) -> OmniResult<BTreeMap<String, Vec<u8>>> {
    let space = root.join(SPACE_DIR);
    let mut found = Vec::new();
    walk(space.as_path(), &mut found)?;
    let mut files = BTreeMap::new();
    for path in found {
        let Ok(rel) = path.strip_prefix(&space) else {
            continue;
        };
        let key = rel
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        if !safe_key(&key) {
            continue;
        }
        let bytes = match std::fs::read(&path) {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(OmniError::new(ErrorCode::Io, err.to_string())),
        };
        files.insert(key, bytes);
    }
    Ok(files)
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) -> OmniResult<()> {
    if !dir.exists() {
        return Ok(());
    }
    for entry in
        std::fs::read_dir(dir).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?
    {
        let entry = entry.map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        let path = entry.path();
        if path.is_dir() {
            walk(&path, out)?;
        } else {
            out.push(path);
        }
    }
    Ok(())
}

async fn gc_remote<R: SpaceRepoRemote + ?Sized>(
    remote: &mut R,
    index: &SpaceRepoIndex,
) -> OmniResult<()> {
    let Ok(keys) = remote.list("objects/").await else {
        return Ok(());
    };
    let keep: BTreeSet<&str> = index
        .files
        .iter()
        .flat_map(|file| file.chunks.iter().map(String::as_str))
        .collect();
    for key in keys {
        let Some(id) = key.rsplit('/').next() else {
            continue;
        };
        if !keep.contains(id) {
            remote.delete(&key).await?;
        }
    }
    Ok(())
}

fn gc_local(root: &Path, index: &SpaceRepoIndex) -> OmniResult<()> {
    let dir = root.join(REPO_DIR).join("objects");
    let mut found = Vec::new();
    walk(&dir, &mut found)?;
    let keep: BTreeSet<&str> = index
        .files
        .iter()
        .flat_map(|file| file.chunks.iter().map(String::as_str))
        .collect();
    for path in found {
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !keep.contains(name) {
            std::fs::remove_file(path)
                .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        }
    }
    Ok(())
}

impl Storage {
    /// 把检出里能回写的记录放回 SQLite。数据库连接文件由调用方另行 upsert。
    pub fn apply_space_checkout(&self, root: &Path) -> OmniResult<u32> {
        let captured = crate::space_repo::capture_checkout_origins(root)?;
        self.save_resource_origins(&captured)?;
        let local_only = read_local_only_file(root);
        let connections = apply_json_dir::<crate::Connection>(root, "connections")?;
        for conn in &connections {
            if local_only.contains(&format!("connections/{}.json", conn.id)) {
                continue;
            }
            self.save_connection(conn)?;
        }
        for existing in self.list_connections()? {
            let rel = format!("connections/{}.json", existing.id);
            if local_only.contains(&rel) {
                continue;
            }
            if !connections.iter().any(|conn| conn.id == existing.id) {
                self.delete_connection(&existing.id)?;
            }
        }

        let keys = apply_json_dir::<crate::SshKeyRecord>(root, "sshkeys")?;
        for key in &keys {
            if local_only.contains(&format!("sshkeys/{}.json", key.id)) {
                continue;
            }
            self.save_ssh_key_record(key)?;
        }
        for existing in self.list_ssh_keys()? {
            if local_only.contains(&format!("sshkeys/{}.json", existing.id)) {
                continue;
            }
            if !keys.iter().any(|key| key.id == existing.id) {
                self.delete_ssh_key(&existing.id)?;
            }
        }

        let requests = apply_json_dir::<crate::SavedHttpRequest>(root, "http/requests")?;
        for req in &requests {
            if local_only.contains(&format!("http/requests/{}.json", req.id)) {
                continue;
            }
            self.http_save_request(req)?;
        }
        for existing in self.http_list_requests(None)? {
            if local_only.contains(&format!("http/requests/{}.json", existing.id)) {
                continue;
            }
            if !requests.iter().any(|req| req.id == existing.id) {
                self.http_delete_request(&existing.id)?;
            }
        }
        let collections = apply_json_dir::<crate::HttpCollection>(root, "http/collections")?;
        for col in &collections {
            if local_only.contains(&format!("http/collections/{}.json", col.id)) {
                continue;
            }
            self.http_save_collection(col)?;
        }
        for existing in self.http_list_collections()? {
            if local_only.contains(&format!("http/collections/{}.json", existing.id)) {
                continue;
            }
            if !collections.iter().any(|col| col.id == existing.id) {
                self.http_delete_collection(&existing.id)?;
            }
        }
        let envs = apply_json_dir::<crate::HttpEnvironment>(root, "http/environments")?;
        for env in &envs {
            if local_only.contains(&format!("http/environments/{}.json", env.id)) {
                continue;
            }
            self.http_save_environment(env)?;
        }
        for existing in self.http_list_environments()? {
            if local_only.contains(&format!("http/environments/{}.json", existing.id)) {
                continue;
            }
            if !envs.iter().any(|env| env.id == existing.id) {
                self.http_delete_environment(&existing.id)?;
            }
        }

        apply_knowledge(self, root, &local_only)?;
        apply_plugins(self, root, &local_only)?;
        apply_workflows(self, root, &local_only)?;
        apply_todos(self, root, &local_only)?;
        apply_skills(self, root, &local_only)?;
        apply_accounts(self, root, &local_only)?;
        apply_knowledge_assets(root, &local_only)?;
        apply_config_files(root)?;
        apply_vault(root, &local_only)?;
        Ok(u32::try_from(connections.len()).unwrap_or(u32::MAX))
    }
}

fn apply_workflows(
    storage: &Storage,
    root: &Path,
    local_only: &BTreeSet<String>,
) -> OmniResult<()> {
    let docs = apply_json_dir::<crate::workflow::WorkflowDetail>(root, "workflows")?;
    for doc in &docs {
        let rel = format!("workflows/{}.json", doc.workflow.id);
        if local_only.contains(&rel) {
            continue;
        }
        storage.workflow_save(&crate::workflow::SaveWorkflowRequest {
            id: Some(doc.workflow.id.clone()),
            name: doc.workflow.name.clone(),
            description: doc.workflow.description.clone(),
            workflow_type: doc.workflow.workflow_type.clone(),
            risk_level: doc.workflow.risk_level.clone(),
            target: doc.workflow.target.clone(),
            env_tag: doc.workflow.env_tag.clone(),
            steps: doc
                .steps
                .iter()
                .map(|step| crate::workflow::SaveStepRequest {
                    id: Some(step.id.clone()),
                    name: step.name.clone(),
                    description: step.description.clone(),
                    step_type: step.step_type.clone(),
                    command: step.command.clone(),
                    step_order: step.step_order,
                })
                .collect(),
        })?;
    }
    for existing in storage.workflow_list()? {
        let rel = format!("workflows/{}.json", existing.id);
        if local_only.contains(&rel) {
            continue;
        }
        if !docs.iter().any(|doc| doc.workflow.id == existing.id) {
            storage.workflow_delete(&existing.id)?;
        }
    }
    Ok(())
}

fn apply_todos(storage: &Storage, root: &Path, local_only: &BTreeSet<String>) -> OmniResult<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Doc {
        list: crate::todo::TodoList,
        #[serde(default)]
        tasks: Vec<TaskDoc>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct TaskDoc {
        task: crate::todo::TodoTask,
        #[serde(default)]
        steps: Vec<crate::todo::TodoStep>,
    }
    let docs = apply_json_dir::<Doc>(root, "todos")?;
    for doc in &docs {
        let rel = format!("todos/{}.json", doc.list.id);
        if local_only.contains(&rel) {
            continue;
        }
        storage.save_todo_list(&doc.list)?;
        for item in &doc.tasks {
            let mut task = item.task.clone();
            if task.steps.is_empty() {
                task.steps = item.steps.clone();
            }
            storage.save_todo_task(&task, true)?;
        }
        let query = crate::todo::TodoTaskQuery {
            view: "list".into(),
            list_id: Some(doc.list.id.clone()),
            include_completed: true,
            today: None,
        };
        for existing in storage.list_todo_tasks(&query)? {
            if !doc.tasks.iter().any(|item| item.task.id == existing.id) {
                storage.delete_todo_task(&existing.id)?;
            }
        }
    }
    for existing in storage.list_todo_lists()? {
        let rel = format!("todos/{}.json", existing.id);
        if local_only.contains(&rel) || existing.is_default {
            continue;
        }
        if !docs.iter().any(|doc| doc.list.id == existing.id) {
            storage.delete_todo_list(&existing.id)?;
        }
    }
    Ok(())
}

fn apply_skills(storage: &Storage, root: &Path, local_only: &BTreeSet<String>) -> OmniResult<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Doc {
        id: String,
        name: String,
        #[serde(default)]
        description: String,
        #[serde(default = "yes")]
        enabled: bool,
        #[serde(default)]
        version: i64,
        #[serde(default)]
        parent_version_id: String,
        #[serde(default)]
        shareable: bool,
        #[serde(default)]
        body: String,
    }
    fn yes() -> bool {
        true
    }
    let docs = apply_json_dir::<Doc>(root, "skills")?;
    for doc in &docs {
        let rel = format!("skills/{}.json", doc.id);
        if local_only.contains(&rel) {
            continue;
        }
        if !doc.body.is_empty() {
            write_skill_body(
                root,
                &doc.id,
                &doc.name,
                &doc.description,
                doc.enabled,
                &doc.body,
            )?;
        }
        let path = skill_checkout_path(root, &doc.id);
        storage.save_skill_db(&crate::SkillDbRecord {
            id: doc.id.clone(),
            name: doc.name.clone(),
            description: doc.description.clone(),
            enabled: doc.enabled,
            version: doc.version.max(1),
            parent_version_id: doc.parent_version_id.clone(),
            path,
            success_count: 0,
            failure_count: 0,
            last_applied_at: None,
            shareable: doc.shareable,
            created_at: 0,
            updated_at: 0,
        })?;
    }
    for existing in storage.list_skills_db()? {
        let rel = format!("skills/{}.json", existing.id);
        if local_only.contains(&rel) {
            continue;
        }
        if !docs.iter().any(|doc| doc.id == existing.id) {
            storage.delete_skill_db(&existing.id)?;
        }
    }
    Ok(())
}

fn skill_checkout_path(root: &Path, id: &str) -> String {
    #[cfg(test)]
    {
        root.join("skill-files")
            .join(id)
            .join("SKILL.md")
            .display()
            .to_string()
    }
    #[cfg(not(test))]
    {
        let _ = root;
        crate::skill::skill_file_path(id)
            .map(|path| path.display().to_string())
            .unwrap_or_default()
    }
}

fn write_skill_body(
    root: &Path,
    id: &str,
    name: &str,
    description: &str,
    enabled: bool,
    body: &str,
) -> OmniResult<()> {
    let frontmatter = crate::skill::SkillFrontmatter {
        name: name.to_string(),
        description: description.to_string(),
        enabled,
    };
    #[cfg(test)]
    {
        let dir = root.join("skill-files").join(id);
        std::fs::create_dir_all(&dir)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        let rendered = format!("---\nname: {name}\n---\n{body}");
        let _ = frontmatter;
        std::fs::write(dir.join("SKILL.md"), rendered)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    }
    #[cfg(not(test))]
    {
        let _ = root;
        crate::skill::write_skill(id, frontmatter, body)
            .map_err(|err| OmniError::new(ErrorCode::Io, "写入技能正文失败").with_cause(err))?;
    }
    Ok(())
}

fn apply_accounts(storage: &Storage, root: &Path, local_only: &BTreeSet<String>) -> OmniResult<()> {
    let docs = apply_json_dir::<crate::ThirdPartyAccount>(root, "accounts")?;
    for doc in &docs {
        let rel = format!("accounts/{}.json", doc.id);
        if local_only.contains(&rel) {
            continue;
        }
        let cred = if doc.has_secret {
            Some(crate::third_party_account::credential_ref_for(&doc.id))
        } else {
            None
        };
        let platform = serde_json::to_value(doc.platform)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "custom".into());
        let auth_method = serde_json::to_value(doc.auth_method)
            .ok()
            .and_then(|value| value.as_str().map(str::to_string))
            .unwrap_or_else(|| "api_key".into());
        storage
            .conn()
            .execute(
                "INSERT INTO third_party_accounts (id, name, platform, auth_method, username, notes, credential_ref, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    platform = excluded.platform,
                    auth_method = excluded.auth_method,
                    username = excluded.username,
                    notes = excluded.notes,
                    credential_ref = COALESCE(excluded.credential_ref, third_party_accounts.credential_ref),
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    doc.id,
                    doc.name,
                    platform,
                    auth_method,
                    doc.username,
                    doc.notes,
                    cred,
                    doc.created_at,
                    doc.updated_at,
                ],
            )
            .map_err(|err| OmniError::new(ErrorCode::Storage, err.to_string()))?;
    }
    for existing in storage.list_third_party_accounts()? {
        let rel = format!("accounts/{}.json", existing.id);
        if local_only.contains(&rel) {
            continue;
        }
        if !docs.iter().any(|doc| doc.id == existing.id) {
            storage.delete_third_party_account(&existing.id)?;
        }
    }
    Ok(())
}

fn apply_knowledge_assets(root: &Path, local_only: &BTreeSet<String>) -> OmniResult<()> {
    let base = root.join(SPACE_DIR).join("knowledge");
    if !base.is_dir() {
        return Ok(());
    }
    let mut found = Vec::new();
    walk(&base, &mut found)?;
    for path in found {
        let Some(rel) = path.strip_prefix(&base).ok().and_then(|p| p.to_str()) else {
            continue;
        };
        let rel = rel.replace('\\', "/");
        let mut parts = rel.split('/');
        let Some(id) = parts.next() else { continue };
        if parts.next() != Some("assets") {
            continue;
        }
        let rest: Vec<&str> = parts.collect();
        if rest.is_empty() || local_only.contains(&format!("knowledge/{id}.json")) {
            continue;
        }
        let dest = root
            .join("knowledge")
            .join("assets")
            .join(id)
            .join(rest.join("/"));
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        }
        std::fs::copy(&path, &dest)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    }
    Ok(())
}

fn apply_config_files(root: &Path) -> OmniResult<()> {
    restore_checkout_file(root, "ai/providers.json", crate::paths::ai_providers_path)?;
    restore_checkout_file(
        root,
        "ai/web-search.json",
        crate::paths::web_search_config_path,
    )?;
    restore_checkout_file(
        root,
        "ai/http-proxy.json",
        crate::paths::http_proxy_config_path,
    )?;
    Ok(())
}

fn restore_checkout_file(
    root: &Path,
    rel: &str,
    dest: fn() -> OmniResult<PathBuf>,
) -> OmniResult<()> {
    let src = root.join(SPACE_DIR).join(rel);
    if !src.is_file() {
        return Ok(());
    }
    let dest = dest()?;
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    }
    std::fs::copy(&src, &dest).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
    Ok(())
}

fn apply_json_dir<T: for<'de> Deserialize<'de>>(root: &Path, dir: &str) -> OmniResult<Vec<T>> {
    let base = root.join(SPACE_DIR).join(dir);
    if !base.exists() {
        return Ok(Vec::new());
    }
    let mut found = Vec::new();
    walk(&base, &mut found)?;
    let mut out = Vec::new();
    for path in found {
        if path.parent() != Some(base.as_path()) {
            continue;
        }
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let bytes =
            std::fs::read(&path).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        let item = serde_json::from_slice(&bytes).map_err(|err| {
            OmniError::new(ErrorCode::Storage, format!("无法读回 {}", path.display()))
                .with_cause(err.to_string())
        })?;
        out.push(item);
    }
    Ok(out)
}

fn apply_knowledge(
    storage: &Storage,
    root: &Path,
    local_only: &BTreeSet<String>,
) -> OmniResult<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Doc {
        entry: crate::KnowledgeEntry,
        #[serde(default)]
        revisions: Vec<crate::KnowledgeRevision>,
    }
    let docs = apply_json_dir::<Doc>(root, "knowledge")?;
    for doc in &docs {
        if local_only.contains(&format!("knowledge/{}.json", doc.entry.id)) {
            continue;
        }
        storage.save_knowledge(&doc.entry)?;
        for rev in &doc.revisions {
            storage
                .conn()
                .execute(
                    "INSERT OR IGNORE INTO knowledge_revisions (id, entry_id, title, content, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![rev.id, rev.entry_id, rev.title, rev.content, rev.created_at],
                )
                .map_err(|err| OmniError::new(ErrorCode::Storage, err.to_string()))?;
        }
    }
    for existing in storage.list_knowledge(None, None)? {
        if local_only.contains(&format!("knowledge/{}.json", existing.id)) {
            continue;
        }
        if !docs.iter().any(|doc| doc.entry.id == existing.id) {
            storage.delete_knowledge(&existing.id)?;
        }
    }
    Ok(())
}

fn apply_plugins(storage: &Storage, root: &Path, local_only: &BTreeSet<String>) -> OmniResult<()> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Doc {
        id: String,
        enabled: Option<bool>,
        state: Option<Value>,
    }
    let docs = apply_json_dir::<Doc>(root, "plugins")?;
    for doc in &docs {
        if local_only.contains(&format!("plugins/{}.json", doc.id)) {
            continue;
        }
        if let Some(enabled) = doc.enabled {
            storage.plugin_enabled_set(&doc.id, enabled)?;
        }
        if let Some(state) = &doc.state {
            let payload = serde_json::to_string(state)
                .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
            storage.plugin_state_set(&doc.id, &payload)?;
        }
    }
    Ok(())
}

fn apply_vault(root: &Path, local_only: &BTreeSet<String>) -> OmniResult<()> {
    #[derive(Deserialize)]
    struct Secret {
        reference: String,
        value: String,
    }
    let dir = root.join(SPACE_DIR).join("vault");
    if !dir.exists() {
        return Ok(());
    }
    let mut found = Vec::new();
    walk(&dir, &mut found)?;
    for path in found {
        let bytes =
            std::fs::read(&path).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        let secret: Secret = serde_json::from_slice(&bytes)
            .map_err(|err| OmniError::new(ErrorCode::Storage, err.to_string()))?;
        if !secret.reference.is_empty()
            && !local_only.contains(&format!("vault/{}.json", secret.reference))
        {
            Vault::store(&secret.reference, &secret.value)?;
        }
    }
    Ok(())
}

pub fn apply_database_files(root: &Path, connections_file: &Path) -> OmniResult<u32> {
    let dir = root.join(SPACE_DIR).join("databases");
    if !dir.exists() {
        return Ok(0);
    }
    let mut found = Vec::new();
    walk(&dir, &mut found)?;
    if found.is_empty() {
        return Ok(0);
    }
    let mut incoming = Vec::new();
    for path in found {
        let bytes =
            std::fs::read(&path).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        let item: crate::DbConnectionConfig = serde_json::from_slice(&bytes)
            .map_err(|err| OmniError::new(ErrorCode::Storage, err.to_string()))?;
        incoming.push(item);
    }
    let local_only = read_local_only_file(root);
    let mut current = crate::load_database_connections_from(connections_file).unwrap_or_default();
    let count = incoming.len();
    for mut item in incoming {
        if local_only.contains(&format!("databases/{}.json", item.id)) {
            continue;
        }
        let stored = current
            .iter()
            .find(|conn| conn.id == item.id)
            .map(|conn| conn.origin_device_id.clone())
            .unwrap_or_default();
        crate::database::settle_db_connection_origin(&stored, &mut item);
        if let Some(existing) = current.iter_mut().find(|conn| conn.id == item.id) {
            *existing = item;
        } else {
            current.push(item);
        }
    }
    crate::save_database_connections_to(connections_file, &current)?;
    Ok(u32::try_from(count).unwrap_or(u32::MAX))
}

/// 目录远端，测试用。
#[cfg(test)]
pub struct DirRemote {
    root: PathBuf,
}

#[cfg(test)]
impl DirRemote {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path_for(&self, key: &str) -> OmniResult<PathBuf> {
        if !safe_key(key) {
            return Err(OmniError::invalid_input(format!("非法远端键 {key}")));
        }
        Ok(self.root.join(key))
    }
}

#[cfg(test)]
#[async_trait]
impl SpaceRepoRemote for DirRemote {
    async fn get(&mut self, key: &str) -> OmniResult<Option<Vec<u8>>> {
        let path = self.path_for(key)?;
        if !path.is_file() {
            return Ok(None);
        }
        std::fs::read(path)
            .map(Some)
            .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))
    }

    async fn put(&mut self, key: &str, bytes: &[u8]) -> OmniResult<()> {
        let path = self.path_for(key)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        }
        std::fs::write(path, bytes).map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))
    }

    async fn delete(&mut self, key: &str) -> OmniResult<()> {
        let path = self.path_for(key)?;
        if path.is_file() {
            std::fs::remove_file(path)
                .map_err(|err| OmniError::new(ErrorCode::Io, err.to_string()))?;
        }
        Ok(())
    }

    async fn list(&mut self, prefix: &str) -> OmniResult<Vec<String>> {
        let dir = self.path_for(prefix.trim_end_matches('/'))?;
        let mut found = Vec::new();
        walk(&dir, &mut found)?;
        let mut keys = Vec::new();
        for path in found {
            if let Ok(rel) = path.strip_prefix(&self.root) {
                keys.push(
                    rel.components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join("/"),
                );
            }
        }
        Ok(keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{Connection, ConnectionKind};

    fn key() -> [u8; 32] {
        [9u8; 32]
    }

    fn conn(id: &str, name: &str) -> Connection {
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

    fn managed() -> BTreeSet<String> {
        FIXED_PREFIXES.iter().map(|p| (*p).to_string()).collect()
    }

    #[test]
    fn legacy_fills_only_missing_paths() {
        let bundle = serde_json::json!({
            "connections": [
                { "connection": { "id": "a", "kind": "ssh", "name": "old", "group": "", "envTag": "dev", "tags": [], "config": "{}", "createdAt": 1, "updatedAt": 1 } },
                { "connection": { "id": "c", "kind": "ssh", "name": "from-cloud", "group": "", "envTag": "dev", "tags": [], "config": "{}", "createdAt": 1, "updatedAt": 1 } }
            ]
        });
        let files = legacy_module_files(&bundle);
        assert!(files.contains_key("connections/a.json"));
        assert!(files.contains_key("connections/c.json"));
    }

    #[test]
    fn conversations_become_one_file_each() {
        let (files, managed) = layout_files(LayoutInput {
            ssh_sidebar_tree_json: None,
            folder_trees_json: None,
            custom_panels_json: None,
            workspaces_json: None,
            conversations_json: Some(r#"[{"id":"c1","title":"完整"},{"id":"../nope"}]"#),
            settings_json: None,
        })
        .unwrap();
        assert!(managed.contains("conversations"));
        assert!(files.contains_key("conversations/c1.json"));
        assert!(!files.keys().any(|path| path.contains("..")));
        let bundle = serde_json::json!({
            "conversations": [{ "id": "old", "messages": [1, 2, 3] }],
            "deleted": [{ "id": "gone", "deletedAt": 1 }]
        });
        let legacy = legacy_conversation_files(&bundle);
        assert!(legacy.contains_key("conversations/old.json"));
        assert!(!legacy.contains_key("conversations/gone.json"));
    }

    #[tokio::test]
    async fn legacy_conversations_fill_when_the_repo_has_no_such_prefix() {
        let remote_dir = tempfile::tempdir().unwrap();
        let mut remote = DirRemote::new(remote_dir.path());
        let root = tempfile::tempdir().unwrap();
        let store = Storage::open_in_memory().unwrap();
        store.save_connection(&conn("a", "alpha")).unwrap();
        store.rebuild_space_repo(root.path()).unwrap();
        sync_local_repo(
            root.path(),
            &mut remote,
            &key(),
            "device-a",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();

        let mut legacy = BTreeMap::new();
        legacy.insert(
            "conversations/c1.json".into(),
            b"{\"id\":\"c1\"}\n".to_vec(),
        );
        sync_local_repo(
            root.path(),
            &mut remote,
            &key(),
            "device-a",
            &legacy,
            &managed(),
        )
        .await
        .unwrap();
        let text =
            std::fs::read_to_string(root.path().join("space/conversations/c1.json")).unwrap();
        assert!(text.contains("c1"));
    }

    #[tokio::test]
    async fn two_devices_keep_unrelated_files_and_take_the_edit() {
        let remote_dir = tempfile::tempdir().unwrap();
        let mut remote = DirRemote::new(remote_dir.path());
        let a_root = tempfile::tempdir().unwrap();
        let a = Storage::open_in_memory().unwrap();
        a.save_connection(&conn("a", "alpha")).unwrap();
        a.save_connection(&conn("b", "beta")).unwrap();
        a.rebuild_space_repo(a_root.path()).unwrap();
        sync_local_repo(
            a_root.path(),
            &mut remote,
            &key(),
            "device-a",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();

        let b_root = tempfile::tempdir().unwrap();
        let b = Storage::open_in_memory().unwrap();
        b.rebuild_space_repo(b_root.path()).unwrap();
        sync_local_repo(
            b_root.path(),
            &mut remote,
            &key(),
            "device-b",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();
        b.apply_space_checkout(b_root.path()).unwrap();
        assert_eq!(b.get_connection("a").unwrap().unwrap().name, "alpha");

        b.save_connection(&conn("b", "beta-2")).unwrap();
        b.rebuild_space_repo(b_root.path()).unwrap();
        sync_local_repo(
            b_root.path(),
            &mut remote,
            &key(),
            "device-b",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();

        a.rebuild_space_repo(a_root.path()).unwrap();
        let before = read_latest_index(a_root.path()).unwrap();
        let a_chunk = before
            .files
            .iter()
            .find(|file| file.path == "connections/a.json")
            .unwrap()
            .chunks
            .clone();
        sync_local_repo(
            a_root.path(),
            &mut remote,
            &key(),
            "device-a",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();
        a.apply_space_checkout(a_root.path()).unwrap();
        assert_eq!(a.get_connection("b").unwrap().unwrap().name, "beta-2");
        let after = read_latest_index(a_root.path()).unwrap();
        let a_after = after
            .files
            .iter()
            .find(|file| file.path == "connections/a.json")
            .unwrap();
        assert_eq!(a_after.chunks, a_chunk);
    }

    #[tokio::test]
    async fn conflict_keeps_remote_bytes_and_records_local() {
        let remote_dir = tempfile::tempdir().unwrap();
        let mut remote = DirRemote::new(remote_dir.path());
        let a_root = tempfile::tempdir().unwrap();
        let store = Storage::open_in_memory().unwrap();
        store.save_connection(&conn("a", "one")).unwrap();
        store.rebuild_space_repo(a_root.path()).unwrap();
        sync_local_repo(
            a_root.path(),
            &mut remote,
            &key(),
            "device-a",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();

        let b_root = tempfile::tempdir().unwrap();
        store.rebuild_space_repo(b_root.path()).unwrap();
        // 第二台先对齐到同一份基线，再各自改同一条。
        let store_b = Storage::open_in_memory().unwrap();
        store_b.rebuild_space_repo(b_root.path()).unwrap();
        sync_local_repo(
            b_root.path(),
            &mut remote,
            &key(),
            "device-b",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();
        store_b.apply_space_checkout(b_root.path()).unwrap();
        store_b.save_connection(&conn("a", "from-b")).unwrap();
        store_b.rebuild_space_repo(b_root.path()).unwrap();
        sync_local_repo(
            b_root.path(),
            &mut remote,
            &key(),
            "device-b",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();

        store.save_connection(&conn("a", "from-a")).unwrap();
        store.rebuild_space_repo(a_root.path()).unwrap();
        let report = sync_local_repo(
            a_root.path(),
            &mut remote,
            &key(),
            "device-a",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap();
        assert!(report.conflicts >= 1);
        store.apply_space_checkout(a_root.path()).unwrap();
        assert_eq!(store.get_connection("a").unwrap().unwrap().name, "from-b");
        let conflict_dir = a_root.path().join(REPO_DIR).join("conflicts");
        assert!(conflict_dir.read_dir().unwrap().next().is_some());
    }

    #[tokio::test]
    async fn lock_held_by_another_device_blocks() {
        let remote_dir = tempfile::tempdir().unwrap();
        let mut remote = DirRemote::new(remote_dir.path());
        let lock = serde_json::json!({ "deviceId": "other", "expiresAtMs": now_ms() + 60_000 });
        remote
            .put("refs/lock", serde_json::to_vec(&lock).unwrap().as_slice())
            .await
            .unwrap();
        let root = tempfile::tempdir().unwrap();
        Storage::open_in_memory()
            .unwrap()
            .rebuild_space_repo(root.path())
            .unwrap();
        let err = sync_local_repo(
            root.path(),
            &mut remote,
            &key(),
            "device-a",
            &BTreeMap::new(),
            &managed(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.code, ErrorCode::Timeout);
    }

    #[tokio::test]
    async fn first_sync_keeps_local_and_adds_legacy_gaps() {
        let remote_dir = tempfile::tempdir().unwrap();
        let mut remote = DirRemote::new(remote_dir.path());
        let root = tempfile::tempdir().unwrap();
        let store = Storage::open_in_memory().unwrap();
        store.save_connection(&conn("a", "local")).unwrap();
        store.rebuild_space_repo(root.path()).unwrap();
        let mut legacy = BTreeMap::new();
        legacy.insert(
            "connections/a.json".into(),
            br#"{"id":"a","kind":"ssh","name":"stale"}"#.to_vec(),
        );
        legacy.insert(
            "connections/c.json".into(),
            br#"{"id":"c","kind":"ssh","name":"gap","group":"","envTag":"dev","tags":[],"config":"{}","createdAt":1,"updatedAt":1}"#.to_vec(),
        );
        sync_local_repo(
            root.path(),
            &mut remote,
            &key(),
            "device-a",
            &legacy,
            &managed(),
        )
        .await
        .unwrap();
        let text = std::fs::read_to_string(root.path().join(SPACE_DIR).join("connections/a.json"))
            .unwrap();
        assert!(text.contains("local"));
        assert!(
            root.path()
                .join(SPACE_DIR)
                .join("connections/c.json")
                .is_file()
        );
        let latest = remote.get("refs/latest").await.unwrap().unwrap();
        assert!(!latest.is_empty());
        let chunk_keys = remote.list("objects/").await.unwrap();
        assert!(!chunk_keys.is_empty());
    }

    #[test]
    fn database_apply_keeps_the_origin_already_stored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        let space = root.join(SPACE_DIR).join("databases");
        std::fs::create_dir_all(&space).unwrap();
        std::fs::write(
            space.join("a.json"),
            r#"{"id":"a","name":"cloud","db_type":"mysql","host":"10.0.0.8","port":3306,"user":"root","password":"","database":"app","tags":["origin:dev-remote","env:prod"],"group":"default"}"#,
        )
        .unwrap();
        std::fs::write(
            space.join("b.json"),
            r#"{"id":"b","name":"new","db_type":"mysql","host":"10.0.0.9","port":3306,"user":"root","password":"","database":"app","tags":["origin:dev-new"],"group":"default"}"#,
        )
        .unwrap();
        let connections = dir.path().join("connections.json");
        let local = crate::DbConnectionConfig {
            id: "a".into(),
            name: "local".into(),
            db_type: "mysql".into(),
            host: "10.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: String::new(),
            database: "app".into(),
            ssl: false,
            sid: String::new(),
            sysdba: false,
            status: "unknown".into(),
            enabled: true,
            has_password: false,
            tags: vec!["env:local".into()],
            group: "default".into(),
            origin_device_id: "dev-local".into(),
        };
        crate::save_database_connections_to(&connections, std::slice::from_ref(&local)).unwrap();
        apply_database_files(root, &connections).unwrap();
        let loaded = crate::load_database_connections_from(&connections).unwrap();
        assert_eq!(loaded[0].host, "10.0.0.8");
        assert_eq!(loaded[0].origin_device_id, "dev-local");
        assert!(!loaded[0].tags.iter().any(|tag| tag.starts_with("origin:")));
        assert!(loaded[0].tags.iter().any(|tag| tag == "env:prod"));
        let fresh = loaded.iter().find(|conn| conn.id == "b").unwrap();
        assert_eq!(fresh.origin_device_id, "dev-new");
        assert!(fresh.tags.is_empty());
    }

    #[test]
    fn conflict_view_reads_saved_copy_and_restore_writes_checkout() {
        let root = tempfile::tempdir().unwrap();
        write_conflict(
            root.path(),
            "connections/a.json",
            br#"{"name":"local"}"#,
            10,
        )
        .unwrap();
        std::fs::create_dir_all(root.path().join(SPACE_DIR).join("connections")).unwrap();
        std::fs::write(
            root.path().join(SPACE_DIR).join("connections/a.json"),
            br#"{"name":"cloud"}"#,
        )
        .unwrap();
        let listed = list_space_conflicts(root.path()).unwrap();
        let view = read_space_conflict(root.path(), &listed[0].id).unwrap();
        assert_eq!(view.path, "connections/a.json");
        assert!(view.saved.contains("local"));
        assert!(view.current.contains("cloud"));
        restore_space_conflict(root.path(), &view.id).unwrap();
        let text = std::fs::read_to_string(root.path().join(SPACE_DIR).join("connections/a.json"))
            .unwrap();
        assert!(text.contains("local"));
        assert!(list_space_conflicts(root.path()).unwrap().is_empty());
    }
}
