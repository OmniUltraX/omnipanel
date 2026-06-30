use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde_json::Value;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::types::Json;
use sqlx::{Column, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::{DbDriver, DbParams, QueryResult, is_query, map_sqlx_err, split_statements};

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
        Ok(decode_text_column(&row, "version").unwrap_or_else(|| "unknown".into()))
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let rows = sqlx::query(
            "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(&self.database)
        .fetch_all(&self.pool)
        .await
        .map_err(map_sqlx_err)?;
        Ok(rows
            .iter()
            .filter_map(|r| decode_text_column(r, 0))
            .collect())
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
        let safe = table.replace('`', "");
        let where_sql = crate::build_where_sql(where_clause)?;
        let order_clause = match order_by {
            Some(clause) if !clause.trim().is_empty() => {
                format!(" ORDER BY {}", clause.trim())
            }
            _ => String::new(),
        };
        let sql = format!(
            "SELECT * FROM `{}`{}{} LIMIT {} OFFSET {}",
            safe,
            where_sql,
            order_clause,
            limit.max(0),
            offset.max(0)
        );
        run(&self.pool, &sql).await
    }

    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64> {
        let safe = table.replace('`', "");
        let where_sql = crate::build_where_sql(where_clause)?;
        let sql = format!("SELECT COUNT(*) AS count FROM `{}`{}", safe, where_sql);
        let row = sqlx::query(&sql)
            .fetch_one(&self.pool)
            .await
            .map_err(map_sqlx_err)?;
        Ok(row.get::<i64, _>("count"))
    }
}

async fn select_columns(pool: &MySqlPool, sql: &str, rows: &[MySqlRow]) -> OmniResult<Vec<String>> {
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

async fn run(pool: &MySqlPool, sql: &str) -> OmniResult<QueryResult> {
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
            // 多个查询时以最后一条为准（前端只展示一个结果集）。
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

fn decode_json_column(row: &MySqlRow, index: usize) -> Option<Value> {
    row.try_get::<Json<Value>, _>(index)
        .ok()
        .map(|Json(v)| v)
}

fn decode_bytes_as_json_or_text(bytes: Vec<u8>) -> Value {
    let text = String::from_utf8_lossy(&bytes).into_owned();
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

fn extract(row: &MySqlRow, index: usize) -> Value {
    let Ok(raw) = row.try_get_raw(index) else {
        return Value::Null;
    };
    if raw.is_null() {
        return Value::Null;
    }
    let type_name = raw.type_info().name().to_lowercase();
    if type_name.contains("int") {
        // BIGINT UNSIGNED 超出 i64 范围，先按 u64 尝试，避免 i64 溢出吞精度
        if let Ok(v) = row.try_get::<u64, _>(index) {
            return safe_int_to_value(v as i128);
        }
        if let Ok(v) = row.try_get::<i64, _>(index) {
            return safe_int_to_value(v as i128);
        }
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
    // sqlx 0.8+：MySQL JSON 列无法直接 decode 为 String，需 Json<Value> 或字节再解析。
    if type_name.contains("json") {
        if let Some(v) = decode_json_column(row, index) {
            return v;
        }
    }
    match row.try_get::<String, _>(index) {
        Ok(v) => Value::String(v),
        Err(_) => decode_json_column(row, index)
            .or_else(|| {
                row.try_get::<Vec<u8>, _>(index)
                    .ok()
                    .map(decode_bytes_as_json_or_text)
            })
            .unwrap_or(Value::Null),
    }
}

/// information_schema 等系统表在部分 MySQL/MariaDB 上会以 VARBINARY 返回标识符列。
fn decode_text_column<I>(row: &MySqlRow, index: I) -> Option<String>
where
    I: sqlx::ColumnIndex<MySqlRow>,
{
    row.try_get::<String, _>(&index)
        .ok()
        .or_else(|| {
            row.try_get::<Vec<u8>, _>(&index)
                .ok()
                .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        })
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
