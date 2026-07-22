use omnipanel_error::OmniError;
use omnipanel_store::{
    ResourceTagDto, SearchEverywhereHit, TagDto, TagMatchMode, TagSource, TaggableKind,
    TaggedResourceSummary,
};
use tauri::State;

use crate::state::AppState;

fn parse_kind(kind: &str) -> Result<TaggableKind, OmniError> {
    TaggableKind::parse(kind)
}

fn parse_source(source: &str) -> TagSource {
    TagSource::parse(source)
}

fn parse_mode(mode: &str) -> TagMatchMode {
    TagMatchMode::parse(mode)
}

/// 列出全局标签树（扁平，含可选计数）。
#[tauri::command]
#[specta::specta]
pub async fn tag_list_tree(
    state: State<'_, AppState>,
    include_counts: Option<bool>,
) -> Result<Vec<TagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_list_tree(include_counts.unwrap_or(true))
}

/// 仅列出已绑定到指定资源范围的标签（筛选面板用；打标编辑仍走全局）。
#[tauri::command]
#[specta::specta]
pub async fn tag_list_used_by(
    state: State<'_, AppState>,
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

/// 创建标签。
#[tauri::command]
#[specta::specta]
pub async fn tag_create(
    state: State<'_, AppState>,
    name: String,
    parent_id: Option<String>,
    color: Option<String>,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_create(&name, parent_id.as_deref(), color.as_deref())
}

/// 重命名标签。
#[tauri::command]
#[specta::specta]
pub async fn tag_rename(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_rename(&id, &name)
}

/// 移动标签。
#[tauri::command]
#[specta::specta]
pub async fn tag_move(
    state: State<'_, AppState>,
    id: String,
    new_parent_id: Option<String>,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_move(&id, new_parent_id.as_deref())
}

/// 删除标签（可选级联子孙）。
#[tauri::command]
#[specta::specta]
pub async fn tag_delete(
    state: State<'_, AppState>,
    id: String,
    cascade: Option<bool>,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_delete(&id, cascade.unwrap_or(false))
}

/// 设置标签颜色。
#[tauri::command]
#[specta::specta]
pub async fn tag_set_color(
    state: State<'_, AppState>,
    id: String,
    color: Option<String>,
) -> Result<TagDto, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_set_color(&id, color.as_deref())
}

/// 列出资源上的标签。
#[tauri::command]
#[specta::specta]
pub async fn resource_list_tags(
    state: State<'_, AppState>,
    kind: String,
    resource_id: String,
) -> Result<Vec<ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_list_tags(parse_kind(&kind)?, &resource_id)
}

/// 全量替换资源的用户标签。
#[tauri::command]
#[specta::specta]
pub async fn resource_set_tags(
    state: State<'_, AppState>,
    kind: String,
    resource_id: String,
    paths: Vec<String>,
) -> Result<Vec<ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_set_user_tags(parse_kind(&kind)?, &resource_id, &paths)
}

/// 为资源追加标签。
#[tauri::command]
#[specta::specta]
pub async fn resource_add_tag(
    state: State<'_, AppState>,
    kind: String,
    resource_id: String,
    path: String,
    source: Option<String>,
) -> Result<Vec<ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    let src = source
        .as_deref()
        .map(parse_source)
        .unwrap_or(TagSource::User);
    storage.resource_add_tag(parse_kind(&kind)?, &resource_id, &path, src)
}

/// 移除资源上的标签。
#[tauri::command]
#[specta::specta]
pub async fn resource_remove_tag(
    state: State<'_, AppState>,
    kind: String,
    resource_id: String,
    tag_id: String,
) -> Result<Vec<ResourceTagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_remove_tag(parse_kind(&kind)?, &resource_id, &tag_id)
}

/// 写入系统键标签（如 os）。
#[tauri::command]
#[specta::specta]
pub async fn resource_set_system_tag(
    state: State<'_, AppState>,
    kind: String,
    resource_id: String,
    key: String,
    value: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.resource_set_system_key(parse_kind(&kind)?, &resource_id, &key, &value)
}

/// 按标签查询资源。
#[tauri::command]
#[specta::specta]
pub async fn tag_query_resources(
    state: State<'_, AppState>,
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

/// 标签路径补全。
#[tauri::command]
#[specta::specta]
pub async fn tag_suggest(
    state: State<'_, AppState>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<TagDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.tag_suggest(&query, limit.unwrap_or(20))
}

/// 全局搜索（多源 + 标签过滤）。
#[tauri::command]
#[specta::specta]
pub async fn search_everywhere(
    state: State<'_, AppState>,
    query: String,
    tag_ids: Option<Vec<String>>,
    mode: Option<String>,
    limit: Option<i64>,
) -> Result<Vec<SearchEverywhereHit>, OmniError> {
    let storage = state.storage.lock().await;
    storage.search_everywhere(
        &query,
        tag_ids.as_deref().unwrap_or(&[]),
        parse_mode(mode.as_deref().unwrap_or("and")),
        limit.unwrap_or(40),
    )
}
