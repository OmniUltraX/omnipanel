//! DB 结构/数据同步：薄适配层，核心逻辑在 `omnipanel-db-sync`。

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use omnipanel_db_sync::{
    batch_table_ddl as shared_batch_table_ddl,
    generate_data_sync_sql_script as shared_generate_data_sync_sql_script,
    preview_schema_sync_sql as shared_preview_schema_sync_sql,
    run_db_data_sync_analysis as shared_run_db_data_sync_analysis,
    run_db_data_sync_execute as shared_run_db_data_sync_execute,
    run_db_data_sync_sql_file_execute as shared_run_db_data_sync_sql_file_execute,
    run_db_schema_sync_analysis as shared_run_db_schema_sync_analysis,
    run_db_schema_sync_execute as shared_run_db_schema_sync_execute,
};
use omnipanel_store::DbConnectionConfig;

use crate::bus::EventBus;
use crate::db_sync_bridge::db_sync_sink;

pub use omnipanel_db_sync::{
    DbDataSyncSqlGenerateResult, DbSyncExecTableSpec, DbSyncSqlPreviewTable, DbSyncTableSpec,
    paths::{read_sync_sql_file, row_diff_cache_dir, save_sync_sql_file, sync_sql_dir},
};

type ProgressCb = Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>;

pub async fn batch_table_ddl(
    connection: DbConnectionConfig,
    schema: Option<String>,
    tables: Vec<String>,
) -> Result<Vec<DbSyncSqlPreviewTable>, String> {
    shared_batch_table_ddl(connection, schema, tables).await
}

pub async fn preview_schema_sync_sql(
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    source_db: String,
    target_db: String,
    tables: Vec<DbSyncTableSpec>,
    create_missing_tables: bool,
) -> Result<Vec<DbSyncSqlPreviewTable>, String> {
    shared_preview_schema_sync_sql(
        source,
        target,
        source_db,
        target_db,
        tables,
        create_missing_tables,
    )
    .await
}

pub async fn generate_data_sync_sql_script(
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
) -> Result<DbDataSyncSqlGenerateResult, String> {
    shared_generate_data_sync_sql_script(source, target, tables).await
}

pub async fn run_db_data_sync_analysis(
    bus: EventBus,
    task_id: String,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
    ignored_fields: Vec<String>,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    shared_run_db_data_sync_analysis(
        db_sync_sink(bus),
        task_id,
        source,
        target,
        tables,
        ignored_fields,
        cancel,
        progress,
    )
    .await
}

pub async fn run_db_data_sync_execute(
    bus: EventBus,
    task_id: String,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    shared_run_db_data_sync_execute(
        db_sync_sink(bus),
        task_id,
        source,
        target,
        tables,
        cancel,
        progress,
    )
    .await
}

pub async fn run_db_data_sync_sql_file_execute(
    bus: EventBus,
    task_id: String,
    target: DbConnectionConfig,
    target_db: String,
    sql_file_path: String,
    table_names: Vec<String>,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    shared_run_db_data_sync_sql_file_execute(
        db_sync_sink(bus),
        task_id,
        target,
        target_db,
        sql_file_path,
        table_names,
        cancel,
        progress,
    )
    .await
}

pub async fn run_db_schema_sync_analysis(
    bus: EventBus,
    task_id: String,
    target: DbConnectionConfig,
    target_schema: String,
    tables: Vec<DbSyncTableSpec>,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    shared_run_db_schema_sync_analysis(
        db_sync_sink(bus),
        task_id,
        target,
        target_schema,
        tables,
        cancel,
        progress,
    )
    .await
}

pub async fn run_db_schema_sync_execute(
    bus: EventBus,
    task_id: String,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    shared_run_db_schema_sync_execute(
        db_sync_sink(bus),
        task_id,
        source,
        target,
        tables,
        cancel,
        progress,
    )
    .await
}

/// Schema 缓存刷新：对齐桌面 `schema_cache_jobs.rs`，经 EventBus 发
/// `bg-task-schema-cache-event`（connection_done / complete）。
pub async fn run_db_schema_cache_refresh(
    bus: EventBus,
    task_id: String,
    connections: Vec<DbConnectionConfig>,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    use omnipanel_db::{
        SchemaCacheDatabasePayload, SchemaConnectionRefreshPayload, refresh_connection_payload,
    };
    use omnipanel_store::{
        SchemaCacheColumn, SchemaCacheConnection, SchemaCacheDatabase, SchemaCacheIndex,
        SchemaCacheRoutine, SchemaCacheSnapshot, SchemaCacheTable, SchemaCacheUser,
        load_schema_cache, merge_schema_cache_connection, save_schema_cache,
    };
    use serde::{Deserialize, Serialize};

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct BgTaskSchemaCacheEvent {
        task_id: String,
        event_type: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        connection_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        entry: Option<SchemaCacheConnection>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot: Option<SchemaCacheSnapshot>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    fn now_ms() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn table_to_cache(table: omnipanel_db::DbTableSchema) -> SchemaCacheTable {
        SchemaCacheTable {
            name: table.name,
            columns: table
                .columns
                .into_iter()
                .map(|c| SchemaCacheColumn {
                    name: c.name,
                    column_type: c.column_type,
                    is_pk: c.is_pk,
                    is_fk: c.is_fk,
                })
                .collect(),
            indexes: table
                .indexes
                .into_iter()
                .map(|i| SchemaCacheIndex {
                    name: i.name,
                    columns: i.columns,
                    unique: i.unique,
                })
                .collect(),
            comment: table.comment,
        }
    }

    fn db_payload_to_cache(db: SchemaCacheDatabasePayload) -> SchemaCacheDatabase {
        SchemaCacheDatabase {
            name: db.name,
            tables: db.tables.into_iter().map(table_to_cache).collect(),
            views: db.views.into_iter().map(table_to_cache).collect(),
            routines: db
                .routines
                .into_iter()
                .map(|r| SchemaCacheRoutine {
                    name: r.name,
                    routine_type: r.routine_type,
                })
                .collect(),
            load_error: db.load_error,
            objects_loaded: db.objects_loaded,
            key_count: db.key_count,
        }
    }

    fn payload_to_cache(
        payload: SchemaConnectionRefreshPayload,
        error: Option<String>,
    ) -> SchemaCacheConnection {
        SchemaCacheConnection {
            databases: payload
                .databases
                .into_iter()
                .map(db_payload_to_cache)
                .collect(),
            users: payload
                .users
                .into_iter()
                .map(|u| SchemaCacheUser {
                    name: u.name,
                    host: u.host,
                })
                .collect(),
            refreshed_at: Some(now_ms()),
            error,
        }
    }

    let emit = |event: BgTaskSchemaCacheEvent| {
        if let Ok(payload) = serde_json::to_value(&event) {
            bus.emit("bg-task-schema-cache-event", payload);
        }
    };

    let total = connections.len().max(1) as u32;
    if connections.is_empty() {
        progress("无可用连接".into(), 0, 1, None, None);
        emit(BgTaskSchemaCacheEvent {
            task_id,
            event_type: "complete".into(),
            connection_id: None,
            connection_name: None,
            entry: None,
            snapshot: Some(load_schema_cache().map_err(|e| e.user_message())?),
            error: None,
        });
        return Ok(());
    }

    progress(
        format!("开始刷新 Schema 缓存（{} 个连接）", connections.len()),
        0,
        total,
        None,
        None,
    );

    let mut snapshot = load_schema_cache().unwrap_or_default();
    let mut index = 0u32;
    for conn in connections {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        index += 1;
        progress(
            format!("正在刷新连接：{}", conn.name),
            index,
            total,
            None,
            None,
        );

        let entry = match refresh_connection_payload(&conn).await {
            Ok(payload) => payload_to_cache(payload, None),
            Err(err) => SchemaCacheConnection {
                databases: Vec::new(),
                users: Vec::new(),
                refreshed_at: Some(now_ms()),
                error: Some(err),
            },
        };
        let merged = merge_schema_cache_connection(snapshot.connections.get(&conn.id), entry);
        snapshot.connections.insert(conn.id.clone(), merged.clone());

        emit(BgTaskSchemaCacheEvent {
            task_id: task_id.clone(),
            event_type: "connection_done".into(),
            connection_id: Some(conn.id.clone()),
            connection_name: Some(conn.name.clone()),
            entry: Some(merged),
            snapshot: None,
            error: None,
        });
    }

    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    save_schema_cache(&snapshot).map_err(|e| e.user_message())?;
    progress("Schema 缓存刷新完成".into(), total, total, None, None);
    emit(BgTaskSchemaCacheEvent {
        task_id,
        event_type: "complete".into(),
        connection_id: None,
        connection_name: None,
        entry: None,
        snapshot: None,
        error: None,
    });
    Ok(())
}
