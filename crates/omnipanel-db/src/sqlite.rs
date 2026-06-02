use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde_json::Value;

use crate::{DbDriver, DbParams, QueryResult, is_query};

/// SQLite 驱动：每次操作在阻塞线程中打开连接（文件打开成本低，避免持有非 Send 连接跨 await）。
pub struct SqliteDriver {
    path: String,
}

impl SqliteDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        let path = params.database.clone();
        let probe = path.clone();
        tokio::task::spawn_blocking(move || Connection::open(&probe).map(|_| ()))
            .await
            .map_err(|e| OmniError::internal("SQLite 任务调度失败").with_cause(e.to_string()))?
            .map_err(|e| OmniError::connection("SQLite 打开失败").with_cause(e.to_string()))?;
        Ok(Self { path })
    }

    async fn with_conn<F, T>(&self, f: F) -> OmniResult<T>
    where
        F: FnOnce(&Connection) -> OmniResult<T> + Send + 'static,
        T: Send + 'static,
    {
        let path = self.path.clone();
        tokio::task::spawn_blocking(move || {
            let conn = Connection::open(&path)
                .map_err(|e| OmniError::connection("SQLite 打开失败").with_cause(e.to_string()))?;
            f(&conn)
        })
        .await
        .map_err(|e| OmniError::internal("SQLite 任务调度失败").with_cause(e.to_string()))?
    }
}

#[async_trait]
impl DbDriver for SqliteDriver {
    async fn version(&self) -> OmniResult<String> {
        self.with_conn(|conn| {
            conn.query_row("SELECT sqlite_version()", [], |row| row.get::<_, String>(0))
                .map_err(|e| OmniError::database("读取版本失败").with_cause(e.to_string()))
        })
        .await
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        self.with_conn(|conn| {
            let mut stmt = conn
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type='table' \
                     AND name NOT LIKE 'sqlite_%' ORDER BY name",
                )
                .map_err(|e| OmniError::database("查询表失败").with_cause(e.to_string()))?;
            let names = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| OmniError::database("查询表失败").with_cause(e.to_string()))?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| OmniError::database("查询表失败").with_cause(e.to_string()))?;
            Ok(names)
        })
        .await
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        let sql = sql.to_string();
        self.with_conn(move |conn| run(conn, &sql)).await
    }

    async fn preview(&self, table: &str, limit: i64, offset: i64) -> OmniResult<QueryResult> {
        let safe = table.replace('"', "");
        let sql = format!(
            "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
            safe,
            limit.max(0),
            offset.max(0)
        );
        self.with_conn(move |conn| run(conn, &sql)).await
    }

    async fn count(&self, table: &str) -> OmniResult<i64> {
        let safe = table.replace('"', "");
        let sql = format!("SELECT COUNT(*) AS count FROM \"{}\"", safe);
        self.with_conn(move |conn| {
            let count: i64 = conn
                .query_row(&sql, [], |row| row.get(0))
                .map_err(|e| OmniError::database("查询行数失败").with_cause(e.to_string()))?;
            Ok(count)
        })
        .await
    }
}

fn run(conn: &Connection, sql: &str) -> OmniResult<QueryResult> {
    if is_query(sql) {
        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| OmniError::database("SQL 解析失败").with_cause(e.to_string()))?;
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let col_count = columns.len();
        let mut rows_out: Vec<Vec<Value>> = Vec::new();
        let mut rows = stmt
            .query([])
            .map_err(|e| OmniError::database("查询失败").with_cause(e.to_string()))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| OmniError::database("读取行失败").with_cause(e.to_string()))?
        {
            let mut record = Vec::with_capacity(col_count);
            for i in 0..col_count {
                let value = match row.get_ref(i) {
                    Ok(ValueRef::Null) => Value::Null,
                    Ok(ValueRef::Integer(n)) => serde_json::json!(n),
                    Ok(ValueRef::Real(f)) => serde_json::json!(f),
                    Ok(ValueRef::Text(t)) => Value::String(String::from_utf8_lossy(t).into_owned()),
                    Ok(ValueRef::Blob(_)) => Value::String("[BLOB]".to_string()),
                    Err(_) => Value::Null,
                };
                record.push(value);
            }
            rows_out.push(record);
        }
        Ok(QueryResult {
            columns,
            rows: rows_out,
            rows_affected: 0,
        })
    } else {
        let affected = conn
            .execute(sql, [])
            .map_err(|e| OmniError::database("执行失败").with_cause(e.to_string()))?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: affected as u64,
        })
    }
}
