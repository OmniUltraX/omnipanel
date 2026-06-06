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


#[cfg(test)]
mod tests {
    use rusqlite::Connection;

    fn test_conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT,
                age INTEGER DEFAULT 0
            );
            CREATE INDEX idx_users_name ON users(name);
            INSERT INTO users (name, email, age) VALUES ('alice', 'alice@test.com', 30);
            INSERT INTO users (name, email, age) VALUES ('bob', 'bob@test.com', 25);"
        ).unwrap();
        conn
    }

    #[test]
    fn list_tables_returns_all() {
        let conn = test_conn();
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .unwrap();
        let tables: Vec<String> = stmt.query_map([], |row| row.get(0)).unwrap()
            .collect::<Result<Vec<_>, _>>().unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0], "users");
    }

    #[test]
    fn pragma_table_info_returns_columns() {
        let conn = test_conn();
        let mut stmt = conn.prepare("PRAGMA table_info('users')").unwrap();
        let cols: Vec<(String, String, i32)> = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i32>(5)?,
            ))
        }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(cols.len(), 4);
        assert_eq!(cols[0].0, "id");
        assert!(cols[0].2 > 0); // is_pk
        assert_eq!(cols[1].0, "name");
        assert_eq!(cols[1].1, "TEXT");
        assert_eq!(cols[1].2, 0); // not pk
    }

    #[test]
    fn pragma_index_list_returns_indexes() {
        let conn = test_conn();
        let mut stmt = conn.prepare("PRAGMA index_list('users')").unwrap();
        let indexes: Vec<(String, i32)> = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, i32>(2)?))
        }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();

        let idx = indexes.iter().find(|(name, _)| name == "idx_users_name");
        assert!(idx.is_some(), "idx_users_name should exist");
        assert_eq!(idx.unwrap().1, 0); // not unique
    }

    #[test]
    fn pragma_index_info_returns_columns() {
        let conn = test_conn();
        let mut stmt = conn.prepare("PRAGMA index_info('idx_users_name')").unwrap();
        let cols: Vec<String> = stmt.query_map([], |row| {
            row.get(2)
        }).unwrap().collect::<Result<Vec<_>, _>>().unwrap();

        assert_eq!(cols, vec!["name".to_string()]);
    }

    #[test]
    fn select_query_returns_correct_data() {
        let conn = test_conn();
        let result = super::run(&conn, "SELECT name, age FROM users ORDER BY age DESC").unwrap();
        assert_eq!(result.columns, vec!["name".to_string(), "age".to_string()]);
        assert_eq!(result.rows.len(), 2);
        assert_eq!(result.rows[0][0], serde_json::json!("alice"));
        assert_eq!(result.rows[0][1], serde_json::json!(30));
    }

    #[test]
    fn insert_returns_rows_affected() {
        let conn = test_conn();
        let result = super::run(&conn, "INSERT INTO users (name, email, age) VALUES ('charlie', 'c@test.com', 20)").unwrap();
        assert_eq!(result.rows_affected, 1);
        assert!(result.columns.is_empty());
    }
}
