//! P1 数据库命令（Web 端）。
//!
//! 与桌面端 `src-tauri/src/commands/database.rs` 的核心链路对齐（连接管理、
//! 测试连接、库/表浏览、SQL 执行），底层全部复用 `omnipanel-db` 领域驱动，
//! 不重新实现业务逻辑。

use std::collections::HashMap;
use std::sync::Arc;

use omnipanel_db::{DbParams, QueryResult};
use omnipanel_store::{DbConnectionConfig, ensure_creator_tag, fill_db_password_from_vault};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::state::ServerState;

/// 运行期 SQL 查询句柄表（`db_execute_query` / `db_cancel_query` 配对）。
pub type RunningDbQueries = Arc<Mutex<HashMap<String, tokio::task::AbortHandle>>>;

/// 查询结果（与桌面端 `DbQueryResult` 同形，rows 为 JSON 值数组）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: u64,
}

impl From<QueryResult> for DbQueryResult {
    fn from(r: QueryResult) -> Self {
        Self {
            columns: r.columns,
            rows: r.rows,
            rows_affected: r.rows_affected,
        }
    }
}

/// 表信息（`db_preview_table` 返回，与桌面端 `TableInfo` 同形）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInfo {
    pub name: String,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    pub columns: Vec<String>,
}

/// 表行数（`db_count_tables` 返回；单表失败为 null）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRowCount {
    pub name: String,
    pub count: Option<i64>,
}

fn err_msg(e: omnipanel_error::OmniError) -> String {
    e.user_message()
}

/// 将连接配置转为领域参数（注入 Vault 密码）。
fn to_params(c: &DbConnectionConfig) -> DbParams {
    let mut c = c.clone();
    fill_db_password_from_vault(&mut c);
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

/// 按 schema 覆盖库名（与桌面端 `with_schema` 一致）。
fn with_schema(c: &DbConnectionConfig, schema: Option<String>) -> DbParams {
    let mut params = to_params(c);
    if let Some(s) = schema.filter(|name| !name.trim().is_empty()) {
        params.database = s;
    }
    params
}

/// 建连（复用 omnipanel-db 领域层）。
async fn connect(params: &DbParams) -> Result<Box<dyn omnipanel_db::DbDriver>, String> {
    omnipanel_db::connect(params).await.map_err(err_msg)
}

/// 列出全部 DB 连接（不含明文密码，与桌面端 `db_list_connections` 语义一致）。
pub async fn db_list_connections(state: &ServerState) -> Result<Vec<DbConnectionConfig>, String> {
    state.db_connections.list().map_err(|e| e.to_string())
}

/// 从 Vault 取回连接明文密码（编辑表单用）。
pub async fn db_get_connection_secret(state: &ServerState, id: String) -> Result<String, String> {
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

/// 保存 DB 连接（写回 connections.json + Vault）。
pub async fn db_save_connection(
    state: &ServerState,
    mut connection: DbConnectionConfig,
) -> Result<DbConnectionConfig, String> {
    // 新建连接时打 creator 标签，标记创建设备
    let existed = !connection.id.trim().is_empty()
        && state
            .db_connections
            .get_with_secret(&connection.id)
            .map_err(|e| e.to_string())?
            .is_some();
    if !existed {
        ensure_creator_tag(&mut connection.tags, &crate::auth_cmds::current_device_name());
    }
    state
        .db_connections
        .save(connection)
        .map_err(|e| e.to_string())
}

/// 删除 DB 连接。
pub async fn db_delete_connection(state: &ServerState, id: String) -> Result<(), String> {
    state.db_connections.delete(&id).map_err(|e| e.to_string())
}

/// 测试连接（返回版本字符串）。
pub async fn db_test_connection(
    state: &ServerState,
    mut connection: DbConnectionConfig,
) -> Result<String, String> {
    let _ = state;
    fill_db_password_from_vault(&mut connection);
    let params = to_params(&connection);
    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
    driver.version().await.map_err(err_msg)
}

/// 列出库（MySQL/PG/Redis/MongoDB/Qdrant 语义与桌面端一致）。
pub async fn db_list_databases(
    state: &ServerState,
    connection: DbConnectionConfig,
) -> Result<Vec<String>, String> {
    let _ = state;
    let conn = &connection;
    match conn.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => {
            let params = to_params(conn);
            let _driver = connect(&params).await?;
            // MySQL 语义：information_schema 可浏览，系统库由前端 schemaFilters 控制
            list_mysql_databases(&params).await.map_err(err_msg)
        }
        "redis" => {
            let preset = connection.database.clone();
            omnipanel_db::redis_list_databases(&to_params(conn), &preset)
                .await
                .map_err(err_msg)
        }
        "postgresql" | "postgres" => {
            let params = to_params(conn);
            list_pg_databases(&params).await.map_err(err_msg)
        }
        "mongodb" | "mongo" => omnipanel_db::mongodb_list_databases(&to_params(conn))
            .await
            .map_err(err_msg),
        "qdrant" => omnipanel_db::qdrant_list_databases(&to_params(conn))
            .await
            .map_err(err_msg),
        _ if !connection.database.trim().is_empty() => Ok(vec![connection.database.clone()]),
        _ => Ok(vec![]),
    }
}

async fn list_mysql_databases(params: &DbParams) -> omnipanel_error::OmniResult<Vec<String>> {
    let driver = omnipanel_db::connect(params).await?;
    // 复用 DbDriver 的 execute（SELECT information_schema.SCHEMATA），
    // 取第一列作为库名。避免在 server crate 里依赖 sqlx 细节。
    let sql = "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME";
    let result = driver.execute(sql).await?;
    Ok(result
        .rows
        .iter()
        .filter_map(|row| row.first().and_then(|v| v.as_str()).map(str::to_string))
        .collect())
}

async fn list_pg_databases(params: &DbParams) -> omnipanel_error::OmniResult<Vec<String>> {
    let driver = omnipanel_db::connect(params).await?;
    let sql = "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname";
    let result = driver.execute(sql).await?;
    Ok(result
        .rows
        .iter()
        .filter_map(|row| row.first().and_then(|v| v.as_str()).map(str::to_string))
        .collect())
}

/// 列出表（`db_list_tables`）。
pub async fn db_list_tables(
    state: &ServerState,
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<Vec<String>, String> {
    let _ = state;
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await?;
    driver.list_tables().await.map_err(err_msg)
}

/// 预览表前 N 行（`db_preview_table`）。
pub async fn db_preview_table(
    state: &ServerState,
    connection: DbConnectionConfig,
    table: String,
    limit: u32,
    offset: u32,
    order_by: Option<String>,
    where_clause: Option<String>,
) -> Result<TableInfo, String> {
    let _ = state;
    let driver = connect(&to_params(&connection)).await?;
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
    let columns = result.columns.clone();
    let rows = result
        .rows
        .into_iter()
        .map(|record| {
            columns
                .iter()
                .cloned()
                .zip(record)
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .collect();
    Ok(TableInfo {
        name: table,
        rows,
        columns,
    })
}

/// 统计表行数（`db_count_table`）。
pub async fn db_count_table(
    state: &ServerState,
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
    where_clause: Option<String>,
) -> Result<f64, String> {
    let _ = state;
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await?;
    driver
        .count(table.trim(), where_clause.as_deref())
        .await
        .map_err(err_msg)
        .map(|n| n as f64)
}

/// 顺序统计多表行数（`db_count_tables`）。
pub async fn db_count_tables(
    state: &ServerState,
    connection: DbConnectionConfig,
    schema: Option<String>,
    tables: Vec<String>,
) -> Result<Vec<TableRowCount>, String> {
    let _ = state;
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await?;
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

/// 执行 SQL（SELECT 返回行集，DML 返回影响行数）。
/// `limit`/`offset` 非零时包裹 LIMIT 防止超大结果集。
/// `run_id` 供 `db_cancel_query` 中断。
pub async fn db_execute_query(
    state: &ServerState,
    connection: DbConnectionConfig,
    sql: String,
    run_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
    presence_token: Option<String>,
) -> Result<DbQueryResult, String> {
    if let Err(e) = omnipanel_presence::ensure_sql_presence(
        &state.presence_tokens,
        &sql,
        &connection.id,
        &connection.database,
        presence_token.as_deref(),
    ) {
        return Err(e.to_string());
    }
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
    result.map(DbQueryResult::from)
}

/// 中断正在执行的 SQL 查询。
pub async fn db_cancel_query(state: &ServerState, run_id: String) -> Result<(), String> {
    let abort_handle = state.running_db_queries.lock().await.remove(&run_id);
    match abort_handle {
        Some(handle) => {
            handle.abort();
            Ok(())
        }
        None => Err("无运行中的查询".to_string()),
    }
}

/// 简化执行（供工具/内部调用；不区分 SELECT/DML 由领域层处理）。
pub async fn db_run_sql(
    state: &ServerState,
    connection: DbConnectionConfig,
    schema: Option<String>,
    sql: String,
) -> Result<u64, String> {
    let _ = state;
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = connect(&params).await?;
    driver
        .execute(&sql)
        .await
        .map_err(err_msg)
        .map(|result| result.rows_affected)
}

/// 打开可复用的数据库驱动（供后台任务使用）。
pub async fn open_db_driver(
    state: &ServerState,
    id: &str,
) -> Result<Box<dyn omnipanel_db::DbDriver>, String> {
    let conn = state
        .db_connections
        .get_with_secret(id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "连接不存在".to_string())?;
    let params = to_params(&conn);
    connect(&params).await
}

fn ensure_redis(connection: &DbConnectionConfig) -> Result<(), String> {
    if connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持该操作".to_string());
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSearchKeysArgs {
    pub connection: DbConnectionConfig,
    pub pattern: String,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default = "default_redis_search_limit")]
    pub limit: u32,
    #[serde(default)]
    pub cursor: u64,
    #[serde(default)]
    pub include_value_preview: bool,
}

fn default_redis_search_limit() -> u32 {
    500
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QdrantDeletePointsArgs {
    pub connection: DbConnectionConfig,
    pub collection: String,
    #[serde(default)]
    pub point_ids: Vec<serde_json::Value>,
}

pub async fn db_redis_config_get_entries(
    connection: DbConnectionConfig,
    pattern: String,
) -> Result<Vec<(String, String)>, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_config_get(&to_params(&connection), &pattern)
        .await
        .map_err(err_msg)
}

pub async fn db_redis_config_get(connection: DbConnectionConfig) -> Result<DbQueryResult, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_config_get_all(&to_params(&connection))
        .await
        .map(DbQueryResult::from)
        .map_err(err_msg)
}

pub async fn db_redis_client_list(connection: DbConnectionConfig) -> Result<DbQueryResult, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_client_list(&to_params(&connection))
        .await
        .map(DbQueryResult::from)
        .map_err(err_msg)
}

pub async fn db_redis_client_kill(
    connection: DbConnectionConfig,
    addr: String,
) -> Result<f64, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_client_kill_addr(&to_params(&connection), &addr)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

pub async fn db_redis_search_keys(
    args: RedisSearchKeysArgs,
) -> Result<omnipanel_db::RedisSearchKeysResult, String> {
    ensure_redis(&args.connection)?;
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

pub async fn db_redis_dbsize(connection: DbConnectionConfig) -> Result<f64, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_dbsize(&to_params(&connection))
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

pub async fn db_redis_key_detail(
    connection: DbConnectionConfig,
    key: String,
) -> Result<omnipanel_db::RedisKeyDetail, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_key_detail(&to_params(&connection), &key)
        .await
        .map_err(err_msg)
}

pub async fn db_redis_set_key(
    connection: DbConnectionConfig,
    key: String,
    value: String,
    key_type: Option<String>,
) -> Result<(), String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_set_key(
        &to_params(&connection),
        &key,
        &value,
        key_type.as_deref().unwrap_or("string"),
    )
    .await
    .map_err(err_msg)
}

pub async fn db_redis_delete_key(
    connection: DbConnectionConfig,
    key: String,
) -> Result<f64, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_delete_key(&to_params(&connection), &key)
        .await
        .map(|n| n as f64)
        .map_err(err_msg)
}

pub async fn db_redis_slowlog(
    connection: DbConnectionConfig,
    count: Option<u32>,
) -> Result<Vec<omnipanel_db::RedisSlowLogEntry>, String> {
    ensure_redis(&connection)?;
    omnipanel_db::redis_slowlog(&to_params(&connection), count.unwrap_or(64) as usize)
        .await
        .map_err(err_msg)
}

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

pub fn db_save_schema_cache(snapshot: omnipanel_store::SchemaCacheSnapshot) -> Result<(), String> {
    omnipanel_store::save_schema_cache(&snapshot).map_err(|e| e.user_message())
}

pub fn db_patch_schema_cache(
    connection_id: String,
    entry: omnipanel_store::SchemaCacheConnection,
) -> Result<omnipanel_store::SchemaCacheConnection, String> {
    omnipanel_store::patch_schema_cache_connection(&connection_id, entry)
        .map_err(|e| e.user_message())
}

pub fn db_load_schema_filters() -> Result<omnipanel_store::SchemaFiltersSnapshot, String> {
    omnipanel_store::load_schema_filters().map_err(|e| e.user_message())
}

pub fn db_save_schema_filters(
    snapshot: omnipanel_store::SchemaFiltersSnapshot,
) -> Result<(), String> {
    omnipanel_store::save_schema_filters(&snapshot).map_err(|e| e.user_message())
}

pub fn db_load_schema_tree_expanded() -> Result<omnipanel_store::SchemaTreeExpandedSnapshot, String>
{
    omnipanel_store::load_schema_tree_expanded().map_err(|e| e.user_message())
}

pub fn db_save_schema_tree_expanded(
    snapshot: omnipanel_store::SchemaTreeExpandedSnapshot,
) -> Result<(), String> {
    omnipanel_store::save_schema_tree_expanded(&snapshot).map_err(|e| e.user_message())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbDropObject {
    pub database: String,
    pub name: String,
    pub kind: String,
}

pub async fn db_drop_table(
    state: &ServerState,
    connection: DbConnectionConfig,
    objects: Vec<DbDropObject>,
    presence_token: String,
) -> Result<(), String> {
    if objects.is_empty() {
        return Err("未指定要删除的表".into());
    }
    let pairs: Vec<(&str, &str)> = objects
        .iter()
        .map(|o| (o.database.as_str(), o.name.as_str()))
        .collect();
    let target = omnipanel_presence::drop_table_objects_target(&connection.id, &pairs);
    omnipanel_presence::require_grant(
        &state.presence_tokens,
        Some(&presence_token),
        omnipanel_presence::ACTION_DB_DROP_TABLE,
        &target,
    )
    .map_err(|e| e.to_string())?;
    for object in &objects {
        let sql = build_drop_table_sql(
            &connection.db_type,
            &object.database,
            &object.name,
            object.kind.eq_ignore_ascii_case("view"),
        );
        let mut conn = connection.clone();
        if !object.database.trim().is_empty() {
            conn.database = object.database.clone();
        }
        let params = to_params(&conn);
        let driver = omnipanel_db::connect(&params)
            .await
            .map_err(|e| e.to_string())?;
        driver.execute(&sql).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn db_drop_database(
    state: &ServerState,
    connection: DbConnectionConfig,
    databases: Vec<String>,
    presence_token: String,
) -> Result<(), String> {
    let mut names = databases;
    names.sort();
    names.dedup();
    if names.is_empty() {
        return Err("未指定要删除的数据库".into());
    }
    let joined = names.join(",");
    let target = omnipanel_presence::drop_database_target(&connection.id, &joined);
    omnipanel_presence::require_grant(
        &state.presence_tokens,
        Some(&presence_token),
        omnipanel_presence::ACTION_DB_DROP_DATABASE,
        &target,
    )
    .map_err(|e| e.to_string())?;
    for name in &names {
        let sql = build_drop_database_sql(&connection.db_type, name)?;
        let params = to_params(&connection);
        let driver = omnipanel_db::connect(&params)
            .await
            .map_err(|e| e.to_string())?;
        driver.execute(&sql).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn db_restart_service(
    state: &ServerState,
    ssh_connection_id: String,
    service: String,
    kind: String,
    location: String,
    presence_token: String,
) -> Result<(), String> {
    let target = omnipanel_presence::restart_target(&ssh_connection_id, &service, &kind, &location);
    omnipanel_presence::require_grant(
        &state.presence_tokens,
        Some(&presence_token),
        omnipanel_presence::ACTION_DB_RESTART,
        &target,
    )
    .map_err(|e| e.to_string())?;
    let command = if kind == "docker" {
        if location.trim().is_empty() {
            return Err("缺少容器".into());
        }
        format!("docker restart '{}'", location.replace('\'', r#"'\''"#))
    } else if kind == "host" {
        match service.as_str() {
            "mysql" => host_mysql_restart(),
            "redis" => host_redis_restart(),
            _ => return Err("不支持的数据库服务".into()),
        }
    } else {
        return Err("不支持的部署类型".into());
    };
    let output = crate::ssh_ops::ssh_pool_exec_command(state, ssh_connection_id, command)
        .await
        .map_err(|e| e.to_string())?;
    if output.exit_code != 0 {
        return Err(format!("重启失败: {}", output.stderr.trim()));
    }
    Ok(())
}

fn quote_ident(engine: &str, name: &str) -> String {
    match engine {
        "mysql" | "hive" => format!("`{}`", name.replace('`', "``")),
        "mssql" => format!("[{}]", name.replace(']', "]]")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    }
}

fn normalize_drop_engine(db_type: &str) -> &'static str {
    let t = db_type.to_ascii_lowercase();
    if t.contains("postgres") || t.contains("highgo") || t.contains("kingbase") {
        "postgres"
    } else if t.contains("sqlite") {
        "sqlite"
    } else if t.contains("mssql") || t.contains("sqlserver") {
        "mssql"
    } else if t.contains("oracle") {
        "oracle"
    } else if t.contains("hive") {
        "hive"
    } else {
        "mysql"
    }
}

fn build_drop_table_sql(db_type: &str, database: &str, table: &str, view: bool) -> String {
    let engine = normalize_drop_engine(db_type);
    let verb = if view { "VIEW" } else { "TABLE" };
    let db = database.trim();
    let name = table.trim();
    match engine {
        "postgres" => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, "public"),
            quote_ident(engine, name)
        ),
        "sqlite" => format!("DROP {verb} {}", quote_ident(engine, name)),
        "mssql" => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, "dbo"),
            quote_ident(engine, name)
        ),
        "oracle" => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, db),
            quote_ident(engine, name)
        ),
        _ => format!(
            "DROP {verb} {}.{}",
            quote_ident(engine, db),
            quote_ident(engine, name)
        ),
    }
}

fn build_drop_database_sql(db_type: &str, database: &str) -> Result<String, String> {
    let engine = normalize_drop_engine(db_type);
    let name = database.trim();
    if name.is_empty() {
        return Err("数据库名为空".into());
    }
    Ok(format!("DROP DATABASE {}", quote_ident(engine, name)))
}

fn host_mysql_restart() -> String {
    [
        "if command -v systemctl >/dev/null 2>&1; then",
        "for u in mysql mysqld mariadb; do",
        r#"if systemctl is-active --quiet "$u" 2>/dev/null; then systemctl restart "$u" && exit 0; fi;"#,
        "done;",
        "fi;",
        "if command -v service >/dev/null 2>&1; then",
        r#"for u in mysql mysqld mariadb; do service "$u" restart 2>/dev/null && exit 0; done;"#,
        "fi;",
        "exit 1",
    ]
    .join(" ")
}

fn host_redis_restart() -> String {
    [
        "if command -v systemctl >/dev/null 2>&1; then",
        "for u in redis redis-server; do",
        r#"if systemctl is-active --quiet "$u" 2>/dev/null; then systemctl restart "$u" && exit 0; fi;"#,
        "done;",
        "fi;",
        "if command -v service >/dev/null 2>&1; then",
        r#"for u in redis redis-server; do service "$u" restart 2>/dev/null && exit 0; done;"#,
        "fi;",
        "exit 1",
    ]
    .join(" ")
}
