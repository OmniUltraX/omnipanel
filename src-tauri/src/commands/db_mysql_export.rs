use omnipanel_store::DbConnectionConfig;
use tauri::{AppHandle, State};

use crate::background::mysql_export_jobs::{
    copy_mysql_export_file, list_mysql_exports, run_mysql_export, MysqlExportDeployment,
    MysqlExportRecord,
};
use crate::commands::database::is_db_connection_enabled;
use crate::state::AppState;
use omnipanel_error::OmniError;

/// 列出指定 MySQL 连接的数据库导出记录。
#[tauri::command]
#[specta::specta]
pub async fn db_mysql_export_list(
    app: AppHandle,
    connection_id: String,
) -> Result<Vec<MysqlExportRecord>, OmniError> {
    Ok(list_mysql_exports(&app, &connection_id).map_err(OmniError::internal)?)
}

/// 将导出文件复制到用户指定路径（需已通过 save 对话框授权）。
#[tauri::command]
#[specta::specta]
pub async fn db_mysql_export_save_as(
    app: AppHandle,
    connection_id: String,
    export_id: String,
    dest_path: String,
) -> Result<String, OmniError> {
    Ok(
        copy_mysql_export_file(&app, &connection_id, &export_id, &dest_path)
            .map_err(OmniError::internal)?,
    )
}

/// 提交 MySQL 数据库导出后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_db_mysql_export(
    state: State<'_, AppState>,
    connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
) -> Result<String, OmniError> {
    if !is_db_connection_enabled(&connection) {
        return Err(OmniError::invalid_input("连接已关闭，无法导出"));
    }
    let db_type = connection.db_type.to_lowercase();
    if db_type != "mysql" && db_type != "mariadb" {
        return Err(OmniError::invalid_input("当前仅支持 MySQL / MariaDB 导出"));
    }

    let title = format!("导出数据库 {database_name}");
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();
    let ssh_pool = state.ssh_pool.clone();

    pool.spawn(
        app.clone(),
        "database",
        "dbMysqlExport",
        title,
        1,
        move |task_id, cancel, progress| {
            run_mysql_export(
                app,
                ssh_pool,
                task_id,
                connection,
                database_name,
                deployment,
                cancel,
                progress,
            )
        },
    )
    .await
}
