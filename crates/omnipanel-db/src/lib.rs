//! 数据库访问层：`DbDriver` trait + MySQL / PostgreSQL / SQLite 三种实现，按 `db_type` 分发。
//!
//! 设计：远程网络数据库（MySQL/PostgreSQL）走 `sqlx` 异步连接池；本地 SQLite 走 `rusqlite`
//! （与 `omnipanel-store` 共用同一 sqlite 后端，避免 `libsqlite3-sys` 版本冲突）。
//! 所有驱动统一返回领域错误 [`OmniError`]，命令层零散字符串错误就此收敛。

use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde::Serialize;
use serde_json::Value;

mod mysql;
mod postgres;
mod redis;
mod sqlite;

pub use mysql::mysql_connect_options;

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
    /// 是否启用 SSL（MySQL）。
    pub ssl: bool,
}

/// 查询结果：列名 + 行（每行按列顺序的 JSON 值）+ 影响行数（DML）。
#[derive(Debug, Clone, Serialize)]
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
    /// 预览某张表前 N 行（支持偏移量）。
    async fn preview(&self, table: &str, limit: i64, offset: i64) -> OmniResult<QueryResult>;
    /// 查询某张表的总行数。
    async fn count(&self, table: &str) -> OmniResult<i64>;
}

/// 按 `db_type` 建立连接并返回对应驱动实例。
pub async fn connect(params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
    match params.db_type.to_lowercase().as_str() {
        "mysql" | "mariadb" => Ok(Box::new(mysql::MySqlDriver::connect(params).await?)),
        "postgres" | "postgresql" | "pg" => {
            Ok(Box::new(postgres::PgDriver::connect(params).await?))
        }
        "sqlite" | "sqlite3" => Ok(Box::new(sqlite::SqliteDriver::connect(params).await?)),
        "redis" => Ok(Box::new(redis::RedisDriver::connect(params).await?)),
        other => Err(OmniError::invalid_input(format!(
            "不支持的数据库类型：{other}"
        ))),
    }
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
pub(crate) fn map_sqlx_err(err: sqlx::Error) -> OmniError {
    OmniError::database("数据库操作失败").with_cause(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::{is_query, split_statements};

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
}
