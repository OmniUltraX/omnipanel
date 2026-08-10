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
pub async fn dispatch(state: &std::sync::Arc<ServerState>, req: InvokeRequest) -> InvokeResponse<serde_json::Value> {
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

        /* ---------------- Docker（P2：写操作 / 镜像 / 卷 / 网络 / compose / daemon / exec / 流式） ---------------- */
        "docker_list_container_stats" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_ids = args.get("containerIds").and_then(|v| v.as_array()).map(|arr| {
                arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect::<Vec<_>>()
            });
            respond(crate::docker_ops::docker_list_container_stats(state, connection_id, container_ids).await)
        }
        "docker_inspect_container" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(crate::docker_ops::docker_inspect_container(state, connection_id, container_id).await)
        }
        "docker_container_action" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let action = get_str(&args, "action").unwrap_or_default();
            respond(crate::docker_ops::docker_container_action(state, connection_id, container_id, action).await)
        }
        "docker_container_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let tail = args.get("tail").and_then(|v| v.as_i64()).unwrap_or(500) as i32;
            let since = args.get("since").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::docker_ops::docker_container_logs(state, connection_id, container_id, tail, since).await)
        }
        "docker_clear_container_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(crate::docker_ops::docker_clear_container_logs(state, connection_id, container_id).await)
        }
        "docker_list_container_log_infos" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_container_log_infos(state, connection_id).await)
        }
        "docker_create_container" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerCreateContainerRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
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
            respond(crate::docker_ops::docker_remove_image(state, connection_id, image_id, force).await)
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
            respond(crate::docker_ops::docker_search_images(state, connection_id, term, limit).await)
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
            respond(crate::docker_ops::docker_pull_image(state, connection_id, image, channel).await)
        }
        "docker_push_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let image = get_str(&args, "image").unwrap_or_default();
            let channel = get_str(&args, "progressChannel").unwrap_or_default();
            respond(crate::docker_ops::docker_push_image(state, connection_id, image, channel).await)
        }
        "docker_build_image" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let context: omnipanel_docker::DockerBuildContext = match serde_json::from_value(args.get("context").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 context 失败: {e}")),
            };
            let channel = get_str(&args, "progressChannel").unwrap_or_default();
            respond(crate::docker_ops::docker_build_image(state, connection_id, context, channel).await)
        }
        "docker_host_run_cli" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let command = get_str(&args, "command").unwrap_or_default();
            let channel = get_str(&args, "progressChannel").unwrap_or_default();
            respond(crate::docker_ops::docker_host_run_cli(state, connection_id, command, channel).await)
        }
        "docker_list_volumes" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_volumes(state, connection_id).await)
        }
        "docker_create_volume" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerCreateVolumeRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond(crate::docker_ops::docker_create_volume(state, connection_id, request).await)
        }
        "docker_remove_volume" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(crate::docker_ops::docker_remove_volume(state, connection_id, name, force).await)
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
            let request: omnipanel_docker::DockerCreateNetworkRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
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
            respond(crate::docker_ops::docker_connect_network(state, connection_id, network, container_id).await)
        }
        "docker_disconnect_network" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let network = get_str(&args, "network").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(crate::docker_ops::docker_disconnect_network(state, connection_id, network, container_id).await)
        }
        "docker_list_compose_projects" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_list_compose_projects(state, connection_id).await)
        }
        "docker_compose_action" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let action: omnipanel_docker::DockerComposeAction = match serde_json::from_value(args.get("action").cloned().unwrap_or_default()) {
                Ok(a) => a,
                Err(e) => return InvokeResponse::err(format!("解析 action 失败: {e}")),
            };
            let request: omnipanel_docker::DockerComposeRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond(crate::docker_ops::docker_compose_action(state, connection_id, action, request).await)
        }
        "docker_read_compose_files" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerComposeReadFilesRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond(crate::docker_ops::docker_read_compose_files(state, connection_id, request).await)
        }
        "docker_write_compose_files" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request: omnipanel_docker::DockerComposeWriteFilesRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond(crate::docker_ops::docker_write_compose_files(state, connection_id, request).await)
        }
        "docker_read_daemon_config" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::docker_ops::docker_read_daemon_config(state, connection_id).await)
        }
        "docker_write_daemon_config" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let content = get_str(&args, "content").unwrap_or_default();
            respond(crate::docker_ops::docker_write_daemon_config(state, connection_id, content).await)
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
            respond(crate::docker_ops::docker_list_container_dir(state, connection_id, container_id, path).await)
        }
        "docker_read_container_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let max_bytes = args.get("maxBytes").and_then(|v| v.as_i64()).unwrap_or(16 * 1024 * 1024);
            respond(crate::docker_ops::docker_read_container_file(state, connection_id, container_id, path, max_bytes).await)
        }
        "docker_write_container_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let data: Vec<u8> = args.get("data").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|n| n.as_u64()).map(|n| n as u8).collect()).unwrap_or_default();
            respond(crate::docker_ops::docker_write_container_file(state, connection_id, container_id, path, data).await)
        }
        "docker_list_volume_dir" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let volume_name = get_str(&args, "volumeName").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond(crate::docker_ops::docker_list_volume_dir(state, connection_id, volume_name, path).await)
        }
        "docker_read_volume_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let volume_name = get_str(&args, "volumeName").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let max_bytes = args.get("maxBytes").and_then(|v| v.as_i64()).unwrap_or(16 * 1024 * 1024);
            respond(crate::docker_ops::docker_read_volume_file(state, connection_id, volume_name, path, max_bytes).await)
        }
        "docker_stream_container_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let tail = args.get("tail").and_then(|v| v.as_i64()).unwrap_or(500) as i32;
            let since = args.get("since").and_then(|v| v.as_str()).map(str::to_string);
            let follow = args.get("follow").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(crate::docker_ops::docker_stream_container_logs(state, connection_id, container_id, tail, since, follow).await)
        }
        "docker_stop_log_stream" => {
            let stream_id = get_str(&args, "streamId").unwrap_or_default();
            respond(crate::docker_ops::docker_stop_log_stream(state, stream_id).await)
        }
        "docker_stream_stats" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            respond(crate::docker_ops::docker_stream_stats(state, connection_id, container_id).await)
        }
        "docker_stop_stats_stream" => {
            let stream_id = get_str(&args, "streamId").unwrap_or_default();
            respond(crate::docker_ops::docker_stop_stats_stream(state, stream_id).await)
        }
        "docker_exec_command" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let command = get_str(&args, "command").unwrap_or_default();
            respond(crate::docker_ops::docker_exec_command(state, connection_id, container_id, command).await)
        }
        "docker_create_exec_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let container_id = get_str(&args, "containerId").unwrap_or_default();
            let shell = args.get("shell").and_then(|v| v.as_str()).map(str::to_string);
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::docker_ops::docker_create_exec_session(state, connection_id, container_id, shell, cols, rows).await {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "docker_create_host_shell_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::docker_ops::docker_create_host_shell_session(state, connection_id, cols, rows).await {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "docker_exec_write" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            let data: Vec<u8> = args.get("data").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|n| n.as_u64()).map(|n| n as u8).collect()).unwrap_or_default();
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
        "file_list_connections" => {
            respond(crate::files::file_list_connections(state).await)
        }
        "file_list_dir" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let search = args.get("search").and_then(|v| v.as_str()).map(str::to_string);
            let continuation_token = args.get("continuationToken").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::files::file_list_dir(state, connection_id, path, search, continuation_token).await)
        }
        "file_s3_search" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let query = get_str(&args, "query").unwrap_or_default();
            let continuation_token = args.get("continuationToken").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::files::file_s3_search(state, connection_id, query, continuation_token).await)
        }
        "file_read_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let max_bytes = args.get("maxBytes").and_then(|v| v.as_f64()).unwrap_or(10.0 * 1024.0 * 1024.0);
            respond(crate::files::file_read_file(state, connection_id, path, max_bytes).await)
        }
        "file_upload_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let data: Vec<u8> = args.get("data").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|n| n.as_u64()).map(|n| n as u8).collect()).unwrap_or_default();
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
        "file_delete" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let entry_kind = args.get("entryKind").and_then(|v| v.as_str()).map(str::to_string);
            respond(crate::files::file_delete(state, connection_id, path, entry_kind).await)
        }
        "file_local_quick_paths" => {
            respond(crate::files::file_local_quick_paths().await)
        }
        "file_local_system_info" => {
            respond(crate::files::file_local_system_info().await)
        }
        "file_upload_local_bytes" => {
            let file_name = get_str(&args, "fileName").unwrap_or_default();
            let data: Vec<u8> = args.get("data").and_then(|v| v.as_array()).map(|arr| arr.iter().filter_map(|n| n.as_u64()).map(|n| n as u8).collect()).unwrap_or_default();
            let dest_connection_id = get_str(&args, "destConnectionId").unwrap_or_default();
            let dest_dir = get_str(&args, "destDir").unwrap_or_default();
            respond(crate::files::file_upload_local_bytes(state, file_name, data, dest_connection_id, dest_dir).await)
        }
        "file_download_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let remote_path = get_str(&args, "remotePath").unwrap_or_default();
            let local_path = get_str(&args, "localPath").unwrap_or_default();
            respond(crate::files::file_download_file(state, connection_id, remote_path, local_path).await)
        }
        "file_upload_local_path_multipart" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let dest_path = get_str(&args, "destPath").unwrap_or_default();
            let local_path = get_str(&args, "localPath").unwrap_or_default();
            let chunk_size = args.get("chunkSize").and_then(|v| v.as_u64()).map(|n| n as usize);
            respond(crate::files::file_upload_local_path_multipart(state, connection_id, dest_path, local_path, chunk_size).await)
        }
        "file_download_s3_range_to_file" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let remote_path = get_str(&args, "remotePath").unwrap_or_default();
            let local_path = get_str(&args, "localPath").unwrap_or_default();
            let chunk_size = args.get("chunkSize").and_then(|v| v.as_u64());
            respond(crate::files::file_download_s3_range_to_file(state, connection_id, remote_path, local_path, chunk_size).await)
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
            let approved = args.get("approved").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(crate::ai::ai_chat_tool_result(state, conversation_id, tool_call_id, result, approved).await)
        }
        "ai_http_stream_post" => {
            let req: crate::ai::AiHttpStreamRequest = match serde_json::from_value(args) {
                Ok(r) => r,
                Err(e) => return InvokeResponse::err(format!("解析 ai_http_stream_post 请求失败: {e}")),
            };
            respond(crate::ai::ai_http_stream_post(state, req).await)
        }

        /* ---------------- MCP 外部服务桥接（P4） ---------------- */
        "mcp_list_services" => {
            respond(crate::mcp::mcp_list_services(state).await)
        }
        "mcp_upsert_service" => {
            let input: crate::mcp::UpsertMcpServiceInput = match serde_json::from_value(args.get("input").cloned().unwrap_or_default()) {
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
            let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(crate::mcp::mcp_set_service_enabled(state, id, enabled).await)
        }
        "mcp_set_service_running" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let running = args.get("running").and_then(|v| v.as_bool()).unwrap_or(false);
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
