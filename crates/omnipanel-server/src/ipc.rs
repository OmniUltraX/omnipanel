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

/// 分发单条命令。未知命令返回错误（与 Tauri `invoke` 未知命令报错一致）。
pub async fn dispatch(state: &ServerState, req: InvokeRequest) -> InvokeResponse<serde_json::Value> {
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
                .map(|arr| arr.iter().filter_map(|n| n.as_u64()).map(|n| n as u8).collect())
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
        "db_list_connections" => {
            respond(crate::db::db_list_connections(state).await)
        }
        "db_get_connection_secret" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::db::db_get_connection_secret(state, id).await)
        }
        "db_save_connection" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
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
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            respond(crate::db::db_test_connection(state, connection).await)
        }
        "db_list_databases" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            respond(crate::db::db_list_databases(state, connection).await)
        }
        "db_list_tables" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            let schema = args.get("schema").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::db::db_list_tables(state, connection, schema).await)
        }
        "db_preview_table" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            let table = get_str(&args, "table").unwrap_or_default();
            let limit = get_u32(&args, "limit").unwrap_or(200);
            let offset = get_u32(&args, "offset").unwrap_or(0);
            let order_by = args.get("orderBy").and_then(|v| v.as_str()).map(str::to_string);
            let where_clause = args.get("whereClause").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::db::db_preview_table(state, connection, table, limit, offset, order_by, where_clause).await)
        }
        "db_count_table" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            let schema = args.get("schema").and_then(|v| v.as_str()).map(str::to_string);
            let table = get_str(&args, "table").unwrap_or_default();
            let where_clause = args.get("whereClause").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::db::db_count_table(state, connection, schema, table, where_clause).await)
        }
        "db_count_tables" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            let schema = args.get("schema").and_then(|v| v.as_str()).map(str::to_string);
            let tables: Vec<String> = args.get("tables")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            respond(crate::db::db_count_tables(state, connection, schema, tables).await)
        }
        "db_execute_query" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            let sql = get_str(&args, "sql").unwrap_or_default();
            let run_id = get_str(&args, "runId").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            let offset = args.get("offset").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond(crate::db::db_execute_query(state, connection, sql, run_id, limit, offset).await)
        }
        "db_cancel_query" => {
            let run_id = get_str(&args, "runId").unwrap_or_default();
            respond(crate::db::db_cancel_query(state, run_id).await)
        }
        "db_run_sql" => {
            let connection: omnipanel_store::DbConnectionConfig = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 connection 失败: {e}")),
            };
            let schema = args.get("schema").and_then(|v| v.as_str()).map(str::to_string);
            let sql = get_str(&args, "sql").unwrap_or_default();
            respond(crate::db::db_run_sql(state, connection, schema, sql).await)
        }

        /* ---------------- SSH（P1） ---------------- */
        "ssh_list_connections" => {
            respond(crate::ssh::ssh_list_connections(state).await)
        }
        "ssh_connect_connection" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::ssh::ssh_connect_connection(state, connection_id, cols, rows).await {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e.to_string()),
            }
        }
        "ssh_write" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|n| n.as_u64()).map(|n| n as u8).collect())
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
        "docker_list_connections" => {
            respond(crate::docker::docker_list_connections(state).await)
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
            let filter = args.get("filter").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::docker::docker_list_containers(state, connection_id, filter).await)
        }
        "docker_get_local_engine_status" => {
            respond(crate::docker::docker_get_local_engine_status().await)
        }
        "docker_reset_ssh_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker::docker_reset_ssh_session(state, connection_id).await)
        }

        other => InvokeResponse::err(format!("unknown command: {other}")),
    }
}

fn get_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn get_u16(args: &serde_json::Value, key: &str) -> Option<u16> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as u16)
}

fn get_u32(args: &serde_json::Value, key: &str) -> Option<u32> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as u32)
}
