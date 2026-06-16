use omnipanel_error::OmniError;
use omnipanel_store::{KnowledgeEntry, KnowledgeSearchResult, KnowledgeTodoList};
use tauri::State;

use crate::state::AppState;

/// 列出知识条目（可选按 kind / tag 过滤）。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_list(
    state: State<'_, AppState>,
    kind: Option<String>,
    tag: Option<String>,
) -> Result<Vec<KnowledgeEntry>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge(kind.as_deref(), tag.as_deref())
}

/// 按 id 获取单条知识。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<KnowledgeEntry>, OmniError> {
    let storage = state.storage.lock().await;
    storage.get_knowledge(&id)
}

/// 保存（新建或更新）知识条目。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_save(
    state: State<'_, AppState>,
    entry: KnowledgeEntry,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_knowledge(&entry)
}

/// 删除知识条目。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_knowledge(&id)
}

/// FTS5 全文搜索（可选按 kind 过滤）。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_search(
    state: State<'_, AppState>,
    query: String,
    kind: Option<String>,
) -> Result<Vec<KnowledgeSearchResult>, OmniError> {
    let storage = state.storage.lock().await;
    storage.search_knowledge(&query, kind.as_deref())
}

/// 列出所有不重复的 tag。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_tags(state: State<'_, AppState>) -> Result<Vec<String>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge_tags()
}

/// 递增使用次数。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_increment_usage(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.increment_usage(&id)
}

/// 列出全部待办列表。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_todo_list(
    state: State<'_, AppState>,
) -> Result<Vec<KnowledgeTodoList>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge_todos()
}

/// 保存（新建或更新）待办列表。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_todo_save(
    state: State<'_, AppState>,
    list: KnowledgeTodoList,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.save_knowledge_todo(&list)
}

/// 删除待办列表。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_todo_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_knowledge_todo(&id)
}
