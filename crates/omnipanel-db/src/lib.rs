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

/// sqlx 错误统一映射为数据库领域错误。
pub(crate) fn map_sqlx_err(err: sqlx::Error) -> OmniError {
    OmniError::database("数据库操作失败").with_cause(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::is_query;

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
}
