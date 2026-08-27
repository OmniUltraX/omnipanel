//! 数据库同步与 MySQL 导出/导入共享逻辑（无 Tauri 依赖）。

pub mod db_ops;
pub mod event;
pub mod jobs;
pub mod mysql;
pub mod paths;
pub mod row_diff_cache;
pub mod util;

pub use db_ops::{
    TableInfo, db_count_table, db_introspect_table_op, db_list_tables, db_preview_table,
    db_run_sql, db_table_ddl_op, open_db_driver, query_result_to_row_maps, to_params,
    to_table_info, with_schema,
};
pub use event::{
    BgTaskDbEvent, BgTaskMysqlExportEvent, DbSyncEventSink, MysqlExportEventSink,
    MysqlExportRecord, SchemaColumnDiffPayload, SchemaCompareEvent, SchemaIndexDiffPayload,
    SyncExecResultEvent, TableCountEvent, TableRowCompareEvent,
};
pub use jobs::{
    DataSyncModes, DbDataSyncSqlGenerateResult, DbSyncExecTableSpec, DbSyncSqlPreviewTable,
    DbSyncTableSpec, batch_table_ddl, generate_data_sync_sql_script, preview_schema_sync_sql,
    run_db_data_sync_analysis, run_db_data_sync_execute, run_db_data_sync_sql_file_execute,
    run_db_schema_sync_analysis, run_db_schema_sync_execute,
};
pub use mysql::{
    MysqlExportDeployment, MysqlImportSource, SshSessionProvider, copy_mysql_export_file,
    delete_mysql_export, list_mysql_exports, resolve_export_record, run_mysql_export,
    run_mysql_import,
};
pub use paths::{
    connection_exports_dir, exports_root, read_sync_sql_file, row_diff_cache_dir,
    save_sync_sql_file, sync_sql_dir,
};
pub use row_diff_cache::{
    RowDiffKindCounts, RowDiffPageResult, TableRowDiffPayload, build_row_diff_cache_id,
    load_row_diff_cache_all, row_diff_page, save_row_diff_cache,
};
pub use util::default_worker_count;
