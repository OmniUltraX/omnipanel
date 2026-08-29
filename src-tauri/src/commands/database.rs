use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use omnipanel_db::{
    CreateDatabaseArgs, DbCharsetMeta, DbDatabaseMeta, DbIntrospectResult, DbNamedTableDetails,
    DbParams, DbTableDetails, DbTableSchema, DbUserMeta, QueryResult, RedisAclUser,
    RedisInfoResult, RedisKeyDetail, RedisMemoryStats, RedisSearchKeysResult, RedisSlowLogEntry,
    RedisStreamConsumer, RedisStreamConsumerCleanupResult, RedisStreamGroup,
    RedisStreamMonitorSnapshot, RedisStreamPendingEntry, RedisStreamRangeResult,
    mysql_connect_options, postgres_connect_options, redis_stream_cleanup_inactive_consumers,
};
use omnipanel_error::OmniError;
pub use omnipanel_store::{
    DbConnectionConfig, SchemaCacheColumn, SchemaCacheConnection, SchemaCacheDatabase,
    SchemaCacheIndex, SchemaCacheRoutine, SchemaCacheSnapshot, SchemaCacheTable, SchemaCacheUser,
    SchemaFiltersSnapshot, SchemaTreeExpandedSnapshot, ensure_creator_tag, load_schema_cache,
    load_schema_filters, load_schema_tree_expanded, patch_schema_cache_connection,
    prune_connection_cache, prune_connection_expanded, prune_connection_filters,
    save_schema_cache, save_schema_filters, save_schema_tree_expanded,
};
use serde::{Deserialize, Serialize};
use sqlx::mysql::{MySqlPool, MySqlPoolOptions};
use sqlx::postgres::{PgPool, PgPoolOptions};
use tauri::State;
use tokio::sync::Mutex;

use crate::state::AppState;

/// 进程内复用 sqlx 连接池：避免每次查询都 TCP+认证+close（重启后首次点库会卡数秒）。
struct SqlxPoolCache {
    mysql: HashMap<String, (String, MySqlPool)>,
    pg: HashMap<String, (String, PgPool)>,
    /// Per-key establishment locks to prevent concurrent pool creation race
    mysql_establishing: HashMap<String, Arc<Mutex<()>>>,
    pg_establishing: HashMap<String, Arc<Mutex<()>>>,
}

fn sqlx_pool_cache() -> &'static Mutex<SqlxPoolCache> {
    static CACHE: OnceLock<Mutex<SqlxPoolCache>> = OnceLock::new();
    CACHE.get_or_init(|| {
        Mutex::new(SqlxPoolCache {
            mysql: HashMap::new(),
            pg: HashMap::new(),
            mysql_establishing: HashMap::new(),
            pg_establishing: HashMap::new(),
        })
    })
}

fn pool_fingerprint(connection: &DbConnectionConfig) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}|{}",
        connection.db_type,
        connection.host,
        connection.port,
        connection.user,
        connection.password,
        connection.database,
        connection.ssl
    )
}

/// MySQL 连接池按「主机凭据」复用，不按当前选中的 database 拆分。
/// information_schema / `db.table` 查询会显式绑定库名；若把 database 打进 fingerprint，
/// 结构同步源/目标同机不同库、或侧栏与工具箱并发 introspect 时会互相 close 对方仍在用的池。
fn mysql_pool_fingerprint(connection: &DbConnectionConfig) -> String {
    format!(
        "{}|{}|{}|{}|{}|{}",
        connection.db_type,
        connection.host,
        connection.port,
        connection.user,
        connection.password,
        connection.ssl
    )
}

/// 从缓存移除旧池时不要立刻 `close()`：其它任务可能仍持有同一 Pool 的 Arc，
/// 提前 close 会让进行中的查询报 “attempted to acquire a connection on a closed pool”。
/// 交给 Arc 自然 drop；空闲连接由 sqlx idle_timeout 回收即可。
fn abandon_stale_pool<C: sqlx::Database>(pool: sqlx::Pool<C>) {
    drop(pool);
}

#[derive(Debug, Serialize, Deserialize, specta::Type)]
pub struct TableInfo {
    pub name: String,
    /// `serde_json::Value` 含 i64 Number，specta 需标成 Any 才能导出。
    #[specta(type = Vec<HashMap<String, specta_typescript::Any>>)]
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    pub columns: Vec<String>,
}

/// IPC 用查询结果（与领域 `QueryResult` 同形；rows 导出为 Any 避免 BigInt 禁令）。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub columns: Vec<String>,
    #[specta(type = Vec<Vec<specta_typescript::Any>>)]
    pub rows: Vec<Vec<serde_json::Value>>,
    #[specta(type = f64)]
    pub rows_affected: u64,
}

fn to_db_query_result(result: QueryResult) -> DbQueryResult {
    DbQueryResult {
        columns: result.columns,
        rows: result.rows,
        rows_affected: result.rows_affected,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TableRowCount {
    pub name: String,
    /// 统计成功时为行数；单表失败时为 `null`（如视图、权限不足）。
    #[specta(type = Option<f64>)]
    pub count: Option<i64>,
}

/// 将领域错误转为前端可读文案（含底层 cause）。
fn err_msg(e: OmniError) -> String {
    e.user_message()
}

/// 将 IPC 连接配置转换为 omnipanel-db 的领域连接参数。
pub(crate) fn to_params(c: &DbConnectionConfig) -> DbParams {
    let mut c = c.clone();
    omnipanel_store::fill_db_password_from_vault(&mut c);
    DbParams {
        db_type: c.db_type.clone(),
        host: c.host.clone(),
        port: c.port,
        user: c.user.clone(),
        password: c.password.clone(),
        database: c.database.clone(),
        ssl: c.ssl,
        sid: c.sid.clone(),
        sysdba: c.sysdba,
    }
}

async fn mysql_pool(connection: &DbConnectionConfig) -> Result<MySqlPool, String> {
    let key = connection.id.clone();
    let fingerprint = mysql_pool_fingerprint(connection);

    // Fast path: check cache
    {
        let cache = sqlx_pool_cache().lock().await;
        if let Some((cached_fp, pool)) = cache.mysql.get(&key) {
            if cached_fp == &fingerprint {
                return Ok(pool.clone());
            }
        }
    }

    // Get or create per-key establishment lock (prevents concurrent pool creation race)
    let establish_lock = {
        let mut cache = sqlx_pool_cache().lock().await;
        cache
            .mysql_establishing
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };

    // Hold per-key lock during establishment — other callers for same key will wait here
    let _guard = establish_lock.lock().await;

    // Double-check: another caller may have established the pool while we waited
    {
        let cache = sqlx_pool_cache().lock().await;
        if let Some((cached_fp, pool)) = cache.mysql.get(&key) {
            if cached_fp == &fingerprint {
                return Ok(pool.clone());
            }
        }
    }

    // 共享池不绑定具体 database，避免与 fingerprint（不含 database）语义不一致
    let mut params = to_params(connection);
    params.database.clear();
    let opts = mysql_connect_options(&params);
    let pool = MySqlPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Some(Duration::from_secs(300)))
        .connect_with(opts)
        .await
        .map_err(|e| format!("MySQL 连接失败: {e}"))?;

    let mut cache = sqlx_pool_cache().lock().await;
    if let Some((cached_fp, existing)) = cache.mysql.get(&key) {
        if cached_fp == &fingerprint {
            return Ok(existing.clone());
        }
        let stale = cache.mysql.remove(&key);
        drop(cache);
        if let Some((_, stale_pool)) = stale {
            abandon_stale_pool(stale_pool);
        }
        let mut cache = sqlx_pool_cache().lock().await;
        cache.mysql.insert(key, (fingerprint, pool.clone()));
        return Ok(pool);
    }
    cache.mysql.insert(key, (fingerprint, pool.clone()));
    Ok(pool)
}

async fn pg_pool(connection: &DbConnectionConfig) -> Result<PgPool, String> {
    let key = connection.id.clone();
    let fingerprint = pool_fingerprint(connection);

    // Fast path: check cache
    {
        let cache = sqlx_pool_cache().lock().await;
        if let Some((cached_fp, pool)) = cache.pg.get(&key) {
            if cached_fp == &fingerprint {
                return Ok(pool.clone());
            }
        }
    }

    // Per-key establishment lock (prevents concurrent pool creation race)
    let establish_lock = {
        let mut cache = sqlx_pool_cache().lock().await;
        cache
            .pg_establishing
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = establish_lock.lock().await;

    // Double-check
    {
        let cache = sqlx_pool_cache().lock().await;
        if let Some((cached_fp, pool)) = cache.pg.get(&key) {
            if cached_fp == &fingerprint {
                return Ok(pool.clone());
            }
        }
    }

    let p = to_params(connection);
    let opts = postgres_connect_options(&p);
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Some(Duration::from_secs(300)))
        .connect_with(opts)
        .await
        .map_err(|e| format!("PostgreSQL 连接失败: {e}"))?;

    let mut cache = sqlx_pool_cache().lock().await;
    if let Some((cached_fp, existing)) = cache.pg.get(&key) {
        if cached_fp == &fingerprint {
            return Ok(existing.clone());
        }
        let stale = cache.pg.remove(&key);
        drop(cache);
        if let Some((_, stale_pool)) = stale {
            abandon_stale_pool(stale_pool);
        }
        let mut cache = sqlx_pool_cache().lock().await;
        cache.pg.insert(key, (fingerprint, pool.clone()));
        return Ok(pool);
    }
    cache.pg.insert(key, (fingerprint, pool.clone()));
    Ok(pool)
}

fn with_schema(c: &DbConnectionConfig, schema: Option<String>) -> DbParams {
    let mut params = to_params(c);
    if let Some(s) = schema.filter(|name| !name.trim().is_empty()) {
        params.database = s;
    }
    params
}

async fn evict_sidecar_agent(connection: &DbConnectionConfig) {
    let params = to_params(connection);
    if let Some(launch) = omnipanel_db::sidecar::launch_for_params(&params) {
        omnipanel_db::sidecar::evict_launch(&launch, &params).await;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<DbConnectionConfig>, String> {
    state.db_connections.list().map_err(|e| e.to_string())
}

/// 编辑连接表单：从 Vault 取回明文密码（列表接口永不返回明文）。
#[tauri::command]
#[specta::specta]
pub async fn db_get_connection_secret(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("连接 id 为空".to_string());
    }
    let conn = state
        .db_connections
        .get_with_secret(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "连接不存在".to_string())?;
    Ok(conn.password)
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_connection(
    state: State<'_, AppState>,
    mut connection: DbConnectionConfig,
) -> Result<DbConnectionConfig, String> {
    let mut existed = false;
    if !connection.id.trim().is_empty() {
        if let Ok(Some(old)) = state.db_connections.get_with_secret(&connection.id) {
            existed = true;
            evict_sidecar_agent(&old).await;
        }
    }
    // 新建连接时打 creator 标签，标记创建设备
    if !existed {
        ensure_creator_tag(
            &mut connection.tags,
            &crate::commands::auth::current_device_name(),
        );
    }
    state
        .db_connections
        .save(connection)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Ok(Some(conn)) = state.db_connections.get_with_secret(&id) {
        evict_sidecar_agent(&conn).await;
    }
    state
        .db_connections
        .delete(&id)
        .map_err(|e| e.to_string())?;
    {
        let storage = state.storage.lock().await;
        let _ = storage.clear_resource_tags(omnipanel_store::TaggableKind::Connection, &id);
    }
    let mut filters = load_schema_filters().map_err(|e| e.to_string())?;
    prune_connection_filters(&mut filters, &id);
    save_schema_filters(&filters).map_err(|e| e.to_string())?;
    let mut expanded = load_schema_tree_expanded().map_err(|e| e.to_string())?;
    prune_connection_expanded(&mut expanded, &id);
    save_schema_tree_expanded(&expanded).map_err(|e| e.to_string())?;
    let mut cache = load_schema_cache().map_err(|e| e.to_string())?;
    prune_connection_cache(&mut cache, &id);
    save_schema_cache(&cache).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn db_load_schema_filters() -> Result<SchemaFiltersSnapshot, String> {
    load_schema_filters().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_schema_filters(snapshot: SchemaFiltersSnapshot) -> Result<(), String> {
    save_schema_filters(&snapshot).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_load_schema_tree_expanded() -> Result<SchemaTreeExpandedSnapshot, String> {
    load_schema_tree_expanded().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_schema_tree_expanded(
    snapshot: SchemaTreeExpandedSnapshot,
) -> Result<(), String> {
    save_schema_tree_expanded(&snapshot).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_load_schema_cache() -> Result<SchemaCacheSnapshot, String> {
    load_schema_cache().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_schema_cache(snapshot: SchemaCacheSnapshot) -> Result<(), String> {
    save_schema_cache(&snapshot).map_err(|e| e.to_string())
}

/// 增量写入单连接 Schema 缓存，避免前端每次传完整快照。
#[tauri::command]
#[specta::specta]
pub async fn db_patch_schema_cache(
    connection_id: String,
    entry: SchemaCacheConnection,
) -> Result<SchemaCacheConnection, String> {
    patch_schema_cache_connection(&connection_id, entry).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_test_connection(mut connection: DbConnectionConfig) -> Result<String, String> {
    omnipanel_store::fill_db_password_from_vault(&mut connection);
    let db_type = connection.db_type.to_lowercase();
    // MySQL/MariaDB 复用 mysql_pool 缓存，避免与 listDatabases 等查询建立两个独立连接池
    if matches!(db_type.as_str(), "mysql" | "mariadb") {
        let pool = mysql_pool(&connection).await?;
        let row: (String,) = sqlx::query_as("SELECT VERSION()")
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
        return Ok(row.0);
    }
    if matches!(db_type.as_str(), "postgresql" | "postgres") {
        let pool = pg_pool(&connection).await?;
        let row: (String,) = sqlx::query_as("SELECT version()")
            .fetch_one(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
        return Ok(row.0);
    }
    let mut params = to_params(&connection);
    if matches!(db_type.as_str(), "mongodb" | "mongo") && params.database.trim().is_empty() {
        params.database = "admin".to_string();
    }
    if db_type == "qdrant" && params.database.trim().is_empty() {
        params.database = "default".to_string();
    }
    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
    driver.version().await.map_err(err_msg)
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_databases(connection: DbConnectionConfig) -> Result<Vec<String>, String> {
    omnipanel_db::db_list_databases(connection).await
}

/// 库列表（含统计信息）：库名 / 字符集 / 排序规则 / 表数 / 大小 / 行数
/// 单条 LEFT JOIN 查询，避免 N+1
#[tauri::command]
#[specta::specta]
pub async fn db_list_databases_with_stats(
    connection: DbConnectionConfig,
) -> Result<Vec<DbDatabaseMeta>, String> {
    omnipanel_db::db_list_databases_with_stats(connection).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_character_sets(
    connection: DbConnectionConfig,
) -> Result<Vec<DbCharsetMeta>, String> {
    omnipanel_db::db_list_character_sets(connection).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_create_database(args: CreateDatabaseArgs) -> Result<String, String> {
    omnipanel_db::db_create_database(args).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_introspect_schema(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<DbIntrospectResult, String> {
    omnipanel_db::db_introspect_schema(connection, schema).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_connection_users(
    connection: DbConnectionConfig,
) -> Result<Vec<DbUserMeta>, String> {
    omnipanel_db::db_list_connection_users(connection).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_introspect_table(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<DbTableSchema, String> {
    omnipanel_db::db_introspect_table(connection, schema, table).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_table_ddl(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<String, String> {
    omnipanel_db::db_table_ddl(connection, schema, table).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_get_table_details(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<DbTableDetails, String> {
    omnipanel_db::db_get_table_details(connection, schema, table).await
}

/// 一次拉取库内全部表详情（表列表首屏用；避免逐表建连）。
#[tauri::command]
#[specta::specta]
pub async fn db_list_table_details(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<Vec<DbNamedTableDetails>, String> {
    omnipanel_db::db_list_table_details(connection, schema).await
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_tables(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<Vec<String>, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
    driver.list_tables().await.map_err(err_msg)
}

#[tauri::command]
#[specta::specta]
pub async fn db_preview_table(
    connection: DbConnectionConfig,
    table: String,
    limit: u32,
    offset: u32,
    order_by: Option<String>,
    where_clause: Option<String>,
) -> Result<TableInfo, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(err_msg)?;
    let result = driver
        .preview(
            &table,
            limit as i64,
            offset as i64,
            order_by.as_deref(),
            where_clause.as_deref(),
        )
        .await
        .map_err(err_msg)?;
    Ok(to_table_info(table, result))
}

#[tauri::command]
#[specta::specta]
pub async fn db_count_table(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
    where_clause: Option<String>,
) -> Result<f64, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
    driver
        .count(table.trim(), where_clause.as_deref())
        .await
        .map_err(err_msg)
        .map(|n| n as f64)
}

/// 在同一连接上顺序统计多表行数，避免前端并发 `db_count_table` 打满连接池。
#[tauri::command]
#[specta::specta]
pub async fn db_count_tables(
    connection: DbConnectionConfig,
    schema: Option<String>,
    tables: Vec<String>,
) -> Result<Vec<TableRowCount>, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
    let mut out = Vec::with_capacity(tables.len());
    for name in tables {
        let trimmed = name.trim().to_string();
        if trimmed.is_empty() {
            continue;
        }
        let count = driver.count(&trimmed, None).await.ok();
        out.push(TableRowCount {
            name: trimmed,
            count,
        });
    }
    Ok(out)
}

/// 执行任意 SQL（SELECT 返回行集，DML 返回影响行数）。高风险写操作由前端经执行引擎确认后调用。
/// `limit` / `offset` 非零时，SELECT/WITH 语句会被包裹为 `SELECT * FROM (...) LIMIT n OFFSET m`，防止超大结果集卡死前端。
/// `run_id` 供前端中断长时间查询（`db_cancel_query`）。
#[tauri::command]
#[specta::specta]
pub async fn db_execute_query(
    state: tauri::State<'_, crate::state::AppState>,
    connection: DbConnectionConfig,
    sql: String,
    run_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
    presence_token: Option<String>,
) -> Result<DbQueryResult, String> {
    let danger_grant = match omnipanel_presence::ensure_sql_presence(
        &state.presence_tokens,
        &sql,
        &connection.id,
        &connection.database,
        presence_token.as_deref(),
    ) {
        Ok(v) => v,
        Err(e) => {
            crate::commands::db_danger::append_danger_audit(
                &state,
                "db.sql.dangerous",
                &connection.id,
                "blocked",
                "token 无效",
            );
            return Err(e.to_string());
        }
    };
    let wrapped = match limit {
        Some(n) if n > 0 => omnipanel_db::wrap_editor_query(
            &connection.db_type,
            &sql,
            n as i64,
            offset.unwrap_or(0) as i64,
        ),
        _ => sql,
    };
    let params = to_params(&connection);
    let handle = tokio::spawn(async move {
        let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
        driver.execute(&wrapped).await.map_err(err_msg)
    });
    let abort_handle = handle.abort_handle();
    state
        .running_db_queries
        .lock()
        .await
        .insert(run_id.clone(), abort_handle);

    let result = match handle.await {
        Ok(inner) => inner,
        Err(join_err) if join_err.is_cancelled() => Err("查询已中断".to_string()),
        Err(join_err) => Err(format!("查询任务失败: {join_err}")),
    };

    state.running_db_queries.lock().await.remove(&run_id);
    if let Some((action, target)) = danger_grant {
        let status = if result.is_ok() { "success" } else { "failed" };
        crate::commands::db_danger::append_danger_audit(&state, &action, &target, status, "verified");
    }
    result.map(to_db_query_result)
}

/// 中断正在执行的 SQL 查询（按 run_id，与 db_execute_query 配对）。
#[tauri::command]
#[specta::specta]
pub async fn db_cancel_query(
    state: tauri::State<'_, crate::state::AppState>,
    run_id: String,
) -> Result<(), String> {
    let abort_handle = state.running_db_queries.lock().await.remove(&run_id);
    match abort_handle {
        Some(handle) => {
            handle.abort();
            Ok(())
        }
        None => Err("无运行中的查询".to_string()),
    }
}

/// 在手动事务会话中执行 SQL（session_id 通常为 SQL Tab id）。
/// 首次执行时自动 BEGIN；失败不自动 ROLLBACK。
#[tauri::command]
#[specta::specta]
pub async fn db_execute_query_in_session(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
    connection: DbConnectionConfig,
    sql: String,
    run_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
    presence_token: Option<String>,
) -> Result<DbQueryResult, String> {
    let danger_grant = match omnipanel_presence::ensure_sql_presence(
        &state.presence_tokens,
        &sql,
        &connection.id,
        &connection.database,
        presence_token.as_deref(),
    ) {
        Ok(v) => v,
        Err(e) => {
            crate::commands::db_danger::append_danger_audit(
                &state,
                "db.sql.dangerous",
                &connection.id,
                "blocked",
                "token 无效",
            );
            return Err(e.to_string());
        }
    };
    let wrapped = match limit {
        Some(n) if n > 0 => omnipanel_db::wrap_editor_query(
            &connection.db_type,
            &sql,
            n as i64,
            offset.unwrap_or(0) as i64,
        ),
        _ => sql,
    };
    let params = to_params(&connection);

    let session_handle = {
        let mut sessions = state.db_query_sessions.lock().await;
        if let Some(existing) = sessions.get(&session_id) {
            existing.clone()
        } else {
            let driver = omnipanel_db::connect_exclusive(&params)
                .await
                .map_err(err_msg)?;
            let handle = Arc::new(Mutex::new(crate::state::DbQueryTxSession {
                driver,
                in_transaction: false,
            }));
            sessions.insert(session_id.clone(), handle.clone());
            handle
        }
    };

    {
        let mut session = session_handle.lock().await;
        if !session.in_transaction {
            session.driver.execute("BEGIN").await.map_err(err_msg)?;
            session.in_transaction = true;
        }
    }

    let handle_for_task = session_handle.clone();
    let handle = tokio::spawn(async move {
        let session = handle_for_task.lock().await;
        session.driver.execute(&wrapped).await.map_err(err_msg)
    });
    let abort_handle = handle.abort_handle();
    state
        .running_db_queries
        .lock()
        .await
        .insert(run_id.clone(), abort_handle);

    let result = match handle.await {
        Ok(inner) => inner,
        Err(join_err) if join_err.is_cancelled() => Err("查询已中断".to_string()),
        Err(join_err) => Err(format!("查询任务失败: {join_err}")),
    };

    state.running_db_queries.lock().await.remove(&run_id);
    if let Some((action, target)) = danger_grant {
        let status = if result.is_ok() { "success" } else { "failed" };
        crate::commands::db_danger::append_danger_audit(&state, &action, &target, status, "verified");
    }
    result.map(to_db_query_result)
}

/// 提交手动事务会话。
#[tauri::command]
#[specta::specta]
pub async fn db_query_session_commit(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
) -> Result<(), String> {
    let handle = {
        let sessions = state.db_query_sessions.lock().await;
        sessions.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Ok(());
    };
    let mut session = handle.lock().await;
    if session.in_transaction {
        session.driver.execute("COMMIT").await.map_err(err_msg)?;
        session.in_transaction = false;
    }
    Ok(())
}

/// 回滚手动事务会话。
#[tauri::command]
#[specta::specta]
pub async fn db_query_session_rollback(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
) -> Result<(), String> {
    let handle = {
        let sessions = state.db_query_sessions.lock().await;
        sessions.get(&session_id).cloned()
    };
    let Some(handle) = handle else {
        return Ok(());
    };
    let mut session = handle.lock().await;
    if session.in_transaction {
        session.driver.execute("ROLLBACK").await.map_err(err_msg)?;
        session.in_transaction = false;
    }
    Ok(())
}

/// 关闭手动事务会话（若仍在事务中则先 ROLLBACK）。
#[tauri::command]
#[specta::specta]
pub async fn db_query_session_close(
    state: tauri::State<'_, crate::state::AppState>,
    session_id: String,
) -> Result<(), String> {
    let handle = {
        let mut sessions = state.db_query_sessions.lock().await;
        sessions.remove(&session_id)
    };
    if let Some(handle) = handle {
        let mut session = handle.lock().await;
        if session.in_transaction {
            let _ = session.driver.execute("ROLLBACK").await;
            session.in_transaction = false;
        }
    }
    Ok(())
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisSearchKeysArgs {
    pub connection: DbConnectionConfig,
    pub pattern: String,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default = "default_redis_search_limit")]
    pub limit: u32,
    #[serde(default)]
    #[specta(type = f64)]
    pub cursor: u64,
    #[serde(default)]
    pub include_value_preview: bool,
}

fn default_redis_search_limit() -> u32 {
    500
}

/// Redis `CONFIG GET` 单键或多键。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_config_get_entries(
    connection: DbConnectionConfig,
    pattern: String,
) -> Result<Vec<(String, String)>, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 CONFIG GET".to_string());
    }
    omnipanel_db::redis_config_get(&to_params(&connection), &pattern)
        .await
        .map_err(err_msg)
}

/// Redis `CONFIG GET *`：返回 parameter / value 两列表格。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_config_get(connection: DbConnectionConfig) -> Result<DbQueryResult, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 CONFIG GET".to_string());
    }
    omnipanel_db::redis_config_get_all(&to_params(&connection))
        .await
        .map_err(err_msg)
        .map(to_db_query_result)
}

/// Redis `CLIENT LIST`：返回客户端连接列表。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_client_list(connection: DbConnectionConfig) -> Result<DbQueryResult, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 CLIENT LIST".to_string());
    }
    omnipanel_db::redis_client_list(&to_params(&connection))
        .await
        .map_err(err_msg)
        .map(to_db_query_result)
}

/// Redis `CLIENT KILL ADDR <ip:port>`：终止指定客户端连接，返回被杀掉的客户端数量。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_client_kill(
    connection: DbConnectionConfig,
    addr: String,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 CLIENT KILL".to_string());
    }
    omnipanel_db::redis_client_kill_addr(&to_params(&connection), &addr)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis 键搜索：SCAN + 类型过滤 + 值预览。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_search_keys(
    args: RedisSearchKeysArgs,
) -> Result<RedisSearchKeysResult, String> {
    if args.connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持键搜索".to_string());
    }
    omnipanel_db::redis_search_keys(
        &to_params(&args.connection),
        &args.pattern,
        &args.types,
        args.limit as usize,
        args.cursor,
        args.include_value_preview,
    )
    .await
    .map_err(err_msg)
}

/// Redis `DBSIZE`：当前逻辑库 key 总数。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_dbsize(connection: DbConnectionConfig) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 DBSIZE".to_string());
    }
    omnipanel_db::redis_dbsize(&to_params(&connection))
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis 单个 key 详情。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_key_detail(
    connection: DbConnectionConfig,
    key: String,
) -> Result<RedisKeyDetail, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 key 详情".to_string());
    }
    omnipanel_db::redis_key_detail(&to_params(&connection), &key)
        .await
        .map_err(err_msg)
}

/// Redis 新建 string key。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_set_key(
    connection: DbConnectionConfig,
    key: String,
    value: String,
    key_type: Option<String>,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持新建 key".to_string());
    }
    omnipanel_db::redis_set_key(
        &to_params(&connection),
        &key,
        &value,
        key_type.as_deref().unwrap_or("string"),
    )
    .await
    .map_err(err_msg)
}

/// Redis 删除 key。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_delete_key(
    connection: DbConnectionConfig,
    key: String,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持删除 key".to_string());
    }
    omnipanel_db::redis_delete_key(&to_params(&connection), &key)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis 慢日志。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_slowlog(
    connection: DbConnectionConfig,
    count: Option<u32>,
) -> Result<Vec<RedisSlowLogEntry>, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持慢日志".to_string());
    }
    omnipanel_db::redis_slowlog(&to_params(&connection), count.unwrap_or(64) as usize)
        .await
        .map_err(err_msg)
}

/// Redis `INFO`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_info(
    connection: DbConnectionConfig,
    section: Option<String>,
) -> Result<RedisInfoResult, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 INFO".to_string());
    }
    omnipanel_db::redis_info(&to_params(&connection), section.as_deref())
        .await
        .map_err(err_msg)
}

/// Redis `MEMORY STATS`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_memory_stats(
    connection: DbConnectionConfig,
) -> Result<RedisMemoryStats, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 MEMORY STATS".to_string());
    }
    omnipanel_db::redis_memory_stats(&to_params(&connection))
        .await
        .map_err(err_msg)
}

/// Redis `MEMORY DOCTOR`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_memory_doctor(connection: DbConnectionConfig) -> Result<String, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 MEMORY DOCTOR".to_string());
    }
    omnipanel_db::redis_memory_doctor(&to_params(&connection))
        .await
        .map_err(err_msg)
}

/// Redis `MEMORY PURGE`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_memory_purge(connection: DbConnectionConfig) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 MEMORY PURGE".to_string());
    }
    omnipanel_db::redis_memory_purge(&to_params(&connection))
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `CONFIG SET`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_config_set(
    connection: DbConnectionConfig,
    parameter: String,
    value: String,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 CONFIG SET".to_string());
    }
    omnipanel_db::redis_config_set(&to_params(&connection), &parameter, &value)
        .await
        .map_err(err_msg)
}

/// Redis `CONFIG REWRITE`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_config_rewrite(connection: DbConnectionConfig) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 CONFIG REWRITE".to_string());
    }
    omnipanel_db::redis_config_rewrite(&to_params(&connection))
        .await
        .map_err(err_msg)
}

/// Redis `FLUSHDB`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_flush_db(
    connection: DbConnectionConfig,
    r#async: Option<bool>,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 FLUSHDB".to_string());
    }
    omnipanel_db::redis_flush_db(&to_params(&connection), r#async.unwrap_or(true))
        .await
        .map_err(err_msg)
}

/// Redis `FLUSHALL`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_flush_all(
    connection: DbConnectionConfig,
    r#async: Option<bool>,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 FLUSHALL".to_string());
    }
    omnipanel_db::redis_flush_all(&to_params(&connection), r#async.unwrap_or(true))
        .await
        .map_err(err_msg)
}

/// Redis Stream 范围查询。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_range(
    connection: DbConnectionConfig,
    key: String,
    start: Option<String>,
    end: Option<String>,
    count: Option<u32>,
    reverse: Option<bool>,
) -> Result<RedisStreamRangeResult, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_range(
        &to_params(&connection),
        &key,
        start.as_deref(),
        end.as_deref(),
        count.map(|n| n as usize),
        reverse.unwrap_or(false),
    )
    .await
    .map_err(err_msg)
}

/// Redis `XINFO GROUPS`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_groups(
    connection: DbConnectionConfig,
    key: String,
) -> Result<Vec<RedisStreamGroup>, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_groups(&to_params(&connection), &key)
        .await
        .map_err(err_msg)
}

/// Redis `XINFO CONSUMERS`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_consumers(
    connection: DbConnectionConfig,
    key: String,
    group: String,
) -> Result<Vec<RedisStreamConsumer>, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_consumers(&to_params(&connection), &key, &group)
        .await
        .map_err(err_msg)
}

/// Redis `XPENDING`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_pending(
    connection: DbConnectionConfig,
    key: String,
    group: String,
    start: Option<String>,
    end: Option<String>,
    count: Option<u32>,
) -> Result<Vec<RedisStreamPendingEntry>, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_pending(
        &to_params(&connection),
        &key,
        &group,
        start.as_deref(),
        end.as_deref(),
        count.map(|n| n as usize),
    )
    .await
    .map_err(err_msg)
}

/// Redis Stream 监控快照。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_monitor(
    connection: DbConnectionConfig,
    key: String,
    group: Option<String>,
) -> Result<RedisStreamMonitorSnapshot, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_monitor(&to_params(&connection), &key, group.as_deref())
        .await
        .map_err(err_msg)
}

/// Redis `XACK`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_ack(
    connection: DbConnectionConfig,
    key: String,
    group: String,
    ids: Vec<String>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_ack(&to_params(&connection), &key, &group, &ids)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `XAUTOCLAIM`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_claim(
    connection: DbConnectionConfig,
    key: String,
    group: String,
    consumer: String,
    min_idle_ms: f64,
    start_id: String,
    count: Option<f64>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_claim(
        &to_params(&connection),
        &key,
        &group,
        &consumer,
        min_idle_ms as u64,
        &start_id,
        count.map(|n| n as u64),
    )
    .await
    .map(|n| n as f64)
    .map_err(err_msg)
}

/// Redis `XGROUP CREATE`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_group_create(
    connection: DbConnectionConfig,
    key: String,
    group: String,
    id: String,
    mkstream: Option<bool>,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_group_create(
        &to_params(&connection),
        &key,
        &group,
        &id,
        mkstream.unwrap_or(false),
    )
    .await
    .map_err(err_msg)
}

/// Redis `XGROUP DESTROY`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_group_destroy(
    connection: DbConnectionConfig,
    key: String,
    group: String,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_group_destroy(&to_params(&connection), &key, &group)
        .await
        .map_err(err_msg)
}

/// Redis `XTRIM`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_trim(
    connection: DbConnectionConfig,
    key: String,
    maxlen: f64,
    approximate: Option<bool>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    omnipanel_db::redis_stream_trim(
        &to_params(&connection),
        &key,
        maxlen as u64,
        approximate.unwrap_or(true),
    )
    .await
    .map(|n| n as f64)
    .map_err(err_msg)
}

/// Redis 清理非活跃 Stream 消费者（转移 Pending + DELCONSUMER）。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_stream_cleanup_inactive_consumers(
    connection: DbConnectionConfig,
    key: String,
    group: String,
    idle_threshold_ms: f64,
    target_consumer: Option<String>,
) -> Result<RedisStreamConsumerCleanupResult, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 Stream".to_string());
    }
    redis_stream_cleanup_inactive_consumers(
        &to_params(&connection),
        &key,
        &group,
        idle_threshold_ms as u64,
        target_consumer.as_deref(),
    )
    .await
    .map_err(err_msg)
}

/// Redis `ACL LIST`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_acl_list(
    connection: DbConnectionConfig,
) -> Result<Vec<RedisAclUser>, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 ACL".to_string());
    }
    omnipanel_db::redis_acl_list(&to_params(&connection))
        .await
        .map_err(err_msg)
}

/// Redis `ACL GETUSER`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_acl_getuser(
    connection: DbConnectionConfig,
    username: String,
) -> Result<RedisAclUser, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 ACL".to_string());
    }
    omnipanel_db::redis_acl_getuser(&to_params(&connection), &username)
        .await
        .map_err(err_msg)
}

/// Redis `ACL SETUSER`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_acl_setuser(
    connection: DbConnectionConfig,
    username: String,
    rule: String,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 ACL".to_string());
    }
    omnipanel_db::redis_acl_setuser(&to_params(&connection), &username, &rule)
        .await
        .map_err(err_msg)
}

/// Redis `ACL DELUSER`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_acl_deluser(
    connection: DbConnectionConfig,
    username: String,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持 ACL".to_string());
    }
    omnipanel_db::redis_acl_deluser(&to_params(&connection), &username)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `HSET`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_hash_set_field(
    connection: DbConnectionConfig,
    key: String,
    field: String,
    value: String,
) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_hash_set_field(&to_params(&connection), &key, &field, &value)
        .await
        .map_err(err_msg)
}

/// Redis `HDEL`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_hash_del_fields(
    connection: DbConnectionConfig,
    key: String,
    fields: Vec<String>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_hash_del_fields(&to_params(&connection), &key, &fields)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `LPUSH` / `RPUSH`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_list_push(
    connection: DbConnectionConfig,
    key: String,
    side: String,
    values: Vec<String>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_list_push(&to_params(&connection), &key, &side, &values)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `LREM`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_list_remove(
    connection: DbConnectionConfig,
    key: String,
    count: f64,
    value: String,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_list_remove(&to_params(&connection), &key, count as i64, &value)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `SADD`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_set_add(
    connection: DbConnectionConfig,
    key: String,
    members: Vec<String>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_set_add(&to_params(&connection), &key, &members)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `SREM`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_set_remove(
    connection: DbConnectionConfig,
    key: String,
    members: Vec<String>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_set_remove(&to_params(&connection), &key, &members)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `ZADD`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_zset_add(
    connection: DbConnectionConfig,
    key: String,
    member: String,
    score: f64,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_zset_add(&to_params(&connection), &key, &member, score)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `ZREM`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_zset_remove(
    connection: DbConnectionConfig,
    key: String,
    members: Vec<String>,
) -> Result<f64, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_zset_remove(&to_params(&connection), &key, &members)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

/// Redis `EXPIRE`。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_expire_key(
    connection: DbConnectionConfig,
    key: String,
    seconds: f64,
) -> Result<bool, String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持".to_string());
    }
    omnipanel_db::redis_expire_key(&to_params(&connection), &key, seconds as i64)
        .await
        .map_err(err_msg)
}

/// Qdrant 按 point id 批量删除参数。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct QdrantDeletePointsArgs {
    pub connection: DbConnectionConfig,
    pub collection: String,
    #[specta(type = Vec<specta_typescript::Any>)]
    pub point_ids: Vec<serde_json::Value>,
}

/// Qdrant 按 point id 批量删除。
#[tauri::command]
#[specta::specta]
pub async fn db_qdrant_delete_points(args: QdrantDeletePointsArgs) -> Result<f64, String> {
    if args.connection.db_type.to_lowercase() != "qdrant" {
        return Err("仅 Qdrant 连接支持删除 Points".to_string());
    }
    if args.collection.trim().is_empty() {
        return Err("未指定 collection".to_string());
    }
    omnipanel_db::qdrant_delete_points(
        &to_params(&args.connection),
        args.collection.trim(),
        &args.point_ids,
    )
    .await
    .map(|n| n as f64)
    .map_err(err_msg)
}

pub use omnipanel_db::{
    SchemaConnectionRefreshPayload, SchemaNodeRefreshArgs, SchemaNodeRefreshResult,
    refresh_connection_payload,
};

fn schema_cache_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn db_table_to_cache_table(table: omnipanel_db::DbTableSchema) -> SchemaCacheTable {
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

fn connection_payload_to_cache(
    payload: SchemaConnectionRefreshPayload,
    error: Option<String>,
) -> SchemaCacheConnection {
    SchemaCacheConnection {
        databases: payload
            .databases
            .into_iter()
            .map(|db| SchemaCacheDatabase {
                name: db.name,
                tables: db.tables.into_iter().map(db_table_to_cache_table).collect(),
                views: db.views.into_iter().map(db_table_to_cache_table).collect(),
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
            })
            .collect(),
        users: payload
            .users
            .into_iter()
            .map(|u| SchemaCacheUser {
                name: u.name,
                host: u.host,
            })
            .collect(),
        refreshed_at: Some(schema_cache_now_ms()),
        error,
    }
}

/// 是否启用数据库连接（与前端 `isConnectionEnabled` 一致）。
pub fn is_db_connection_enabled(connection: &DbConnectionConfig) -> bool {
    connection.enabled
}

/// 拉取单连接的 Schema 缓存条目（供后台任务与命令复用）。
pub async fn build_schema_cache_connection(
    connection: &DbConnectionConfig,
) -> SchemaCacheConnection {
    match refresh_connection_payload(connection).await {
        Ok(payload) => connection_payload_to_cache(payload, None),
        Err(err) => SchemaCacheConnection {
            databases: Vec::new(),
            users: Vec::new(),
            refreshed_at: Some(schema_cache_now_ms()),
            error: Some(err),
        },
    }
}

/// 按 Schema 树节点类型刷新缓存片段（连接 / 库 / 表 / 用户等）。
#[tauri::command]
#[specta::specta]
pub async fn db_refresh_schema_node(
    args: SchemaNodeRefreshArgs,
) -> Result<SchemaNodeRefreshResult, String> {
    omnipanel_db::db_refresh_schema_node(args).await
}

/// 将列式 QueryResult 转换为前端预览用的 TableInfo（行为 列名→值 的 map）。
fn to_table_info(name: String, result: QueryResult) -> TableInfo {
    let rows = result
        .rows
        .into_iter()
        .map(|record| {
            result
                .columns
                .iter()
                .cloned()
                .zip(record)
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .collect();
    TableInfo {
        name,
        rows,
        columns: result.columns,
    }
}
