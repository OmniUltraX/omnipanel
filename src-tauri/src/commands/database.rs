use std::collections::HashMap;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use omnipanel_db::{
    DbDriver, DbParams, MongoDriver, QueryResult, RedisKeyDetail, RedisSearchKeysResult,
    RedisSlowLogEntry, mongodb_list_databases, mysql_connect_options, qdrant_list_databases,
};
use omnipanel_error::OmniError;
pub use omnipanel_store::{
    DbConnectionConfig, SchemaCacheColumn, SchemaCacheConnection, SchemaCacheDatabase,
    SchemaCacheIndex, SchemaCacheRoutine, SchemaCacheSnapshot, SchemaCacheTable, SchemaCacheUser,
    SchemaFiltersSnapshot, SchemaTreeExpandedSnapshot, load_schema_cache, load_schema_filters,
    load_schema_tree_expanded, patch_schema_cache_connection, prune_connection_cache,
    prune_connection_expanded, prune_connection_filters, save_schema_cache, save_schema_filters,
    save_schema_tree_expanded,
};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use sqlx::mysql::{MySqlPool, MySqlPoolOptions, MySqlRow};
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

/// 读取可能为 NULL 的整数列（如 CHARACTER_MAXIMUM_LENGTH / NUMERIC_PRECISION）。
/// 返回 i32 以兼容 specta 的 TypeScript 导出（禁止 i64）；列长度/精度不会超过 i32 范围。
fn mysql_row_optional_i32(row: &MySqlRow, index: usize) -> Option<i32> {
    if let Ok(v) = row.try_get::<Option<i32>, _>(index) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(index) {
        return v.map(|x| x as i32);
    }
    if let Ok(v) = row.try_get::<Option<u32>, _>(index) {
        return v.map(|x| x as i32);
    }
    if let Ok(v) = row.try_get::<Option<u64>, _>(index) {
        return v.map(|x| x as i32);
    }
    let s = mysql_row_string(row, index);
    if s.is_empty() {
        None
    } else {
        s.trim().parse::<i32>().ok()
    }
}

/// 归一化 MySQL 的 COLUMN_DEFAULT：
/// - NULL（字符串 "NULL" 或真正 NULL 列）→ None
/// - 当前时间戳的特殊标记 "CURRENT_TIMESTAMP" / "current_timestamp()" 保留原样
/// - 字符串字面量去外层引号（MySQL 返回 `'foo'`，我们存 `foo`），在 apply 时按需再加引号
/// - 数值字面量保持原样
fn normalize_mysql_column_default(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("null") {
        return None;
    }
    // 去除字符串字面量的外层单引号（MySQL information_schema 用双单引号转义）
    let lower = trimmed.to_ascii_lowercase();
    if lower == "current_timestamp" || lower == "current_timestamp()" || lower == "now()" {
        return Some(trimmed.to_string());
    }
    if trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2 {
        let inner = &trimmed[1..trimmed.len() - 1];
        return Some(inner.replace("''", "'"));
    }
    Some(trimmed.to_string())
}

/// 归一化 PG 的 column_default：
/// - NULL → None
/// - 序列默认值（nextval(...)）属于 auto-increment 的实现细节，不展示为用户可编辑的 default
/// - 字符串字面量 `'foo'`::text → foo（去引号和类型标注）
/// - 数值 / 表达式保持原样
fn normalize_pg_column_default(raw: Option<&str>, is_auto_increment: bool) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("null") {
        return None;
    }
    // 序列默认值由 is_auto_increment 标识，不在 default 字段重复展示
    if is_auto_increment || s.starts_with("nextval(") {
        return None;
    }
    // 去掉 ::type 类型标注（如 'foo'::text → 'foo'）
    let s = if let Some(pos) = s.find("::") {
        s[..pos].trim()
    } else {
        s
    };
    // 去掉字符串字面量的外层单引号（PG 用双单引号转义）
    if s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2 {
        let inner = &s[1..s.len() - 1];
        return Some(inner.replace("''", "'"));
    }
    Some(s.to_string())
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

    // 优先带属性查询；旧版本无 account_locked 时回退基础查询。
    let rich_sql = "SELECT User, Host, \
         IFNULL(Super_priv, 'N'), \
         IFNULL(Create_priv, 'N'), \
         IFNULL(account_locked, 'N') \
         FROM mysql.user ORDER BY User, Host";
    let basic_sql = "SELECT User, Host, \
         IFNULL(Super_priv, 'N'), \
         IFNULL(Create_priv, 'N') \
         FROM mysql.user ORDER BY User, Host";

    let rows = match sqlx::query(rich_sql).fetch_all(&pool).await {
        Ok(rows) => rows,
        Err(e) => {
            let msg = format!("{e}");
            let lower = msg.to_ascii_lowercase();
            if lower.contains("1142")
                || lower.contains("access denied")
                || lower.contains("command denied")
                || lower.contains("for table 'user'")
                || lower.contains("for table \"user\"")
            {
                return Ok(Vec::new());
            }
            // account_locked 等列不存在时回退
            if lower.contains("unknown column") || lower.contains("1054") {
                match sqlx::query(basic_sql).fetch_all(&pool).await {
                    Ok(rows) => rows,
                    Err(e2) => {
                        let msg2 = format!("{e2}");
                        let lower2 = msg2.to_ascii_lowercase();
                        if lower2.contains("1142")
                            || lower2.contains("access denied")
                            || lower2.contains("command denied")
                        {
                            return Ok(Vec::new());
                        }
                        return Err(format!("Query failed: {msg2}"));
                    }
                }
            } else {
                return Err(format!("Query failed: {msg}"));
            }
        }
    };

    Ok(rows
        .into_iter()
        .map(|row| {
            let super_priv = mysql_row_string(&row, 2);
            let create_priv = mysql_row_string(&row, 3);
            let locked_raw = mysql_row_string(&row, 4);
            let account_locked = if locked_raw.is_empty() {
                None
            } else {
                Some(locked_raw.eq_ignore_ascii_case("Y") || locked_raw == "1")
            };
            DbUserMeta {
                name: mysql_row_string(&row, 0),
                host: Some(mysql_row_string(&row, 1)),
                can_login: !account_locked.unwrap_or(false),
                is_superuser: super_priv.eq_ignore_ascii_case("Y"),
                can_create_db: create_priv.eq_ignore_ascii_case("Y"),
                is_role: false,
                account_locked,
            }
        })
        .collect())
}

/// 跨多个 schema 收集对象类型，返回 (schema, table_name, table_type) 列表。
/// 用于替代单 schema 的 pg_fetch_object_types，让边栏树显示所有 schema 的表。
async fn pg_fetch_object_types_all_schemas(
    pool: &PgPool,
    schemas: &[String],
) -> Result<Vec<(String, String, String)>, String> {
    let mut out = Vec::new();
    for schema in schemas {
        let rows = sqlx::query(
            "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = $1",
        )
        .bind(schema)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("PG table types query failed: {e}"))?;
        for row in rows {
            out.push((
                schema.clone(),
                row.try_get::<String, _>(0).unwrap_or_default(),
                row.try_get::<String, _>(1).unwrap_or_default(),
            ));
        }
    }
    Ok(out)
}

/// 跨多个 schema 收集表注释，返回 (table_display_name, comment)。
/// table_display_name 与 pg_resolve_table_display 一致。
async fn pg_fetch_table_comments_all_schemas(
    pool: &PgPool,
    schemas: &[String],
) -> Result<HashMap<String, String>, String> {
    let mut map = HashMap::new();
    for schema in schemas {
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
        for row in rows {
            let name: String = row.try_get(0).unwrap_or_default();
            let comment: Option<String> = row.try_get(1).ok();
            if let Some(normalized) = comment.and_then(|c| normalize_table_comment(&c)) {
                map.insert(pg_resolve_table_display(schema, &name), normalized);
            }
        }
    }
    Ok(map)
}

/// 跨多个 schema 收集 routines/triggers，返回聚合列表。
async fn pg_fetch_routines_all_schemas(
    pool: &PgPool,
    schemas: &[String],
) -> Result<Vec<DbRoutineMeta>, String> {
    let mut routines = Vec::new();
    for schema in schemas {
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
    }
    Ok(routines)
}

/// 解析表名为 (schema, table)：支持 "schema.table" 形式或纯 "table"（默认 public）。
/// 与 pg_resolve_table_display 对应，用于 introspect_pg_table 跨 schema 查询。
fn pg_parse_qualified_table(name: &str) -> (String, String) {
    if let Some((schema, table)) = name.rsplit_once('.') {
        if !schema.is_empty() && !table.is_empty() {
            return (schema.to_string(), table.to_string());
        }
    }
    ("public".to_string(), name.to_string())
}

/// 生成表的展示名：仅一个 schema 时或默认 public 下用纯表名，
/// 多 schema 且有重名时用 "schema.table" 避免歧义。
/// 这里统一用：schema == "public" 时用纯表名，否则用 "schema.table"。
fn pg_resolve_table_display(schema: &str, table: &str) -> String {
    if schema == "public" {
        table.to_string()
    } else {
        format!("{schema}.{table}")
    }
}

async fn pg_list_users(connection: &DbConnectionConfig) -> Result<Vec<DbUserMeta>, String> {
    let pool = pg_pool(connection).await?;
    let rows = sqlx::query(
        "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb \
         FROM pg_catalog.pg_roles \
         ORDER BY rolname",
    )
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG users query failed: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let can_login: bool = row.try_get(1).unwrap_or(false);
            let is_superuser: bool = row.try_get(2).unwrap_or(false);
            let can_create_db: bool = row.try_get(3).unwrap_or(false);
            DbUserMeta {
                name: row.try_get(0).unwrap_or_default(),
                host: None,
                can_login,
                is_superuser,
                can_create_db,
                is_role: !can_login,
                account_locked: None,
            }
        })
        .collect())
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
pub struct DbColumnMeta {
    pub name: String,
    #[serde(rename = "type")]
    pub column_type: String,
    pub is_pk: bool,
    pub is_fk: bool,
    #[serde(default)]
    pub nullable: bool,
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    /// 列长度（来自 information_schema）：MySQL CHARACTER_MAXIMUM_LENGTH / NUMERIC_PRECISION；PG character_maximum_length / numeric_precision
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub length: Option<i32>,
    /// 列默认值表达式（原始字符串，如 "'0'" / "nextval(...)" / "CURRENT_TIMESTAMP"）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_value: Option<String>,
}

fn mysql_extra_is_auto_increment(extra: &str) -> bool {
    extra.to_ascii_lowercase().contains("auto_increment")
}

fn type_implies_auto_increment(column_type: &str) -> bool {
    let t = column_type.to_ascii_lowercase();
    t.contains("auto_increment") || t.contains("serial") || t.contains("identity")
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
    /// 是否可登录（MySQL 默认 true；PG 对应 rolcanlogin）
    #[serde(default)]
    pub can_login: bool,
    /// 是否超级用户 / SUPER 权限
    #[serde(default)]
    pub is_superuser: bool,
    /// 是否可创建数据库
    #[serde(default)]
    pub can_create_db: bool,
    /// PostgreSQL 中无 LOGIN 的角色；MySQL 恒为 false
    #[serde(default)]
    pub is_role: bool,
    /// MySQL account_locked；PG 无此概念
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_locked: Option<bool>,
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
pub struct DbTableDetails {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub row_count: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub data_length: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_format: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update_time: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collation: Option<String>,
}

/// 库内多表详情（一次查询回填表列表，避免 N 次建连）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbNamedTableDetails {
    pub name: String,
    pub details: DbTableDetails,
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

/// 打开可复用的数据库驱动（供后台同步任务分页读取，避免每页新建连接池）。
pub(crate) async fn open_db_driver(c: &DbConnectionConfig) -> Result<Box<dyn DbDriver>, String> {
    omnipanel_db::connect(&to_params(c)).await.map_err(err_msg)
}

pub(crate) fn query_result_to_row_maps(
    result: QueryResult,
) -> Vec<HashMap<String, serde_json::Value>> {
    let columns = result.columns;
    result
        .rows
        .into_iter()
        .map(|record| {
            columns
                .iter()
                .cloned()
                .zip(record)
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .collect()
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
    let opts = sqlx::postgres::PgConnectOptions::new()
        .host(&p.host)
        .port(p.port)
        .username(&p.user)
        .password(&p.password)
        .database(&p.database);
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

/// 连接到指定数据库的 PG 连接池（用于跨库 introspection：PG 的 information_schema
/// 是库级本地视图，必须切到目标库才能拿到该库的表/列/索引）。
/// 缓存 key 为 `{conn_id}:{db_name}`，fingerprint 包含 db_name 以便区分。
async fn pg_pool_for_db(connection: &DbConnectionConfig, db_name: &str) -> Result<PgPool, String> {
    let trimmed = db_name.trim();
    if trimmed.is_empty() {
        // 未指定库名时退回到默认连接池（连接配置里的 database）
        return pg_pool(connection).await;
    }
    // 与默认 database 相同则直接用 pg_pool，避免重复建池
    if connection.database.trim() == trimmed {
        return pg_pool(connection).await;
    }

    let key = format!("{}:{}", connection.id, trimmed);
    let fingerprint = format!(
        "{}|{}|{}|{}|{}|{}|{}",
        connection.db_type,
        connection.host,
        connection.port,
        connection.user,
        connection.password,
        trimmed,
        connection.ssl
    );

    // Fast path
    {
        let cache = sqlx_pool_cache().lock().await;
        if let Some((cached_fp, pool)) = cache.pg.get(&key) {
            if cached_fp == &fingerprint {
                return Ok(pool.clone());
            }
        }
    }

    let establish_lock = {
        let mut cache = sqlx_pool_cache().lock().await;
        cache
            .pg_establishing
            .entry(key.clone())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    };
    let _guard = establish_lock.lock().await;

    {
        let cache = sqlx_pool_cache().lock().await;
        if let Some((cached_fp, pool)) = cache.pg.get(&key) {
            if cached_fp == &fingerprint {
                return Ok(pool.clone());
            }
        }
    }

    let p = to_params(connection);
    let opts = sqlx::postgres::PgConnectOptions::new()
        .host(&p.host)
        .port(p.port)
        .username(&p.user)
        .password(&p.password)
        .database(trimmed);
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Some(Duration::from_secs(300)))
        .connect_with(opts)
        .await
        .map_err(|e| format!("PostgreSQL 连接数据库 `{trimmed}` 失败: {e}"))?;

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

/// 枚举 PG 非 system schema（pg_catalog / information_schema 之外的用户 schema）。
/// 用于替代硬编码 'public'，让边栏树能显示所有 schema 下的表。
async fn pg_list_user_schemas(pool: &PgPool) -> Result<Vec<String>, String> {
    let rows = sqlx::query(
        "SELECT nspname FROM pg_namespace \
         WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast') \
         AND nspname NOT LIKE 'pg_temp_%' \
         AND nspname NOT LIKE 'pg_toast_temp_%' \
         ORDER BY nspname",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG schemas query failed: {e}"))?;
    let mut schemas: Vec<String> = rows
        .into_iter()
        .map(|row| row.try_get::<String, _>(0).unwrap_or_default())
        .filter(|s| !s.is_empty())
        .collect();
    // 确保至少有 'public'（新建库可能还没有 public schema 的表，但 schema 名仍在）
    if !schemas.iter().any(|s| s == "public") {
        schemas.push("public".to_string());
    }
    Ok(schemas)
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
pub async fn db_test_connection(connection: DbConnectionConfig) -> Result<String, String> {
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
    let mut params = to_params(&connection);
    if matches!(db_type.as_str(), "mongodb" | "mongo") && params.database.trim().is_empty() {
        params.database = "admin".to_string();
    }
    if db_type == "qdrant" && params.database.trim().is_empty() {
        params.database = "default".to_string();
    }
    let driver = omnipanel_db::connect(&params)
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
            Ok(databases)
        }
        "redis" => {
            let preset = connection.database.clone();
            omnipanel_db::redis_list_databases(&to_params(&connection), &preset)
                .await
                .map_err(err_msg)
        }
        "postgresql" | "postgres" => {
            let pool = pg_pool(&connection).await?;
            let rows = sqlx::query(
                "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;
            Ok(rows
                .into_iter()
                .map(|row| row.try_get::<String, _>(0).unwrap_or_default())
                .collect())
        }
        "mongodb" | "mongo" => mongodb_list_databases(&to_params(&connection))
            .await
            .map_err(err_msg),
        "qdrant" => qdrant_list_databases(&to_params(&connection))
            .await
            .map_err(err_msg),
        _ if !connection.database.trim().is_empty() => Ok(vec![connection.database.clone()]),
        _ => Ok(vec![]),
    }
}

/// 库列表（含统计信息）：库名 / 字符集 / 排序规则 / 表数 / 大小 / 行数
/// 单条 LEFT JOIN 查询，避免 N+1
#[tauri::command]
#[specta::specta]
pub async fn db_list_databases_with_stats(
    connection: DbConnectionConfig,
) -> Result<Vec<DbDatabaseMeta>, String> {
    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => {
            let pool = mysql_pool(&connection).await?;
            // SCHEMATA LEFT JOIN TABLES 聚合：一条查询拿到全部统计
            // TABLE_ROWS / DATA_LENGTH 为估算值（InnoDB 不精确），仅作参考
            // CAST(... AS CHAR) 把 DECIMAL/BIGINT 转成字符串，mysql_row_string 才能解码
            let rows = sqlx::query(
                "SELECT \
                   s.SCHEMA_NAME, \
                   s.DEFAULT_CHARACTER_SET_NAME, \
                   s.DEFAULT_COLLATION_NAME, \
                   CAST(COUNT(t.TABLE_NAME) AS CHAR) AS table_count, \
                   CAST(COALESCE(SUM(t.DATA_LENGTH + t.INDEX_LENGTH), 0) AS CHAR) AS size_bytes, \
                   CAST(COALESCE(SUM(t.TABLE_ROWS), 0) AS CHAR) AS rows_estimate \
                 FROM information_schema.SCHEMATA s \
                 LEFT JOIN information_schema.TABLES t \
                   ON t.TABLE_SCHEMA = s.SCHEMA_NAME \
                 GROUP BY s.SCHEMA_NAME, s.DEFAULT_CHARACTER_SET_NAME, s.DEFAULT_COLLATION_NAME \
                 ORDER BY s.SCHEMA_NAME",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|row| {
                    let name = mysql_row_string(&row, 0);
                    let charset = {
                        let s = mysql_row_string(&row, 1);
                        if s.is_empty() { None } else { Some(s) }
                    };
                    let collation = {
                        let s = mysql_row_string(&row, 2);
                        if s.is_empty() { None } else { Some(s) }
                    };
                    // MySQL SUM() 返回 DECIMAL 类型，try_get::<i64> 会失败，
                    // 用字符串解析兼容 DECIMAL / BIGINT / INT 等各种返回类型
                    let table_count = {
                        let s = mysql_row_string(&row, 3);
                        if s.is_empty() { None } else { s.parse::<i32>().ok() }
                    };
                    let size_bytes = {
                        let s = mysql_row_string(&row, 4);
                        if s.is_empty() { None } else { s.parse::<f64>().ok() }
                    };
                    let rows_estimate = {
                        let s = mysql_row_string(&row, 5);
                        if s.is_empty() { None } else { s.parse::<f64>().ok() }
                    };
                    DbDatabaseMeta {
                        name,
                        charset,
                        collation,
                        table_count,
                        size_bytes,
                        rows_estimate,
                    }
                })
                .collect())
        }
        "postgresql" | "postgres" => {
            let pool = pg_pool(&connection).await?;
            // pg_database_size() 可跨库查询任意库大小；encoding/datcollate 给出
            // 字符集与排序规则。PG 的 information_schema 仅含当前库的表，无法跨库
            // 统计表数/行数，故 table_count / rows_estimate 留空（前端显示「—」）。
            let rows = sqlx::query(
                "SELECT d.datname, \
                   pg_encoding_to_char(d.encoding) AS encoding, \
                   d.datcollate AS collation, \
                   pg_database_size(d.datname) AS size_bytes \
                 FROM pg_database d \
                 WHERE NOT d.datistemplate \
                 ORDER BY d.datname",
            )
            .fetch_all(&pool)
            .await
            .map_err(|e| format!("Query failed: {e}"))?;

            Ok(rows
                .into_iter()
                .map(|row| {
                    let name: String = row.try_get(0).unwrap_or_default();
                    let charset = {
                        let s: String = row.try_get(1).unwrap_or_default();
                        if s.is_empty() { None } else { Some(s) }
                    };
                    let collation = {
                        let s: String = row.try_get(2).unwrap_or_default();
                        if s.is_empty() { None } else { Some(s) }
                    };
                    let size_bytes = {
                        let v: i64 = row.try_get(3).unwrap_or(0);
                        Some(v as f64)
                    };
                    DbDatabaseMeta {
                        name,
                        charset,
                        collation,
                        table_count: None,
                        size_bytes,
                        rows_estimate: None,
                    }
                })
                .collect())
        }
        "redis" => {
            let preset = connection.database.clone();
            let infos = omnipanel_db::redis_list_databases_with_key_counts(
                &to_params(&connection),
                &preset,
            )
            .await
            .map_err(err_msg)?;
            Ok(infos
                .into_iter()
                .map(|info| DbDatabaseMeta {
                    name: info.name,
                    charset: None,
                    collation: None,
                    table_count: None,
                    size_bytes: None,
                    rows_estimate: Some(info.key_count as f64),
                })
                .collect())
        }
        "qdrant" => {
            let infos = omnipanel_db::qdrant_list_collection_infos(&to_params(&connection))
                .await
                .map_err(err_msg)?;
            let collection_count = infos.len() as i32;
            let points_estimate: f64 = infos.iter().map(|i| i.points_count as f64).sum();
            Ok(vec![DbDatabaseMeta {
                name: "default".to_string(),
                charset: None,
                collation: None,
                table_count: Some(collection_count),
                size_bytes: None,
                rows_estimate: Some(points_estimate),
            }])
        }
        // 非 MySQL/PG/Redis/Qdrant 引擎退化为仅库名
        _ => {
            let names = db_list_databases(connection).await?;
            Ok(names
                .into_iter()
                .map(|name| DbDatabaseMeta {
                    name,
                    charset: None,
                    collation: None,
                    table_count: None,
                    size_bytes: None,
                    rows_estimate: None,
                })
                .collect())
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbCharsetMeta {
    pub charset: String,
    pub description: String,
    pub default_collation: String,
}

/// 数据库元信息（库列表 tab 展示用）
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DbDatabaseMeta {
    /// 库名
    pub name: String,
    /// 默认字符集
    pub charset: Option<String>,
    /// 默认排序规则
    pub collation: Option<String>,
    /// 表数量（含视图）
    pub table_count: Option<i32>,
    /// 数据 + 索引总大小（字节）；f64 避免 u64 被 Specta 禁止导出
    pub size_bytes: Option<f64>,
    /// 估算总行数
    pub rows_estimate: Option<f64>,
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
    Ok(charsets)
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_character_sets(
    connection: DbConnectionConfig,
) -> Result<Vec<DbCharsetMeta>, String> {
    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => mysql_list_character_sets(&connection).await,
        // PostgreSQL 用 ENCODING 而非 MySQL 的 CHARACTER SET 概念；
        // 返回常见编码供前端「创建数据库」对话框选择。
        "postgresql" | "postgres" => Ok(vec![
            DbCharsetMeta {
                charset: "UTF8".into(),
                description: "Unicode, 8-bit".into(),
                default_collation: "C.UTF-8".into(),
            },
            DbCharsetMeta {
                charset: "LATIN1".into(),
                description: "ISO 8859-1, ECMA 94, 8-bit".into(),
                default_collation: "C".into(),
            },
            DbCharsetMeta {
                charset: "LATIN2".into(),
                description: "ISO 8859-2, ECMA 94, 8-bit".into(),
                default_collation: "C".into(),
            },
            DbCharsetMeta {
                charset: "LATIN9".into(),
                description: "ISO 8859-15, 8-bit".into(),
                default_collation: "C".into(),
            },
            DbCharsetMeta {
                charset: "WIN1252".into(),
                description: "Windows CP1252, 8-bit".into(),
                default_collation: "C".into(),
            },
            DbCharsetMeta {
                charset: "EUC_JP".into(),
                description: "Japanese EUC".into(),
                default_collation: "C".into(),
            },
            DbCharsetMeta {
                charset: "EUC_CN".into(),
                description: "Chinese EUC, GB2312".into(),
                default_collation: "C".into(),
            },
            DbCharsetMeta {
                charset: "SQL_ASCII".into(),
                description: "unspecified, 7-bit".into(),
                default_collation: "C".into(),
            },
        ]),
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
            Ok(name)
        }
        "postgresql" | "postgres" => {
            let pool = pg_pool(&args.connection).await?;
            // PG 标识符用双引号；CREATE DATABASE 不能在事务块中执行，
            // sqlx 单条 query 默认不开启事务，可直接执行。
            let escaped_name = name.replace('"', "\"\"");
            // PG：charset → ENCODING，collation → LC_COLLATE
            let encoding_clause = match args
                .charset
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                Some(enc) => {
                    let e = enc.replace('\'', "''");
                    format!(" ENCODING '{e}'")
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
                    let c = co.replace('\'', "''");
                    format!(" LC_COLLATE '{c}'")
                }
                None => String::new(),
            };
            let sql = format!("CREATE DATABASE \"{escaped_name}\"{encoding_clause}{collation_clause}");
            sqlx::query(&sql)
                .execute(&pool)
                .await
                .map_err(|e| format!("创建数据库失败：{e}"))?;
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
        "sqlite" | "sqlite3" => introspect_sqlite_schema(&connection).await,
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
        "sqlite" | "sqlite3" => introspect_sqlite_table(&connection, table.trim()).await,
        "mongodb" | "mongo" => introspect_mongo_table(&connection, &db_name, table.trim()).await,
        "qdrant" => introspect_qdrant_collection(&connection, table.trim()).await,
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
        "sqlite" | "sqlite3" => sqlite_table_ddl(&connection, table.trim()),
        _ => Err(format!("不支持的数据库类型: {}", connection.db_type)),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_get_table_details(
    connection: DbConnectionConfig,
    schema: Option<String>,
    table: String,
) -> Result<DbTableDetails, String> {
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
        "mysql" | "mariadb" => mysql_table_details(&connection, &db_name, table.trim()).await,
        "postgresql" | "postgres" => pg_table_details(&connection, &db_name, table.trim()).await,
        "sqlite" | "sqlite3" => sqlite_table_details(&connection, table.trim()).await,
        _ => Err(format!("不支持的数据库类型: {}", connection.db_type)),
    }
}

/// 一次拉取库内全部表详情（表列表首屏用；避免逐表建连）。
#[tauri::command]
#[specta::specta]
pub async fn db_list_table_details(
    connection: DbConnectionConfig,
    schema: Option<String>,
) -> Result<Vec<DbNamedTableDetails>, String> {
    let db_name = schema
        .filter(|name| !name.trim().is_empty())
        .unwrap_or_else(|| connection.database.clone());
    if db_name.trim().is_empty() {
        return Err("未指定数据库".to_string());
    }

    match connection.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => mysql_list_table_details(&connection, &db_name).await,
        "postgresql" | "postgres" => pg_list_table_details(&connection, &db_name).await,
        "sqlite" | "sqlite3" => sqlite_list_table_details(&connection).await,
        _ => Err(format!("不支持的数据库类型: {}", connection.db_type)),
    }
}

fn mysql_row_opt_i64(row: &MySqlRow, index: usize) -> Option<i64> {
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return Some(v);
    }
    if let Ok(v) = row.try_get::<u64, _>(index) {
        return Some(v as i64);
    }
    if let Ok(v) = row.try_get::<Option<i64>, _>(index) {
        return v;
    }
    if let Ok(v) = row.try_get::<Option<u64>, _>(index) {
        return v.map(|n| n as i64);
    }
    None
}

fn mysql_row_opt_string(row: &MySqlRow, index: usize) -> Option<String> {
    let value = mysql_row_string(row, index);
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn mysql_row_timestamp(row: &MySqlRow, index: usize) -> Option<String> {
    mysql_row_opt_string(row, index)
}

async fn mysql_table_details(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<DbTableDetails, String> {
    let pool = mysql_pool(connection).await?;
    let row = sqlx::query(
        "SELECT TABLE_ROWS, DATA_LENGTH, ENGINE, ROW_FORMAT, CREATE_TIME, UPDATE_TIME, \
         TABLE_COMMENT, TABLE_COLLATION \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? \
         LIMIT 1",
    )
    .bind(db_name)
    .bind(table_name)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("查询表信息失败: {e}"))?;

    let Some(row) = row else {
        return Err(format!("表 {table_name} 不存在"));
    };

    Ok(mysql_details_from_info_row(&row, 0))
}

fn mysql_details_from_info_row(row: &MySqlRow, offset: usize) -> DbTableDetails {
    DbTableDetails {
        row_count: mysql_row_opt_i64(row, offset),
        data_length: mysql_row_opt_i64(row, offset + 1),
        row_format: mysql_row_opt_string(row, offset + 3),
        engine: mysql_row_opt_string(row, offset + 2),
        create_time: mysql_row_timestamp(row, offset + 4),
        update_time: mysql_row_timestamp(row, offset + 5),
        comment: normalize_table_comment(&mysql_row_string(row, offset + 6)),
        collation: mysql_row_opt_string(row, offset + 7),
    }
}

async fn mysql_list_table_details(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<Vec<DbNamedTableDetails>, String> {
    let pool = mysql_pool(connection).await?;
    let rows = sqlx::query(
        "SELECT TABLE_NAME, TABLE_ROWS, DATA_LENGTH, ENGINE, ROW_FORMAT, CREATE_TIME, UPDATE_TIME, \
         TABLE_COMMENT, TABLE_COLLATION \
         FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' \
         ORDER BY TABLE_NAME",
    )
    .bind(db_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询表信息失败: {e}"))?;

    Ok(rows
        .into_iter()
        .map(|row| DbNamedTableDetails {
            name: mysql_row_string(&row, 0),
            details: mysql_details_from_info_row(&row, 1),
        })
        .filter(|item| !item.name.is_empty())
        .collect())
}

async fn pg_table_details(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<DbTableDetails, String> {
    let pool = pg_pool_for_db(connection, db_name).await?;
    let (schema_name, pure_table) = pg_parse_qualified_table(table_name);

    let row = sqlx::query(
        "SELECT c.reltuples::bigint, pg_relation_size(c.oid)::bigint, \
         obj_description(c.oid, 'pg_class'), \
         (SELECT datcollate FROM pg_database WHERE datname = current_database()) \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p') \
         LIMIT 1",
    )
    .bind(&schema_name)
    .bind(&pure_table)
    .fetch_optional(&pool)
    .await
    .map_err(|e| format!("查询表信息失败: {e}"))?;

    let Some(row) = row else {
        return Err(format!("表 {table_name} 不存在"));
    };

    let row_count = row.try_get::<i64, _>(0).ok().filter(|v| *v >= 0);
    let data_length = row.try_get::<i64, _>(1).ok().filter(|v| *v >= 0);
    let comment: Option<String> = row
        .try_get::<Option<String>, _>(2)
        .ok()
        .flatten()
        .and_then(|c| normalize_table_comment(&c));
    let collation: Option<String> = row.try_get::<Option<String>, _>(3).ok().flatten();

    Ok(DbTableDetails {
        row_count,
        data_length,
        row_format: None,
        engine: Some("Heap".to_string()),
        create_time: None,
        update_time: None,
        comment,
        collation,
    })
}

async fn pg_list_table_details(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<Vec<DbNamedTableDetails>, String> {
    let pool = pg_pool_for_db(connection, db_name).await?;
    // PG 库详情页的表列表对应 public schema（与浅加载一致）
    let schema_name = "public";

    let rows = sqlx::query(
        "SELECT c.relname, c.reltuples::bigint, pg_relation_size(c.oid)::bigint, \
         obj_description(c.oid, 'pg_class'), \
         (SELECT datcollate FROM pg_database WHERE datname = current_database()) \
         FROM pg_class c \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') \
         ORDER BY c.relname",
    )
    .bind(&schema_name)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("查询表信息失败: {e}"))?;

    Ok(rows
        .into_iter()
        .filter_map(|row| {
            let name = row.try_get::<String, _>(0).ok()?;
            if name.trim().is_empty() {
                return None;
            }
            let row_count = row.try_get::<i64, _>(1).ok().filter(|v| *v >= 0);
            let data_length = row.try_get::<i64, _>(2).ok().filter(|v| *v >= 0);
            let comment: Option<String> = row
                .try_get::<Option<String>, _>(3)
                .ok()
                .flatten()
                .and_then(|c| normalize_table_comment(&c));
            let collation: Option<String> = row.try_get::<Option<String>, _>(4).ok().flatten();
            Some(DbNamedTableDetails {
                name,
                details: DbTableDetails {
                    row_count,
                    data_length,
                    row_format: None,
                    engine: Some("Heap".to_string()),
                    create_time: None,
                    update_time: None,
                    comment,
                    collation,
                },
            })
        })
        .collect())
}

async fn sqlite_table_details(
    connection: &DbConnectionConfig,
    table_name: &str,
) -> Result<DbTableDetails, String> {
    let conn = connection.clone();
    let table = table_name.to_string();
    tokio::task::spawn_blocking(move || sqlite_table_details_inner(&conn, &table))
        .await
        .map_err(|e| format!("SQLite task failed: {e}"))?
}

fn sqlite_quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

fn sqlite_table_details_inner(
    connection: &DbConnectionConfig,
    table_name: &str,
) -> Result<DbTableDetails, String> {
    let path = connection.database.trim();
    if path.is_empty() {
        return Err("SQLite database path is empty".into());
    }
    let conn = rusqlite::Connection::open(path).map_err(|e| format!("SQLite open failed: {e}"))?;

    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
            [table_name],
            |row| row.get(0),
        )
        .map_err(|e| format!("SQLite table lookup failed: {e}"))?;
    if exists == 0 {
        return Err(format!("表 {table_name} 不存在"));
    }

    let row_count: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM {}", sqlite_quote_ident(table_name)),
            [],
            |row| row.get(0),
        )
        .map_err(|e| format!("统计行数失败: {e}"))?;

    let page_count: i64 = conn
        .query_row("PRAGMA page_count", [], |row| row.get(0))
        .unwrap_or(0);
    let page_size: i64 = conn
        .query_row("PRAGMA page_size", [], |row| row.get(0))
        .unwrap_or(0);

    Ok(DbTableDetails {
        row_count: Some(row_count),
        data_length: Some(page_count.saturating_mul(page_size)),
        row_format: None,
        engine: Some("SQLite".to_string()),
        create_time: None,
        update_time: None,
        comment: None,
        collation: None,
    })
}

async fn sqlite_list_table_details(
    connection: &DbConnectionConfig,
) -> Result<Vec<DbNamedTableDetails>, String> {
    let conn = connection.clone();
    tokio::task::spawn_blocking(move || {
        let path = conn.database.trim();
        if path.is_empty() {
            return Err("SQLite database path is empty".into());
        }
        let sqlite =
            rusqlite::Connection::open(path).map_err(|e| format!("SQLite open failed: {e}"))?;
        let mut stmt = sqlite
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .map_err(|e| format!("SQLite list tables failed: {e}"))?;
        let names: Vec<String> = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| format!("SQLite list tables failed: {e}"))?
            .filter_map(|item| item.ok())
            .collect();

        let page_count: i64 = sqlite
            .query_row("PRAGMA page_count", [], |row| row.get(0))
            .unwrap_or(0);
        let page_size: i64 = sqlite
            .query_row("PRAGMA page_size", [], |row| row.get(0))
            .unwrap_or(0);
        let data_length = Some(page_count.saturating_mul(page_size));

        let mut out = Vec::with_capacity(names.len());
        for table_name in names {
            let row_count: i64 = sqlite
                .query_row(
                    &format!("SELECT COUNT(*) FROM {}", sqlite_quote_ident(&table_name)),
                    [],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            out.push(DbNamedTableDetails {
                name: table_name,
                details: DbTableDetails {
                    row_count: Some(row_count),
                    data_length,
                    row_format: None,
                    engine: Some("SQLite".to_string()),
                    create_time: None,
                    update_time: None,
                    comment: None,
                    collation: None,
                },
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("SQLite task failed: {e}"))?
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

    // SHOW CREATE TABLE 返回两列：Table 名称 + Create Table 语句
    let create_sql: String = row.try_get(1).map_err(|e| format!("解码 DDL 失败: {e}"))?;
    Ok(create_sql)
}

/// PostgreSQL: 拼接标准 DDL（PG 没有原生 `SHOW CREATE TABLE`）。
async fn pg_table_ddl(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<String, String> {
    // 切到目标库 + 解析 schema.table 前缀
    let pool = pg_pool_for_db(connection, db_name).await?;
    let (schema_name, pure_table) = pg_parse_qualified_table(table_name);
    let ddl = pg_build_ddl(&pool, &schema_name, &pure_table).await?;
    Ok(ddl)
}

async fn pg_build_ddl(
    pool: &PgPool,
    schema_name: &str,
    table_name: &str,
) -> Result<String, String> {
    let col_rows = sqlx::query(
        "SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, \
         pg_get_expr(d.adbin, d.adrelid) AS default_expr \
         FROM pg_attribute a \
         JOIN pg_class c ON c.oid = a.attrelid \
         JOIN pg_type t ON t.oid = a.atttypid \
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relname = $1 AND n.nspname = $2 AND a.attnum > 0 AND NOT a.attisdropped \
         ORDER BY a.attnum",
    )
    .bind(table_name)
    .bind(schema_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG columns query failed: {e}"))?;

    let pk_rows = sqlx::query(
        "SELECT a.attname \
         FROM pg_index i \
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
         JOIN pg_class c ON c.oid = i.indrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE c.relname = $1 AND n.nspname = $2 AND i.indisprimary \
         ORDER BY array_position(i.indkey, a.attnum)",
    )
    .bind(table_name)
    .bind(schema_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG pk query failed: {e}"))?;

    let idx_rows = sqlx::query(
        "SELECT i.relname AS index_name, \
                array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS cols, \
                ix.indisunique AS is_unique \
         FROM pg_index ix \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_class t ON t.oid = ix.indrelid \
         JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
         JOIN pg_namespace n ON n.oid = t.relnamespace \
         WHERE t.relname = $1 AND n.nspname = $2 AND NOT ix.indisprimary \
         GROUP BY i.relname, ix.indisunique \
         ORDER BY i.relname",
    )
    .bind(table_name)
    .bind(schema_name)
    .fetch_all(pool)
    .await
    .map_err(|e| format!("PG index query failed: {e}"))?;

    if col_rows.is_empty() {
        return Err(format!("PG 表 {schema_name}.{table_name} 不存在或无字段"));
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

    // 非 public schema 时 DDL 用 schema 限定表名
    let qualified = if schema_name == "public" {
        format!("\"{table_name}\"")
    } else {
        format!("\"{schema_name}\".\"{table_name}\"")
    };
    let mut ddl = format!("CREATE TABLE {qualified} (\n{});\n", lines.join(",\n"));

    for row in &idx_rows {
        let name: String = row.try_get(0).unwrap_or_default();
        let cols: Vec<String> = row.try_get::<Vec<String>, _>(1).unwrap_or_default();
        let is_unique: bool = row.try_get(2).unwrap_or(false);
        let unique = if is_unique { "UNIQUE " } else { "" };
        ddl.push('\n');
        ddl.push_str(&format!(
            "CREATE {unique}INDEX \"{name}\" ON {qualified} ({});\n",
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
        "SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE, COLUMN_COMMENT, EXTRA, \
         COLUMN_DEFAULT, \
         COALESCE(CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION) \
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
        let is_auto_increment = mysql_extra_is_auto_increment(&mysql_row_string(row, 6));
        let default_value = normalize_mysql_column_default(&mysql_row_string(row, 7));
        let length = mysql_row_optional_i32(row, 8);

        if let Some(table) = all_objects.iter_mut().find(|t| t.name == table_name) {
            table.columns.push(DbColumnMeta {
                name: column_name,
                column_type: data_type,
                is_pk,
                is_fk,
                nullable,
                is_auto_increment,
                comment,
                length,
                default_value,
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
                    is_auto_increment,
                    comment,
                    length,
                    default_value,
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
        "SELECT COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY, IS_NULLABLE, COLUMN_COMMENT, EXTRA, \
         COLUMN_DEFAULT, \
         COALESCE(CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION) \
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
                is_auto_increment: mysql_extra_is_auto_increment(&mysql_row_string(row, 5)),
                comment: normalize_table_comment(&mysql_row_string(row, 4)),
                default_value: normalize_mysql_column_default(&mysql_row_string(row, 6)),
                length: mysql_row_optional_i32(row, 7),
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
#[specta::specta]
pub async fn db_execute_query(
    state: tauri::State<'_, crate::state::AppState>,
    connection: DbConnectionConfig,
    sql: String,
    run_id: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<DbQueryResult, String> {
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
pub async fn db_redis_config_get(
    connection: DbConnectionConfig,
) -> Result<DbQueryResult, String> {
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
pub async fn db_redis_client_list(
    connection: DbConnectionConfig,
) -> Result<DbQueryResult, String> {
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
pub async fn db_redis_delete_key(connection: DbConnectionConfig, key: String) -> Result<f64, String> {
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
    /// 连接浅刷新为 false；库对象名列表已拉取为 true（列/索引仍可按表懒加载）。
    #[serde(default)]
    pub objects_loaded: bool,
    /// Redis：`INFO keyspace` 的 keys 数；其它引擎忽略。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub key_count: Option<i64>,
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

/// 库级浅加载：仅表/视图/例程名（可含表注释），不含列与索引。
/// 展开未缓存库时避免全量 COLUMNS introspect + 巨型 IPC 堵 UI。
async fn list_database_objects_shallow(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<SchemaCacheDatabasePayload, String> {
    let db_type = connection.db_type.to_ascii_lowercase();
    match db_type.as_str() {
        "mysql" | "mariadb" => {
            let pool = mysql_pool(connection).await?;
            let type_map = mysql_fetch_object_types(&pool, db_name).await?;
            let comments = mysql_fetch_table_comments(&pool, db_name).await?;
            let routines = mysql_fetch_routines(&pool, db_name).await?;

            let mut tables = Vec::new();
            let mut views = Vec::new();
            let mut names: Vec<_> = type_map.keys().cloned().collect();
            names.sort();
            for name in names {
                let kind = type_map.get(&name).map(String::as_str);
                let schema = DbTableSchema {
                    name: name.clone(),
                    columns: Vec::new(),
                    indexes: Vec::new(),
                    comment: comments.get(&name).cloned(),
                };
                match kind {
                    Some("VIEW") => views.push(schema),
                    _ => tables.push(schema),
                }
            }
            Ok(SchemaCacheDatabasePayload {
                name: db_name.to_string(),
                tables,
                views,
                routines,
                load_error: None,
                objects_loaded: true,
                key_count: None,
            })
        }
        "postgresql" | "postgres" => {
            // PG 的 information_schema 是库级本地视图：必须切到目标库才能拿到该库的表。
            // pg_pool_for_db 在 db_name 与 connection.database 相同时复用默认池。
            let pool = pg_pool_for_db(connection, db_name).await?;
            let schemas = pg_list_user_schemas(&pool).await?;
            let type_rows = pg_fetch_object_types_all_schemas(&pool, &schemas).await?;
            let comments = pg_fetch_table_comments_all_schemas(&pool, &schemas).await?;
            let routines = pg_fetch_routines_all_schemas(&pool, &schemas).await?;

            let mut tables = Vec::new();
            let mut views = Vec::new();
            // 按展示名排序（public.table 或 schema.table）
            let mut entries: Vec<(String, String)> = type_rows
                .into_iter()
                .map(|(schema, table, kind)| {
                    (pg_resolve_table_display(&schema, &table), kind)
                })
                .collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            for (display_name, kind) in entries {
                let schema = DbTableSchema {
                    name: display_name.clone(),
                    columns: Vec::new(),
                    indexes: Vec::new(),
                    comment: comments.get(&display_name).cloned(),
                };
                if kind == "VIEW" {
                    views.push(schema);
                } else {
                    tables.push(schema);
                }
            }
            Ok(SchemaCacheDatabasePayload {
                name: db_name.to_string(),
                tables,
                views,
                routines,
                load_error: None,
                objects_loaded: true,
                key_count: None,
            })
        }
        "sqlite" | "sqlite3" => {
            let names = db_list_tables(connection.clone(), Some(db_name.to_string())).await?;
            let tables = names
                .into_iter()
                .map(|name| DbTableSchema {
                    name,
                    columns: Vec::new(),
                    indexes: Vec::new(),
                    comment: None,
                })
                .collect();
            Ok(SchemaCacheDatabasePayload {
                name: db_name.to_string(),
                tables,
                views: Vec::new(),
                routines: Vec::new(),
                load_error: None,
                objects_loaded: true,
                key_count: None,
            })
        }
        "mongodb" | "mongo" | "qdrant" => {
            let names = db_list_tables(connection.clone(), Some(db_name.to_string())).await?;
            let tables = names
                .into_iter()
                .map(|name| DbTableSchema {
                    name,
                    columns: Vec::new(),
                    indexes: Vec::new(),
                    comment: None,
                })
                .collect();
            Ok(SchemaCacheDatabasePayload {
                name: db_name.to_string(),
                tables,
                views: Vec::new(),
                routines: Vec::new(),
                load_error: None,
                objects_loaded: true,
                key_count: None,
            })
        }
        other => Err(format!("Unsupported database type for shallow list: {other}")),
    }
}

async fn refresh_database_payload(
    connection: &DbConnectionConfig,
    db_name: &str,
) -> Result<SchemaCacheDatabasePayload, String> {
    list_database_objects_shallow(connection, db_name).await
}

/// 连接级浅刷新：仅库名 + 用户，不拉取各库表结构（避免打开连接时主线程被巨型 JSON 卡死）。
async fn refresh_connection_payload(
    connection: &DbConnectionConfig,
) -> Result<SchemaConnectionRefreshPayload, String> {
    if connection.db_type.to_lowercase() == "redis" {
        let infos = omnipanel_db::redis_list_databases_with_key_counts(
            &to_params(connection),
            &connection.database,
        )
        .await
        .map_err(err_msg)?;
        let databases = infos
            .into_iter()
            .map(|info| SchemaCacheDatabasePayload {
                name: info.name,
                tables: Vec::new(),
                views: Vec::new(),
                routines: Vec::new(),
                load_error: None,
                objects_loaded: true,
                key_count: Some(info.key_count as i64),
            })
            .collect();
        return Ok(SchemaConnectionRefreshPayload {
            databases,
            users: Vec::new(),
        });
    }

    let db_names = db_list_databases(connection.clone()).await?;
    let databases = db_names
        .into_iter()
        .map(|name| SchemaCacheDatabasePayload {
            name,
            tables: Vec::new(),
            views: Vec::new(),
            routines: Vec::new(),
            load_error: None,
            objects_loaded: false,
            key_count: None,
        })
        .collect();
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
    // 切到目标库：PG 的 information_schema 是库级本地视图
    let pool = pg_pool_for_db(connection, db_name).await?;
    let schemas = pg_list_user_schemas(&pool).await?;

    let mut all_objects: Vec<DbTableSchema> = Vec::new();
    // 收集所有 schema 的列，按展示名（public.table 或 schema.table）归并
    for schema_name in &schemas {
        let col_rows = sqlx::query(
            "SELECT c.table_name, c.column_name, c.data_type, \
             CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk, \
             c.is_nullable = 'YES' AS nullable, \
             (c.is_identity = 'YES' OR COALESCE(c.column_default, '') LIKE 'nextval%') AS is_auto_increment, \
             pgd.description AS column_comment, \
             c.column_default, \
             COALESCE(c.character_maximum_length, c.numeric_precision, c.datetime_precision) \
             FROM information_schema.columns c \
             LEFT JOIN ( \
                 SELECT ku.column_name, ku.table_name \
                 FROM information_schema.table_constraints tc \
                 JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
                 WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 \
             ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name \
             LEFT JOIN pg_catalog.pg_statio_all_tables st \
               ON c.table_schema = st.schemaname AND c.table_name = st.relname \
             LEFT JOIN pg_catalog.pg_description pgd \
               ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position \
             WHERE c.table_schema = $1 \
             ORDER BY c.table_name, c.ordinal_position",
        )
        .bind(schema_name)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("PG columns query failed: {e}"))?;

        for row in &col_rows {
            let table_name: String = row.try_get(0).unwrap_or_default();
            let column_name: String = row.try_get(1).unwrap_or_default();
            let data_type: String = row.try_get(2).unwrap_or_default();
            let is_pk: bool = row.try_get(3).unwrap_or(false);
            let nullable: bool = row.try_get(4).unwrap_or(false);
            let is_auto_increment: bool = row.try_get(5).unwrap_or(false);
            let comment: Option<String> = row
                .try_get::<Option<String>, _>(6)
                .ok()
                .flatten()
                .and_then(|c| normalize_table_comment(&c));
            let raw_default: Option<String> = row
                .try_get::<Option<String>, _>(7)
                .ok()
                .flatten();
            let default_value = normalize_pg_column_default(raw_default.as_deref(), is_auto_increment);
            let length: Option<i32> = row
                .try_get::<Option<i32>, _>(8)
                .ok()
                .flatten();

            let display = pg_resolve_table_display(schema_name, &table_name);
            if let Some(table) = all_objects.iter_mut().find(|t| t.name == display) {
                table.columns.push(DbColumnMeta {
                    name: column_name,
                    column_type: data_type,
                    is_pk,
                    is_fk: false,
                    nullable,
                    is_auto_increment,
                    comment,
                    length,
                    default_value,
                });
            } else {
                all_objects.push(DbTableSchema {
                    name: display,
                    columns: vec![DbColumnMeta {
                        name: column_name,
                        column_type: data_type,
                        is_pk,
                        is_fk: false,
                        nullable,
                        is_auto_increment,
                        comment,
                        length,
                        default_value,
                    }],
                    indexes: Vec::new(),
                    comment: None,
                });
            }
        }

        let idx_rows = sqlx::query(
            "SELECT t.relname AS table_name, i.relname AS index_name, \
             a.attname AS column_name, ix.indisunique AS is_unique \
             FROM pg_class t \
             JOIN pg_index ix ON t.oid = ix.indrelid \
             JOIN pg_class i ON i.oid = ix.indexrelid \
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey) \
             JOIN pg_namespace n ON n.oid = t.relnamespace \
             WHERE n.nspname = $1 AND NOT ix.indisprimary \
             ORDER BY t.relname, i.relname, a.attnum",
        )
        .bind(schema_name)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("PG indexes query failed: {e}"))?;

        for row in &idx_rows {
            let table_name: String = row.try_get(0).unwrap_or_default();
            let index_name: String = row.try_get(1).unwrap_or_default();
            let column_name: String = row.try_get(2).unwrap_or_default();
            let is_unique: bool = row.try_get(3).unwrap_or(false);

            let display = pg_resolve_table_display(schema_name, &table_name);
            if let Some(table) = all_objects.iter_mut().find(|t| t.name == display) {
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
    }

    let comments = pg_fetch_table_comments_all_schemas(&pool, &schemas).await?;
    let type_rows = pg_fetch_object_types_all_schemas(&pool, &schemas).await?;
    let routines = pg_fetch_routines_all_schemas(&pool, &schemas).await?;

    // 构建 展示名 -> 类型 映射
    let type_map: HashMap<String, String> = type_rows
        .into_iter()
        .map(|(schema, table, kind)| (pg_resolve_table_display(&schema, &table), kind))
        .collect();

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
    db_name: &str,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    // 切到目标库 + 解析可能的 schema.table 前缀
    let pool = pg_pool_for_db(connection, db_name).await?;
    let (schema_name, pure_table) = pg_parse_qualified_table(table_name);

    let col_rows = sqlx::query(
        "SELECT c.column_name, c.data_type, \
         CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk, \
         c.is_nullable = 'YES' AS nullable, \
         (c.is_identity = 'YES' OR COALESCE(c.column_default, '') LIKE 'nextval%') AS is_auto_increment, \
         pgd.description AS column_comment, \
         c.column_default, \
         COALESCE(c.character_maximum_length, c.numeric_precision, c.datetime_precision) \
         FROM information_schema.columns c \
         LEFT JOIN ( \
             SELECT ku.column_name, ku.table_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name \
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1 \
         ) pk ON c.table_name = pk.table_name AND c.column_name = pk.column_name \
         LEFT JOIN pg_catalog.pg_statio_all_tables st \
           ON c.table_schema = st.schemaname AND c.table_name = st.relname \
         LEFT JOIN pg_catalog.pg_description pgd \
           ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position \
         WHERE c.table_schema = $1 AND c.table_name = $2 \
         ORDER BY c.ordinal_position",
    )
    .bind(&schema_name)
    .bind(&pure_table)
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
         WHERE n.nspname = $1 AND t.relname = $2 AND NOT ix.indisprimary \
         ORDER BY i.relname, a.attnum",
    )
    .bind(&schema_name)
    .bind(&pure_table)
    .fetch_all(&pool)
    .await
    .map_err(|e| format!("PG indexes query failed: {e}"))?;

    let comment = pg_fetch_table_comment(&pool, &schema_name, &pure_table).await?;

    let columns: Vec<DbColumnMeta> = col_rows
        .iter()
        .map(|row| {
            let is_auto_increment: bool = row.try_get(4).unwrap_or(false);
            let raw_default: Option<String> = row
                .try_get::<Option<String>, _>(6)
                .ok()
                .flatten();
            let default_value = normalize_pg_column_default(raw_default.as_deref(), is_auto_increment);
            let length: Option<i32> = row
                .try_get::<Option<i32>, _>(7)
                .ok()
                .flatten();
            DbColumnMeta {
                name: row.try_get(0).unwrap_or_default(),
                column_type: row.try_get(1).unwrap_or_default(),
                is_pk: row.try_get(2).unwrap_or(false),
                is_fk: false,
                nullable: row.try_get(3).unwrap_or(false),
                is_auto_increment,
                comment: row
                    .try_get::<Option<String>, _>(5)
                    .ok()
                    .flatten()
                    .and_then(|c| normalize_table_comment(&c)),
                length,
                default_value,
            }
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
            let column_type: String = row.get(2)?;
            let raw_default: Option<String> = row.get::<_, Option<String>>(4)?;
            let default_value = raw_default
                .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("null"))
                .map(|s| {
                    // SQLite 默认值已含引号则去除外层引号
                    let trimmed = s.trim();
                    if trimmed.starts_with('\'') && trimmed.ends_with('\'') && trimmed.len() >= 2 {
                        trimmed[1..trimmed.len() - 1].replace("''", "'")
                    } else {
                        trimmed.to_string()
                    }
                });
            Ok(DbColumnMeta {
                name: row.get::<_, String>(1)?,
                column_type: column_type.clone(),
                is_pk: row.get::<_, i32>(5)? > 0,
                is_fk: false,
                nullable: notnull == 0,
                is_auto_increment: type_implies_auto_increment(&column_type),
                comment: None,
                length: None,
                default_value,
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

async fn introspect_mongo_table(
    connection: &DbConnectionConfig,
    db_name: &str,
    table_name: &str,
) -> Result<DbTableSchema, String> {
    let params = with_schema(connection, Some(db_name.to_string()));
    let driver = MongoDriver::connect(&params).await.map_err(err_msg)?;
    let column_names = driver
        .infer_column_names(table_name, 100)
        .await
        .map_err(err_msg)?;
    Ok(DbTableSchema {
        name: table_name.to_string(),
        columns: column_names
            .into_iter()
            .map(|name| DbColumnMeta {
                name: name.clone(),
                column_type: "mixed".to_string(),
                is_pk: name == "_id",
                is_fk: false,
                nullable: true,
                is_auto_increment: false,
                comment: None,
                length: None,
                default_value: None,
            })
            .collect(),
        indexes: Vec::new(),
        comment: None,
    })
}

async fn introspect_qdrant_collection(
    connection: &DbConnectionConfig,
    collection_name: &str,
) -> Result<DbTableSchema, String> {
    let driver = omnipanel_db::connect(&to_params(connection))
        .await
        .map_err(err_msg)?;
    let result = driver
        .preview(collection_name, 100, 0, None, None)
        .await
        .map_err(err_msg)?;
    Ok(DbTableSchema {
        name: collection_name.to_string(),
        columns: result
            .columns
            .into_iter()
            .map(|name| DbColumnMeta {
                name: name.clone(),
                column_type: if name == "vector_dim" {
                    "integer".to_string()
                } else {
                    "mixed".to_string()
                },
                is_pk: name == "id",
                is_fk: false,
                nullable: name != "id",
                is_auto_increment: false,
                comment: None,
                length: None,
                default_value: None,
            })
            .collect(),
        indexes: Vec::new(),
        comment: None,
    })
}
