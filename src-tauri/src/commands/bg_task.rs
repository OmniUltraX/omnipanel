use omnipanel_error::OmniError;
use omnipanel_store::DbConnectionConfig;
use tauri::State;

use crate::background::db_sync_jobs::{
    batch_table_ddl, preview_schema_sync_sql, DbDataSyncSqlGenerateResult, DbSyncExecTableSpec,
    DbSyncSqlPreviewTable, DbSyncTableSpec, generate_data_sync_sql_script, read_sync_sql_file,
    run_db_data_sync_analysis, run_db_data_sync_execute, run_db_data_sync_sql_file_execute,
    run_db_schema_sync_analysis, run_db_schema_sync_execute,
};
use crate::background::knowledge_vector_jobs::run_knowledge_vectorize_background;
use crate::background::local_runtime_jobs::{
    run_ollama_install_background, run_ollama_pull_background,
};
use crate::background::schema_cache_jobs::run_db_schema_cache_refresh;
use crate::background::worker_pool::BackgroundTaskInfo;
use crate::commands::database::is_db_connection_enabled;
use crate::commands::knowledge_vector::KnowledgeVectorizeArgs;
use crate::state::AppState;

/// 列出当前正在运行的后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_list(state: State<'_, AppState>) -> Result<Vec<BackgroundTaskInfo>, OmniError> {
    Ok(state.worker_pool.list_running().await)
}

/// 取消后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_cancel(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    state
        .worker_pool
        .cancel_and_emit(&state.app_handle, &id)
        .await
}

/// 提交数据库数据同步对比分析后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_db_data_sync(
    state: State<'_, AppState>,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
    ignored_fields: Option<Vec<String>>,
) -> Result<String, OmniError> {
    let ignored_fields = ignored_fields.unwrap_or_default();
    let total = tables.len().max(1) as u32;
    let title = format!("数据同步对比分析（{total} 张表）");
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();

    pool.spawn(
        app.clone(),
        "database",
        "dbDataSyncAnalysis",
        title,
        total,
        move |task_id, cancel, progress| {
            run_db_data_sync_analysis(
                app,
                task_id,
                source,
                target,
                tables,
                ignored_fields,
                cancel,
                progress,
            )
        },
    )
    .await
}

/// 提交数据库结构同步对比分析后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_db_schema_sync(
    state: State<'_, AppState>,
    target: DbConnectionConfig,
    target_schema: String,
    tables: Vec<DbSyncTableSpec>,
) -> Result<String, OmniError> {
    let total = tables.len().max(1) as u32;
    let title = format!("结构同步对比分析（{total} 张表）");
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();

    pool.spawn(
        app.clone(),
        "database",
        "dbSchemaSyncAnalysis",
        title,
        total,
        move |task_id, cancel, progress| {
            run_db_schema_sync_analysis(
                app,
                task_id,
                target,
                target_schema,
                tables,
                cancel,
                progress,
            )
        },
    )
    .await
}

/// 提交知识库文档向量化后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_knowledge_vectorize(
    state: State<'_, AppState>,
    args: KnowledgeVectorizeArgs,
) -> Result<String, OmniError> {
    if args.provider.api_standard.to_lowercase() == "anthropic" {
        return Err(OmniError::invalid_input(
            "Anthropic 提供商暂不支持 embedding，请在设置中选用 OpenAI 兼容模型",
        ));
    }
    let title = {
        let storage = state.storage.lock().await;
        let entry = storage
            .get_knowledge(&args.entry_id)?
            .ok_or_else(|| OmniError::invalid_input("知识条目不存在"))?;
        if entry.node_type == "folder" {
            return Err(OmniError::invalid_input("文件夹不支持向量化，请选择文档"));
        }
        format!("文档向量化：{}", entry.title)
    };
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();
    let storage = state.storage.clone();

    pool.spawn(
        app.clone(),
        "knowledge",
        "knowledgeVectorize",
        title,
        1,
        move |task_id, cancel, progress| {
            run_knowledge_vectorize_background(app, storage, task_id, args, cancel, progress)
        },
    )
    .await
}

/// 提交 Ollama 授权安装后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_ollama_install(
    state: State<'_, AppState>,
) -> Result<String, OmniError> {
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();
    pool.spawn(
        app.clone(),
        "localModels",
        "ollamaInstall",
        "安装 Ollama",
        100,
        move |task_id, cancel, progress| {
            run_ollama_install_background(app, task_id, cancel, progress)
        },
    )
    .await
}

/// 提交 Ollama 模型拉取后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_ollama_pull(
    state: State<'_, AppState>,
    model: String,
) -> Result<String, OmniError> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err(OmniError::invalid_input("模型名不能为空"));
    }
    let title = format!("拉取模型：{model}");
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();
    let model_for_job = model.clone();
    pool.spawn(
        app.clone(),
        "localModels",
        "ollamaPull",
        title,
        100,
        move |task_id, cancel, progress| {
            run_ollama_pull_background(app, task_id, model_for_job, cancel, progress)
        },
    )
    .await
}

/// 提交数据库 Schema 缓存刷新后台任务。
/// `connection_ids` 为 `None` 时刷新全部已启用连接；否则仅刷新指定连接。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_db_schema_cache_refresh(
    state: State<'_, AppState>,
    connection_ids: Option<Vec<String>>,
) -> Result<String, OmniError> {
    let connections = state.db_connections.list()?;
    let target_count = connections
        .iter()
        .filter(|c| is_db_connection_enabled(c))
        .filter(|c| {
            connection_ids
                .as_ref()
                .is_none_or(|ids| ids.iter().any(|id| id == &c.id))
        })
        .count();
    let total = target_count.max(1) as u32;
    let title = match connection_ids.as_ref().map(|ids| ids.as_slice()) {
        Some([single_id]) => connections
            .iter()
            .find(|c| c.id == *single_id)
            .map(|c| format!("刷新 Schema：{}", c.name))
            .unwrap_or_else(|| "刷新 Schema 缓存".to_string()),
        Some(ids) if !ids.is_empty() => format!("刷新 Schema 缓存（{target_count} 个连接）"),
        _ => "刷新全部 Schema 缓存".to_string(),
    };
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();
    let ids = connection_ids;

    pool.spawn(
        app.clone(),
        "database",
        "dbSchemaCacheRefresh",
        title,
        total,
        move |task_id, cancel, progress| {
            run_db_schema_cache_refresh(app, connections, ids, task_id, cancel, progress)
        },
    )
    .await
}

/// 提交数据库数据同步执行后台任务（目标表不存在时自动建表）。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_db_data_sync_execute(
    state: State<'_, AppState>,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
) -> Result<String, OmniError> {
    let total = tables.len().max(1) as u32;
    let title = format!("数据同步（{} 张表）", tables.len());
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();

    pool.spawn(
        app.clone(),
        "database",
        "dbDataSyncExecute",
        title,
        total,
        move |task_id, cancel, progress| {
            run_db_data_sync_execute(app, task_id, source, target, tables, cancel, progress)
        },
    )
    .await
}

/// 生成数据同步可执行 SQL 脚本并写入缓存文件。
#[tauri::command]
#[specta::specta]
pub async fn db_data_sync_generate_sql(
    app: tauri::AppHandle,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncExecTableSpec>,
) -> Result<DbDataSyncSqlGenerateResult, OmniError> {
    Ok(generate_data_sync_sql_script(&app, source, target, tables).await?)
}

/// 结构同步：一次返回「表 → SQL 预览」（不执行）。
#[tauri::command]
#[specta::specta]
pub async fn db_schema_sync_preview_sql(
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    source_db: String,
    target_db: String,
    tables: Vec<DbSyncTableSpec>,
    create_missing_tables: Option<bool>,
) -> Result<Vec<DbSyncSqlPreviewTable>, OmniError> {
    Ok(preview_schema_sync_sql(
        source,
        target,
        source_db,
        target_db,
        tables,
        create_missing_tables.unwrap_or(true),
    )
    .await?)
}

/// 批量拉取建表 DDL（数据同步预览等）。
#[tauri::command]
#[specta::specta]
pub async fn db_batch_table_ddl(
    connection: DbConnectionConfig,
    schema: Option<String>,
    tables: Vec<String>,
) -> Result<Vec<DbSyncSqlPreviewTable>, OmniError> {
    Ok(batch_table_ddl(connection, schema, tables).await?)
}

/// 读取数据同步 SQL 缓存文件（仅限 app_cache/data-sync-sql 目录）。
#[tauri::command]
#[specta::specta]
pub async fn db_data_sync_read_sql_file(
    app: tauri::AppHandle,
    file_path: String,
) -> Result<String, OmniError> {
    Ok(read_sync_sql_file(&app, &file_path)?)
}

/// 提交数据同步 SQL 文件执行后台任务。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_db_data_sync_sql_execute(
    state: State<'_, AppState>,
    target: DbConnectionConfig,
    sql_file_path: String,
    table_names: Vec<String>,
) -> Result<String, OmniError> {
    let total = table_names.len().max(1) as u32;
    let title = if table_names.len() == 1 {
        format!("执行同步 SQL：{}", table_names[0])
    } else {
        format!("执行同步 SQL（{} 张表）", table_names.len())
    };
    let target_db = target.database.clone();
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();

    pool.spawn(
        app.clone(),
        "database",
        "dbDataSyncSqlExecute",
        title,
        total,
        move |task_id, cancel, progress| {
            run_db_data_sync_sql_file_execute(
                app,
                task_id,
                target,
                target_db,
                sql_file_path,
                table_names,
                cancel,
                progress,
            )
        },
    )
    .await
}

/// 提交数据库结构同步执行后台任务（目标表不存在时自动建表）。
#[tauri::command]
#[specta::specta]
pub async fn bg_task_submit_db_schema_sync_execute(
    state: State<'_, AppState>,
    source: DbConnectionConfig,
    target: DbConnectionConfig,
    tables: Vec<DbSyncTableSpec>,
) -> Result<String, OmniError> {
    let total = tables.len().max(1) as u32;
    let title = format!("结构同步（{} 张表）", tables.len());
    let app = state.app_handle.clone();
    let pool = state.worker_pool.clone();

    pool.spawn(
        app.clone(),
        "database",
        "dbSchemaSyncExecute",
        title,
        total,
        move |task_id, cancel, progress| {
            run_db_schema_sync_execute(app, task_id, source, target, tables, cancel, progress)
        },
    )
    .await
}
