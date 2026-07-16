use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde_json::Value;
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::types::Json;
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, Utc};
use sqlx::{Column, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::{
    DbDriver, DbParams, QueryResult, encode_blob_value, is_query, map_sqlx_err, split_statements,
};

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
        // Preferred 会对非 TLS 服务器先尝试握手，易触发 HandshakeFailure；
        // 显式关闭 SSL 时用 Disabled，与连接配置语义一致。
        MySqlSslMode::Disabled
    };

    let mut opts = MySqlConnectOptions::new()
        .host(&params.host)
        .port(port)
        .username(&params.user)
        .password(&params.password)
        .charset("utf8mb4")
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
    // 仅真正的 BLOB 类型走二进制编码。不可用 contains("binary")：会误伤 VARBINARY，
    // 以及 Activiti 等历史表里的 VARCHAR BINARY（线上常以 VARBINARY 上报）。
    if is_mysql_blob_type(&type_name) {
        return row
            .try_get::<Vec<u8>, _>(index)
            .map(|bytes| encode_blob_value(&bytes))
            .unwrap_or_else(|_| Value::String("[BLOB]".to_string()));
    }
    if is_mysql_binary_type(&type_name) {
        return decode_binary_or_text_column(row, index);
    }
    // sqlx 0.8+：MySQL JSON 列无法直接 decode 为 String，需 Json<Value> 或字节再解析。
    if type_name.contains("json") {
        if let Some(v) = decode_json_column(row, index) {
            return v;
        }
    }
    if type_name.contains("datetime") {
        if let Ok(v) = row.try_get::<NaiveDateTime, _>(index) {
            return Value::String(v.format("%Y-%m-%d %H:%M:%S").to_string());
        }
    } else if type_name.contains("timestamp") {
        if let Ok(v) = row.try_get::<DateTime<Utc>, _>(index) {
            return Value::String(v.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string());
        }
        if let Ok(v) = row.try_get::<NaiveDateTime, _>(index) {
            return Value::String(v.format("%Y-%m-%d %H:%M:%S").to_string());
        }
    } else if type_name == "date" {
        if let Ok(v) = row.try_get::<NaiveDate, _>(index) {
            return Value::String(v.format("%Y-%m-%d").to_string());
        }
    } else if type_name == "time" {
        if let Ok(v) = row.try_get::<String, _>(index) {
            return Value::String(v);
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

fn is_mysql_blob_type(type_name: &str) -> bool {
    matches!(
        type_name,
        "blob" | "tinyblob" | "mediumblob" | "longblob"
    )
}

fn is_mysql_binary_type(type_name: &str) -> bool {
    matches!(type_name, "binary" | "varbinary")
}

/// BINARY / VARBINARY：可 UTF-8 解码的按文本展示，否则按 BLOB 结构化编码。
fn decode_binary_or_text_column(row: &MySqlRow, index: usize) -> Value {
    if let Ok(v) = row.try_get::<String, _>(index) {
        return Value::String(v);
    }
    match row.try_get::<Vec<u8>, _>(index) {
        Ok(bytes) if looks_like_utf8_text(&bytes) => decode_bytes_as_json_or_text(bytes),
        Ok(bytes) => encode_blob_value(&bytes),
        Err(_) => Value::String("[BLOB]".to_string()),
    }
}

fn looks_like_utf8_text(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return true;
    }
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    text.chars()
        .all(|c| !c.is_control() || matches!(c, '\n' | '\r' | '\t'))
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
