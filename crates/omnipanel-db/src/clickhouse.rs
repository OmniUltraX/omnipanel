//! ClickHouse HTTP 驱动（默认 8123）。插件 `omni.engine.clickhouse` 声明引擎 key / 表单。

use std::time::Duration;

use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::Deserialize;
use serde_json::Value;

use crate::{
    build_where_sql, is_query, sanitize_json_value_for_js, DbDriver, DbParams, QueryResult,
};

const DEFAULT_CLICKHOUSE_PORT: u16 = 8123;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub struct ClickHouseDriver {
    client: reqwest::Client,
    base_url: String,
    database: String,
}

#[derive(Debug, Deserialize)]
struct JsonCompactResponse {
    #[serde(default)]
    meta: Vec<JsonCompactMeta>,
    #[serde(default)]
    data: Vec<Vec<Value>>,
    #[serde(default)]
    rows: u64,
}

#[derive(Debug, Deserialize)]
struct JsonCompactMeta {
    name: String,
}

impl ClickHouseDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        let driver = Self::from_params(params)?;
        let _ = driver.version().await?;
        Ok(driver)
    }

    pub(crate) fn from_params(params: &DbParams) -> OmniResult<Self> {
        let host = params.host.trim();
        if host.is_empty() {
            return Err(OmniError::invalid_input("未指定 ClickHouse 主机"));
        }
        let port = if params.port == 0 {
            DEFAULT_CLICKHOUSE_PORT
        } else {
            params.port
        };
        let scheme = if params.ssl { "https" } else { "http" };
        let base_url = format!("{scheme}://{host}:{port}");
        let database = if params.database.trim().is_empty() {
            "default".to_string()
        } else {
            params.database.trim().to_string()
        };

        let mut headers = HeaderMap::new();
        let user = if params.user.trim().is_empty() {
            "default"
        } else {
            params.user.trim()
        };
        headers.insert(
            HeaderName::from_static("x-clickhouse-user"),
            HeaderValue::from_str(user).map_err(|e| {
                OmniError::invalid_input("ClickHouse 用户名含非法字符").with_cause(e.to_string())
            })?,
        );
        if !params.password.trim().is_empty() {
            headers.insert(
                HeaderName::from_static("x-clickhouse-key"),
                HeaderValue::from_str(params.password.trim()).map_err(|e| {
                    OmniError::invalid_input("ClickHouse 密码含非法字符").with_cause(e.to_string())
                })?,
            );
        }

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(REQUEST_TIMEOUT)
            .user_agent("OmniPanel/1.0 (clickhouse)")
            .build()
            .map_err(|e| {
                OmniError::connection("创建 ClickHouse HTTP 客户端失败").with_cause(e.to_string())
            })?;

        Ok(Self {
            client,
            base_url,
            database,
        })
    }

    async fn post_sql(&self, sql: &str) -> OmniResult<(String, Option<String>)> {
        let url = format!(
            "{}?database={}",
            self.base_url,
            urlencoding_lite(&self.database)
        );
        let resp = self
            .client
            .post(&url)
            .header("content-type", "text/plain; charset=utf-8")
            .body(sql.to_string())
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = resp.status();
        let summary = resp
            .headers()
            .get("x-clickhouse-summary")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = resp.text().await.map_err(map_reqwest)?;
        if !status.is_success() {
            return Err(OmniError::database(format!(
                "ClickHouse 请求失败 HTTP {}",
                status.as_u16()
            ))
            .with_cause(body.chars().take(400).collect::<String>()));
        }
        Ok((body, summary))
    }

    async fn query_json(&self, sql: &str) -> OmniResult<QueryResult> {
        let formatted = with_json_format(sql);
        let (body, _) = self.post_sql(&formatted).await?;
        let parsed: JsonCompactResponse = serde_json::from_str(&body).map_err(|e| {
            OmniError::database("解析 ClickHouse JSONCompact 失败")
                .with_cause(e.to_string())
        })?;
        let columns: Vec<String> = parsed.meta.into_iter().map(|m| m.name).collect();
        let rows = parsed
            .data
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(sanitize_json_value_for_js)
                    .collect::<Vec<_>>()
            })
            .collect();
        Ok(QueryResult {
            columns,
            rows,
            rows_affected: parsed.rows,
        })
    }

    pub async fn list_databases(&self) -> OmniResult<Vec<String>> {
        let result = self.query_json("SHOW DATABASES").await?;
        let mut names: Vec<String> = result
            .rows
            .into_iter()
            .filter_map(|row| row.first().and_then(value_as_string))
            .filter(|name| !name.is_empty())
            .collect();
        names.sort();
        Ok(names)
    }

    pub async fn describe_table(&self, table: &str) -> OmniResult<Vec<(String, String)>> {
        let ident = qualify_table(&self.database, table)?;
        let result = self
            .query_json(&format!("DESCRIBE TABLE {ident}"))
            .await?;
        Ok(result
            .rows
            .into_iter()
            .filter_map(|row| {
                let name = row.first().and_then(value_as_string)?;
                let col_type = row.get(1).and_then(value_as_string).unwrap_or_default();
                if name.is_empty() {
                    None
                } else {
                    Some((name, col_type))
                }
            })
            .collect())
    }

    pub async fn create_database(&self, name: &str) -> OmniResult<()> {
        let ident = quote_ident(name);
        let _ = self
            .post_sql(&format!("CREATE DATABASE IF NOT EXISTS {ident}"))
            .await?;
        Ok(())
    }

    pub async fn show_create_table(&self, table: &str) -> OmniResult<String> {
        let ident = qualify_table(&self.database, table)?;
        let result = self
            .query_json(&format!("SHOW CREATE TABLE {ident}"))
            .await?;
        Ok(result
            .rows
            .first()
            .and_then(|row| row.last())
            .and_then(value_as_string)
            .unwrap_or_default())
    }
}

#[async_trait]
impl DbDriver for ClickHouseDriver {
    async fn version(&self) -> OmniResult<String> {
        let result = self.query_json("SELECT version()").await?;
        Ok(result
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(value_as_string)
            .unwrap_or_else(|| "ClickHouse".to_string()))
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let db = quote_ident(&self.database);
        let result = self
            .query_json(&format!("SHOW TABLES FROM {db}"))
            .await?;
        let mut names: Vec<String> = result
            .rows
            .into_iter()
            .filter_map(|row| row.first().and_then(value_as_string))
            .filter(|name| !name.is_empty())
            .collect();
        names.sort();
        Ok(names)
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        let trimmed = sql.trim();
        if trimmed.is_empty() {
            return Err(OmniError::invalid_input("语句不能为空"));
        }
        if is_query(trimmed) {
            return self.query_json(trimmed).await;
        }
        let (body, summary) = self.post_sql(trimmed.trim_end_matches(';')).await?;
        let _ = body;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            rows_affected: parse_written_rows(summary.as_deref()),
        })
    }

    async fn preview(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
        order_by: Option<&str>,
        where_clause: Option<&str>,
    ) -> OmniResult<QueryResult> {
        let ident = qualify_table(&self.database, table)?;
        let where_sql = build_where_sql(where_clause)?;
        let order_sql = match order_by {
            Some(expr) if !expr.trim().is_empty() => format!(" ORDER BY {}", expr.trim()),
            _ => String::new(),
        };
        let limit = limit.clamp(1, 10_000);
        let offset = offset.max(0);
        let sql = format!(
            "SELECT * FROM {ident}{where_sql}{order_sql} LIMIT {limit} OFFSET {offset}"
        );
        self.query_json(&sql).await
    }

    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64> {
        let ident = qualify_table(&self.database, table)?;
        let where_sql = build_where_sql(where_clause)?;
        let result = self
            .query_json(&format!("SELECT count() FROM {ident}{where_sql}"))
            .await?;
        Ok(result
            .rows
            .first()
            .and_then(|row| row.first())
            .and_then(value_as_i64)
            .unwrap_or(0))
    }
}

pub async fn clickhouse_list_databases(params: &DbParams) -> OmniResult<Vec<String>> {
    let driver = ClickHouseDriver::from_params(params)?;
    driver.list_databases().await
}

fn qualify_table(database: &str, table: &str) -> OmniResult<String> {
    let table = table.trim();
    if table.is_empty() {
        return Err(OmniError::invalid_input("未指定数据表"));
    }
    if table.contains('.') {
        let mut parts = table.splitn(2, '.');
        let db = parts.next().unwrap_or(database);
        let name = parts.next().unwrap_or(table);
        return Ok(format!("{}.{}", quote_ident(db), quote_ident(name)));
    }
    Ok(format!("{}.{}", quote_ident(database), quote_ident(table)))
}

pub(crate) fn quote_ident(raw: &str) -> String {
    format!("`{}`", raw.replace('`', "``"))
}

fn with_json_format(sql: &str) -> String {
    let trimmed = sql.trim().trim_end_matches(';').trim();
    let upper = trimmed.to_ascii_uppercase();
    if upper.contains(" FORMAT ") {
        trimmed.to_string()
    } else {
        format!("{trimmed} FORMAT JSONCompact")
    }
}

fn value_as_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

fn value_as_i64(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64().or_else(|| n.as_u64().map(|v| v as i64)),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
}

fn parse_written_rows(summary: Option<&str>) -> u64 {
    let Some(raw) = summary else {
        return 0;
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return 0;
    };
    value
        .get("written_rows")
        .and_then(|v| match v {
            Value::String(s) => s.parse().ok(),
            Value::Number(n) => n.as_u64(),
            _ => None,
        })
        .unwrap_or(0)
}

fn urlencoding_lite(value: &str) -> String {
    let mut out = String::new();
    for ch in value.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            _ => {
                for byte in ch.to_string().as_bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    out
}

fn map_reqwest(err: reqwest::Error) -> OmniError {
    OmniError::connection("ClickHouse 网络请求失败").with_cause(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_backticks() {
        assert_eq!(quote_ident("default"), "`default`");
        assert_eq!(quote_ident("a`b"), "`a``b`");
    }

    #[test]
    fn appends_json_compact_once() {
        assert_eq!(
            with_json_format("SELECT 1;"),
            "SELECT 1 FORMAT JSONCompact"
        );
        assert_eq!(
            with_json_format("SELECT 1 FORMAT JSONCompact"),
            "SELECT 1 FORMAT JSONCompact"
        );
    }

    #[test]
    fn parses_summary_written_rows() {
        assert_eq!(
            parse_written_rows(Some(r#"{"written_rows":"3","read_rows":"0"}"#)),
            3
        );
        assert_eq!(parse_written_rows(None), 0);
    }
}
