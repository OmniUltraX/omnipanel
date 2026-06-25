use serde::{Deserialize, Serialize};

/// 文件索引元信息（按连接维度）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexStatus {
    pub connection_id: String,
    /// idle | building | ready | failed
    pub status: String,
    pub root_path: String,
    #[specta(type = f64)]
    pub indexed_count: i64,
    pub error: String,
    #[specta(type = f64)]
    pub started_at: i64,
    #[specta(type = f64)]
    pub finished_at: i64,
}

/// 单条索引记录（不含正文）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexEntry {
    pub connection_id: String,
    pub path: String,
    pub name: String,
    /// file | dir
    pub kind: String,
    #[specta(type = f64)]
    pub size: i64,
    #[specta(type = f64)]
    pub modified: i64,
}

/// FTS5 搜索结果。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexSearchResult {
    pub entry: FileIndexEntry,
    pub snippet: String,
    #[specta(type = f64)]
    pub score: i64,
}

/// 索引进度事件载荷。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileIndexProgress {
    pub connection_id: String,
    /// building | done | failed
    pub status: String,
    #[specta(type = f64)]
    pub indexed_count: i64,
    pub error: String,
}

#[derive(Debug, Clone)]
pub struct FileIndexBatchItem {
    pub path: String,
    pub name: String,
    pub kind: String,
    pub size: u64,
    pub modified: i64,
    pub content: String,
}
