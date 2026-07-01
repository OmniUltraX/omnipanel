use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use futures::stream::{self, StreamExt};
use omnipanel_store::DbConnectionConfig;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Emitter};

use crate::background::worker_pool::DEFAULT_WORKER_COUNT;
use crate::commands::database::{self, DbColumnMeta, DbIndexMeta};

const PAGE_SIZE: i64 = 500;
const MAX_DIFF_DETAIL_ROWS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbSyncTableSpec {
    pub name: String,
    pub columns: Vec<DbColumnMeta>,
    #[serde(default)]
    pub indexes: Vec<DbIndexMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowDiffPayload {
    pub row_key: String,
    pub display_key: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed_fields: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_row: Option<HashMap<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbSyncExecTableSpec {
    pub name: String,
    pub columns: Vec<DbColumnMeta>,
    #[serde(default)]
    pub indexes: Vec<DbIndexMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
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
        .map(|col| normalize_value(row.get(col).unwrap_or(&serde_json::Value::Null)))
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
                normalize_value(row.get(col).unwrap_or(&serde_json::Value::Null))
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

async fn fetch_all_rows(
    connection: &DbConnectionConfig,
    table_name: &str,
    cancel: &AtomicBool,
    row_total: u32,
    row_completed: &mut u32,
    report_rows: Arc<dyn Fn(u32, u32) + Send + Sync>,
) -> Result<Vec<HashMap<String, serde_json::Value>>, String> {
    let total = database::db_count_table(
        connection.clone(),
        None,
        table_name.to_string(),
        None,
    )
    .await?;
    if total <= 0 {
        return Ok(Vec::new());
    }

    let mut rows = Vec::new();
    let mut offset = 0i64;
    while offset < total {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let page = database::db_preview_table(
            connection.clone(),
            table_name.to_string(),
            PAGE_SIZE as u32,
            offset as u32,
            None,
            None,
        )
        .await?;
        let fetched = page.rows.len() as u32;
        rows.extend(page.rows);
        *row_completed = row_completed.saturating_add(fetched);
        if row_total > 0 {
            report_rows(*row_completed, row_total);
        }
        offset += PAGE_SIZE;
    }
    Ok(rows)
}

async fn compare_table_rows(
    source: &DbConnectionConfig,
    target: &DbConnectionConfig,
    table_name: &str,
    columns: &[DbColumnMeta],
    cancel: Arc<AtomicBool>,
    report_rows: Arc<dyn Fn(u32, u32) + Send + Sync>,
) -> TableRowCompareEvent {
    let pk_columns: Vec<String> = columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.clone())
        .collect();
    let all_column_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

    let source_total = database::db_count_table(
        source.clone(),
        None,
        table_name.to_string(),
        None,
    )
    .await
    .map(clamp_row_count)
    .unwrap_or(0);
    let target_total = database::db_count_table(
        target.clone(),
        None,
        table_name.to_string(),
        None,
    )
    .await
    .map(clamp_row_count)
    .unwrap_or(0);
    let row_total = source_total.saturating_add(target_total).max(1);
    let mut row_completed = 0u32;

    let source_rows = match fetch_all_rows(
        source,
        table_name,
        &cancel,
        row_total,
        &mut row_completed,
        report_rows.clone(),
    )
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            if e == "cancelled" {
                return TableRowCompareEvent {
                    table: table_name.to_string(),
                    status: "error".to_string(),
                    diff_rows: None,
                    diffs: Vec::new(),
                    truncated: None,
                    error: Some("cancelled".to_string()),
                };
            }
            return TableRowCompareEvent {
                table: table_name.to_string(),
                status: "error".to_string(),
                diff_rows: None,
                diffs: Vec::new(),
                truncated: None,
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
            error: Some("cancelled".to_string()),
        };
    }

    let target_rows = match fetch_all_rows(
        target,
        table_name,
        &cancel,
        row_total,
        &mut row_completed,
        report_rows.clone(),
    )
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            return TableRowCompareEvent {
                table: table_name.to_string(),
                status: "error".to_string(),
                diff_rows: None,
                diffs: Vec::new(),
                truncated: None,
                error: Some(e),
            };
        }
    };

    report_rows(row_completed.min(row_total), row_total);

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

    let mut diffs: Vec<TableRowDiffPayload> = Vec::new();
    let mut diff_count = 0u32;

    for (key, source_row) in &source_map {
        if cancel.load(Ordering::Relaxed) {
            return TableRowCompareEvent {
                table: table_name.to_string(),
                status: "error".to_string(),
                diff_rows: None,
                diffs: Vec::new(),
                truncated: None,
                error: Some("cancelled".to_string()),
            };
        }
        match target_map.get(key) {
            None => {
                diff_count += 1;
                if diffs.len() < MAX_DIFF_DETAIL_ROWS {
                    diffs.push(TableRowDiffPayload {
                        row_key: key.clone(),
                        display_key: format_row_display_key(source_row, &pk_columns, &all_column_names),
                        kind: "sourceOnly".to_string(),
                        changed_fields: None,
                        source_row: Some(source_row.clone()),
                        target_row: None,
                    });
                }
            }
            Some(target_row) => {
                let mut changed: Vec<String> = Vec::new();
                for col in &all_column_names {
                    let sv = normalize_value(source_row.get(col).unwrap_or(&serde_json::Value::Null));
                    let tv = normalize_value(target_row.get(col).unwrap_or(&serde_json::Value::Null));
                    if sv != tv {
                        changed.push(col.clone());
                    }
                }
                if !changed.is_empty() {
                    diff_count += 1;
                    if diffs.len() < MAX_DIFF_DETAIL_ROWS {
                        diffs.push(TableRowDiffPayload {
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
    }

    for (key, target_row) in &target_map {
        if cancel.load(Ordering::Relaxed) {
            return TableRowCompareEvent {
                table: table_name.to_string(),
                status: "error".to_string(),
                diff_rows: None,
                diffs: Vec::new(),
                truncated: None,
                error: Some("cancelled".to_string()),
            };
        }
        if source_map.contains_key(key) {
            continue;
        }
        diff_count += 1;
        if diffs.len() < MAX_DIFF_DETAIL_ROWS {
            diffs.push(TableRowDiffPayload {
                row_key: key.clone(),
                display_key: format_row_display_key(target_row, &pk_columns, &all_column_names),
                kind: "targetOnly".to_string(),
                changed_fields: None,
                source_row: None,
                target_row: Some(target_row.clone()),
            });
        }
    }

    if diff_count == 0 {
        report_rows(row_total, row_total);
        TableRowCompareEvent {
            table: table_name.to_string(),
            status: "match".to_string(),
            diff_rows: Some(0),
            diffs: Vec::new(),
            truncated: None,
            error: None,
        }
    } else {
        report_rows(row_total, row_total);
        TableRowCompareEvent {
            table: table_name.to_string(),
            status: "diff".to_string(),
            diff_rows: Some(diff_count),
            diffs,
            truncated: Some(diff_count as usize > MAX_DIFF_DETAIL_ROWS),
            error: None,
        }
    }
}

fn column_signature(col: &DbColumnMeta) -> String {
    format!("{}|{}|{}", col.column_type, col.is_pk, col.is_fk)
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

async fn compare_schema_for_table(
    target: DbConnectionConfig,
    target_schema: String,
    spec: DbSyncTableSpec,
) -> SchemaCompareEvent {
    let table = spec.name.clone();
    match database::db_introspect_table(target, Some(target_schema), table.clone()).await {
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
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let total = tables.len().max(1) as u32;
    let source_db = source.database.clone();
    let target_db = target.database.clone();

    for (idx, spec) in tables.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }

        let index = (idx + 1) as u32;
        let table = spec.name.clone();

        progress(
            format!("正在统计目标表行数 ({index}/{total})：{table}"),
            index,
            total,
            None,
            None,
        );

        let target_count = database::db_count_table(
            target.clone(),
            Some(target_db.clone()),
            table.clone(),
            None,
        )
        .await
        .ok();

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
            return Ok(());
        }

        let progress_for_rows = progress.clone();
        let table_for_rows = table.clone();
        let report_rows: Arc<dyn Fn(u32, u32) + Send + Sync> = Arc::new(move |row_completed, row_total| {
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

        let row_result = compare_table_rows(
            &source,
            &target,
            &table,
            &spec.columns,
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

        let _ = source_db.as_str();
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

    let concurrency = DEFAULT_WORKER_COUNT.max(1) as usize;
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

const INSERT_BATCH_SIZE: usize = 150;

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

fn sql_literal(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::Null => "NULL".to_string(),
        serde_json::Value::Bool(b) => {
            if *b {
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

async fn ensure_table_from_source(
    source: &DbConnectionConfig,
    source_db: &str,
    target: &DbConnectionConfig,
    target_db: &str,
    table: &str,
) -> Result<(), String> {
    if target_table_exists(target, target_db, table).await {
        return Ok(());
    }
    let ddl = database::db_table_ddl(
        source.clone(),
        Some(source_db.to_string()),
        table.to_string(),
    )
    .await?;
    let sql = normalize_create_table_ddl(&ddl, &target.db_type);
    database::db_run_sql(target.clone(), Some(target_db.to_string()), sql).await?;
    Ok(())
}

async fn truncate_target_table(
    target: &DbConnectionConfig,
    target_db: &str,
    table: &str,
) -> Result<(), String> {
    let ident = quote_ident(&target.db_type, table);
    let sql = if is_mysql_engine(&target.db_type) {
        format!("TRUNCATE TABLE {ident}")
    } else if is_postgres_engine(&target.db_type) {
        format!("TRUNCATE TABLE {ident}")
    } else {
        format!("DELETE FROM {ident}")
    };
    database::db_run_sql(target.clone(), Some(target_db.to_string()), sql)
        .await?;
    Ok(())
}

fn build_insert_statement(
    db_type: &str,
    table: &str,
    columns: &[String],
    rows: &[HashMap<String, serde_json::Value>],
    strategy: &str,
    pk_columns: &[String],
) -> Result<String, String> {
    if rows.is_empty() {
        return Ok(String::new());
    }
    let table_ident = quote_ident(db_type, table);
    let col_idents: Vec<String> = columns
        .iter()
        .map(|name| quote_ident(db_type, name))
        .collect();
    let col_list = col_idents.join(", ");
    let mut values_parts = Vec::with_capacity(rows.len());
    for row in rows {
        let values = columns
            .iter()
            .map(|col| sql_literal(row.get(col).unwrap_or(&serde_json::Value::Null)))
            .collect::<Vec<_>>()
            .join(", ");
        values_parts.push(format!("({values})"));
    }
    let values_sql = values_parts.join(", ");

    if is_mysql_engine(db_type) {
        return match strategy {
            "append" => Ok(format!(
                "INSERT IGNORE INTO {table_ident} ({col_list}) VALUES {values_sql}"
            )),
            "update" if !pk_columns.is_empty() => {
                let base = format!("INSERT INTO {table_ident} ({col_list}) VALUES {values_sql}");
                let updates = columns
                    .iter()
                    .map(|col| {
                        let ident = quote_ident(db_type, col);
                        format!("{ident}=new.{ident}")
                    })
                    .collect::<Vec<_>>()
                    .join(", ");
                Ok(format!("{base} AS new ON DUPLICATE KEY UPDATE {updates}"))
            }
            _ => Ok(format!(
                "INSERT INTO {table_ident} ({col_list}) VALUES {values_sql}"
            )),
        };
    }

    if is_postgres_engine(db_type) {
        let base = format!("INSERT INTO {table_ident} ({col_list}) VALUES {values_sql}");
        if strategy == "append" && !pk_columns.is_empty() {
            let pk_list = pk_columns
                .iter()
                .map(|col| quote_ident(db_type, col))
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(format!("{base} ON CONFLICT ({pk_list}) DO NOTHING"));
        }
        if strategy == "update" && !pk_columns.is_empty() {
            let pk_list = pk_columns
                .iter()
                .map(|col| quote_ident(db_type, col))
                .collect::<Vec<_>>()
                .join(", ");
            let updates = columns
                .iter()
                .map(|col| {
                    let ident = quote_ident(db_type, col);
                    format!("{ident}=EXCLUDED.{ident}")
                })
                .collect::<Vec<_>>()
                .join(", ");
            return Ok(format!("{base} ON CONFLICT ({pk_list}) DO UPDATE SET {updates}"));
        }
        return Ok(base);
    }

    if strategy == "append" {
        Ok(format!(
            "INSERT OR IGNORE INTO {table_ident} ({col_list}) VALUES {values_sql}"
        ))
    } else {
        Ok(format!(
            "INSERT OR REPLACE INTO {table_ident} ({col_list}) VALUES {values_sql}"
        ))
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
) -> Result<u64, String> {
    let table = spec.name.as_str();
    let columns: Vec<String> = spec.columns.iter().map(|c| c.name.clone()).collect();
    if columns.is_empty() {
        return Err("缺少表字段信息".to_string());
    }
    let pk_columns: Vec<String> = spec
        .columns
        .iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.clone())
        .collect();
    let strategy = spec.strategy.as_deref().unwrap_or("rewrite");

    if strategy == "rewrite" {
        truncate_target_table(target, target_db, table).await?;
    }

    let mut source_conn = source.clone();
    source_conn.database = source_db.to_string();
    let mut target_conn = target.clone();
    target_conn.database = target_db.to_string();

    let total = database::db_count_table(source_conn.clone(), None, table.to_string(), None)
        .await
        .unwrap_or(0)
        .max(0) as u32;
    let mut written = 0u64;
    let mut offset = 0i64;

    while offset < i64::from(total.max(1)) || (total == 0 && offset == 0) {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let page = database::db_preview_table(
            source_conn.clone(),
            table.to_string(),
            PAGE_SIZE as u32,
            offset as u32,
            None,
            None,
        )
        .await?;
        if page.rows.is_empty() {
            break;
        }
        let batch_len = page.rows.len();
        for chunk in page.rows.chunks(INSERT_BATCH_SIZE) {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            let sql = build_insert_statement(
                &target.db_type,
                table,
                &columns,
                chunk,
                strategy,
                &pk_columns,
            )?;
            if sql.is_empty() {
                continue;
            }
            written += database::db_run_sql(target_conn.clone(), None, sql).await?;
        }
        let done = (offset as u32 + batch_len as u32).min(total.max(batch_len as u32));
        report_rows(done, total.max(1));
        offset += PAGE_SIZE;
        if batch_len < PAGE_SIZE as usize {
            break;
        }
    }

    Ok(written)
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

    if let Err(err) =
        ensure_table_from_source(source, source_db, target, target_db, &spec.name).await
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
        spec,
        cancel,
        report_rows,
    )
    .await
    {
        Ok(rows) => SyncExecResultEvent {
            table,
            status: "success".to_string(),
            rows_written: Some(rows),
            message: Some(format!("已同步 {rows} 行")),
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

fn build_add_column_sql(db_type: &str, table: &str, col: &DbColumnMeta) -> String {
    let table_ident = quote_ident(db_type, table);
    let col_ident = quote_ident(db_type, &col.name);
    let null = if col.nullable { "NULL" } else { "NOT NULL" };
    if is_mysql_engine(db_type) {
        format!(
            "ALTER TABLE {table_ident} ADD COLUMN {col_ident} {} {null}",
            col.column_type
        )
    } else if is_postgres_engine(db_type) {
        format!(
            "ALTER TABLE {table_ident} ADD COLUMN {col_ident} {} {null}",
            col.column_type
        )
    } else {
        format!(
            "ALTER TABLE {table_ident} ADD COLUMN {col_ident} {} {null}",
            col.column_type
        )
    }
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

async fn apply_schema_diff(
    target: &DbConnectionConfig,
    target_db: &str,
    spec: &DbSyncTableSpec,
) -> Result<String, String> {
    let target_table = database::db_introspect_table(
        target.clone(),
        Some(target_db.to_string()),
        spec.name.clone(),
    )
    .await?;
    let col_diffs = compare_table_columns(&spec.columns, &target_table.columns);
    let idx_diffs = compare_table_indexes(&spec.indexes, &target_table.indexes);
    let mut applied = 0u32;

    for diff in &col_diffs {
        let Some(col) = spec.columns.iter().find(|c| c.name == diff.name) else {
            continue;
        };
        let sql = match diff.kind.as_str() {
            "added" => build_add_column_sql(&target.db_type, &spec.name, col),
            "changed" => build_modify_column_sql(&target.db_type, &spec.name, col),
            _ => continue,
        };
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
                    let sql = build_create_index_sql(&target.db_type, &spec.name, idx);
                    database::db_run_sql(target.clone(), Some(target_db.to_string()), sql)
                        .await?;
                    applied += 1;
                }
            }
            "changed" => {
                if let Some(idx) = spec.indexes.iter().find(|i| i.name == diff.name) {
                    let drop_sql = build_drop_index_sql(&target.db_type, &spec.name, idx);
                    if !drop_sql.is_empty() {
                        database::db_run_sql(
                            target.clone(),
                            Some(target_db.to_string()),
                            drop_sql,
                        )
                        .await?;
                    }
                    let create_sql = build_create_index_sql(&target.db_type, &spec.name, idx);
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

    if !target_table_exists(target, target_db, &spec.name).await {
        match ensure_table_from_source(source, source_db, target, target_db, &spec.name).await {
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

    for (idx, spec) in tables.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        let index = (idx + 1) as u32;
        let table = spec.name.clone();
        progress(
            format!("正在同步数据 ({index}/{total})：{table}"),
            index,
            total,
            None,
            None,
        );

        let report_rows: Arc<dyn Fn(u32, u32) + Send + Sync> = {
            let progress = progress.clone();
            let table_for_rows = table.clone();
            Arc::new(move |row_completed, row_total| {
                progress(
                    format!("正在写入 {table_for_rows} ({row_completed}/{row_total})"),
                    index,
                    total,
                    Some(row_completed),
                    Some(row_total),
                );
            })
        };

        let result = execute_data_sync_table(
            &source,
            &source_db,
            &target,
            &target_db,
            spec,
            &cancel,
            report_rows,
        )
        .await;
        emit_exec_event(&app, &task_id, result).await;
    }

    progress(
        format!("数据同步已完成 ({total}/{total})"),
        total,
        total,
        None,
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
