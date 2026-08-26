//! 数据库访问层：`DbDriver` trait + 按引擎隔离的进程内 / sidecar 实现。
//!
//! 第一方引擎身份见 [`engine_contract::FirstPartyEngine`]（与 `plugins/db-*/plugin.json` 对齐）。
//! 运行时：
//! - SQLite / Qdrant / SQL Server / 默认 MySQL·PG：进程内（T0）
//! - ClickHouse / MongoDB / Redis：常驻 sidecar（T1）
//! - MySQL / PG：`OMNIPANEL_SQL_SIDECAR=1` 时可切 sidecar
//! - 未知引擎：已安装 sidecar 插件的 `entry.driver`，或 `OMNIPANEL_ENGINE_SIDECAR_{TYPE}` / `OMNIPANEL_DBX_CMD`
//!
//! 所有驱动统一返回领域错误 [`OmniError`]，命令层零散字符串错误就此收敛。

use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

mod blob_value;
mod engine_contract;
#[cfg(feature = "clickhouse-http")]
pub(crate) mod clickhouse;
#[cfg(feature = "host")]
mod introspect;
#[cfg(feature = "host")]
mod sidecar_catalog;
mod json_value;
#[cfg(feature = "mongodb")]
mod mongodb;
#[cfg(feature = "mysql")]
mod mysql;
#[cfg(feature = "postgres")]
mod postgres;
#[cfg(feature = "qdrant")]
mod qdrant;
#[cfg(feature = "redis")]
mod redis;
#[cfg(feature = "redis")]
#[cfg_attr(not(feature = "sidecar-serve"), allow(dead_code))]
mod redis_ops;
#[cfg(feature = "host")]
mod redis_host;
#[cfg(feature = "host")]
mod registry;
#[cfg(feature = "host")]
mod schema_refresh;
#[cfg(any(feature = "sidecar-host", feature = "sidecar-serve"))]
pub mod sidecar;
#[cfg(feature = "sqlite")]
mod sqlite;
#[cfg(feature = "sqlserver")]
mod sqlserver;

#[cfg(any(
    feature = "mysql",
    feature = "postgres",
    feature = "mongodb",
    feature = "sqlite",
    feature = "sqlserver"
))]
pub(crate) use json_value::{decode_text_as_json_or_string, safe_int_to_value};
pub(crate) use json_value::sanitize_json_value_for_js;

pub use blob_value::encode_blob_value;
pub use engine_contract::{FirstPartyEngine, FirstPartyRuntime};

#[cfg(feature = "host")]
pub use introspect::{
    db_create_database, db_get_table_details, db_introspect_schema, db_introspect_table,
    db_list_character_sets, db_list_connection_users, db_list_databases,
    db_list_databases_with_stats,
    db_list_table_details, db_table_ddl, CreateDatabaseArgs, DbCharsetMeta, DbColumnMeta,
    DbDatabaseMeta, DbIndexMeta, DbIntrospectResult, DbNamedTableDetails, DbRoutineMeta,
    DbTableDetails, DbTableSchema, DbUserMeta,
};

#[cfg(feature = "host")]
pub use schema_refresh::{
    db_refresh_schema_node, refresh_connection_payload, SchemaCacheDatabasePayload,
    SchemaConnectionRefreshPayload, SchemaNodeRefreshArgs, SchemaNodeRefreshResult,
    SchemaTableRefreshPayload,
};

#[cfg(feature = "mongodb")]
pub use mongodb::MongoDriver;

#[cfg(feature = "clickhouse-http")]
pub use clickhouse::ClickHouseDriver;
#[cfg(feature = "mysql")]
pub use mysql::mysql_connect_options;
#[cfg(feature = "postgres")]
pub use postgres::postgres_connect_options;
#[cfg(feature = "sqlserver")]
pub use sqlserver::SqlServerDriver;
#[cfg(feature = "qdrant")]
pub use qdrant::{QdrantCollectionInfo, QdrantDriver};
#[cfg(feature = "redis")]
pub use redis::{
    RedisDatabaseInfo, RedisDriver, RedisKeyDetail, RedisKeyEntry, RedisSearchKeysResult,
    RedisSlowLogEntry,
};
#[cfg(feature = "redis")]
pub use redis_ops::{
    RedisAclUser, RedisInfoResult, RedisMemoryStats, RedisStreamConsumer,
    RedisStreamConsumerCleanupResult, RedisStreamEntry, RedisStreamGroup,
    RedisStreamMonitorSnapshot, RedisStreamPendingEntry, RedisStreamRangeResult,
};
#[cfg(feature = "host")]
pub use redis_host::*;

/// 连接参数（领域内部用，不直接进 IPC；由命令层从连接模型转换而来）。
#[derive(Debug, Clone)]
pub struct DbParams {
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    /// 网络数据库为库名；SQLite 为文件路径。
    pub database: String,
    /// 是否启用 SSL（MySQL / PostgreSQL）。SQL Server 表示加密传输。
    pub ssl: bool,
    /// Oracle SID；空则使用 `database` 作为服务名。
    pub sid: String,
    /// Oracle SYSDBA。
    pub sysdba: bool,
}

/// 查询结果：列名 + 行（每行按列顺序的 JSON 值）+ 影响行数（DML）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: u64,
}

/// 数据库驱动扩展点（仿 `AiProvider` / `Executor`）。
#[async_trait]
pub trait DbDriver: Send + Sync {
    /// 返回数据库版本字符串（用于连接测试）。
    async fn version(&self) -> OmniResult<String>;
    /// 列出当前库的表名。
    async fn list_tables(&self) -> OmniResult<Vec<String>>;
    /// 执行任意 SQL：SELECT 类返回行集，DML 返回影响行数。
    async fn execute(&self, sql: &str) -> OmniResult<QueryResult>;
    /// 预览某张表前 N 行（支持偏移量）。`order_by` 为已转义的 `ORDER BY` 子句（不含关键字），传 None 时不排序。
    /// `where_clause` 为不含 `WHERE` 关键字的条件表达式，由前端 query builder 生成并经校验。
    async fn preview(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
        order_by: Option<&str>,
        where_clause: Option<&str>,
    ) -> OmniResult<QueryResult>;
    /// 查询某张表的总行数；可选 `where_clause` 与 preview 一致。
    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64>;
}

/// 校验前端传入的 WHERE 表达式，防止 SQL 注入。
pub fn validate_where_clause(clause: &str) -> OmniResult<()> {
    let trimmed = clause.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    let lower = trimmed.to_lowercase();
    const BLOCKED: &[&str] = &[
        ";",
        "--",
        "/*",
        "*/",
        " select ",
        " insert ",
        " update ",
        " delete ",
        " drop ",
        " alter ",
        " create ",
        " truncate ",
        " grant ",
        " revoke ",
        " exec ",
        " execute ",
        " union ",
        " into ",
        " outfile ",
        " dumpfile ",
        " load_file",
        " sleep(",
        " benchmark(",
        " pg_sleep(",
    ];
    for token in BLOCKED {
        if lower.contains(token) {
            return Err(OmniError::invalid_input(format!(
                "非法的过滤条件：包含不允许的关键字或字符"
            )));
        }
    }
    Ok(())
}

pub(crate) fn build_where_sql(where_clause: Option<&str>) -> OmniResult<String> {
    match where_clause {
        Some(clause) if !clause.trim().is_empty() => {
            validate_where_clause(clause)?;
            Ok(format!(" WHERE {}", clause.trim()))
        }
        _ => Ok(String::new()),
    }
}

/// 按 `db_type` 建立连接并返回对应驱动实例（走驱动注册表）。
#[cfg(feature = "host")]
pub async fn connect(params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
    registry::connect_registered(params).await
}

/// 建立「独占连接」驱动（池大小 1），用于跨多次 execute 保持事务。
/// 目前仅支持 MySQL / MariaDB / PostgreSQL。
#[cfg(feature = "host")]
pub async fn connect_exclusive(params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
    registry::connect_exclusive_registered(params).await
}

#[cfg(feature = "host")]
pub async fn mongodb_list_databases(params: &DbParams) -> OmniResult<Vec<String>> {
    let mut params = params.clone();
    if params.database.trim().is_empty() {
        params.database = "admin".to_string();
    }
    let driver = sidecar::connect_engine(sidecar::EngineKind::MongoDb, &params).await?;
    driver.list_databases().await
}

#[cfg(feature = "host")]
pub async fn clickhouse_list_databases(params: &DbParams) -> OmniResult<Vec<String>> {
    let driver = sidecar::connect_clickhouse(params).await?;
    driver.list_databases().await
}

/// Qdrant 虚拟库固定为 `default`（collections 作为「表」）。
#[cfg(feature = "qdrant")]
pub async fn qdrant_list_databases(_params: &DbParams) -> OmniResult<Vec<String>> {
    Ok(vec!["default".to_string()])
}

#[cfg(feature = "qdrant")]
pub async fn qdrant_list_collection_infos(
    params: &DbParams,
) -> OmniResult<Vec<QdrantCollectionInfo>> {
    qdrant::qdrant_list_collection_infos(params).await
}

#[cfg(feature = "qdrant")]
pub async fn qdrant_delete_points(
    params: &DbParams,
    collection: &str,
    point_ids: &[Value],
) -> OmniResult<u64> {
    qdrant::qdrant_delete_points(params, collection, point_ids).await
}

/// 判断 SQL 是否为返回行集的查询（否则按 DML 处理，返回影响行数）。
pub(crate) fn is_query(sql: &str) -> bool {
    let s = sql.trim_start().to_lowercase();
    [
        "select", "show", "with", "explain", "describe", "desc", "pragma", "values", "table",
    ]
    .iter()
    .any(|kw| s.starts_with(kw))
}

/// 按顶层 `;` 拆分多条 SQL，跳过空语句与纯注释语句。
///
/// 规则：
/// - `;` 出现在字符串字面量（`'…'` / `"…"` / 反引号）中时不拆分；用 `\` 转义的引号被识别为非终止。
/// - `--` 行注释与 `/* … */` 块注释内的 `;` 不拆分。
/// - 拆分后逐条 `trim()`，空字符串与纯注释语句被剔除。
/// - 输入若完全为空白 / 注释，返回空 `Vec`。
pub(crate) fn split_statements(sql: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut buf = String::new();

    let mut in_single = false;
    let mut in_double = false;
    let mut in_backtick = false;
    let mut line_comment = false;
    let mut block_comment = false;

    let flush = |buf: &mut String, out: &mut Vec<String>| {
        let trimmed = buf.trim();
        if trimmed.is_empty() {
            buf.clear();
            return;
        }
        if is_comment_only(trimmed) {
            buf.clear();
            return;
        }
        out.push(trimmed.to_string());
        buf.clear();
    };

    let mut chars = sql.chars().peekable();
    while let Some(ch) = chars.next() {
        let next = chars.peek().copied();

        if line_comment {
            buf.push(ch);
            if ch == '\n' {
                line_comment = false;
            }
            continue;
        }
        if block_comment {
            buf.push(ch);
            if ch == '*' && next == Some('/') {
                buf.push('/');
                chars.next();
                block_comment = false;
            }
            continue;
        }

        if !in_single && !in_double && !in_backtick {
            if ch == '-' && next == Some('-') {
                line_comment = true;
                buf.push(ch);
                buf.push('-');
                chars.next();
                continue;
            }
            if ch == '/' && next == Some('*') {
                block_comment = true;
                buf.push(ch);
                buf.push('*');
                chars.next();
                continue;
            }
        }

        if ch == '\'' && !in_double && !in_backtick {
            // 处理 SQL 标准 `''` 转义（两个单引号表示字面量单引号）。
            if in_single && next == Some('\'') {
                buf.push('\'');
                buf.push('\'');
                chars.next();
                continue;
            }
            in_single = !in_single;
            buf.push(ch);
            continue;
        }
        if ch == '"' && !in_single && !in_backtick {
            if in_double && next == Some('"') {
                buf.push('"');
                buf.push('"');
                chars.next();
                continue;
            }
            in_double = !in_double;
            buf.push(ch);
            continue;
        }
        if ch == '`' && !in_single && !in_double {
            in_backtick = !in_backtick;
            buf.push(ch);
            continue;
        }

        // 字符串内反斜杠转义（MySQL 默认模式）：`\'` / `\"` / `\\` 等不终止字面量。
        if (in_single || in_double) && ch == '\\' {
            buf.push(ch);
            if let Some(escaped) = chars.next() {
                buf.push(escaped);
            }
            continue;
        }

        if ch == ';' && !in_single && !in_double && !in_backtick {
            flush(&mut buf, &mut out);
            continue;
        }

        buf.push(ch);
    }
    flush(&mut buf, &mut out);
    out
}

fn is_comment_only(stmt: &str) -> bool {
    let mut had_content = false;
    let mut in_line = false;
    let mut in_block = false;
    let mut chars = stmt.chars().peekable();
    while let Some(ch) = chars.next() {
        let next = chars.peek().copied();
        if in_line {
            if ch == '\n' {
                in_line = false;
            }
            continue;
        }
        if in_block {
            if ch == '*' && next == Some('/') {
                chars.next();
                in_block = false;
            }
            continue;
        }
        if ch == '-' && next == Some('-') {
            in_line = true;
            chars.next();
            continue;
        }
        if ch == '/' && next == Some('*') {
            in_block = true;
            chars.next();
            continue;
        }
        if ch.is_whitespace() {
            continue;
        }
        had_content = true;
    }
    !had_content
}

/// sqlx 错误统一映射为数据库领域错误。
#[cfg(any(feature = "mysql", feature = "postgres"))]
pub(crate) fn map_sqlx_err(err: sqlx::Error) -> OmniError {
    OmniError::database("数据库操作失败").with_cause(err.to_string())
}

/// 判断 SQL 语句是否可安全包裹为子查询（仅 SELECT / WITH / TABLE / VALUES）。
/// SHOW / DESCRIBE / PRAGMA / EXPLAIN 等元数据查询不能作为子查询，跳过包裹。
fn is_wrappable_select(sql: &str) -> bool {
    let s = sql.trim_start().to_lowercase();
    ["select", "with", "table", "values"]
        .iter()
        .any(|kw| s.starts_with(kw))
}

/// 将 SQL 中每条 SELECT/WITH 语句包裹为 `SELECT * FROM (...) AS __omnipanel_wrap__ LIMIT n OFFSET m`，
/// 防止用户查询返回超大结果集导致前端卡死。非查询语句（DML）和不可包裹的元数据查询保持原样。
///
/// - `limit` ≤ 0 时不包裹，直接返回原始 SQL。
/// - 已含 LIMIT 的查询包裹后仍正确（内层 LIMIT 先生效，外层 LIMIT 仅做兜底）。
pub fn wrap_select_with_limit(sql: &str, limit: i64, offset: i64) -> String {
    if limit <= 0 {
        return sql.to_string();
    }
    let statements = split_statements(sql);
    if statements.is_empty() {
        return sql.to_string();
    }
    let off = offset.max(0);
    let wrapped: Vec<String> = statements
        .iter()
        .map(|stmt| {
            if is_wrappable_select(stmt) {
                format!(
                    "SELECT * FROM ({}) AS __omnipanel_wrap__ LIMIT {} OFFSET {}",
                    stmt, limit, off
                )
            } else {
                stmt.clone()
            }
        })
        .collect();
    wrapped.join("; ")
}

/// 按引擎包装编辑器查询：普通 SQL 走子查询 LIMIT；Oracle/达梦/DB2 走 FETCH；
/// SQL Server 额外补 ORDER BY；Hive/Spark 只追加 LIMIT；Firebird 走 ROWS；
/// CQL 只追加 LIMIT；Cypher 不改写。未知 OLAP 默认 LIMIT 追加而非子查询包裹。
pub fn wrap_editor_query(db_type: &str, sql: &str, limit: i64, offset: i64) -> String {
    if limit <= 0 {
        return sql.to_string();
    }
    match db_type.to_ascii_lowercase().as_str() {
        "neo4j" => sql.to_string(),
        "cassandra" => wrap_cql_limit(sql, limit),
        "hive" | "spark" => wrap_append_limit(sql, limit, None),
        "firebird" => wrap_firebird_rows(sql, limit, offset),
        "oracle" | "orcl" | "db2" | "dameng" | "dm" => {
            wrap_select_with_fetch(sql, limit, offset, false)
        }
        "sqlserver" | "mssql" | "sql server" => wrap_select_with_fetch(sql, limit, offset, true),
        "ignite" | "ignite3" | "spanner" | "trino" | "presto" | "databend" | "databricks"
        | "kylin" | "snowflake" | "vertica" | "exasol" | "saphana" | "teradata" => {
            wrap_append_limit(sql, limit, Some(offset.max(0)))
        }
        _ => wrap_select_with_limit(sql, limit, offset),
    }
}

/// Oracle 12c+ / 达梦 / DB2：`SELECT * FROM (stmt) alias OFFSET n ROWS FETCH NEXT m ROWS ONLY`。
/// SQL Server 的 OFFSET/FETCH 必须带 ORDER BY，用 `(SELECT NULL)` 占位。
fn wrap_select_with_fetch(sql: &str, limit: i64, offset: i64, require_order: bool) -> String {
    if limit <= 0 {
        return sql.to_string();
    }
    let statements = split_statements(sql);
    if statements.is_empty() {
        return sql.to_string();
    }
    let off = offset.max(0);
    statements
        .iter()
        .map(|stmt| {
            if is_wrappable_select(stmt) {
                let order = if require_order {
                    " ORDER BY (SELECT NULL)"
                } else {
                    ""
                };
                format!(
                    "SELECT * FROM ({stmt}) __omnipanel_wrap__{order} OFFSET {off} ROWS FETCH NEXT {limit} ROWS ONLY"
                )
            } else {
                stmt.clone()
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn wrap_cql_limit(sql: &str, limit: i64) -> String {
    wrap_append_limit(sql, limit, None)
}

/// Hive / Spark / 未知 OLAP：只追加 LIMIT，不套 `__omnipanel_wrap__` 子查询。
fn wrap_append_limit(sql: &str, limit: i64, offset: Option<i64>) -> String {
    let statements = split_statements(sql);
    if statements.is_empty() {
        return sql.to_string();
    }
    statements
        .into_iter()
        .map(|stmt| {
            let lower = stmt.to_ascii_lowercase();
            if !is_wrappable_select(&stmt) || lower.contains(" limit ") || lower.contains(" rows ") {
                return stmt;
            }
            let trimmed = stmt.trim_end().trim_end_matches(';');
            match offset {
                Some(off) if off > 0 => format!("{trimmed} LIMIT {limit} OFFSET {off}"),
                _ => format!("{trimmed} LIMIT {limit}"),
            }
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// Firebird：`ROWS m TO n`（1-based 闭区间），与预览方言对齐。
fn wrap_firebird_rows(sql: &str, limit: i64, offset: i64) -> String {
    let statements = split_statements(sql);
    if statements.is_empty() {
        return sql.to_string();
    }
    let start = offset.max(0) + 1;
    let end = start + limit - 1;
    statements
        .into_iter()
        .map(|stmt| {
            let lower = stmt.to_ascii_lowercase();
            if !is_wrappable_select(&stmt)
                || lower.contains(" rows ")
                || lower.contains(" fetch ")
            {
                return stmt;
            }
            let trimmed = stmt.trim_end().trim_end_matches(';');
            format!("{trimmed} ROWS {start} TO {end}")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

#[cfg(test)]
mod tests {
    use super::{is_query, split_statements, wrap_editor_query, wrap_select_with_limit};

    #[test]
    fn classifies_select_as_query() {
        assert!(is_query("SELECT * FROM t"));
        assert!(is_query("  with cte as (select 1) select * from cte"));
        assert!(is_query("SHOW TABLES"));
    }

    #[test]
    fn classifies_dml_as_non_query() {
        assert!(!is_query("INSERT INTO t VALUES (1)"));
        assert!(!is_query("UPDATE t SET a=1"));
        assert!(!is_query("DELETE FROM t"));
    }

    #[test]
    fn split_single_statement_with_trailing_semicolon() {
        let out =
            split_statements("SELECT * FROM tiku_chapter WHERE textbook_id = 852104305040297984;");
        assert_eq!(
            out,
            vec!["SELECT * FROM tiku_chapter WHERE textbook_id = 852104305040297984".to_string()]
        );
    }

    #[test]
    fn split_multiple_statements_with_blanks_and_comments() {
        let sql = "SELECT 1;\n\n-- 注释\nSELECT * FROM users;\n".to_string();
        let out = split_statements(&sql);
        assert_eq!(
            out,
            vec![
                "SELECT 1".to_string(),
                "-- 注释\nSELECT * FROM users".to_string(),
            ]
        );
    }

    #[test]
    fn split_respects_strings_and_escaped_quotes() {
        let sql = "INSERT INTO t VALUES ('a;b', \"c;d\"); SELECT 1;";
        let out = split_statements(sql);
        assert_eq!(
            out,
            vec![
                "INSERT INTO t VALUES ('a;b', \"c;d\")".to_string(),
                "SELECT 1".to_string(),
            ]
        );
    }

    #[test]
    fn split_respects_mysql_backslash_escaped_quotes() {
        let sql = "INSERT INTO t VALUES ('a\\';b'); SELECT 1;";
        let out = split_statements(sql);
        assert_eq!(
            out,
            vec![
                "INSERT INTO t VALUES ('a\\';b')".to_string(),
                "SELECT 1".to_string(),
            ]
        );
    }

    #[test]
    fn split_respects_sql_standard_doubled_quotes_with_semicolon() {
        let sql = "INSERT INTO t VALUES ('err ''name''; more; text'); SELECT 1;";
        let out = split_statements(sql);
        assert_eq!(
            out,
            vec![
                "INSERT INTO t VALUES ('err ''name''; more; text')".to_string(),
                "SELECT 1".to_string(),
            ]
        );
    }

    #[test]
    fn split_respects_backticks_and_block_comments() {
        let sql = "SELECT `col;with;semis` FROM t; /* block; */ SELECT 2;";
        let out = split_statements(sql);
        assert_eq!(
            out,
            vec![
                "SELECT `col;with;semis` FROM t".to_string(),
                "/* block; */ SELECT 2".to_string(),
            ]
        );
    }

    #[test]
    fn split_skips_empty_and_comment_only() {
        let sql = ";;-- only comment\n;SELECT 1;/* c */;";
        let out = split_statements(sql);
        assert_eq!(out, vec!["SELECT 1".to_string()]);
    }

    #[test]
    fn wrap_select_wraps_select_and_with() {
        let out = wrap_select_with_limit("SELECT * FROM users", 1000, 0);
        assert_eq!(
            out,
            "SELECT * FROM (SELECT * FROM users) AS __omnipanel_wrap__ LIMIT 1000 OFFSET 0"
        );
    }

    #[test]
    fn wrap_select_preserves_dml() {
        let out = wrap_select_with_limit("INSERT INTO t VALUES (1); SELECT 1", 100, 0);
        assert!(out.contains("INSERT INTO t VALUES (1)"));
        assert!(out.contains("SELECT * FROM (SELECT 1) AS __omnipanel_wrap__ LIMIT 100 OFFSET 0"));
    }

    #[test]
    fn wrap_select_skips_show_and_describe() {
        let out = wrap_select_with_limit("SHOW TABLES", 1000, 0);
        assert_eq!(out, "SHOW TABLES");
    }

    #[test]
    fn wrap_select_noop_when_limit_zero() {
        let out = wrap_select_with_limit("SELECT * FROM t", 0, 0);
        assert_eq!(out, "SELECT * FROM t");
    }

    #[test]
    fn wrap_editor_skips_cypher_and_appends_cql_limit() {
        assert_eq!(
            wrap_editor_query("neo4j", "MATCH (n:Person) RETURN n", 50, 10),
            "MATCH (n:Person) RETURN n"
        );
        assert_eq!(
            wrap_editor_query("cassandra", "SELECT * FROM person", 20, 99),
            "SELECT * FROM person LIMIT 20"
        );
        assert_eq!(
            wrap_editor_query("cassandra", "SELECT * FROM person LIMIT 5", 20, 0),
            "SELECT * FROM person LIMIT 5"
        );
        let mysql = wrap_editor_query("mysql", "SELECT * FROM t", 10, 0);
        assert!(mysql.contains("__omnipanel_wrap__"));
        assert!(mysql.contains("LIMIT 10 OFFSET 0"));
    }

    #[test]
    fn wrap_editor_oracle_dameng_use_fetch() {
        let oracle = wrap_editor_query("oracle", "SELECT * FROM EMP", 50, 10);
        assert!(oracle.contains("OFFSET 10 ROWS FETCH NEXT 50 ROWS ONLY"));
        assert!(!oracle.to_ascii_lowercase().contains(" limit "));
        let dameng = wrap_editor_query("dameng", "SELECT * FROM SYSDBA.T", 20, 0);
        assert!(dameng.contains("OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY"));
        let mssql = wrap_editor_query("sqlserver", "SELECT * FROM dbo.t", 5, 0);
        assert!(mssql.contains("ORDER BY (SELECT NULL)"));
        assert!(mssql.contains("FETCH NEXT 5 ROWS ONLY"));
    }

    #[test]
    fn wrap_editor_hive_spark_append_limit_without_subquery() {
        let hive = wrap_editor_query("hive", "SELECT * FROM logs", 50, 10);
        assert_eq!(hive, "SELECT * FROM logs LIMIT 50");
        assert!(!hive.contains("__omnipanel_wrap__"));
        let spark = wrap_editor_query("spark", "SELECT a FROM t LIMIT 3", 20, 0);
        assert_eq!(spark, "SELECT a FROM t LIMIT 3");
        let ignite = wrap_editor_query("ignite", "SELECT * FROM cache", 10, 2);
        assert_eq!(ignite, "SELECT * FROM cache LIMIT 10 OFFSET 2");
        assert!(!ignite.contains("__omnipanel_wrap__"));
    }

    #[test]
    fn wrap_editor_firebird_uses_rows() {
        let sql = wrap_editor_query("firebird", "SELECT * FROM EMPLOYEE", 20, 10);
        assert_eq!(sql, "SELECT * FROM EMPLOYEE ROWS 11 TO 30");
        assert!(!sql.contains("__omnipanel_wrap__"));
        assert!(!sql.to_ascii_lowercase().contains(" limit "));
    }
}
