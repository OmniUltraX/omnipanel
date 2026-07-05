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

/// 分页 SCAN 搜索结果。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedisSearchKeysResult {
    pub entries: Vec<RedisKeyEntry>,
    /// 下次请求传入的 SCAN 游标；0 表示当前模式已扫完。
    pub next_cursor: u64,
    pub has_more: bool,
    /// 单次请求扫描的 key 数量达到上限，需缩小模式或继续加载。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub scan_limit_hit: bool,
}

const DEFAULT_REDIS_PORT: u16 = 6379;
const SCAN_BATCH_COUNT: u64 = 500;
const TYPE_BATCH_SIZE: usize = 64;
/// 单次请求最多从 SCAN 见到的 key 数（含被类型过滤掉的）。
const MAX_SCAN_VISITS_PER_REQUEST: usize = 8_000;
/// 单次请求最多执行的 SCAN 轮次，避免无匹配时在整库上长时间阻塞。
const MAX_SCAN_ROUNDS_PER_REQUEST: usize = 64;

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

    /// 使用 SCAN 按模式搜索键，并按类型过滤；值预览可选。
    pub async fn search_keys(
        &self,
        pattern: &str,
        types: &[String],
        limit: usize,
        cursor: u64,
        include_value_preview: bool,
    ) -> OmniResult<RedisSearchKeysResult> {
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
        let mut scan_cursor = cursor;
        let mut entries = Vec::new();
        let mut scanned = 0usize;
        let mut scan_rounds = 0usize;
        let mut scan_limit_hit = false;

        loop {
            scan_rounds += 1;
            if scan_rounds > MAX_SCAN_ROUNDS_PER_REQUEST {
                scan_limit_hit = true;
                return Ok(RedisSearchKeysResult {
                    entries,
                    next_cursor: scan_cursor,
                    has_more: true,
                    scan_limit_hit,
                });
            }

            let (next, keys): (u64, Vec<redis::Value>) = redis::cmd("SCAN")
                .arg(scan_cursor)
                .arg("MATCH")
                .arg(pattern)
                .arg("COUNT")
                .arg(SCAN_BATCH_COUNT)
                .query_async(&mut conn)
                .await
                .map_err(map_redis_err)?;

            let key_names: Vec<String> = keys.into_iter().map(redis_value_to_string).collect();
            scanned += key_names.len();

            for chunk in key_names.chunks(TYPE_BATCH_SIZE) {
                let types_batch = batch_key_types(&mut conn, chunk).await?;
                for (key, key_type) in chunk.iter().zip(types_batch.iter()) {
                    if filter_types && !type_filter.contains(key_type) {
                        continue;
                    }
                    let value = if include_value_preview {
                        preview_redis_value(&mut conn, key, key_type).await?
                    } else {
                        String::new()
                    };
                    entries.push(RedisKeyEntry {
                        key: key.clone(),
                        key_type: key_type.clone(),
                        value,
                    });
                    if entries.len() >= limit {
                        return Ok(RedisSearchKeysResult {
                            entries,
                            next_cursor: if next == 0 { 0 } else { next },
                            has_more: next != 0 || scan_limit_hit,
                            scan_limit_hit,
                        });
                    }
                }
            }

            scan_cursor = next;
            if scan_cursor == 0 {
                return Ok(RedisSearchKeysResult {
                    entries,
                    next_cursor: 0,
                    has_more: false,
                    scan_limit_hit,
                });
            }
            if scanned >= MAX_SCAN_VISITS_PER_REQUEST {
                scan_limit_hit = true;
                return Ok(RedisSearchKeysResult {
                    entries,
                    next_cursor: scan_cursor,
                    has_more: true,
                    scan_limit_hit,
                });
            }
        }
    }
}

async fn batch_key_types(
    conn: &mut MultiplexedConnection,
    keys: &[String],
) -> OmniResult<Vec<String>> {
    if keys.is_empty() {
        return Ok(Vec::new());
    }
    let mut pipe = redis::pipe();
    for key in keys {
        pipe.cmd("TYPE").arg(key);
    }
    let values: Vec<redis::Value> = pipe.query_async(conn).await.map_err(map_redis_err)?;
    Ok(values.into_iter().map(redis_value_to_string).collect())
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
        let keys: Vec<redis::Value> = redis::cmd("KEYS")
            .arg("*")
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        Ok(keys.into_iter().map(redis_value_to_string).collect())
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
        _where_clause: Option<&str>,
    ) -> OmniResult<QueryResult> {
        let mut conn = self.conn.clone();
        let key_type: String = redis::cmd("TYPE")
            .arg(table)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;

        match key_type.as_str() {
            "string" => {
                let value: Option<Vec<u8>> = conn.get(table).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["key".to_string(), "value".to_string()],
                    rows: vec![vec![
                        Value::String(table.to_string()),
                        json_opt(value.map(|b| bytes_to_display(&b))),
                    ]],
                    rows_affected: 0,
                })
            }
            "list" => {
                let stop = (limit.max(1) - 1).try_into().unwrap_or(isize::MAX);
                let values: Vec<Vec<u8>> =
                    conn.lrange(table, 0, stop).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["index".to_string(), "value".to_string()],
                    rows: values
                        .into_iter()
                        .enumerate()
                        .map(|(i, v)| vec![Value::Number(i.into()), Value::String(bytes_to_display(&v))])
                        .collect(),
                    rows_affected: 0,
                })
            }
            "set" => {
                let values: Vec<Vec<u8>> = conn.smembers(table).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["member".to_string()],
                    rows: values
                        .into_iter()
                        .map(|v| vec![Value::String(bytes_to_display(&v))])
                        .collect(),
                    rows_affected: 0,
                })
            }
            "zset" => {
                let values: Vec<(Vec<u8>, f64)> = conn
                    .zrange_withscores(table, 0isize, (limit.max(0) - 1) as isize)
                    .await
                    .map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["member".to_string(), "score".to_string()],
                    rows: values
                        .into_iter()
                        .map(|(m, s)| vec![Value::String(bytes_to_display(&m)), serde_json::json!(s)])
                        .collect(),
                    rows_affected: 0,
                })
            }
            "hash" => {
                let fields: std::collections::HashMap<Vec<u8>, Vec<u8>> =
                    conn.hgetall(table).await.map_err(map_redis_err)?;
                Ok(QueryResult {
                    columns: vec!["field".to_string(), "value".to_string()],
                    rows: fields
                        .into_iter()
                        .map(|(k, v)| {
                            vec![
                                Value::String(bytes_to_display(&k)),
                                Value::String(bytes_to_display(&v)),
                            ]
                        })
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

    async fn count(&self, table: &str, _where_clause: Option<&str>) -> OmniResult<i64> {
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
            let v: Option<Vec<u8>> = conn.get(key).await.map_err(map_redis_err)?;
            Ok(truncate_display(
                v.map(|b| bytes_to_display(&b)).unwrap_or_default(),
                MAX,
            ))
        }
        "list" => {
            let len: i64 = conn.llen(key).await.map_err(map_redis_err)?;
            let values: Vec<Vec<u8>> = conn.lrange(key, 0, 2).await.map_err(map_redis_err)?;
            let preview = values
                .iter()
                .map(|b| bytes_to_display(b))
                .collect::<Vec<_>>()
                .join(", ");
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
            let field_names: Vec<Vec<u8>> = conn.hkeys(key).await.map_err(map_redis_err)?;
            if field_names.is_empty() {
                return Ok(format!("[hash len={len}]"));
            }
            let preview_fields: Vec<Vec<u8>> = field_names.into_iter().take(2).collect();
            let mut preview_parts = Vec::new();
            for field in &preview_fields {
                if let Some(value) = conn.hget::<_, _, Option<Vec<u8>>>(key, field).await.map_err(map_redis_err)? {
                    preview_parts.push(format!(
                        "{}={}",
                        bytes_to_display(field),
                        truncate_display(bytes_to_display(&value), 40),
                    ));
                }
            }
            let preview = preview_parts.join(", ");
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

fn bytes_to_display(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
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
