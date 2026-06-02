use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde_json::Value;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, Row, TypeInfo, ValueRef};

use crate::{DbDriver, DbParams, QueryResult, is_query, map_sqlx_err};

pub struct MySqlDriver {
    pool: MySqlPool,
    database: String,
}

const DEFAULT_MYSQL_PORT: u16 = 3306;

pub fn mysql_connect_options(params: &DbParams) -> MySqlConnectOptions {
    let port = if params.port == 0 {
        DEFAULT_MYSQL_PORT
    } else {
        params.port
    };
    let ssl_mode = if params.ssl {
        MySqlSslMode::Required
    } else {
        MySqlSslMode::Preferred
    };

    let mut opts = MySqlConnectOptions::new()
        .host(&params.host)
        .port(port)
        .username(&params.user)
        .password(&params.password)
        .ssl_mode(ssl_mode);

    if !params.database.trim().is_empty() {
        opts = opts.database(params.database.trim());
    }
    opts
}

impl MySqlDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        let opts = mysql_connect_options(params);
        let pool = MySqlPoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .map_err(|e| OmniError::connection("MySQL 连接失败").with_cause(e.to_string()))?;
        Ok(Self {
            pool,
            database: params.database.clone(),
        })
    }
}

#[async_trait]
impl DbDriver for MySqlDriver {
    async fn version(&self) -> OmniResult<String> {
        let row = sqlx::query("SELECT VERSION() AS version")
            .fetch_one(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        Ok(row.get::<String, _>("version"))
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(&self.database)
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        run(&self.pool, sql).await
    }

    async fn preview(&self, table: &str, limit: i64, offset: i64) -> OmniResult<QueryResult> {
        let safe = table.replace('`', "");
        let sql = format!(
            "SELECT * FROM `{}` LIMIT {} OFFSET {}",
            safe,
            limit.max(0),
            offset.max(0)
        );
        run(&self.pool, &sql).await
    }

    async fn count(&self, table: &str) -> OmniResult<i64> {
        let safe = table.replace('`', "");
        let sql = format!("SELECT COUNT(*) AS count FROM `{}`", safe);
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        Ok(row.get::<i64, _>("count"))
    }
}

async fn run(pool: &MySqlPool, sql: &str) -> OmniResult<QueryResult> {
    if is_query(sql) {
        let rows = sqlx::query(sql)
            .fetch_all(pool)
            .await
            .map_err(map_sqlx_err)?;
        let columns: Vec<String> = match rows.first() {
            Some(r) => r.columns().iter().map(|c| c.name().to_string()).collect(),
            None => Vec::new(),
        };
        let data = rows
            .iter()
            .map(|r| (0..columns.len()).map(|i| extract(r, i)).collect())
            .collect();
        Ok(QueryResult {
            columns,
            rows: data,
            rows_affected: 0,
        })
    } else {
        let res = sqlx::query(sql).execute(pool).await.map_err(map_sqlx_err)?;
        Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: res.rows_affected(),
        })
    }
}

fn extract(row: &MySqlRow, index: usize) -> Value {
    let Ok(raw) = row.try_get_raw(index) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_lowercase();
    if type_name.contains("int")
        && let Ok(v) = row.try_get::<i64, _>(index)
    {
        return serde_json::json!(v);
    }
    if (type_name.contains("float")
        || type_name.contains("double")
        || type_name.contains("decimal"))
        && let Ok(v) = row.try_get::<f64, _>(index)
    {
        return serde_json::json!(v);
    }
    if type_name.contains("blob") || type_name.contains("binary") {
        return Value::String("[BLOB]".to_string());
    }
    match row.try_get::<String, _>(index) {
        Ok(v) => Value::String(v),
        Err(_) => Value::Null,
    }
}
