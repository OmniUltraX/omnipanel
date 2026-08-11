# -*- coding: utf-8 -*-
"""将 bindings 中尚未注册到 ipc.rs 的命令批量接入 dispatch。"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IPC_PATH = ROOT / "crates/omnipanel-server/src/ipc.rs"
MARKER = "        other => InvokeResponse::ok(crate::soft_degrade::soft_degrade_value(other)),"

DEFERRED = frozenset(
    {
        "sniffer_list_interfaces",
        "sniffer_start_capture",
        "sniffer_stop_capture",
        "sniffer_get_packets",
        "sniffer_get_stats",
        "check_update",
        "install_update",
    }
)

BLOCK = r'''
        /* ---------------- SSH keys / connect / tmux ---------------- */
        "ssh_generate_key" => {
            let key_type = get_str(&args, "keyType").unwrap_or_default();
            let bits = args.get("bits").and_then(|v| v.as_u64()).map(|n| n as u32);
            let comment = get_str(&args, "comment").unwrap_or_default();
            let passphrase = get_str(&args, "passphrase").unwrap_or_default();
            let name = get_str(&args, "name");
            respond_omni(crate::ssh_keys::ssh_generate_key(key_type, bits, comment, passphrase, name).await)
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
            let config: omnipanel_ssh::SshConfig = match serde_json::from_value(args.get("config").cloned().unwrap_or_default()) {
                Ok(c) => c,
                Err(e) => return InvokeResponse::err(format!("解析 config 失败: {e}")),
            };
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let pane_id = args.get("paneId").and_then(|v| v.as_u64()).map(|n| n as u32);
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
        "invalidate_tmux_cache" => respond_omni(crate::ssh_tmux_cmds::invalidate_tmux_cache(state).await),
        "ssh_terminal_info" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::ssh_tmux_cmds::ssh_terminal_info(state, id).await)
        }
        "ssh_terminal_set_direct_mode" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            respond_omni(crate::ssh_tmux_cmds::ssh_terminal_set_direct_mode(state, id, cols, rows).await)
        }
        "ssh_tmux_capture_pane" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let history_lines = args.get("historyLines").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            respond_omni(crate::ssh_tmux_cmds::ssh_tmux_capture_pane(state, id, history_lines).await)
        }
        "ssh_tmux_list_sessions" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::ssh_tmux_cmds::ssh_tmux_list_sessions(state, connection_id).await)
        }
        "ssh_tmux_list_windows" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let session_name = get_str(&args, "sessionName").unwrap_or_default();
            respond_omni(crate::ssh_tmux_cmds::ssh_tmux_list_windows(state, connection_id, session_name).await)
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
            respond_omni(crate::ssh_tmux_cmds::ssh_tmux_kill_session(state, connection_id, session_name).await)
        }
        "ssh_tmux_attach_session" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let session_name = get_str(&args, "sessionName").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let pane_id = args.get("paneId").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::ssh_tmux_cmds::ssh_tmux_attach_session(state, connection_id, session_name, cols, rows, pane_id).await)
        }
        "ssh_pool_probe_capabilities" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool());
            respond_omni(crate::ssh_capabilities::ssh_pool_probe_capabilities(state, resource_id, force).await)
        }
        "ssh_pool_invalidate_capabilities" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::ssh_capabilities::ssh_pool_invalidate_capabilities(state, resource_id).await)
        }
        "ssh_pool_install_tool" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let tool_id = get_str(&args, "toolId").unwrap_or_default();
            respond_omni(crate::ssh_capabilities::ssh_pool_install_tool(state, resource_id, tool_id).await)
        }
        "ssh_pool_probe_panels" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::ssh_capabilities::ssh_pool_probe_panels(state, resource_id).await)
        }
        "ssh_pool_enable_panel_api" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let kind = get_str(&args, "kind").unwrap_or_default();
            let allow_all = args.get("allowAll").and_then(|v| v.as_bool()).unwrap_or(false);
            respond_omni(crate::ssh_capabilities::ssh_pool_enable_panel_api(state, resource_id, kind, allow_all).await)
        }
        "ssh_pool_list_archive_entries" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            respond_omni(crate::ssh_archive::ssh_pool_list_archive_entries(state, resource_id, path).await)
        }
        "ssh_pool_install_archive_tool" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let tool = get_str(&args, "tool").unwrap_or_default();
            respond_omni(crate::ssh_archive::ssh_pool_install_archive_tool(state, resource_id, tool).await)
        }

        /* ---------------- 日志搜索 / 预览缓存 ---------------- */
        "local_log_search" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let pattern = get_str(&args, "pattern").unwrap_or_default();
            let options = args.get("options").and_then(|v| serde_json::from_value(v.clone()).ok());
            respond_omni(crate::log_search::local_log_search(path, pattern, options).await)
        }
        "sftp_log_search" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let pattern = get_str(&args, "pattern").unwrap_or_default();
            let options = args.get("options").and_then(|v| serde_json::from_value(v.clone()).ok());
            respond_omni(crate::log_search::sftp_log_search(state, id, path, pattern, options).await)
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
            respond_omni(crate::panel_cmds::panel_1panel_request(host, api_key, method, path, body).await)
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
            respond_omni(crate::panel_cmds::panel_1panel_request_text(host, api_key, method, path, body).await)
        }
        "panel_1panel_request_bytes" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let method = get_str(&args, "method").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let body = get_str(&args, "body");
            respond_omni(crate::panel_cmds::panel_1panel_request_bytes(host, api_key, method, path, body).await)
        }
        "panel_1panel_upload_file" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let filename = get_str(&args, "filename").unwrap_or_default();
            let content_base64 = get_str(&args, "contentBase64").unwrap_or_default();
            let overwrite = args.get("overwrite").and_then(|v| v.as_bool());
            respond_omni(crate::panel_cmds::panel_1panel_upload_file(host, api_key, path, filename, content_base64, overwrite).await)
        }
        "panel_bt_request" => {
            let host = get_str(&args, "host").unwrap_or_default();
            let api_sk = get_str(&args, "apiSk").unwrap_or_default();
            let path = get_str(&args, "path").unwrap_or_default();
            let body = get_str(&args, "body");
            respond_omni(crate::panel_cmds::panel_bt_request(host, api_sk, path, body).await)
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
            respond_omni(crate::panel_cmds::panel_bt_app_icon(host, api_sk, app_name, icon_file).await)
        }
        "cloud_test" => {
            let connection: omnipanel_store::Connection = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
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
        "cloud_list_certs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond_omni(crate::cloud_cmds::cloud_list_certs(state, connection_id).await)
        }

        /* ---------------- 文件索引 / 连接 ---------------- */
        "file_save_connection" => {
            let connection: omnipanel_store::Connection = match serde_json::from_value(args.get("connection").cloned().unwrap_or_default()) {
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
        "file_index_storage_info" => respond(crate::file_index::file_index_storage_info(state).await),
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
        "detect_opencode_install" => respond_omni(crate::system_cmds::detect_opencode_install().await),
        "ai_services_probe" => {
            let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
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
        "local_runtime_refresh_catalog" => respond(crate::local_runtime_cmds::local_runtime_refresh_catalog().await),
        "local_runtime_start_ollama" => respond(crate::local_runtime_cmds::local_runtime_start_ollama().await),
        "local_runtime_install_ollama" => respond(crate::local_runtime_cmds::local_runtime_install_ollama().await),
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
        "local_runtime_ollama_download_url" => respond(crate::local_runtime_cmds::local_runtime_ollama_download_url().await),
        "bg_task_submit_ollama_install" => respond_omni(crate::bg_task_cmds::bg_task_submit_ollama_install(state).await),
        "bg_task_submit_ollama_pull" => {
            let model = get_str(&args, "model").unwrap_or_default();
            respond_omni(crate::bg_task_cmds::bg_task_submit_ollama_pull(state, model).await)
        }

        /* ---------------- 资源画像 ---------------- */
        "resource_collect_ssh_snapshot" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::resource_profile_cmds::resource_collect_ssh_snapshot(state, resource_id).await)
        }
        "resource_collect_database_snapshot" => {
            let connection_name = get_str(&args, "connectionName").unwrap_or_default();
            respond_omni(crate::resource_profile_cmds::resource_collect_database_snapshot(state, connection_name).await)
        }
        "resource_compute_observation_diff" => {
            let resource_type = get_str(&args, "resourceType").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let observation_kind = get_str(&args, "observationKind").unwrap_or_default();
            respond_omni(crate::resource_profile_cmds::resource_compute_observation_diff(state, resource_type, resource_id, observation_kind).await)
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
            let req: omnipanel_store::SaveTaskRequest = match serde_json::from_value(args.get("req").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 req 失败: {e}")),
            };
            respond_omni(crate::store_ext::task_save(state, req).await)
        }
        "task_update_status" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let status: omnipanel_store::TaskStatus = match serde_json::from_value(args.get("status").cloned().unwrap_or_default()) {
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
            respond_omni(crate::bg_task_cmds::task_events_list(state, module, workspace_id, resource_id, source, limit).await)
        }
        "execute_action" => {
            let action: omnipanel_exec::ActionRequest = match serde_json::from_value(args.get("action").cloned().unwrap_or_default()) {
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
            let entry: omnipanel_store::AuditEntry = match serde_json::from_value(args.get("entry").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 entry 失败: {e}")),
            };
            respond(crate::store_ext::audit_log_append(state, entry).await)
        }
        "third_party_account_list" => respond(crate::store_ext::third_party_account_list(state).await),
        "third_party_account_upsert" => {
            let input: omnipanel_store::UpsertThirdPartyAccountInput = match serde_json::from_value(args.get("input").cloned().unwrap_or_default()) {
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
            let expire_in_sec = args.get("expireInSec").and_then(|v| v.as_u64()).map(|n| n as u32);
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
        "auth_login_github_cancel" => respond_omni(crate::auth_cmds::auth_login_github_cancel().await),
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
            let expire_in_sec = args.get("expireInSec").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::auth_cmds::auth_link_wechat_wait(token, login_id, expire_in_sec).await)
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
        "auth_link_github_cancel" => respond_omni(crate::auth_cmds::auth_link_github_cancel().await),
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
            let expire_in_sec = args.get("expireInSec").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::auth_cmds::auth_bindings_wait(token, bind_id, expire_in_sec).await)
        }
        "auth_bindings_cancel_wait" => {
            let bind_id = get_str(&args, "bindId").unwrap_or_default();
            respond_omni(crate::auth_cmds::auth_bindings_cancel_wait(bind_id).await)
        }

        /* ---------------- 助手 / 客户端同步 ---------------- */
        "assistant_push_snapshot" => {
            let request: crate::assistant_cmds::AssistantPushRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond_omni(crate::assistant_cmds::assistant_push_snapshot(state, request).await)
        }
        "assistant_upload_oss_text" => {
            let request: crate::assistant_cmds::AssistantUploadTextRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
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
            respond_omni(crate::assistant_cmds::assistant_chat_fetch_object(token, object_key).await)
        }
        "assistant_chat_inbox_start" => {
            let token = get_str(&args, "token").unwrap_or_default();
            respond_omni(crate::assistant_cmds::assistant_chat_inbox_start(state, token).await)
        }
        "assistant_chat_inbox_stop" => respond_omni(crate::assistant_cmds::assistant_chat_inbox_stop().await),
        "client_sync_push_conversations" => {
            let request: crate::client_sync_cmds::ClientSyncPushConversationsRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond_omni(crate::client_sync_cmds::client_sync_push_conversations(state, request).await)
        }
        "client_sync_push_modules" => {
            let request: crate::client_sync_modules_cmds::ClientSyncPushModulesRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond_omni(crate::client_sync_modules_cmds::client_sync_push_modules(state, request).await)
        }
        "client_sync_peek_device" => {
            let request: crate::client_sync_modules_cmds::ClientSyncPeekRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond_omni(crate::client_sync_modules_cmds::client_sync_peek_device(state, request).await)
        }
        "client_sync_import_from_device" => {
            let request: crate::client_sync_modules_cmds::ClientSyncImportRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond_omni(crate::client_sync_modules_cmds::client_sync_import_from_device(state, request).await)
        }

        /* ---------------- 密文库 ---------------- */
        "secrets_vault_status" => respond_omni(crate::store_ext::secrets_vault_status(state).await),
        "secrets_vault_unlock" => {
            let device_code = get_str(&args, "deviceCode").unwrap_or_default();
            respond_omni(crate::store_ext::secrets_vault_unlock(device_code).await)
        }
        "secrets_vault_lock" => respond_omni(crate::store_ext::secrets_vault_lock().await),
        "secrets_vault_push" => {
            let request: crate::store_ext::SecretsVaultPushRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond_omni(crate::store_ext::secrets_vault_push(state, request).await)
        }
        "secrets_vault_pull" => {
            let request: crate::store_ext::SecretsVaultPullRequest = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 request 失败: {e}")),
            };
            respond_omni(crate::store_ext::secrets_vault_pull(state, request).await)
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
            let prompt_args: crate::acp_cmds::AcpPromptArgs = match serde_json::from_value(args.clone()) {
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
            let request_id = args.get("requestId").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let option_id = get_str(&args, "optionId").unwrap_or_default();
            match crate::acp_cmds::acp_respond_permission(state, request_id, option_id).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "acp_save_agent_config" => {
            let config: crate::acp_cmds::AcpAgentConfigInput = match serde_json::from_value(args.get("config").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("解析 config 失败: {e}")),
            };
            respond(crate::acp_cmds::acp_save_agent_config(config).await)
        }

        /* ---------------- 暂缓（sniffer / updater） ---------------- */
        "sniffer_list_interfaces" => InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_list_interfaces")),
        "sniffer_start_capture" => InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_start_capture")),
        "sniffer_stop_capture" => InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_stop_capture")),
        "sniffer_get_packets" => InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_get_packets")),
        "sniffer_get_stats" => InvokeResponse::err(crate::defer_cmds::deferred_error("sniffer_get_stats")),
        "check_update" => InvokeResponse::err(crate::defer_cmds::deferred_error("check_update")),
        "install_update" => InvokeResponse::err(crate::defer_cmds::deferred_error("install_update")),
'''

SSH_CONNECT_PATCH_OLD = """        "ssh_connect_connection" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match crate::ssh::ssh_connect_connection(state, connection_id, cols, rows).await {"""

SSH_CONNECT_PATCH_NEW = """        "ssh_connect_connection" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let pane_id = args.get("paneId").and_then(|v| v.as_u64()).map(|n| n as u32);
            match crate::ssh::ssh_connect_connection(state, connection_id, cols, rows, pane_id).await {"""


def split_arms(block: str) -> dict[str, str]:
    """按 match arm 切分 BLOCK，返回 cmd -> 完整 arm 文本。"""
    arms: dict[str, str] = {}
    chunks = re.split(r"\n(?=        \"[a-z0-9_]+\" =>)", block.strip())
    for chunk in chunks:
        chunk = chunk.strip("\n")
        if not chunk.strip():
            continue
        m = re.match(r"        \"([a-z0-9_]+)\" =>", chunk)
        if not m:
            continue
        cmd = m.group(1)
        arms[cmd] = chunk if chunk.startswith("        ") else "        " + chunk
    return arms


def registered_commands(text: str) -> set[str]:
    return set(re.findall(r'"([a-z0-9_]+)"\s*=>', text))


def main() -> int:
    if not IPC_PATH.is_file():
        print(f"error: ipc.rs not found: {IPC_PATH}", file=sys.stderr)
        return 1

    text = IPC_PATH.read_text(encoding="utf-8")
    if MARKER not in text:
        print("error: soft_degrade marker not found in ipc.rs", file=sys.stderr)
        return 1

    registered = registered_commands(text)
    all_arms = split_arms(BLOCK)
    missing = [cmd for cmd in all_arms if cmd not in registered]
    if not missing:
        print("all arms already registered (0 inserted)")
        return 0

    insert_lines: list[str] = []
    for cmd in all_arms:
        if cmd in registered:
            continue
        insert_lines.append(all_arms[cmd])

    patch_applied = False
    if SSH_CONNECT_PATCH_OLD in text and SSH_CONNECT_PATCH_NEW not in text:
        text = text.replace(SSH_CONNECT_PATCH_OLD, SSH_CONNECT_PATCH_NEW, 1)
        patch_applied = True

    insertion = "\n".join(insert_lines) + "\n"
    text = text.replace(MARKER, insertion + MARKER, 1)
    IPC_PATH.write_text(text, encoding="utf-8")

    deferred_inserted = sum(1 for c in missing if c in DEFERRED)
    print(f"inserted {len(missing)} command arm(s)")
    if patch_applied:
        print("patched ssh_connect_connection pane_id forwarding")
    if deferred_inserted:
        print(f"  deferred: {deferred_inserted}")
    print(f"  commands: {', '.join(missing)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
