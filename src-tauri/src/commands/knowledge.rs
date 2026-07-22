use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use omnipanel_store::{
    knowledge_entry_assets_dir, KnowledgeEntry, KnowledgeRevision, KnowledgeSearchResult,
    KnowledgeTodoList,
};
use tauri::State;

use crate::state::AppState;

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

fn knowledge_title_from_pdf_path(path: &str) -> Result<String, OmniError> {
    Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| OmniError::invalid_input("无效的文件路径"))
}

fn next_knowledge_sort_order(entries: &[KnowledgeEntry], parent_id: &str) -> i64 {
    entries
        .iter()
        .filter(|e| e.parent_id == parent_id)
        .map(|e| e.sort_order)
        .max()
        .unwrap_or(-1)
        + 1
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

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

/// 从 PDF 文件导入知识文档（提取文本并保存为 document 条目）。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_import_pdf(
    state: State<'_, AppState>,
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

    let content = pdf_extract::extract_text(path).map_err(|e| {
        OmniError::internal("PDF 文本提取失败").with_cause(e.to_string())
    })?;
    if content.trim().is_empty() {
        return Err(OmniError::invalid_input("PDF 中未提取到文本内容"));
    }

    let title = knowledge_title_from_pdf_path(path)?;
    let parent = parent_id.unwrap_or_default();
    let now = now_millis();

    let entry = {
        let storage = state.storage.lock().await;
        let all = storage.list_knowledge(None, None)?;
        let sort_order = next_knowledge_sort_order(&all, &parent);
        KnowledgeEntry {
            id: new_knowledge_id(),
            kind: "snippet".to_string(),
            title,
            content,
            tags: vec![],
            risk_level: "safe".to_string(),
            source: format!("import:pdf:{path}"),
            env_tag: "dev".to_string(),
            language: String::new(),
            usage_count: 0,
            created_at: now,
            updated_at: now,
            parent_id: parent,
            node_type: "document".to_string(),
            sort_order,
            resource_type: String::new(),
            resource_id: String::new(),
        }
    };

    {
        let storage = state.storage.lock().await;
        storage.save_knowledge(&entry)?;
    }

    Ok(entry)
}

/// 列出文档历史版本。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_list_revisions(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Vec<KnowledgeRevision>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_knowledge_revisions(&entry_id)
}

/// 恢复历史版本为当前文档内容。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_restore_revision(
    state: State<'_, AppState>,
    revision_id: String,
) -> Result<KnowledgeEntry, OmniError> {
    let storage = state.storage.lock().await;
    storage.restore_knowledge_revision(&revision_id)
}

/// 保存知识库附件，返回可用于 Markdown 的相对资源描述。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeAssetSaved {
    pub entry_id: String,
    pub file_name: String,
    pub absolute_path: String,
}

/// 将二进制写入文档附件目录。
#[tauri::command]
#[specta::specta]
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

/// 解析附件绝对路径。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_asset_path(
    entry_id: String,
    file_name: String,
) -> Result<String, OmniError> {
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
