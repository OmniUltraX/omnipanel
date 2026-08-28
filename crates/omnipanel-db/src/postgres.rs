use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::types::Json;
use sqlx::types::chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::{Column, Executor, Row, Statement, TypeInfo, ValueRef};

use crate::{
    DbDriver, DbParams, QueryResult, encode_blob_value, is_query, map_sqlx_err,
    numeric_string_to_value, safe_int_to_value, sanitize_json_value_for_js, split_statements,
};

const DEFAULT_PG_PORT: u16 = 5432;

pub fn postgres_connect_options(params: &DbParams) -> PgConnectOptions {
    let port = if params.port == 0 {
        DEFAULT_PG_PORT
    } else {
        params.port
    };
    let database = if params.database.trim().is_empty() {
        "postgres"
    } else {
        params.database.trim()
    };
    let ssl_mode = if params.ssl {
        PgSslMode::Require
    } else {
        // 默认 Prefer 会先发送 SSLRequest；瀚高/部分 PG 兼容库不支持 SSL 握手会报错。
        PgSslMode::Disable
    };

    PgConnectOptions::new()
        .host(&params.host)
        .port(port)
        .username(&params.user)
        .password(&params.password)
        .database(database)
        .ssl_mode(ssl_mode)
}

pub struct PgDriver {
    pool: PgPool,
}

impl PgDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        Self::connect_with_pool_size(params, 2).await
    }

    /// 事务会话用：池大小为 1，保证 BEGIN/后续语句/COMMIT 落在同一连接。
    pub async fn connect_exclusive(params: &DbParams) -> OmniResult<Self> {
        Self::connect_with_pool_size(params, 1).await
    }

    async fn connect_with_pool_size(params: &DbParams, max_connections: u32) -> OmniResult<Self> {
        let opts = postgres_connect_options(params);
        let pool = PgPoolOptions::new()
            .max_connections(max_connections.max(1))
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
        "int2" | "int4" | "int8" | "oid" | "xid" | "cid" => decode_pg_int(row, index),
        "float4" | "float8" => decode_pg_float(row, index),
        "numeric" => decode_pg_numeric(row, index),
        "uuid" => decode_pg_uuid(row, index),
        "timestamp" | "timestamptz" | "date" | "time" | "timetz" => decode_pg_temporal(row, index),
        "_int2" | "int2[]" | "_int4" | "int4[]" | "_int8" | "int8[]" | "_oid" | "oid[]" => {
            decode_pg_int_array(row, index)
        }
        "_float4" | "float4[]" | "_float8" | "float8[]" => decode_pg_float_array(row, index),
        "_bool" | "bool[]" => decode_pg_bool_array(row, index),
        "_text" | "text[]" | "_varchar" | "varchar[]" | "_bpchar" | "bpchar[]" | "_name"
        | "name[]" | "_uuid" | "uuid[]" => decode_pg_text_array(row, index),
        "bytea" => row
            .try_get::<Vec<u8>, _>(index)
            .map(|bytes| encode_blob_value(&bytes))
            .unwrap_or_else(|_| Value::String("[BYTEA]".to_string())),
        "json" | "jsonb" => row
            .try_get::<Json<Value>, _>(index)
            .map(|Json(v)| sanitize_json_value_for_js(v))
            .unwrap_or(Value::Null),
        _ => row
            .try_get::<String, _>(index)
            .map(Value::String)
            .or_else(|_| {
                row.try_get::<Json<Value>, _>(index)
                    .map(|Json(v)| sanitize_json_value_for_js(v))
            })
            .unwrap_or(Value::Null),
    }
}

/// sqlx 对整型按宽度严格兼容：`INT4` 不能 `try_get::<i64>`，否则整列变 NULL。
fn decode_pg_uuid(row: &PgRow, index: usize) -> Value {
    if let Ok(s) = row.try_get::<String, _>(index) {
        return Value::String(s);
    }
    if let Ok(bytes) = row.try_get::<[u8; 16], _>(index) {
        return Value::String(format_uuid_bytes(&bytes));
    }
    if let Ok(raw) = row.try_get_raw(index) {
        if let Ok(bytes) = raw.as_bytes() {
            if let Ok(arr) = <[u8; 16]>::try_from(bytes) {
                return Value::String(format_uuid_bytes(&arr));
            }
        }
    }
    Value::Null
}

fn format_uuid_bytes(b: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13],
        b[14], b[15]
    )
}

fn decode_pg_int(row: &PgRow, index: usize) -> Value {
    if let Ok(v) = row.try_get::<i64, _>(index) {
        return safe_int_to_value(i128::from(v));
    }
    if let Ok(v) = row.try_get::<i32, _>(index) {
        return safe_int_to_value(i128::from(v));
    }
    if let Ok(v) = row.try_get::<i16, _>(index) {
        return safe_int_to_value(i128::from(v));
    }
    Value::Null
}

fn decode_pg_float(row: &PgRow, index: usize) -> Value {
    if let Ok(v) = row.try_get::<f64, _>(index) {
        return serde_json::json!(v);
    }
    if let Ok(v) = row.try_get::<f32, _>(index) {
        return serde_json::json!(v);
    }
    row.try_get::<String, _>(index)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

/// sqlx 默认不解码 `NUMERIC`（需 rust_decimal）。从协议二进制组十进制字符串，保精度。
fn decode_pg_numeric(row: &PgRow, index: usize) -> Value {
    if let Ok(raw) = row.try_get_raw(index) {
        if let Ok(bytes) = raw.as_bytes() {
            if let Some(s) = pg_numeric_bytes_to_string(bytes) {
                return numeric_string_to_value(&s);
            }
        }
    }
    decode_pg_float(row, index)
}

const PG_NUMERIC_NEG: u16 = 0x4000;
const PG_NUMERIC_NAN: u16 = 0xC000;
const PG_NUMERIC_PINF: u16 = 0xD000;
const PG_NUMERIC_NINF: u16 = 0xF000;

fn pg_numeric_bytes_to_string(bytes: &[u8]) -> Option<String> {
    if bytes.len() < 8 {
        return None;
    }
    let ndigits = i16::from_be_bytes(bytes[0..2].try_into().ok()?) as usize;
    let weight = i16::from_be_bytes(bytes[2..4].try_into().ok()?);
    let sign = u16::from_be_bytes(bytes[4..6].try_into().ok()?);
    let dscale = u16::from_be_bytes(bytes[6..8].try_into().ok()?) as i32;
    match sign {
        PG_NUMERIC_NAN => return Some("NaN".to_string()),
        PG_NUMERIC_PINF => return Some("Infinity".to_string()),
        PG_NUMERIC_NINF => return Some("-Infinity".to_string()),
        0 | PG_NUMERIC_NEG => {}
        _ => return None,
    }
    let needed = 8usize.checked_add(ndigits.checked_mul(2)?)?;
    if bytes.len() < needed {
        return None;
    }
    let mut digits = Vec::with_capacity(ndigits);
    for i in 0..ndigits {
        let off = 8 + i * 2;
        digits.push(i16::from_be_bytes(bytes[off..off + 2].try_into().ok()?));
    }

    let mut out = String::new();
    if sign == PG_NUMERIC_NEG {
        out.push('-');
    }
    if ndigits == 0 || weight < 0 {
        out.push('0');
    } else {
        for i in 0..=weight {
            let d = digits.get(i as usize).copied().unwrap_or(0);
            if i == 0 {
                out.push_str(&d.to_string());
            } else {
                out.push_str(&format!("{d:04}"));
            }
        }
    }
    if dscale > 0 {
        out.push('.');
        let mut remaining = dscale;
        let mut i = i32::from(weight) + 1;
        while remaining > 0 {
            let d = if i >= 0 {
                digits.get(i as usize).copied().unwrap_or(0)
            } else {
                0
            };
            let chunk = format!("{d:04}");
            let take = remaining.min(4);
            out.push_str(&chunk[..take as usize]);
            remaining -= take;
            i += 1;
        }
    }
    Some(out)
}

fn decode_pg_int_array(row: &PgRow, index: usize) -> Value {
    if let Ok(v) = row.try_get::<Vec<i64>, _>(index) {
        return serde_json::json!(v);
    }
    if let Ok(v) = row.try_get::<Vec<i32>, _>(index) {
        return serde_json::json!(v);
    }
    if let Ok(v) = row.try_get::<Vec<i16>, _>(index) {
        return serde_json::json!(v);
    }
    Value::Null
}

fn decode_pg_float_array(row: &PgRow, index: usize) -> Value {
    if let Ok(v) = row.try_get::<Vec<f64>, _>(index) {
        return serde_json::json!(v);
    }
    if let Ok(v) = row.try_get::<Vec<f32>, _>(index) {
        return serde_json::json!(v);
    }
    Value::Null
}

fn decode_pg_bool_array(row: &PgRow, index: usize) -> Value {
    row.try_get::<Vec<bool>, _>(index)
        .map(|v| serde_json::json!(v))
        .unwrap_or(Value::Null)
}

fn decode_pg_text_array(row: &PgRow, index: usize) -> Value {
    row.try_get::<Vec<String>, _>(index)
        .map(|v| serde_json::json!(v))
        .unwrap_or(Value::Null)
}

fn decode_pg_temporal(row: &PgRow, index: usize) -> Value {
    if let Ok(v) = row.try_get::<DateTime<Utc>, _>(index) {
        return Value::String(v.to_rfc3339());
    }
    if let Ok(v) = row.try_get::<NaiveDateTime, _>(index) {
        return Value::String(v.format("%Y-%m-%d %H:%M:%S%.f").to_string());
    }
    if let Ok(v) = row.try_get::<NaiveDate, _>(index) {
        return Value::String(v.format("%Y-%m-%d").to_string());
    }
    if let Ok(v) = row.try_get::<NaiveTime, _>(index) {
        return Value::String(v.format("%H:%M:%S%.f").to_string());
    }
    row.try_get::<String, _>(index)
        .map(Value::String)
        .unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::pg_numeric_bytes_to_string;
    use crate::numeric_string_to_value;
    use serde_json::json;

    fn pack(ndigits: i16, weight: i16, sign: u16, dscale: u16, digits: &[i16]) -> Vec<u8> {
        let mut out = Vec::with_capacity(8 + digits.len() * 2);
        out.extend_from_slice(&ndigits.to_be_bytes());
        out.extend_from_slice(&weight.to_be_bytes());
        out.extend_from_slice(&sign.to_be_bytes());
        out.extend_from_slice(&dscale.to_be_bytes());
        for d in digits {
            out.extend_from_slice(&d.to_be_bytes());
        }
        out
    }

    #[test]
    fn pg_numeric_1_25() {
        let bytes = pack(2, 0, 0, 2, &[1, 2500]);
        assert_eq!(
            pg_numeric_bytes_to_string(&bytes).as_deref(),
            Some("1.25")
        );
        assert_eq!(numeric_string_to_value("1.25"), json!(1.25));
    }

    #[test]
    fn pg_numeric_zero_point_one() {
        let bytes = pack(1, -1, 0, 1, &[1000]);
        assert_eq!(pg_numeric_bytes_to_string(&bytes).as_deref(), Some("0.1"));
    }

    #[test]
    fn pg_numeric_negative() {
        let bytes = pack(2, 0, 0x4000, 1, &[12, 5000]);
        assert_eq!(pg_numeric_bytes_to_string(&bytes).as_deref(), Some("-12.5"));
    }

    #[test]
    fn pg_numeric_nan() {
        let bytes = pack(0, 0, 0xC000, 0, &[]);
        assert_eq!(pg_numeric_bytes_to_string(&bytes).as_deref(), Some("NaN"));
    }

    #[test]
    fn uuid_bytes_format() {
        let b = [
            0x55, 0x0e, 0x84, 0x00, 0xe2, 0x9b, 0x41, 0xd4, 0xa7, 0x16, 0x44, 0x66, 0x55, 0x44,
            0x00, 0x00,
        ];
        assert_eq!(
            super::format_uuid_bytes(&b),
            "550e8400-e29b-41d4-a716-446655440000"
        );
    }
}
