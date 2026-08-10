//! 知识库 / 标签 / 待办 / 资源档案（store 薄封装）。

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use omnipanel_store::{
    knowledge_entry_assets_dir, KnowledgeEntry, KnowledgeRevision, KnowledgeSearchResult,
    KnowledgeTodoList, KnowledgeChunkListResult, ResourceObservation, ResourceProfileSummary,
    SearchEverywhereHit, TagDto, TagMatchMode, TagSource, TaggableKind, TaggedResourceSummary,
    TodoList, TodoStep, TodoTask, TodoTaskQuery,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerState;

#[allow(dead_code)]
fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_knowledge_id() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let nanos = t.as_nanos();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (nanos >> 96) as u32,
        ((nanos >> 80) & 0xFFFF) as u16,
        ((nanos >> 64) & 0xFFF) as u16,
        ((nanos >> 48) & 0xFFFF) as u16,
        nanos & 0xFFFFFFFFFFFF_u128
    )
}

fn parse_kind(kind: &str) -> Result<TaggableKind, OmniError> {
    TaggableKind::parse(kind)
}

fn parse_source(source: &str) -> TagSource {
    TagSource::parse(source)
}

fn parse_mode(mode: &str) -> TagMatchMode {
    TagMatchMode::parse(mode)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeAssetSaved {
    pub entry_id: String,
    pub file_name: String,
    pub absolute_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDeleteChunksResult {
    pub entry_id: String,
    pub deleted: i64,
    pub remaining: i64,
}

pub async fn knowledge_list(
    state: &ServerState,
    kind: Option<String>,
    tag: Option<String>,
) -> Result<Vec<KnowledgeEntry>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge(kind.as_deref(), tag.as_deref())
}

pub async fn knowledge_get(
    state: &ServerState,
    id: String,
) -> Result<Option<KnowledgeEntry>, OmniError> {
    let storage = state.storage.lock().await;
    storage.get_knowledge(&id)
}

pub async fn knowledge_save(state: &ServerState, entry: KnowledgeEntry) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_knowledge(&entry)
}

pub async fn knowledge_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_knowledge(&id)?;
    drop(storage);
    if let Ok(root) = omnipanel_store::knowledge_assets_root() {
        let dir = root.join(&id);
        if dir.is_dir() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
    Ok(())
}

pub async fn knowledge_search(
    state: &ServerState,
    query: String,
    kind: Option<String>,
) -> Result<Vec<KnowledgeSearchResult>, OmniError> {
    let storage = state.storage.lock().await;
    storage.search_knowledge(&query, kind.as_deref())
}

pub async fn knowledge_tags(state: &ServerState) -> Result<Vec<String>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge_tags()
}

pub async fn knowledge_increment_usage(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.increment_usage(&id)
}

pub async fn knowledge_list_revisions(
    state: &ServerState,
    entry_id: String,
) -> Result<Vec<KnowledgeRevision>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge_revisions(&entry_id)
}

pub async fn knowledge_restore_revision(
    state: &ServerState,
    revision_id: String,
) -> Result<KnowledgeEntry, OmniError> {
    let storage = state.storage.lock().await;
    storage.restore_knowledge_revision(&revision_id)
}

pub async fn knowledge_save_asset(
    entry_id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<KnowledgeAssetSaved, OmniError> {
    let entry_id = entry_id.trim();
    if entry_id.is_empty() {
        return Err(OmniError::invalid_input("entryId 不能为空"));
    }
    let safe_name = Path::new(file_name.trim())
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::invalid_input("无效的文件名"))?
        .to_string();

    let dir = knowledge_entry_assets_dir(entry_id)?;
    let ext = Path::new(&safe_name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let stored_name = format!("{}.{}", new_knowledge_id(), ext);
    let path = dir.join(&stored_name);
    std::fs::write(&path, bytes).map_err(|e| {
        OmniError::internal("写入附件失败").with_cause(e.to_string())
    })?;

    Ok(KnowledgeAssetSaved {
        entry_id: entry_id.to_string(),
        file_name: stored_name,
        absolute_path: path.to_string_lossy().to_string(),
    })
}

pub async fn knowledge_asset_path(entry_id: String, file_name: String) -> Result<String, OmniError> {
    let safe_name = Path::new(file_name.trim())
        .file_name()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::invalid_input("无效的文件名"))?;
    let path = knowledge_entry_assets_dir(entry_id.trim())?.join(safe_name);
    if !path.is_file() {
        return Err(OmniError::not_found("附件不存在"));
    }
    Ok(path.to_string_lossy().to_string())
}

pub async fn knowledge_list_chunks(
    state: &ServerState,
    entry_id: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<KnowledgeChunkListResult, OmniError> {
    const DEFAULT_LIMIT: i64 = 12;
    let storage = state.storage.lock().await;
    storage.list_knowledge_chunks_page(
        &entry_id,
        offset.unwrap_or(0) as i64,
        limit.map(|n| n as i64).unwrap_or(DEFAULT_LIMIT),
    )
}

#[allow(dead_code)]
fn knowledge_title_from_pdf_path(path: &str) -> Result<String, OmniError> {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| OmniError::invalid_input("无效的文件路径"))
}

#[allow(dead_code)]
fn next_knowledge_sort_order(entries: &[KnowledgeEntry], parent_id: &str) -> i64 {
    entries
        .iter()
        .filter(|e| e.parent_id == parent_id)
        .map(|e| e.sort_order)
        .max()
        .unwrap_or(-1)
        + 1
}

/// 从本地 PDF 提取文本并创建知识条目。
pub async fn knowledge_import_pdf(
    state: &ServerState,
    path: String,
    parent_id: Option<String>,
) -> Result<KnowledgeEntry, OmniError> {
    let path = path.trim();
    if path.is_empty() {
        return Err(OmniError::invalid_input("未选择文件"));
    }

    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    if !ext.eq_ignore_ascii_case("pdf") {
        return Err(OmniError::invalid_input("仅支持 PDF 格式文件"));
    }

    let _ = (state, parent_id, path);
    Err(OmniError::invalid_input(
        "Web 端暂未接入 PDF 文本提取，请使用桌面端导入或粘贴文本",
    ))
}

pub async fn knowledge_delete_chunks(
    state: &ServerState,
    entry_id: String,
    chunk_ids: Vec<String>,
) -> Result<KnowledgeDeleteChunksResult, OmniError> {
    let storage = state.storage.lock().await;
    let (deleted, remaining) = storage.delete_knowledge_chunks(&entry_id, &chunk_ids)?;
    Ok(KnowledgeDeleteChunksResult {
        entry_id,
        deleted,
        remaining,
    })
}

pub async fn knowledge_todo_list(state: &ServerState) -> Result<Vec<KnowledgeTodoList>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge_todos()
}

pub async fn knowledge_todo_save(
    state: &ServerState,
    list: KnowledgeTodoList,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_knowledge_todo(&list)
}

pub async fn knowledge_todo_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_knowledge_todo(&id)
}

pub async fn tag_list_tree(
    state: &ServerState,
    include_counts: Option<bool>,
) -> Result<Vec<TagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_list_tree(include_counts.unwrap_or(true))
}

pub async fn tag_list_used_by(
    state: &ServerState,
    include_counts: Option<bool>,
    resource_kinds: Option<Vec<String>>,
    connection_kinds: Option<Vec<String>>,
    extra_resource_ids: Option<Vec<String>>,
    include_ancestors: Option<bool>,
) -> Result<Vec<TagDto>, OmniError> {
    let kinds: Option<Vec<TaggableKind>> = resource_kinds
        .as_ref()
        .map(|list| {
            list.iter()
                .map(|k| parse_kind(k))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    let storage = state.storage.lock().await;
    storage.tag_list_used_by(
        include_counts.unwrap_or(true),
        kinds.as_deref(),
        connection_kinds.as_deref(),
        extra_resource_ids.as_deref(),
        include_ancestors.unwrap_or(true),
    )
}

pub async fn tag_create(
    state: &ServerState,
    name: String,
    parent_id: Option<String>,
    color: Option<String>,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_create(&name, parent_id.as_deref(), color.as_deref())
}

pub async fn tag_rename(
    state: &ServerState,
    id: String,
    name: String,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_rename(&id, &name)
}

pub async fn tag_move(
    state: &ServerState,
    id: String,
    new_parent_id: Option<String>,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_move(&id, new_parent_id.as_deref())
}

pub async fn tag_delete(
    state: &ServerState,
    id: String,
    cascade: Option<bool>,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_delete(&id, cascade.unwrap_or(false))
}

pub async fn tag_set_color(
    state: &ServerState,
    id: String,
    color: Option<String>,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_set_color(&id, color.as_deref())
}

pub async fn resource_list_tags(
    state: &ServerState,
    kind: String,
    resource_id: String,
) -> Result<Vec<omnipanel_store::ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_list_tags(parse_kind(&kind)?, &resource_id)
}

pub async fn resource_set_tags(
    state: &ServerState,
    kind: String,
    resource_id: String,
    paths: Vec<String>,
) -> Result<Vec<omnipanel_store::ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_set_user_tags(parse_kind(&kind)?, &resource_id, &paths)
}

pub async fn resource_add_tag(
    state: &ServerState,
    kind: String,
    resource_id: String,
    path: String,
    source: Option<String>,
) -> Result<Vec<omnipanel_store::ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    let src = source
        .as_deref()
        .map(parse_source)
        .unwrap_or(TagSource::User);
    storage.resource_add_tag(parse_kind(&kind)?, &resource_id, &path, src)
}

pub async fn resource_remove_tag(
    state: &ServerState,
    kind: String,
    resource_id: String,
    tag_id: String,
) -> Result<Vec<omnipanel_store::ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_remove_tag(parse_kind(&kind)?, &resource_id, &tag_id)
}

pub async fn resource_set_system_tag(
    state: &ServerState,
    kind: String,
    resource_id: String,
    key: String,
    value: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_set_system_key(parse_kind(&kind)?, &resource_id, &key, &value)
}

pub async fn tag_query_resources(
    state: &ServerState,
    tag_ids: Vec<String>,
    mode: Option<String>,
    kinds: Option<Vec<String>>,
    include_descendants: Option<bool>,
) -> Result<Vec<TaggedResourceSummary>, OmniError> {
    let storage = state.storage.lock().await;
    let mode = parse_mode(mode.as_deref().unwrap_or("and"));
    let kinds: Option<Vec<TaggableKind>> = kinds
        .map(|ks| {
            ks.into_iter()
                .map(|k| TaggableKind::parse(&k))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?;
    storage.tag_query_resources(
        &tag_ids,
        mode,
        kinds.as_deref(),
        include_descendants.unwrap_or(true),
    )
}

pub async fn tag_suggest(
    state: &ServerState,
    query: String,
    limit: Option<f64>,
) -> Result<Vec<TagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_suggest(&query, limit.unwrap_or(20.0) as i64)
}

pub async fn search_everywhere(
    state: &ServerState,
    query: String,
    tag_ids: Option<Vec<String>>,
    mode: Option<String>,
    limit: Option<f64>,
) -> Result<Vec<SearchEverywhereHit>, OmniError> {
    let storage = state.storage.lock().await;
    storage.search_everywhere(
        &query,
        tag_ids.as_deref().unwrap_or(&[]),
        parse_mode(mode.as_deref().unwrap_or("and")),
        limit.unwrap_or(40.0) as i64,
    )
}

pub async fn todo_list_list(state: &ServerState) -> Result<Vec<TodoList>, OmniError> {
    let storage = state.storage.lock().await;
    storage.ensure_todo_schema_data()?;
    storage.list_todo_lists()
}

pub async fn todo_list_save(state: &ServerState, list: TodoList) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_todo_list(&list)
}

pub async fn todo_list_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_todo_list(&id)
}

pub async fn todo_task_list(
    state: &ServerState,
    query: TodoTaskQuery,
) -> Result<Vec<TodoTask>, OmniError> {
    let storage = state.storage.lock().await;
    storage.ensure_todo_schema_data()?;
    storage.list_todo_tasks(&query)
}

pub async fn todo_task_get(
    state: &ServerState,
    id: String,
) -> Result<Option<TodoTask>, OmniError> {
    let storage = state.storage.lock().await;
    storage.get_todo_task(&id)
}

pub async fn todo_task_save(
    state: &ServerState,
    task: TodoTask,
    replace_steps: bool,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_todo_task(&task, replace_steps)
}

pub async fn todo_task_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_todo_task(&id)
}

pub async fn todo_step_save(state: &ServerState, step: TodoStep) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_todo_step(&step)
}

pub async fn todo_step_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_todo_step(&id)
}

pub async fn resource_list_profiles(
    state: &ServerState,
    resource_type: Option<String>,
) -> Result<Vec<ResourceProfileSummary>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_resources_with_profiles(resource_type.as_deref())
}

pub async fn resource_get_profile(
    state: &ServerState,
    resource_type: String,
    resource_id: String,
) -> Result<Option<serde_json::Value>, OmniError> {
    let storage = state.storage.lock().await;
    storage.get_latest_resource_profile(&resource_type, &resource_id)
}

pub async fn resource_find_similar(
    state: &ServerState,
    resource_type: String,
    resource_id: String,
    limit: Option<f64>,
) -> Result<Vec<ResourceProfileSummary>, OmniError> {
    let storage = state.storage.lock().await;
    storage.find_similar_resources(
        &resource_type,
        &resource_id,
        limit.unwrap_or(5.0) as usize,
    )
}

pub async fn resource_delete_observations(
    state: &ServerState,
    resource_type: String,
    resource_id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_resource_observations(&resource_type, &resource_id)
}

pub async fn resource_list_knowledge(
    state: &ServerState,
    resource_type: String,
    resource_id: String,
    _limit: Option<f64>,
) -> Result<Vec<KnowledgeEntry>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge_for_resource(&resource_type, &resource_id)
}

pub async fn resource_save_observation(
    state: &ServerState,
    obs: ResourceObservation,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_resource_observation(&obs)
}
