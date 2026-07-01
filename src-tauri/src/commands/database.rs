use std::collections::HashMap;

use omnipanel_db::{DbParams, QueryResult, RedisKeyEntry, mysql_connect_options};
use omnipanel_error::OmniError;
pub use omnipanel_store::{
    DbConnectionConfig, SchemaCacheColumn, SchemaCacheConnection, SchemaCacheDatabase,
    SchemaCacheIndex, SchemaCacheRoutine, SchemaCacheSnapshot, SchemaCacheTable, SchemaCacheUser,
    SchemaFiltersSnapshot, SchemaTreeExpandedSnapshot, load_schema_cache, load_schema_filters,
    load_schema_tree_expanded, prune_connection_cache, prune_connection_expanded,
    prune_connection_filters, save_schema_cache, save_schema_filters, save_schema_tree_expanded,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
use sqlx::postgres::{PgPool, PgPoolOptions};
use tauri::State;

use crate::state::AppState;

/// `information_schema` 部分列在 MySQL 驱动下为 BLOB，需兼容解码为 `String`。
fn mysql_row_string(row: &MySqlRow, index: usize) -> String {
    if let Ok(v) = row.try_get::<String, _>(index) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<Option<String>, _>(index) {
        return v;
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(index) {
        return String::from_utf8_lossy(&v).into_owned();
    }
    if let Ok(Some(v)) = row.try_get::<Option<Vec<u8>>, _>(index) {
        return String::from_utf8_lossy(&v).into_owned();
    }
    String::new()
}

fn mysql_row_i32(row: &MySqlRow, index: usize, default: i32) -> i32 {
    if let Ok(v) = row.try_get::<i32, _>(index) {
        return v;
    }
    if let Ok(v) = row.try_get::<i8, _>(index) {
        return i32::from(v);
    }
    if let Ok(v) = row.try_get::<u8, _>(index) {
        return i32::from(v);
    }
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return v as i32;
    }
    mysql_row_string(row, index).parse().unwrap_or(default)
}

fn normalize_table_comment(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

async fn mysql_fetch_table_comments(
    pool: &MySqlPool,
    db_name: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME, TABLE_COMMENT FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'",
    )
    .bind(db_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    let mut map = HashMap::new();
    for row in rows {
        let name = mysql_row_string(&row, 0);
        let comment = mysql_row_string(&row, 1);
        if let Some(normalized) = normalize_table_comment(&comment) {
            map.insert(name, normalized);
        }
    }
    Ok(map)
}

async fn mysql_fetch_table_comment(
    pool: &MySqlPool,
    db_name: &str,
    table_name: &str,
) -> Result<Option<String>, String> {
    let row = sqlx::query(
        "SELECT TABLE_COMMENT FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND TABLE_TYPE = 'BASE TABLE'",
    )
    .bind(db_name)
    .bind(table_name)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    Ok(row.and_then(|r| normalize_table_comment(&mysql_row_string(&r, 0))))
}

async fn pg_fetch_table_comments(
    pool: &PgPool,
    schema: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query(
        "SELECT c.relname, obj_description(c.oid, 'pg_class')::text \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind = 'r'",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG table comments query failed: {e}"))?;

    let mut map = HashMap::new();
    for row in rows {
        let name: String = row.try_get(0).unwrap_or_default();
        let comment: Option<String> = row.try_get(1).ok();
        if let Some(normalized) = comment.and_then(|c| normalize_table_comment(&c)) {
            map.insert(name, normalized);
        }
    }
    Ok(map)
}

async fn pg_fetch_table_comment(
    pool: &PgPool,
    schema: &str,
    table_name: &str,
) -> Result<Option<String>, String> {
    let row = sqlx::query(
        "SELECT obj_description(c.oid, 'pg_class')::text \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'",
    )
    .bind(schema)
    .bind(table_name)
    .fetch_optional(pool)
    .await
    .map_err(|e| format!("PG table comment query failed: {e}"))?;

    Ok(row
        .and_then(|r| r.try_get::<Option<String>, _>(0).ok())
        .flatten()
        .and_then(|c| normalize_table_comment(&c)))
}

fn apply_table_comments(tables: &mut [DbTableSchema], comments: HashMap<String, String>) {
    for table in tables {
        if let Some(comment) = comments.get(&table.name) {
            table.comment = Some(comment.clone());
        }
    }
}

fn split_schemas_by_type(
    schemas: Vec<DbTableSchema>,
    type_map: &HashMap<String, String>,
) -> (Vec<DbTableSchema>, Vec<DbTableSchema>) {
    let mut tables = Vec::new();
    let mut views = Vec::new();
    for schema in schemas {
        match type_map.get(&schema.name).map(String::as_str) {
            Some("VIEW") => views.push(schema),
            Some("BASE TABLE") | Some("TABLE") => tables.push(schema),
            _ => tables.push(schema),
        }
    }
    (tables, views)
}

async fn mysql_fetch_object_types(
    pool: &MySqlPool,
    db_name: &str,
) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query(
        "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?",
    )
    .bind(db_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|row| (mysql_row_string(&row, 0), mysql_row_string(&row, 1)))
        .collect())
}

async fn mysql_fetch_routines(
    pool: &MySqlPool,
    db_name: &str,
) -> Result<Vec<DbRoutineMeta>, String> {
    let mut routines = Vec::new();
    let routine_rows = sqlx::query(
        "SELECT ROUTINE_NAME, ROUTINE_TYPE FROM information_schema.ROUTINES \
         WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME, ROUTINE_TYPE",
    )
    .bind(db_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    for row in routine_rows {
        routines.push(DbRoutineMeta {
            name: mysql_row_string(&row, 0),
            routine_type: mysql_row_string(&row, 1).to_ascii_lowercase(),
        });
    }

    let trigger_rows = sqlx::query(
        "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS \
         WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME",
    )
    .bind(db_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    for row in trigger_rows {
        routines.push(DbRoutineMeta {
            name: mysql_row_string(&row, 0),
            routine_type: "trigger".to_string(),
        });
    }

    Ok(routines)
}

async fn mysql_list_users(connection: &DbConnectionConfig) -> Result<Vec<DbUserMeta>, String> {
    let pool = mysql_pool(connection).await?;
    let rows = sqlx::query("SELECT User, Host FROM mysql.user ORDER BY User, Host")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("Query failed: {e}"))?;
    pool.close().await;

    Ok(rows
        .into_iter()
        .map(|row| DbUserMeta {
            name: mysql_row_string(&row, 0),
            host: Some(mysql_row_string(&row, 1)),
        })
        .collect())
}

async fn pg_fetch_object_types(pool: &PgPool, schema: &str) -> Result<HashMap<String, String>, String> {
    let rows = sqlx::query(
        "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG table types query failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|row| {
            (
                row.try_get::<String, _>(0).unwrap_or_default(),
                row.try_get::<String, _>(1).unwrap_or_default(),
            )
        })
        .collect())
}

async fn pg_fetch_routines(pool: &PgPool, schema: &str) -> Result<Vec<DbRoutineMeta>, String> {
    let mut routines = Vec::new();
    let routine_rows = sqlx::query(
        "SELECT routine_name, routine_type FROM information_schema.routines \
         WHERE routine_schema = $1 ORDER BY routine_name, routine_type",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG routines query failed: {e}"))?;

    for row in routine_rows {
        routines.push(DbRoutineMeta {
            name: row.try_get(0).unwrap_or_default(),
            routine_type: row
                .try_get::<String, _>(1)
                .unwrap_or_default()
                .to_ascii_lowercase(),
        });
    }

    let trigger_rows = sqlx::query(
        "SELECT trigger_name FROM information_schema.triggers \
         WHERE trigger_schema = $1 ORDER BY trigger_name",
    )
    .bind(schema)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG triggers query failed: {e}"))?;

    for row in trigger_rows {
        routines.push(DbRoutineMeta {
            name: row.try_get(0).unwrap_or_default(),
            routine_type: "trigger".to_string(),
        });
    }

    Ok(routines)
}

async fn pg_list_users(connection: &DbConnectionConfig) -> Result<Vec<DbUserMeta>, String> {
    let pool = pg_pool(connection).await?;
    let rows = sqlx::query("SELECT usename FROM pg_catalog.pg_user ORDER BY usename")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("PG users query failed: {e}"))?;
    pool.close().await;

    Ok(rows
        .into_iter()
        .map(|row| DbUserMeta {
            name: row.try_get(0).unwrap_or_default(),
            host: None,
        })
        .collect())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbColumnMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub is_pk: bool,
    pub is_fk: bool,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbIndexMeta {
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbRoutineMeta {
    pub name: String,
    pub routine_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbUserMeta {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DbTableSchema {
    pub name: String,
    pub columns: Vec<DbColumnMeta>,
    #[serde(default)]
    pub indexes: Vec<DbIndexMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbIntrospectResult {
    pub database: String,
    pub tables: Vec<DbTableSchema>,
    #[serde(default)]
    pub views: Vec<DbTableSchema>,
    #[serde(default)]
    pub routines: Vec<DbRoutineMeta>,
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
fn to_params(c: &DbConnectionConfig) -> DbParams {
    DbParams {
        db_type: c.db_type.clone(),
        host: c.host.clone(),
        port: c.port,
        user: c.user.clone(),
        password: c.password.clone(),
        database: c.database.clone(),
        ssl: c.ssl,
    }
}

async fn mysql_pool(connection: &DbConnectionConfig) -> Result<MySqlPool, String> {
    let opts = mysql_connect_options(&to_params(connection));
    MySqlPoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| format!("MySQL 连接失败: {e}"))
}

async fn pg_pool(connection: &DbConnectionConfig) -> Result<PgPool, String> {
    let p = to_params(connection);
    let opts = sqlx::postgres::PgConnectOptions::new()
        .host(&p.host)
        .port(p.port)
        .username(&p.user)
        .password(&p.password)
        .database(&p.database);
    PgPoolOptions::new()
        .max_connections(1)
        .connect_with(opts)
        .await
        .map_err(|e| format!("PostgreSQL 连接失败: {e}"))
}

fn with_schema(c: &DbConnectionConfig, schema: Option<String>) -> DbParams {
    let mut params = to_params(c);
    if let Some(s) = schema.filter(|name| !name.trim().is_empty()) {
        params.database = s;
    }
    params
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<DbConnectionConfig>, String> {
    state.db_connections.list().map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_connection(
    state: State<'_, AppState>,
    connection: DbConnectionConfig,
) -> Result<DbConnectionConfig, String> {
    state
        .db_connections
        .save(connection)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    state
        .db_connections
        .delete(&id)
        .map_err(|e| e.to_string())?;
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

#[tauri::command]
#[specta::specta]
pub async fn db_test_connection(connection: DbConnectionConfig) -> Result<String, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(err_msg)?;
    driver.version().await.map_err(err_msg)
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_databases(connection: DbConnectionConfig) -> Result<Vec<String>, String> {
    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => {
            let pool = mysql_pool(&connection).await?;
            // 保留 information_schema / performance_schema / mysql / sys 等系统库，
            // 让用户能浏览表/列结构；隐藏逻辑由前端 schemaFilters 按 connId 控制。
            let rows = sqlx::query(
                "SELECT SCHEMA_NAME FROM information_schema.SCHEMATA \
                 ORDER BY SCHEMA_NAME",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
            let databases: Vec<String> = rows.iter().map(|r| mysql_row_string(r, 0)).collect();
            pool.close().await;
            Ok(databases)
        }
        "redis" => {
            let preset = connection.database.trim();
            if !preset.is_empty() {
                return Ok(vec![preset.to_string()]);
            }
            // Redis 逻辑库为数字索引，默认实例通常有 16 个（0-15）。
            Ok((0..16).map(|n| n.to_string()).collect())
        }
        _ if !connection.database.trim().is_empty() => Ok(vec![connection.database.clone()]),
        _ => Ok(vec![]),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbCharsetMeta {
    pub charset: String,
    pub description: String,
    pub default_collation: String,
}

async fn mysql_list_character_sets(
    connection: &DbConnectionConfig,
) -> Result<Vec<DbCharsetMeta>, String> {
    let pool = mysql_pool(connection).await?;
    let rows = sqlx::query("SHOW CHARACTER SET")
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("Query failed: {e}"))?;
    let charsets: Vec<DbCharsetMeta> = rows
        .iter()
        .map(|row| DbCharsetMeta {
            charset: mysql_row_string(row, 0),
            description: mysql_row_string(row, 1),
            default_collation: mysql_row_string(row, 2),
        })
        .collect();
    pool.close().await;
    Ok(charsets)
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_character_sets(
    connection: DbConnectionConfig,
) -> Result<Vec<DbCharsetMeta>, String> {
    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => mysql_list_character_sets(&connection).await,
        _ => Ok(Vec::new()),
    }
}

/// 创建数据库参数。name 必填；charset 可选，留空时使用服务器默认。
#[derive(Debug, Deserialize, specta::Type)]
pub struct CreateDatabaseArgs {
    pub connection: DbConnectionConfig,
    pub name: String,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
}

/// 校验数据库名：仅允许 ASCII 字母/数字/下划线/$，且首字符不能为数字，长度 1..=64。
/// 同时屏蔽 MySQL 系统库名。
fn validate_database_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("数据库名不能为空".to_string());
    }
    if trimmed.len() > 64 {
        return Err("数据库名长度不能超过 64 个字符".to_string());
    }
    let mut chars = trimmed.chars();
    let first = chars.next().unwrap();
    if !first.is_ascii_alphabetic() && first != '_' && first != '$' {
        return Err("数据库名必须以字母、下划线或 $ 开头".to_string());
    }
    for c in chars {
        if !(c.is_ascii_alphanumeric() || c == '_' || c == '$') {
            return Err("数据库名仅允许字母、数字、下划线和 $".to_string());
        }
    }
    const RESERVED: &[&str] = &["information_schema", "performance_schema", "mysql", "sys"];
    if RESERVED.iter().any(|r| r.eq_ignore_ascii_case(trimmed)) {
        return Err(format!("`{trimmed}` 是系统保留库名，请使用其他名称"));
    }
    Ok(trimmed.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_create_database(args: CreateDatabaseArgs) -> Result<String, String> {
    let name = validate_database_name(&args.name)?;
    match args.connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => {
            let pool = mysql_pool(&args.connection).await?;
            // MySQL 标识符允许反引号转义；这里手工拼接以兼容老驱动，
            // 先用反斜杠转义（实际为重复反引号），防止简单的 SQL 注入。
            let escaped_name = name.replace('`', "``");
            let charset_clause = match args
                .charset
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(cs) => {
                    let escaped_cs = cs.replace('`', "``");
                    format!(" CHARACTER SET `{escaped_cs}`")
                }
                None => String::new(),
            };
            let collation_clause = match args
                .collation
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(co) => {
                    let escaped_co = co.replace('`', "``");
                    format!(" COLLATE `{escaped_co}`")
                }
                None => String::new(),
            };
            let sql = format!("CREATE DATABASE `{escaped_name}`{charset_clause}{collation_clause}");
            sqlx::query(&sql)
                .execute(&pool)
                .await
                .map_err(|e| format!("创建数据库失败：{e}"))?;
            pool.close().await;
            Ok(name)
        }
        _ => Err(format!(
            "暂不支持在 {} 引擎上创建数据库",
            args.connection.db_type
        )),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_introspect_schema(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<DbIntrospectResult, String> {
    let db_name = schema
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| connection.database.clone());
    if db_name.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }

    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => introspect_mysql_schema(&connection, &db_name).await,
        "postgresql" | "postgres" => introspect_pg_schema(&connection, &db_name).await,
        "sqlite" => introspect_sqlite_schema(&connection).await,
        _ => {
            let params = with_schema(&connection, Some(db_name.clone()));
            let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
            let table_names = driver.list_tables().await.map_err(err_msg)?;
            Ok(DbIntrospectResult {
                database: db_name,
                tables: table_names
                    .into_iter()
                    .map(|name| DbTableSchema {
                        name,
                        columns: Vec::new(),
                        indexes: Vec::new(),
                        comment: None,
                    })
                    .collect(),
                views: Vec::new(),
                routines: Vec::new(),
            })
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_connection_users(
    connection: DbConnectionConfig,
) -> Result<Vec<DbUserMeta>, String> {
    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => mysql_list_users(&connection).await,
        "postgresql" | "postgres" => pg_list_users(&connection).await,
        _ => Ok(Vec::new()),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_introspect_table(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<DbTableSchema, String> {
    let db_name = schema
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| connection.database.clone());
    if db_name.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    if table.trim().is_empty() {
        return Err("未指定数据表".to_string());
    }

    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => introspect_mysql_table(&connection, &db_name, table.trim()).await,
        "postgresql" | "postgres" => introspect_pg_table(&connection, &db_name, table.trim()).await,
        "sqlite" => introspect_sqlite_table(&connection, table.trim()).await,
        _ => Ok(DbTableSchema {
            name: table,
            columns: Vec::new(),
            indexes: Vec::new(),
            comment: None,
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_table_ddl(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<String, String> {
    let db_name = schema
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| connection.database.clone());
    if db_name.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    if table.trim().is_empty() {
        return Err("未指定数据表".to_string());
    }

    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => mysql_table_ddl(&connection, &db_name, table.trim()).await,
        "postgresql" | "postgres" => pg_table_ddl(&connection, &db_name, table.trim()).await,
        "sqlite" => sqlite_table_ddl(&connection, table.trim()),
        _ => Err(format!("不支持的数据库类型: {}", connection.db_type)),
    }
}

/// MySQL / MariaDB: `SHOW CREATE TABLE` 直接返回原始建表语句。
async fn mysql_table_ddl(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<String, String> {
    let pool = mysql_pool(connection).await?;
    let row = sqlx::query(&format!(
        "SHOW CREATE TABLE `{}`.`{}`",
        db_name.replace('`', "``"),
        table_name.replace('`', "``")
    ))
    .fetch_one(&pool)
    .await
    .map_err(|e| format!("SHOW CREATE TABLE 失败: {e}"))?;
    pool.close().await;

    // SHOW CREATE TABLE 返回两列：Table 名称 + Create Table 语句
    let create_sql: String = row.try_get(1).map_err(|e| format!("解码 DDL 失败: {e}"))?;
    Ok(create_sql)
}

/// PostgreSQL: 拼接标准 DDL（PG 没有原生 `SHOW CREATE TABLE`）。
async fn pg_table_ddl(
    connection: &DbConnectionConfig,
    _db_name: &str,
    table_name: &str,
) -> Result<String, String> {
    let pool = pg_pool(connection).await?;
    let ddl = pg_build_ddl(&pool, table_name).await?;
    pool.close().await;
    Ok(ddl)
}

async fn pg_build_ddl(pool: &PgPool, table_name: &str) -> Result<String, String> {
    let col_rows = sqlx::query(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, \
         pg_get_expr(d.adbin, d.adrelid) AS default_expr \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_type t ON t.oid = a.atttypid \
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
         WHERE c.relname = $1 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG columns query failed: {e}"))?;

    let pk_rows = sqlx::query(
        "SELECT a.attname \
         FROM pg_index i \
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
         JOIN pg_class c ON c.oid = i.indrelid \
         WHERE c.relname = $1 AND i.indisprimary \
         ORDER BY array_position(i.indkey, a.attnum)",
    )
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG pk query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT i.relname AS index_name, \
                array_agg(a.attname ORDER BY array_position(i.indkey, a.attnum)) AS cols, \
                ix.indisunique AS is_unique \
         FROM pg_index ix \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_class t ON t.oid = ix.indrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         WHERE t.relname = $1 AND NOT ix.indisprimary \
         GROUP BY i.relname, ix.indisunique \
         ORDER BY i.relname",
    )
    .bind(table_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG index query failed: {e}"))?;

    if col_rows.is_empty() {
        return Err(format!("PG 表 {table_name} 不存在或无字段"));
    }

    let mut lines: Vec<String> = Vec::new();
    for row in &col_rows {
        let name: String = row.try_get(0).unwrap_or_default();
        let typ: String = row.try_get(1).unwrap_or_default();
        let not_null: bool = row.try_get(2).unwrap_or(false);
        let default_expr: Option<String> = row.try_get(3).ok();
        let mut parts = vec![format!("\"{name}\" {typ}")];
        if not_null {
            parts.push("NOT NULL".to_string());
        }
        if let Some(d) = default_expr.filter(|s| !s.is_empty()) {
            parts.push(format!("DEFAULT {d}"));
        }
        lines.push(format!("  {}", parts.join(" ")));
    }

    if !pk_rows.is_empty() {
        let cols: Vec<String> = pk_rows
            .iter()
            .map(|r| r.try_get::<String, _>(0).unwrap_or_default())
            .collect();
        lines.push(format!("  PRIMARY KEY ({})", cols.join(", ")));
    }

    let mut ddl = format!("CREATE TABLE \"{table_name}\" (\n{});\n", lines.join(",\n"));

    for row in &idx_rows {
        let name: String = row.try_get(0).unwrap_or_default();
        let cols: Vec<String> = row.try_get::<Vec<String>, _>(1).unwrap_or_default();
        let is_unique: bool = row.try_get(2).unwrap_or(false);
        let unique = if is_unique { "UNIQUE " } else { "" };
        ddl.push('\n');
        ddl.push_str(&format!(
            "CREATE {unique}INDEX \"{name}\" ON \"{table_name}\" ({});\n",
            cols.iter()
                .map(|c| format!("\"{c}\""))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    Ok(ddl)
}

/// SQLite: `sqlite_master.sql` 拿原始建表语句。
fn sqlite_table_ddl(connection: &DbConnectionConfig, table_name: &str) -> Result<String, String> {
    let path = connection.database.trim();
    if path.is_empty() {
        return Err("SQLite database path is empty".into());
    }
    let conn = rusqlite::Connection::open(path).map_err(|e| format!("SQLite open failed: {e}"))?;
    let sql = format!(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='{}'",
        table_name.replace('\'', "''")
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("SQLite prepare failed: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("SQLite query failed: {e}"))?;
    if let Ok(Some(row)) = rows.next() {
        let sql: Option<String> = row.get(0).map_err(|e| format!("row error: {e}"))?;
        if let Some(s) = sql {
            return Ok(s);
        }
    }
    Err(format!("SQLite 表 {table_name} 不存在或无建表语句"))
}

async fn introspect_mysql_schema(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<DbIntrospectResult, String> {
    let pool = mysql_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_KEY, IS_NULLABLE, COLUMN_COMMENT \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? \
         ORDER BY TABLE_NAME, ORDINAL_POSITION",
    )
    .bind(db_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT TABLE_NAME, INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? \
         ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(db_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    let comments = mysql_fetch_table_comments(&pool, db_name).await?;
    let type_map = mysql_fetch_object_types(&pool, db_name).await?;
    let routines = mysql_fetch_routines(&pool, db_name).await?;
    pool.close().await;

    let mut all_objects: Vec<DbTableSchema> = Vec::new();
    for row in &col_rows {
        let table_name = mysql_row_string(row, 0);
        let column_name = mysql_row_string(row, 1);
        let data_type = mysql_row_string(row, 2);
        let column_key = mysql_row_string(row, 3);
        let is_pk = column_key == "PRI";
        let is_fk = column_key == "MUL";
        let nullable = mysql_row_string(row, 4).eq_ignore_ascii_case("yes");
        let comment = normalize_table_comment(&mysql_row_string(row, 5));

        if let Some(table) = all_objects.iter_mut().find(|t| t.name == table_name) {
            table.columns.push(DbColumnMeta {
                name: column_name,
                column_type: data_type,
                is_pk,
                is_fk,
                nullable,
                comment,
            });
        } else {
            all_objects.push(DbTableSchema {
                name: table_name,
                columns: vec![DbColumnMeta {
                    name: column_name,
                    column_type: data_type,
                    is_pk,
                    is_fk,
                    nullable,
                    comment,
                }],
                indexes: Vec::new(),
                comment: None,
            });
        }
    }

    apply_mysql_index_rows(&mut all_objects, idx_rows);
    apply_table_comments(&mut all_objects, comments);
    let (tables, views) = split_schemas_by_type(all_objects, &type_map);

    Ok(DbIntrospectResult {
        database: db_name.to_string(),
        tables,
        views,
        routines,
    })
}

async fn introspect_mysql_table(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let pool = mysql_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY, IS_NULLABLE, COLUMN_COMMENT \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY ORDINAL_POSITION",
    )
    .bind(db_name)
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE, SEQ_IN_INDEX \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
    )
    .bind(db_name)
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("Query failed: {e}"))?;

    let comment = mysql_fetch_table_comment(&pool, db_name, table_name).await?;
    pool.close().await;

    let columns: Vec<DbColumnMeta> = col_rows
        .iter()
        .map(|row| {
            let column_name = mysql_row_string(row, 0);
            let data_type = mysql_row_string(row, 1);
            let column_key = mysql_row_string(row, 2);
            DbColumnMeta {
                name: column_name,
                column_type: data_type,
                is_pk: column_key == "PRI",
                is_fk: column_key == "MUL",
                nullable: mysql_row_string(row, 3).eq_ignore_ascii_case("yes"),
                comment: normalize_table_comment(&mysql_row_string(row, 4)),
            }
        })
        .collect();

    let mut table = DbTableSchema {
        name: table_name.to_string(),
        columns,
        indexes: Vec::new(),
        comment,
    };
    push_mysql_index_row(&mut table.indexes, idx_rows);
    Ok(table)
}

fn push_mysql_index_row(indexes: &mut Vec<DbIndexMeta>, idx_rows: Vec<sqlx::mysql::MySqlRow>) {
    for row in &idx_rows {
        let index_name = mysql_row_string(row, 0);
        let column_name = mysql_row_string(row, 1);
        let non_unique = mysql_row_i32(row, 2, 1);
        if index_name == "PRIMARY" {
            continue;
        }
        let unique = non_unique == 0;
        if let Some(index) = indexes.iter_mut().find(|i| i.name == index_name) {
            index.columns.push(column_name);
        } else {
            indexes.push(DbIndexMeta {
                name: index_name,
                columns: vec![column_name],
                unique,
            });
        }
    }
}

fn apply_mysql_index_rows(tables: &mut [DbTableSchema], idx_rows: Vec<sqlx::mysql::MySqlRow>) {
    for row in &idx_rows {
        let table_name = mysql_row_string(row, 0);
        let index_name = mysql_row_string(row, 1);
        let column_name = mysql_row_string(row, 2);
        let non_unique = mysql_row_i32(row, 3, 1);
        let table = match tables.iter_mut().find(|t| t.name == table_name) {
            Some(t) => t,
            None => continue,
        };
        if index_name == "PRIMARY" {
            continue;
        }
        let unique = non_unique == 0;
        if let Some(index) = table.indexes.iter_mut().find(|i| i.name == index_name) {
            index.columns.push(column_name);
        } else {
            table.indexes.push(DbIndexMeta {
                name: index_name,
                columns: vec![column_name],
                unique,
            });
        }
    }
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
) -> Result<i64, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
    driver
        .count(table.trim(), where_clause.as_deref())
        .await
        .map_err(err_msg)
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

/// 在指定库上执行单条 SQL（DDL / DML），返回影响行数。
pub async fn db_run_sql(
    connection: DbConnectionConfig,
    schema: Option<String>,
    sql: String,
) -> Result<u64, String> {
    let params = with_schema(&connection, schema);
    if params.database.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }
    let driver = omnipanel_db::connect(&params).await.map_err(err_msg)?;
    driver
        .execute(&sql)
        .await
        .map_err(err_msg)
        .map(|result| result.rows_affected)
}

/// 执行任意 SQL（SELECT 返回行集，DML 返回影响行数）。高风险写操作由前端经执行引擎确认后调用。
/// `limit` / `offset` 非零时，SELECT/WITH 语句会被包裹为 `SELECT * FROM (...) LIMIT n OFFSET m`，防止超大结果集卡死前端。
/// `run_id` 供前端中断长时间查询（`db_cancel_query`）。
#[tauri::command]
pub async fn db_execute_query(
    state: tauri::State<'_, crate::state::AppState>,
    connection: DbConnectionConfig,
    sql: String,
    run_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<QueryResult, String> {
    let wrapped = match limit {
        Some(n) if n > 0 => omnipanel_db::wrap_select_with_limit(
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
    result
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

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisSearchKeysArgs {
    pub connection: DbConnectionConfig,
    pub pattern: String,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default = "default_redis_search_limit")]
    pub limit: u32,
}

fn default_redis_search_limit() -> u32 {
    500
}

/// Redis 键搜索：SCAN + 类型过滤 + 值预览。
#[tauri::command]
#[specta::specta]
pub async fn db_redis_search_keys(args: RedisSearchKeysArgs) -> Result<Vec<RedisKeyEntry>, String> {
    if args.connection.db_type.to_lowercase() != "redis" {
        return Err("仅 Redis 连接支持键搜索".to_string());
    }
    omnipanel_db::redis_search_keys(
        &to_params(&args.connection),
        &args.pattern,
        &args.types,
        args.limit as usize,
    )
    .await
    .map_err(err_msg)
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaCacheDatabasePayload {
    pub name: String,
    pub tables: Vec<DbTableSchema>,
    #[serde(default)]
    pub views: Vec<DbTableSchema>,
    #[serde(default)]
    pub routines: Vec<DbRoutineMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub load_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaConnectionRefreshPayload {
    pub databases: Vec<SchemaCacheDatabasePayload>,
    #[serde(default)]
    pub users: Vec<DbUserMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaTableRefreshPayload {
    pub database_name: String,
    pub object_kind: String,
    pub table: DbTableSchema,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", tag = "scope")]
pub enum SchemaNodeRefreshResult {
    Connection(SchemaConnectionRefreshPayload),
    Database(SchemaCacheDatabasePayload),
    Table(SchemaTableRefreshPayload),
    Users { users: Vec<DbUserMeta> },
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SchemaNodeRefreshArgs {
    pub connection: DbConnectionConfig,
    pub node_kind: String,
    pub node_id: String,
}

fn parse_conn_db_from_rest(rest: &str) -> Option<(String, String)> {
    let colon_indices: Vec<usize> = rest.match_indices(':').map(|(i, _)| i).collect();
    if colon_indices.is_empty() {
        return None;
    }
    let conn_id = rest[..colon_indices[0]].to_string();
    let db_name = rest[colon_indices[0] + 1..].to_string();
    if conn_id.is_empty() || db_name.is_empty() {
        return None;
    }
    Some((conn_id, db_name))
}

fn parse_object_node_id(
    id: &str,
    prefix: &str,
) -> Option<(String, String, String)> {
    let rest = id.strip_prefix(prefix)?;
    let colon_indices: Vec<usize> = rest.match_indices(':').map(|(i, _)| i).collect();
    if colon_indices.len() < 2 {
        return None;
    }
    let conn_id = rest[..colon_indices[0]].to_string();
    let last = *colon_indices.last()?;
    let db_name = rest[colon_indices[0] + 1..last].to_string();
    let mut object_name = rest[last + 1..].to_string();
    if let Some(pos) = object_name.find(":col:") {
        object_name.truncate(pos);
    } else if let Some(pos) = object_name.find(":idx:") {
        object_name.truncate(pos);
    }
    if conn_id.is_empty() || db_name.is_empty() || object_name.is_empty() {
        return None;
    }
    Some((conn_id, db_name, object_name))
}

fn table_key_from_details_folder(id: &str) -> Option<String> {
    id.strip_suffix(":cols")
        .or_else(|| id.strip_suffix(":idxs"))
        .map(str::to_string)
}

async fn refresh_database_payload(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<SchemaCacheDatabasePayload, String> {
    let result = db_introspect_schema(connection.clone(), Some(db_name.to_string())).await?;
    Ok(SchemaCacheDatabasePayload {
        name: result.database,
        tables: result.tables,
        views: result.views,
        routines: result.routines,
        load_error: None,
    })
}

async fn refresh_connection_payload(
    connection: &DbConnectionConfig,
) -> Result<SchemaConnectionRefreshPayload, String> {
    let db_names = db_list_databases(connection.clone()).await?;
    let mut databases = Vec::with_capacity(db_names.len());
    for name in db_names {
        match refresh_database_payload(connection, &name).await {
            Ok(entry) => databases.push(entry),
            Err(err) => databases.push(SchemaCacheDatabasePayload {
                name,
                tables: Vec::new(),
                views: Vec::new(),
                routines: Vec::new(),
                load_error: Some(err),
            }),
        }
    }
    let users = db_list_connection_users(connection.clone())
        .await
        .unwrap_or_default();
    Ok(SchemaConnectionRefreshPayload { databases, users })
}

fn schema_cache_now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn db_table_to_cache_table(table: DbTableSchema) -> SchemaCacheTable {
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

async fn refresh_table_payload(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
    object_kind: &str,
) -> Result<SchemaTableRefreshPayload, String> {
    let table = db_introspect_table(
        connection.clone(),
        Some(db_name.to_string()),
        table_name.to_string(),
    )
    .await?;
    Ok(SchemaTableRefreshPayload {
        database_name: db_name.to_string(),
        object_kind: object_kind.to_string(),
        table,
    })
}

/// 按 Schema 树节点类型刷新缓存片段（连接 / 库 / 表 / 用户等）。
#[tauri::command]
#[specta::specta]
pub async fn db_refresh_schema_node(
    args: SchemaNodeRefreshArgs,
) -> Result<SchemaNodeRefreshResult, String> {
    let kind = args.node_kind.as_str();
    let id = args.node_id.as_str();
    let connection = &args.connection;

    match kind {
        "connection" => Ok(SchemaNodeRefreshResult::Connection(
            refresh_connection_payload(connection).await?,
        )),
        "database" => {
            let (_, db_name) = parse_conn_db_from_rest(id.strip_prefix("db:").ok_or("无效的数据库节点")?)
                .ok_or_else(|| "无法解析数据库节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Database(
                refresh_database_payload(connection, &db_name).await?,
            ))
        }
        "folder" => {
            if let Some(conn_id) = id.strip_prefix("databases:") {
                if conn_id != connection.id {
                    return Err("连接 id 与节点不匹配".to_string());
                }
                return Ok(SchemaNodeRefreshResult::Connection(
                    refresh_connection_payload(connection).await?,
                ));
            }
            if let Some(conn_id) = id.strip_prefix("users:") {
                if conn_id != connection.id {
                    return Err("连接 id 与节点不匹配".to_string());
                }
                return Ok(SchemaNodeRefreshResult::Users {
                    users: db_list_connection_users(connection.clone()).await?,
                });
            }
            if let Some(rest) = id
                .strip_prefix("tbls:")
                .or_else(|| id.strip_prefix("views:"))
                .or_else(|| id.strip_prefix("other:"))
            {
                let (_, db_name) = parse_conn_db_from_rest(rest)
                    .ok_or_else(|| "无法解析文件夹节点".to_string())?;
                return Ok(SchemaNodeRefreshResult::Database(
                    refresh_database_payload(connection, &db_name).await?,
                ));
            }
            if let Some(table_key) = table_key_from_details_folder(id) {
                let (_, db_name, table_name) = parse_object_node_id(&table_key, "tbl:")
                    .ok_or_else(|| "无法解析表字段/索引文件夹".to_string())?;
                return Ok(SchemaNodeRefreshResult::Table(refresh_table_payload(
                    connection,
                    &db_name,
                    &table_name,
                    "table",
                )
                .await?));
            }
            Err(format!("不支持的文件夹节点：{id}"))
        }
        "table" => {
            let (_, db_name, table_name) = parse_object_node_id(id, "tbl:")
                .ok_or_else(|| "无法解析表节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Table(refresh_table_payload(
                connection,
                &db_name,
                &table_name,
                "table",
            )
            .await?))
        }
        "view" => {
            let (_, db_name, view_name) = parse_object_node_id(id, "view:")
                .ok_or_else(|| "无法解析视图节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Table(refresh_table_payload(
                connection,
                &db_name,
                &view_name,
                "view",
            )
            .await?))
        }
        "routine" => {
            let (_, db_name, _) = parse_object_node_id(id, "routine:")
                .ok_or_else(|| "无法解析例程节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Database(
                refresh_database_payload(connection, &db_name).await?,
            ))
        }
        "user" => Ok(SchemaNodeRefreshResult::Users {
            users: db_list_connection_users(connection.clone()).await?,
        }),
        "column" | "index" => {
            let (_, db_name, table_name) = parse_object_node_id(id, "tbl:")
                .ok_or_else(|| "无法解析列/索引节点".to_string())?;
            Ok(SchemaNodeRefreshResult::Table(refresh_table_payload(
                connection,
                &db_name,
                &table_name,
                "table",
            )
            .await?))
        }
        "group" => Err("分组节点请在前端刷新其下连接".to_string()),
        _ => Err(format!("不支持的节点类型：{kind}")),
    }
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
// ─── PostgreSQL Introspection ────────────────────────────────────────────

async fn introspect_pg_schema(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<DbIntrospectResult, String> {
    let pool = pg_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT c.table_name, c.column_name, c.data_type, \
         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk, \
         c.is_nullable = 'YES' AS nullable, pgd.description AS column_comment \
         FROM information_schema.columns c \
         LEFT JOIN ( \
             SELECT ku.column_name, ku.table_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' \
         ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name \
         LEFT JOIN pg_catalog.pg_statio_all_tables st \
           ON c.table_schema = st.schemaname AND c.table_name = st.relname \
         LEFT JOIN pg_catalog.pg_description pgd \
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position \
         WHERE c.table_schema = 'public' \
         ORDER BY c.table_name, c.ordinal_position",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG columns query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT t.relname AS table_name, i.relname AS index_name, \
         a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         WHERE n.nspname = 'public' AND NOT ix.indisprimary \
         ORDER BY t.relname, i.relname, a.attnum",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG indexes query failed: {e}"))?;

    let comments = pg_fetch_table_comments(&pool, "public").await?;
    let type_map = pg_fetch_object_types(&pool, "public").await?;
    let routines = pg_fetch_routines(&pool, "public").await?;
    pool.close().await;

    let mut all_objects: Vec<DbTableSchema> = Vec::new();
    for row in &col_rows {
        let table_name: String = row.try_get(0).unwrap_or_default();
        let column_name: String = row.try_get(1).unwrap_or_default();
        let data_type: String = row.try_get(2).unwrap_or_default();
        let is_pk: bool = row.try_get(3).unwrap_or(false);
        let nullable: bool = row.try_get(4).unwrap_or(false);
        let comment: Option<String> = row
            .try_get::<Option<String>, _>(5)
            .ok()
            .flatten()
            .and_then(|c| normalize_table_comment(&c));

        if let Some(table) = all_objects.iter_mut().find(|t| t.name == table_name) {
            table.columns.push(DbColumnMeta {
                name: column_name,
                column_type: data_type,
                is_pk,
                is_fk: false,
                nullable,
                comment,
            });
        } else {
            all_objects.push(DbTableSchema {
                name: table_name,
                columns: vec![DbColumnMeta {
                    name: column_name,
                    column_type: data_type,
                    is_pk,
                    is_fk: false,
                    nullable,
                    comment,
                }],
                indexes: Vec::new(),
                comment: None,
            });
        }
    }

    for row in &idx_rows {
        let table_name: String = row.try_get(0).unwrap_or_default();
        let index_name: String = row.try_get(1).unwrap_or_default();
        let column_name: String = row.try_get(2).unwrap_or_default();
        let is_unique: bool = row.try_get(3).unwrap_or(false);

        if let Some(table) = all_objects.iter_mut().find(|t| t.name == table_name) {
            if let Some(index) = table.indexes.iter_mut().find(|i| i.name == index_name) {
                index.columns.push(column_name);
            } else {
                table.indexes.push(DbIndexMeta {
                    name: index_name,
                    columns: vec![column_name],
                    unique: is_unique,
                });
            }
        }
    }

    apply_table_comments(&mut all_objects, comments);
    let (tables, views) = split_schemas_by_type(all_objects, &type_map);

    Ok(DbIntrospectResult {
        database: db_name.to_string(),
        tables,
        views,
        routines,
    })
}

async fn introspect_pg_table(
    connection: &DbConnectionConfig,
    _db_name: &str,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let pool = pg_pool(connection).await?;

    let col_rows = sqlx::query(
        "SELECT c.column_name, c.data_type, \
         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk, \
         c.is_nullable = 'YES' AS nullable, pgd.description AS column_comment \
         FROM information_schema.columns c \
         LEFT JOIN ( \
             SELECT ku.column_name, ku.table_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public' \
         ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name \
         LEFT JOIN pg_catalog.pg_statio_all_tables st \
           ON c.table_schema = st.schemaname AND c.table_name = st.relname \
         LEFT JOIN pg_catalog.pg_description pgd \
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position \
         WHERE c.table_schema = 'public' AND c.table_name = $1 \
         ORDER BY c.ordinal_position",
    )
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG columns query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT i.relname AS index_name, a.attname AS column_name, ix.indisunique AS is_unique \
         FROM pg_class t \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         WHERE n.nspname = 'public' AND t.relname = $1 AND NOT ix.indisprimary \
         ORDER BY i.relname, a.attnum",
    )
    .bind(table_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG indexes query failed: {e}"))?;

    let comment = pg_fetch_table_comment(&pool, "public", table_name).await?;
    pool.close().await;

    let columns: Vec<DbColumnMeta> = col_rows
        .iter()
        .map(|row| DbColumnMeta {
            name: row.try_get(0).unwrap_or_default(),
            column_type: row.try_get(1).unwrap_or_default(),
            is_pk: row.try_get(2).unwrap_or(false),
            is_fk: false,
            nullable: row.try_get(3).unwrap_or(false),
            comment: row
                .try_get::<Option<String>, _>(4)
                .ok()
                .flatten()
                .and_then(|c| normalize_table_comment(&c)),
        })
        .collect();

    let mut indexes: Vec<DbIndexMeta> = Vec::new();
    for row in &idx_rows {
        let index_name: String = row.try_get(0).unwrap_or_default();
        let column_name: String = row.try_get(1).unwrap_or_default();
        let is_unique: bool = row.try_get(2).unwrap_or(false);

        if let Some(idx) = indexes.iter_mut().find(|i| i.name == index_name) {
            idx.columns.push(column_name);
        } else {
            indexes.push(DbIndexMeta {
                name: index_name,
                columns: vec![column_name],
                unique: is_unique,
            });
        }
    }

    Ok(DbTableSchema {
        name: table_name.to_string(),
        columns,
        indexes,
        comment,
    })
}

// ─── SQLite Introspection ───────────────────────────────────────────────

fn introspect_sqlite_schema_inner(
    connection: &DbConnectionConfig,
) -> Result<DbIntrospectResult, String> {
    let path = connection.database.trim();
    if path.is_empty() {
        return Err("SQLite database path is empty".into());
    }
    let conn = rusqlite::Connection::open(path).map_err(|e| format!("SQLite open failed: {e}"))?;

    let table_names: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .map_err(|e| format!("SQLite prepare failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("SQLite query failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("SQLite collect failed: {e}"))?
    };

    let view_names: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='view' ORDER BY name")
            .map_err(|e| format!("SQLite prepare failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("SQLite query failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("SQLite collect failed: {e}"))?
    };

    let trigger_names: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
            .map_err(|e| format!("SQLite prepare failed: {e}"))?;
        let rows = stmt
            .query_map([], |row| row.get(0))
            .map_err(|e| format!("SQLite query failed: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("SQLite collect failed: {e}"))?
    };

    let mut tables: Vec<DbTableSchema> = Vec::new();
    for tname in &table_names {
        let columns = sqlite_pragma_columns(&conn, tname)?;
        let indexes = sqlite_pragma_indexes(&conn, tname)?;
        tables.push(DbTableSchema {
            name: tname.clone(),
            columns,
            indexes,
            comment: None,
        });
    }

    let mut views: Vec<DbTableSchema> = Vec::new();
    for vname in &view_names {
        let columns = sqlite_pragma_columns(&conn, vname).unwrap_or_default();
        views.push(DbTableSchema {
            name: vname.clone(),
            columns,
            indexes: Vec::new(),
            comment: None,
        });
    }

    let routines: Vec<DbRoutineMeta> = trigger_names
        .into_iter()
        .map(|name| DbRoutineMeta {
            name,
            routine_type: "trigger".to_string(),
        })
        .collect();

    Ok(DbIntrospectResult {
        database: path.to_string(),
        tables,
        views,
        routines,
    })
}

fn introspect_sqlite_table_inner(
    connection: &DbConnectionConfig,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let path = connection.database.trim();
    if path.is_empty() {
        return Err("SQLite database path is empty".into());
    }
    let conn = rusqlite::Connection::open(path).map_err(|e| format!("SQLite open failed: {e}"))?;

    let columns = sqlite_pragma_columns(&conn, table_name)?;
    let indexes = sqlite_pragma_indexes(&conn, table_name)?;

    Ok(DbTableSchema {
        name: table_name.to_string(),
        columns,
        indexes,
        comment: None,
    })
}

fn sqlite_pragma_columns(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<Vec<DbColumnMeta>, String> {
    let sql = format!("PRAGMA table_info('{}')", table.replace('\'', "''"));
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("PRAGMA table_info failed: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            let notnull: i32 = row.get(3)?;
            Ok(DbColumnMeta {
                name: row.get::<_, String>(1)?,
                column_type: row.get::<_, String>(2)?,
                is_pk: row.get::<_, i32>(5)? > 0,
                is_fk: false,
                nullable: notnull == 0,
                comment: None,
            })
        })
        .map_err(|e| format!("PRAGMA table_info query failed: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row error: {e}"))?);
    }
    Ok(out)
}

fn sqlite_pragma_indexes(
    conn: &rusqlite::Connection,
    table: &str,
) -> Result<Vec<DbIndexMeta>, String> {
    let sql = format!("PRAGMA index_list('{}')", table.replace('\'', "''"));
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("PRAGMA index_list failed: {e}"))?;
    let idx_rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,   // index name
                row.get::<_, i32>(2)? != 0, // unique
            ))
        })
        .map_err(|e| format!("PRAGMA index_list query failed: {e}"))?;

    let mut indexes = Vec::new();
    for r in idx_rows {
        let (idx_name, unique) = r.map_err(|e| format!("row error: {e}"))?;
        let col_sql = format!("PRAGMA index_info('{}')", idx_name.replace('\'', "''"));
        let mut col_stmt = conn
            .prepare(&col_sql)
            .map_err(|e| format!("PRAGMA index_info failed: {e}"))?;
        let cols: Vec<String> = col_stmt
            .query_map([], |row| row.get(2))
            .map_err(|e| format!("PRAGMA index_info query failed: {e}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("collect error: {e}"))?;

        if !cols.is_empty() {
            indexes.push(DbIndexMeta {
                name: idx_name,
                columns: cols,
                unique,
            });
        }
    }
    Ok(indexes)
}

async fn introspect_sqlite_schema(
    connection: &DbConnectionConfig,
) -> Result<DbIntrospectResult, String> {
    let conn = connection.clone();
    tokio::task::spawn_blocking(move || introspect_sqlite_schema_inner(&conn))
        .await
        .map_err(|e| format!("SQLite task failed: {e}"))?
}

async fn introspect_sqlite_table(
    connection: &DbConnectionConfig,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let conn = connection.clone();
    let tname = table_name.to_string();
    tokio::task::spawn_blocking(move || introspect_sqlite_table_inner(&conn, &tname))
        .await
        .map_err(|e| format!("SQLite task failed: {e}"))?
}
