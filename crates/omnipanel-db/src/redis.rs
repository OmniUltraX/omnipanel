use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use redis::{AsyncCommands, Client, aio::MultiplexedConnection};
use serde::Serialize;
use serde_json::Value;

use crate::{DbDriver, DbParams, QueryResult};

/// Redis 键搜索结果（供查询面板展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyEntry {
    pub key: String,
    pub key_type: String,
    pub value: String,
}

const DEFAULT_REDIS_PORT: u16 = 6379;

pub struct RedisDriver {
    conn: MultiplexedConnection,
}

impl RedisDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        let port = if params.port == 0 {
            DEFAULT_REDIS_PORT
        } else {
            params.port
        };
        let db = params
            .database
            .trim()
            .parse::<i64>()
            .ok()
            .and_then(|n| if (0..=15).contains(&n) { Some(n) } else { None })
            .unwrap_or(0);

        let url = if params.password.is_empty() {
            format!("redis://{}:{}/{}", params.host, port, db)
        } else if params.user.is_empty() {
            format!(
                "redis://:{}@{}:{}/{}",
                percent_encode(&params.password),
                params.host,
                port,
                db
            )
        } else {
            format!(
                "redis://{}:{}@{}:{}/{}",
                percent_encode(&params.user),
                percent_encode(&params.password),
                params.host,
                port,
                db
            )
        };

        let client = Client::open(url)
            .map_err(|e| OmniError::connection("Redis 连接参数无效").with_cause(e.to_string()))?;
        let conn = client
            .get_multiplexed_tokio_connection()
            .await
            .map_err(|e| OmniError::connection("Redis 连接失败").with_cause(e.to_string()))?;

        Ok(Self { conn })
    }

    /// 使用 SCAN 按模式搜索键，并按类型过滤；值为简要预览。
    pub async fn search_keys(
        &self,
        pattern: &str,
        types: &[String],
        limit: usize,
    ) -> OmniResult<Vec<RedisKeyEntry>> {
        let pattern = {
            let trimmed = pattern.trim();
            if trimmed.is_empty() {
                "*"
            } else {
                trimmed
            }
        };
        let limit = limit.clamp(1, 2000);
        let type_filter: std::collections::HashSet<String> =
            types.iter().map(|t| t.to_lowercase()).collect();
        let filter_types = !type_filter.is_empty();

        let mut conn = self.conn.clone();
        let mut cursor: u64 = 0;
        let mut entries = Vec::new();

        loop {
            let (next, keys): (u64, Vec<String>) = redis::cmd("SCAN")
                .arg(cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(200)
                .query_async(&mut conn)
                .await
                .map_err(map_redis_err)?;

            for key in keys {
                if entries.len() >= limit {
                    return Ok(entries);
                }
                let key_type: String = redis::cmd("TYPE")
                    .arg(&key)
                    .query_async(&mut conn)
                    .await
                    .map_err(map_redis_err)?;
                if filter_types && !type_filter.contains(&key_type) {
                    continue;
                }
                let value = preview_redis_value(&mut conn, &key, &key_type).await?;
                entries.push(RedisKeyEntry {
                    key,
                    key_type,
                    value,
                });
            }

            cursor = next;
            if cursor == 0 {
                break;
            }
        }

        Ok(entries)
    }
}

#[async_trait]
impl DbDriver for RedisDriver {
    async fn version(&self) -> OmniResult<String> {
        let mut conn = self.conn.clone();
        let info: String = redis::cmd("INFO")
            .arg("server")
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        parse_redis_version(&info)
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let mut conn = self.conn.clone();
        let keys: Vec<String> = redis::cmd("KEYS")
            .arg("*")
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        Ok(keys)
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        let cmd = parse_redis_command(sql);
        if cmd.args.is_empty() {
            return Err(OmniError::invalid_input("Redis 命令为空"));
        }

        let mut connection = self.conn.clone();
        let name = cmd.args[0].to_uppercase();
        let mut command = redis::cmd(&name);
        for arg in &cmd.args[1..] {
            command.arg(arg);
        }

        let value: redis::Value = command
            .query_async(&mut connection)
            .await
            .map_err(map_redis_err)?;

        to_query_result(value, name)
    }

    async fn preview(
        &self,
        table: &str,
        limit: i64,
        _offset: i64,
        _order_by: Option<&str>,
    ) -> OmniResult<QueryResult> {
        let mut conn = self.conn.clone();
        let key_type: String = redis::cmd("TYPE")
            .arg(table)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;

        match key_type.as_str() {
            "string" => {
                let value: Option<String> = conn.get(table).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["key".to_string(), "value".to_string()],
                    rows: vec![vec![Value::String(table.to_string()), json_opt(value)]],
                    rows_affected: 0,
                })
            }
            "list" => {
                let stop = (limit.max(1) - 1).try_into().unwrap_or(isize::MAX);
                let values: Vec<String> =
                    conn.lrange(table, 0, stop).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["index".to_string(), "value".to_string()],
                    rows: values
                        .into_iter()
                        .enumerate()
                        .map(|(i, v)| vec![Value::Number(i.into()), Value::String(v)])
                        .collect(),
                    rows_affected: 0,
                })
            }
            "set" => {
                let values: Vec<String> = conn.smembers(table).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["member".to_string()],
                    rows: values.into_iter().map(|v| vec![Value::String(v)]).collect(),
                    rows_affected: 0,
                })
            }
            "zset" => {
                let values: Vec<(String, f64)> = conn
                    .zrange_withscores(table, 0isize, (limit.max(0) - 1) as isize)
                    .await
                    .map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["member".to_string(), "score".to_string()],
                    rows: values
                        .into_iter()
                        .map(|(m, s)| vec![Value::String(m), serde_json::json!(s)])
                        .collect(),
                    rows_affected: 0,
                })
            }
            "hash" => {
                let fields: Vec<(String, String)> =
                    conn.hgetall(table).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["field".to_string(), "value".to_string()],
                    rows: fields
                        .into_iter()
                        .map(|(k, v)| vec![Value::String(k), Value::String(v)])
                        .collect(),
                    rows_affected: 0,
                })
            }
            _ => Ok(QueryResult {
                columns: vec!["type".to_string()],
                rows: vec![vec![Value::String(key_type)]],
                rows_affected: 0,
            }),
        }
    }

    async fn count(&self, table: &str) -> OmniResult<i64> {
        let mut conn = self.conn.clone();
        let key_type: String = redis::cmd("TYPE")
            .arg(table)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;

        let count: i64 = match key_type.as_str() {
            "string" => 1,
            "list" => conn.llen(table).await.map_err(map_redis_err)?,
            "set" => conn.scard(table).await.map_err(map_redis_err)?,
            "zset" => conn.zcard(table).await.map_err(map_redis_err)?,
            "hash" => conn.hlen(table).await.map_err(map_redis_err)?,
            _ => 0,
        };
        Ok(count)
    }
}

async fn preview_redis_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    key_type: &str,
) -> OmniResult<String> {
    const MAX: usize = 256;
    match key_type {
        "string" => {
            let v: Option<String> = conn.get(key).await.map_err(map_redis_err)?;
            Ok(truncate_display(v.unwrap_or_default(), MAX))
        }
        "list" => {
            let len: i64 = conn.llen(key).await.map_err(map_redis_err)?;
            let values: Vec<String> = conn.lrange(key, 0, 2).await.map_err(map_redis_err)?;
            let preview = values.join(", ");
            let suffix = if len > 3 { ", …" } else { "" };
            Ok(format!("[list len={len}] {preview}{suffix}"))
        }
        "set" => {
            let len: i64 = conn.scard(key).await.map_err(map_redis_err)?;
            Ok(format!("[set len={len}]"))
        }
        "zset" => {
            let len: i64 = conn.zcard(key).await.map_err(map_redis_err)?;
            Ok(format!("[zset len={len}]"))
        }
        "hash" => {
            let len: i64 = conn.hlen(key).await.map_err(map_redis_err)?;
            let fields: Vec<(String, String)> = conn.hgetall(key).await.map_err(map_redis_err)?;
            if fields.is_empty() {
                return Ok(format!("[hash len={len}]"));
            }
            let preview: String = fields
                .into_iter()
                .take(2)
                .map(|(k, v)| format!("{k}={}", truncate_display(v, 40)))
                .collect::<Vec<_>>()
                .join(", ");
            let suffix = if len > 2 { ", …" } else { "" };
            Ok(format!("[hash len={len}] {preview}{suffix}"))
        }
        "stream" => {
            let len: i64 = redis::cmd("XLEN")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_redis_err)?;
            Ok(format!("[stream len={len}]"))
        }
        other => Ok(format!("[{other}]")),
    }
}

fn truncate_display(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        s
    } else {
        let truncated: String = s.chars().take(max).collect();
        format!("{truncated}…")
    }
}

fn map_redis_err(err: redis::RedisError) -> OmniError {
    OmniError::database("Redis 操作失败").with_cause(err.to_string())
}

fn percent_encode(s: &str) -> String {
    // 只处理 URL 中需要转义的特殊字符；空格转成 %20，:@ 保留在 userinfo 中语义正确。
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '%' => "%25".to_string(),
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            '[' => "%5B".to_string(),
            ']' => "%5D".to_string(),
            _ => c.to_string(),
        })
        .collect()
}

#[derive(Debug)]
struct ParsedCommand {
    args: Vec<String>,
}

fn parse_redis_command(input: &str) -> ParsedCommand {
    let trimmed = input.trim();
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut escape = false;

    for ch in trimmed.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        if ch == '\\' {
            escape = true;
            continue;
        }
        if ch == '"' {
            in_quote = !in_quote;
            continue;
        }
        if ch.is_whitespace() && !in_quote {
            if !current.is_empty() {
                args.push(current.clone());
                current.clear();
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        args.push(current);
    }
    ParsedCommand { args }
}

fn parse_redis_version(info: &str) -> OmniResult<String> {
    for line in info.lines() {
        if let Some(value) = line.strip_prefix("redis_version:") {
            return Ok(value.trim().to_string());
        }
    }
    Ok("unknown".to_string())
}

fn to_query_result(value: redis::Value, command_name: String) -> OmniResult<QueryResult> {
    match value {
        redis::Value::Nil => Ok(QueryResult {
            columns: vec!["result".to_string()],
            rows: Vec::new(),
            rows_affected: 0,
        }),
        redis::Value::Int(n) => Ok(QueryResult {
            columns: vec!["integer".to_string()],
            rows: vec![vec![serde_json::json!(n)]],
            rows_affected: if is_write_command(&command_name) {
                n.max(0) as u64
            } else {
                0
            },
        }),
        redis::Value::BulkString(bytes) => Ok(QueryResult {
            columns: vec!["result".to_string()],
            rows: vec![vec![Value::String(
                String::from_utf8_lossy(&bytes).into_owned(),
            )]],
            rows_affected: 0,
        }),
        redis::Value::Array(items) => {
            // 数组统一展示为两列：index / value（扁平化）。
            let rows: Vec<Vec<Value>> = items
                .into_iter()
                .enumerate()
                .map(|(i, item)| vec![Value::Number(i.into()), redis_value_to_json(item)])
                .collect();
            Ok(QueryResult {
                columns: vec!["index".to_string(), "value".to_string()],
                rows,
                rows_affected: 0,
            })
        }
        redis::Value::SimpleString(s) => Ok(QueryResult {
            columns: vec!["status".to_string()],
            rows: vec![vec![Value::String(s)]],
            rows_affected: 0,
        }),
        redis::Value::Okay => Ok(QueryResult {
            columns: vec!["status".to_string()],
            rows: vec![vec![Value::String("OK".to_string())]],
            rows_affected: 1,
        }),
        redis::Value::Map(map) => {
            let mut columns = Vec::new();
            let mut row = Vec::new();
            for (k, v) in map {
                columns.push(redis_value_to_string(k));
                row.push(redis_value_to_json(v));
            }
            Ok(QueryResult {
                columns,
                rows: vec![row],
                rows_affected: 0,
            })
        }
        redis::Value::Attribute { .. } => Ok(QueryResult {
            columns: vec!["result".to_string()],
            rows: vec![vec![Value::String("(attribute response)".to_string())]],
            rows_affected: 0,
        }),
        redis::Value::Set(items) => Ok(QueryResult {
            columns: vec!["index".to_string(), "value".to_string()],
            rows: items
                .into_iter()
                .enumerate()
                .map(|(i, item)| vec![Value::Number(i.into()), redis_value_to_json(item)])
                .collect(),
            rows_affected: 0,
        }),
        redis::Value::Double(f) => Ok(QueryResult {
            columns: vec!["score".to_string()],
            rows: vec![vec![serde_json::json!(f)]],
            rows_affected: 0,
        }),
        redis::Value::Boolean(b) => Ok(QueryResult {
            columns: vec!["boolean".to_string()],
            rows: vec![vec![Value::Bool(b)]],
            rows_affected: 0,
        }),
        redis::Value::VerbatimString { format: _, text } => Ok(QueryResult {
            columns: vec!["result".to_string()],
            rows: vec![vec![Value::String(text)]],
            rows_affected: 0,
        }),
        redis::Value::BigNumber(n) => Ok(QueryResult {
            columns: vec!["integer".to_string()],
            rows: vec![vec![Value::String(n.to_string())]],
            rows_affected: 0,
        }),
        _ => Ok(QueryResult {
            columns: vec!["result".to_string()],
            rows: vec![vec![Value::String(format!("{:?}", value))]],
            rows_affected: 0,
        }),
    }
}

fn redis_value_to_json(value: redis::Value) -> Value {
    match value {
        redis::Value::Nil => Value::Null,
        redis::Value::Int(n) => serde_json::json!(n),
        redis::Value::BulkString(bytes) => {
            Value::String(String::from_utf8_lossy(&bytes).into_owned())
        }
        redis::Value::Array(items) => {
            Value::Array(items.into_iter().map(redis_value_to_json).collect())
        }
        redis::Value::SimpleString(s) => Value::String(s),
        redis::Value::Okay => Value::String("OK".to_string()),
        redis::Value::Map(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (redis_value_to_string(k), redis_value_to_json(v)))
                .collect(),
        ),
        redis::Value::Set(items) => {
            Value::Array(items.into_iter().map(redis_value_to_json).collect())
        }
        redis::Value::Double(f) => serde_json::json!(f),
        redis::Value::Boolean(b) => Value::Bool(b),
        redis::Value::VerbatimString { format: _, text } => Value::String(text),
        redis::Value::BigNumber(n) => Value::String(n.to_string()),
        _ => Value::String(format!("{:?}", value)),
    }
}

fn redis_value_to_string(value: redis::Value) -> String {
    match value {
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
        redis::Value::SimpleString(s) => s,
        redis::Value::Int(n) => n.to_string(),
        _ => format!("{:?}", value),
    }
}

fn json_opt<T: Into<Value>>(v: Option<T>) -> Value {
    match v {
        Some(value) => value.into(),
        None => Value::Null,
    }
}

fn is_write_command(name: &str) -> bool {
    matches!(
        name,
        "SET"
            | "SETEX"
            | "SETNX"
            | "MSET"
            | "HSET"
            | "HMSET"
            | "LPUSH"
            | "RPUSH"
            | "SADD"
            | "ZADD"
            | "DEL"
            | "HDEL"
            | "LDEL"
            | "SDEL"
            | "ZREM"
            | "EXPIRE"
            | "PEXPIRE"
            | "RENAME"
            | "FLUSHDB"
            | "FLUSHALL"
    )
}
