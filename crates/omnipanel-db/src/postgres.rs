use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow};
use sqlx::types::Json;
use sqlx::{Column, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::{DbDriver, DbParams, QueryResult, is_query, map_sqlx_err, split_statements};

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

    async fn preview(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
        order_by: Option<&str>,
        where_clause: Option<&str>,
    ) -> OmniResult<QueryResult> {
        let safe = table.replace('"', "");
        let where_sql = crate::build_where_sql(where_clause)?;
        let order_clause = match order_by {
            Some(clause) if !clause.trim().is_empty() => {
                format!(" ORDER BY {}", clause.trim())
            }
            _ => String::new(),
        };
        let sql = format!(
            "SELECT * FROM \"{}\"{}{} LIMIT {} OFFSET {}",
            safe,
            where_sql,
            order_clause,
            limit.max(0),
            offset.max(0)
        );
        run(&self.pool, &sql).await
    }

    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64> {
        let safe = table.replace('"', "");
        let where_sql = crate::build_where_sql(where_clause)?;
        let sql = format!("SELECT COUNT(*) AS count FROM \"{}\"{}", safe, where_sql);
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        Ok(row.get::<i64, _>("count"))
    }
}

async fn select_columns(pool: &PgPool, sql: &str, rows: &[PgRow]) -> OmniResult<Vec<String>> {
    if let Some(row) = rows.first() {
        return Ok(row.columns().iter().map(|c| c.name().to_string()).collect());
    }
    let statement = pool.prepare(sql).await.map_err(map_sqlx_err)?;
    Ok(statement
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect())
}

async fn run(pool: &PgPool, sql: &str) -> OmniResult<QueryResult> {
    let statements = split_statements(sql);
    if statements.is_empty() {
        return Ok(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: 0,
        });
    }

    let mut result = QueryResult {
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected: 0,
    };
    for stmt in statements {
        if is_query(&stmt) {
            let rows = sqlx::query(&stmt)
                .fetch_all(pool)
                .await
                .map_err(map_sqlx_err)?;
            let columns = select_columns(pool, &stmt, &rows).await?;
            let data = rows
                .iter()
                .map(|r| (0..columns.len()).map(|i| extract(r, i)).collect())
                .collect();
            result = QueryResult {
                columns,
                rows: data,
                rows_affected: 0,
            };
        } else {
            let res = sqlx::query(&stmt)
                .execute(pool)
                .await
                .map_err(map_sqlx_err)?;
            result.rows_affected = result.rows_affected.saturating_add(res.rows_affected());
        }
    }
    Ok(result)
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
            .map(|v| safe_int_to_value(v as i128))
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
        "json" | "jsonb" => row
            .try_get::<Json<Value>, _>(index)
            .map(|Json(v)| v)
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(index)
            .map(Value::String)
            .or_else(|_| {
                row.try_get::<Json<Value>, _>(index)
                    .map(|Json(v)| v)
            })
            .unwrap_or(Value::Null),
    }
}

/// 整数若落在 JS Number 安全区间（±2^53）内返回 number，否则返回字符串以保留精度。
fn safe_int_to_value(v: i128) -> Value {
    const SAFE_MAX: i128 = 1i128 << 53;
    if v.abs() < SAFE_MAX {
        serde_json::json!(v)
    } else {
        Value::String(v.to_string())
    }
}
