use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use redis::{AsyncCommands, Client, aio::MultiplexedConnection};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::redis_ops::{
    self, RedisAclUser, RedisInfoResult, RedisMemoryStats, RedisStreamConsumer, RedisStreamGroup,
    RedisStreamMonitorSnapshot, RedisStreamPendingEntry, RedisStreamRangeResult,
};
use crate::{DbDriver, DbParams, QueryResult};

/// Redis 键搜索结果（供查询面板展示）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyEntry {
    pub key: String,
    pub key_type: String,
    pub value: String,
}

/// 分页 SCAN 搜索结果。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisSearchKeysResult {
    pub entries: Vec<RedisKeyEntry>,
    /// 下次请求传入的 SCAN 游标；0 表示当前模式已扫完。
    #[specta(type = f64)]
    pub next_cursor: u64,
    pub has_more: bool,
    /// 单次请求扫描的 key 数量达到上限，需缩小模式或继续加载。
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub scan_limit_hit: bool,
}

/// 逻辑库名 + key 条数（`INFO keyspace`）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisDatabaseInfo {
    pub name: String,
    #[specta(type = f64)]
    pub key_count: u64,
}

/// 单个 key 的详情（类型 / TTL / 大小 / 值预览）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisKeyDetail {
    pub key: String,
    pub key_type: String,
    /// TTL 秒；-1 永不过期；-2 key 不存在。
    #[specta(type = f64)]
    pub ttl: i64,
    /// 字节大小（MEMORY USAGE）；不可用时为 None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub size_bytes: Option<u64>,
    /// JSON 字符串：string 为引号字符串；hash/list/set/zset 为对象数组。
    pub value_json: String,
    pub value_truncated: bool,
}

/// 慢日志条目。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct RedisSlowLogEntry {
    #[specta(type = f64)]
    pub id: u64,
    #[specta(type = f64)]
    pub timestamp: u64,
    #[specta(type = f64)]
    pub duration_us: u64,
    pub command: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_addr: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub client_name: Option<String>,
}

const DEFAULT_REDIS_PORT: u16 = 6379;
const DEFAULT_DATABASE_COUNT: u64 = 16;
const MAX_DATABASE_COUNT: u64 = 256;
const SCAN_BATCH_COUNT: u64 = 500;
const TYPE_BATCH_SIZE: usize = 64;
/// 单次请求最多从 SCAN 见到的 key 数（含被类型过滤掉的）。
const MAX_SCAN_VISITS_PER_REQUEST: usize = 8_000;
/// 单次请求最多执行的 SCAN 轮次，避免无匹配时在整库上长时间阻塞。
const MAX_SCAN_ROUNDS_PER_REQUEST: usize = 64;
const KEY_DETAIL_PREVIEW_LIMIT: usize = 200;
/// 建连瞬断（如 Multiplexed driver terminated）时的重试次数。
const CONNECT_RETRY_ATTEMPTS: u32 = 3;
const CONNECT_RETRY_BASE_DELAY_MS: u64 = 80;

pub struct RedisDriver {
    conn: MultiplexedConnection,
}

#[cfg_attr(not(feature = "sidecar-serve"), allow(dead_code))]
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
            .and_then(|n| {
                if (0..=MAX_DATABASE_COUNT as i64).contains(&n) {
                    Some(n)
                } else {
                    None
                }
            })
            .unwrap_or(0);

        let url = redis_connection_url(params, port, db);

        let client = Client::open(url)
            .map_err(|e| OmniError::connection("Redis 连接参数无效").with_cause(e.to_string()))?;

        let mut last_err: Option<redis::RedisError> = None;
        for attempt in 0..CONNECT_RETRY_ATTEMPTS {
            match client.get_multiplexed_tokio_connection().await {
                Ok(conn) => return Ok(Self { conn }),
                Err(e) => {
                    let transient = is_transient_redis_connect_error(&e);
                    last_err = Some(e);
                    if transient && attempt + 1 < CONNECT_RETRY_ATTEMPTS {
                        let delay_ms = CONNECT_RETRY_BASE_DELAY_MS * u64::from(attempt + 1);
                        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                        continue;
                    }
                    break;
                }
            }
        }

        let cause = last_err
            .map(|e| e.to_string())
            .unwrap_or_else(|| "unknown".to_string());
        Err(OmniError::connection("Redis 连接失败").with_cause(cause))
    }

    /// 执行 `CONFIG GET`，返回参数名与值的键值对列表。
    pub async fn config_get(&self, pattern: &str) -> OmniResult<Vec<(String, String)>> {
        let mut conn = self.conn.clone();
        let value: redis::Value = redis::cmd("CONFIG")
            .arg("GET")
            .arg(pattern)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        parse_config_get_response(value)
    }

    /// `CONFIG GET *` 结果格式化为两列表格。
    pub async fn config_get_all(&self) -> OmniResult<QueryResult> {
        let pairs = self.config_get("*").await?;
        Ok(QueryResult {
            columns: vec!["parameter".to_string(), "value".to_string()],
            rows: pairs
                .into_iter()
                .map(|(name, value)| vec![Value::String(name), Value::String(value)])
                .collect(),
            rows_affected: 0,
        })
    }

    /// `CLIENT LIST`：解析为列式表格（每行一个客户端连接）。
    pub async fn client_list(&self) -> OmniResult<QueryResult> {
        let mut conn = self.conn.clone();
        let value: redis::Value = redis::cmd("CLIENT")
            .arg("LIST")
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        parse_client_list_response(value)
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
            if trimmed.is_empty() { "*" } else { trimmed }
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

    /// 逻辑库名列表：`CONFIG GET databases`，失败回退 16；连接已指定 database 时只返回该库。
    pub async fn list_databases(&self, preset_database: &str) -> OmniResult<Vec<String>> {
        let preset = preset_database.trim();
        if !preset.is_empty() {
            return Ok(vec![preset.to_string()]);
        }
        let count = self
            .database_count()
            .await
            .unwrap_or(DEFAULT_DATABASE_COUNT);
        Ok((0..count).map(|n| n.to_string()).collect())
    }

    /// 库列表 + key 条数（`INFO keyspace`）。
    pub async fn list_databases_with_key_counts(
        &self,
        preset_database: &str,
    ) -> OmniResult<Vec<RedisDatabaseInfo>> {
        let names = self.list_databases(preset_database).await?;
        let counts = self.keyspace_counts().await.unwrap_or_default();
        Ok(names
            .into_iter()
            .map(|name| {
                let key_count = name
                    .parse::<u64>()
                    .ok()
                    .and_then(|idx| counts.get(&idx).copied())
                    .unwrap_or(0);
                RedisDatabaseInfo { name, key_count }
            })
            .collect())
    }

    async fn database_count(&self) -> OmniResult<u64> {
        let pairs = self.config_get("databases").await?;
        let raw = pairs
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("databases"))
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        let count = raw
            .trim()
            .parse::<u64>()
            .unwrap_or(DEFAULT_DATABASE_COUNT)
            .clamp(1, MAX_DATABASE_COUNT);
        Ok(count)
    }

    async fn keyspace_counts(&self) -> OmniResult<std::collections::HashMap<u64, u64>> {
        let mut conn = self.conn.clone();
        let info: String = redis::cmd("INFO")
            .arg("keyspace")
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        Ok(parse_keyspace_counts(&info))
    }

    /// 当前连接所选逻辑库的 `DBSIZE`。
    pub async fn dbsize(&self) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        let size: u64 = redis::cmd("DBSIZE")
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        Ok(size)
    }

    /// 读取单个 key 的详情。
    pub async fn key_detail(&self, key: &str) -> OmniResult<RedisKeyDetail> {
        let key = key.trim();
        if key.is_empty() {
            return Err(OmniError::invalid_input("Redis key 为空"));
        }
        let mut conn = self.conn.clone();
        let key_type: String = redis::cmd("TYPE")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        if key_type == "none" {
            return Err(OmniError::not_found(format!("Key 不存在：{key}")));
        }
        let ttl: i64 = redis::cmd("TTL")
            .arg(key)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        let size_bytes = memory_usage_bytes(&mut conn, key).await.ok();
        let (value, value_truncated) = read_key_value(&mut conn, key, &key_type).await?;
        Ok(RedisKeyDetail {
            key: key.to_string(),
            key_type,
            ttl,
            size_bytes,
            value_json: value.to_string(),
            value_truncated,
        })
    }

    /// 新建 string key（`SET`）；其它类型用命令行。
    pub async fn set_key(&self, key: &str, value: &str, key_type: &str) -> OmniResult<()> {
        let key = key.trim();
        if key.is_empty() {
            return Err(OmniError::invalid_input("Redis key 为空"));
        }
        let mut conn = self.conn.clone();
        match key_type.trim().to_lowercase().as_str() {
            "" | "string" => {
                let _: () = conn.set(key, value).await.map_err(map_redis_err)?;
            }
            other => {
                return Err(OmniError::invalid_input(format!(
                    "新建仅支持 string，当前类型：{other}"
                )));
            }
        }
        Ok(())
    }

    /// 删除 key。
    pub async fn delete_key(&self, key: &str) -> OmniResult<u64> {
        let key = key.trim();
        if key.is_empty() {
            return Err(OmniError::invalid_input("Redis key 为空"));
        }
        let mut conn = self.conn.clone();
        let deleted: u64 = conn.del(key).await.map_err(map_redis_err)?;
        Ok(deleted)
    }

    /// `SLOWLOG GET`。
    pub async fn slowlog(&self, count: usize) -> OmniResult<Vec<RedisSlowLogEntry>> {
        let count = count.clamp(1, 200);
        let mut conn = self.conn.clone();
        let value: redis::Value = redis::cmd("SLOWLOG")
            .arg("GET")
            .arg(count)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        parse_slowlog_response(value)
    }

    /// `CLIENT KILL ADDR <ip:port>`，返回被杀掉的客户端数量。
    pub async fn client_kill_addr(&self, addr: &str) -> OmniResult<u64> {
        let addr = addr.trim();
        if addr.is_empty() {
            return Err(OmniError::invalid_input("Redis CLIENT KILL ADDR 为空"));
        }
        // 简单格式校验：必须包含 `:`（ip:port）
        if !addr.contains(':') {
            return Err(OmniError::invalid_input(format!(
                "Redis CLIENT KILL ADDR 格式非法（应为 ip:port）：{addr}"
            )));
        }
        let mut conn = self.conn.clone();
        let killed: u64 = redis::cmd("CLIENT")
            .arg("KILL")
            .arg("ADDR")
            .arg(addr)
            .query_async(&mut conn)
            .await
            .map_err(map_redis_err)?;
        Ok(killed)
    }

    pub async fn info(&self, section: Option<&str>) -> OmniResult<RedisInfoResult> {
        let mut conn = self.conn.clone();
        redis_ops::info(&mut conn, section).await
    }

    pub async fn memory_stats(&self) -> OmniResult<RedisMemoryStats> {
        let mut conn = self.conn.clone();
        redis_ops::memory_stats(&mut conn).await
    }

    pub async fn memory_doctor(&self) -> OmniResult<String> {
        let mut conn = self.conn.clone();
        redis_ops::memory_doctor(&mut conn).await
    }

    pub async fn memory_purge(&self) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::memory_purge(&mut conn).await
    }

    pub async fn config_set(&self, parameter: &str, value: &str) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::config_set(&mut conn, parameter, value).await
    }

    pub async fn config_rewrite(&self) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::config_rewrite(&mut conn).await
    }

    pub async fn flush_db(&self, r#async: bool) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::flush_db(&mut conn, r#async).await
    }

    pub async fn flush_all(&self, r#async: bool) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::flush_all(&mut conn, r#async).await
    }

    pub async fn stream_range(
        &self,
        key: &str,
        start: Option<&str>,
        end: Option<&str>,
        count: Option<usize>,
        reverse: bool,
    ) -> OmniResult<RedisStreamRangeResult> {
        let mut conn = self.conn.clone();
        redis_ops::stream_range(&mut conn, key, start, end, count, reverse).await
    }

    pub async fn stream_groups(&self, key: &str) -> OmniResult<Vec<RedisStreamGroup>> {
        let mut conn = self.conn.clone();
        redis_ops::stream_groups(&mut conn, key).await
    }

    pub async fn stream_consumers(
        &self,
        key: &str,
        group: &str,
    ) -> OmniResult<Vec<RedisStreamConsumer>> {
        let mut conn = self.conn.clone();
        redis_ops::stream_consumers(&mut conn, key, group).await
    }

    pub async fn stream_pending(
        &self,
        key: &str,
        group: &str,
        start: Option<&str>,
        end: Option<&str>,
        count: Option<usize>,
    ) -> OmniResult<Vec<RedisStreamPendingEntry>> {
        let mut conn = self.conn.clone();
        redis_ops::stream_pending(&mut conn, key, group, start, end, count).await
    }

    pub async fn stream_monitor(
        &self,
        key: &str,
        group: Option<&str>,
    ) -> OmniResult<RedisStreamMonitorSnapshot> {
        let mut conn = self.conn.clone();
        redis_ops::stream_monitor(&mut conn, key, group).await
    }

    pub async fn stream_ack(&self, key: &str, group: &str, ids: &[String]) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::stream_ack(&mut conn, key, group, ids).await
    }

    pub async fn stream_claim(
        &self,
        key: &str,
        group: &str,
        consumer: &str,
        min_idle_ms: u64,
        start_id: &str,
        count: Option<u64>,
    ) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::stream_claim(
            &mut conn,
            key,
            group,
            consumer,
            min_idle_ms,
            start_id,
            count,
        )
        .await
    }

    pub async fn stream_group_create(
        &self,
        key: &str,
        group: &str,
        id: &str,
        mkstream: bool,
    ) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::stream_group_create(&mut conn, key, group, id, mkstream).await
    }

    pub async fn stream_group_destroy(&self, key: &str, group: &str) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::stream_group_destroy(&mut conn, key, group).await
    }

    pub async fn stream_trim(&self, key: &str, maxlen: u64, approximate: bool) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::stream_trim(&mut conn, key, maxlen, approximate).await
    }

    pub async fn stream_cleanup_inactive_consumers(
        &self,
        key: &str,
        group: &str,
        idle_threshold_ms: u64,
        target_consumer: Option<&str>,
    ) -> OmniResult<redis_ops::RedisStreamConsumerCleanupResult> {
        let mut conn = self.conn.clone();
        redis_ops::stream_cleanup_inactive_consumers(
            &mut conn,
            key,
            group,
            idle_threshold_ms,
            target_consumer,
        )
        .await
    }

    pub async fn acl_list(&self) -> OmniResult<Vec<RedisAclUser>> {
        let mut conn = self.conn.clone();
        redis_ops::acl_list(&mut conn).await
    }

    pub async fn acl_getuser(&self, username: &str) -> OmniResult<RedisAclUser> {
        let mut conn = self.conn.clone();
        redis_ops::acl_getuser(&mut conn, username).await
    }

    pub async fn acl_setuser(&self, username: &str, rule: &str) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::acl_setuser(&mut conn, username, rule).await
    }

    pub async fn acl_deluser(&self, username: &str) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::acl_deluser(&mut conn, username).await
    }

    pub async fn hash_set_field(&self, key: &str, field: &str, value: &str) -> OmniResult<()> {
        let mut conn = self.conn.clone();
        redis_ops::hash_set_field(&mut conn, key, field, value).await
    }

    pub async fn hash_del_fields(&self, key: &str, fields: &[String]) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::hash_del_fields(&mut conn, key, fields).await
    }

    pub async fn list_push(&self, key: &str, side: &str, values: &[String]) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::list_push(&mut conn, key, side, values).await
    }

    pub async fn list_remove(&self, key: &str, count: i64, value: &str) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::list_remove(&mut conn, key, count, value).await
    }

    pub async fn set_add(&self, key: &str, members: &[String]) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::set_add(&mut conn, key, members).await
    }

    pub async fn set_remove(&self, key: &str, members: &[String]) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::set_remove(&mut conn, key, members).await
    }

    pub async fn zset_add(&self, key: &str, member: &str, score: f64) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::zset_add(&mut conn, key, member, score).await
    }

    pub async fn zset_remove(&self, key: &str, members: &[String]) -> OmniResult<u64> {
        let mut conn = self.conn.clone();
        redis_ops::zset_remove(&mut conn, key, members).await
    }

    pub async fn expire_key(&self, key: &str, seconds: i64) -> OmniResult<bool> {
        let mut conn = self.conn.clone();
        redis_ops::expire_key(&mut conn, key, seconds).await
    }
}

async fn memory_usage_bytes(conn: &mut MultiplexedConnection, key: &str) -> OmniResult<u64> {
    let size: u64 = redis::cmd("MEMORY")
        .arg("USAGE")
        .arg(key)
        .query_async(conn)
        .await
        .map_err(map_redis_err)?;
    Ok(size)
}

async fn read_key_value(
    conn: &mut MultiplexedConnection,
    key: &str,
    key_type: &str,
) -> OmniResult<(Value, bool)> {
    let limit = KEY_DETAIL_PREVIEW_LIMIT as isize;
    match key_type {
        "string" => {
            let value: Option<Vec<u8>> = conn.get(key).await.map_err(map_redis_err)?;
            let text = match value {
                Some(bytes) => escape_bytes_preview(&bytes),
                None => String::new(),
            };
            Ok((Value::String(text), false))
        }
        "list" => {
            let len: i64 = conn.llen(key).await.map_err(map_redis_err)?;
            let stop = (limit - 1).min(isize::try_from((len - 1).max(0)).unwrap_or(0));
            let values: Vec<Vec<u8>> = conn.lrange(key, 0, stop).await.map_err(map_redis_err)?;
            let rows: Vec<Value> = values
                .into_iter()
                .enumerate()
                .map(|(i, bytes)| {
                    serde_json::json!({
                        "index": i,
                        "value": escape_bytes_preview(&bytes),
                    })
                })
                .collect();
            Ok((Value::Array(rows), len as usize > KEY_DETAIL_PREVIEW_LIMIT))
        }
        "set" => {
            let members: Vec<Vec<u8>> = conn.smembers(key).await.map_err(map_redis_err)?;
            let truncated = members.len() > KEY_DETAIL_PREVIEW_LIMIT;
            let rows: Vec<Value> = members
                .into_iter()
                .take(KEY_DETAIL_PREVIEW_LIMIT)
                .map(|bytes| {
                    serde_json::json!({
                        "member": escape_bytes_preview(&bytes),
                    })
                })
                .collect();
            Ok((Value::Array(rows), truncated))
        }
        "zset" => {
            let stop = (KEY_DETAIL_PREVIEW_LIMIT as isize) - 1;
            let values: Vec<(Vec<u8>, f64)> = conn
                .zrange_withscores(key, 0isize, stop)
                .await
                .map_err(map_redis_err)?;
            let card: i64 = conn.zcard(key).await.map_err(map_redis_err)?;
            let rows: Vec<Value> = values
                .into_iter()
                .map(|(member, score)| {
                    serde_json::json!({
                        "member": escape_bytes_preview(&member),
                        "score": score,
                    })
                })
                .collect();
            Ok((Value::Array(rows), card as usize > KEY_DETAIL_PREVIEW_LIMIT))
        }
        "hash" => {
            let map: std::collections::HashMap<Vec<u8>, Vec<u8>> =
                conn.hgetall(key).await.map_err(map_redis_err)?;
            let truncated = map.len() > KEY_DETAIL_PREVIEW_LIMIT;
            let rows: Vec<Value> = map
                .into_iter()
                .take(KEY_DETAIL_PREVIEW_LIMIT)
                .map(|(field, value)| {
                    serde_json::json!({
                        "field": escape_bytes_preview(&field),
                        "value": escape_bytes_preview(&value),
                    })
                })
                .collect();
            Ok((Value::Array(rows), truncated))
        }
        "stream" => {
            let len: i64 = redis::cmd("XLEN")
                .arg(key)
                .query_async(conn)
                .await
                .map_err(map_redis_err)?;
            let range = redis_ops::stream_range(conn, key, None, None, Some(20), true)
                .await
                .unwrap_or(RedisStreamRangeResult {
                    entries: Vec::new(),
                    reverse: true,
                });
            let entries: Vec<Value> = range
                .entries
                .into_iter()
                .map(|entry| {
                    serde_json::json!({
                        "id": entry.id,
                        "fields": entry.fields,
                    })
                })
                .collect();
            Ok((
                serde_json::json!({ "length": len, "entries": entries }),
                len as usize > KEY_DETAIL_PREVIEW_LIMIT,
            ))
        }
        other => Ok((serde_json::json!({ "unsupportedType": other }), false)),
    }
}

fn escape_bytes_preview(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let mut out = String::with_capacity(bytes.len() * 4);
            for b in bytes.iter().take(512) {
                out.push_str(&format!("\\x{b:02x}"));
            }
            if bytes.len() > 512 {
                out.push('…');
            }
            out
        }
    }
}

fn parse_keyspace_counts(info: &str) -> std::collections::HashMap<u64, u64> {
    let mut map = std::collections::HashMap::new();
    for line in info.lines() {
        let line = line.trim();
        // db0:keys=3461,expires=12,avg_ttl=...
        let Some(rest) = line.strip_prefix("db") else {
            continue;
        };
        let Some((idx_str, stats)) = rest.split_once(':') else {
            continue;
        };
        let Ok(idx) = idx_str.parse::<u64>() else {
            continue;
        };
        let mut keys = 0u64;
        for part in stats.split(',') {
            if let Some(value) = part.strip_prefix("keys=") {
                keys = value.parse().unwrap_or(0);
                break;
            }
        }
        map.insert(idx, keys);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::{parse_keyspace_counts, redis_connection_url};
    use crate::DbParams;

    fn redis_params(user: &str, password: &str) -> DbParams {
        DbParams {
            db_type: "redis".into(),
            host: "10.0.0.1".into(),
            port: 6379,
            user: user.into(),
            password: password.into(),
            database: "0".into(),
            ssl: false,
            sid: String::new(),
            sysdba: false,
        }
    }

    #[test]
    fn parses_keyspace_lines() {
        let info =
            "# Keyspace\ndb0:keys=3461,expires=12,avg_ttl=100\ndb1:keys=861,expires=0,avg_ttl=0\n";
        let map = parse_keyspace_counts(info);
        assert_eq!(map.get(&0), Some(&3461));
        assert_eq!(map.get(&1), Some(&861));
        assert_eq!(map.get(&2), None);
    }

    #[test]
    fn default_username_uses_requirepass_url() {
        let url = redis_connection_url(&redis_params("default", "s3cret"), 6379, 0);
        assert_eq!(url, "redis://:s3cret@10.0.0.1:6379/0");
        let url = redis_connection_url(&redis_params("", "s3cret"), 6379, 0);
        assert_eq!(url, "redis://:s3cret@10.0.0.1:6379/0");
    }

    #[test]
    fn acl_username_kept_in_url() {
        let url = redis_connection_url(&redis_params("app", "s3cret"), 6379, 2);
        assert_eq!(url, "redis://app:s3cret@10.0.0.1:6379/2");
    }
}

fn parse_slowlog_response(value: redis::Value) -> OmniResult<Vec<RedisSlowLogEntry>> {
    let items = match value {
        redis::Value::Array(items) => items,
        redis::Value::Nil => return Ok(Vec::new()),
        other => {
            return Err(
                OmniError::database("SLOWLOG 响应格式无效").with_cause(format!("{other:?}"))
            );
        }
    };
    let mut entries = Vec::with_capacity(items.len());
    for item in items {
        let redis::Value::Array(parts) = item else {
            continue;
        };
        if parts.len() < 4 {
            continue;
        }
        let id = redis_value_to_u64(&parts[0]);
        let timestamp = redis_value_to_u64(&parts[1]);
        let duration_us = redis_value_to_u64(&parts[2]);
        let command = match &parts[3] {
            redis::Value::Array(args) => args
                .iter()
                .map(|a| redis_value_to_string(a.clone()))
                .collect::<Vec<_>>()
                .join(" "),
            other => redis_value_to_string(other.clone()),
        };
        let client_addr = parts.get(4).map(|v| redis_value_to_string(v.clone()));
        let client_name = parts.get(5).map(|v| redis_value_to_string(v.clone()));
        entries.push(RedisSlowLogEntry {
            id,
            timestamp,
            duration_us,
            command,
            client_addr,
            client_name,
        });
    }
    Ok(entries)
}

fn redis_value_to_u64(value: &redis::Value) -> u64 {
    match value {
        redis::Value::Int(n) => *n as u64,
        redis::Value::BulkString(bytes) => String::from_utf8_lossy(bytes).parse().unwrap_or(0),
        redis::Value::SimpleString(s) => s.parse().unwrap_or(0),
        redis::Value::BigNumber(n) => n.to_string().parse().unwrap_or(0),
        _ => 0,
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
                        .map(|(i, v)| {
                            vec![Value::Number(i.into()), Value::String(bytes_to_display(&v))]
                        })
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
                        .map(|(m, s)| {
                            vec![Value::String(bytes_to_display(&m)), serde_json::json!(s)]
                        })
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
                if let Some(value) = conn
                    .hget::<_, _, Option<Vec<u8>>>(key, field)
                    .await
                    .map_err(map_redis_err)?
                {
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

/// 建连阶段常见瞬断：驱动提前退出 / IO 中断，适合短间隔重试。
fn is_transient_redis_connect_error(err: &redis::RedisError) -> bool {
    let msg = err.to_string().to_ascii_lowercase();
    msg.contains("multiplexed connection driver unexpectedly terminated")
        || msg.contains("connection reset")
        || msg.contains("broken pipe")
        || msg.contains("connection refused")
        || msg.contains("timed out")
        || msg.contains("os error 10054")
        || msg.contains("os error 10053")
        || msg.contains("os error 104")
}

fn parse_config_get_response(value: redis::Value) -> OmniResult<Vec<(String, String)>> {
    match value {
        redis::Value::Nil => Ok(Vec::new()),
        redis::Value::Map(map) => Ok(map
            .into_iter()
            .map(|(key, item)| (redis_value_to_string(key), redis_value_to_string(item)))
            .collect()),
        redis::Value::Array(items) => {
            let strings: Vec<String> = items.into_iter().map(redis_value_to_string).collect();
            let mut pairs = Vec::new();
            let mut index = 0;
            while index + 1 < strings.len() {
                pairs.push((strings[index].clone(), strings[index + 1].clone()));
                index += 2;
            }
            Ok(pairs)
        }
        other => {
            Err(OmniError::database("CONFIG GET 返回格式不支持").with_cause(format!("{other:?}")))
        }
    }
}

const CLIENT_LIST_COLUMN_ORDER: &[&str] = &[
    "id",
    "addr",
    "laddr",
    "fd",
    "name",
    "age",
    "idle",
    "flags",
    "db",
    "sub",
    "psub",
    "multi",
    "qbuf",
    "qbuf-free",
    "obl",
    "oll",
    "omem",
    "events",
    "cmd",
    "user",
    "redir",
    "resp",
];

fn parse_client_line(line: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for part in line.split_whitespace() {
        if let Some((key, value)) = part.split_once('=') {
            map.insert(key.to_string(), value.to_string());
        }
    }
    map
}

fn parse_client_entry(item: redis::Value) -> Option<std::collections::HashMap<String, String>> {
    match item {
        redis::Value::BulkString(bytes) => {
            let line = String::from_utf8_lossy(&bytes).into_owned();
            let map = parse_client_line(&line);
            if map.is_empty() { None } else { Some(map) }
        }
        redis::Value::SimpleString(line) => {
            let map = parse_client_line(&line);
            if map.is_empty() { None } else { Some(map) }
        }
        redis::Value::Map(map) => {
            let mut parsed = std::collections::HashMap::new();
            for (key, value) in map {
                parsed.insert(redis_value_to_string(key), redis_value_to_string(value));
            }
            if parsed.is_empty() {
                None
            } else {
                Some(parsed)
            }
        }
        _ => None,
    }
}

fn build_client_list_columns(clients: &[std::collections::HashMap<String, String>]) -> Vec<String> {
    let mut seen = std::collections::BTreeSet::new();
    for client in clients {
        for key in client.keys() {
            seen.insert(key.clone());
        }
    }
    // 只保留常用列：Redis 7+ CLIENT LIST 字段极多，全量展示会撑破右侧 flex 布局。
    let mut columns = Vec::new();
    for key in CLIENT_LIST_COLUMN_ORDER {
        if seen.remove(*key) {
            columns.push((*key).to_string());
        }
    }
    columns
}

fn parse_client_list_response(value: redis::Value) -> OmniResult<QueryResult> {
    let clients: Vec<std::collections::HashMap<String, String>> = match value {
        redis::Value::Nil => Vec::new(),
        redis::Value::Array(items) => items.into_iter().filter_map(parse_client_entry).collect(),
        redis::Value::BulkString(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            text.lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
                .map(parse_client_line)
                .filter(|map| !map.is_empty())
                .collect()
        }
        redis::Value::SimpleString(text) => text
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(parse_client_line)
            .filter(|map| !map.is_empty())
            .collect(),
        other => {
            return Err(
                OmniError::database("CLIENT LIST 返回格式不支持").with_cause(format!("{other:?}"))
            );
        }
    };

    if clients.is_empty() {
        return Ok(QueryResult {
            columns: CLIENT_LIST_COLUMN_ORDER
                .iter()
                .map(|column| (*column).to_string())
                .collect(),
            rows: Vec::new(),
            rows_affected: 0,
        });
    }

    let columns = build_client_list_columns(&clients);
    let rows = clients
        .into_iter()
        .map(|client| {
            columns
                .iter()
                .map(|column| {
                    Value::String(
                        client
                            .get(column)
                            .cloned()
                            .unwrap_or_else(|| "—".to_string()),
                    )
                })
                .collect()
        })
        .collect();

    Ok(QueryResult {
        columns,
        rows,
        rows_affected: 0,
    })
}

/// Redis 6+ 的 `default` 用户应走单参数 AUTH（requirepass），不要写进 URL 用户名。
/// 连接表单常把用户名填成 `default`，redis-rs 会改发 ACL AUTH，老实例直接 NOAUTH。
fn redis_acl_username(user: &str) -> Option<&str> {
    let user = user.trim();
    if user.is_empty() || user.eq_ignore_ascii_case("default") {
        None
    } else {
        Some(user)
    }
}

fn redis_connection_url(params: &DbParams, port: u16, db: i64) -> String {
    if params.password.is_empty() {
        format!("redis://{}:{}/{}", params.host, port, db)
    } else if let Some(user) = redis_acl_username(&params.user) {
        format!(
            "redis://{}:{}@{}:{}/{}",
            percent_encode(user),
            percent_encode(&params.password),
            params.host,
            port,
            db
        )
    } else {
        format!(
            "redis://:{}@{}:{}/{}",
            percent_encode(&params.password),
            params.host,
            port,
            db
        )
    }
}

fn percent_encode(s: &str) -> String {
    // userinfo 必须转义 `@` / `:`，否则密码里的 `@` 会把 host 解析错，表现为 NOAUTH。
    s.chars()
        .map(|c| match c {
            ' ' => "%20".to_string(),
            '%' => "%25".to_string(),
            '/' => "%2F".to_string(),
            '?' => "%3F".to_string(),
            '#' => "%23".to_string(),
            '[' => "%5B".to_string(),
            ']' => "%5D".to_string(),
            '@' => "%40".to_string(),
            ':' => "%3A".to_string(),
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
            | "XACK"
            | "XCLAIM"
            | "XAUTOCLAIM"
            | "XGROUP"
            | "XTRIM"
            | "CONFIG"
            | "MEMORY"
            | "ACL"
            | "LREM"
            | "SREM"
    )
}
