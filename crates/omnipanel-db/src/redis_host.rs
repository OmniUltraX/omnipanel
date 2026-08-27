//! 宿主侧 Redis API：进程内 `RedisDriver`。
//!
//! sidecar 仍可用于隔离部署；热路径走本进程，避免旧 sidecar 二进制把
//! `default` 用户名编进 URL 后出现 NOAUTH，也避免连库时同步 cargo build。

use omnipanel_error::OmniResult;

use crate::redis::RedisDriver;
use crate::{
    DbParams, QueryResult, RedisAclUser, RedisDatabaseInfo, RedisInfoResult, RedisKeyDetail,
    RedisMemoryStats, RedisSearchKeysResult, RedisSlowLogEntry, RedisStreamConsumer,
    RedisStreamConsumerCleanupResult, RedisStreamGroup, RedisStreamMonitorSnapshot,
    RedisStreamPendingEntry, RedisStreamRangeResult,
};

async fn driver(params: &DbParams) -> OmniResult<RedisDriver> {
    RedisDriver::connect(params).await
}

pub async fn redis_config_get_all(params: &DbParams) -> OmniResult<QueryResult> {
    driver(params).await?.config_get_all().await
}

pub async fn redis_config_get(
    params: &DbParams,
    pattern: &str,
) -> OmniResult<Vec<(String, String)>> {
    driver(params).await?.config_get(pattern).await
}

pub async fn redis_client_list(params: &DbParams) -> OmniResult<QueryResult> {
    driver(params).await?.client_list().await
}

pub async fn redis_search_keys(
    params: &DbParams,
    pattern: &str,
    types: &[String],
    limit: usize,
    cursor: u64,
    include_value_preview: bool,
) -> OmniResult<RedisSearchKeysResult> {
    driver(params)
        .await?
        .search_keys(pattern, types, limit, cursor, include_value_preview)
        .await
}

pub async fn redis_list_databases(
    params: &DbParams,
    preset_database: &str,
) -> OmniResult<Vec<String>> {
    driver(params).await?.list_databases(preset_database).await
}

pub async fn redis_list_databases_with_key_counts(
    params: &DbParams,
    preset_database: &str,
) -> OmniResult<Vec<RedisDatabaseInfo>> {
    driver(params)
        .await?
        .list_databases_with_key_counts(preset_database)
        .await
}

pub async fn redis_dbsize(params: &DbParams) -> OmniResult<u64> {
    driver(params).await?.dbsize().await
}

pub async fn redis_key_detail(params: &DbParams, key: &str) -> OmniResult<RedisKeyDetail> {
    driver(params).await?.key_detail(key).await
}

pub async fn redis_set_key(
    params: &DbParams,
    key: &str,
    value: &str,
    key_type: &str,
) -> OmniResult<()> {
    driver(params).await?.set_key(key, value, key_type).await
}

pub async fn redis_delete_key(params: &DbParams, key: &str) -> OmniResult<u64> {
    driver(params).await?.delete_key(key).await
}

pub async fn redis_slowlog(params: &DbParams, count: usize) -> OmniResult<Vec<RedisSlowLogEntry>> {
    driver(params).await?.slowlog(count).await
}

pub async fn redis_client_kill_addr(params: &DbParams, addr: &str) -> OmniResult<u64> {
    driver(params).await?.client_kill_addr(addr).await
}

pub async fn redis_info(params: &DbParams, section: Option<&str>) -> OmniResult<RedisInfoResult> {
    driver(params).await?.info(section).await
}

pub async fn redis_memory_stats(params: &DbParams) -> OmniResult<RedisMemoryStats> {
    driver(params).await?.memory_stats().await
}

pub async fn redis_memory_doctor(params: &DbParams) -> OmniResult<String> {
    driver(params).await?.memory_doctor().await
}

pub async fn redis_memory_purge(params: &DbParams) -> OmniResult<u64> {
    driver(params).await?.memory_purge().await
}

pub async fn redis_config_set(params: &DbParams, parameter: &str, value: &str) -> OmniResult<()> {
    driver(params).await?.config_set(parameter, value).await
}

pub async fn redis_config_rewrite(params: &DbParams) -> OmniResult<()> {
    driver(params).await?.config_rewrite().await
}

pub async fn redis_flush_db(params: &DbParams, r#async: bool) -> OmniResult<()> {
    driver(params).await?.flush_db(r#async).await
}

pub async fn redis_flush_all(params: &DbParams, r#async: bool) -> OmniResult<()> {
    driver(params).await?.flush_all(r#async).await
}

pub async fn redis_stream_range(
    params: &DbParams,
    key: &str,
    start: Option<&str>,
    end: Option<&str>,
    count: Option<usize>,
    reverse: bool,
) -> OmniResult<RedisStreamRangeResult> {
    driver(params)
        .await?
        .stream_range(key, start, end, count, reverse)
        .await
}

pub async fn redis_stream_groups(
    params: &DbParams,
    key: &str,
) -> OmniResult<Vec<RedisStreamGroup>> {
    driver(params).await?.stream_groups(key).await
}

pub async fn redis_stream_consumers(
    params: &DbParams,
    key: &str,
    group: &str,
) -> OmniResult<Vec<RedisStreamConsumer>> {
    driver(params).await?.stream_consumers(key, group).await
}

pub async fn redis_stream_pending(
    params: &DbParams,
    key: &str,
    group: &str,
    start: Option<&str>,
    end: Option<&str>,
    count: Option<usize>,
) -> OmniResult<Vec<RedisStreamPendingEntry>> {
    driver(params)
        .await?
        .stream_pending(key, group, start, end, count)
        .await
}

pub async fn redis_stream_monitor(
    params: &DbParams,
    key: &str,
    group: Option<&str>,
) -> OmniResult<RedisStreamMonitorSnapshot> {
    driver(params).await?.stream_monitor(key, group).await
}

pub async fn redis_stream_ack(
    params: &DbParams,
    key: &str,
    group: &str,
    ids: &[String],
) -> OmniResult<u64> {
    driver(params).await?.stream_ack(key, group, ids).await
}

pub async fn redis_stream_claim(
    params: &DbParams,
    key: &str,
    group: &str,
    consumer: &str,
    min_idle_ms: u64,
    start_id: &str,
    count: Option<u64>,
) -> OmniResult<u64> {
    driver(params)
        .await?
        .stream_claim(key, group, consumer, min_idle_ms, start_id, count)
        .await
}

pub async fn redis_stream_group_create(
    params: &DbParams,
    key: &str,
    group: &str,
    id: &str,
    mkstream: bool,
) -> OmniResult<()> {
    driver(params)
        .await?
        .stream_group_create(key, group, id, mkstream)
        .await
}

pub async fn redis_stream_group_destroy(
    params: &DbParams,
    key: &str,
    group: &str,
) -> OmniResult<()> {
    driver(params).await?.stream_group_destroy(key, group).await
}

pub async fn redis_stream_trim(
    params: &DbParams,
    key: &str,
    maxlen: u64,
    approximate: bool,
) -> OmniResult<u64> {
    driver(params)
        .await?
        .stream_trim(key, maxlen, approximate)
        .await
}

pub async fn redis_stream_cleanup_inactive_consumers(
    params: &DbParams,
    key: &str,
    group: &str,
    idle_threshold_ms: u64,
    target_consumer: Option<&str>,
) -> OmniResult<RedisStreamConsumerCleanupResult> {
    driver(params)
        .await?
        .stream_cleanup_inactive_consumers(key, group, idle_threshold_ms, target_consumer)
        .await
}

pub async fn redis_acl_list(params: &DbParams) -> OmniResult<Vec<RedisAclUser>> {
    driver(params).await?.acl_list().await
}

pub async fn redis_acl_getuser(params: &DbParams, username: &str) -> OmniResult<RedisAclUser> {
    driver(params).await?.acl_getuser(username).await
}

pub async fn redis_acl_setuser(params: &DbParams, username: &str, rule: &str) -> OmniResult<()> {
    driver(params).await?.acl_setuser(username, rule).await
}

pub async fn redis_acl_deluser(params: &DbParams, username: &str) -> OmniResult<u64> {
    driver(params).await?.acl_deluser(username).await
}

pub async fn redis_hash_set_field(
    params: &DbParams,
    key: &str,
    field: &str,
    value: &str,
) -> OmniResult<()> {
    driver(params)
        .await?
        .hash_set_field(key, field, value)
        .await
}

pub async fn redis_hash_del_fields(
    params: &DbParams,
    key: &str,
    fields: &[String],
) -> OmniResult<u64> {
    driver(params).await?.hash_del_fields(key, fields).await
}

pub async fn redis_list_push(
    params: &DbParams,
    key: &str,
    side: &str,
    values: &[String],
) -> OmniResult<u64> {
    driver(params).await?.list_push(key, side, values).await
}

pub async fn redis_list_remove(
    params: &DbParams,
    key: &str,
    count: i64,
    value: &str,
) -> OmniResult<u64> {
    driver(params).await?.list_remove(key, count, value).await
}

pub async fn redis_set_add(params: &DbParams, key: &str, members: &[String]) -> OmniResult<u64> {
    driver(params).await?.set_add(key, members).await
}

pub async fn redis_set_remove(params: &DbParams, key: &str, members: &[String]) -> OmniResult<u64> {
    driver(params).await?.set_remove(key, members).await
}

pub async fn redis_zset_add(
    params: &DbParams,
    key: &str,
    member: &str,
    score: f64,
) -> OmniResult<u64> {
    driver(params).await?.zset_add(key, member, score).await
}

pub async fn redis_zset_remove(
    params: &DbParams,
    key: &str,
    members: &[String],
) -> OmniResult<u64> {
    driver(params).await?.zset_remove(key, members).await
}

pub async fn redis_expire_key(params: &DbParams, key: &str, seconds: i64) -> OmniResult<bool> {
    driver(params).await?.expire_key(key, seconds).await
}
