use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use specta::Type;

/// 表行对比进度事件（推送给前端）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowCompareEvent {
    pub table: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_rows: Option<u32>,
    #[serde(default)]
    pub diffs: Vec<crate::row_diff_cache::TableRowDiffPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub truncated: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_cache_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableCountEvent {
    pub table: String,
    pub side: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaColumnDiffPayload {
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_type: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaIndexDiffPayload {
    pub name: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCompareEvent {
    pub table: String,
    pub status: String,
    #[serde(default)]
    pub columns: Vec<SchemaColumnDiffPayload>,
    #[serde(default)]
    pub indexes: Vec<SchemaIndexDiffPayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncExecResultEvent {
    pub table: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rows_written: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgTaskDbEvent {
    pub task_id: String,
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<TableCountEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_result: Option<TableRowCompareEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema_result: Option<SchemaCompareEvent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exec_result: Option<SyncExecResultEvent>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MysqlExportRecord {
    pub id: String,
    pub connection_id: String,
    pub database_name: String,
    pub file_name: String,
    pub file_path: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub file_size: u64,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgTaskMysqlExportEvent {
    pub task_id: String,
    pub event_type: String,
    pub connection_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub export: Option<MysqlExportRecord>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// 数据库同步后台任务事件出口（由宿主实现，例如 Tauri `emit`）。
#[async_trait]
pub trait DbSyncEventSink: Send + Sync {
    async fn emit_db_event(&self, event: BgTaskDbEvent);
    async fn emit_exec_event(&self, task_id: &str, result: SyncExecResultEvent);
}

/// MySQL 导出/导入后台任务事件出口。
#[async_trait]
pub trait MysqlExportEventSink: Send + Sync {
    async fn emit_export_event(&self, event: BgTaskMysqlExportEvent);
}
