//! Tauri 薄适配：转发至 `omnipanel-db-sync`。

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use omnipanel_db_sync::{
    batch_table_ddl as shared_batch_table_ddl,
    generate_data_sync_sql_script as shared_generate_data_sync_sql_script,
    preview_schema_sync_sql as shared_preview_schema_sync_sql,
    read_sync_sql_file as shared_read_sync_sql_file,
    run_db_data_sync_analysis as shared_run_db_data_sync_analysis,
    run_db_data_sync_execute as shared_run_db_data_sync_execute,
    run_db_data_sync_sql_file_execute as shared_run_db_data_sync_sql_file_execute,
    run_db_schema_sync_analysis as shared_run_db_schema_sync_analysis,
    run_db_schema_sync_execute as shared_run_db_schema_sync_execute,
    save_sync_sql_file as shared_save_sync_sql_file,
};
use omnipanel_store::DbConnectionConfig;
use tauri::AppHandle;

use crate::background::db_sync_bridge::db_sync_sink;

pub use omnipanel_db_sync::{
    row_diff_cache::TableRowDiffPayload, DataSyncModes, DbDataSyncSqlGenerateResult,
    DbSyncExecTableSpec, DbSyncSqlPreviewTable, DbSyncTableSpec,
};

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
    shared_run_db_data_sync_analysis(
        db_sync_sink(app),
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

pub async fn run_db_schema_sync_analysis(
    app: AppHandle,
    task_id: String,
    target: DbConnectionConfig,
    target_schema: String,
    tables: Vec<DbSyncTableSpec>,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    shared_run_db_schema_sync_analysis(
        db_sync_sink(app),
        task_id,
        target,
        target_schema,
        tables,
        cancel,
        progress,
    )
    .await
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
    shared_run_db_data_sync_execute(
        db_sync_sink(app),
        task_id,
        source,
        target,
        tables,
        cancel,
        progress,
    )
    .await
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
    shared_run_db_schema_sync_execute(
        db_sync_sink(app),
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
    app: AppHandle,
    task_id: String,
    target: DbConnectionConfig,
    target_db: String,
    sql_file_path: String,
    table_names: Vec<String>,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    shared_run_db_data_sync_sql_file_execute(
        db_sync_sink(app),
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

pub async fn generate_data_sync_sql_script(
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
) -> Result<DbDataSyncSqlGenerateResult, String> {
    shared_generate_data_sync_sql_script(source, target, tables).await
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

pub async fn batch_table_ddl(
    connection: DbConnectionConfig,
    schema: Option<String>,
    tables: Vec<String>,
) -> Result<Vec<DbSyncSqlPreviewTable>, String> {
    shared_batch_table_ddl(connection, schema, tables).await
}

pub fn read_sync_sql_file(file_path: &str) -> Result<String, String> {
    shared_read_sync_sql_file(file_path)
}

pub fn save_sync_sql_file(sql: &str) -> Result<String, String> {
    shared_save_sync_sql_file(sql)
}
