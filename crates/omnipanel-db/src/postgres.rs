use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::{Column, Row, TypeInfo, ValueRef};

use crate::{DbDriver, DbParams, QueryResult, is_query, map_sqlx_err};

pub struct PgDriver {
    pool: PgPool,
}

impl PgDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        let opts = PgConnectOptions::new()
            .host(&params.host)
            .port(params.port)
            .username(&params.user)
            .password(&params.password)
            .database(&params.database);
        let pool = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(opts)
            .await
            .map_err(|e| OmniError::connection("PostgreSQL 连接失败").with_cause(e.to_string()))?;
        Ok(Self { pool })
    }
}

#[async_trait]
impl DbDriver for PgDriver {
    async fn version(&self) -> OmniResult<String> {
        let row = sqlx::query("SELECT version() AS version")
            .fetch_one(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        Ok(row.get::<String, _>("version"))
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let rows = sqlx::query(
            "SELECT tablename FROM pg_catalog.pg_tables \
             WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY tablename",
        )
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        Ok(rows.iter().map(|r| r.get::<String, _>(0)).collect())
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        run(&self.pool, sql).await
    }

    async fn preview(&self, table: &str, limit: i64, offset: i64) -> OmniResult<QueryResult> {
        let safe = table.replace('"', "");
        let sql = format!(
            "SELECT * FROM \"{}\" LIMIT {} OFFSET {}",
            safe,
            limit.max(0),
            offset.max(0)
        );
        run(&self.pool, &sql).await
    }

    async fn count(&self, table: &str) -> OmniResult<i64> {
        let safe = table.replace('"', "");
        let sql = format!("SELECT COUNT(*) AS count FROM \"{}\"", safe);
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        Ok(row.get::<i64, _>("count"))
    }
}

async fn run(pool: &PgPool, sql: &str) -> OmniResult<QueryResult> {
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

fn extract(row: &PgRow, index: usize) -> Value {
    let Ok(raw) = row.try_get_raw(index) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_lowercase();
    match type_name.as_str() {
        "bool" => row
            .try_get::<bool, _>(index)
            .map(|v| serde_json::json!(v))
            .unwrap_or(Value::Null),
        "int2" | "int4" | "int8" => row
            .try_get::<i64, _>(index)
            .map(|v| serde_json::json!(v))
            .unwrap_or(Value::Null),
        "float4" | "float8" | "numeric" => row
            .try_get::<f64, _>(index)
            .map(|v| serde_json::json!(v))
            .unwrap_or_else(|_| {
                row.try_get::<String, _>(index)
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            }),
        "bytea" => Value::String("[BYTEA]".to_string()),
        _ => row
            .try_get::<String, _>(index)
            .map(Value::String)
            .unwrap_or(Value::Null),
    }
}
