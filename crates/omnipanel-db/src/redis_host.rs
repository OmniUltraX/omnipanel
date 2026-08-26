//! 宿主侧 Redis API：全部转发到常驻 sidecar（redis_ops 只活在客体进程）。

use omnipanel_error::OmniResult;
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

use crate::sidecar::{self, EngineKind};
use crate::{
    DbParams, QueryResult, RedisAclUser, RedisDatabaseInfo, RedisInfoResult, RedisKeyDetail,
    RedisMemoryStats, RedisSearchKeysResult, RedisSlowLogEntry, RedisStreamConsumer,
    RedisStreamConsumerCleanupResult, RedisStreamGroup, RedisStreamMonitorSnapshot,
    RedisStreamPendingEntry, RedisStreamRangeResult,
};

const KIND: EngineKind = EngineKind::Redis;

async fn rpc<T: DeserializeOwned>(
    params: &DbParams,
    method: &str,
    args: Value,
) -> OmniResult<T> {
    sidecar::invoke_json(KIND, params, method, args).await
}

async fn rpc_ok(params: &DbParams, method: &str, args: Value) -> OmniResult<()> {
    let _: Value = rpc(params, method, args).await?;
    Ok(())
}

async fn rpc_query(params: &DbParams, method: &str, args: Value) -> OmniResult<QueryResult> {
    sidecar::invoke_query(KIND, params, method, args).await
}

pub async fn redis_config_get_all(params: &DbParams) -> OmniResult<QueryResult> {
    rpc_query(params, "redis_config_get_all", json!({})).await
}

pub async fn redis_config_get(params: &DbParams, pattern: &str) -> OmniResult<Vec<(String, String)>> {
    rpc(params, "redis_config_get", json!({ "pattern": pattern })).await
}

pub async fn redis_client_list(params: &DbParams) -> OmniResult<QueryResult> {
    rpc_query(params, "redis_client_list", json!({})).await
}

pub async fn redis_search_keys(
    params: &DbParams,
    pattern: &str,
    types: &[String],
    limit: usize,
    cursor: u64,
    include_value_preview: bool,
) -> OmniResult<RedisSearchKeysResult> {
    rpc(
        params,
        "redis_search_keys",
        json!({
            "pattern": pattern,
            "types": types,
            "limit": limit,
            "cursor": cursor,
            "includeValuePreview": include_value_preview,
        }),
    )
    .await
}

pub async fn redis_list_databases(
    params: &DbParams,
    preset_database: &str,
) -> OmniResult<Vec<String>> {
    rpc(
        params,
        "redis_list_databases",
        json!({ "presetDatabase": preset_database }),
    )
    .await
}

pub async fn redis_list_databases_with_key_counts(
    params: &DbParams,
    preset_database: &str,
) -> OmniResult<Vec<RedisDatabaseInfo>> {
    rpc(
        params,
        "redis_list_databases_with_key_counts",
        json!({ "presetDatabase": preset_database }),
    )
    .await
}

pub async fn redis_dbsize(params: &DbParams) -> OmniResult<u64> {
    rpc(params, "redis_dbsize", json!({})).await
}

pub async fn redis_key_detail(params: &DbParams, key: &str) -> OmniResult<RedisKeyDetail> {
    rpc(params, "redis_key_detail", json!({ "key": key })).await
}

pub async fn redis_set_key(
    params: &DbParams,
    key: &str,
    value: &str,
    key_type: &str,
) -> OmniResult<()> {
    rpc_ok(
        params,
        "redis_set_key",
        json!({ "key": key, "value": value, "keyType": key_type }),
    )
    .await
}

pub async fn redis_delete_key(params: &DbParams, key: &str) -> OmniResult<u64> {
    rpc(params, "redis_delete_key", json!({ "key": key })).await
}

pub async fn redis_slowlog(params: &DbParams, count: usize) -> OmniResult<Vec<RedisSlowLogEntry>> {
    rpc(params, "redis_slowlog", json!({ "count": count })).await
}

pub async fn redis_client_kill_addr(params: &DbParams, addr: &str) -> OmniResult<u64> {
    rpc(params, "redis_client_kill_addr", json!({ "addr": addr })).await
}

pub async fn redis_info(params: &DbParams, section: Option<&str>) -> OmniResult<RedisInfoResult> {
    rpc(params, "redis_info", json!({ "section": section })).await
}

pub async fn redis_memory_stats(params: &DbParams) -> OmniResult<RedisMemoryStats> {
    rpc(params, "redis_memory_stats", json!({})).await
}

pub async fn redis_memory_doctor(params: &DbParams) -> OmniResult<String> {
    rpc(params, "redis_memory_doctor", json!({})).await
}

pub async fn redis_memory_purge(params: &DbParams) -> OmniResult<u64> {
    rpc(params, "redis_memory_purge", json!({})).await
}

pub async fn redis_config_set(params: &DbParams, parameter: &str, value: &str) -> OmniResult<()> {
    rpc_ok(
        params,
        "redis_config_set",
        json!({ "parameter": parameter, "value": value }),
    )
    .await
}

pub async fn redis_config_rewrite(params: &DbParams) -> OmniResult<()> {
    rpc_ok(params, "redis_config_rewrite", json!({})).await
}

pub async fn redis_flush_db(params: &DbParams, r#async: bool) -> OmniResult<()> {
    rpc_ok(params, "redis_flush_db", json!({ "async": r#async })).await
}

pub async fn redis_flush_all(params: &DbParams, r#async: bool) -> OmniResult<()> {
    rpc_ok(params, "redis_flush_all", json!({ "async": r#async })).await
}

pub async fn redis_stream_range(
    params: &DbParams,
    key: &str,
    start: Option<&str>,
    end: Option<&str>,
    count: Option<usize>,
    reverse: bool,
) -> OmniResult<RedisStreamRangeResult> {
    rpc(
        params,
        "redis_stream_range",
        json!({
            "key": key,
            "start": start,
            "end": end,
            "count": count,
            "reverse": reverse,
        }),
    )
    .await
}

pub async fn redis_stream_groups(params: &DbParams, key: &str) -> OmniResult<Vec<RedisStreamGroup>> {
    rpc(params, "redis_stream_groups", json!({ "key": key })).await
}

pub async fn redis_stream_consumers(
    params: &DbParams,
    key: &str,
    group: &str,
) -> OmniResult<Vec<RedisStreamConsumer>> {
    rpc(
        params,
        "redis_stream_consumers",
        json!({ "key": key, "group": group }),
    )
    .await
}

pub async fn redis_stream_pending(
    params: &DbParams,
    key: &str,
    group: &str,
    start: Option<&str>,
    end: Option<&str>,
    count: Option<usize>,
) -> OmniResult<Vec<RedisStreamPendingEntry>> {
    rpc(
        params,
        "redis_stream_pending",
        json!({
            "key": key,
            "group": group,
            "start": start,
            "end": end,
            "count": count,
        }),
    )
    .await
}

pub async fn redis_stream_monitor(
    params: &DbParams,
    key: &str,
    group: Option<&str>,
) -> OmniResult<RedisStreamMonitorSnapshot> {
    rpc(
        params,
        "redis_stream_monitor",
        json!({ "key": key, "group": group }),
    )
    .await
}

pub async fn redis_stream_ack(
    params: &DbParams,
    key: &str,
    group: &str,
    ids: &[String],
) -> OmniResult<u64> {
    rpc(
        params,
        "redis_stream_ack",
        json!({ "key": key, "group": group, "ids": ids }),
    )
    .await
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
    rpc(
        params,
        "redis_stream_claim",
        json!({
            "key": key,
            "group": group,
            "consumer": consumer,
            "minIdleMs": min_idle_ms,
            "startId": start_id,
            "count": count,
        }),
    )
    .await
}

pub async fn redis_stream_group_create(
    params: &DbParams,
    key: &str,
    group: &str,
    id: &str,
    mkstream: bool,
) -> OmniResult<()> {
    rpc_ok(
        params,
        "redis_stream_group_create",
        json!({ "key": key, "group": group, "id": id, "mkstream": mkstream }),
    )
    .await
}

pub async fn redis_stream_group_destroy(params: &DbParams, key: &str, group: &str) -> OmniResult<()> {
    rpc_ok(
        params,
        "redis_stream_group_destroy",
        json!({ "key": key, "group": group }),
    )
    .await
}

pub async fn redis_stream_trim(
    params: &DbParams,
    key: &str,
    maxlen: u64,
    approximate: bool,
) -> OmniResult<u64> {
    rpc(
        params,
        "redis_stream_trim",
        json!({ "key": key, "maxlen": maxlen, "approximate": approximate }),
    )
    .await
}

pub async fn redis_stream_cleanup_inactive_consumers(
    params: &DbParams,
    key: &str,
    group: &str,
    idle_threshold_ms: u64,
    target_consumer: Option<&str>,
) -> OmniResult<RedisStreamConsumerCleanupResult> {
    rpc(
        params,
        "redis_stream_cleanup_inactive_consumers",
        json!({
            "key": key,
            "group": group,
            "idleThresholdMs": idle_threshold_ms,
            "targetConsumer": target_consumer,
        }),
    )
    .await
}

pub async fn redis_acl_list(params: &DbParams) -> OmniResult<Vec<RedisAclUser>> {
    rpc(params, "redis_acl_list", json!({})).await
}

pub async fn redis_acl_getuser(params: &DbParams, username: &str) -> OmniResult<RedisAclUser> {
    rpc(params, "redis_acl_getuser", json!({ "username": username })).await
}

pub async fn redis_acl_setuser(params: &DbParams, username: &str, rule: &str) -> OmniResult<()> {
    rpc_ok(
        params,
        "redis_acl_setuser",
        json!({ "username": username, "rule": rule }),
    )
    .await
}

pub async fn redis_acl_deluser(params: &DbParams, username: &str) -> OmniResult<u64> {
    rpc(params, "redis_acl_deluser", json!({ "username": username })).await
}

pub async fn redis_hash_set_field(
    params: &DbParams,
    key: &str,
    field: &str,
    value: &str,
) -> OmniResult<()> {
    rpc_ok(
        params,
        "redis_hash_set_field",
        json!({ "key": key, "field": field, "value": value }),
    )
    .await
}

pub async fn redis_hash_del_fields(
    params: &DbParams,
    key: &str,
    fields: &[String],
) -> OmniResult<u64> {
    rpc(
        params,
        "redis_hash_del_fields",
        json!({ "key": key, "fields": fields }),
    )
    .await
}

pub async fn redis_list_push(
    params: &DbParams,
    key: &str,
    side: &str,
    values: &[String],
) -> OmniResult<u64> {
    rpc(
        params,
        "redis_list_push",
        json!({ "key": key, "side": side, "values": values }),
    )
    .await
}

pub async fn redis_list_remove(
    params: &DbParams,
    key: &str,
    count: i64,
    value: &str,
) -> OmniResult<u64> {
    rpc(
        params,
        "redis_list_remove",
        json!({ "key": key, "count": count, "value": value }),
    )
    .await
}

pub async fn redis_set_add(params: &DbParams, key: &str, members: &[String]) -> OmniResult<u64> {
    rpc(
        params,
        "redis_set_add",
        json!({ "key": key, "members": members }),
    )
    .await
}

pub async fn redis_set_remove(params: &DbParams, key: &str, members: &[String]) -> OmniResult<u64> {
    rpc(
        params,
        "redis_set_remove",
        json!({ "key": key, "members": members }),
    )
    .await
}

pub async fn redis_zset_add(
    params: &DbParams,
    key: &str,
    member: &str,
    score: f64,
) -> OmniResult<u64> {
    rpc(
        params,
        "redis_zset_add",
        json!({ "key": key, "member": member, "score": score }),
    )
    .await
}

pub async fn redis_zset_remove(params: &DbParams, key: &str, members: &[String]) -> OmniResult<u64> {
    rpc(
        params,
        "redis_zset_remove",
        json!({ "key": key, "members": members }),
    )
    .await
}

pub async fn redis_expire_key(params: &DbParams, key: &str, seconds: i64) -> OmniResult<bool> {
    rpc(
        params,
        "redis_expire_key",
        json!({ "key": key, "seconds": seconds }),
    )
    .await
}
