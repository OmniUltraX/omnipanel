//! 各引擎在 JSON-RPC 上的扩展方法（describe / redis_ops / list_databases 等）。

use async_trait::async_trait;
use serde_json::{json, Value};

use crate::sidecar::protocol::{
    ColumnInfo, ConnectParams, CreateDatabaseParams, TableParams,
};
#[cfg(feature = "engine-redis")]
use crate::sidecar::protocol::encode_query_result;
use crate::{DbDriver, DbParams};

#[async_trait]
pub trait EngineSession: DbDriver {
    async fn handle_extra(&self, method: &str, params: Value) -> Result<Value, String>;
}

pub fn engine_name() -> &'static str {
    #[allow(unreachable_code)]
    {
        #[cfg(feature = "engine-clickhouse")]
        {
            return "clickhouse";
        }
        #[cfg(feature = "engine-mongodb")]
        {
            return "mongodb";
        }
        #[cfg(feature = "engine-redis")]
        {
            return "redis";
        }
        #[cfg(feature = "engine-mysql")]
        {
            return "mysql";
        }
        #[cfg(feature = "engine-postgres")]
        {
            return "postgres";
        }
        "unknown"
    }
}

pub async fn engine_connect(params: Value) -> Result<Box<dyn EngineSession>, String> {
    let spec: ConnectParams =
        serde_json::from_value(params).map_err(|e| format!("connect 参数非法: {e}"))?;
    let mut params = DbParams::from(spec);
    if params.database.trim().is_empty() {
        params.database = default_database(&params);
    }
    connect_ready(params).await
}

fn default_database(params: &DbParams) -> String {
    match params.db_type.to_ascii_lowercase().as_str() {
        "mongodb" | "mongo" => "admin".into(),
        "clickhouse" | "ch" => "default".into(),
        "redis" => "0".into(),
        _ => params.database.clone(),
    }
}

async fn connect_ready(params: DbParams) -> Result<Box<dyn EngineSession>, String> {
    #[allow(unreachable_code)]
    {
    #[cfg(feature = "engine-clickhouse")]
    {
        let driver = crate::clickhouse::ClickHouseDriver::connect(&params)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Box::new(driver));
    }
    #[cfg(feature = "engine-mongodb")]
    {
        let driver = crate::mongodb::MongoDriver::connect(&params)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Box::new(driver));
    }
    #[cfg(feature = "engine-redis")]
    {
        let driver = crate::redis::RedisDriver::connect(&params)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Box::new(driver));
    }
    #[cfg(feature = "engine-mysql")]
    {
        let driver = crate::mysql::MySqlDriver::connect(&params)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Box::new(driver));
    }
    #[cfg(feature = "engine-postgres")]
    {
        let driver = crate::postgres::PgDriver::connect(&params)
            .await
            .map_err(|e| e.to_string())?;
        return Ok(Box::new(driver));
    }
    let _ = params;
    Err("sidecar 未启用任何 engine-* feature".into())
    }
}

fn json_cell_string(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Null => None,
        other => Some(other.to_string()),
    }
}

#[cfg(any(feature = "engine-mysql", feature = "engine-postgres"))]
fn columns_from_query(result: crate::QueryResult) -> Vec<ColumnInfo> {
    result
        .rows
        .into_iter()
        .filter_map(|row| {
            let name = row.first().and_then(json_cell_string)?;
            let column_type = row
                .get(1)
                .and_then(json_cell_string)
                .unwrap_or_else(|| "unknown".into());
            Some(ColumnInfo { name, column_type })
        })
        .collect()
}

#[cfg(feature = "engine-clickhouse")]
#[async_trait]
impl EngineSession for crate::clickhouse::ClickHouseDriver {
    async fn handle_extra(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "list_databases" => Ok(json!(self.list_databases().await.map_err(|e| e.to_string())?)),
            "list_schemas" => {
                let result = self
                    .execute("SELECT currentDatabase()")
                    .await
                    .map_err(|e| e.to_string())?;
                let name = result
                    .rows
                    .first()
                    .and_then(|row| row.first())
                    .and_then(json_cell_string)
                    .unwrap_or_else(|| "default".into());
                Ok(json!(vec![name]))
            }
            "describe_table" => {
                let spec: TableParams = serde_json::from_value(params)
                    .map_err(|e| format!("describe_table 参数非法: {e}"))?;
                let columns = self
                    .describe_table(&spec.table)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(
                    columns
                        .into_iter()
                        .map(|(name, column_type)| ColumnInfo { name, column_type })
                        .collect::<Vec<_>>(),
                )
                .unwrap_or(Value::Null))
            }
            "create_database" => {
                let spec: CreateDatabaseParams = serde_json::from_value(params)
                    .map_err(|e| format!("create_database 参数非法: {e}"))?;
                self.create_database(&spec.name)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(json!({ "ok": true }))
            }
            "show_create_table" => {
                let spec: TableParams = serde_json::from_value(params)
                    .map_err(|e| format!("show_create_table 参数非法: {e}"))?;
                Ok(json!(
                    self.show_create_table(&spec.table)
                        .await
                        .map_err(|e| e.to_string())?
                ))
            }
            unknown => Err(format!("未知方法: {unknown}")),
        }
    }
}

#[cfg(feature = "engine-mongodb")]
#[async_trait]
impl EngineSession for crate::mongodb::MongoDriver {
    async fn handle_extra(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "list_databases" => Ok(json!(
                self.list_database_names().await.map_err(|e| e.to_string())?
            )),
            "list_schemas" => Ok(json!(self.list_tables().await.map_err(|e| e.to_string())?)),
            "describe_table" => {
                let spec: TableParams = serde_json::from_value(params)
                    .map_err(|e| format!("describe_table 参数非法: {e}"))?;
                let names = self
                    .infer_column_names(&spec.table, 100)
                    .await
                    .map_err(|e| e.to_string())?;
                Ok(serde_json::to_value(
                    names
                        .into_iter()
                        .map(|name| ColumnInfo {
                            column_type: if name == "_id" {
                                "objectId".into()
                            } else {
                                "mixed".into()
                            },
                            name,
                        })
                        .collect::<Vec<_>>(),
                )
                .unwrap_or(Value::Null))
            }
            unknown => Err(format!("未知方法: {unknown}")),
        }
    }
}

#[cfg(feature = "engine-mysql")]
#[async_trait]
impl EngineSession for crate::mysql::MySqlDriver {
    async fn handle_extra(&self, method: &str, params: Value) -> Result<Value, String> {
        sql_handle_extra(self, method, params, "mysql").await
    }
}

#[cfg(feature = "engine-postgres")]
#[async_trait]
impl EngineSession for crate::postgres::PgDriver {
    async fn handle_extra(&self, method: &str, params: Value) -> Result<Value, String> {
        sql_handle_extra(self, method, params, "postgres").await
    }
}

#[cfg(any(feature = "engine-mysql", feature = "engine-postgres"))]
async fn sql_handle_extra<D: DbDriver + Sync>(
    driver: &D,
    method: &str,
    params: Value,
    dialect: &str,
) -> Result<Value, String> {
    match method {
        "list_databases" => {
            let sql = if dialect == "postgres" {
                "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname"
            } else {
                "SHOW DATABASES"
            };
            let result = driver.execute(sql).await.map_err(|e| e.to_string())?;
            let names: Vec<String> = result
                .rows
                .into_iter()
                .filter_map(|row| row.first().and_then(json_cell_string))
                .collect();
            Ok(json!(names))
        }
        "list_schemas" => {
            let sql = if dialect == "postgres" {
                "SELECT current_schema()"
            } else {
                "SELECT DATABASE()"
            };
            let result = driver.execute(sql).await.map_err(|e| e.to_string())?;
            let name = result
                .rows
                .first()
                .and_then(|row| row.first())
                .and_then(json_cell_string)
                .unwrap_or_default();
            Ok(json!(vec![name]))
        }
        "describe_table" => {
            let spec: TableParams = serde_json::from_value(params)
                .map_err(|e| format!("describe_table 参数非法: {e}"))?;
            let table = spec.table.replace('`', "").replace('"', "");
            let sql = if dialect == "postgres" {
                format!(
                    "SELECT column_name, data_type FROM information_schema.columns \
                     WHERE table_schema = current_schema() AND table_name = '{table}' \
                     ORDER BY ordinal_position"
                )
            } else {
                format!(
                    "SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS \
                     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{table}' \
                     ORDER BY ORDINAL_POSITION"
                )
            };
            let result = driver.execute(&sql).await.map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(columns_from_query(result)).unwrap_or(Value::Null))
        }
        "show_create_table" => {
            let spec: TableParams = serde_json::from_value(params)
                .map_err(|e| format!("show_create_table 参数非法: {e}"))?;
            let table = spec.table.replace('`', "").replace('"', "");
            if dialect == "postgres" {
                return Err("PostgreSQL sidecar 请用 information_schema 查看结构".into());
            }
            let result = driver
                .execute(&format!("SHOW CREATE TABLE `{table}`"))
                .await
                .map_err(|e| e.to_string())?;
            let ddl = result
                .rows
                .first()
                .and_then(|row| row.get(1))
                .and_then(json_cell_string)
                .unwrap_or_default();
            Ok(json!(ddl))
        }
        unknown => Err(format!("未知方法: {unknown}")),
    }
}

#[cfg(feature = "engine-redis")]
#[async_trait]
impl EngineSession for crate::redis::RedisDriver {
    async fn handle_extra(&self, method: &str, params: Value) -> Result<Value, String> {
        redis_handle_extra(self, method, params).await
    }
}

#[cfg(feature = "engine-redis")]
async fn redis_handle_extra(
    driver: &crate::redis::RedisDriver,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    fn s(params: &Value, key: &str) -> Result<String, String> {
        params
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| format!("缺少 {key}"))
    }
    fn opt_s(params: &Value, key: &str) -> Option<String> {
        params.get(key).and_then(Value::as_str).map(str::to_string)
    }
    fn strings(params: &Value, key: &str) -> Vec<String> {
        params
            .get(key)
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default()
    }

    match method {
        "list_databases" => {
            let preset = opt_s(&params, "presetDatabase").unwrap_or_else(|| "0".into());
            Ok(json!(
                driver
                    .list_databases(&preset)
                    .await
                    .map_err(|e| e.to_string())?
            ))
        }
        "list_schemas" => Ok(json!(vec!["0".to_string()])),
        "describe_table" => Ok(json!(Vec::<ColumnInfo>::new())),
        "redis_config_get_all" => Ok(encode_query_result(
            &driver.config_get_all().await.map_err(|e| e.to_string())?,
        )),
        "redis_config_get" => Ok(json!(
            driver
                .config_get(&s(&params, "pattern")?)
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_client_list" => Ok(encode_query_result(
            &driver.client_list().await.map_err(|e| e.to_string())?,
        )),
        "redis_search_keys" => {
            let types = strings(&params, "types");
            let result = driver
                .search_keys(
                    &s(&params, "pattern")?,
                    &types,
                    params.get("limit").and_then(Value::as_u64).unwrap_or(100) as usize,
                    params.get("cursor").and_then(Value::as_u64).unwrap_or(0),
                    params
                        .get("includeValuePreview")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::to_value(result).unwrap_or(Value::Null))
        }
        "redis_list_databases" => {
            let preset = opt_s(&params, "presetDatabase").unwrap_or_else(|| "0".into());
            Ok(json!(
                driver
                    .list_databases(&preset)
                    .await
                    .map_err(|e| e.to_string())?
            ))
        }
        "redis_list_databases_with_key_counts" => {
            let preset = opt_s(&params, "presetDatabase").unwrap_or_else(|| "0".into());
            Ok(serde_json::to_value(
                driver
                    .list_databases_with_key_counts(&preset)
                    .await
                    .map_err(|e| e.to_string())?,
            )
            .unwrap_or(Value::Null))
        }
        "redis_dbsize" => Ok(json!(driver.dbsize().await.map_err(|e| e.to_string())?)),
        "redis_key_detail" => Ok(serde_json::to_value(
            driver
                .key_detail(&s(&params, "key")?)
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_set_key" => {
            driver
                .set_key(&s(&params, "key")?, &s(&params, "value")?, &s(&params, "keyType")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_delete_key" => Ok(json!(
            driver
                .delete_key(&s(&params, "key")?)
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_slowlog" => Ok(serde_json::to_value(
            driver
                .slowlog(params.get("count").and_then(Value::as_u64).unwrap_or(16) as usize)
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_client_kill_addr" => Ok(json!(
            driver
                .client_kill_addr(&s(&params, "addr")?)
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_info" => Ok(serde_json::to_value(
            driver
                .info(opt_s(&params, "section").as_deref())
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_memory_stats" => Ok(serde_json::to_value(
            driver.memory_stats().await.map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_memory_doctor" => {
            Ok(json!(driver.memory_doctor().await.map_err(|e| e.to_string())?))
        }
        "redis_memory_purge" => {
            Ok(json!(driver.memory_purge().await.map_err(|e| e.to_string())?))
        }
        "redis_config_set" => {
            driver
                .config_set(&s(&params, "parameter")?, &s(&params, "value")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_config_rewrite" => {
            driver.config_rewrite().await.map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_flush_db" => {
            driver
                .flush_db(params.get("async").and_then(Value::as_bool).unwrap_or(false))
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_flush_all" => {
            driver
                .flush_all(params.get("async").and_then(Value::as_bool).unwrap_or(false))
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_stream_range" => Ok(serde_json::to_value(
            driver
                .stream_range(
                    &s(&params, "key")?,
                    opt_s(&params, "start").as_deref(),
                    opt_s(&params, "end").as_deref(),
                    params
                        .get("count")
                        .and_then(Value::as_u64)
                        .map(|n| n as usize),
                    params.get("reverse").and_then(Value::as_bool).unwrap_or(false),
                )
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_stream_groups" => Ok(serde_json::to_value(
            driver
                .stream_groups(&s(&params, "key")?)
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_stream_consumers" => Ok(serde_json::to_value(
            driver
                .stream_consumers(&s(&params, "key")?, &s(&params, "group")?)
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_stream_pending" => Ok(serde_json::to_value(
            driver
                .stream_pending(
                    &s(&params, "key")?,
                    &s(&params, "group")?,
                    opt_s(&params, "start").as_deref(),
                    opt_s(&params, "end").as_deref(),
                    params
                        .get("count")
                        .and_then(Value::as_u64)
                        .map(|n| n as usize),
                )
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_stream_monitor" => Ok(serde_json::to_value(
            driver
                .stream_monitor(&s(&params, "key")?, opt_s(&params, "group").as_deref())
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_stream_ack" => Ok(json!(
            driver
                .stream_ack(&s(&params, "key")?, &s(&params, "group")?, &strings(&params, "ids"))
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_stream_claim" => Ok(json!(
            driver
                .stream_claim(
                    &s(&params, "key")?,
                    &s(&params, "group")?,
                    &s(&params, "consumer")?,
                    params.get("minIdleMs").and_then(Value::as_u64).unwrap_or(0),
                    &s(&params, "startId")?,
                    params.get("count").and_then(Value::as_u64),
                )
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_stream_group_create" => {
            driver
                .stream_group_create(
                    &s(&params, "key")?,
                    &s(&params, "group")?,
                    &s(&params, "id")?,
                    params.get("mkstream").and_then(Value::as_bool).unwrap_or(false),
                )
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_stream_group_destroy" => {
            driver
                .stream_group_destroy(&s(&params, "key")?, &s(&params, "group")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_stream_trim" => Ok(json!(
            driver
                .stream_trim(
                    &s(&params, "key")?,
                    params.get("maxlen").and_then(Value::as_u64).unwrap_or(0),
                    params
                        .get("approximate")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                )
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_stream_cleanup_inactive_consumers" => Ok(serde_json::to_value(
            driver
                .stream_cleanup_inactive_consumers(
                    &s(&params, "key")?,
                    &s(&params, "group")?,
                    params
                        .get("idleThresholdMs")
                        .and_then(Value::as_u64)
                        .unwrap_or(0),
                    opt_s(&params, "targetConsumer").as_deref(),
                )
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_acl_list" => Ok(serde_json::to_value(
            driver.acl_list().await.map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_acl_getuser" => Ok(serde_json::to_value(
            driver
                .acl_getuser(&s(&params, "username")?)
                .await
                .map_err(|e| e.to_string())?,
        )
        .unwrap_or(Value::Null)),
        "redis_acl_setuser" => {
            driver
                .acl_setuser(&s(&params, "username")?, &s(&params, "rule")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_acl_deluser" => Ok(json!(
            driver
                .acl_deluser(&s(&params, "username")?)
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_hash_set_field" => {
            driver
                .hash_set_field(&s(&params, "key")?, &s(&params, "field")?, &s(&params, "value")?)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "ok": true }))
        }
        "redis_hash_del_fields" => Ok(json!(
            driver
                .hash_del_fields(&s(&params, "key")?, &strings(&params, "fields"))
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_list_push" => Ok(json!(
            driver
                .list_push(&s(&params, "key")?, &s(&params, "side")?, &strings(&params, "values"))
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_list_remove" => Ok(json!(
            driver
                .list_remove(
                    &s(&params, "key")?,
                    params.get("count").and_then(Value::as_i64).unwrap_or(0),
                    &s(&params, "value")?,
                )
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_set_add" => Ok(json!(
            driver
                .set_add(&s(&params, "key")?, &strings(&params, "members"))
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_set_remove" => Ok(json!(
            driver
                .set_remove(&s(&params, "key")?, &strings(&params, "members"))
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_zset_add" => Ok(json!(
            driver
                .zset_add(
                    &s(&params, "key")?,
                    &s(&params, "member")?,
                    params.get("score").and_then(Value::as_f64).unwrap_or(0.0),
                )
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_zset_remove" => Ok(json!(
            driver
                .zset_remove(&s(&params, "key")?, &strings(&params, "members"))
                .await
                .map_err(|e| e.to_string())?
        )),
        "redis_expire_key" => Ok(json!(
            driver
                .expire_key(
                    &s(&params, "key")?,
                    params.get("seconds").and_then(Value::as_i64).unwrap_or(0),
                )
                .await
                .map_err(|e| e.to_string())?
        )),
        unknown => Err(format!("未知方法: {unknown}")),
    }
}
