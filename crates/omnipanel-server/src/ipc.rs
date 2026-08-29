//! `/ipc/invoke` 分发：把 HTTP 请求映射为命令调用（等价于 Tauri `invoke`）。
//!
//! P0 覆盖本地终端链路；P1 新增 DB / SSH / Docker 模块的渐进接入。

use serde::Deserialize;
use serde::Serialize;

use crate::terminal::ServerState;

/// `POST /ipc/invoke` 请求体。
#[derive(Debug, Deserialize)]
pub struct InvokeRequest {
    pub cmd: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// `POST /ipc/invoke` 响应体（成功/失败统一 JSON，前端 shim 据此 resolve/reject）。
#[derive(Debug, Serialize)]
pub struct InvokeResponse<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl InvokeResponse<serde_json::Value> {
    pub fn ok(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}

/// 统一把 `Result<T, E>` 转成响应（T: Serialize）。
fn respond<T: Serialize>(result: Result<T, String>) -> InvokeResponse<serde_json::Value> {
    match result {
        Ok(v) => match serde_json::to_value(v) {
            Ok(json) => InvokeResponse::ok(json),
            Err(e) => InvokeResponse::err(format!("序列化命令结果失败: {e}")),
        },
        Err(e) => InvokeResponse::err(e),
    }
}

fn respond_omni<T: Serialize>(
    result: omnipanel_error::OmniResult<T>,
) -> InvokeResponse<serde_json::Value> {
    match result {
        Ok(v) => match serde_json::to_value(v) {
            Ok(json) => InvokeResponse::ok(json),
            Err(e) => InvokeResponse::err(format!("序列化命令结果失败: {e}")),
        },
        Err(e) => InvokeResponse::err(e.user_message()),
    }
}

/// 分发单条命令。未知命令返回错误（与 Tauri `invoke` 未知命令报错一致）。
pub async fn dispatch(
    state: &std::sync::Arc<ServerState>,
    req: InvokeRequest,
) -> InvokeResponse<serde_json::Value> {
    let args = req.args;
    match req.cmd.as_str() {
        /* ---------------- 本地终端（P0） ---------------- */
        "create_terminal" => {
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let shell = args
                .get("shell")
                .filter(|v| !v.is_null())
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            match state.create_terminal(cols, rows, shell).await {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "write_terminal" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64())
                        .map(|n| n as u8)
                        .collect()
                })
                .unwrap_or_default();
            match state.write_terminal(&id, &data).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "resize_terminal" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match state.resize_terminal(&id, cols, rows).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "close_terminal" => {
            let id = get_str(&args, "id").unwrap_or_default();
            state.close_terminal(&id).await;
            InvokeResponse::ok(serde_json::json!(null))
        }
        "terminal_snapshot" => {
            let id = get_str(&args, "id").unwrap_or_default();
            InvokeResponse::ok(serde_json::json!(state.terminal_snapshot(&id)))
        }
        "list_shells" => {
            let json = state
                .list_shells()
                .map(|shells| serde_json::to_value(shells).unwrap_or(serde_json::json!([])))
                .unwrap_or(serde_json::json!([]));
            InvokeResponse::ok(json)
        }

        /* ---------------- 数据库（P1） ---------------- */
        "db_list_connections" => respond(crate::db::db_list_connections(state).await),
        "db_get_connection_secret" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::db::db_get_connection_secret(state, id).await)
        }
        "db_save_connection" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(crate::db::db_save_connection(state, connection).await)
        }
        "db_delete_connection" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::db::db_delete_connection(state, id).await)
        }
        "db_test_connection" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(crate::db::db_test_connection(state, connection).await)
        }
        "db_list_databases" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(crate::db::db_list_databases(state, connection).await)
        }
        "db_list_databases_with_stats" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(omnipanel_db::db_list_databases_with_stats(connection).await)
        }
        "db_list_connection_users" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(omnipanel_db::db_list_connection_users(connection).await)
        }
        "db_list_character_sets" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(omnipanel_db::db_list_character_sets(connection).await)
        }
        "db_create_database" => {
            let create_args: omnipanel_db::CreateDatabaseArgs =
                match serde_json::from_value(args.get("args").cloned().unwrap_or(args.clone())) {
                    Ok(a) => a,
                    Err(e) => {
                        return InvokeResponse::err(format!("解析 create_database 失败: {e}"));
                    }
                };
            respond(omnipanel_db::db_create_database(create_args).await)
        }
        "db_list_table_details" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(omnipanel_db::db_list_table_details(connection, schema).await)
        }
        "db_get_table_details" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let table = get_str(&args, "table").unwrap_or_default();
            respond(omnipanel_db::db_get_table_details(connection, schema, table).await)
        }
        "db_table_ddl" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let table = get_str(&args, "table").unwrap_or_default();
            respond(omnipanel_db::db_table_ddl(connection, schema, table).await)
        }
        "db_introspect_schema" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(omnipanel_db::db_introspect_schema(connection, schema).await)
        }
        "db_introspect_table" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let table = get_str(&args, "table").unwrap_or_default();
            respond(omnipanel_db::db_introspect_table(connection, schema, table).await)
        }
        "db_redis_config_get_entries" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let pattern = get_str(&args, "pattern").unwrap_or_else(|| "*".into());
            respond(crate::db::db_redis_config_get_entries(connection, pattern).await)
        }
        "db_redis_config_get" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(crate::db::db_redis_config_get(connection).await)
        }
        "db_redis_client_list" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(crate::db::db_redis_client_list(connection).await)
        }
        "db_redis_client_kill" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let addr = get_str(&args, "addr").unwrap_or_default();
            respond(crate::db::db_redis_client_kill(connection, addr).await)
        }
        "db_redis_search_keys" => {
            let search_args: crate::db::RedisSearchKeysArgs =
                match serde_json::from_value(args.get("args").cloned().unwrap_or(args.clone())) {
                    Ok(a) => a,
                    Err(e) => {
                        return InvokeResponse::err(format!("解析 redis_search_keys 失败: {e}"));
                    }
                };
            respond(crate::db::db_redis_search_keys(search_args).await)
        }
        "db_redis_dbsize" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond(crate::db::db_redis_dbsize(connection).await)
        }
        "db_redis_key_detail" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let key = get_str(&args, "key").unwrap_or_default();
            respond(crate::db::db_redis_key_detail(connection, key).await)
        }
        "db_redis_set_key" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let key = get_str(&args, "key").unwrap_or_default();
            let value = get_str(&args, "value").unwrap_or_default();
            let key_type = get_str(&args, "keyType");
            respond(crate::db::db_redis_set_key(connection, key, value, key_type).await)
        }
        "db_redis_delete_key" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let key = get_str(&args, "key").unwrap_or_default();
            respond(crate::db::db_redis_delete_key(connection, key).await)
        }
        "db_redis_slowlog" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let count = args.get("count").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond(crate::db::db_redis_slowlog(connection, count).await)
        }
        "db_qdrant_delete_points" => {
            let qargs: crate::db::QdrantDeletePointsArgs =
                match serde_json::from_value(args.get("args").cloned().unwrap_or(args.clone())) {
                    Ok(a) => a,
                    Err(e) => {
                        return InvokeResponse::err(format!("解析 qdrant_delete_points 失败: {e}"));
                    }
                };
            respond(crate::db::db_qdrant_delete_points(qargs).await)
        }
        "db_save_schema_cache" => {
            let snapshot =
                match serde_json::from_value(args.get("snapshot").cloned().unwrap_or(args.clone()))
                {
                    Ok(s) => s,
                    Err(e) => return InvokeResponse::err(format!("解析 schema cache 失败: {e}")),
                };
            respond(crate::db::db_save_schema_cache(snapshot))
        }
        "db_patch_schema_cache" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let entry = match serde_json::from_value(args.get("entry").cloned().unwrap_or_default())
            {
                Ok(e) => e,
                Err(e) => return InvokeResponse::err(format!("解析 schema entry 失败: {e}")),
            };
            respond(crate::db::db_patch_schema_cache(connection_id, entry))
        }
        "db_load_schema_filters" => respond(crate::db::db_load_schema_filters()),
        "db_save_schema_filters" => {
            let snapshot =
                match serde_json::from_value(args.get("snapshot").cloned().unwrap_or(args.clone()))
                {
                    Ok(s) => s,
                    Err(e) => return InvokeResponse::err(format!("解析 schema filters 失败: {e}")),
                };
            respond(crate::db::db_save_schema_filters(snapshot))
        }
        "db_load_schema_tree_expanded" => respond(crate::db::db_load_schema_tree_expanded()),
        "db_save_schema_tree_expanded" => {
            let snapshot =
                match serde_json::from_value(args.get("snapshot").cloned().unwrap_or(args.clone()))
                {
                    Ok(s) => s,
                    Err(e) => {
                        return InvokeResponse::err(format!("解析 schema tree expanded 失败: {e}"));
                    }
                };
            respond(crate::db::db_save_schema_tree_expanded(snapshot))
        }
        "db_batch_table_ddl" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let tables: Vec<String> = args
                .get("tables")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            respond(crate::db_sync::batch_table_ddl(connection, schema, tables).await)
        }
        "db_data_sync_generate_sql" => {
            let source: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 source 失败: {e}")),
                };
            let target: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 target 失败: {e}")),
                };
            let tables =
                match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                    Ok(t) => t,
                    Err(e) => return InvokeResponse::err(format!("解析 tables 失败: {e}")),
                };
            respond(crate::db_sync::generate_data_sync_sql_script(source, target, tables).await)
        }
        "db_data_sync_read_sql_file" => {
            let path = get_str(&args, "filePath")
                .or_else(|| get_str(&args, "sqlFilePath"))
                .or_else(|| get_str(&args, "path"))
                .unwrap_or_default();
            respond(crate::db_sync::read_sync_sql_file(&path))
        }
        "db_data_sync_write_sql_file" => {
            let sql = get_str(&args, "sql").unwrap_or_default();
            respond(crate::db_sync::save_sync_sql_file(&sql))
        }
        "db_schema_sync_preview_sql" => {
            let source: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 source 失败: {e}")),
                };
            let target: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 target 失败: {e}")),
                };
            let source_db = get_str(&args, "sourceDb").unwrap_or_default();
            let target_db = get_str(&args, "targetDb").unwrap_or_default();
            let tables =
                match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                    Ok(t) => t,
                    Err(e) => return InvokeResponse::err(format!("解析 tables 失败: {e}")),
                };
            let create_missing = args
                .get("createMissingTables")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            respond(
                crate::db_sync::preview_schema_sync_sql(
                    source,
                    target,
                    source_db,
                    target_db,
                    tables,
                    create_missing,
                )
                .await,
            )
        }
        "db_sync_row_diff_page" => {
            let cache_id = get_str(&args, "cacheId").unwrap_or_default();
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as u32;
            let kinds = args
                .get("kinds")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            respond(
                crate::db_sync_diff::db_sync_row_diff_page(cache_id, offset, limit, kinds).await,
            )
        }
        "db_mysql_export_list" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::db_mysql_export::list_mysql_exports(&connection_id))
        }
        "db_mysql_export_delete" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let export_id = get_str(&args, "exportId").unwrap_or_default();
            respond(crate::db_mysql_export::delete_mysql_export(
                &connection_id,
                &export_id,
            ))
        }
        "db_mysql_export_save_as" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let export_id = get_str(&args, "exportId").unwrap_or_default();
            let dest_path = get_str(&args, "destPath").unwrap_or_default();
            respond(crate::db_mysql_export::copy_mysql_export_file(
                &connection_id,
                &export_id,
                &dest_path,
            ))
        }
        "db_list_tables" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(crate::db::db_list_tables(state, connection, schema).await)
        }
        "db_preview_table" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let table = get_str(&args, "table").unwrap_or_default();
            let limit = get_u32(&args, "limit").unwrap_or(200);
            let offset = get_u32(&args, "offset").unwrap_or(0);
            let order_by = args
                .get("orderBy")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let where_clause = args
                .get("whereClause")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(
                crate::db::db_preview_table(
                    state,
                    connection,
                    table,
                    limit,
                    offset,
                    order_by,
                    where_clause,
                )
                .await,
            )
        }
        "db_count_table" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let table = get_str(&args, "table").unwrap_or_default();
            let where_clause = args
                .get("whereClause")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(crate::db::db_count_table(state, connection, schema, table, where_clause).await)
        }
        "db_count_tables" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let tables: Vec<String> = args
                .get("tables")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            respond(crate::db::db_count_tables(state, connection, schema, tables).await)
        }
        "presence_status" => {
            let cap = omnipanel_presence::platform_verifier().status();
            respond(Ok(serde_json::json!({
                "available": cap.available,
                "kind": cap.kind,
                "osEnabled": state.os_presence_enabled.load(std::sync::atomic::Ordering::Relaxed),
            })))
        }
        "presence_set_os_enabled" => {
            let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            state
                .os_presence_enabled
                .store(enabled, std::sync::atomic::Ordering::Relaxed);
            respond(Ok(serde_json::Value::Null))
        }
        "presence_verify" => respond::<()>(Err("本机不支持系统验证".into())),
        "db_drop_table" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let objects: Vec<crate::db::DbDropObject> =
                serde_json::from_value(args.get("objects").cloned().unwrap_or_default())
                    .unwrap_or_default();
            let token = get_str(&args, "presenceToken").unwrap_or_default();
            respond(crate::db::db_drop_table(state, connection, objects, token).await)
        }
        "db_drop_database" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let databases: Vec<String> =
                serde_json::from_value(args.get("databases").cloned().unwrap_or_default())
                    .unwrap_or_default();
            let token = get_str(&args, "presenceToken").unwrap_or_default();
            respond(crate::db::db_drop_database(state, connection, databases, token).await)
        }
        "db_restart_service" => {
            respond(
                crate::db::db_restart_service(
                    state,
                    get_str(&args, "sshConnectionId").unwrap_or_default(),
                    get_str(&args, "service").unwrap_or_default(),
                    get_str(&args, "kind").unwrap_or_default(),
                    get_str(&args, "location").unwrap_or_default(),
                    get_str(&args, "presenceToken").unwrap_or_default(),
                )
                .await,
            )
        }
        "presence_issue_typed" => {
            let action = get_str(&args, "action").unwrap_or_default();
            let target = get_str(&args, "target").unwrap_or_default();
            let typed = get_str(&args, "typed").unwrap_or_default();
            respond(
                match omnipanel_presence::expected_typed(&action, &target) {
                    Ok(expected) if typed.trim() == expected => state
                        .presence_tokens
                        .issue(&action, &target)
                        .map(|issued| serde_json::to_value(issued).unwrap_or_default())
                        .map_err(|e| e.to_string()),
                    Ok(_) => Err("输入内容不匹配".into()),
                    Err(e) => Err(e.to_string()),
                },
            )
        }
        "db_execute_query" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let sql = get_str(&args, "sql").unwrap_or_default();
            let run_id = get_str(&args, "runId").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            let offset = args
                .get("offset")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let presence_token = args
                .get("presenceToken")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(
                crate::db::db_execute_query(
                    state,
                    connection,
                    sql,
                    run_id,
                    limit,
                    offset,
                    presence_token,
                )
                .await,
            )
        }
        "db_cancel_query" => {
            let run_id = get_str(&args, "runId").unwrap_or_default();
            respond(crate::db::db_cancel_query(state, run_id).await)
        }
        "db_run_sql" => {
            let connection: omnipanel_store::DbConnectionConfig =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let schema = args
                .get("schema")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let sql = get_str(&args, "sql").unwrap_or_default();
            respond(crate::db::db_run_sql(state, connection, schema, sql).await)
        }
        "db_load_schema_cache" => match omnipanel_store::load_schema_cache() {
            Ok(snapshot) => match serde_json::to_value(snapshot) {
                Ok(json) => InvokeResponse::ok(json),
                Err(e) => InvokeResponse::err(format!("序列化 schema cache 失败: {e}")),
            },
            Err(e) => InvokeResponse::err(e.user_message()),
        },
        "db_refresh_schema_node" => {
            let refresh_args: omnipanel_db::SchemaNodeRefreshArgs =
                match serde_json::from_value(args.clone()) {
                    Ok(a) => a,
                    Err(e) => {
                        return InvokeResponse::err(format!(
                            "解析 db_refresh_schema_node 失败: {e}"
                        ));
                    }
                };
            respond(omnipanel_db::db_refresh_schema_node(refresh_args).await)
        }
        "db_sql_files_load" => respond_omni(crate::store_bridge::db_sql_files_load(state).await),
        "db_sql_files_save" => {
            let file =
                match serde_json::from_value(args.get("file").cloned().unwrap_or(args.clone())) {
                    Ok(f) => f,
                    Err(e) => {
                        return InvokeResponse::err(format!("解析 db_sql_files_save 失败: {e}"));
                    }
                };
            respond_omni(crate::store_bridge::db_sql_files_save(state, file).await)
        }
        "db_tree_chart_files_load" => {
            respond_omni(crate::store_bridge::db_tree_chart_files_load(state).await)
        }
        "db_tree_chart_files_save" => {
            let file =
                match serde_json::from_value(args.get("file").cloned().unwrap_or(args.clone())) {
                    Ok(f) => f,
                    Err(e) => {
                        return InvokeResponse::err(format!(
                            "解析 db_tree_chart_files_save 失败: {e}"
                        ));
                    }
                };
            respond_omni(crate::store_bridge::db_tree_chart_files_save(state, file).await)
        }
        "bg_task_list" => respond_omni(crate::bg_task_cmds::bg_task_list(state).await),
        "bg_task_cancel" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::bg_task_cmds::bg_task_cancel(state, id).await)
        }
        "bg_task_history_list" => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::bg_task_cmds::bg_task_history_list(state, limit).await)
        }
        "bg_task_submit_db_schema_cache_refresh" => {
            let connection_ids = args
                .get("connectionIds")
                .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok());
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_schema_cache_refresh(state, connection_ids)
                    .await,
            )
        }
        "bg_task_submit_db_data_sync" => {
            let source =
                match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 source 失败: {e}")),
                };
            let target =
                match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 target 失败: {e}")),
                };
            let tables =
                match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                    Ok(t) => t,
                    Err(e) => return InvokeResponse::err(format!("解析 tables 失败: {e}")),
                };
            let ignored_fields = args
                .get("ignoredFields")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_data_sync(
                    state,
                    source,
                    target,
                    tables,
                    ignored_fields,
                )
                .await,
            )
        }
        "bg_task_submit_db_data_sync_execute" => {
            let source =
                match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 source 失败: {e}")),
                };
            let target =
                match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 target 失败: {e}")),
                };
            let tables =
                match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                    Ok(t) => t,
                    Err(e) => return InvokeResponse::err(format!("解析 tables 失败: {e}")),
                };
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_data_sync_execute(
                    state, source, target, tables,
                )
                .await,
            )
        }
        "bg_task_submit_db_schema_sync" => {
            let source =
                match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 source 失败: {e}")),
                };
            let target =
                match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 target 失败: {e}")),
                };
            let tables =
                match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                    Ok(t) => t,
                    Err(e) => return InvokeResponse::err(format!("解析 tables 失败: {e}")),
                };
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_schema_sync(state, source, target, tables)
                    .await,
            )
        }
        "bg_task_submit_db_schema_sync_execute" => {
            let source =
                match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 source 失败: {e}")),
                };
            let target =
                match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 target 失败: {e}")),
                };
            let tables =
                match serde_json::from_value(args.get("tables").cloned().unwrap_or_default()) {
                    Ok(t) => t,
                    Err(e) => return InvokeResponse::err(format!("解析 tables 失败: {e}")),
                };
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_schema_sync_execute(
                    state, source, target, tables,
                )
                .await,
            )
        }
        "bg_task_submit_db_data_sync_sql_execute" => {
            let target =
                match serde_json::from_value(args.get("target").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 target 失败: {e}")),
                };
            let sql_file_path = get_str(&args, "sqlFilePath").unwrap_or_default();
            let table_names: Vec<String> = args
                .get("tableNames")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_data_sync_sql_execute(
                    state,
                    target,
                    sql_file_path,
                    table_names,
                )
                .await,
            )
        }
        "bg_task_submit_db_mysql_export" => {
            let connection =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let database_name = get_str(&args, "databaseName").unwrap_or_default();
            let deployment =
                match serde_json::from_value(args.get("deployment").cloned().unwrap_or_default()) {
                    Ok(d) => d,
                    Err(e) => return InvokeResponse::err(format!("解析 deployment 失败: {e}")),
                };
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_mysql_export(
                    state,
                    connection,
                    database_name,
                    deployment,
                )
                .await,
            )
        }
        "bg_task_submit_db_mysql_import" => {
            let connection =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let database_name = get_str(&args, "databaseName").unwrap_or_default();
            let deployment =
                match serde_json::from_value(args.get("deployment").cloned().unwrap_or_default()) {
                    Ok(d) => d,
                    Err(e) => return InvokeResponse::err(format!("解析 deployment 失败: {e}")),
                };
            let source =
                match serde_json::from_value(args.get("source").cloned().unwrap_or_default()) {
                    Ok(s) => s,
                    Err(e) => return InvokeResponse::err(format!("解析 source 失败: {e}")),
                };
            respond_omni(
                crate::bg_task_cmds::bg_task_submit_db_mysql_import(
                    state,
                    connection,
                    database_name,
                    deployment,
                    source,
                )
                .await,
            )
        }
        "bg_task_submit_knowledge_vectorize" => respond_omni(
            crate::bg_task_cmds::bg_task_submit_knowledge_vectorize(state, args.clone()).await,
        ),

        /* ---------------- SSH（P1） ---------------- */
        "ssh_list_connections" => respond(crate::ssh::ssh_list_connections(state).await),
        "ssh_connect_connection" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let pane_id = args
                .get("paneId")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            match crate::ssh::ssh_connect_connection(state, connection_id, cols, rows, pane_id)
                .await
            {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e.to_string()),
            }
        }
        "ssh_write" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64())
                        .map(|n| n as u8)
                        .collect()
                })
                .unwrap_or_default();
            match crate::ssh::ssh_write(state, id, data).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e.to_string()),
            }
        }
        "ssh_resize" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::ssh::ssh_resize(state, id, cols, rows).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e.to_string()),
            }
        }
        "ssh_disconnect" => {
            let id = get_str(&args, "id").unwrap_or_default();
            match crate::ssh::ssh_disconnect(state, id).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e.to_string()),
            }
        }

        /* ---------------- Docker（P1） ---------------- */
        "docker_list_connections" => respond(crate::docker::docker_list_connections(state).await),
        "docker_get_connection_secret" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::docker::docker_get_connection_secret(state, id).await)
        }
        "docker_probe_connection" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker::docker_probe_connection(state, connection_id).await)
        }
        "docker_get_overview" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker::docker_get_overview(state, connection_id).await)
        }
        "docker_list_containers" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let filter = args
                .get("filter")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(crate::docker::docker_list_containers(state, connection_id, filter).await)
        }
        "docker_get_local_engine_status" => {
            respond(crate::docker::docker_get_local_engine_status().await)
        }
        "docker_reset_ssh_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker::docker_reset_ssh_session(state, connection_id).await)
        }

        /* ---------------- Docker（P2：写操作 / 镜像 / 卷 / 网络 / compose / daemon / exec / 流式） ---------------- */
        "docker_list_container_stats" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_ids = args
                .get("containerIds")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(str::to_string))
                        .collect::<Vec<_>>()
                });
            respond(
                crate::docker_ops::docker_list_container_stats(state, connection_id, container_ids)
                    .await,
            )
        }
        "docker_inspect_container" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(
                crate::docker_ops::docker_inspect_container(state, connection_id, container_id)
                    .await,
            )
        }
        "docker_container_action" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let action = get_str(&args, "action").unwrap_or_default();
            respond(
                crate::docker_ops::docker_container_action(
                    state,
                    connection_id,
                    container_id,
                    action,
                )
                .await,
            )
        }
        "docker_container_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let tail = args.get("tail").and_then(|v| v.as_i64()).unwrap_or(500) as i32;
            let since = args
                .get("since")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(
                crate::docker_ops::docker_container_logs(
                    state,
                    connection_id,
                    container_id,
                    tail,
                    since,
                )
                .await,
            )
        }
        "docker_clear_container_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(
                crate::docker_ops::docker_clear_container_logs(state, connection_id, container_id)
                    .await,
            )
        }
        "docker_list_container_log_infos" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_container_log_infos(state, connection_id).await)
        }
        "docker_create_container" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerCreateContainerRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(r) => r,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond(crate::docker_ops::docker_create_container(state, connection_id, request).await)
        }
        "docker_list_images" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_images(state, connection_id).await)
        }
        "docker_remove_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let image_id = get_str(&args, "imageId").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(
                crate::docker_ops::docker_remove_image(state, connection_id, image_id, force).await,
            )
        }
        "docker_inspect_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let image_id = get_str(&args, "imageId").unwrap_or_default();
            respond(crate::docker_ops::docker_inspect_image(state, connection_id, image_id).await)
        }
        "docker_image_history" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let image_id = get_str(&args, "imageId").unwrap_or_default();
            respond(crate::docker_ops::docker_image_history(state, connection_id, image_id).await)
        }
        "docker_prune_images" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_prune_images(state, connection_id).await)
        }
        "docker_search_images" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let term = get_str(&args, "term").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(25) as u32;
            respond(
                crate::docker_ops::docker_search_images(state, connection_id, term, limit).await,
            )
        }
        "docker_prune_build_cache" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_prune_build_cache(state, connection_id).await)
        }
        "docker_tag_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let source = get_str(&args, "source").unwrap_or_default();
            let target = get_str(&args, "target").unwrap_or_default();
            respond(crate::docker_ops::docker_tag_image(state, connection_id, source, target).await)
        }
        "docker_pull_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let image = get_str(&args, "image").unwrap_or_default();
            let channel = get_str(&args, "progressChannel").unwrap_or_default();
            respond(
                crate::docker_ops::docker_pull_image(state, connection_id, image, channel).await,
            )
        }
        "docker_push_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let image = get_str(&args, "image").unwrap_or_default();
            let channel = get_str(&args, "progressChannel").unwrap_or_default();
            respond(
                crate::docker_ops::docker_push_image(state, connection_id, image, channel).await,
            )
        }
        "docker_build_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let context: omnipanel_docker::DockerBuildContext =
                match serde_json::from_value(args.get("context").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 context 失败: {e}")),
                };
            let channel = get_str(&args, "progressChannel").unwrap_or_default();
            respond(
                crate::docker_ops::docker_build_image(state, connection_id, context, channel).await,
            )
        }
        "docker_host_run_cli" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let command = get_str(&args, "command").unwrap_or_default();
            let channel = get_str(&args, "progressChannel").unwrap_or_default();
            respond(
                crate::docker_ops::docker_host_run_cli(state, connection_id, command, channel)
                    .await,
            )
        }
        "docker_list_volumes" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_volumes(state, connection_id).await)
        }
        "docker_create_volume" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerCreateVolumeRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(r) => r,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond(crate::docker_ops::docker_create_volume(state, connection_id, request).await)
        }
        "docker_remove_volume" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(
                crate::docker_ops::docker_remove_volume(state, connection_id, name, force).await,
            )
        }
        "docker_inspect_volume" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            respond(crate::docker_ops::docker_inspect_volume(state, connection_id, name).await)
        }
        "docker_prune_volumes" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_prune_volumes(state, connection_id).await)
        }
        "docker_list_networks" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_networks(state, connection_id).await)
        }
        "docker_create_network" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerCreateNetworkRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(r) => r,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond(crate::docker_ops::docker_create_network(state, connection_id, request).await)
        }
        "docker_remove_network" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            respond(crate::docker_ops::docker_remove_network(state, connection_id, name).await)
        }
        "docker_prune_networks" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_prune_networks(state, connection_id).await)
        }
        "docker_inspect_network" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            respond(crate::docker_ops::docker_inspect_network(state, connection_id, name).await)
        }
        "docker_connect_network" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let network = get_str(&args, "network").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(
                crate::docker_ops::docker_connect_network(
                    state,
                    connection_id,
                    network,
                    container_id,
                )
                .await,
            )
        }
        "docker_disconnect_network" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let network = get_str(&args, "network").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(
                crate::docker_ops::docker_disconnect_network(
                    state,
                    connection_id,
                    network,
                    container_id,
                )
                .await,
            )
        }
        "docker_list_compose_projects" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_compose_projects(state, connection_id).await)
        }
        "docker_compose_action" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let action: omnipanel_docker::DockerComposeAction =
                match serde_json::from_value(args.get("action").cloned().unwrap_or_default()) {
                    Ok(a) => a,
                    Err(e) => return InvokeResponse::err(format!("解析 action 失败: {e}")),
                };
            let request: omnipanel_docker::DockerComposeRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(r) => r,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond(
                crate::docker_ops::docker_compose_action(state, connection_id, action, request)
                    .await,
            )
        }
        "docker_read_compose_files" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerComposeReadFilesRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(r) => r,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond(
                crate::docker_ops::docker_read_compose_files(state, connection_id, request).await,
            )
        }
        "docker_write_compose_files" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerComposeWriteFilesRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(r) => r,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond(
                crate::docker_ops::docker_write_compose_files(state, connection_id, request).await,
            )
        }
        "docker_read_daemon_config" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_read_daemon_config(state, connection_id).await)
        }
        "docker_write_daemon_config" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let content = get_str(&args, "content").unwrap_or_default();
            respond(
                crate::docker_ops::docker_write_daemon_config(state, connection_id, content).await,
            )
        }
        "docker_restart_daemon" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_restart_daemon(state, connection_id).await)
        }
        "docker_start_local_engine" => {
            respond(crate::docker_ops::docker_start_local_engine().await)
        }
        "docker_get_system_disk_usage" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_get_system_disk_usage(state, connection_id).await)
        }
        "docker_list_container_dir" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond(
                crate::docker_ops::docker_list_container_dir(
                    state,
                    connection_id,
                    container_id,
                    path,
                )
                .await,
            )
        }
        "docker_read_container_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let max_bytes = args
                .get("maxBytes")
                .and_then(|v| v.as_i64())
                .unwrap_or(16 * 1024 * 1024);
            respond(
                crate::docker_ops::docker_read_container_file(
                    state,
                    connection_id,
                    container_id,
                    path,
                    max_bytes,
                )
                .await,
            )
        }
        "docker_write_container_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64())
                        .map(|n| n as u8)
                        .collect()
                })
                .unwrap_or_default();
            respond(
                crate::docker_ops::docker_write_container_file(
                    state,
                    connection_id,
                    container_id,
                    path,
                    data,
                )
                .await,
            )
        }
        "docker_list_volume_dir" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let volume_name = get_str(&args, "volumeName").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond(
                crate::docker_ops::docker_list_volume_dir(state, connection_id, volume_name, path)
                    .await,
            )
        }
        "docker_read_volume_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let volume_name = get_str(&args, "volumeName").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let max_bytes = args
                .get("maxBytes")
                .and_then(|v| v.as_i64())
                .unwrap_or(16 * 1024 * 1024);
            respond(
                crate::docker_ops::docker_read_volume_file(
                    state,
                    connection_id,
                    volume_name,
                    path,
                    max_bytes,
                )
                .await,
            )
        }
        "docker_stream_container_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let tail = args.get("tail").and_then(|v| v.as_i64()).unwrap_or(500) as i32;
            let since = args
                .get("since")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let follow = args
                .get("follow")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            respond(
                crate::docker_ops::docker_stream_container_logs(
                    state,
                    connection_id,
                    container_id,
                    tail,
                    since,
                    follow,
                )
                .await,
            )
        }
        "docker_stop_log_stream" => {
            let stream_id = get_str(&args, "streamId").unwrap_or_default();
            respond(crate::docker_ops::docker_stop_log_stream(state, stream_id).await)
        }
        "docker_stream_stats" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(
                crate::docker_ops::docker_stream_stats(state, connection_id, container_id).await,
            )
        }
        "docker_stop_stats_stream" => {
            let stream_id = get_str(&args, "streamId").unwrap_or_default();
            respond(crate::docker_ops::docker_stop_stats_stream(state, stream_id).await)
        }
        "docker_exec_command" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let command = get_str(&args, "command").unwrap_or_default();
            respond(
                crate::docker_ops::docker_exec_command(state, connection_id, container_id, command)
                    .await,
            )
        }
        "docker_create_exec_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let shell = args
                .get("shell")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::docker_ops::docker_create_exec_session(
                state,
                connection_id,
                container_id,
                shell,
                cols,
                rows,
            )
            .await
            {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "docker_create_host_shell_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::docker_ops::docker_create_host_shell_session(
                state,
                connection_id,
                cols,
                rows,
            )
            .await
            {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "docker_exec_write" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64())
                        .map(|n| n as u8)
                        .collect()
                })
                .unwrap_or_default();
            respond(crate::docker_ops::docker_exec_write(state, session_id, data).await)
        }
        "docker_exec_resize" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            respond(crate::docker_ops::docker_exec_resize(state, session_id, cols, rows).await)
        }
        "docker_exec_close" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            respond(crate::docker_ops::docker_exec_close(state, session_id).await)
        }

        /* ---------------- 文件管理器（P2：本机 + SFTP） ---------------- */
        "file_list_connections" => respond(crate::files::file_list_connections(state).await),
        "file_list_dir" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let search = args
                .get("search")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            let continuation_token = args
                .get("continuationToken")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(
                crate::files::file_list_dir(state, connection_id, path, search, continuation_token)
                    .await,
            )
        }
        "file_s3_search" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let query = get_str(&args, "query").unwrap_or_default();
            let continuation_token = args
                .get("continuationToken")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(
                crate::files::file_s3_search(state, connection_id, query, continuation_token).await,
            )
        }
        "file_read_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let max_bytes = args
                .get("maxBytes")
                .and_then(|v| v.as_f64())
                .unwrap_or(10.0 * 1024.0 * 1024.0);
            respond(crate::files::file_read_file(state, connection_id, path, max_bytes).await)
        }
        "file_upload_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64())
                        .map(|n| n as u8)
                        .collect()
                })
                .unwrap_or_default();
            respond(crate::files::file_upload_file(state, connection_id, path, data).await)
        }
        "file_mkdir" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond(crate::files::file_mkdir(state, connection_id, path).await)
        }
        "file_rename" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let old_path = get_str(&args, "oldPath").unwrap_or_default();
            let new_path = get_str(&args, "newPath").unwrap_or_default();
            respond(crate::files::file_rename(state, connection_id, old_path, new_path).await)
        }
        "file_s3_copy_object" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let from_path = get_str(&args, "fromPath").unwrap_or_default();
            let to_path = get_str(&args, "toPath").unwrap_or_default();
            respond(
                crate::files::file_s3_copy_object(state, connection_id, from_path, to_path).await,
            )
        }
        "file_delete" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let entry_kind = args
                .get("entryKind")
                .and_then(|v| v.as_str())
                .map(str::to_string);
            respond(crate::files::file_delete(state, connection_id, path, entry_kind).await)
        }
        "file_local_quick_paths" => respond(crate::files::file_local_quick_paths().await),
        "file_local_system_info" => respond(crate::files::file_local_system_info().await),
        "file_upload_local_bytes" => {
            let file_name = get_str(&args, "fileName").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64())
                        .map(|n| n as u8)
                        .collect()
                })
                .unwrap_or_default();
            let dest_connection_id = get_str(&args, "destConnectionId").unwrap_or_default();
            let dest_dir = get_str(&args, "destDir").unwrap_or_default();
            respond(
                crate::files::file_upload_local_bytes(
                    state,
                    file_name,
                    data,
                    dest_connection_id,
                    dest_dir,
                )
                .await,
            )
        }
        "file_download_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let remote_path = get_str(&args, "remotePath").unwrap_or_default();
            let local_path = get_str(&args, "localPath").unwrap_or_default();
            respond(
                crate::files::file_download_file(state, connection_id, remote_path, local_path)
                    .await,
            )
        }
        "file_upload_local_path_multipart" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let dest_path = get_str(&args, "destPath").unwrap_or_default();
            let local_path = get_str(&args, "localPath").unwrap_or_default();
            let chunk_size = args
                .get("chunkSize")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize);
            respond(
                crate::files::file_upload_local_path_multipart(
                    state,
                    connection_id,
                    dest_path,
                    local_path,
                    chunk_size,
                )
                .await,
            )
        }
        "file_download_s3_range_to_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let remote_path = get_str(&args, "remotePath").unwrap_or_default();
            let local_path = get_str(&args, "localPath").unwrap_or_default();
            let chunk_size = args.get("chunkSize").and_then(|v| v.as_u64());
            respond(
                crate::files::file_download_s3_range_to_file(
                    state,
                    connection_id,
                    remote_path,
                    local_path,
                    chunk_size,
                )
                .await,
            )
        }

        /* ---------------- 跨连接文件 relay（P3） ---------------- */
        "transfer_start" => {
            let req: crate::transfer::TransferStartRequest = match serde_json::from_value(args) {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 transfer_start 请求失败: {e}")),
            };
            respond(crate::transfer::transfer_start(state.clone(), req).await)
        }
        "transfer_cancel" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::transfer::transfer_cancel(state, id).await)
        }
        "file_transfer_list" => respond(crate::file_transfer::file_transfer_list(state).await),
        "file_transfer_plan" => {
            let request: crate::file_transfer::FileTransferPlanRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or(args)) {
                    Ok(r) => r,
                    Err(e) => {
                        return InvokeResponse::err(format!(
                            "解析 file_transfer_plan 请求失败: {e}"
                        ));
                    }
                };
            respond(crate::file_transfer::file_transfer_plan(state, request).await)
        }
        "file_transfer_enqueue" => {
            let request: crate::file_transfer::FileTransferEnqueueRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or(args)) {
                    Ok(r) => r,
                    Err(e) => {
                        return InvokeResponse::err(format!(
                            "解析 file_transfer_enqueue 请求失败: {e}"
                        ));
                    }
                };
            respond(crate::file_transfer::file_transfer_enqueue(state.clone(), request).await)
        }
        "file_transfer_upload_local_bytes" => {
            let file_name = get_str(&args, "fileName").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|n| n.as_u64())
                        .map(|n| n as u8)
                        .collect()
                })
                .unwrap_or_default();
            let dest_connection_id = get_str(&args, "destConnectionId").unwrap_or_default();
            let dest_dir = get_str(&args, "destDir").unwrap_or_default();
            let conflict_policy: crate::file_transfer::FileTransferConflictPolicy = args
                .get("conflictPolicy")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or(crate::file_transfer::FileTransferConflictPolicy::Overwrite);
            respond(
                crate::file_transfer::file_transfer_upload_local_bytes(
                    state.clone(),
                    file_name,
                    data,
                    dest_connection_id,
                    dest_dir,
                    conflict_policy,
                )
                .await,
            )
        }
        "file_transfer_cancel" => {
            let job_id = get_str(&args, "jobId").unwrap_or_default();
            respond(crate::file_transfer::file_transfer_cancel(state, job_id).await)
        }
        "file_transfer_retry" => {
            let job_id = get_str(&args, "jobId").unwrap_or_default();
            respond(crate::file_transfer::file_transfer_retry(state.clone(), job_id).await)
        }
        "file_transfer_clear_finished" => {
            respond(crate::file_transfer::file_transfer_clear_finished(state).await)
        }
        "file_transfer_dismiss" => {
            let job_id = get_str(&args, "jobId").unwrap_or_default();
            respond(crate::file_transfer::file_transfer_dismiss(state, job_id).await)
        }
        "file_transfer_set_concurrency" => {
            let concurrency = args
                .get("concurrency")
                .and_then(|v| v.as_u64())
                .unwrap_or(2) as u32;
            respond(crate::file_transfer::file_transfer_set_concurrency(state, concurrency).await)
        }
        "file_transfer_set_rate_limit" => {
            let rate_limit_bps = args.get("rateLimitBps").and_then(|v| v.as_f64());
            respond(crate::file_transfer::file_transfer_set_rate_limit(rate_limit_bps).await)
        }
        "sftp_probe_media" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::log_tail::sftp_probe_media(state, id, path).await)
        }
        "sftp_open_media_stream" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::log_tail::sftp_open_media_stream(state, id, path).await)
        }
        "sftp_close_media_stream" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::log_tail::sftp_close_media_stream(state, token).await)
        }
        "sftp_log_open" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::log_tail::sftp_log_open(state, id, path).await)
        }
        "sftp_log_read_lines" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let start_line = args
                .get("startLine")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0);
            let end_line = args
                .get("endLine")
                .and_then(|v| v.as_f64())
                .unwrap_or(start_line);
            respond_omni(
                crate::log_tail::sftp_log_read_lines(state, id, path, start_line, end_line).await,
            )
        }
        "sftp_log_tail_initial" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(200) as u32;
            respond_omni(crate::log_tail::sftp_log_tail_initial(state, id, path, lines).await)
        }
        "sftp_log_tail_start" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let lines_after = args
                .get("linesAfter")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            respond_omni(crate::log_tail::sftp_log_tail_start(state, id, path, lines_after).await)
        }
        "sftp_log_tail_stop" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::log_tail::sftp_log_tail_stop(state, token).await)
        }
        "local_log_open" => {
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::log_tail::local_log_open(path).await)
        }
        "local_log_read_lines" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let start_line = args
                .get("startLine")
                .and_then(|v| v.as_f64())
                .unwrap_or(1.0);
            let end_line = args
                .get("endLine")
                .and_then(|v| v.as_f64())
                .unwrap_or(start_line);
            respond_omni(crate::log_tail::local_log_read_lines(path, start_line, end_line).await)
        }
        "local_log_tail_initial" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(200) as u32;
            respond_omni(crate::log_tail::local_log_tail_initial(path, lines).await)
        }
        "local_log_tail_start" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let lines_after = args
                .get("linesAfter")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            respond_omni(crate::log_tail::local_log_tail_start(state, path, lines_after).await)
        }
        "local_log_tail_stop" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::log_tail::local_log_tail_stop(token).await)
        }

        /* ---------------- AI（P2：HTTP 流式对话 + 流式 HTTP 代理） ---------------- */
        "ai_chat_stream" => {
            let req: crate::ai::AiChatStreamArgs = match serde_json::from_value(args) {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 ai_chat_stream 请求失败: {e}")),
            };
            respond(crate::ai::ai_chat_stream(state, req).await)
        }
        "ai_chat_cancel" => {
            let conversation_id = get_str(&args, "conversationId").unwrap_or_default();
            respond(crate::ai::ai_chat_cancel(state, conversation_id).await)
        }
        "ai_chat_tool_result" => {
            let conversation_id = get_str(&args, "conversationId").unwrap_or_default();
            let tool_call_id = get_str(&args, "toolCallId").unwrap_or_default();
            let result = get_str(&args, "result").unwrap_or_default();
            let approved = args
                .get("approved")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            respond(
                crate::ai::ai_chat_tool_result(
                    state,
                    conversation_id,
                    tool_call_id,
                    result,
                    approved,
                )
                .await,
            )
        }
        "ai_http_stream_post" => {
            let req: crate::ai::AiHttpStreamRequest = match serde_json::from_value(args) {
                Ok(r) => r,
                Err(e) => {
                    return InvokeResponse::err(format!("解析 ai_http_stream_post 请求失败: {e}"));
                }
            };
            respond(crate::ai::ai_http_stream_post(state, req).await)
        }
        "ai_list_backends" => respond(crate::ai::ai_list_backends().await),
        "ai_gateway_configure" => {
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let port = args.get("port").and_then(|v| v.as_u64()).unwrap_or(8765) as u16;
            let api_key = get_str(&args, "apiKey");
            let bind_lan = args
                .get("bindLan")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let mcp_external_require_approval = args
                .get("mcpExternalRequireApproval")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            respond(
                crate::ai::ai_gateway_configure(
                    state,
                    enabled,
                    port,
                    api_key,
                    bind_lan,
                    mcp_external_require_approval,
                )
                .await,
            )
        }
        "ai_models_load" => respond(crate::store_bridge::ai_models_load().await),
        "ai_models_save" => {
            let file: crate::store_bridge::AiModelsFile =
                match serde_json::from_value(args.get("file").cloned().unwrap_or(args.clone())) {
                    Ok(f) => f,
                    Err(e) => return InvokeResponse::err(format!("解析 ai_models_save 失败: {e}")),
                };
            respond(crate::store_bridge::ai_models_save(file).await)
        }
        "ai_models_resolve_api_key" => {
            let provider_id = args
                .get("providerId")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            respond(crate::store_bridge::ai_models_resolve_api_key(provider_id).await)
        }
        "ai_models_fetch_list" => {
            let base_url = get_str(&args, "baseUrl").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let api_standard = get_str(&args, "apiStandard");
            respond(
                crate::store_bridge::ai_models_fetch_list(base_url, api_key, api_standard).await,
            )
        }

        /* ---------------- 启动热路径：连接 / 模块 / HTTP 协议库 / 隧道 / 本机监控 ---------------- */
        "conn_list" => respond_omni(crate::store_bridge::conn_list(state).await),
        "conn_save" => {
            let connection =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            respond_omni(crate::store_bridge::conn_save(state, connection).await)
        }
        "conn_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::store_bridge::conn_delete(state, id).await)
        }
        "conn_test" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::store_bridge::conn_test(state, id).await)
        }
        "app_module_list" => respond_omni(crate::store_bridge::app_module_list(state).await),
        "app_module_set_status" => {
            let key = get_str(&args, "key").unwrap_or_default();
            let status = get_str(&args, "status").unwrap_or_default();
            respond_omni(crate::store_bridge::app_module_set_status(state, key, status).await)
        }
        "builtin_tool_list" => respond_omni(crate::store_bridge::builtin_tool_list(state).await),
        "builtin_tool_sync_catalog" => {
            let entries =
                match serde_json::from_value(args.get("entries").cloned().unwrap_or_default()) {
                    Ok(e) => e,
                    Err(e) => return InvokeResponse::err(format!("解析 entries 失败: {e}")),
                };
            respond_omni(crate::store_bridge::builtin_tool_sync_catalog(state, entries).await)
        }
        "builtin_tool_set_enabled" => {
            let tool_name = get_str(&args, "toolName").unwrap_or_default();
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            respond_omni(
                crate::store_bridge::builtin_tool_set_enabled(state, tool_name, enabled).await,
            )
        }
        "builtin_tool_audit_list" => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::store_bridge::builtin_tool_audit_list(state, limit).await)
        }
        "http_list_requests" => {
            let collection_id = get_str(&args, "collectionId");
            respond(crate::store_bridge::http_list_requests(state, collection_id).await)
        }
        "http_save_request" => {
            let req = match serde_json::from_value(args.get("req").cloned().unwrap_or(args.clone()))
            {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond(crate::store_bridge::http_save_request(state, req).await)
        }
        "http_delete_request" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::store_bridge::http_delete_request(state, id).await)
        }
        "http_list_collections" => respond(crate::store_bridge::http_list_collections(state).await),
        "http_save_collection" => {
            let col = match serde_json::from_value(args.get("col").cloned().unwrap_or(args.clone()))
            {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 collection 失败: {e}")),
            };
            respond(crate::store_bridge::http_save_collection(state, col).await)
        }
        "http_delete_collection" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::store_bridge::http_delete_collection(state, id).await)
        }
        "http_list_environments" => {
            respond(crate::store_bridge::http_list_environments(state).await)
        }
        "http_save_environment" => {
            let env = match serde_json::from_value(args.get("env").cloned().unwrap_or(args.clone()))
            {
                Ok(e) => e,
                Err(e) => return InvokeResponse::err(format!("解析 environment 失败: {e}")),
            };
            respond(crate::store_bridge::http_save_environment(state, env).await)
        }
        "http_delete_environment" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::store_bridge::http_delete_environment(state, id).await)
        }
        "http_list_history" => {
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(200);
            respond(crate::store_bridge::http_list_history(state, limit).await)
        }
        "http_add_history" => {
            let entry =
                match serde_json::from_value(args.get("entry").cloned().unwrap_or(args.clone())) {
                    Ok(e) => e,
                    Err(e) => return InvokeResponse::err(format!("解析 history entry 失败: {e}")),
                };
            respond(crate::store_bridge::http_add_history(state, entry).await)
        }
        "http_delete_history" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::store_bridge::http_delete_history(state, id).await)
        }
        "http_rename_history" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let label = get_str(&args, "label").unwrap_or_default();
            respond(crate::store_bridge::http_rename_history(state, id, label).await)
        }
        "http_clear_history" => respond(crate::store_bridge::http_clear_history(state).await),
        "http_clear_history_for_request" => {
            let request_id = get_str(&args, "requestId").unwrap_or_default();
            respond(crate::store_bridge::http_clear_history_for_request(state, request_id).await)
        }
        "ssh_list_tunnels" => respond_omni(crate::store_bridge::ssh_list_tunnels(state).await),
        "ssh_create_tunnel" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let tunnel_type = get_str(&args, "tunnelType").unwrap_or_else(|| "local".into());
            let local_port = args.get("localPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let remote_host = get_str(&args, "remoteHost").unwrap_or_default();
            let remote_port = args.get("remotePort").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            respond_omni(
                crate::store_bridge::ssh_create_tunnel(
                    state,
                    connection_id,
                    tunnel_type,
                    local_port,
                    remote_host,
                    remote_port,
                )
                .await,
            )
        }
        "ssh_close_tunnel" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::store_bridge::ssh_close_tunnel(state, id).await)
        }
        "ssh_list_keys" => respond_omni(crate::store_bridge::ssh_list_keys().await),
        "ssh_sync_config_hosts" => respond_omni(crate::store_bridge::ssh_sync_config_hosts().await),
        "local_fetch_stats" => respond_omni(crate::monitoring::local_fetch_stats().await),
        "local_list_processes" => respond_omni(crate::monitoring::local_list_processes().await),
        "ssh_pool_fetch_stats" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::monitoring::ssh_pool_fetch_stats(state, &resource_id).await)
        }
        "ssh_pool_load_processes" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::monitoring::ssh_pool_load_processes(state, &resource_id).await)
        }
        "set_proxy_config" => {
            let config = args.get("config").cloned().unwrap_or(args.clone());
            respond(crate::store_bridge::set_proxy_config(config).await)
        }
        "docker_load_sidebar_cache" => {
            respond(crate::store_bridge::docker_load_sidebar_cache().await)
        }

        /* ---------------- MCP 外部服务桥接（P4） ---------------- */
        "mcp_list_services" => respond(crate::mcp::mcp_list_services(state).await),
        "mcp_upsert_service" => {
            let input: crate::mcp::UpsertMcpServiceInput =
                match serde_json::from_value(args.get("input").cloned().unwrap_or_default()) {
                    Ok(i) => i,
                    Err(e) => return InvokeResponse::err(format!("解析 input 失败: {e}")),
                };
            respond(crate::mcp::mcp_upsert_service(state, input).await)
        }
        "mcp_delete_service" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::mcp::mcp_delete_service(state, id).await)
        }
        "mcp_set_service_enabled" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            respond(crate::mcp::mcp_set_service_enabled(state, id, enabled).await)
        }
        "mcp_set_service_running" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let running = args
                .get("running")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            respond(crate::mcp::mcp_set_service_running(state, id, running).await)
        }
        "mcp_list_service_tools" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::mcp::mcp_list_service_tools(state, id).await)
        }
        "mcp_call_tool" => {
            let service_id = get_str(&args, "serviceId").unwrap_or_default();
            let tool_name = get_str(&args, "toolName").unwrap_or_default();
            let tool_arguments = get_str(&args, "toolArguments").unwrap_or_default();
            respond(crate::mcp::mcp_call_tool(state, service_id, tool_name, tool_arguments).await)
        }
        "mcp_set_external_require_approval" => {
            let require = args
                .get("require")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            respond(crate::mcp::mcp_set_external_require_approval(state, require).await)
        }

        /* ---------------- 终端历史 / 连接池 / 本地进程 ---------------- */
        "terminal_history_load_session" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            respond_omni(
                crate::terminal_history::terminal_history_load_session(state, session_id).await,
            )
        }
        "terminal_history_upsert_blocks" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            let workspace_id = get_str(&args, "workspaceId");
            let blocks =
                match serde_json::from_value(args.get("blocks").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid blocks: {e}")),
                };
            let policy =
                match serde_json::from_value(args.get("policy").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid policy: {e}")),
                };
            respond_omni(
                crate::terminal_history::terminal_history_upsert_blocks(
                    state,
                    session_id,
                    workspace_id,
                    blocks,
                    policy,
                )
                .await,
            )
        }
        "terminal_history_remove_block" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            let block_id = get_str(&args, "blockId").unwrap_or_default();
            respond_omni(
                crate::terminal_history::terminal_history_remove_block(state, session_id, block_id)
                    .await,
            )
        }
        "terminal_history_clear_session" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            respond_omni(
                crate::terminal_history::terminal_history_clear_session(state, session_id).await,
            )
        }
        "terminal_history_clear_all" => {
            respond_omni(crate::terminal_history::terminal_history_clear_all(state).await)
        }
        "terminal_history_counts" => {
            respond_omni(crate::terminal_history::terminal_history_counts(state).await)
        }
        "pool_get_summary" => respond_omni(crate::pool::pool_get_summary(state).await),
        "local_process_detail" => {
            let pid = args.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            respond_omni(crate::monitoring::local_process_detail(pid).await)
        }
        "local_kill_process" => {
            let pid = args.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            respond_omni(crate::monitoring::local_kill_process(pid).await)
        }
        "ssh_pool_subscribe_monitoring" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::monitoring::ssh_pool_subscribe_monitoring(&resource_id).await)
        }
        "ssh_pool_unsubscribe_monitoring" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::monitoring::ssh_pool_unsubscribe_monitoring(&resource_id).await)
        }
        "get_proxy_config" => respond_omni(crate::docker_ssh_detect::get_proxy_config().await),

        /* ---------------- SSH 池 / SFTP CRUD ---------------- */
        "ssh_pool_exec_command" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let command = get_str(&args, "command").unwrap_or_default();
            respond_omni(crate::ssh_ops::ssh_pool_exec_command(state, resource_id, command).await)
        }
        "ssh_pool_process_detail" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let pid = args.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            respond_omni(crate::ssh_ops::ssh_pool_process_detail(state, resource_id, pid).await)
        }
        "ssh_pool_kill_process" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let pid = args.get("pid").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let signal = args
                .get("signal")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            respond_omni(
                crate::ssh_ops::ssh_pool_kill_process(state, resource_id, pid, signal).await,
            )
        }
        "ssh_pool_create_run_script" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            let content = get_str(&args, "content").unwrap_or_default();
            let script_args: Option<Vec<String>> = args
                .get("args")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let timeout_secs = args.get("timeoutSecs").and_then(|v| v.as_u64());
            respond_omni(
                crate::ssh_ops::ssh_pool_create_run_script(
                    state,
                    resource_id,
                    name,
                    content,
                    script_args,
                    timeout_secs,
                )
                .await,
            )
        }
        "ssh_pool_load_overview" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::ssh_ops::ssh_pool_load_overview(state, resource_id).await)
        }
        "ssh_pool_release" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::ssh_ops::ssh_pool_release(state, resource_id).await)
        }
        "ssh_pool_get_active_sessions" => {
            respond_omni(crate::ssh_ops::ssh_pool_get_active_sessions(state).await)
        }
        "ssh_pool_probe_all" => respond_omni(crate::ssh_ops::ssh_pool_probe_all(state).await),
        "ssh_pool_download_install_binary" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let url = get_str(&args, "url").unwrap_or_default();
            let dest = get_str(&args, "dest").unwrap_or_default();
            respond_omni(
                crate::ssh_ops::ssh_pool_download_install_binary(state, resource_id, url, dest)
                    .await,
            )
        }
        "sftp_list" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::ssh_ops::sftp_list(state, id, path).await)
        }
        "sftp_download" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::ssh_ops::sftp_download(state, id, path).await)
        }
        "sftp_upload" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let data = match args.get("data").and_then(|v| v.as_str()).map(|s| {
                use base64::{Engine as _, engine::general_purpose::STANDARD};
                STANDARD.decode(s).map_err(|e| e.to_string())
            }) {
                Some(Ok(b)) => b,
                Some(Err(e)) => return InvokeResponse::err(e),
                None => match serde_json::from_value::<Vec<u8>>(
                    args.get("data").cloned().unwrap_or_default(),
                ) {
                    Ok(b) => b,
                    Err(e) => return InvokeResponse::err(format!("invalid data: {e}")),
                },
            };
            respond_omni(crate::ssh_ops::sftp_upload(state, id, path, data).await)
        }
        "sftp_mkdir" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::ssh_ops::sftp_mkdir(state, id, path).await)
        }
        "sftp_remove" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::ssh_ops::sftp_remove(state, id, path).await)
        }
        "sftp_rename" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let from = get_str(&args, "from")
                .or_else(|| get_str(&args, "oldPath"))
                .unwrap_or_default();
            let to = get_str(&args, "to")
                .or_else(|| get_str(&args, "newPath"))
                .unwrap_or_default();
            respond_omni(crate::ssh_ops::sftp_rename(state, id, from, to).await)
        }
        "sftp_chmod" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let mode = args.get("mode").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            respond_omni(crate::ssh_ops::sftp_chmod(state, id, path, mode).await)
        }

        /* ---------------- Docker Swarm / SSH 探测 / 侧栏缓存 ---------------- */
        "docker_swarm_init" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let listen_addr = get_str(&args, "listenAddr");
            let advertise_addr = get_str(&args, "advertiseAddr");
            respond(
                crate::docker_swarm::docker_swarm_init(
                    state,
                    connection_id,
                    listen_addr,
                    advertise_addr,
                )
                .await,
            )
        }
        "docker_swarm_join" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let remote_addrs: Vec<String> = args
                .get("remoteAddrs")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let token = get_str(&args, "token").unwrap_or_default();
            let listen_addr = get_str(&args, "listenAddr");
            respond(
                crate::docker_swarm::docker_swarm_join(
                    state,
                    connection_id,
                    remote_addrs,
                    token,
                    listen_addr,
                )
                .await,
            )
        }
        "docker_swarm_leave" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(crate::docker_swarm::docker_swarm_leave(state, connection_id, force).await)
        }
        "docker_swarm_inspect" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_swarm::docker_swarm_inspect(state, connection_id).await)
        }
        "docker_service_list" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_swarm::docker_service_list(state, connection_id).await)
        }
        "docker_service_create" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request = match serde_json::from_value(
                args.get("request").cloned().unwrap_or(args.clone()),
            ) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid request: {e}")),
            };
            respond(crate::docker_swarm::docker_service_create(state, connection_id, request).await)
        }
        "docker_service_update" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let service_id = get_str(&args, "serviceId").unwrap_or_default();
            let replicas = args.get("replicas").and_then(|v| v.as_f64());
            let image = get_str(&args, "image");
            respond(
                crate::docker_swarm::docker_service_update(
                    state,
                    connection_id,
                    service_id,
                    replicas,
                    image,
                )
                .await,
            )
        }
        "docker_service_remove" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let service_id = get_str(&args, "serviceId").unwrap_or_default();
            respond(
                crate::docker_swarm::docker_service_remove(state, connection_id, service_id).await,
            )
        }
        "docker_service_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let service_id = get_str(&args, "serviceId").unwrap_or_default();
            let tail = get_str(&args, "tail").or_else(|| {
                args.get("tail")
                    .and_then(|v| v.as_u64())
                    .map(|n| n.to_string())
            });
            respond(
                crate::docker_swarm::docker_service_logs(state, connection_id, service_id, tail)
                    .await,
            )
        }
        "docker_node_list" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_swarm::docker_node_list(state, connection_id).await)
        }
        "docker_node_inspect" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let node_id = get_str(&args, "nodeId").unwrap_or_default();
            respond(crate::docker_swarm::docker_node_inspect(state, connection_id, node_id).await)
        }
        "docker_node_update" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let node_id = get_str(&args, "nodeId").unwrap_or_default();
            let availability = get_str(&args, "availability");
            let labels: Option<Vec<_>> = args
                .get("labels")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            respond(
                crate::docker_swarm::docker_node_update(
                    state,
                    connection_id,
                    node_id,
                    availability,
                    labels,
                )
                .await,
            )
        }
        "docker_node_remove" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let node_id = get_str(&args, "nodeId").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(
                crate::docker_swarm::docker_node_remove(state, connection_id, node_id, force).await,
            )
        }
        "docker_stack_deploy" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            let compose = get_str(&args, "composeContent")
                .or_else(|| get_str(&args, "compose"))
                .unwrap_or_default();
            let env: Option<Vec<String>> = args
                .get("env")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            respond(
                crate::docker_swarm::docker_stack_deploy(state, connection_id, name, compose, env)
                    .await,
            )
        }
        "docker_stack_list" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_swarm::docker_stack_list(state, connection_id).await)
        }
        "docker_stack_remove" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            respond(crate::docker_swarm::docker_stack_remove(state, connection_id, name).await)
        }
        "docker_stack_services" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            respond(crate::docker_swarm::docker_stack_services(state, connection_id, name).await)
        }
        "docker_probe_ssh_docker" => {
            let ssh_connection_id = get_str(&args, "sshConnectionId")
                .or_else(|| get_str(&args, "connectionId"))
                .unwrap_or_default();
            respond_omni(
                crate::docker_ssh_detect::docker_probe_ssh_docker(state, ssh_connection_id).await,
            )
        }
        "docker_list_ssh_hosts" => {
            respond_omni(crate::docker_ssh_detect::docker_list_ssh_hosts(state).await)
        }
        "docker_scan_ssh_docker_hosts" => {
            let auto_save = args
                .get("autoSave")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            respond_omni(
                crate::docker_ssh_detect::docker_scan_ssh_docker_hosts(state, auto_save).await,
            )
        }
        "docker_patch_sidebar_cache" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let patch = args.get("patch").cloned().unwrap_or(serde_json::json!({}));
            respond(crate::store_bridge::docker_patch_sidebar_cache(connection_id, patch).await)
        }
        "docker_remove_sidebar_cache" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::store_bridge::docker_remove_sidebar_cache(connection_id).await)
        }
        "docker_list_sidebar_cache_page" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let category = get_str(&args, "category").unwrap_or_default();
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as u32;
            respond(
                crate::store_bridge::docker_list_sidebar_cache_page(
                    connection_id,
                    category,
                    offset,
                    limit,
                )
                .await,
            )
        }

        /* ---------------- Skills / Provider / Embedding / WebSearch ---------------- */
        "skill_list" => respond(crate::skills_cmds::skill_list().await),
        "skill_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::skill_get(id).await)
        }
        "skill_create" => {
            let input =
                match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
                };
            respond(crate::skills_cmds::skill_create(state, input).await)
        }
        "skill_update" => {
            let input =
                match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
                };
            respond(crate::skills_cmds::skill_update(state, input).await)
        }
        "skill_remove" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::skill_remove(state, id).await)
        }
        "skill_set_enabled" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            respond(crate::skills_cmds::skill_set_enabled(state, id, enabled).await)
        }
        "skill_import" => {
            let source_path = get_str(&args, "sourcePath").unwrap_or_default();
            respond(crate::skills_cmds::skill_import(state, source_path).await)
        }
        "skill_get_db" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::skill_get_db(state, id).await)
        }
        "skill_list_db" => respond(crate::skills_cmds::skill_list_db(state).await),
        "skill_get_version_chain" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::skill_get_version_chain(state, id).await)
        }
        "skill_list_applications" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let limit = args
                .get("limit")
                .and_then(|v| v.as_f64())
                .or_else(|| args.get("limit").and_then(|v| v.as_u64()).map(|n| n as f64));
            respond(crate::skills_cmds::skill_list_applications(state, id, limit).await)
        }
        "skill_update_application_outcome" => {
            let application_id = get_str(&args, "applicationId").unwrap_or_default();
            let outcome = get_str(&args, "outcome").unwrap_or_default();
            let feedback = get_str(&args, "feedback");
            respond(
                crate::skills_cmds::skill_update_application_outcome(
                    state,
                    application_id,
                    outcome,
                    feedback,
                )
                .await,
            )
        }
        "skill_vectorize" => {
            let args_in = match serde_json::from_value(args.clone()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
            };
            respond(crate::skills_cmds::skill_vectorize(state, args_in).await)
        }
        "skill_vector_status" => {
            let skill_id = get_str(&args, "skillId").unwrap_or_default();
            respond(crate::skills_cmds::skill_vector_status(state, skill_id).await)
        }
        "skill_vectorize_all" => {
            let provider =
                match serde_json::from_value(args.get("provider").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid provider: {e}")),
                };
            respond(crate::skills_cmds::skill_vectorize_all(state, provider).await)
        }
        "agent_prompt_list" => respond(crate::skills_cmds::agent_prompt_list().await),
        "agent_prompt_save" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let content = get_str(&args, "content").unwrap_or_default();
            respond(crate::skills_cmds::agent_prompt_save(id, content).await)
        }
        "agent_prompt_reset" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::agent_prompt_reset(id).await)
        }
        "provider_registry_load" => respond(crate::skills_cmds::provider_registry_load().await),
        "provider_registry_save" => {
            let file =
                match serde_json::from_value(args.get("file").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid file: {e}")),
                };
            respond(crate::skills_cmds::provider_registry_save(file).await)
        }
        "provider_list_models_cmd" => {
            let provider_id = get_str(&args, "providerId").unwrap_or_default();
            respond(crate::skills_cmds::provider_list_models(&provider_id))
        }
        "cli_provider_list_cmd" => respond(crate::skills_cmds::cli_provider_list()),
        "cli_provider_patch_cmd" => {
            let input =
                match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
                };
            respond(crate::skills_cmds::cli_provider_patch(input))
        }
        "cli_provider_upsert_cmd" => {
            let input =
                match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
                };
            respond(crate::skills_cmds::cli_provider_upsert(input))
        }
        "cli_provider_remove_cmd" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::cli_provider_remove(&id))
        }
        "embedding_provider_get" => {
            respond_omni(crate::embedding_cmds::embedding_provider_get().await)
        }
        "embedding_provider_sync" => {
            let provider =
                match serde_json::from_value(args.get("provider").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid provider: {e}")),
                };
            respond_omni(crate::embedding_cmds::embedding_provider_sync(provider).await)
        }
        "web_search_get_config" => {
            respond_omni(crate::web_search_cmds::web_search_get_config().await)
        }
        "web_search_set_config" => {
            let config =
                match serde_json::from_value(args.get("config").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid config: {e}")),
                };
            respond_omni(crate::web_search_cmds::web_search_set_config(config).await)
        }
        "web_search_set_exa_key" => {
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_exa_key(api_key).await)
        }
        "web_search_exa_key_configured" => {
            respond_omni(crate::web_search_cmds::web_search_exa_key_configured().await)
        }
        "web_search_set_jina_key" => {
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_jina_key(api_key).await)
        }
        "web_search_jina_key_configured" => {
            respond_omni(crate::web_search_cmds::web_search_jina_key_configured().await)
        }
        "web_search_set_zhihu_secret" => {
            let secret = get_str(&args, "secret").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_zhihu_secret(secret).await)
        }
        "web_search_zhihu_secret_configured" => {
            respond_omni(crate::web_search_cmds::web_search_zhihu_secret_configured().await)
        }
        "web_search_test_backend" => {
            let backend = get_str(&args, "backend").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_test_backend(backend).await)
        }
        "web_search_test_fetch" => {
            let url = get_str(&args, "url").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_test_fetch(url).await)
        }
        "ai_list_sessions" => {
            let source = get_str(&args, "source");
            respond_omni(crate::store_bridge::ai_list_sessions(state, source).await)
        }
        "ai_list_session_traces" => {
            let session_id = get_str(&args, "sessionId")
                .or_else(|| get_str(&args, "conversationId"))
                .unwrap_or_default();
            respond_omni(crate::store_bridge::ai_list_session_traces(state, session_id).await)
        }
        "builtin_tool_set_internal_enabled" => {
            let tool_name = get_str(&args, "toolName").unwrap_or_default();
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            respond_omni(
                crate::store_bridge::builtin_tool_set_internal_enabled(state, tool_name, enabled)
                    .await,
            )
        }
        "builtin_tool_set_external_exposed" => {
            let tool_name = get_str(&args, "toolName").unwrap_or_default();
            let exposed = args
                .get("exposed")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            respond_omni(
                crate::store_bridge::builtin_tool_set_external_exposed(state, tool_name, exposed)
                    .await,
            )
        }

        /* ---------------- Knowledge / Tags / Todo ---------------- */
        "knowledge_list" => {
            let kind = get_str(&args, "kind");
            let tag = get_str(&args, "tag");
            respond_omni(crate::knowledge_cmds::knowledge_list(state, kind, tag).await)
        }
        "knowledge_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_get(state, id).await)
        }
        "knowledge_save" => {
            let entry =
                match serde_json::from_value(args.get("entry").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid entry: {e}")),
                };
            respond_omni(crate::knowledge_cmds::knowledge_save(state, entry).await)
        }
        "knowledge_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_delete(state, id).await)
        }
        "knowledge_search" => {
            let query = get_str(&args, "query").unwrap_or_default();
            let kind = get_str(&args, "kind");
            respond_omni(crate::knowledge_cmds::knowledge_search(state, query, kind).await)
        }
        "knowledge_tags" => respond_omni(crate::knowledge_cmds::knowledge_tags(state).await),
        "knowledge_increment_usage" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_increment_usage(state, id).await)
        }
        "knowledge_list_revisions" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_list_revisions(state, entry_id).await)
        }
        "knowledge_restore_revision" => {
            let revision_id = get_str(&args, "revisionId").unwrap_or_default();
            respond_omni(
                crate::knowledge_cmds::knowledge_restore_revision(state, revision_id).await,
            )
        }
        "knowledge_save_asset" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let file_name = get_str(&args, "fileName").unwrap_or_default();
            let bytes = match serde_json::from_value::<Vec<u8>>(
                args.get("bytes")
                    .cloned()
                    .or_else(|| args.get("data").cloned())
                    .unwrap_or_default(),
            ) {
                Ok(b) => b,
                Err(e) => return InvokeResponse::err(format!("invalid bytes: {e}")),
            };
            respond_omni(
                crate::knowledge_cmds::knowledge_save_asset(entry_id, file_name, bytes).await,
            )
        }
        "knowledge_asset_path" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let file_name = get_str(&args, "fileName").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_asset_path(entry_id, file_name).await)
        }
        "knowledge_list_chunks" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let offset = args
                .get("offset")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(
                crate::knowledge_cmds::knowledge_list_chunks(state, entry_id, offset, limit).await,
            )
        }
        "knowledge_import_pdf" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let parent_id = get_str(&args, "parentId");
            respond_omni(crate::knowledge_cmds::knowledge_import_pdf(state, path, parent_id).await)
        }
        "knowledge_delete_chunks" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let chunk_ids: Vec<String> = args
                .get("chunkIds")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            respond_omni(
                crate::knowledge_cmds::knowledge_delete_chunks(state, entry_id, chunk_ids).await,
            )
        }
        "knowledge_todo_list" => {
            respond_omni(crate::knowledge_cmds::knowledge_todo_list(state).await)
        }
        "knowledge_todo_save" => {
            let list =
                match serde_json::from_value(args.get("list").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid list: {e}")),
                };
            respond_omni(crate::knowledge_cmds::knowledge_todo_save(state, list).await)
        }
        "knowledge_todo_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_todo_delete(state, id).await)
        }
        "knowledge_vectorize" => {
            let args_in =
                match serde_json::from_value(args.get("args").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
                };
            respond_omni(crate::knowledge_vector_cmds::knowledge_vectorize(state, args_in).await)
        }
        "knowledge_vector_status" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            respond_omni(
                crate::knowledge_vector_cmds::knowledge_vector_status(state, entry_id).await,
            )
        }
        "knowledge_recall_test" => {
            let args_in =
                match serde_json::from_value(args.get("args").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
                };
            respond_omni(crate::knowledge_vector_cmds::knowledge_recall_test(state, args_in).await)
        }
        "knowledge_query_document" => {
            let args_in =
                match serde_json::from_value(args.get("args").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
                };
            respond_omni(
                crate::knowledge_vector_cmds::knowledge_query_document(state, args_in).await,
            )
        }
        "tag_list_tree" => {
            let include_counts = args.get("includeCounts").and_then(|v| v.as_bool());
            respond_omni(crate::knowledge_cmds::tag_list_tree(state, include_counts).await)
        }
        "tag_list_used_by" => {
            let include_counts = args.get("includeCounts").and_then(|v| v.as_bool());
            let resource_kinds: Option<Vec<String>> = args
                .get("resourceKinds")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let connection_kinds: Option<Vec<String>> = args
                .get("connectionKinds")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let extra_resource_ids: Option<Vec<String>> = args
                .get("extraResourceIds")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let include_ancestors = args.get("includeAncestors").and_then(|v| v.as_bool());
            respond_omni(
                crate::knowledge_cmds::tag_list_used_by(
                    state,
                    include_counts,
                    resource_kinds,
                    connection_kinds,
                    extra_resource_ids,
                    include_ancestors,
                )
                .await,
            )
        }
        "tag_create" => {
            let name = get_str(&args, "name").unwrap_or_default();
            let parent_id = get_str(&args, "parentId");
            let color = get_str(&args, "color");
            respond_omni(crate::knowledge_cmds::tag_create(state, name, parent_id, color).await)
        }
        "tag_rename" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::tag_rename(state, id, name).await)
        }
        "tag_move" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let parent_id = get_str(&args, "parentId").or_else(|| get_str(&args, "newParentId"));
            respond_omni(crate::knowledge_cmds::tag_move(state, id, parent_id).await)
        }
        "tag_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let cascade = args.get("cascade").and_then(|v| v.as_bool());
            respond_omni(crate::knowledge_cmds::tag_delete(state, id, cascade).await)
        }
        "tag_set_color" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let color = get_str(&args, "color");
            respond_omni(crate::knowledge_cmds::tag_set_color(state, id, color).await)
        }
        "resource_list_tags" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_list_tags(state, kind, resource_id).await)
        }
        "resource_set_tags" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let paths: Vec<String> = args
                .get("paths")
                .or_else(|| args.get("tagIds"))
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            respond_omni(
                crate::knowledge_cmds::resource_set_tags(state, kind, resource_id, paths).await,
            )
        }
        "resource_add_tag" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let path = get_str(&args, "path")
                .or_else(|| get_str(&args, "tagId"))
                .unwrap_or_default();
            let source = get_str(&args, "source");
            respond_omni(
                crate::knowledge_cmds::resource_add_tag(state, kind, resource_id, path, source)
                    .await,
            )
        }
        "resource_remove_tag" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let tag_id = get_str(&args, "tagId").unwrap_or_default();
            respond_omni(
                crate::knowledge_cmds::resource_remove_tag(state, kind, resource_id, tag_id).await,
            )
        }
        "resource_set_system_tag" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let key = get_str(&args, "key").unwrap_or_default();
            let value = get_str(&args, "value").unwrap_or_default();
            respond_omni(
                crate::knowledge_cmds::resource_set_system_tag(
                    state,
                    kind,
                    resource_id,
                    key,
                    value,
                )
                .await,
            )
        }
        "tag_query_resources" => {
            let tag_ids: Vec<String> = args
                .get("tagIds")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            let mode = get_str(&args, "mode");
            let kinds: Option<Vec<String>> = args
                .get("kinds")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let include_descendants = args.get("includeDescendants").and_then(|v| v.as_bool());
            respond_omni(
                crate::knowledge_cmds::tag_query_resources(
                    state,
                    tag_ids,
                    mode,
                    kinds,
                    include_descendants,
                )
                .await,
            )
        }
        "tag_suggest" => {
            let query = get_str(&args, "query").unwrap_or_default();
            let limit = args
                .get("limit")
                .and_then(|v| v.as_f64())
                .or_else(|| args.get("limit").and_then(|v| v.as_u64()).map(|n| n as f64));
            respond_omni(crate::knowledge_cmds::tag_suggest(state, query, limit).await)
        }
        "search_everywhere" => {
            let query = get_str(&args, "query").unwrap_or_default();
            let tag_ids: Option<Vec<String>> = args
                .get("tagIds")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            let mode = get_str(&args, "mode");
            let limit = args
                .get("limit")
                .and_then(|v| v.as_f64())
                .or_else(|| args.get("limit").and_then(|v| v.as_u64()).map(|n| n as f64));
            respond_omni(
                crate::knowledge_cmds::search_everywhere(state, query, tag_ids, mode, limit).await,
            )
        }
        "todo_list_list" => respond_omni(crate::knowledge_cmds::todo_list_list(state).await),
        "todo_list_save" => {
            let list =
                match serde_json::from_value(args.get("list").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid list: {e}")),
                };
            respond_omni(crate::knowledge_cmds::todo_list_save(state, list).await)
        }
        "todo_list_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::todo_list_delete(state, id).await)
        }
        "todo_task_list" => {
            let query =
                match serde_json::from_value(args.get("query").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid query: {e}")),
                };
            respond_omni(crate::knowledge_cmds::todo_task_list(state, query).await)
        }
        "todo_task_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::todo_task_get(state, id).await)
        }
        "todo_task_save" => {
            let task =
                match serde_json::from_value(args.get("task").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid task: {e}")),
                };
            let replace_steps = args
                .get("replaceSteps")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            respond_omni(crate::knowledge_cmds::todo_task_save(state, task, replace_steps).await)
        }
        "todo_task_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::todo_task_delete(state, id).await)
        }
        "todo_step_save" => {
            let step =
                match serde_json::from_value(args.get("step").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid step: {e}")),
                };
            respond_omni(crate::knowledge_cmds::todo_step_save(state, step).await)
        }
        "todo_step_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::todo_step_delete(state, id).await)
        }
        "resource_list_profiles" => {
            let kind = get_str(&args, "resourceType").or_else(|| get_str(&args, "kind"));
            respond_omni(crate::knowledge_cmds::resource_list_profiles(state, kind).await)
        }
        "resource_get_profile" => {
            let kind = get_str(&args, "resourceType")
                .or_else(|| get_str(&args, "kind"))
                .unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(
                crate::knowledge_cmds::resource_get_profile(state, kind, resource_id).await,
            )
        }
        "resource_find_similar" => {
            let kind = get_str(&args, "resourceType")
                .or_else(|| get_str(&args, "kind"))
                .unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let limit = args
                .get("limit")
                .and_then(|v| v.as_f64())
                .or_else(|| args.get("limit").and_then(|v| v.as_u64()).map(|n| n as f64));
            respond_omni(
                crate::knowledge_cmds::resource_find_similar(state, kind, resource_id, limit).await,
            )
        }
        "resource_delete_observations" => {
            let kind = get_str(&args, "resourceType")
                .or_else(|| get_str(&args, "kind"))
                .unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(
                crate::knowledge_cmds::resource_delete_observations(state, kind, resource_id).await,
            )
        }
        "resource_list_knowledge" => {
            let kind = get_str(&args, "resourceType")
                .or_else(|| get_str(&args, "kind"))
                .unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let limit = args
                .get("limit")
                .and_then(|v| v.as_f64())
                .or_else(|| args.get("limit").and_then(|v| v.as_u64()).map(|n| n as f64));
            respond_omni(
                crate::knowledge_cmds::resource_list_knowledge(state, kind, resource_id, limit)
                    .await,
            )
        }
        "resource_save_observation" => {
            let observation = match serde_json::from_value(
                args.get("observation")
                    .cloned()
                    .or_else(|| args.get("obs").cloned())
                    .unwrap_or(args.clone()),
            ) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid observation: {e}")),
            };
            respond_omni(crate::knowledge_cmds::resource_save_observation(state, observation).await)
        }

        /* ---------------- Workflow ---------------- */
        "workflow_list" => respond_omni(crate::workflow_cmds::workflow_list(state).await),
        "workflow_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::workflow_cmds::workflow_get(state, id).await)
        }
        "workflow_save" => {
            let req = match serde_json::from_value(args.get("req").cloned().unwrap_or(args.clone()))
            {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid req: {e}")),
            };
            respond_omni(crate::workflow_cmds::workflow_save(state, req).await)
        }
        "workflow_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::workflow_cmds::workflow_delete(state, id).await)
        }
        "workflow_executions" => {
            let workflow_id = get_str(&args, "workflowId").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(50) as u32;
            respond_omni(crate::workflow_cmds::workflow_executions(state, workflow_id, limit).await)
        }
        "workflow_get_execution" => {
            let execution_id = get_str(&args, "executionId")
                .or_else(|| get_str(&args, "id"))
                .unwrap_or_default();
            respond_omni(crate::workflow_cmds::workflow_get_execution(state, execution_id).await)
        }
        "workflow_run" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::workflow_cmds::workflow_run(state, id).await)
        }
        "workflow_stop" => {
            let execution_id = get_str(&args, "executionId").unwrap_or_default();
            respond_omni(crate::workflow_cmds::workflow_stop(state, execution_id).await)
        }

        /* ---------------- gRPC / Modbus ---------------- */
        "grpc_connect" => {
            let config =
                match serde_json::from_value(args.get("config").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid config: {e}")),
                };
            respond(crate::protocol_cmds::grpc_connect(state, config).await)
        }
        "grpc_call" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid request: {e}")),
                };
            respond(crate::protocol_cmds::grpc_call(state, connection_id, request).await)
        }
        "grpc_close" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::protocol_cmds::grpc_close(state, connection_id).await)
        }
        "grpc_list_connections" => {
            respond(crate::protocol_cmds::grpc_list_connections(state).await)
        }
        "modbus_connect" => {
            let config =
                match serde_json::from_value(args.get("config").cloned().unwrap_or(args.clone())) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("invalid config: {e}")),
                };
            respond(crate::protocol_cmds::modbus_connect(state, config).await)
        }
        "modbus_disconnect" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::protocol_cmds::modbus_disconnect(state, id).await)
        }
        "modbus_read_coils" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let qty = args.get("qty").and_then(|v| v.as_u64()).unwrap_or(1) as u16;
            respond(crate::protocol_cmds::modbus_read_coils(state, id, addr, qty).await)
        }
        "modbus_read_discrete_inputs" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let qty = args.get("qty").and_then(|v| v.as_u64()).unwrap_or(1) as u16;
            respond(crate::protocol_cmds::modbus_read_discrete_inputs(state, id, addr, qty).await)
        }
        "modbus_read_holding_registers" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let qty = args.get("qty").and_then(|v| v.as_u64()).unwrap_or(1) as u16;
            respond(crate::protocol_cmds::modbus_read_holding_registers(state, id, addr, qty).await)
        }
        "modbus_read_input_registers" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let qty = args.get("qty").and_then(|v| v.as_u64()).unwrap_or(1) as u16;
            respond(crate::protocol_cmds::modbus_read_input_registers(state, id, addr, qty).await)
        }
        "modbus_write_single_coil" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let value = args.get("value").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(crate::protocol_cmds::modbus_write_single_coil(state, id, addr, value).await)
        }
        "modbus_write_single_register" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let value = args.get("value").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            respond(
                crate::protocol_cmds::modbus_write_single_register(state, id, addr, value).await,
            )
        }
        "modbus_write_multiple_coils" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let values: Vec<bool> = args
                .get("values")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            respond(
                crate::protocol_cmds::modbus_write_multiple_coils(state, id, addr, values).await,
            )
        }
        "modbus_write_multiple_registers" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let values: Vec<u16> = args
                .get("values")
                .and_then(|v| serde_json::from_value(v.clone()).ok())
                .unwrap_or_default();
            respond(
                crate::protocol_cmds::modbus_write_multiple_registers(state, id, addr, values)
                    .await,
            )
        }

        "ssh_generate_key" => {
            let key_type = get_str(&args, "keyType").unwrap_or_default();
            let bits = args.get("bits").and_then(|v| v.as_u64()).map(|n| n as u32);
            let comment = get_str(&args, "comment").unwrap_or_default();
            let passphrase = get_str(&args, "passphrase").unwrap_or_default();
            let name = get_str(&args, "name");
            respond_omni(
                crate::ssh_keys::ssh_generate_key(key_type, bits, comment, passphrase, name).await,
            )
        }
        "ssh_import_key" => {
            let name = get_str(&args, "name").unwrap_or_default();
            let private_key = get_str(&args, "privateKey").unwrap_or_default();
            respond_omni(crate::ssh_keys::ssh_import_key(name, private_key).await)
        }
        "ssh_delete_key" => {
            let name = get_str(&args, "name").unwrap_or_default();
            respond_omni(crate::ssh_keys::ssh_delete_key(name).await)
        }
        "ssh_read_key_private" => {
            let name = get_str(&args, "name").unwrap_or_default();
            respond_omni(crate::ssh_keys::ssh_read_key_private(name).await)
        }
        "ssh_read_key_public" => {
            let name = get_str(&args, "name").unwrap_or_default();
            respond_omni(crate::ssh_keys::ssh_read_key_public(name).await)
        }
        "ssh_connect" => {
            let config: omnipanel_ssh::SshConfig =
                match serde_json::from_value(args.get("config").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 config 失败: {e}")),
                };
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let pane_id = args
                .get("paneId")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            match crate::ssh::ssh_connect(state, config, cols, rows, pane_id).await {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e.user_message()),
            }
        }
        "ssh_connect_config_host" => {
            let alias = get_str(&args, "alias").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::ssh::ssh_connect_config_host(state, alias, cols, rows).await {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e.user_message()),
            }
        }
        "ssh_list_config_hosts" => respond_omni(crate::ssh::ssh_list_config_hosts().await),
        "ssh_process_list" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::ssh::ssh_process_list(state, id).await)
        }
        "ssh_pool_get_statuses" => respond_omni(crate::ssh::ssh_pool_get_statuses(state).await),
        "set_terminal_tmux_mode" => {
            let mode = get_str(&args, "mode").unwrap_or_default();
            respond_omni(crate::ssh_tmux_cmds::set_terminal_tmux_mode(state, mode).await)
        }
        "invalidate_tmux_cache" => {
            respond_omni(crate::ssh_tmux_cmds::invalidate_tmux_cache(state).await)
        }
        "ssh_terminal_info" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::ssh_tmux_cmds::ssh_terminal_info(state, id).await)
        }
        "ssh_terminal_set_direct_mode" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            respond_omni(
                crate::ssh_tmux_cmds::ssh_terminal_set_direct_mode(state, id, cols, rows).await,
            )
        }
        "ssh_tmux_capture_pane" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let history_lines = args
                .get("historyLines")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32;
            respond_omni(
                crate::ssh_tmux_cmds::ssh_tmux_capture_pane(state, id, history_lines).await,
            )
        }
        "ssh_tmux_list_sessions" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::ssh_tmux_cmds::ssh_tmux_list_sessions(state, connection_id).await)
        }
        "ssh_tmux_list_windows" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let session_name = get_str(&args, "sessionName").unwrap_or_default();
            respond_omni(
                crate::ssh_tmux_cmds::ssh_tmux_list_windows(state, connection_id, session_name)
                    .await,
            )
        }
        "ssh_tmux_tab_stats" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::ssh_tmux_cmds::ssh_tmux_tab_stats(state, connection_id).await)
        }
        "ssh_tmux_kill_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let session_name = get_str(&args, "name")
                .or_else(|| get_str(&args, "sessionName"))
                .unwrap_or_default();
            respond_omni(
                crate::ssh_tmux_cmds::ssh_tmux_kill_session(state, connection_id, session_name)
                    .await,
            )
        }
        "ssh_tmux_attach_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let session_name = get_str(&args, "sessionName").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let pane_id = args
                .get("paneId")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            respond_omni(
                crate::ssh_tmux_cmds::ssh_tmux_attach_session(
                    state,
                    connection_id,
                    session_name,
                    cols,
                    rows,
                    pane_id,
                )
                .await,
            )
        }
        "ssh_pool_probe_capabilities" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool());
            respond_omni(
                crate::ssh_capabilities::ssh_pool_probe_capabilities(state, resource_id, force)
                    .await,
            )
        }
        "ssh_pool_invalidate_capabilities" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(
                crate::ssh_capabilities::ssh_pool_invalidate_capabilities(state, resource_id).await,
            )
        }
        "ssh_pool_install_tool" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let tool_id = get_str(&args, "toolId").unwrap_or_default();
            respond_omni(
                crate::ssh_capabilities::ssh_pool_install_tool(state, resource_id, tool_id).await,
            )
        }
        "ssh_pool_probe_panels" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::ssh_capabilities::ssh_pool_probe_panels(state, resource_id).await)
        }
        "ssh_pool_enable_panel_api" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let kind = get_str(&args, "kind").unwrap_or_default();
            let allow_all = args
                .get("allowAll")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            respond_omni(
                crate::ssh_capabilities::ssh_pool_enable_panel_api(
                    state,
                    resource_id,
                    kind,
                    allow_all,
                )
                .await,
            )
        }
        "ssh_pool_list_archive_entries" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(
                crate::ssh_archive::ssh_pool_list_archive_entries(state, resource_id, path).await,
            )
        }
        "ssh_pool_install_archive_tool" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let tool = get_str(&args, "tool").unwrap_or_default();
            respond_omni(
                crate::ssh_archive::ssh_pool_install_archive_tool(state, resource_id, tool).await,
            )
        }

        /* ---------------- 日志搜索 / 预览缓存 ---------------- */
        "local_log_search" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let pattern = get_str(&args, "pattern").unwrap_or_default();
            let options = args
                .get("options")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            respond_omni(crate::log_search::local_log_search(path, pattern, options).await)
        }
        "sftp_log_search" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let pattern = get_str(&args, "pattern").unwrap_or_default();
            let options = args
                .get("options")
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            respond_omni(
                crate::log_search::sftp_log_search(state, id, path, pattern, options).await,
            )
        }
        "sftp_cache_for_preview" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let size = args.get("size").and_then(|v| v.as_f64());
            respond_omni(crate::log_tail::sftp_cache_for_preview(state, id, path, size).await)
        }

        /* ---------------- 面板 / 云 ---------------- */
        "panel_resolve_api_key" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::panel_cmds::panel_resolve_api_key(state, connection_id).await)
        }
        "panel_1panel_request" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let method = get_str(&args, "method").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let body = get_str(&args, "body");
            respond_omni(
                crate::panel_cmds::panel_1panel_request(host, api_key, method, path, body).await,
            )
        }
        "panel_1panel_test_connection" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            respond_omni(crate::panel_cmds::panel_1panel_test_connection(host, api_key).await)
        }
        "panel_1panel_app_icon" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let app_key = get_str(&args, "appKey").unwrap_or_default();
            respond_omni(crate::panel_cmds::panel_1panel_app_icon(host, api_key, app_key).await)
        }
        "panel_1panel_request_text" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let method = get_str(&args, "method").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let body = get_str(&args, "body");
            respond_omni(
                crate::panel_cmds::panel_1panel_request_text(host, api_key, method, path, body)
                    .await,
            )
        }
        "panel_1panel_request_bytes" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let method = get_str(&args, "method").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let body = get_str(&args, "body");
            respond_omni(
                crate::panel_cmds::panel_1panel_request_bytes(host, api_key, method, path, body)
                    .await,
            )
        }
        "panel_1panel_upload_file" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let filename = get_str(&args, "filename").unwrap_or_default();
            let content_base64 = get_str(&args, "contentBase64").unwrap_or_default();
            let overwrite = args.get("overwrite").and_then(|v| v.as_bool());
            respond_omni(
                crate::panel_cmds::panel_1panel_upload_file(
                    host,
                    api_key,
                    path,
                    filename,
                    content_base64,
                    overwrite,
                )
                .await,
            )
        }
        "panel_bt_request" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_sk = get_str(&args, "apiSk").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let body = get_str(&args, "body");
            respond_omni(crate::panel_cmds::panel_bt_request(host, api_sk, path, body).await)
        }
        "panel_bt_request_get" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_sk = get_str(&args, "apiSk").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let query = get_str(&args, "query");
            respond_omni(crate::panel_cmds::panel_bt_request_get(host, api_sk, path, query).await)
        }
        "panel_bt_test_connection" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_sk = get_str(&args, "apiSk").unwrap_or_default();
            respond_omni(crate::panel_cmds::panel_bt_test_connection(host, api_sk).await)
        }
        "panel_bt_app_icon" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_sk = get_str(&args, "apiSk").unwrap_or_default();
            let app_name = get_str(&args, "appName").unwrap_or_default();
            let icon_file = get_str(&args, "iconFile");
            respond_omni(
                crate::panel_cmds::panel_bt_app_icon(host, api_sk, app_name, icon_file).await,
            )
        }
        "cloud_test" => {
            let connection: omnipanel_store::Connection =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let secret = get_str(&args, "secret");
            respond_omni(crate::cloud_cmds::cloud_test(state, connection, secret).await)
        }
        "cloud_list_oss" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let region = get_str(&args, "region");
            respond_omni(crate::cloud_cmds::cloud_list_oss(state, connection_id, region).await)
        }
        "cloud_list_swas" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let region = get_str(&args, "region");
            respond_omni(crate::cloud_cmds::cloud_list_swas(state, connection_id, region).await)
        }
        "cloud_list_domains" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::cloud_cmds::cloud_list_domains(state, connection_id).await)
        }
        "cloud_list_ecs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let region = get_str(&args, "region");
            respond_omni(crate::cloud_cmds::cloud_list_ecs(state, connection_id, region).await)
        }
        "cloud_list_regions" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::cloud_cmds::cloud_list_regions(state, connection_id).await)
        }
        "cloud_get_account" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::cloud_cmds::cloud_get_account(state, connection_id).await)
        }
        "cloud_list_certs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::cloud_cmds::cloud_list_certs(state, connection_id).await)
        }
        "cloud_list_resources" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let capability = get_str(&args, "capability").unwrap_or_default();
            let filter = args
                .get("filter")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok());
            respond_omni(
                crate::cloud_cmds::cloud_list_resources(state, connection_id, capability, filter)
                    .await,
            )
        }
        "cloud_get_resource" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let capability = get_str(&args, "capability").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let region_id = get_str(&args, "regionId");
            respond_omni(
                crate::cloud_cmds::cloud_get_resource(
                    state,
                    connection_id,
                    capability,
                    resource_id,
                    region_id,
                )
                .await,
            )
        }
        "cloud_invoke_action" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let action = match serde_json::from_value(
                args.get("action").cloned().unwrap_or_default(),
            ) {
                Ok(a) => a,
                Err(e) => return InvokeResponse::err(format!("解析 action 失败: {e}")),
            };
            respond_omni(
                crate::cloud_cmds::cloud_invoke_action(state, connection_id, action).await,
            )
        }

        /* ---------------- 文件索引 / 连接 ---------------- */
        "file_save_connection" => {
            let connection: omnipanel_store::Connection =
                match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                    Ok(c) => c,
                    Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
                };
            let secret = get_str(&args, "secret");
            respond_omni(crate::files_conn::file_save_connection(state, connection, secret).await)
        }
        "file_test_connection" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::files_conn::file_test_connection(state, connection_id).await)
        }
        "file_local_temp_dir" => respond_omni(crate::files_conn::file_local_temp_dir().await),
        "write_text_file" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let contents = get_str(&args, "contents").unwrap_or_default();
            respond(crate::store_ext::write_text_file(path, contents).await)
        }
        "file_index_build" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::file_index::file_index_build(state.clone(), connection_id).await)
        }
        "file_index_search" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let query = get_str(&args, "query").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_f64());
            respond(crate::file_index::file_index_search(state, connection_id, query, limit).await)
        }
        "file_index_status" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::file_index::file_index_status(state, connection_id).await)
        }
        "file_index_clear" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::file_index::file_index_clear(state, connection_id).await)
        }
        "file_index_cancel" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::file_index::file_index_cancel(state, connection_id).await)
        }
        "file_index_storage_info" => {
            respond(crate::file_index::file_index_storage_info(state).await)
        }
        "set_file_index_storage_dir" => {
            let dir = get_str(&args, "dir").unwrap_or_default();
            respond(crate::file_index::set_file_index_storage_dir(state, dir).await)
        }

        /* ---------------- 系统 / 本地运行时 ---------------- */
        "list_system_fonts" => {
            let monospace_only = args.get("monospaceOnly").and_then(|v| v.as_bool());
            respond_omni(crate::system_cmds::list_system_fonts(monospace_only).await)
        }
        "detect_all_agents" => {
            let agents = crate::system_cmds::detect_all_agents().await;
            InvokeResponse::ok(serde_json::to_value(agents).unwrap_or(serde_json::json!([])))
        }
        "detect_opencode_install" => {
            respond_omni(crate::system_cmds::detect_opencode_install().await)
        }
        "ai_services_probe" => {
            let enabled = args
                .get("enabled")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let port = args.get("port").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            respond(crate::system_cmds::ai_services_probe(enabled, port).await)
        }
        "resolve_host" => {
            let host = get_str(&args, "host").unwrap_or_default();
            respond_omni(crate::docker_ssh_detect::resolve_host(host).await)
        }
        "decrypt_navicat_password" => {
            let ciphertext = get_str(&args, "ciphertext").unwrap_or_default();
            respond(crate::navicat::decrypt_navicat_password(ciphertext))
        }
        "local_runtime_probe" => respond(crate::local_runtime_cmds::local_runtime_probe().await),
        "local_runtime_refresh_catalog" => {
            respond(crate::local_runtime_cmds::local_runtime_refresh_catalog().await)
        }
        "local_runtime_start_ollama" => {
            respond(crate::local_runtime_cmds::local_runtime_start_ollama().await)
        }
        "local_runtime_install_ollama" => {
            respond(crate::local_runtime_cmds::local_runtime_install_ollama().await)
        }
        "local_runtime_ollama_pull" => {
            let model = get_str(&args, "model").unwrap_or_default();
            respond(crate::local_runtime_cmds::local_runtime_ollama_pull(model).await)
        }
        "local_runtime_ollama_delete" => {
            let model = get_str(&args, "model").unwrap_or_default();
            respond(crate::local_runtime_cmds::local_runtime_ollama_delete(model).await)
        }
        "local_runtime_probe_openai_compat" => {
            let base_url = get_str(&args, "baseUrl").unwrap_or_default();
            respond(crate::local_runtime_cmds::local_runtime_probe_openai_compat(base_url).await)
        }
        "local_runtime_ollama_download_url" => {
            respond(crate::local_runtime_cmds::local_runtime_ollama_download_url().await)
        }
        "bg_task_submit_ollama_install" => {
            respond_omni(crate::bg_task_cmds::bg_task_submit_ollama_install(state).await)
        }
        "bg_task_submit_ollama_pull" => {
            let model = get_str(&args, "model").unwrap_or_default();
            respond_omni(crate::bg_task_cmds::bg_task_submit_ollama_pull(state, model).await)
        }

        /* ---------------- 资源画像 ---------------- */
        "resource_collect_ssh_snapshot" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(
                crate::resource_profile_cmds::resource_collect_ssh_snapshot(state, resource_id)
                    .await,
            )
        }
        "resource_collect_database_snapshot" => {
            let connection_name = get_str(&args, "connectionName").unwrap_or_default();
            respond_omni(
                crate::resource_profile_cmds::resource_collect_database_snapshot(
                    state,
                    connection_name,
                )
                .await,
            )
        }
        "resource_compute_observation_diff" => {
            let resource_type = get_str(&args, "resourceType").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let observation_kind = get_str(&args, "observationKind").unwrap_or_default();
            respond_omni(
                crate::resource_profile_cmds::resource_compute_observation_diff(
                    state,
                    resource_type,
                    resource_id,
                    observation_kind,
                )
                .await,
            )
        }

        /* ---------------- 任务 / 审计 / 第三方账号 ---------------- */
        "task_list" => {
            let status_filter = get_str(&args, "statusFilter");
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(200) as u32;
            respond_omni(crate::store_ext::task_list(state, status_filter, limit).await)
        }
        "task_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::store_ext::task_get(state, id).await)
        }
        "task_save" => {
            let req: omnipanel_store::SaveTaskRequest =
                match serde_json::from_value(args.get("req").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 req 失败: {e}")),
                };
            respond_omni(crate::store_ext::task_save(state, req).await)
        }
        "task_update_status" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let status: omnipanel_store::TaskStatus =
                match serde_json::from_value(args.get("status").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 status 失败: {e}")),
                };
            respond_omni(crate::store_ext::task_update_status(state, id, status).await)
        }
        "task_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::store_ext::task_delete(state, id).await)
        }
        "task_run" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::exec_cmds::task_run(state, id).await)
        }
        "task_stop" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::exec_cmds::task_stop(state, id).await)
        }
        "task_get_output" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::exec_cmds::task_get_output(state, id).await)
        }
        "task_events_list" => {
            let module = get_str(&args, "module");
            let workspace_id = get_str(&args, "workspaceId");
            let resource_id = get_str(&args, "resourceId");
            let source = get_str(&args, "source");
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(
                crate::bg_task_cmds::task_events_list(
                    state,
                    module,
                    workspace_id,
                    resource_id,
                    source,
                    limit,
                )
                .await,
            )
        }
        "execute_action" => {
            let action: omnipanel_exec::ActionRequest =
                match serde_json::from_value(args.get("action").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 action 失败: {e}")),
                };
            respond_omni(crate::exec_cmds::execute_action(state, action).await)
        }
        "audit_log_recent" => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond(crate::store_ext::audit_log_recent(state, limit).await)
        }
        "audit_log_append" => {
            let entry: omnipanel_store::AuditEntry =
                match serde_json::from_value(args.get("entry").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 entry 失败: {e}")),
                };
            respond(crate::store_ext::audit_log_append(state, entry).await)
        }
        "third_party_account_list" => {
            respond(crate::store_ext::third_party_account_list(state).await)
        }
        "third_party_account_upsert" => {
            let input: omnipanel_store::UpsertThirdPartyAccountInput =
                match serde_json::from_value(args.get("input").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 input 失败: {e}")),
                };
            respond(crate::store_ext::third_party_account_upsert(state, input).await)
        }
        "third_party_account_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::store_ext::third_party_account_delete(state, id).await)
        }

        /* ---------------- 认证 ---------------- */
        "auth_device_identity" => respond_omni(crate::auth_cmds::auth_device_identity().await),
        "auth_list_devices" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_list_devices(token).await)
        }
        "auth_delete_device" => {
            let token = get_str(&args, "token").unwrap_or_default();
            let device_id = get_str(&args, "deviceId").unwrap_or_default();
            let app_id = get_str(&args, "appId");
            respond_omni(crate::auth_cmds::auth_delete_device(token, device_id, app_id).await)
        }
        "auth_get_me" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_get_me(token).await)
        }
        "auth_update_profile" => {
            let token = get_str(&args, "token").unwrap_or_default();
            let nickname = get_str(&args, "nickname");
            let avatar_url = get_str(&args, "avatarUrl");
            respond_omni(crate::auth_cmds::auth_update_profile(token, nickname, avatar_url).await)
        }
        "auth_login_qrcode" => respond_omni(crate::auth_cmds::auth_login_qrcode().await),
        "auth_public_qrcodes" => respond_omni(crate::auth_cmds::auth_public_qrcodes().await),
        "auth_presence" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_presence(token).await)
        }
        "auth_logout" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_logout(token).await)
        }
        "auth_login_wait" => {
            let login_id = get_str(&args, "loginId").unwrap_or_default();
            let expire_in_sec = args
                .get("expireInSec")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            respond_omni(crate::auth_cmds::auth_login_wait(login_id, expire_in_sec).await)
        }
        "auth_login_cancel_wait" => {
            let login_id = get_str(&args, "loginId").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_login_cancel_wait(login_id).await)
        }
        "auth_login_email_send" => {
            let email = get_str(&args, "email").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_login_email_send(email).await)
        }
        "auth_login_email" => {
            let email = get_str(&args, "email").unwrap_or_default();
            let code = get_str(&args, "code").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_login_email(email, code).await)
        }
        "auth_login_github" => respond_omni(crate::auth_cmds::auth_login_github().await),
        "auth_login_github_cancel" => {
            respond_omni(crate::auth_cmds::auth_login_github_cancel().await)
        }
        "auth_account_links" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_account_links(token).await)
        }
        "auth_link_wechat_qrcode" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_link_wechat_qrcode(token).await)
        }
        "auth_link_wechat_wait" => {
            let token = get_str(&args, "token").unwrap_or_default();
            let login_id = get_str(&args, "loginId").unwrap_or_default();
            let expire_in_sec = args
                .get("expireInSec")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            respond_omni(
                crate::auth_cmds::auth_link_wechat_wait(token, login_id, expire_in_sec).await,
            )
        }
        "auth_link_wechat_cancel_wait" => {
            let login_id = get_str(&args, "loginId").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_link_wechat_cancel_wait(login_id).await)
        }
        "auth_link_email_send" => {
            let token = get_str(&args, "token").unwrap_or_default();
            let email = get_str(&args, "email").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_link_email_send(token, email).await)
        }
        "auth_link_email" => {
            let token = get_str(&args, "token").unwrap_or_default();
            let email = get_str(&args, "email").unwrap_or_default();
            let code = get_str(&args, "code").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_link_email(token, email, code).await)
        }
        "auth_link_github" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_link_github(token).await)
        }
        "auth_link_github_cancel" => {
            respond_omni(crate::auth_cmds::auth_link_github_cancel().await)
        }
        "auth_unlink_wechat" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_unlink_wechat(token).await)
        }
        "auth_unlink_github" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_unlink_github(token).await)
        }
        "auth_unlink_email" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_unlink_email(token).await)
        }
        "auth_bindings_qrcode" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_bindings_qrcode(token).await)
        }
        "auth_bindings_wait" => {
            let token = get_str(&args, "token").unwrap_or_default();
            let bind_id = get_str(&args, "bindId").unwrap_or_default();
            let expire_in_sec = args
                .get("expireInSec")
                .and_then(|v| v.as_u64())
                .map(|n| n as u32);
            respond_omni(crate::auth_cmds::auth_bindings_wait(token, bind_id, expire_in_sec).await)
        }
        "auth_bindings_cancel_wait" => {
            let bind_id = get_str(&args, "bindId").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_bindings_cancel_wait(bind_id).await)
        }

        /* ---------------- 助手 / 客户端同步 ---------------- */
        "assistant_push_snapshot" => {
            let request: crate::assistant_cmds::AssistantPushRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(crate::assistant_cmds::assistant_push_snapshot(state, request).await)
        }
        "assistant_upload_oss_text" => {
            let request: crate::assistant_cmds::AssistantUploadTextRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(crate::assistant_cmds::assistant_upload_oss_text(state, request).await)
        }
        "assistant_chat_latest" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::assistant_cmds::assistant_chat_latest(token).await)
        }
        "assistant_chat_fetch_object" => {
            let token = get_str(&args, "token").unwrap_or_default();
            let object_key = get_str(&args, "objectKey").unwrap_or_default();
            respond_omni(
                crate::assistant_cmds::assistant_chat_fetch_object(token, object_key).await,
            )
        }
        "assistant_chat_inbox_start" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::assistant_cmds::assistant_chat_inbox_start(state, token).await)
        }
        "assistant_chat_inbox_stop" => {
            respond_omni(crate::assistant_cmds::assistant_chat_inbox_stop().await)
        }
        "client_sync_push_conversations" => {
            let request: crate::client_sync_cmds::ClientSyncPushConversationsRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(
                crate::client_sync_cmds::client_sync_push_conversations(state, request).await,
            )
        }
        "client_sync_pull_conversations" => {
            let request: crate::client_sync_cmds::ClientSyncPullConversationsRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(
                crate::client_sync_cmds::client_sync_pull_conversations(state, request).await,
            )
        }
        "client_sync_push_modules" => {
            let request: crate::client_sync_modules_cmds::ClientSyncPushModulesRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(
                crate::client_sync_modules_cmds::client_sync_push_modules(state, request).await,
            )
        }
        "client_sync_pull_modules" => {
            let request: crate::client_sync_modules_cmds::ClientSyncPullModulesRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(
                crate::client_sync_modules_cmds::client_sync_pull_modules(state, request).await,
            )
        }

        /* ---------------- 密文库 ---------------- */
        "secrets_vault_status" => respond_omni(crate::store_ext::secrets_vault_status(state).await),
        "secrets_vault_unlock" => {
            let device_code = get_str(&args, "deviceCode").unwrap_or_default();
            respond_omni(crate::store_ext::secrets_vault_unlock(device_code).await)
        }
        "secrets_vault_lock" => respond_omni(crate::store_ext::secrets_vault_lock().await),
        "secrets_vault_push" => {
            let request: crate::store_ext::SecretsVaultPushRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(crate::store_ext::secrets_vault_push(state, request).await)
        }
        "secrets_vault_pull" => {
            let request: crate::store_ext::SecretsVaultPullRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(crate::store_ext::secrets_vault_pull(state, request).await)
        }
        "sync_master_key_status" => respond_omni(crate::store_ext::sync_master_key_status().await),
        "sync_master_key_get_or_create" => {
            respond_omni(crate::store_ext::sync_master_key_get_or_create().await)
        }
        "sync_master_key_clear" => respond_omni(crate::store_ext::sync_master_key_clear().await),
        "sync_master_key_validate" => {
            let key = get_str(&args, "key").unwrap_or_default();
            respond_omni(crate::store_ext::sync_master_key_validate(key).await)
        }
        "sync_team_key_status" => {
            let team_id = get_str(&args, "teamId")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            respond_omni(crate::store_ext::sync_team_key_status(team_id).await)
        }
        "sync_team_key_get_or_create" => {
            let team_id = get_str(&args, "teamId")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            respond_omni(crate::store_ext::sync_team_key_get_or_create(team_id).await)
        }
        "sync_team_key_clear" => {
            let team_id = get_str(&args, "teamId")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            respond_omni(crate::store_ext::sync_team_key_clear(team_id).await)
        }
        "sync_team_key_export_file" => {
            let team_id = get_str(&args, "teamId")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let path = get_str(&args, "path").unwrap_or_default();
            let passphrase = get_str(&args, "passphrase");
            respond_omni(
                crate::store_ext::sync_team_key_export_file(team_id, path, passphrase).await,
            )
        }
        "sync_team_key_import_file" => {
            let team_id = get_str(&args, "teamId")
                .and_then(|s| s.parse().ok())
                .unwrap_or(0);
            let path = get_str(&args, "path").unwrap_or_default();
            let passphrase = get_str(&args, "passphrase");
            respond_omni(
                crate::store_ext::sync_team_key_import_file(team_id, path, passphrase).await,
            )
        }
        "sync_pairing_create_keypair" => {
            let pairing_id = get_str(&args, "pairingId").unwrap_or_default();
            respond_omni(crate::store_ext::sync_pairing_create_keypair(pairing_id).await)
        }
        "sync_pairing_wrap_key" => {
            let request: crate::store_ext::WrapKeyRequest =
                match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
                };
            respond_omni(crate::store_ext::sync_pairing_wrap_key(request).await)
        }
        "sync_pairing_unwrap_and_store" => {
            let pairing_id = get_str(&args, "pairingId").unwrap_or_default();
            let requester_device_id = get_str(&args, "requesterDeviceId").unwrap_or_default();
            let wrapped_key = get_str(&args, "wrappedKey").unwrap_or_default();
            respond_omni(
                crate::store_ext::sync_pairing_unwrap_and_store(
                    pairing_id,
                    requester_device_id,
                    wrapped_key,
                )
                .await,
            )
        }

        /* ---------------- ACP ---------------- */
        "acp_connect" => {
            let command_line = get_str(&args, "commandLine").unwrap_or_default();
            respond(crate::acp_cmds::acp_connect(state, command_line).await)
        }
        "acp_connect_default" => respond(crate::acp_cmds::acp_connect_default(state).await),
        "acp_disconnect" => respond(crate::acp_cmds::acp_disconnect(state).await),
        "acp_get_status" => respond(crate::acp_cmds::acp_get_status(state).await),
        "acp_get_default_command" => respond(crate::acp_cmds::acp_get_default_command()),
        "acp_prompt" => {
            let prompt_args: crate::acp_cmds::AcpPromptArgs =
                match serde_json::from_value(args.clone()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 acp_prompt 参数失败: {e}")),
                };
            match crate::acp_cmds::acp_prompt(state, prompt_args).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "acp_cancel" => {
            let conversation_id = get_str(&args, "conversationId").unwrap_or_default();
            match crate::acp_cmds::acp_cancel(state, conversation_id).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "acp_respond_permission" => {
            let request_id = args
                .get("requestId")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let option_id = get_str(&args, "optionId").unwrap_or_default();
            match crate::acp_cmds::acp_respond_permission(state, request_id, option_id).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "acp_save_agent_config" => {
            let config: crate::acp_cmds::AcpAgentConfigInput =
                match serde_json::from_value(args.get("config").cloned().unwrap_or_default()) {
                    Ok(v) => v,
                    Err(e) => return InvokeResponse::err(format!("解析 config 失败: {e}")),
                };
            respond(crate::acp_cmds::acp_save_agent_config(config).await)
        }

        /* ---------------- 暂缓（sniffer / updater） ---------------- */
        "sniffer_list_interfaces" => {
            InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_list_interfaces"))
        }
        "sniffer_start_capture" => {
            InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_start_capture"))
        }
        "sniffer_stop_capture" => {
            InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_stop_capture"))
        }
        "sniffer_get_packets" => {
            InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_get_packets"))
        }
        "sniffer_get_stats" => {
            InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_get_stats"))
        }
        "check_update" => InvokeResponse::err(crate::defer_cmds::deferred_error("check_update")),
        "install_update" => {
            InvokeResponse::err(crate::defer_cmds::deferred_error("install_update"))
        }
        other => InvokeResponse::ok(crate::soft_degrade::soft_degrade_value(other)),
    }
}

fn get_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
}

fn get_u16(args: &serde_json::Value, key: &str) -> Option<u16> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as u16)
}

fn get_u32(args: &serde_json::Value, key: &str) -> Option<u32> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as u32)
}
