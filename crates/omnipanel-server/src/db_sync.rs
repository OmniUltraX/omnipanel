//! DB 结构/数据同步：薄适配层，核心逻辑在 `omnipanel-db-sync`。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

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
    paths::{read_sync_sql_file, row_diff_cache_dir, save_sync_sql_file, sync_sql_dir},
    DbDataSyncSqlGenerateResult, DbSyncExecTableSpec, DbSyncSqlPreviewTable, DbSyncTableSpec,
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

/// Schema 缓存刷新：对每个连接拉库表列表并写入 schema cache（Web 端本地实现）。
pub async fn run_db_schema_cache_refresh(
    _task_id: String,
    connections: Vec<DbConnectionConfig>,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;

    let total = connections.len().max(1) as u32;
    progress(
        format!("开始刷新 Schema 缓存（{} 个连接）", connections.len()),
        0,
        total,
        None,
        None,
    );

    let mut snapshot = omnipanel_store::load_schema_cache().map_err(|e| e.user_message())?;
    let mut index = 0u32;
    for conn in connections {
        if cancel.load(Ordering::Relaxed) {
            return Err("任务已取消".to_string());
        }
        progress(
            format!("刷新：{}", conn.name),
            index,
            total,
            None,
            None,
        );
        let databases = match omnipanel_db::db_list_databases_with_stats(conn.clone()).await {
            Ok(rows) => rows.into_iter().map(|r| r.name).collect::<Vec<_>>(),
            Err(err) => {
                tracing::warn!(connection = %conn.name, error = %err, "Schema 缓存刷新失败");
                index += 1;
                progress(
                    format!("跳过：{}", conn.name),
                    index,
                    total,
                    None,
                    None,
                );
                continue;
            }
        };
        let mut cache_dbs = Vec::new();
        for db_name in databases.into_iter().take(50) {
            if cancel.load(Ordering::Relaxed) {
                return Err("任务已取消".to_string());
            }
            let tables = match crate::db::open_driver_for_connection(&conn, Some(db_name.clone())).await
            {
                Ok(driver) => driver.list_tables().await.unwrap_or_default(),
                Err(_) => Vec::new(),
            };
            cache_dbs.push(omnipanel_store::SchemaCacheDatabase {
                name: db_name,
                tables: tables
                    .into_iter()
                    .take(200)
                    .map(|name| omnipanel_store::SchemaCacheTable {
                        name,
                        columns: Vec::new(),
                        indexes: Vec::new(),
                        comment: None,
                    })
                    .collect(),
                views: Vec::new(),
                routines: Vec::new(),
                load_error: None,
                objects_loaded: true,
                key_count: None,
            });
        }
        let entry = omnipanel_store::SchemaCacheConnection {
            databases: cache_dbs,
            users: Vec::new(),
            refreshed_at: Some(
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            ),
            error: None,
        };
        snapshot.connections.insert(conn.id.clone(), entry);
        index += 1;
        progress(
            format!("已完成：{}", conn.name),
            index,
            total,
            None,
            None,
        );
    }
    omnipanel_store::save_schema_cache(&snapshot).map_err(|e| e.user_message())?;
    progress("Schema 缓存刷新完成".into(), total, total, None, None);
    Ok(())
}
