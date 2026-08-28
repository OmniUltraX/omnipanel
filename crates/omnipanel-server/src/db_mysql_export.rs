//! MySQL 导出/导入：薄适配层，核心逻辑在 `omnipanel-db-sync`。

use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use omnipanel_db_sync::{
    copy_mysql_export_file as shared_copy_mysql_export_file,
    delete_mysql_export as shared_delete_mysql_export,
    list_mysql_exports as shared_list_mysql_exports, run_mysql_export as shared_run_mysql_export,
    run_mysql_import as shared_run_mysql_import,
};
use omnipanel_store::DbConnectionConfig;

use crate::bus::EventBus;
use crate::db_sync_bridge::{mysql_export_sink, ssh_session_provider};
use crate::terminal::ServerState;

pub use omnipanel_db_sync::{MysqlExportDeployment, MysqlExportRecord, MysqlImportSource};

type ProgressCb = Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>;

pub fn list_mysql_exports(connection_id: &str) -> Result<Vec<MysqlExportRecord>, String> {
    shared_list_mysql_exports(connection_id)
}

pub fn delete_mysql_export(connection_id: &str, export_id: &str) -> Result<(), String> {
    shared_delete_mysql_export(connection_id, export_id)
}

pub fn copy_mysql_export_file(
    connection_id: &str,
    export_id: &str,
    dest_path: &str,
) -> Result<String, String> {
    shared_copy_mysql_export_file(connection_id, export_id, dest_path)
}

pub async fn run_mysql_export(
    state: Arc<ServerState>,
    bus: EventBus,
    task_id: String,
    connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    shared_run_mysql_export(
        mysql_export_sink(bus),
        ssh_session_provider(state),
        task_id,
        connection,
        database_name,
        deployment,
        cancel,
        progress,
    )
    .await
}

pub async fn run_mysql_import(
    state: Arc<ServerState>,
    bus: EventBus,
    task_id: String,
    connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
    source: MysqlImportSource,
    cancel: Arc<AtomicBool>,
    progress: ProgressCb,
) -> Result<(), String> {
    shared_run_mysql_import(
        mysql_export_sink(bus),
        ssh_session_provider(state),
        task_id,
        connection,
        database_name,
        deployment,
        source,
        cancel,
        progress,
    )
    .await
}
