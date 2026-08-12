//! Redis 运维扩展：INFO / Memory / Stream / ACL 等结构化 API。

use omnipanel_error::{OmniError, OmniResult};
use redis::aio::MultiplexedConnection;
use serde::Serialize;
use serde_json::Value;

use crate::QueryResult;

const STREAM_RANGE_DEFAULT: usize = 50;
const STREAM_RANGE_MAX: usize = 200;

/// `INFO` 解析结果：section -> key -> value（均为字符串）。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisInfoResult {
    pub sections: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

/// Stream 消费组摘要。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamGroup {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub consumers: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub pending: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub lag: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub entries_read: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_delivered_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub behind_seconds: Option<i64>,
}

/// Stream 消费者。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamConsumer {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub pending: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub idle_ms: Option<u64>,
    pub active: bool,
}

/// XPENDING 明细行。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamPendingEntry {
    pub id: String,
    pub consumer: String,
    #[specta(type = f64)]
    pub idle_ms: u64,
    #[specta(type = f64)]
    pub delivery_count: u64,
}

/// Stream 监控快照（对齐运维脚本指标）。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamMonitorSnapshot {
    pub key: String,
    pub newest_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub newest_ts_ms: Option<i64>,
    pub groups: Vec<RedisStreamGroup>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub consumers: Vec<RedisStreamConsumer>,
    #[specta(type = f64)]
    pub sampled_at: u64,
}

/// Stream 条目。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamEntry {
    pub id: String,
    pub fields: std::collections::HashMap<String, String>,
}

/// Stream 范围查询结果。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisStreamRangeResult {
    pub entries: Vec<RedisStreamEntry>,
    pub reverse: bool,
}

/// `MEMORY STATS` 键值对。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisMemoryStats {
    pub entries: std::collections::HashMap<String, String>,
}

/// ACL 用户行。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisAclUser {
    pub username: String,
    pub flags: String,
    pub commands: String,
    pub keys: String,
    pub channels: String,
    pub raw: String,
}

pub async fn info(
    conn: &mut MultiplexedConnection,
    section: Option<&str>,
) -> OmniResult<RedisInfoResult> {
    let mut cmd = redis::cmd("INFO");
    if let Some(sec) = section.filter(|s| !s.trim().is_empty()) {
        cmd.arg(sec);
    }
    let text: String = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(RedisInfoResult {
        sections: parse_info_sections(&text),
    })
}

pub async fn memory_stats(conn: &mut MultiplexedConnection) -> OmniResult<RedisMemoryStats> {
    let value: redis::Value = redis::cmd("MEMORY")
        .arg("STATS")
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(RedisMemoryStats {
        entries: redis_value_to_flat_map(value),
    })
}

pub async fn memory_doctor(conn: &mut MultiplexedConnection) -> OmniResult<String> {
    let text: String = redis::cmd("MEMORY")
        .arg("DOCTOR")
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(text)
}

pub async fn memory_purge(conn: &mut MultiplexedConnection) -> OmniResult<u64> {
    let n: u64 = redis::cmd("MEMORY")
        .arg("PURGE")
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(n)
}

pub async fn config_set(
    conn: &mut MultiplexedConnection,
    parameter: &str,
    value: &str,
) -> OmniResult<()> {
    let _: () = redis::cmd("CONFIG")
        .arg("SET")
        .arg(parameter)
        .arg(value)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(())
}

pub async fn config_rewrite(conn: &mut MultiplexedConnection) -> OmniResult<()> {
    let _: () = redis::cmd("CONFIG")
        .arg("REWRITE")
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(())
}

pub async fn flush_db(conn: &mut MultiplexedConnection, r#async: bool) -> OmniResult<()> {
    let mut cmd = redis::cmd("FLUSHDB");
    if r#async {
        cmd.arg("ASYNC");
    }
    let _: () = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(())
}

pub async fn flush_all(conn: &mut MultiplexedConnection, r#async: bool) -> OmniResult<()> {
    let mut cmd = redis::cmd("FLUSHALL");
    if r#async {
        cmd.arg("ASYNC");
    }
    let _: () = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(())
}

pub async fn stream_range(
    conn: &mut MultiplexedConnection,
    key: &str,
    start: Option<&str>,
    end: Option<&str>,
    count: Option<usize>,
    reverse: bool,
) -> OmniResult<RedisStreamRangeResult> {
    let count = count.unwrap_or(STREAM_RANGE_DEFAULT).clamp(1, STREAM_RANGE_MAX);
    let mut cmd = if reverse {
        redis::cmd("XREVRANGE")
    } else {
        redis::cmd("XRANGE")
    };
    cmd.arg(key)
        .arg(start.unwrap_or(if reverse { "+" } else { "-" }))
        .arg(end.unwrap_or(if reverse { "-" } else { "+" }))
        .arg("COUNT")
        .arg(count);
    let value: redis::Value = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(RedisStreamRangeResult {
        entries: parse_stream_entries(value),
        reverse,
    })
}

pub async fn stream_groups(
    conn: &mut MultiplexedConnection,
    key: &str,
) -> OmniResult<Vec<RedisStreamGroup>> {
    let newest_id = newest_stream_id(conn, key).await.ok();
    let value: redis::Value = redis::cmd("XINFO")
        .arg("GROUPS")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    let mut groups = parse_stream_groups(value);
    for group in &mut groups {
        if let (Some(ld), Some(nid)) = (&group.last_delivered_id, &newest_id) {
            group.behind_seconds = stream_id_behind_seconds(ld, nid);
        }
    }
    Ok(groups)
}

pub async fn stream_consumers(
    conn: &mut MultiplexedConnection,
    key: &str,
    group: &str,
) -> OmniResult<Vec<RedisStreamConsumer>> {
    let value: redis::Value = redis::cmd("XINFO")
        .arg("CONSUMERS")
        .arg(key)
        .arg(group)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(parse_stream_consumers(value))
}

pub async fn stream_pending(
    conn: &mut MultiplexedConnection,
    key: &str,
    group: &str,
    start: Option<&str>,
    end: Option<&str>,
    count: Option<usize>,
) -> OmniResult<Vec<RedisStreamPendingEntry>> {
    let count = count.unwrap_or(50).clamp(1, 200);
    let mut cmd = redis::cmd("XPENDING");
    cmd.arg(key).arg(group);
    if start.is_some() || end.is_some() {
        cmd.arg(start.unwrap_or("-"))
            .arg(end.unwrap_or("+"))
            .arg(count);
    } else {
        cmd.arg("-").arg("+").arg(count);
    }
    let value: redis::Value = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(parse_stream_pending(value))
}

pub async fn stream_monitor(
    conn: &mut MultiplexedConnection,
    key: &str,
    group: Option<&str>,
) -> OmniResult<RedisStreamMonitorSnapshot> {
    let newest_id = newest_stream_id(conn, key).await.ok();
    let newest_ts_ms = newest_id.as_ref().map(|id| stream_id_to_ts_ms(id)).flatten();
    let mut groups = stream_groups(conn, key).await.unwrap_or_default();
    let consumers = if let Some(g) = group.filter(|s| !s.trim().is_empty()) {
        stream_consumers(conn, key, g).await.unwrap_or_default()
    } else if groups.len() == 1 {
        stream_consumers(conn, key, &groups[0].name)
            .await
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    if let Some(g) = group.filter(|s| !s.trim().is_empty()) {
        groups.retain(|item| item.name == g);
    }
    Ok(RedisStreamMonitorSnapshot {
        key: key.to_string(),
        newest_id,
        newest_ts_ms,
        groups,
        consumers,
        sampled_at: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
    })
}

pub async fn stream_ack(
    conn: &mut MultiplexedConnection,
    key: &str,
    group: &str,
    ids: &[String],
) -> OmniResult<u64> {
    if ids.is_empty() {
        return Err(OmniError::invalid_input("XACK ids 为空"));
    }
    let mut cmd = redis::cmd("XACK");
    cmd.arg(key).arg(group);
    for id in ids {
        cmd.arg(id);
    }
    let n: u64 = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(n)
}

pub async fn stream_claim(
    conn: &mut MultiplexedConnection,
    key: &str,
    group: &str,
    consumer: &str,
    min_idle_ms: u64,
    start_id: &str,
    count: Option<u64>,
) -> OmniResult<u64> {
    let count = count.unwrap_or(10).clamp(1, 100);
    let value: redis::Value = redis::cmd("XAUTOCLAIM")
        .arg(key)
        .arg(group)
        .arg(consumer)
        .arg(min_idle_ms)
        .arg(start_id)
        .arg("COUNT")
        .arg(count)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(parse_autoclaim_count(value))
}

pub async fn stream_group_create(
    conn: &mut MultiplexedConnection,
    key: &str,
    group: &str,
    id: &str,
    mkstream: bool,
) -> OmniResult<()> {
    let mut cmd = redis::cmd("XGROUP");
    cmd.arg("CREATE").arg(key).arg(group).arg(id);
    if mkstream {
        cmd.arg("MKSTREAM");
    }
    let _: () = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(())
}

pub async fn stream_group_destroy(
    conn: &mut MultiplexedConnection,
    key: &str,
    group: &str,
) -> OmniResult<()> {
    let _: () = redis::cmd("XGROUP")
        .arg("DESTROY")
        .arg(key)
        .arg(group)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(())
}

pub async fn stream_trim(
    conn: &mut MultiplexedConnection,
    key: &str,
    maxlen: u64,
    approximate: bool,
) -> OmniResult<u64> {
    let mut cmd = redis::cmd("XTRIM");
    cmd.arg(key).arg("MAXLEN");
    if approximate {
        cmd.arg("~");
    }
    cmd.arg(maxlen);
    let n: u64 = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(n)
}

pub async fn acl_list(conn: &mut MultiplexedConnection) -> OmniResult<Vec<RedisAclUser>> {
    let value: redis::Value = redis::cmd("ACL")
        .arg("LIST")
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(parse_acl_list(value))
}

pub async fn acl_getuser(
    conn: &mut MultiplexedConnection,
    username: &str,
) -> OmniResult<RedisAclUser> {
    let value: redis::Value = redis::cmd("ACL")
        .arg("GETUSER")
        .arg(username)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    parse_acl_getuser(username, value)
}

pub async fn acl_setuser(
    conn: &mut MultiplexedConnection,
    username: &str,
    rule: &str,
) -> OmniResult<()> {
    let _: () = redis::cmd("ACL")
        .arg("SETUSER")
        .arg(username)
        .arg(rule)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(())
}

pub async fn acl_deluser(
    conn: &mut MultiplexedConnection,
    username: &str,
) -> OmniResult<u64> {
    let n: u64 = redis::cmd("ACL")
        .arg("DELUSER")
        .arg(username)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(n)
}

// --- hash / list / set / zset mutations ---

pub async fn hash_set_field(
    conn: &mut MultiplexedConnection,
    key: &str,
    field: &str,
    value: &str,
) -> OmniResult<()> {
    let _: () = redis::cmd("HSET")
        .arg(key)
        .arg(field)
        .arg(value)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(())
}

pub async fn hash_del_fields(
    conn: &mut MultiplexedConnection,
    key: &str,
    fields: &[String],
) -> OmniResult<u64> {
    if fields.is_empty() {
        return Ok(0);
    }
    let mut cmd = redis::cmd("HDEL");
    cmd.arg(key);
    for field in fields {
        cmd.arg(field);
    }
    let n: u64 = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(n)
}

pub async fn list_push(
    conn: &mut MultiplexedConnection,
    key: &str,
    side: &str,
    values: &[String],
) -> OmniResult<u64> {
    if values.is_empty() {
        return Err(OmniError::invalid_input("列表值为空"));
    }
    let cmd_name = if side.eq_ignore_ascii_case("right") {
        "RPUSH"
    } else {
        "LPUSH"
    };
    let mut cmd = redis::cmd(cmd_name);
    cmd.arg(key);
    for value in values {
        cmd.arg(value);
    }
    let n: u64 = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(n)
}

pub async fn list_remove(
    conn: &mut MultiplexedConnection,
    key: &str,
    count: i64,
    value: &str,
) -> OmniResult<u64> {
    let n: u64 = redis::cmd("LREM")
        .arg(key)
        .arg(count)
        .arg(value)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(n)
}

pub async fn set_add(conn: &mut MultiplexedConnection, key: &str, members: &[String]) -> OmniResult<u64> {
    if members.is_empty() {
        return Ok(0);
    }
    let mut cmd = redis::cmd("SADD");
    cmd.arg(key);
    for member in members {
        cmd.arg(member);
    }
    let n: u64 = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(n)
}

pub async fn set_remove(
    conn: &mut MultiplexedConnection,
    key: &str,
    members: &[String],
) -> OmniResult<u64> {
    if members.is_empty() {
        return Ok(0);
    }
    let mut cmd = redis::cmd("SREM");
    cmd.arg(key);
    for member in members {
        cmd.arg(member);
    }
    let n: u64 = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(n)
}

pub async fn zset_add(
    conn: &mut MultiplexedConnection,
    key: &str,
    member: &str,
    score: f64,
) -> OmniResult<u64> {
    let n: u64 = redis::cmd("ZADD")
        .arg(key)
        .arg(score)
        .arg(member)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(n)
}

pub async fn zset_remove(
    conn: &mut MultiplexedConnection,
    key: &str,
    members: &[String],
) -> OmniResult<u64> {
    if members.is_empty() {
        return Ok(0);
    }
    let mut cmd = redis::cmd("ZREM");
    cmd.arg(key);
    for member in members {
        cmd.arg(member);
    }
    let n: u64 = cmd.query_async(conn).await.map_err(map_redis_err)?;
    Ok(n)
}

pub async fn expire_key(
    conn: &mut MultiplexedConnection,
    key: &str,
    seconds: i64,
) -> OmniResult<bool> {
    let ok: bool = redis::cmd("EXPIRE")
        .arg(key)
        .arg(seconds)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(ok)
}

// --- parsers ---

fn map_redis_err(err: redis::RedisError) -> OmniError {
    OmniError::database("Redis 操作失败").with_cause(err.to_string())
}

pub fn parse_info_sections(text: &str) -> std::collections::HashMap<String, std::collections::HashMap<String, String>> {
    let mut sections: std::collections::HashMap<String, std::collections::HashMap<String, String>> =
        std::collections::HashMap::new();
    let mut current = "default".to_string();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            if let Some(name) = line.strip_prefix("# ") {
                current = name.trim().to_string();
                sections.entry(current.clone()).or_default();
            }
            continue;
        }
        if let Some((key, value)) = line.split_once(':') {
            sections
                .entry(current.clone())
                .or_default()
                .insert(key.trim().to_string(), value.trim().to_string());
        }
    }
    sections
}

fn redis_value_to_string(value: &redis::Value) -> String {
    match value {
        redis::Value::Nil => String::new(),
        redis::Value::Int(n) => n.to_string(),
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).into_owned(),
        redis::Value::SimpleString(s) => s.clone(),
        redis::Value::Okay => "OK".to_string(),
        redis::Value::Double(f) => f.to_string(),
        redis::Value::Boolean(b) => b.to_string(),
        other => format!("{other:?}"),
    }
}

fn redis_value_to_string_owned(value: redis::Value) -> String {
    redis_value_to_string(&value)
}

fn redis_value_to_flat_map(value: redis::Value) -> std::collections::HashMap<String, String> {
    match value {
        redis::Value::Map(map) => map
            .into_iter()
            .map(|(k, v)| {
                (
                    redis_value_to_string_owned(k),
                    redis_value_to_string_owned(v),
                )
            })
            .collect(),
        redis::Value::Array(items) => {
            let strings: Vec<String> = items
                .into_iter()
                .map(redis_value_to_string_owned)
                .collect();
            let mut out = std::collections::HashMap::new();
            let mut i = 0;
            while i + 1 < strings.len() {
                out.insert(strings[i].clone(), strings[i + 1].clone());
                i += 2;
            }
            out
        }
        other => {
            let mut out = std::collections::HashMap::new();
            out.insert("raw".to_string(), format!("{other:?}"));
            out
        }
    }
}

fn parse_stream_map(item: redis::Value) -> std::collections::HashMap<String, String> {
    match item {
        redis::Value::Map(map) => map
            .into_iter()
            .map(|(k, v)| (redis_value_to_string_owned(k), redis_value_to_string_owned(v)))
            .collect(),
        redis::Value::Array(items) => {
            let strings: Vec<String> = items.into_iter().map(redis_value_to_string_owned).collect();
            let mut out = std::collections::HashMap::new();
            let mut i = 0;
            while i + 1 < strings.len() {
                out.insert(strings[i].clone(), strings[i + 1].clone());
                i += 2;
            }
            out
        }
        _ => std::collections::HashMap::new(),
    }
}

fn parse_stream_groups(value: redis::Value) -> Vec<RedisStreamGroup> {
    match value {
        redis::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| {
                let map = parse_stream_map(item);
                if map.is_empty() {
                    return None;
                }
                Some(RedisStreamGroup {
                    name: map
                        .get("name")
                        .cloned()
                        .unwrap_or_default(),
                    consumers: map.get("consumers").and_then(|v| v.parse().ok()),
                    pending: map.get("pending").and_then(|v| v.parse().ok()),
                    lag: map.get("lag").and_then(|v| v.parse().ok()),
                    entries_read: map
                        .get("entries-read")
                        .or_else(|| map.get("entries_read"))
                        .and_then(|v| v.parse().ok()),
                    last_delivered_id: map
                        .get("last-delivered-id")
                        .or_else(|| map.get("last_delivered_id"))
                        .cloned(),
                    behind_seconds: None,
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_consumers(value: redis::Value) -> Vec<RedisStreamConsumer> {
    match value {
        redis::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| {
                let map = parse_stream_map(item);
                if map.is_empty() {
                    return None;
                }
                let idle_ms = map.get("idle").and_then(|v| v.parse().ok());
                Some(RedisStreamConsumer {
                    name: map.get("name").cloned().unwrap_or_default(),
                    pending: map.get("pending").and_then(|v| v.parse().ok()),
                    idle_ms,
                    active: idle_ms.map(|v| v < 60_000).unwrap_or(false),
                })
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_pending(value: redis::Value) -> Vec<RedisStreamPendingEntry> {
    match value {
        redis::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                redis::Value::Array(parts) if parts.len() >= 4 => Some(RedisStreamPendingEntry {
                    id: redis_value_to_string(&parts[0]),
                    consumer: redis_value_to_string(&parts[1]),
                    idle_ms: redis_value_to_string(&parts[2]).parse().unwrap_or(0),
                    delivery_count: redis_value_to_string(&parts[3]).parse().unwrap_or(0),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_entries(value: redis::Value) -> Vec<RedisStreamEntry> {
    match value {
        redis::Value::Array(items) => items
            .into_iter()
            .filter_map(|item| match item {
                redis::Value::Array(parts) if parts.len() >= 2 => Some(RedisStreamEntry {
                    id: redis_value_to_string(&parts[0]),
                    fields: parse_stream_fields(&parts[1]),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_stream_fields(value: &redis::Value) -> std::collections::HashMap<String, String> {
    match value {
        redis::Value::Array(items) => {
            let strings: Vec<String> = items.iter().map(redis_value_to_string).collect();
            let mut out = std::collections::HashMap::new();
            let mut i = 0;
            while i + 1 < strings.len() {
                out.insert(strings[i].clone(), strings[i + 1].clone());
                i += 2;
            }
            out
        }
        redis::Value::Map(map) => map
            .iter()
            .map(|(k, v)| (redis_value_to_string(k), redis_value_to_string(v)))
            .collect(),
        _ => std::collections::HashMap::new(),
    }
}

async fn newest_stream_id(conn: &mut MultiplexedConnection, key: &str) -> OmniResult<String> {
    let value: redis::Value = redis::cmd("XREVRANGE")
        .arg(key)
        .arg("+")
        .arg("-")
        .arg("COUNT")
        .arg(1)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    let entries = parse_stream_entries(value);
    entries
        .first()
        .map(|e| e.id.clone())
        .ok_or_else(|| OmniError::not_found("Stream 为空"))
}

pub fn stream_id_to_ts_ms(id: &str) -> Option<i64> {
    id.split('-').next()?.parse().ok()
}

pub fn stream_id_behind_seconds(last_id: &str, newest_id: &str) -> Option<i64> {
    let last_ts = stream_id_to_ts_ms(last_id)?;
    let newest_ts = stream_id_to_ts_ms(newest_id)?;
    Some((newest_ts - last_ts) / 1000)
}

fn parse_autoclaim_count(value: redis::Value) -> u64 {
    match value {
        redis::Value::Array(items) if items.len() >= 2 => match &items[1] {
            redis::Value::Array(claimed) => claimed.len() as u64,
            _ => 0,
        },
        _ => 0,
    }
}

fn parse_acl_list(value: redis::Value) -> Vec<RedisAclUser> {
    match value {
        redis::Value::Array(items) => items
            .into_iter()
            .map(|item| parse_acl_line(&redis_value_to_string_owned(item)))
            .collect(),
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(&bytes)
            .lines()
            .map(parse_acl_line)
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_acl_line(raw: &str) -> RedisAclUser {
    let mut username = String::new();
    let mut flags = Vec::new();
    let mut commands = String::new();
    let mut keys = String::new();
    let mut channels = String::new();
    for part in raw.split_whitespace() {
        if let Some(name) = part.strip_prefix("user ") {
            username = name.to_string();
        } else if let Some(flag) = part.strip_prefix("flags=") {
            flags.push(flag.to_string());
        } else if let Some(cmd) = part.strip_prefix("commands=") {
            commands = cmd.to_string();
        } else if let Some(k) = part.strip_prefix("keys=") {
            keys = k.to_string();
        } else if let Some(ch) = part.strip_prefix("channels=") {
            channels = ch.to_string();
        }
    }
    RedisAclUser {
        username,
        flags: flags.join(","),
        commands,
        keys,
        channels,
        raw: raw.to_string(),
    }
}

fn map_get_string(map: &[(redis::Value, redis::Value)], key: &str) -> String {
    map.iter()
        .find(|(k, _)| redis_value_to_string(k) == key)
        .map(|(_, v)| redis_value_to_string(v))
        .unwrap_or_default()
}

fn parse_acl_getuser(username: &str, value: redis::Value) -> OmniResult<RedisAclUser> {
    match value {
        redis::Value::Nil => Err(OmniError::not_found(format!("ACL 用户不存在：{username}"))),
        redis::Value::Map(map) => {
            let flags = map_get_string(&map, "flags");
            let commands = map_get_string(&map, "commands");
            let keys = map_get_string(&map, "keys");
            let channels = map_get_string(&map, "channels");
            let raw = format!("{map:?}");
            Ok(RedisAclUser {
                username: username.to_string(),
                flags,
                commands,
                keys,
                channels,
                raw,
            })
        }
        other => Ok(parse_acl_line(&redis_value_to_string_owned(other))),
    }
}

#[allow(dead_code)]
pub fn info_to_query_result(info: &RedisInfoResult, section: &str) -> QueryResult {
    let rows = info
        .sections
        .get(section)
        .map(|map| {
            map.iter()
                .map(|(k, v)| vec![Value::String(k.clone()), Value::String(v.clone())])
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    QueryResult {
        columns: vec!["key".to_string(), "value".to_string()],
        rows,
        rows_affected: 0,
    }
}
