//! 后台任务 IPC（列表 / 取消 / 历史 / 事件索引 / DB 同步与 MySQL 导入导出提交）。

use std::sync::Arc;

use omnipanel_error::OmniError;
use omnipanel_store::{BgTaskHistoryRecord, DbConnectionConfig, TaskEventFilter, TaskEventRecord};

use crate::bg_worker_pool::BackgroundTaskInfo;
use crate::db_mysql_export::{MysqlExportDeployment, MysqlImportSource};
use crate::db_sync::{DbSyncExecTableSpec, DbSyncTableSpec};
use crate::state::ServerState;
pub async fn bg_task_list(state: &ServerState) -> Result<Vec<BackgroundTaskInfo>, OmniError> {
    Ok(state.worker_pool.list_running().await)
}

pub async fn bg_task_cancel(state: &ServerState, id: String) -> Result<(), OmniError> {
    state.worker_pool.cancel(&id).await
}

pub async fn bg_task_history_list(
    state: &ServerState,
    limit: Option<u32>,
) -> Result<Vec<BgTaskHistoryRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_bg_task_history(limit.unwrap_or(200))
}

pub async fn task_events_list(
    state: &ServerState,
    module: Option<String>,
    workspace_id: Option<String>,
    resource_id: Option<String>,
    source: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<TaskEventRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_task_events(&TaskEventFilter {
        module,
        workspace_id,
        resource_id,
        source,
        limit: limit.unwrap_or(200),
    })
}

fn ensure_db_enabled(connection: &DbConnectionConfig) -> Result<(), OmniError> {
    if !connection.enabled {
        return Err(OmniError::invalid_input("连接已关闭，无法执行"));
    }
    Ok(())
}

/// 提交数据库数据同步对比分析后台任务。
pub async fn bg_task_submit_db_data_sync(
    state: &ServerState,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
    ignored_fields: Option<Vec<String>>,
) -> Result<String, OmniError> {
    ensure_db_enabled(&source)?;
    ensure_db_enabled(&target)?;
    let ignored_fields = ignored_fields.unwrap_or_default();
    let total = tables.len().max(1) as u32;
    let title = format!("数据同步对比分析（{total} 张表）");
    let pool = state.worker_pool.clone();
    let bus = state.bus.clone();

    pool.spawn(
        "database",
        "dbDataSyncAnalysis",
        title,
        total,
        move |task_id, cancel, progress| {
            crate::db_sync::run_db_data_sync_analysis(
                bus,
                task_id,
                source,
                target,
                tables,
                ignored_fields,
                cancel,
                progress,
            )
        },
    )    .await
}

/// 提交数据库数据同步执行后台任务。
pub async fn bg_task_submit_db_data_sync_execute(
    state: &ServerState,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
) -> Result<String, OmniError> {
    ensure_db_enabled(&source)?;
    ensure_db_enabled(&target)?;
    let total = tables.len().max(1) as u32;
    let title = format!("数据同步（{} 张表）", tables.len());
    let pool = state.worker_pool.clone();
    let bus = state.bus.clone();

    pool.spawn(
        "database",
        "dbDataSyncExecute",
        title,
        total,
        move |task_id, cancel, progress| {
            crate::db_sync::run_db_data_sync_execute(
                bus, task_id, source, target, tables, cancel, progress,
            )
        },
    )    .await
}

/// 提交数据同步 SQL 文件执行后台任务。
pub async fn bg_task_submit_db_data_sync_sql_execute(
    state: &ServerState,
    target: DbConnectionConfig,
    sql_file_path: String,
    table_names: Vec<String>,
) -> Result<String, OmniError> {
    ensure_db_enabled(&target)?;
    let total = table_names.len().max(1) as u32;
    let title = if table_names.len() == 1 {
        format!("执行同步 SQL：{}", table_names[0])
    } else {
        format!("执行同步 SQL（{} 张表）", table_names.len())
    };
    let pool = state.worker_pool.clone();
    let bus = state.bus.clone();
    let target_db = target.database.clone();

    pool.spawn(
        "database",
        "dbDataSyncSqlExecute",
        title,
        total,
        move |task_id, cancel, progress| {
            crate::db_sync::run_db_data_sync_sql_file_execute(
                bus,
                task_id,
                target,
                target_db,
                sql_file_path,
                table_names,
                cancel,
                progress,
            )
        },
    )    .await
}

/// 提交 MySQL 数据库导出后台任务。
pub async fn bg_task_submit_db_mysql_export(
    state: &Arc<ServerState>,
    connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
) -> Result<String, OmniError> {    ensure_db_enabled(&connection)?;
    let db_type = connection.db_type.to_lowercase();
    if db_type != "mysql" && db_type != "mariadb" {
        return Err(OmniError::invalid_input("当前仅支持 MySQL / MariaDB 导出"));
    }

    let title = format!("导出数据库 {database_name}");
    let pool = state.worker_pool.clone();
    let server = Arc::clone(state);
    let bus = state.bus.clone();

    pool.spawn(
        "database",
        "dbMysqlExport",
        title,
        1,
        move |task_id, cancel, progress| {
            crate::db_mysql_export::run_mysql_export(
                server,
                bus,
                task_id,
                connection,
                database_name,
                deployment,
                cancel,
                progress,
            )
        },
    )    .await
}

/// 提交 MySQL SQL 导入后台任务。
pub async fn bg_task_submit_db_mysql_import(
    state: &Arc<ServerState>,
    connection: DbConnectionConfig,
    database_name: String,
    deployment: MysqlExportDeployment,
    source: MysqlImportSource,
) -> Result<String, OmniError> {    ensure_db_enabled(&connection)?;
    let db_type = connection.db_type.to_lowercase();
    if db_type != "mysql" && db_type != "mariadb" {
        return Err(OmniError::invalid_input("当前仅支持 MySQL / MariaDB 导入"));
    }

    let title = format!("导入数据库 {database_name}");
    let pool = state.worker_pool.clone();
    let server = Arc::clone(state);
    let bus = state.bus.clone();

    pool.spawn(
        "database",
        "dbMysqlImport",
        title,
        1,
        move |task_id, cancel, progress| {
            crate::db_mysql_export::run_mysql_import(
                server,
                bus,
                task_id,
                connection,
                database_name,
                deployment,
                source,
                cancel,
                progress,
            )
        },
    )    .await
}

/// 提交数据库结构同步对比分析后台任务。
pub async fn bg_task_submit_db_schema_sync(
    state: &ServerState,
    target: DbConnectionConfig,
    target_schema: String,
    tables: Vec<DbSyncTableSpec>,
) -> Result<String, OmniError> {
    ensure_db_enabled(&target)?;
    let total = tables.len().max(1) as u32;
    let title = format!("结构同步对比分析（{total} 张表）");
    let pool = state.worker_pool.clone();
    let bus = state.bus.clone();

    pool.spawn(
        "database",
        "dbSchemaSyncAnalysis",
        title,
        total,
        move |task_id, cancel, progress| {
            crate::db_sync::run_db_schema_sync_analysis(
                bus,
                task_id,
                target,
                target_schema,
                tables,
                cancel,
                progress,
            )
        },
    )    .await
}

/// 提交数据库结构同步执行后台任务。
pub async fn bg_task_submit_db_schema_sync_execute(
    state: &ServerState,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
) -> Result<String, OmniError> {
    ensure_db_enabled(&source)?;
    ensure_db_enabled(&target)?;
    let total = tables.len().max(1) as u32;
    let title = format!("结构同步（{} 张表）", tables.len());
    let pool = state.worker_pool.clone();
    let bus = state.bus.clone();

    pool.spawn(
        "database",
        "dbSchemaSyncExecute",
        title,
        total,
        move |task_id, cancel, progress| {
            crate::db_sync::run_db_schema_sync_execute(
                bus, task_id, source, target, tables, cancel, progress,
            )
        },
    )    .await
}

/// 提交 Schema 缓存刷新后台任务。
pub async fn bg_task_submit_db_schema_cache_refresh(
    state: &ServerState,
    connection_ids: Option<Vec<String>>,
) -> Result<String, OmniError> {
    let connections = state
        .db_connections
        .list()
        .map_err(|e| OmniError::internal(e.to_string()))?;
    let filtered: Vec<_> = connections
        .into_iter()
        .filter(|c| c.enabled)
        .filter(|c| {
            connection_ids
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| id == &c.id))
        })
        .collect();
    let target_count = filtered.len();
    let total = target_count.max(1) as u32;
    let title = match connection_ids.as_ref().map(|ids| ids.as_slice()) {
        Some([single_id]) => filtered
            .iter()
            .find(|c| c.id == *single_id)
            .map(|c| format!("刷新 Schema：{}", c.name))
            .unwrap_or_else(|| "刷新 Schema 缓存".to_string()),
        Some(ids) if !ids.is_empty() => format!("刷新 Schema 缓存（{target_count} 个连接）"),
        _ => "刷新全部 Schema 缓存".to_string(),
    };
    let pool = state.worker_pool.clone();
    let bus = state.bus.clone();

    pool.spawn(
        "database",
        "dbSchemaCacheRefresh",
        title,
        total,
        move |task_id, cancel, progress| {
            crate::db_sync::run_db_schema_cache_refresh(
                bus, task_id, filtered, cancel, progress,
            )
        },
    )
    .await
}

/// 提交 Ollama 安装后台任务。
pub async fn bg_task_submit_ollama_install(state: &ServerState) -> Result<String, OmniError> {
    let pool = state.worker_pool.clone();
    pool.spawn(
        "localModels",
        "ollamaInstall",
        "安装 Ollama",
        100,
        move |_task_id, cancel, progress| async move {
            crate::local_runtime_cmds::install_ollama_with_progress(cancel, progress)
                .await
                .map(|_| ())
        },
    )
    .await
}

/// 提交 Ollama 模型拉取后台任务。
pub async fn bg_task_submit_ollama_pull(
    state: &ServerState,
    model: String,
) -> Result<String, OmniError> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err(OmniError::invalid_input("模型名不能为空"));
    }
    let title = format!("拉取模型：{model}");
    let pool = state.worker_pool.clone();
    let model_for_job = model.clone();
    pool.spawn(
        "localModels",
        "ollamaPull",
        title,
        100,
        move |_task_id, cancel, progress| async move {
            crate::local_runtime_cmds::pull_ollama_with_progress(model_for_job, cancel, progress)
                .await
                .map(|_| ())
        },
    )
    .await
}

/// Web 端知识库向量化占位（桌面端完整实现）。
pub async fn bg_task_submit_knowledge_vectorize(
    _state: &ServerState,
    _args: serde_json::Value,
) -> Result<String, OmniError> {
    Err(OmniError::invalid_input(
        "Web 端暂未接入知识库向量化，请使用桌面端",
    ))
}
