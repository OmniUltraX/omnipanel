use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use omnipanel_store::DbConnectionConfig;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};

use crate::background::worker_pool::default_worker_count;
use crate::commands::database::{self, DbColumnMeta, DbIndexMeta};
use crate::commands::db_sync_diff_cache::{build_row_diff_cache_id, load_row_diff_cache_all, save_row_diff_cache};

const PAGE_SIZE: i64 = 2000;
const MAX_DIFF_DETAIL_ROWS: usize = 100;
/// 多值 INSERT 每批行数（单条 SQL 内 VALUES 个数）
const INSERT_BATCH_SIZE: usize = 500;
/// SQL 文件执行时，合并连续语句的条数（同连接多语句一次往返）
const SQL_FILE_STMT_BATCH: usize = 20;
/// 多表直连数据同步并行度上限（SQL 文件执行仍按文件顺序，保证外键安全）
fn data_sync_table_concurrency() -> usize {
    default_worker_count().max(1).min(4) as usize
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbSyncTableSpec {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_name: Option<String>,
    pub columns: Vec<DbColumnMeta>,
    #[serde(default)]
    pub indexes: Vec<DbIndexMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableRowDiffPayload {
    pub row_key: String,
    pub display_key: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_fields: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(skip)]
    pub source_row: Option<HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(skip)]
    pub target_row: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowCompareEvent {
    pub table: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_rows: Option<u32>,
    #[serde(default)]
    pub diffs: Vec<TableRowDiffPayload>,
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

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct DataSyncModes {
    #[serde(default)]
    pub insert: bool,
    #[serde(default)]
    pub merge: bool,
    #[serde(default)]
    pub delete: bool,
}

impl DataSyncModes {
    fn any_enabled(&self) -> bool {
        self.insert || self.merge || self.delete
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbSyncExecTableSpec {
    pub name: String,
    pub columns: Vec<DbColumnMeta>,
    #[serde(default)]
    pub indexes: Vec<DbIndexMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sync_modes: Option<DataSyncModes>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diff_cache_id: Option<String>,
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

fn normalize_value(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => String::new(),
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn build_row_key(
    row: &HashMap<String, serde_json::Value>,
    pk_columns: &[String],
    all_columns: &[String],
) -> String {
    let keys = if pk_columns.is_empty() {
        all_columns
    } else {
        pk_columns
    };
    keys.iter()
        .map(|col| normalize_value(&row_value(row, col)))
        .collect::<Vec<_>>()
        .join("\0")
}

fn format_row_display_key(
    row: &HashMap<String, serde_json::Value>,
    pk_columns: &[String],
    all_columns: &[String],
) -> String {
    let keys = if pk_columns.is_empty() {
        all_columns.iter().take(3).cloned().collect::<Vec<_>>()
    } else {
        pk_columns.to_vec()
    };
    keys.iter()
        .map(|col| {
            format!(
                "{col}={}",
                normalize_value(&row_value(row, col))
            )
        })
        .collect::<Vec<_>>()
        .join(", ")
}

fn clamp_row_count(count: i64) -> u32 {
    if count <= 0 {
        0
    } else if count > i64::from(u32::MAX) {
        u32::MAX
    } else {
        count as u32
    }
}

fn build_ignored_field_set(fields: &[String]) -> HashSet<String> {
    fields
        .iter()
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty() && entry.contains('.'))
        .collect()
}

fn is_ignored_compare_field(table: &str, column: &str, ignored: &HashSet<String>) -> bool {
    let key = format!("{}.{}", table.to_ascii_lowercase(), column.to_ascii_lowercase());
    if ignored.contains(&key) {
        return true;
    }
    let wildcard = format!("*.{}", column.to_ascii_lowercase());
    ignored.contains(&wildcard)
}

async fn compare_table_rows(
    app: &AppHandle,
    source: &DbConnectionConfig,
    target: &DbConnectionConfig,
    table_name: &str,
    columns: &[DbColumnMeta],
    ignored_fields: &HashSet<String>,
    cancel: Arc<AtomicBool>,
    report_rows: Arc<dyn Fn(u32, u32) + Send + Sync>,
) -> TableRowCompareEvent {
    let pk_columns: Vec<String> = columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.clone())
        .collect();
    let all_column_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

    let fetch_columns = build_fetch_columns(table_name, columns, &pk_columns, ignored_fields);
    let source_order = build_pk_order_clause(&source.db_type, &pk_columns);
    let target_order = build_pk_order_clause(&target.db_type, &pk_columns);

    let (source_count, target_count) = tokio::join!(
        database::db_count_table(
            source.clone(),
            None,
            table_name.to_string(),
            None,
        ),
        database::db_count_table(
            target.clone(),
            None,
            table_name.to_string(),
            None,
        ),
    );
    let source_total = source_count.map(|n| clamp_row_count(n as i64)).unwrap_or(0);
    let target_total = target_count.map(|n| clamp_row_count(n as i64)).unwrap_or(0);
    let row_total = source_total.saturating_add(target_total).max(1);
    let row_completed = Arc::new(AtomicU32::new(0));

    let table = table_name.to_string();
    let cancel_source = cancel.clone();
    let cancel_target = cancel.clone();
    let row_completed_source = row_completed.clone();
    let row_completed_target = row_completed.clone();
    let report_source = report_rows.clone();
    let report_target = report_rows.clone();
    let source_conn = source.clone();
    let target_conn = target.clone();

    let (source_rows, target_rows) = match tokio::try_join!(
        fetch_all_rows(
            &source_conn,
            &table,
            &fetch_columns,
            source_order.as_deref(),
            i64::from(source_total),
            &cancel_source,
            row_completed_source,
            row_total,
            report_source,
        ),
        fetch_all_rows(
            &target_conn,
            &table,
            &fetch_columns,
            target_order.as_deref(),
            i64::from(target_total),
            &cancel_target,
            row_completed_target,
            row_total,
            report_target,
        ),
    ) {
        Ok(rows) => rows,
        Err(e) => {
            if e == "cancelled" {
                return TableRowCompareEvent {
                    table: table_name.to_string(),
                    status: "error".to_string(),
                    diff_rows: None,
                    diffs: Vec::new(),
                    truncated: None,
                    diff_cache_id: None,
                    error: Some("cancelled".to_string()),
                };
            }
            return TableRowCompareEvent {
                table: table_name.to_string(),
                status: "error".to_string(),
                diff_rows: None,
                diffs: Vec::new(),
                truncated: None,
                diff_cache_id: None,
                error: Some(e),
            };
        }
    };

    if cancel.load(Ordering::Relaxed) {
        return TableRowCompareEvent {
            table: table_name.to_string(),
            status: "error".to_string(),
            diff_rows: None,
            diffs: Vec::new(),
            truncated: None,
            diff_cache_id: None,
            error: Some("cancelled".to_string()),
        };
    }

    report_rows(row_total, row_total);

    let mut source_map: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
    for row in source_rows {
        let key = build_row_key(&row, &pk_columns, &all_column_names);
        source_map.insert(key, row);
    }

    let mut target_map: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
    for row in target_rows {
        let key = build_row_key(&row, &pk_columns, &all_column_names);
        target_map.insert(key, row);
    }

    let mut all_diffs: Vec<TableRowDiffPayload> = Vec::new();

    for (key, source_row) in &source_map {
        if cancel.load(Ordering::Relaxed) {
            return TableRowCompareEvent {
                table: table_name.to_string(),
                status: "error".to_string(),
                diff_rows: None,
                diffs: Vec::new(),
                truncated: None,
                diff_cache_id: None,
                error: Some("cancelled".to_string()),
            };
        }
        match target_map.get(key) {
            None => {
                all_diffs.push(TableRowDiffPayload {
                    row_key: key.clone(),
                    display_key: format_row_display_key(source_row, &pk_columns, &all_column_names),
                    kind: "sourceOnly".to_string(),
                    changed_fields: None,
                    source_row: Some(source_row.clone()),
                    target_row: None,
                });
            }
            Some(target_row) => {
                let mut changed: Vec<String> = Vec::new();
                for col in &all_column_names {
                    if is_ignored_compare_field(table_name, col, ignored_fields) {
                        continue;
                    }
                    let sv = normalize_value(&row_value(source_row, col));
                    let tv = normalize_value(&row_value(target_row, col));
                    if sv != tv {
                        changed.push(col.clone());
                    }
                }
                if !changed.is_empty() {
                    all_diffs.push(TableRowDiffPayload {
                        row_key: key.clone(),
                        display_key: format_row_display_key(
                            source_row,
                            &pk_columns,
                            &all_column_names,
                        ),
                        kind: "changed".to_string(),
                        changed_fields: Some(changed),
                        source_row: Some(source_row.clone()),
                        target_row: Some(target_row.clone()),
                    });
                }
            }
        }
    }

    for (key, target_row) in &target_map {
        if cancel.load(Ordering::Relaxed) {
            return TableRowCompareEvent {
                table: table_name.to_string(),
                status: "error".to_string(),
                diff_rows: None,
                diffs: Vec::new(),
                truncated: None,
                diff_cache_id: None,
                error: Some("cancelled".to_string()),
            };
        }
        if source_map.contains_key(key) {
            continue;
        }
        all_diffs.push(TableRowDiffPayload {
            row_key: key.clone(),
            display_key: format_row_display_key(target_row, &pk_columns, &all_column_names),
            kind: "targetOnly".to_string(),
            changed_fields: None,
            source_row: None,
            target_row: Some(target_row.clone()),
        });
    }

    let diff_count = all_diffs.len() as u32;

    if diff_count == 0 {
        report_rows(row_total, row_total);
        let cache_id = build_row_diff_cache_id(source, target, table_name, ignored_fields);
        let diff_cache_id = match save_row_diff_cache(app, &cache_id, table_name, &[]) {
            Ok(()) => Some(cache_id),
            Err(e) => {
                eprintln!("[db_sync] 保存行差异缓存失败: {e}");
                None
            }
        };
        TableRowCompareEvent {
            table: table_name.to_string(),
            status: "match".to_string(),
            diff_rows: Some(0),
            diffs: Vec::new(),
            truncated: None,
            diff_cache_id,
            error: None,
        }
    } else {
        report_rows(row_total, row_total);
        let cache_id = build_row_diff_cache_id(source, target, table_name, ignored_fields);
        let diff_cache_id = match save_row_diff_cache(app, &cache_id, table_name, &all_diffs) {
            Ok(()) => Some(cache_id),
            Err(e) => {
                eprintln!("[db_sync] 保存行差异缓存失败: {e}");
                None
            }
        };
        let preview: Vec<TableRowDiffPayload> = all_diffs
            .iter()
            .take(MAX_DIFF_DETAIL_ROWS)
            .cloned()
            .collect();
        TableRowCompareEvent {
            table: table_name.to_string(),
            status: "diff".to_string(),
            diff_rows: Some(diff_count),
            diffs: preview,
            truncated: Some(diff_count as usize > MAX_DIFF_DETAIL_ROWS),
            diff_cache_id,
            error: None,
        }
    }
}

fn column_signature(col: &DbColumnMeta) -> String {
    format!(
        "{}|{}|{}|{}",
        col.column_type, col.is_pk, col.is_fk, col.is_auto_increment
    )
}

fn compare_table_columns(
    source: &[DbColumnMeta],
    target: &[DbColumnMeta],
) -> Vec<SchemaColumnDiffPayload> {
    let mut diffs = Vec::new();
    let target_by_name: HashMap<_, _> = target.iter().map(|c| (c.name.as_str(), c)).collect();
    let source_by_name: HashMap<_, _> = source.iter().map(|c| (c.name.as_str(), c)).collect();

    for sc in source {
        match target_by_name.get(sc.name.as_str()) {
            None => diffs.push(SchemaColumnDiffPayload {
                name: sc.name.clone(),
                kind: "added".to_string(),
                source_type: Some(sc.column_type.clone()),
                target_type: None,
            }),
            Some(tc) if column_signature(sc) != column_signature(tc) => {
                diffs.push(SchemaColumnDiffPayload {
                    name: sc.name.clone(),
                    kind: "changed".to_string(),
                    source_type: Some(sc.column_type.clone()),
                    target_type: Some(tc.column_type.clone()),
                });
            }
            _ => {}
        }
    }

    for tc in target {
        if !source_by_name.contains_key(tc.name.as_str()) {
            diffs.push(SchemaColumnDiffPayload {
                name: tc.name.clone(),
                kind: "removed".to_string(),
                source_type: None,
                target_type: Some(tc.column_type.clone()),
            });
        }
    }

    diffs.sort_by(|a, b| a.name.cmp(&b.name));
    diffs
}

fn index_signature(idx: &DbIndexMeta) -> String {
    format!("{}|{}", idx.unique, idx.columns.join("\x1f"))
}

fn format_index_detail(idx: &DbIndexMeta) -> String {
    let cols = idx.columns.join(", ");
    if idx.unique {
        format!("UNIQUE ({cols})")
    } else {
        format!("({cols})")
    }
}

fn compare_table_indexes(
    source: &[DbIndexMeta],
    target: &[DbIndexMeta],
) -> Vec<SchemaIndexDiffPayload> {
    let mut diffs = Vec::new();
    let target_by_name: HashMap<_, _> = target.iter().map(|i| (i.name.as_str(), i)).collect();
    let source_by_name: HashMap<_, _> = source.iter().map(|i| (i.name.as_str(), i)).collect();

    for si in source {
        match target_by_name.get(si.name.as_str()) {
            None => diffs.push(SchemaIndexDiffPayload {
                name: si.name.clone(),
                kind: "added".to_string(),
                source_detail: Some(format_index_detail(si)),
                target_detail: None,
            }),
            Some(ti) if index_signature(si) != index_signature(ti) => {
                diffs.push(SchemaIndexDiffPayload {
                    name: si.name.clone(),
                    kind: "changed".to_string(),
                    source_detail: Some(format_index_detail(si)),
                    target_detail: Some(format_index_detail(ti)),
                });
            }
            _ => {}
        }
    }

    for ti in target {
        if !source_by_name.contains_key(ti.name.as_str()) {
            diffs.push(SchemaIndexDiffPayload {
                name: ti.name.clone(),
                kind: "removed".to_string(),
                source_detail: None,
                target_detail: Some(format_index_detail(ti)),
            });
        }
    }

    diffs.sort_by(|a, b| a.name.cmp(&b.name));
    diffs
}

fn looks_like_missing_table(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    e.contains("doesn't exist")
        || e.contains("does not exist")
        || e.contains("unknown table")
        || e.contains("no such table")
        || e.contains("not found")
        || e.contains("不存在")
}

fn schema_compare_event_for_new_table(spec: &DbSyncTableSpec) -> SchemaCompareEvent {
    SchemaCompareEvent {
        table: spec.name.clone(),
        status: "new".to_string(),
        columns: spec
            .columns
            .iter()
            .map(|c| SchemaColumnDiffPayload {
                name: c.name.clone(),
                kind: "added".to_string(),
                source_type: Some(c.column_type.clone()),
                target_type: None,
            })
            .collect(),
        indexes: spec
            .indexes
            .iter()
            .map(|idx| SchemaIndexDiffPayload {
                name: idx.name.clone(),
                kind: "added".to_string(),
                source_detail: Some(format_index_detail(idx)),
                target_detail: None,
            })
            .collect(),
        error: None,
    }
}

async fn compare_schema_for_table(
    target: DbConnectionConfig,
    target_schema: String,
    spec: DbSyncTableSpec,
) -> SchemaCompareEvent {
    let table = spec.name.clone();
    let target_table_name = spec_target_table_name(&spec).to_string();
    match database::db_introspect_table(target, Some(target_schema), target_table_name).await {
        Ok(target_table) => {
            let columns = compare_table_columns(&spec.columns, &target_table.columns);
            let indexes = compare_table_indexes(&spec.indexes, &target_table.indexes);
            let has_diff = !columns.is_empty() || !indexes.is_empty();
            SchemaCompareEvent {
                table,
                status: if has_diff {
                    "diff".to_string()
                } else {
                    "match".to_string()
                },
                columns,
                indexes,
                error: None,
            }
        }
        Err(e) if looks_like_missing_table(&e) => schema_compare_event_for_new_table(&spec),
        Err(e) => SchemaCompareEvent {
            table,
            status: "error".to_string(),
            columns: Vec::new(),
            indexes: Vec::new(),
            error: Some(e),
        },
    }
}

async fn emit_db_event(app: &AppHandle, event: BgTaskDbEvent) {
    let _ = app.emit("bg-task-db-event", &event);
}

pub async fn run_db_data_sync_analysis(
    app: AppHandle,
    task_id: String,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
    ignored_fields: Vec<String>,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let total = tables.len().max(1) as u32;
    let source_db = source.database.clone();
    let target_db = target.database.clone();
    let ignored = Arc::new(build_ignored_field_set(&ignored_fields));

    if tables.is_empty() {
        progress(
            format!("对比分析已完成 ({total}/{total})"),
            total,
            total,
            None,
            None,
        );
        return Ok(());
    }

    let concurrency = default_worker_count().max(1) as usize;
    let completed = Arc::new(AtomicU32::new(0));

    stream::iter(tables.into_iter())
        .map(|spec| {
            let app = app.clone();
            let task_id = task_id.clone();
            let source = source.clone();
            let target = target.clone();
            let source_db = source_db.clone();
            let target_db = target_db.clone();
            let ignored = ignored.clone();
            let cancel = cancel.clone();
            let progress = progress.clone();
            let completed = completed.clone();

            async move {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }

                let table = spec.name.clone();
                let index = completed.load(Ordering::Relaxed) + 1;

                progress(
                    format!("正在统计目标表行数 ({index}/{total})：{table}"),
                    index,
                    total,
                    None,
                    None,
                );

                let mut target_for_count = target.clone();
                target_for_count.database = target_db.clone();
                let target_count = database::db_count_table(
                    target_for_count,
                    None,
                    table.clone(),
                    None,
                )
                .await
                .ok()
                .map(|n| n as i64);

                emit_db_event(
                    &app,
                    BgTaskDbEvent {
                        task_id: task_id.clone(),
                        event_type: "count".to_string(),
                        table: Some(table.clone()),
                        count: Some(TableCountEvent {
                            table: table.clone(),
                            side: "target".to_string(),
                            count: target_count,
                        }),
                        row_result: None,
                        schema_result: None,
                        exec_result: None,
                    },
                )
                .await;

                if cancel.load(Ordering::Relaxed) {
                    return;
                }

                let progress_for_rows = progress.clone();
                let table_for_rows = table.clone();
                let report_rows: Arc<dyn Fn(u32, u32) + Send + Sync> =
                    Arc::new(move |row_completed, row_total| {
                        progress_for_rows(
                            format!("正在逐行比对 ({index}/{total})：{table_for_rows}"),
                            index,
                            total,
                            Some(row_completed),
                            Some(row_total),
                        );
                    });

                progress(
                    format!("正在逐行比对 ({index}/{total})：{table}"),
                    index,
                    total,
                    Some(0),
                    None,
                );

                let mut source_for_compare = source.clone();
                source_for_compare.database = source_db.clone();
                let mut target_for_compare = target.clone();
                target_for_compare.database = target_db.clone();

                let row_result = compare_table_rows(
                    &app,
                    &source_for_compare,
                    &target_for_compare,
                    &table,
                    &spec.columns,
                    &ignored,
                    cancel.clone(),
                    report_rows,
                )
                .await;

                emit_db_event(
                    &app,
                    BgTaskDbEvent {
                        task_id: task_id.clone(),
                        event_type: "row_result".to_string(),
                        table: Some(table.clone()),
                        count: None,
                        row_result: Some(row_result),
                        schema_result: None,
                        exec_result: None,
                    },
                )
                .await;

                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                progress(
                    format!("对比分析已完成 ({done}/{total})：{table}"),
                    done,
                    total,
                    None,
                    None,
                );
            }
        })
        .buffer_unordered(concurrency)
        .collect::<Vec<_>>()
        .await;

    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    progress(
        format!("对比分析已完成 ({total}/{total})"),
        total,
        total,
        None,
        None,
    );
    Ok(())
}

pub async fn run_db_schema_sync_analysis(
    app: AppHandle,
    task_id: String,
    target: DbConnectionConfig,
    target_schema: String,
    tables: Vec<DbSyncTableSpec>,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let total = tables.len().max(1) as u32;
    if tables.is_empty() {
        progress(
            format!("对比分析已完成 ({total}/{total})"),
            total,
            total,
            None,
            None,
        );
        return Ok(());
    }

    let concurrency = default_worker_count().max(1) as usize;
    let completed = Arc::new(AtomicU32::new(0));

    stream::iter(tables.into_iter())
        .map(|spec| {
            let app = app.clone();
            let task_id = task_id.clone();
            let target = target.clone();
            let target_schema = target_schema.clone();
            let cancel = cancel.clone();
            let progress = progress.clone();
            let completed = completed.clone();

            async move {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }

                let table = spec.name.clone();
                let schema_result =
                    compare_schema_for_table(target, target_schema, spec).await;

                if cancel.load(Ordering::Relaxed) {
                    return;
                }

                emit_db_event(
                    &app,
                    BgTaskDbEvent {
                        task_id: task_id.clone(),
                        event_type: "schema_result".to_string(),
                        table: Some(table.clone()),
                        count: None,
                        row_result: None,
                        schema_result: Some(schema_result),
                        exec_result: None,
                    },
                )
                .await;

                let done = completed.fetch_add(1, Ordering::Relaxed) + 1;
                progress(
                    format!("正在对比表结构 ({done}/{total})：{table}"),
                    done,
                    total,
                    None,
                    None,
                );
            }
        })
        .buffer_unordered(concurrency)
        .collect::<Vec<_>>()
        .await;

    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    progress(
        format!("对比分析已完成 ({total}/{total})"),
        total,
        total,
        None,
        None,
    );
    Ok(())
}

fn is_mysql_engine(db_type: &str) -> bool {
    matches!(db_type.to_lowercase().as_str(), "mysql" | "mariadb")
}

fn is_postgres_engine(db_type: &str) -> bool {
    matches!(
        db_type.to_lowercase().as_str(),
        "postgresql" | "postgres"
    )
}

fn quote_ident(db_type: &str, name: &str) -> String {
    if is_mysql_engine(db_type) {
        format!("`{}`", name.replace('`', "``"))
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

fn build_fetch_columns(
    table: &str,
    columns: &[DbColumnMeta],
    pk_columns: &[String],
    ignored: &HashSet<String>,
) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for pk in pk_columns {
        if seen.insert(pk.clone()) {
            out.push(pk.clone());
        }
    }
    for col in columns {
        if !seen.insert(col.name.clone()) {
            continue;
        }
        if is_ignored_compare_field(table, &col.name, ignored) {
            continue;
        }
        out.push(col.name.clone());
    }
    out
}

fn build_pk_order_clause(db_type: &str, pk_columns: &[String]) -> Option<String> {
    if pk_columns.is_empty() {
        return None;
    }
    Some(
        pk_columns
            .iter()
            .map(|name| quote_ident(db_type, name))
            .collect::<Vec<_>>()
            .join(", "),
    )
}

async fn preview_table_column_page(
    driver: &dyn omnipanel_db::DbDriver,
    db_type: &str,
    table: &str,
    columns: &[String],
    limit: i64,
    offset: i64,
    order_by: Option<&str>,
) -> Result<Vec<HashMap<String, serde_json::Value>>, String> {
    if columns.is_empty() {
        return Err("缺少表字段信息".to_string());
    }
    let col_list = columns
        .iter()
        .map(|name| quote_ident(db_type, name))
        .collect::<Vec<_>>()
        .join(", ");
    let table_ident = quote_ident(db_type, table);
    let order_clause = order_by
        .filter(|clause| !clause.is_empty())
        .map(|clause| format!(" ORDER BY {clause}"))
        .unwrap_or_default();
    let sql = format!(
        "SELECT {col_list} FROM {table_ident}{order_clause} LIMIT {} OFFSET {}",
        limit.max(0),
        offset.max(0)
    );
    let result = driver.execute(&sql).await.map_err(|e| e.user_message())?;
    Ok(database::query_result_to_row_maps(result))
}

async fn fetch_all_rows(
    connection: &DbConnectionConfig,
    table_name: &str,
    fetch_columns: &[String],
    order_by: Option<&str>,
    total: i64,
    cancel: &AtomicBool,
    row_completed: Arc<AtomicU32>,
    row_total: u32,
    report_rows: Arc<dyn Fn(u32, u32) + Send + Sync>,
) -> Result<Vec<HashMap<String, serde_json::Value>>, String> {
    if total <= 0 {
        return Ok(Vec::new());
    }

    let driver = database::open_db_driver(connection).await?;
    let db_type = connection.db_type.clone();
    let mut rows = Vec::new();
    let mut offset = 0i64;
    while offset < total {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let page_rows = preview_table_column_page(
            driver.as_ref(),
            &db_type,
            table_name,
            fetch_columns,
            PAGE_SIZE,
            offset,
            order_by,
        )
        .await?;
        let fetched = page_rows.len() as u32;
        rows.extend(page_rows);
        let done = row_completed.fetch_add(fetched, Ordering::Relaxed) + fetched;
        if row_total > 0 {
            report_rows(done.min(row_total), row_total);
        }
        offset += PAGE_SIZE;
        if fetched < PAGE_SIZE as u32 {
            break;
        }
    }
    Ok(rows)
}

fn row_has_column(row: &HashMap<String, serde_json::Value>, col: &str) -> bool {
    if row.contains_key(col) {
        return true;
    }
    row.keys().any(|key| key.eq_ignore_ascii_case(col))
}

fn row_value(row: &HashMap<String, serde_json::Value>, col: &str) -> serde_json::Value {
    if let Some(value) = row.get(col) {
        return value.clone();
    }
    for (key, value) in row {
        if key.eq_ignore_ascii_case(col) {
            return value.clone();
        }
    }
    serde_json::Value::Null
}

fn sql_literal(value: &serde_json::Value, db_type: &str) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => {
            if is_postgres_engine(db_type) {
                if *b {
                    "TRUE".to_string()
                } else {
                    "FALSE".to_string()
                }
            } else if *b {
                "1".to_string()
            } else {
                "0".to_string()
            }
        }
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::String(s) => format!(
            "'{}'",
            s.replace('\\', "\\\\").replace('\'', "''")
        ),
        other => format!(
            "'{}'",
            other.to_string().replace('\\', "\\\\").replace('\'', "''")
        ),
    }
}

fn normalize_create_table_ddl(ddl: &str, db_type: &str) -> String {
    let mut sql = ddl.trim().trim_end_matches(';').to_string();
    let upper = sql.to_uppercase();
    if !upper.contains("IF NOT EXISTS") {
        sql = sql.replacen("CREATE TABLE", "CREATE TABLE IF NOT EXISTS", 1);
    }
    if is_mysql_engine(db_type) {
        if let Some(marker) = sql.find("IF NOT EXISTS") {
            let head = &sql[..marker + "IF NOT EXISTS".len()];
            let mut tail = sql[marker + "IF NOT EXISTS".len()..].trim_start();
            if tail.starts_with('`') {
                if let Some(dot) = tail.find("`.`") {
                    tail = tail[dot + 3..].trim_start();
                    sql = format!("{head} {tail}");
                }
            }
        }
    }
    sql
}

fn rewrite_create_table_ddl_name(
    ddl: &str,
    source_table: &str,
    target_table: &str,
    db_type: &str,
) -> String {
    if source_table == target_table {
        return ddl.to_string();
    }
    let source_quoted = quote_ident(db_type, source_table);
    let target_quoted = quote_ident(db_type, target_table);
    if ddl.contains(&source_quoted) {
        return ddl.replacen(&source_quoted, &target_quoted, 1);
    }
    ddl.to_string()
}

async fn target_table_exists(
    target: &DbConnectionConfig,
    target_db: &str,
    table: &str,
) -> bool {
    database::db_list_tables(target.clone(), Some(target_db.to_string()))
        .await
        .ok()
        .is_some_and(|names| names.iter().any(|name| name == table))
}

fn spec_target_table_name(spec: &DbSyncTableSpec) -> &str {
    spec.target_name.as_deref().unwrap_or(spec.name.as_str())
}

async fn ensure_table_from_source(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    source_table: &str,
    target_table: &str,
) -> Result<(), String> {
    if target_table_exists(target, target_db, target_table).await {
        return Ok(());
    }
    let ddl = database::db_table_ddl(
        source.clone(),
        Some(source_db.to_string()),
        source_table.to_string(),
    )
    .await?;
    let sql = normalize_create_table_ddl(&ddl, &target.db_type);
    let sql = rewrite_create_table_ddl_name(&sql, source_table, target_table, &target.db_type);
    database::db_run_sql(target.clone(), Some(target_db.to_string()), sql).await?;
    Ok(())
}


fn resolve_data_sync_modes(spec: &DbSyncExecTableSpec) -> DataSyncModes {
    if let Some(modes) = spec.sync_modes.clone() {
        return modes;
    }
    migrate_legacy_data_sync_strategy(spec.strategy.as_deref())
}

fn migrate_legacy_data_sync_strategy(strategy: Option<&str>) -> DataSyncModes {
    match normalize_data_sync_strategy(strategy) {
        "target" | "mergeTarget" | "conflictTarget" => DataSyncModes {
            insert: false,
            merge: false,
            delete: false,
        },
        "conflictSource" => DataSyncModes {
            insert: false,
            merge: true,
            delete: false,
        },
        "source" => DataSyncModes {
            insert: true,
            merge: true,
            delete: true,
        },
        _ => DataSyncModes {
            insert: true,
            merge: true,
            delete: false,
        },
    }
}

fn rows_have_conflict(
    source_row: &HashMap<String, serde_json::Value>,
    target_row: &HashMap<String, serde_json::Value>,
    columns: &[DbColumnMeta],
    pk_columns: &[String],
) -> bool {
    for col in columns {
        if pk_columns
            .iter()
            .any(|pk| pk.eq_ignore_ascii_case(&col.name))
        {
            continue;
        }
        if normalize_value(&row_value(source_row, &col.name))
            != normalize_value(&row_value(target_row, &col.name))
        {
            return true;
        }
    }
    false
}

fn build_delete_statement(
    db_type: &str,
    table: &str,
    columns: &[DbColumnMeta],
    pk_columns: &[String],
    row: &HashMap<String, serde_json::Value>,
) -> Result<Option<String>, String> {
    if pk_columns.is_empty() {
        return Ok(None);
    }
    let table_ident = quote_ident(db_type, table);
    let mut where_parts: Vec<String> = Vec::new();
    for pk in pk_columns {
        let col = columns
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case(pk))
            .ok_or_else(|| format!("无法生成 DELETE：缺少主键列 {pk}"))?;
        where_parts.push(format!(
            "{} = {}",
            quote_ident(db_type, &col.name),
            sql_literal(&row_value(row, &col.name), db_type)
        ));
    }
    Ok(Some(format!(
        "DELETE FROM {table_ident} WHERE {}",
        where_parts.join(" AND ")
    )))
}

struct SyncWriteStats {
    inserted: u64,
    updated: u64,
    deleted: u64,
}

impl SyncWriteStats {
    fn total(&self) -> u64 {
        self.inserted
            .saturating_add(self.updated)
            .saturating_add(self.deleted)
    }
}

async fn fetch_table_row_keys(
    connection: &DbConnectionConfig,
    table_name: &str,
    columns: &[DbColumnMeta],
    cancel: &AtomicBool,
) -> Result<HashSet<String>, String> {
    let pk_columns: Vec<String> = columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.clone())
        .collect();
    let all_column_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
    let fetch_columns = build_fetch_columns(table_name, columns, &pk_columns, &HashSet::new());
    let order_by = build_pk_order_clause(&connection.db_type, &pk_columns);

    let total = database::db_count_table(
        connection.clone(),
        None,
        table_name.to_string(),
        None,
    )
    .await? as i64;
    if total <= 0 {
        return Ok(HashSet::new());
    }

    let driver = database::open_db_driver(connection).await?;
    let db_type = connection.db_type.clone();
    let mut keys = HashSet::new();
    let mut offset = 0i64;
    while offset < total {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let page_rows = preview_table_column_page(
            driver.as_ref(),
            &db_type,
            table_name,
            &fetch_columns,
            PAGE_SIZE,
            offset,
            order_by.as_deref(),
        )
        .await?;
        if page_rows.is_empty() {
            break;
        }
        let batch_len = page_rows.len();
        for row in page_rows {
            keys.insert(build_row_key(&row, &pk_columns, &all_column_names));
        }
        offset += PAGE_SIZE;
        if batch_len < PAGE_SIZE as usize {
            break;
        }
    }
    Ok(keys)
}

async fn fetch_table_rows_map(
    connection: &DbConnectionConfig,
    table_name: &str,
    columns: &[DbColumnMeta],
    cancel: &AtomicBool,
) -> Result<HashMap<String, HashMap<String, serde_json::Value>>, String> {
    let pk_columns: Vec<String> = columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.clone())
        .collect();
    let all_column_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
    let order_by = build_pk_order_clause(&connection.db_type, &pk_columns);

    let total = database::db_count_table(
        connection.clone(),
        None,
        table_name.to_string(),
        None,
    )
    .await? as i64;
    if total <= 0 {
        return Ok(HashMap::new());
    }

    let driver = database::open_db_driver(connection).await?;
    let db_type = connection.db_type.clone();
    let mut rows_map: HashMap<String, HashMap<String, serde_json::Value>> = HashMap::new();
    let mut offset = 0i64;
    while offset < total {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let page_rows = preview_table_column_page(
            driver.as_ref(),
            &db_type,
            table_name,
            &all_column_names,
            PAGE_SIZE,
            offset,
            order_by.as_deref(),
        )
        .await?;
        if page_rows.is_empty() {
            break;
        }
        let batch_len = page_rows.len();
        for row in page_rows {
            let key = build_row_key(&row, &pk_columns, &all_column_names);
            rows_map.insert(key, row);
        }
        offset += PAGE_SIZE;
        if batch_len < PAGE_SIZE as usize {
            break;
        }
    }
    Ok(rows_map)
}

async fn copy_table_data_with_modes(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    spec: &DbSyncExecTableSpec,
    cancel: &AtomicBool,
    report_rows: Arc<dyn Fn(u32, u32) + Send + Sync>,
    modes: DataSyncModes,
) -> Result<SyncWriteStats, String> {
    let table = spec.name.as_str();
    let column_names: Vec<String> = spec.columns.iter().map(|c| c.name.clone()).collect();
    if spec.columns.is_empty() {
        return Err("缺少表字段信息".to_string());
    }
    if !modes.any_enabled() {
        report_rows(0, 1);
        return Ok(SyncWriteStats {
            inserted: 0,
            updated: 0,
            deleted: 0,
        });
    }

    let pk_columns: Vec<String> = spec
        .columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.clone())
        .collect();

    let mut source_conn = source.clone();
    source_conn.database = source_db.to_string();
    let mut target_conn = target.clone();
    target_conn.database = target_db.to_string();

    let source_order = build_pk_order_clause(&source_conn.db_type, &pk_columns);
    let target_order = build_pk_order_clause(&target_conn.db_type, &pk_columns);

    let needs_target_keys = modes.insert || modes.merge;
    let target_keys = if needs_target_keys {
        Some(
            fetch_table_row_keys(&target_conn, table, &spec.columns, cancel).await?,
        )
    } else {
        None
    };

    let target_rows = if modes.merge {
        Some(
            fetch_table_rows_map(&target_conn, table, &spec.columns, cancel).await?,
        )
    } else {
        None
    };

    let source_keys = if modes.delete {
        Some(
            fetch_table_row_keys(&source_conn, table, &spec.columns, cancel).await?,
        )
    } else {
        None
    };

    let source_total = database::db_count_table(source_conn.clone(), None, table.to_string(), None)
        .await
        .unwrap_or(0.0)
        .max(0.0) as u32;
    let target_total = database::db_count_table(target_conn.clone(), None, table.to_string(), None)
        .await
        .unwrap_or(0.0)
        .max(0.0) as u32;

    let mut stats = SyncWriteStats {
        inserted: 0,
        updated: 0,
        deleted: 0,
    };

    if modes.insert || modes.merge {
        let mut offset = 0i64;
        while offset < i64::from(source_total.max(1)) || (source_total == 0 && offset == 0) {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            let page = database::db_preview_table(
                source_conn.clone(),
                table.to_string(),
                PAGE_SIZE as u32,
                offset as u32,
                source_order.clone(),
                None,
            )
            .await?;
            if page.rows.is_empty() {
                break;
            }
            let batch_len = page.rows.len();
            let mut rows_to_insert: Vec<HashMap<String, serde_json::Value>> = Vec::new();
            for row in page.rows {
                let key = build_row_key(&row, &pk_columns, &column_names);
                let in_target = target_keys
                    .as_ref()
                    .map(|keys| keys.contains(&key))
                    .unwrap_or(false);
                if modes.insert && !in_target {
                    rows_to_insert.push(row);
                    continue;
                }
                if modes.merge && in_target {
                    if let Some(target_row) = target_rows.as_ref().and_then(|map| map.get(&key)) {
                        if rows_have_conflict(&row, target_row, &spec.columns, &pk_columns) {
                            if let Some(sql) = build_update_statement(
                                &target.db_type,
                                table,
                                &spec.columns,
                                &pk_columns,
                                &row,
                            )? {
                                let affected =
                                    execute_insert_statements(&target_conn, vec![sql], cancel, table)
                                        .await?;
                                if affected > 0 {
                                    stats.updated += 1;
                                }
                            }
                        }
                    }
                }
            }
            for chunk in rows_to_insert.chunks(INSERT_BATCH_SIZE) {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".to_string());
                }
                let statements =
                    build_insert_statement(&target.db_type, table, &spec.columns, chunk)?;
                if statements.is_empty() {
                    continue;
                }
                execute_insert_statements(&target_conn, statements, cancel, table).await?;
                stats.inserted = stats
                    .inserted
                    .saturating_add(chunk.len() as u64);
            }
            report_rows(stats.total() as u32, source_total.max(1));
            offset += PAGE_SIZE;
            if batch_len < PAGE_SIZE as usize {
                break;
            }
        }
    }

    if modes.delete {
        if let Some(source_key_set) = source_keys.as_ref() {
            let mut offset = 0i64;
            while offset < i64::from(target_total.max(1)) || (target_total == 0 && offset == 0) {
                if cancel.load(Ordering::Relaxed) {
                    return Err("cancelled".to_string());
                }
                let page = database::db_preview_table(
                    target_conn.clone(),
                    table.to_string(),
                    PAGE_SIZE as u32,
                    offset as u32,
                    target_order.clone(),
                    None,
                )
                .await?;
                if page.rows.is_empty() {
                    break;
                }
                let batch_len = page.rows.len();
                for row in page.rows {
                    let key = build_row_key(&row, &pk_columns, &column_names);
                    if source_key_set.contains(&key) {
                        continue;
                    }
                    if let Some(sql) = build_delete_statement(
                        &target.db_type,
                        table,
                        &spec.columns,
                        &pk_columns,
                        &row,
                    )? {
                        let affected =
                            execute_insert_statements(&target_conn, vec![sql], cancel, table)
                                .await?;
                        if affected > 0 {
                            stats.deleted += 1;
                        }
                    }
                }
                report_rows(stats.total() as u32, target_total.max(1));
                offset += PAGE_SIZE;
                if batch_len < PAGE_SIZE as usize {
                    break;
                }
            }
        }
    }

    report_rows(stats.total() as u32, stats.total().max(1) as u32);
    Ok(stats)
}

fn format_sql_statement(sql: &str) -> String {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.ends_with(';') {
        trimmed.to_string()
    } else {
        format!("{trimmed};")
    }
}

fn format_sync_modes_label(modes: &DataSyncModes) -> String {
    if !modes.any_enabled() {
        return "未启用".to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    if modes.insert {
        parts.push("新增");
    }
    if modes.merge {
        parts.push("合并");
    }
    if modes.delete {
        parts.push("删除");
    }
    parts.join("+")
}

fn parse_table_marker(line: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with("-- ── ") || !trimmed.ends_with(" ──") {
        return None;
    }
    let inner = trimmed
        .trim_start_matches("-- ── ")
        .trim_end_matches(" ──")
        .trim();
    if inner.is_empty() {
        None
    } else {
        Some(inner.to_string())
    }
}

fn parse_sql_file_statements(content: &str) -> Vec<(Option<String>, String)> {
    let mut current_table: Option<String> = None;
    let mut statements: Vec<(Option<String>, String)> = Vec::new();
    let mut buffer = String::new();

    for line in content.lines() {
        if let Some(table) = parse_table_marker(line) {
            current_table = Some(table);
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("--") {
            continue;
        }
        buffer.push_str(line);
        buffer.push('\n');
        if trimmed.ends_with(';') {
            let stmt = buffer.trim().trim_end_matches(';').trim();
            if !stmt.is_empty() {
                statements.push((current_table.clone(), stmt.to_string()));
            }
            buffer.clear();
        }
    }

    let tail = buffer.trim().trim_end_matches(';').trim();
    if !tail.is_empty() {
        statements.push((current_table, tail.to_string()));
    }
    statements
}

async fn generate_create_table_statement(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    source_table: &str,
    target_table: &str,
) -> Result<Option<String>, String> {
    if target_table_exists(target, target_db, target_table).await {
        return Ok(None);
    }
    let ddl = database::db_table_ddl(
        source.clone(),
        Some(source_db.to_string()),
        source_table.to_string(),
    )
    .await?;
    let sql = normalize_create_table_ddl(&ddl, &target.db_type);
    let sql = rewrite_create_table_ddl_name(&sql, source_table, target_table, &target.db_type);
    Ok(Some(format_sql_statement(&sql)))
}

fn collect_table_sync_sql_from_diffs(
    db_type: &str,
    table: &str,
    columns: &[DbColumnMeta],
    pk_columns: &[String],
    diffs: &[TableRowDiffPayload],
    modes: DataSyncModes,
) -> Result<(Vec<String>, SyncWriteStats), String> {
    let mut statements: Vec<String> = Vec::new();
    let mut stats = SyncWriteStats {
        inserted: 0,
        updated: 0,
        deleted: 0,
    };

    if !modes.any_enabled() {
        return Ok((vec!["-- 未启用任何同步方式，无 DML".to_string()], stats));
    }

    for diff in diffs {
        match diff.kind.as_str() {
            "sourceOnly" if modes.insert => {
                if let Some(row) = &diff.source_row {
                    for sql in build_insert_statement(db_type, table, columns, std::slice::from_ref(row))? {
                        statements.push(format_sql_statement(&sql));
                    }
                    stats.inserted += 1;
                }
            }
            "changed" if modes.merge => {
                if let Some(row) = &diff.source_row {
                    if let Some(sql) =
                        build_update_statement(db_type, table, columns, pk_columns, row)?
                    {
                        statements.push(format_sql_statement(&sql));
                        stats.updated += 1;
                    }
                }
            }
            "targetOnly" if modes.delete => {
                if let Some(row) = &diff.target_row {
                    if let Some(sql) =
                        build_delete_statement(db_type, table, columns, pk_columns, row)?
                    {
                        statements.push(format_sql_statement(&sql));
                        stats.deleted += 1;
                    }
                }
            }
            _ => {}
        }
    }

    Ok((statements, stats))
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbDataSyncSqlGenerateResult {
    pub file_path: String,
    pub statement_count: u32,
}

fn sync_sql_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use std::fs;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无法定位缓存目录: {e}"))?
        .join("data-sync-sql");
    fs::create_dir_all(&dir).map_err(|e| format!("创建 SQL 缓存目录失败: {e}"))?;
    Ok(dir)
}

fn write_sync_sql_file(app: &AppHandle, sql: &str) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    let dir = sync_sql_dir(app)?;
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path: PathBuf = dir.join(format!("sync-{millis}.sql"));
    fs::write(&path, sql).map_err(|e| format!("写入 SQL 文件失败: {e}"))?;
    Ok(path.to_string_lossy().to_string())
}

pub fn read_sync_sql_file(app: &AppHandle, sql_file_path: &str) -> Result<String, String> {
    use std::fs;
    use std::path::PathBuf;

    let dir = sync_sql_dir(app)?;
    let dir_canonical = dir.canonicalize().unwrap_or(dir);
    let requested = PathBuf::from(sql_file_path);
    let resolved = requested
        .canonicalize()
        .map_err(|e| format!("SQL 文件不存在或无法访问: {e}"))?;
    if !resolved.starts_with(&dir_canonical) {
        return Err("不允许读取该 SQL 文件路径".to_string());
    }
    fs::read_to_string(resolved).map_err(|e| format!("读取 SQL 文件失败: {e}"))
}

pub async fn generate_data_sync_sql_script(
    app: &AppHandle,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
) -> Result<DbDataSyncSqlGenerateResult, String> {
    let source_db = source.database.clone();
    let target_db = target.database.clone();
    let mut lines: Vec<String> = Vec::new();
    let mut statement_count = 0u32;

    lines.push("-- 数据同步 SQL 脚本".to_string());
    lines.push(format!("-- 源库: {source_db}"));
    lines.push(format!("-- 目标库: {target_db}"));
    lines.push(format!("-- 表数量: {}", tables.len()));
    lines.push(String::new());

    for spec in &tables {
        let table = spec.name.clone();
        lines.push(format!("-- ── {table} ──"));

        let mut exec_spec = spec.clone();
        exec_spec.columns = resolve_exec_table_columns(&source, &source_db, spec).await?;

        if let Some(create_sql) = generate_create_table_statement(
            &source,
            &source_db,
            &target,
            &target_db,
            &exec_spec.name,
            &exec_spec.name,
        )
        .await?
        {
            lines.push(create_sql);
            statement_count += 1;
        }

        let modes = resolve_data_sync_modes(&exec_spec);
        lines.push(format!("-- 同步方式: {}", format_sync_modes_label(&modes)));

        let pk_columns: Vec<String> = exec_spec
            .columns
            .iter()
            .filter(|c| c.is_pk)
            .map(|c| c.name.clone())
            .collect();

        let (mut stmts, stats) = if let Some(cache_id) = exec_spec.diff_cache_id.as_deref() {
            let diffs = load_row_diff_cache_all(app, cache_id).map_err(|err| {
                format!("无法读取表 {table} 的行差异缓存，请先在目标侧完成「分析」后再试：{err}")
            })?;
            collect_table_sync_sql_from_diffs(
                &target.db_type,
                &exec_spec.name,
                &exec_spec.columns,
                &pk_columns,
                &diffs,
                modes.clone(),
            )?
        } else {
            return Err(format!(
                "表 {table} 尚未完成行级分析，请先在目标侧点击「分析」后再生成 SQL"
            ));
        };
        statement_count = statement_count.saturating_add(stmts.len() as u32);
        lines.append(&mut stmts);
        lines.push(format!(
            "-- 预计: 新增 {} / 合并 {} / 删除 {} 行",
            stats.inserted, stats.updated, stats.deleted
        ));
        lines.push(String::new());
    }

    let sql = format!("{}\n", lines.join("\n").trim_end());
    let file_path = write_sync_sql_file(app, &sql)?;
    Ok(DbDataSyncSqlGenerateResult {
        file_path,
        statement_count,
    })
}

pub async fn run_db_data_sync_sql_file_execute(
    app: AppHandle,
    task_id: String,
    target: DbConnectionConfig,
    target_db: String,
    sql_file_path: String,
    table_names: Vec<String>,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    use std::fs;

    let content = fs::read_to_string(&sql_file_path)
        .map_err(|e| format!("读取 SQL 文件失败 ({sql_file_path}): {e}"))?;
    let statements = parse_sql_file_statements(&content);
    if statements.is_empty() {
        return Err("SQL 文件中没有可执行的语句".to_string());
    }

    let total_stmts = statements.len() as u32;
    let display_tables = if table_names.is_empty() {
        "全部表".to_string()
    } else {
        table_names.join(", ")
    };
    progress(
        format!("开始执行 SQL 文件（{display_tables}，共 {total_stmts} 条语句）"),
        0,
        total_stmts,
        Some(0),
        None,
    );

    let mut target_conn = target.clone();
    target_conn.database = target_db.clone();

    // 复用同一连接，避免每条语句重建连接池；按文件顺序批量执行，保证外键依赖安全
    let driver = database::open_db_driver(&target_conn).await?;

    let mut table_rows: HashMap<String, u32> = HashMap::new();
    for name in &table_names {
        table_rows.insert(name.clone(), 0);
    }

    let mut current = 0u32;
    let mut rows_written_total = 0u32;
    let mut batch_sql: Vec<String> = Vec::with_capacity(SQL_FILE_STMT_BATCH);
    let mut batch_table: Option<String> = None;
    let mut last_progress_table: Option<String> = None;

    for (marker_table, sql) in statements {
        if cancel.load(Ordering::Relaxed) {
            return Err("任务已取消".to_string());
        }

        // 表切换时先刷掉上一批，便于按表统计进度
        if marker_table.is_some() && marker_table != batch_table && !batch_sql.is_empty() {
            flush_sql_file_batch(
                driver.as_ref(),
                &mut batch_sql,
                &batch_table,
                &mut table_rows,
                &mut current,
                &mut rows_written_total,
                &mut last_progress_table,
                total_stmts,
                &progress,
            )
            .await?;
        }
        if let Some(name) = marker_table.clone() {
            batch_table = Some(name);
        }

        batch_sql.push(sql);
        if batch_sql.len() >= SQL_FILE_STMT_BATCH {
            flush_sql_file_batch(
                driver.as_ref(),
                &mut batch_sql,
                &batch_table,
                &mut table_rows,
                &mut current,
                &mut rows_written_total,
                &mut last_progress_table,
                total_stmts,
                &progress,
            )
            .await?;
        }
    }

    flush_sql_file_batch(
        driver.as_ref(),
        &mut batch_sql,
        &batch_table,
        &mut table_rows,
        &mut current,
        &mut rows_written_total,
        &mut last_progress_table,
        total_stmts,
        &progress,
    )
    .await?;

    for name in &table_names {
        let rows = table_rows.get(name).copied().unwrap_or(0);
        emit_exec_event(
            &app,
            &task_id,
            SyncExecResultEvent {
                table: name.clone(),
                status: "success".to_string(),
                rows_written: Some(u64::from(rows)),
                message: Some(format!("已从 SQL 文件执行，影响 {rows} 行")),
                error: None,
            },
        )
        .await;
    }

    progress(
        format!("SQL 文件执行完成，共影响 {rows_written_total} 行"),
        total_stmts,
        total_stmts,
        Some(rows_written_total),
        None,
    );
    Ok(())
}

async fn flush_sql_file_batch(
    driver: &dyn omnipanel_db::DbDriver,
    batch_sql: &mut Vec<String>,
    batch_table: &Option<String>,
    table_rows: &mut HashMap<String, u32>,
    current: &mut u32,
    rows_written_total: &mut u32,
    last_progress_table: &mut Option<String>,
    total_stmts: u32,
    progress: &Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    if batch_sql.is_empty() {
        return Ok(());
    }
    let batch_len = batch_sql.len() as u32;
    let combined = batch_sql
        .iter()
        .map(|s| {
            let t = s.trim().trim_end_matches(';').trim();
            format!("{t};")
        })
        .collect::<Vec<_>>()
        .join("\n");
    batch_sql.clear();

    let result = driver.execute(&combined).await.map_err(|e| {
        let msg = e.user_message();
        if let Some(table) = batch_table {
            format_sync_foreign_key_error(table, &msg)
        } else {
            msg
        }
    })?;

    let affected = result.rows_affected.min(u64::from(u32::MAX)) as u32;
    *rows_written_total = rows_written_total.saturating_add(affected);
    *current = current.saturating_add(batch_len);

    if let Some(table) = batch_table {
        let entry = table_rows.entry(table.clone()).or_insert(0);
        *entry = entry.saturating_add(affected);
        *last_progress_table = Some(table.clone());
    }

    let progress_table = batch_table
        .clone()
        .or_else(|| last_progress_table.clone())
        .unwrap_or_else(|| "SQL".to_string());
    progress(
        format!("正在执行 ({current}/{total_stmts})：{progress_table}"),
        (*current).min(total_stmts),
        total_stmts,
        Some(*rows_written_total),
        None,
    );
    Ok(())
}


fn format_sync_modes_message(modes: &DataSyncModes, stats: &SyncWriteStats) -> String {
    if !modes.any_enabled() {
        return "未启用任何同步方式，已跳过".to_string();
    }
    let mut parts: Vec<&str> = Vec::new();
    if modes.insert {
        parts.push("新增");
    }
    if modes.merge {
        parts.push("合并");
    }
    if modes.delete {
        parts.push("删除");
    }
    format!(
        "已执行 {}（新增 {} / 合并 {} / 删除 {} 行）",
        parts.join("+"),
        stats.inserted,
        stats.updated,
        stats.deleted
    )
}

fn normalize_data_sync_strategy(strategy: Option<&str>) -> &'static str {
    match strategy.unwrap_or("source") {
        "target" => "target",
        "mergeTarget" | "merge_target" => "mergeTarget",
        "conflictTarget" | "conflict_target" => "conflictTarget",
        "mergeSource" | "merge_source" | "merge" | "append" => "mergeSource",
        "conflictSource" | "conflict_source" => "conflictSource",
        "source" | "rewrite" | "update" => "source",
        _ => "source",
    }
}

fn should_include_insert_column(row: &HashMap<String, serde_json::Value>, col: &DbColumnMeta) -> bool {
    if !row_has_column(row, &col.name) {
        return false;
    }
    let value = row_value(row, &col.name);
    if value.is_null() {
        // 预览未取到值 / 源端为 NULL：省略该列，让目标库 DEFAULT 生效（如 create_time）
        return false;
    }
    if !col.nullable {
        if let serde_json::Value::String(text) = &value {
            if text.is_empty() {
                return false;
            }
        }
    }
    true
}

fn is_temporal_column_type(column_type: &str) -> bool {
    let t = column_type.to_ascii_lowercase();
    t.contains("datetime") || t.contains("timestamp") || t == "date" || t == "time"
}

fn temporal_default_expr(db_type: &str) -> String {
    if is_postgres_engine(db_type) {
        "CURRENT_TIMESTAMP".to_string()
    } else {
        "CURRENT_TIMESTAMP".to_string()
    }
}

fn insert_field_expr(
    row: &HashMap<String, serde_json::Value>,
    col: &DbColumnMeta,
    db_type: &str,
) -> Option<String> {
    if should_include_insert_column(row, col) {
        return Some(sql_literal(&row_value(row, &col.name), db_type));
    }
    if !col.nullable && is_temporal_column_type(&col.column_type) {
        return Some(temporal_default_expr(db_type));
    }
    None
}

/// 按「参与插入的列集合」分组，生成多值 `INSERT ... VALUES (...), (...)`，大幅减少往返。
fn build_insert_statement(
    db_type: &str,
    table: &str,
    columns: &[DbColumnMeta],
    rows: &[HashMap<String, serde_json::Value>],
) -> Result<Vec<String>, String> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    let table_ident = quote_ident(db_type, table);

    // 列签名 → 该组行
    let mut groups: Vec<(Vec<usize>, Vec<&HashMap<String, serde_json::Value>>)> = Vec::new();
    for row in rows {
        let col_indexes: Vec<usize> = columns
            .iter()
            .enumerate()
            .filter_map(|(idx, col)| insert_field_expr(row, col, db_type).map(|_| idx))
            .collect();
        if col_indexes.is_empty() {
            continue;
        }
        if let Some(group) = groups.iter_mut().find(|(sig, _)| *sig == col_indexes) {
            group.1.push(row);
        } else {
            groups.push((col_indexes, vec![row]));
        }
    }

    let mut statements = Vec::new();
    for (col_indexes, group_rows) in groups {
        let col_names: Vec<String> = col_indexes
            .iter()
            .map(|&idx| quote_ident(db_type, &columns[idx].name))
            .collect();
        let cols_sql = col_names.join(", ");
        for chunk in group_rows.chunks(INSERT_BATCH_SIZE) {
            let mut values_parts = Vec::with_capacity(chunk.len());
            for row in chunk {
                let exprs: Vec<String> = col_indexes
                    .iter()
                    .filter_map(|&idx| insert_field_expr(row, &columns[idx], db_type))
                    .collect();
                if exprs.len() != col_indexes.len() {
                    // 同组签名下应一致；兜底跳过异常行
                    continue;
                }
                values_parts.push(format!("({})", exprs.join(", ")));
            }
            if values_parts.is_empty() {
                continue;
            }
            statements.push(format!(
                "INSERT INTO {table_ident} ({cols_sql}) VALUES {}",
                values_parts.join(", ")
            ));
        }
    }
    Ok(statements)
}

fn build_update_statement(
    db_type: &str,
    table: &str,
    columns: &[DbColumnMeta],
    pk_columns: &[String],
    row: &HashMap<String, serde_json::Value>,
) -> Result<Option<String>, String> {
    if pk_columns.is_empty() {
        return Ok(None);
    }
    let table_ident = quote_ident(db_type, table);
    let mut set_parts: Vec<String> = Vec::new();
    for col in columns {
        if pk_columns
            .iter()
            .any(|pk| pk.eq_ignore_ascii_case(&col.name))
        {
            continue;
        }
        if let Some(expr) = insert_field_expr(row, col, db_type) {
            set_parts.push(format!(
                "{} = {}",
                quote_ident(db_type, &col.name),
                expr
            ));
        }
    }
    if set_parts.is_empty() {
        return Ok(None);
    }
    let mut where_parts: Vec<String> = Vec::new();
    for pk in pk_columns {
        let col = columns
            .iter()
            .find(|c| c.name.eq_ignore_ascii_case(pk))
            .ok_or_else(|| format!("无法生成 UPDATE：缺少主键列 {pk}"))?;
        where_parts.push(format!(
            "{} = {}",
            quote_ident(db_type, &col.name),
            sql_literal(&row_value(row, &col.name), db_type)
        ));
    }
    Ok(Some(format!(
        "UPDATE {table_ident} SET {} WHERE {}",
        set_parts.join(", "),
        where_parts.join(" AND ")
    )))
}

struct ForeignKeyViolation {
    child_table: Option<String>,
    child_column: Option<String>,
    parent_table: String,
    parent_column: Option<String>,
    is_parent_row_violation: bool,
}

fn parse_backtick_ident(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    if !input.starts_with('`') {
        return None;
    }
    let inner = &input[1..];
    let end = inner.find('`')?;
    Some((&inner[..end], &inner[end + 1..]))
}

fn parse_ident_in_parens(input: &str) -> Option<String> {
    let input = input.trim_start();
    if !input.starts_with('(') {
        return None;
    }
    let inner = &input[1..];
    let end = inner.find(')')?;
    let token = inner[..end].trim();
    if let Some((name, _)) = parse_backtick_ident(token) {
        return Some(name.to_string());
    }
    if let Some((name, _)) = parse_double_quote_ident(token) {
        return Some(name.to_string());
    }
    let cleaned = token.trim_matches('`').trim_matches('"');
    if cleaned.is_empty() {
        None
    } else {
        Some(cleaned.to_string())
    }
}

fn parse_double_quote_ident(input: &str) -> Option<(&str, &str)> {
    let input = input.trim_start();
    if !input.starts_with('"') {
        return None;
    }
    let inner = &input[1..];
    let end = inner.find('"')?;
    Some((&inner[..end], &inner[end + 1..]))
}

fn parse_child_table_from_fails_clause(error: &str) -> Option<String> {
    let marker = "foreign key constraint fails";
    let idx = error.to_ascii_lowercase().find(marker)?;
    let tail = &error[idx + marker.len()..];
    let paren_start = tail.find('(')?;
    let inner = tail[paren_start + 1..].trim_start();
    if let Some((first, rest)) = parse_backtick_ident(inner) {
        let rest = rest.trim_start();
        if rest.starts_with('.') {
            let after_dot = rest[1..].trim_start();
            if let Some((table, _)) = parse_backtick_ident(after_dot) {
                return Some(table.to_string());
            }
        }
        return Some(first.to_string());
    }
    None
}

fn parse_mysql_foreign_key_violation(error: &str) -> Option<ForeignKeyViolation> {
    let upper = error.to_ascii_uppercase();
    if !upper.contains("FOREIGN KEY") {
        return None;
    }
    let fk_idx = upper.rfind("FOREIGN KEY (")?;
    let segment = &error[fk_idx..];
    let refs_idx = segment.to_ascii_uppercase().find("REFERENCES")?;
    let fk_clause = segment[..refs_idx].trim_end();
    let after_refs = segment[refs_idx + "REFERENCES".len()..].trim_start();
    let (parent_table, rest) = parse_backtick_ident(after_refs)?;
    let child_column = parse_ident_in_parens(
        fk_clause
            .strip_prefix("FOREIGN KEY")
            .or_else(|| fk_clause.strip_prefix("foreign key"))
            .unwrap_or(fk_clause)
            .trim_start(),
    );
    Some(ForeignKeyViolation {
        child_table: parse_child_table_from_fails_clause(error),
        child_column,
        parent_table: parent_table.to_string(),
        parent_column: parse_ident_in_parens(rest.trim_start()),
        is_parent_row_violation: error.contains("Cannot delete or update a parent row"),
    })
}

fn parse_postgres_foreign_key_violation(error: &str) -> Option<ForeignKeyViolation> {
    let lower = error.to_ascii_lowercase();
    if !lower.contains("violates foreign key constraint") && !lower.contains("is not present in table")
    {
        return None;
    }
    let marker = "is not present in table";
    let idx = lower.find(marker)?;
    let tail = &error[idx + marker.len()..];
    let tail = tail.trim_start();
    let parent_table = if let Some((name, _)) = parse_double_quote_ident(tail) {
        name.to_string()
    } else if let Some((name, _)) = parse_backtick_ident(tail) {
        name.to_string()
    } else {
        return None;
    };
    let child_column = error
        .find("Key (")
        .and_then(|key_idx| {
            let part = &error[key_idx + 4..];
            part.find(')').map(|end| part[..end].trim().to_string())
        })
        .filter(|name| !name.is_empty());
    Some(ForeignKeyViolation {
        child_table: None,
        child_column,
        parent_table,
        parent_column: None,
        is_parent_row_violation: false,
    })
}

fn parse_foreign_key_violation(error: &str) -> Option<ForeignKeyViolation> {
    parse_mysql_foreign_key_violation(error).or_else(|| parse_postgres_foreign_key_violation(error))
}

fn format_sync_foreign_key_error(syncing_table: &str, error: &str) -> String {
    let Some(fk) = parse_foreign_key_violation(error) else {
        if error.to_ascii_lowercase().contains("foreign key constraint") {
            return format!(
                "表 `{syncing_table}` 写入失败：外键约束不满足，请先同步被引用的父表后再重试。\n原始错误：{}",
                error.trim()
            );
        }
        return error.to_string();
    };

    if fk.is_parent_row_violation {
        let child = fk
            .child_table
            .as_deref()
            .unwrap_or("子表");
        return format!(
            "表 `{syncing_table}` 操作失败：仍有子表 `{child}` 引用本表数据。请先处理子表 `{child}` 的数据同步。"
        );
    }

    let link = match (&fk.child_column, &fk.parent_column) {
        (Some(child_col), Some(parent_col)) => {
            format!("本表字段 `{child_col}` → `{}`.`{parent_col}`", fk.parent_table)
        }
        (Some(child_col), None) => format!("本表字段 `{child_col}` → `{}`", fk.parent_table),
        _ => format!("引用表 `{}`", fk.parent_table),
    };

    format!(
        "表 `{syncing_table}` 写入失败：目标库缺少外键关联数据（{link}）。\n请先同步父表 `{}` 到目标库，再同步 `{syncing_table}`。",
        fk.parent_table
    )
}

async fn execute_sql_statements_on_driver(
    driver: &dyn omnipanel_db::DbDriver,
    statements: &[String],
    cancel: &AtomicBool,
    syncing_table: &str,
) -> Result<u64, String> {
    if statements.is_empty() {
        return Ok(0);
    }
    let mut written = 0u64;
    let mut i = 0usize;
    while i < statements.len() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let mut batch: Vec<&str> = Vec::with_capacity(SQL_FILE_STMT_BATCH);
        while i < statements.len() && batch.len() < SQL_FILE_STMT_BATCH {
            let raw = &statements[i];
            i += 1;
            if raw.trim().is_empty() {
                continue;
            }
            batch.push(raw.as_str());
        }
        if batch.is_empty() {
            continue;
        }
        let combined = batch
            .iter()
            .map(|s| {
                let t = s.trim().trim_end_matches(';').trim();
                format!("{t};")
            })
            .collect::<Vec<_>>()
            .join("\n");
        let result = driver
            .execute(&combined)
            .await
            .map_err(|e| format_sync_foreign_key_error(syncing_table, &e.user_message()))?;
        written = written.saturating_add(result.rows_affected);
    }
    Ok(written)
}

async fn execute_insert_statements(
    target_conn: &DbConnectionConfig,
    statements: Vec<String>,
    cancel: &AtomicBool,
    syncing_table: &str,
) -> Result<u64, String> {
    if statements.is_empty() {
        return Ok(0);
    }
    // 复用同一驱动，避免每条 SQL 重新建池
    let driver = database::open_db_driver(target_conn).await?;
    execute_sql_statements_on_driver(driver.as_ref(), &statements, cancel, syncing_table).await
}

#[cfg(test)]
mod fk_error_tests {
    use super::{
        format_sync_foreign_key_error, parse_mysql_foreign_key_violation,
    };

    #[test]
    fn parse_mysql_child_insert_fk_error() {
        let err = "error returned from database: 1452 (23000): Cannot add or update a child row: a foreign key constraint fails (`teacher-chat`.`edu_english_word`, CONSTRAINT `edu_english_word_ibfk_1` FOREIGN KEY (`unit_id`) REFERENCES `edu_english_unit` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT)";
        let fk = parse_mysql_foreign_key_violation(err).expect("fk");
        assert_eq!(fk.child_table.as_deref(), Some("edu_english_word"));
        assert_eq!(fk.child_column.as_deref(), Some("unit_id"));
        assert_eq!(fk.parent_table, "edu_english_unit");
        assert_eq!(fk.parent_column.as_deref(), Some("id"));
        assert!(!fk.is_parent_row_violation);
    }

    #[test]
    fn format_sync_fk_error_message() {
        let err = "数据库操作失败: error returned from database: 1452 (23000): Cannot add or update a child row: a foreign key constraint fails (`teacher-chat`.`edu_english_word`, CONSTRAINT `edu_english_word_ibfk_1` FOREIGN KEY (`unit_id`) REFERENCES `edu_english_unit` (`id`) ON DELETE CASCADE ON UPDATE RESTRICT)";
        let msg = format_sync_foreign_key_error("edu_english_word", err);
        assert!(msg.contains("edu_english_unit"));
        assert!(msg.contains("unit_id"));
        assert!(msg.contains("请先同步父表"));
    }
}

async fn copy_table_data(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    spec: &DbSyncExecTableSpec,
    cancel: &AtomicBool,
    report_rows: Arc<dyn Fn(u32, u32) + Send + Sync>,
) -> Result<SyncWriteStats, String> {
    let modes = resolve_data_sync_modes(spec);
    copy_table_data_with_modes(
        source,
        source_db,
        target,
        target_db,
        spec,
        cancel,
        report_rows,
        modes,
    )
    .await
}

async fn resolve_exec_table_columns(
    source: &DbConnectionConfig,
    source_db: &str,
    spec: &DbSyncExecTableSpec,
) -> Result<Vec<DbColumnMeta>, String> {
    if !spec.columns.is_empty() {
        return Ok(spec.columns.clone());
    }
    let schema = database::db_introspect_table(
        source.clone(),
        Some(source_db.to_string()),
        spec.name.clone(),
    )
    .await?;
    if schema.columns.is_empty() {
        return Err(format!("表 {} 缺少字段信息", spec.name));
    }
    Ok(schema.columns)
}

async fn execute_data_sync_table(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    spec: &DbSyncExecTableSpec,
    cancel: &AtomicBool,
    report_rows: Arc<dyn Fn(u32, u32) + Send + Sync>,
) -> SyncExecResultEvent {
    let table = spec.name.clone();
    if !is_mysql_engine(&target.db_type)
        && !is_postgres_engine(&target.db_type)
        && target.db_type.to_lowercase() != "sqlite"
    {
        return SyncExecResultEvent {
            table,
            status: "error".to_string(),
            rows_written: None,
            message: None,
            error: Some(format!("暂不支持 {} 的数据同步执行", target.db_type)),
        };
    }

    let mut exec_spec = spec.clone();
    match resolve_exec_table_columns(source, source_db, spec).await {
        Ok(columns) => exec_spec.columns = columns,
        Err(err) => {
            return SyncExecResultEvent {
                table,
                status: "error".to_string(),
                rows_written: None,
                message: None,
                error: Some(err),
            };
        }
    }

    if let Err(err) = ensure_table_from_source(
        source,
        source_db,
        target,
        target_db,
        &exec_spec.name,
        &exec_spec.name,
    )
    .await
    {
        return SyncExecResultEvent {
            table,
            status: "error".to_string(),
            rows_written: None,
            message: None,
            error: Some(err),
        };
    }

    match copy_table_data(
        source,
        source_db,
        target,
        target_db,
        &exec_spec,
        cancel,
        report_rows,
    )
    .await
    {
        Ok(stats) => SyncExecResultEvent {
            table,
            status: "success".to_string(),
            rows_written: Some(stats.total()),
            message: Some(format_sync_modes_message(
                &resolve_data_sync_modes(spec),
                &stats,
            )),
            error: None,
        },
        Err(err) if err == "cancelled" => SyncExecResultEvent {
            table,
            status: "error".to_string(),
            rows_written: None,
            message: None,
            error: Some("已取消".to_string()),
        },
        Err(err) => SyncExecResultEvent {
            table,
            status: "error".to_string(),
            rows_written: None,
            message: None,
            error: Some(err),
        },
    }
}

fn build_add_column_sql(
    db_type: &str,
    table: &str,
    col: &DbColumnMeta,
    position: MysqlAddColumnPosition<'_>,
) -> String {
    let table_ident = quote_ident(db_type, table);
    let col_ident = quote_ident(db_type, &col.name);
    let null = if col.nullable { "NULL" } else { "NOT NULL" };
    let position_sql = if is_mysql_engine(db_type) {
        match position {
            MysqlAddColumnPosition::First => " FIRST".to_string(),
            MysqlAddColumnPosition::After(name) => {
                format!(" AFTER {}", quote_ident(db_type, name))
            }
            MysqlAddColumnPosition::None => String::new(),
        }
    } else {
        String::new()
    };
    format!(
        "ALTER TABLE {table_ident} ADD COLUMN {col_ident} {} {null}{position_sql}",
        col.column_type
    )
}

enum MysqlAddColumnPosition<'a> {
    First,
    After(&'a str),
    None,
}

/// 根据源表列顺序解析 MySQL ADD COLUMN 的 FIRST / AFTER。
/// `existing_names`：目标已有列 ∪ 本批次已执行 ADD 的列。
fn resolve_mysql_add_column_position<'a>(
    source_columns: &'a [DbColumnMeta],
    column_name: &str,
    existing_names: &HashSet<&str>,
) -> MysqlAddColumnPosition<'a> {
    let Some(idx) = source_columns.iter().position(|c| c.name == column_name) else {
        return MysqlAddColumnPosition::None;
    };
    for i in (0..idx).rev() {
        let prev = source_columns[i].name.as_str();
        if existing_names.contains(prev) {
            return MysqlAddColumnPosition::After(prev);
        }
    }
    MysqlAddColumnPosition::First
}

fn build_modify_column_sql(db_type: &str, table: &str, col: &DbColumnMeta) -> String {
    let table_ident = quote_ident(db_type, table);
    let col_ident = quote_ident(db_type, &col.name);
    let null = if col.nullable { "NULL" } else { "NOT NULL" };
    if is_mysql_engine(db_type) {
        format!(
            "ALTER TABLE {table_ident} MODIFY COLUMN {col_ident} {} {null}",
            col.column_type
        )
    } else if is_postgres_engine(db_type) {
        format!(
            "ALTER TABLE {table_ident} ALTER COLUMN {col_ident} TYPE {}",
            col.column_type
        )
    } else {
        String::new()
    }
}

fn build_create_index_sql(db_type: &str, table: &str, idx: &DbIndexMeta) -> String {
    let table_ident = quote_ident(db_type, table);
    let idx_ident = quote_ident(db_type, &idx.name);
    let cols = idx
        .columns
        .iter()
        .map(|c| quote_ident(db_type, c))
        .collect::<Vec<_>>()
        .join(", ");
    if idx.unique {
        if is_mysql_engine(db_type) {
            format!("CREATE UNIQUE INDEX {idx_ident} ON {table_ident} ({cols})")
        } else {
            format!("CREATE UNIQUE INDEX {idx_ident} ON {table_ident} ({cols})")
        }
    } else {
        format!("CREATE INDEX {idx_ident} ON {table_ident} ({cols})")
    }
}

fn build_drop_index_sql(db_type: &str, table: &str, idx: &DbIndexMeta) -> String {
    let table_ident = quote_ident(db_type, table);
    let idx_ident = quote_ident(db_type, &idx.name);
    if is_mysql_engine(db_type) {
        format!("DROP INDEX {idx_ident} ON {table_ident}")
    } else if is_postgres_engine(db_type) {
        format!("DROP INDEX IF EXISTS {idx_ident}")
    } else {
        String::new()
    }
}

/// 单表结构同步 SQL 预览（不落库）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbSyncSqlPreviewTable {
    pub table: String,
    pub sql: String,
}

async fn collect_schema_diff_sql(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    spec: &DbSyncTableSpec,
    create_missing_tables: bool,
) -> Result<String, String> {
    let target_table_name = spec_target_table_name(spec);
    let mut lines: Vec<String> = Vec::new();

    if !target_table_exists(target, target_db, target_table_name).await {
        if !create_missing_tables {
            return Ok(format!("-- 已关闭「新增表」，跳过: {}", spec.name));
        }
        let ddl = database::db_table_ddl(
            source.clone(),
            Some(source_db.to_string()),
            spec.name.clone(),
        )
        .await?;
        let sql = normalize_create_table_ddl(&ddl, &target.db_type);
        let sql = rewrite_create_table_ddl_name(
            &sql,
            &spec.name,
            target_table_name,
            &target.db_type,
        );
        return Ok(format!("{sql};"));
    }

    let target_table = database::db_introspect_table(
        target.clone(),
        Some(target_db.to_string()),
        target_table_name.to_string(),
    )
    .await?;
    let col_diffs = compare_table_columns(&spec.columns, &target_table.columns);
    let idx_diffs = compare_table_indexes(&spec.indexes, &target_table.indexes);
    if col_diffs.is_empty() && idx_diffs.is_empty() {
        return Ok("-- 结构已一致，无需变更".to_string());
    }

    let added_names: HashSet<&str> = col_diffs
        .iter()
        .filter(|d| d.kind == "added")
        .map(|d| d.name.as_str())
        .collect();
    let mut existing_names: HashSet<&str> = target_table
        .columns
        .iter()
        .map(|c| c.name.as_str())
        .collect();

    for col in &spec.columns {
        if !added_names.contains(col.name.as_str()) {
            continue;
        }
        let position = if is_mysql_engine(&target.db_type) {
            resolve_mysql_add_column_position(&spec.columns, &col.name, &existing_names)
        } else {
            MysqlAddColumnPosition::None
        };
        let sql = build_add_column_sql(&target.db_type, target_table_name, col, position);
        if !sql.is_empty() {
            lines.push(format!("{sql};"));
            existing_names.insert(col.name.as_str());
        }
    }

    for diff in &col_diffs {
        if diff.kind == "added" {
            continue;
        }
        if diff.kind == "removed" {
            lines.push(format!(
                "-- 目标端多余列 {}（执行时不会自动删除）",
                diff.name
            ));
            continue;
        }
        if diff.kind != "changed" {
            continue;
        }
        let Some(col) = spec.columns.iter().find(|c| c.name == diff.name) else {
            continue;
        };
        let sql = build_modify_column_sql(&target.db_type, target_table_name, col);
        if !sql.is_empty() {
            lines.push(format!("{sql};"));
        }
    }

    for diff in &idx_diffs {
        match diff.kind.as_str() {
            "added" => {
                if let Some(idx) = spec.indexes.iter().find(|i| i.name == diff.name) {
                    let sql = build_create_index_sql(&target.db_type, target_table_name, idx);
                    lines.push(format!("{sql};"));
                }
            }
            "changed" => {
                if let Some(idx) = spec.indexes.iter().find(|i| i.name == diff.name) {
                    let drop_sql = build_drop_index_sql(&target.db_type, target_table_name, idx);
                    if !drop_sql.is_empty() {
                        lines.push(format!("{drop_sql};"));
                    }
                    let create_sql =
                        build_create_index_sql(&target.db_type, target_table_name, idx);
                    lines.push(format!("{create_sql};"));
                }
            }
            "removed" => {
                lines.push(format!(
                    "-- 目标端多余索引 {}（执行时不会自动删除）",
                    diff.name
                ));
            }
            _ => {}
        }
    }

    if lines.is_empty() {
        return Ok("-- 无待执行结构变更".to_string());
    }
    Ok(lines.join("\n"))
}

/// 批量生成结构同步「表 → SQL 预览」（dry-run，不执行）。
pub async fn preview_schema_sync_sql(
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    source_db: String,
    target_db: String,
    tables: Vec<DbSyncTableSpec>,
    create_missing_tables: bool,
) -> Result<Vec<DbSyncSqlPreviewTable>, String> {
    if !is_mysql_engine(&target.db_type)
        && !is_postgres_engine(&target.db_type)
        && target.db_type.to_lowercase() != "sqlite"
    {
        return Err(format!("暂不支持 {} 的脚本预览", target.db_type));
    }

    let mut out = Vec::with_capacity(tables.len());
    for spec in tables {
        let table = spec.name.clone();
        match collect_schema_diff_sql(
            &source,
            &source_db,
            &target,
            &target_db,
            &spec,
            create_missing_tables,
        )
        .await
        {
            Ok(sql) => out.push(DbSyncSqlPreviewTable { table, sql }),
            Err(err) => out.push(DbSyncSqlPreviewTable {
                table,
                sql: format!("-- 无法生成预览: {err}"),
            }),
        }
    }
    Ok(out)
}

/// 批量拉取建表 DDL（供数据同步预览等一次取齐）。
pub async fn batch_table_ddl(
    connection: DbConnectionConfig,
    schema: Option<String>,
    tables: Vec<String>,
) -> Result<Vec<DbSyncSqlPreviewTable>, String> {
    let mut out = Vec::with_capacity(tables.len());
    for table in tables {
        match database::db_table_ddl(connection.clone(), schema.clone(), table.clone()).await {
            Ok(ddl) => out.push(DbSyncSqlPreviewTable {
                table,
                sql: ddl,
            }),
            Err(err) => out.push(DbSyncSqlPreviewTable {
                table,
                sql: format!("-- 无法获取建表语句: {err}"),
            }),
        }
    }
    Ok(out)
}

async fn apply_schema_diff(
    target: &DbConnectionConfig,
    target_db: &str,
    spec: &DbSyncTableSpec,
) -> Result<String, String> {
    let target_table_name = spec_target_table_name(spec);
    let target_table = database::db_introspect_table(
        target.clone(),
        Some(target_db.to_string()),
        target_table_name.to_string(),
    )
    .await?;
    let col_diffs = compare_table_columns(&spec.columns, &target_table.columns);
    let idx_diffs = compare_table_indexes(&spec.indexes, &target_table.indexes);
    let mut applied = 0u32;

    let added_names: HashSet<&str> = col_diffs
        .iter()
        .filter(|d| d.kind == "added")
        .map(|d| d.name.as_str())
        .collect();
    let mut existing_names: HashSet<&str> = target_table
        .columns
        .iter()
        .map(|c| c.name.as_str())
        .collect();

    // 按源表列顺序 ADD，使 MySQL AFTER / FIRST 与源顺序一致
    for col in &spec.columns {
        if !added_names.contains(col.name.as_str()) {
            continue;
        }
        let position = if is_mysql_engine(&target.db_type) {
            resolve_mysql_add_column_position(&spec.columns, &col.name, &existing_names)
        } else {
            MysqlAddColumnPosition::None
        };
        let sql = build_add_column_sql(&target.db_type, target_table_name, col, position);
        if sql.is_empty() {
            continue;
        }
        database::db_run_sql(target.clone(), Some(target_db.to_string()), sql).await?;
        existing_names.insert(col.name.as_str());
        applied += 1;
    }

    for diff in &col_diffs {
        if diff.kind != "changed" {
            continue;
        }
        let Some(col) = spec.columns.iter().find(|c| c.name == diff.name) else {
            continue;
        };
        let sql = build_modify_column_sql(&target.db_type, target_table_name, col);
        if sql.is_empty() {
            continue;
        }
        database::db_run_sql(target.clone(), Some(target_db.to_string()), sql).await?;
        applied += 1;
    }

    for diff in &idx_diffs {
        match diff.kind.as_str() {
            "added" => {
                if let Some(idx) = spec.indexes.iter().find(|i| i.name == diff.name) {
                    let sql = build_create_index_sql(&target.db_type, target_table_name, idx);
                    database::db_run_sql(target.clone(), Some(target_db.to_string()), sql)
                        .await?;
                    applied += 1;
                }
            }
            "changed" => {
                if let Some(idx) = spec.indexes.iter().find(|i| i.name == diff.name) {
                    let drop_sql = build_drop_index_sql(&target.db_type, target_table_name, idx);
                    if !drop_sql.is_empty() {
                        database::db_run_sql(
                            target.clone(),
                            Some(target_db.to_string()),
                            drop_sql,
                        )
                        .await?;
                    }
                    let create_sql = build_create_index_sql(&target.db_type, target_table_name, idx);
                    database::db_run_sql(
                        target.clone(),
                        Some(target_db.to_string()),
                        create_sql,
                    )
                    .await?;
                    applied += 1;
                }
            }
            _ => {}
        }
    }

    if applied == 0 && col_diffs.iter().all(|d| d.kind == "removed")
        && idx_diffs.iter().all(|d| d.kind == "removed")
    {
        return Ok("结构已一致".to_string());
    }
    Ok(format!("已应用 {applied} 项结构变更"))
}

async fn execute_schema_sync_table(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    spec: &DbSyncTableSpec,
) -> SyncExecResultEvent {
    let table = spec.name.clone();
    if !is_mysql_engine(&target.db_type)
        && !is_postgres_engine(&target.db_type)
        && target.db_type.to_lowercase() != "sqlite"
    {
        return SyncExecResultEvent {
            table,
            status: "error".to_string(),
            rows_written: None,
            message: None,
            error: Some(format!("暂不支持 {} 的结构同步执行", target.db_type)),
        };
    }

    let target_table_name = spec_target_table_name(spec);

    if !target_table_exists(target, target_db, target_table_name).await {
        match ensure_table_from_source(
            source,
            source_db,
            target,
            target_db,
            &spec.name,
            target_table_name,
        )
        .await
        {
            Ok(()) => {
                return SyncExecResultEvent {
                    table,
                    status: "success".to_string(),
                    rows_written: None,
                    message: Some("已创建表".to_string()),
                    error: None,
                };
            }
            Err(err) => {
                return SyncExecResultEvent {
                    table,
                    status: "error".to_string(),
                    rows_written: None,
                    message: None,
                    error: Some(err),
                };
            }
        }
    }

    match apply_schema_diff(target, target_db, spec).await {
        Ok(message) => SyncExecResultEvent {
            table,
            status: "success".to_string(),
            rows_written: None,
            message: Some(message),
            error: None,
        },
        Err(err) => SyncExecResultEvent {
            table,
            status: "error".to_string(),
            rows_written: None,
            message: None,
            error: Some(err),
        },
    }
}

async fn emit_exec_event(app: &AppHandle, task_id: &str, result: SyncExecResultEvent) {
    emit_db_event(
        app,
        BgTaskDbEvent {
            task_id: task_id.to_string(),
            event_type: "exec_result".to_string(),
            table: Some(result.table.clone()),
            count: None,
            row_result: None,
            schema_result: None,
            exec_result: Some(result),
        },
    )
    .await;
}

pub async fn run_db_data_sync_execute(
    app: AppHandle,
    task_id: String,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let source_db = source.database.clone();
    let target_db = target.database.clone();
    let total = tables.len().max(1) as u32;
    let rows_written_total = Arc::new(AtomicU32::new(0));
    let completed = Arc::new(AtomicU32::new(0));
    let failed: Arc<tokio::sync::Mutex<Vec<String>>> =
        Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let concurrency = data_sync_table_concurrency().max(1);

    // 多表并行同步（有限并发）；表间外键依赖时建议按父→子顺序生成任务，或改走 SQL 文件保序执行
    stream::iter(tables.into_iter().enumerate())
        .map(|(idx, spec)| {
            let app = app.clone();
            let task_id = task_id.clone();
            let source = source.clone();
            let target = target.clone();
            let source_db = source_db.clone();
            let target_db = target_db.clone();
            let cancel = cancel.clone();
            let progress = progress.clone();
            let rows_written_total = rows_written_total.clone();
            let completed = completed.clone();
            let failed = failed.clone();
            async move {
                if cancel.load(Ordering::Relaxed) {
                    return;
                }
                let index = (idx + 1) as u32;
                let table = spec.name.clone();
                progress(
                    format!("正在同步数据 ({index}/{total})：{table}"),
                    completed.load(Ordering::Relaxed).min(total),
                    total,
                    Some(rows_written_total.load(Ordering::Relaxed)),
                    None,
                );

                let report_rows: Arc<dyn Fn(u32, u32) + Send + Sync> = {
                    let progress = progress.clone();
                    let table_for_rows = table.clone();
                    let rows_written_total = rows_written_total.clone();
                    let completed = completed.clone();
                    Arc::new(move |rows_written, _estimated_total| {
                        progress(
                            format!("正在同步 {table_for_rows}（已写入 {rows_written} 行）"),
                            completed.load(Ordering::Relaxed).min(total),
                            total,
                            Some(
                                rows_written_total
                                    .load(Ordering::Relaxed)
                                    .saturating_add(rows_written),
                            ),
                            None,
                        );
                    })
                };

                let result = execute_data_sync_table(
                    &source,
                    &source_db,
                    &target,
                    &target_db,
                    &spec,
                    &cancel,
                    report_rows,
                )
                .await;
                if result.status == "error" {
                    let detail = result
                        .error
                        .clone()
                        .unwrap_or_else(|| "未知错误".to_string());
                    failed.lock().await.push(format!("{table}: {detail}"));
                } else {
                    let written =
                        result.rows_written.unwrap_or(0).min(u64::from(u32::MAX)) as u32;
                    rows_written_total.fetch_add(written, Ordering::Relaxed);
                }
                completed.fetch_add(1, Ordering::Relaxed);
                emit_exec_event(&app, &task_id, result).await;
            }
        })
        .buffer_unordered(concurrency)
        .collect::<Vec<_>>()
        .await;

    let failed_tables = failed.lock().await.clone();
    let rows_written_total = rows_written_total.load(Ordering::Relaxed);

    if !failed_tables.is_empty() {
        progress(
            format!("数据同步完成，{}/{} 张表失败", failed_tables.len(), total),
            total,
            total,
            Some(rows_written_total),
            None,
        );
        return Err(failed_tables.join("；"));
    }

    progress(
        format!("数据同步已完成，共写入 {rows_written_total} 行"),
        total,
        total,
        Some(rows_written_total),
        None,
    );
    Ok(())
}


pub async fn run_db_schema_sync_execute(
    app: AppHandle,
    task_id: String,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let source_db = source.database.clone();
    let target_db = target.database.clone();
    let total = tables.len().max(1) as u32;

    for (idx, spec) in tables.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let index = (idx + 1) as u32;
        let table = spec.name.clone();
        progress(
            format!("正在同步结构 ({index}/{total})：{table}"),
            index,
            total,
            None,
            None,
        );
        let result = execute_schema_sync_table(&source, &source_db, &target, &target_db, spec).await;
        emit_exec_event(&app, &task_id, result).await;
    }

    progress(
        format!("结构同步已完成 ({total}/{total})"),
        total,
        total,
        None,
        None,
    );
    Ok(())
}

#[cfg(test)]
mod add_column_position_tests {
    use super::{
        build_add_column_sql, resolve_mysql_add_column_position, MysqlAddColumnPosition,
    };
    use crate::commands::database::DbColumnMeta;
    use std::collections::HashSet;

    fn col(name: &str) -> DbColumnMeta {
        DbColumnMeta {
            name: name.to_string(),
            column_type: "json".to_string(),
            is_pk: false,
            is_fk: false,
            nullable: true,
            is_auto_increment: false,
            comment: None,
        }
    }

    #[test]
    fn mysql_add_column_uses_after_previous_existing() {
        let source = vec![col("id"), col("update_time"), col("chapter_json"), col("name")];
        let existing: HashSet<&str> = ["id", "update_time", "name"].into_iter().collect();
        let position =
            resolve_mysql_add_column_position(&source, "chapter_json", &existing);
        assert!(matches!(
            position,
            MysqlAddColumnPosition::After("update_time")
        ));
        let sql = build_add_column_sql("mysql", "tiku_chapter", &source[2], position);
        assert_eq!(
            sql,
            "ALTER TABLE `tiku_chapter` ADD COLUMN `chapter_json` json NULL AFTER `update_time`"
        );
    }

    #[test]
    fn mysql_add_column_uses_first_when_no_previous() {
        let source = vec![col("id"), col("name")];
        let existing: HashSet<&str> = ["name"].into_iter().collect();
        let position = resolve_mysql_add_column_position(&source, "id", &existing);
        assert!(matches!(position, MysqlAddColumnPosition::First));
        let sql = build_add_column_sql("mysql", "t", &source[0], position);
        assert!(sql.ends_with(" FIRST"));
    }
}
