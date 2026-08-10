# -*- coding: utf-8 -*-
"""批量注册已实现但未挂入 ipc 的模块命令。"""
from pathlib import Path

p = Path(r"c:/Users/chaoj/dev/omnipanel/crates/omnipanel-server/src/ipc.rs")
t = p.read_text(encoding="utf-8")
marker = "        other => InvokeResponse::ok(crate::soft_degrade::soft_degrade_value(other)),"
if marker not in t:
    raise SystemExit("marker missing")

if '"skill_list"' in t and '"knowledge_list"' in t and '"docker_swarm_init"' in t:
    print("batch already registered")
    raise SystemExit(0)

block = r'''
        /* ---------------- 终端历史 / 连接池 / 本地进程 ---------------- */
        "terminal_history_load_session" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            respond_omni(crate::terminal_history::terminal_history_load_session(state, session_id).await)
        }
        "terminal_history_upsert_blocks" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            let workspace_id = get_str(&args, "workspaceId");
            let blocks = match serde_json::from_value(args.get("blocks").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid blocks: {e}")),
            };
            let policy = match serde_json::from_value(args.get("policy").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid policy: {e}")),
            };
            respond_omni(crate::terminal_history::terminal_history_upsert_blocks(state, session_id, workspace_id, blocks, policy).await)
        }
        "terminal_history_remove_block" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            let block_id = get_str(&args, "blockId").unwrap_or_default();
            respond_omni(crate::terminal_history::terminal_history_remove_block(state, session_id, block_id).await)
        }
        "terminal_history_clear_session" => {
            let session_id = get_str(&args, "sessionId").unwrap_or_default();
            respond_omni(crate::terminal_history::terminal_history_clear_session(state, session_id).await)
        }
        "terminal_history_clear_all" => respond_omni(crate::terminal_history::terminal_history_clear_all(state).await),
        "terminal_history_counts" => respond_omni(crate::terminal_history::terminal_history_counts(state).await),
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
            let signal = args.get("signal").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::ssh_ops::ssh_pool_kill_process(state, resource_id, pid, signal).await)
        }
        "ssh_pool_create_run_script" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            let content = get_str(&args, "content").unwrap_or_default();
            let script_args: Option<Vec<String>> = args.get("args").and_then(|v| serde_json::from_value(v.clone()).ok());
            let timeout_secs = args.get("timeoutSecs").and_then(|v| v.as_u64());
            respond_omni(crate::ssh_ops::ssh_pool_create_run_script(state, resource_id, name, content, script_args, timeout_secs).await)
        }
        "ssh_pool_load_overview" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::ssh_ops::ssh_pool_load_overview(state, resource_id).await)
        }
        "ssh_pool_release" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::ssh_ops::ssh_pool_release(state, resource_id).await)
        }
        "ssh_pool_get_active_sessions" => respond_omni(crate::ssh_ops::ssh_pool_get_active_sessions(state).await),
        "ssh_pool_probe_all" => respond_omni(crate::ssh_ops::ssh_pool_probe_all(state).await),
        "ssh_pool_download_install_binary" => {
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let url = get_str(&args, "url").unwrap_or_default();
            let dest = get_str(&args, "dest").unwrap_or_default();
            respond_omni(crate::ssh_ops::ssh_pool_download_install_binary(state, resource_id, url, dest).await)
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
                None => match serde_json::from_value::<Vec<u8>>(args.get("data").cloned().unwrap_or_default()) {
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
            let from = get_str(&args, "from").or_else(|| get_str(&args, "oldPath")).unwrap_or_default();
            let to = get_str(&args, "to").or_else(|| get_str(&args, "newPath")).unwrap_or_default();
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
            respond(crate::docker_swarm::docker_swarm_init(state, connection_id, listen_addr, advertise_addr).await)
        }
        "docker_swarm_join" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let remote_addrs: Vec<String> = args.get("remoteAddrs").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            let token = get_str(&args, "token").unwrap_or_default();
            let listen_addr = get_str(&args, "listenAddr");
            respond(crate::docker_swarm::docker_swarm_join(state, connection_id, remote_addrs, token, listen_addr).await)
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
            let request = match serde_json::from_value(args.get("request").cloned().unwrap_or(args.clone())) {
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
            respond(crate::docker_swarm::docker_service_update(state, connection_id, service_id, replicas, image).await)
        }
        "docker_service_remove" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let service_id = get_str(&args, "serviceId").unwrap_or_default();
            respond(crate::docker_swarm::docker_service_remove(state, connection_id, service_id).await)
        }
        "docker_service_logs" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let service_id = get_str(&args, "serviceId").unwrap_or_default();
            let tail = get_str(&args, "tail").or_else(|| args.get("tail").and_then(|v| v.as_u64()).map(|n| n.to_string()));
            respond(crate::docker_swarm::docker_service_logs(state, connection_id, service_id, tail).await)
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
            let labels: Option<Vec<_>> = args.get("labels").and_then(|v| serde_json::from_value(v.clone()).ok());
            respond(crate::docker_swarm::docker_node_update(state, connection_id, node_id, availability, labels).await)
        }
        "docker_node_remove" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let node_id = get_str(&args, "nodeId").unwrap_or_default();
            let force = args.get("force").and_then(|v| v.as_bool()).unwrap_or(false);
            respond(crate::docker_swarm::docker_node_remove(state, connection_id, node_id, force).await)
        }
        "docker_stack_deploy" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let name = get_str(&args, "name").unwrap_or_default();
            let compose = get_str(&args, "composeContent").or_else(|| get_str(&args, "compose")).unwrap_or_default();
            let env: Option<Vec<String>> = args.get("env").and_then(|v| serde_json::from_value(v.clone()).ok());
            respond(crate::docker_swarm::docker_stack_deploy(state, connection_id, name, compose, env).await)
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
            let ssh_connection_id = get_str(&args, "sshConnectionId").or_else(|| get_str(&args, "connectionId")).unwrap_or_default();
            respond_omni(crate::docker_ssh_detect::docker_probe_ssh_docker(state, ssh_connection_id).await)
        }
        "docker_list_ssh_hosts" => respond_omni(crate::docker_ssh_detect::docker_list_ssh_hosts(state).await),
        "docker_scan_ssh_docker_hosts" => {
            let auto_save = args.get("autoSave").and_then(|v| v.as_bool()).unwrap_or(false);
            respond_omni(crate::docker_ssh_detect::docker_scan_ssh_docker_hosts(state, auto_save).await)
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
            respond(crate::store_bridge::docker_list_sidebar_cache_page(connection_id, category, offset, limit).await)
        }

        /* ---------------- Skills / Provider / Embedding / WebSearch ---------------- */
        "skill_list" => respond(crate::skills_cmds::skill_list().await),
        "skill_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::skill_get(id).await)
        }
        "skill_create" => {
            let input = match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
            };
            respond(crate::skills_cmds::skill_create(state, input).await)
        }
        "skill_update" => {
            let input = match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
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
            let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
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
            let limit = args.get("limit").and_then(|v| v.as_f64()).or_else(|| args.get("limit").and_then(|v| v.as_u64()).map(|n| n as f64));
            respond(crate::skills_cmds::skill_list_applications(state, id, limit).await)
        }
        "skill_update_application_outcome" => {
            let application_id = get_str(&args, "applicationId").unwrap_or_default();
            let outcome = get_str(&args, "outcome").unwrap_or_default();
            let feedback = get_str(&args, "feedback");
            respond(crate::skills_cmds::skill_update_application_outcome(state, application_id, outcome, feedback).await)
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
            let provider = match serde_json::from_value(args.get("provider").cloned().unwrap_or_default()) {
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
            let file = match serde_json::from_value(args.get("file").cloned().unwrap_or(args.clone())) {
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
            let input = match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
            };
            respond(crate::skills_cmds::cli_provider_patch(input))
        }
        "cli_provider_upsert_cmd" => {
            let input = match serde_json::from_value(args.get("input").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid input: {e}")),
            };
            respond(crate::skills_cmds::cli_provider_upsert(input))
        }
        "cli_provider_remove_cmd" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond(crate::skills_cmds::cli_provider_remove(&id))
        }
        "embedding_provider_get" => respond_omni(crate::embedding_cmds::embedding_provider_get().await),
        "embedding_provider_sync" => {
            let provider = match serde_json::from_value(args.get("provider").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid provider: {e}")),
            };
            respond_omni(crate::embedding_cmds::embedding_provider_sync(provider).await)
        }
        "web_search_get_config" => respond_omni(crate::web_search_cmds::web_search_get_config().await),
        "web_search_set_config" => {
            let config = match serde_json::from_value(args.get("config").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid config: {e}")),
            };
            respond_omni(crate::web_search_cmds::web_search_set_config(config).await)
        }
        "web_search_set_exa_key" => {
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_exa_key(api_key).await)
        }
        "web_search_exa_key_configured" => respond_omni(crate::web_search_cmds::web_search_exa_key_configured().await),
        "web_search_set_jina_key" => {
            let api_key = get_str(&args, "apiKey").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_jina_key(api_key).await)
        }
        "web_search_jina_key_configured" => respond_omni(crate::web_search_cmds::web_search_jina_key_configured().await),
        "web_search_set_zhihu_secret" => {
            let secret = get_str(&args, "secret").unwrap_or_default();
            respond_omni(crate::web_search_cmds::web_search_set_zhihu_secret(secret).await)
        }
        "web_search_zhihu_secret_configured" => respond_omni(crate::web_search_cmds::web_search_zhihu_secret_configured().await),
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
            let session_id = get_str(&args, "sessionId").or_else(|| get_str(&args, "conversationId")).unwrap_or_default();
            respond_omni(crate::store_bridge::ai_list_session_traces(state, session_id).await)
        }
        "builtin_tool_set_internal_enabled" => {
            let tool_name = get_str(&args, "toolName").unwrap_or_default();
            let enabled = args.get("enabled").and_then(|v| v.as_bool()).unwrap_or(true);
            respond_omni(crate::store_bridge::builtin_tool_set_internal_enabled(state, tool_name, enabled).await)
        }
        "builtin_tool_set_external_exposed" => {
            let tool_name = get_str(&args, "toolName").unwrap_or_default();
            let exposed = args.get("exposed").and_then(|v| v.as_bool()).unwrap_or(true);
            respond_omni(crate::store_bridge::builtin_tool_set_external_exposed(state, tool_name, exposed).await)
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
            let entry = match serde_json::from_value(args.get("entry").cloned().unwrap_or(args.clone())) {
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
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let revision_id = get_str(&args, "revisionId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_restore_revision(state, entry_id, revision_id).await)
        }
        "knowledge_save_asset" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let file_name = get_str(&args, "fileName").unwrap_or_default();
            let bytes = match serde_json::from_value::<Vec<u8>>(
                args.get("bytes").cloned().or_else(|| args.get("data").cloned()).unwrap_or_default(),
            ) {
                Ok(b) => b,
                Err(e) => return InvokeResponse::err(format!("invalid bytes: {e}")),
            };
            respond_omni(crate::knowledge_cmds::knowledge_save_asset(entry_id, file_name, bytes).await)
        }
        "knowledge_asset_path" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let file_name = get_str(&args, "fileName").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_asset_path(entry_id, file_name).await)
        }
        "knowledge_list_chunks" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let offset = args.get("offset").and_then(|v| v.as_u64()).map(|n| n as u32);
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::knowledge_cmds::knowledge_list_chunks(state, entry_id, offset, limit).await)
        }
        "knowledge_import_pdf" => {
            let path = get_str(&args, "path").unwrap_or_default();
            let parent_id = get_str(&args, "parentId");
            respond_omni(crate::knowledge_cmds::knowledge_import_pdf(state, path, parent_id).await)
        }
        "knowledge_delete_chunks" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            let chunk_ids: Vec<String> = args.get("chunkIds").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            respond_omni(crate::knowledge_cmds::knowledge_delete_chunks(state, entry_id, chunk_ids).await)
        }
        "knowledge_todo_list" => respond_omni(crate::knowledge_cmds::knowledge_todo_list(state).await),
        "knowledge_todo_save" => {
            let list = match serde_json::from_value(args.get("list").cloned().unwrap_or(args.clone())) {
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
            let args_in = match serde_json::from_value(args.clone()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
            };
            respond_omni(crate::knowledge_vector_cmds::knowledge_vectorize(state, args_in).await)
        }
        "knowledge_vector_status" => {
            let entry_id = get_str(&args, "entryId").unwrap_or_default();
            respond_omni(crate::knowledge_vector_cmds::knowledge_vector_status(state, entry_id).await)
        }
        "knowledge_recall_test" => {
            let args_in = match serde_json::from_value(args.clone()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
            };
            respond_omni(crate::knowledge_vector_cmds::knowledge_recall_test(state, args_in).await)
        }
        "knowledge_query_document" => {
            let args_in = match serde_json::from_value(args.clone()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid args: {e}")),
            };
            respond_omni(crate::knowledge_vector_cmds::knowledge_query_document(state, args_in).await)
        }
        "tag_list_tree" => {
            let include_counts = args.get("includeCounts").and_then(|v| v.as_bool());
            respond_omni(crate::knowledge_cmds::tag_list_tree(state, include_counts).await)
        }
        "tag_list_used_by" => {
            let tag_id = get_str(&args, "tagId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::tag_list_used_by(state, tag_id).await)
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
            let parent_id = get_str(&args, "parentId");
            respond_omni(crate::knowledge_cmds::tag_move(state, id, parent_id).await)
        }
        "tag_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::tag_delete(state, id).await)
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
            let tag_ids: Vec<String> = args.get("tagIds").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_set_tags(state, kind, resource_id, tag_ids).await)
        }
        "resource_add_tag" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let tag_id = get_str(&args, "tagId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_add_tag(state, kind, resource_id, tag_id).await)
        }
        "resource_remove_tag" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let tag_id = get_str(&args, "tagId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_remove_tag(state, kind, resource_id, tag_id).await)
        }
        "resource_set_system_tag" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let key = get_str(&args, "key").unwrap_or_default();
            let value = get_str(&args, "value").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_set_system_tag(state, kind, resource_id, key, value).await)
        }
        "tag_query_resources" => {
            let tag_ids: Vec<String> = args.get("tagIds").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            let kind = get_str(&args, "kind");
            respond_omni(crate::knowledge_cmds::tag_query_resources(state, tag_ids, kind).await)
        }
        "tag_suggest" => {
            let query = get_str(&args, "query").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::knowledge_cmds::tag_suggest(state, query, limit).await)
        }
        "search_everywhere" => {
            let query = get_str(&args, "query").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::knowledge_cmds::search_everywhere(state, query, limit).await)
        }
        "todo_list_list" => respond_omni(crate::knowledge_cmds::todo_list_list(state).await),
        "todo_list_save" => {
            let list = match serde_json::from_value(args.get("list").cloned().unwrap_or(args.clone())) {
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
            let list_id = get_str(&args, "listId");
            let status = get_str(&args, "status");
            respond_omni(crate::knowledge_cmds::todo_task_list(state, list_id, status).await)
        }
        "todo_task_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::todo_task_get(state, id).await)
        }
        "todo_task_save" => {
            let task = match serde_json::from_value(args.get("task").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid task: {e}")),
            };
            respond_omni(crate::knowledge_cmds::todo_task_save(state, task).await)
        }
        "todo_task_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::todo_task_delete(state, id).await)
        }
        "todo_step_save" => {
            let step = match serde_json::from_value(args.get("step").cloned().unwrap_or(args.clone())) {
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
            let kind = get_str(&args, "kind");
            respond_omni(crate::knowledge_cmds::resource_list_profiles(state, kind).await)
        }
        "resource_get_profile" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_get_profile(state, kind, resource_id).await)
        }
        "resource_find_similar" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            let limit = args.get("limit").and_then(|v| v.as_u64()).map(|n| n as u32);
            respond_omni(crate::knowledge_cmds::resource_find_similar(state, kind, resource_id, limit).await)
        }
        "resource_delete_observations" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_delete_observations(state, kind, resource_id).await)
        }
        "resource_list_knowledge" => {
            let kind = get_str(&args, "kind").unwrap_or_default();
            let resource_id = get_str(&args, "resourceId").unwrap_or_default();
            respond_omni(crate::knowledge_cmds::resource_list_knowledge(state, kind, resource_id).await)
        }
        "resource_save_observation" => {
            let observation = match serde_json::from_value(args.get("observation").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid observation: {e}")),
            };
            respond_omni(crate::knowledge_cmds::resource_save_observation(state, observation).await)
        }

        /* ---------------- Workflow / Task store ---------------- */
        "workflow_list" => respond_omni(crate::workflow_cmds::workflow_list(state).await),
        "workflow_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::workflow_cmds::workflow_get(state, id).await)
        }
        "workflow_save" => {
            let req = match serde_json::from_value(args.get("req").cloned().unwrap_or(args.clone())) {
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
            let execution_id = get_str(&args, "executionId").or_else(|| get_str(&args, "id")).unwrap_or_default();
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
        "task_list" => {
            let status_filter = get_str(&args, "statusFilter").or_else(|| get_str(&args, "status"));
            let limit = args.get("limit").and_then(|v| v.as_i64());
            respond_omni(crate::store_ext::task_list(state, status_filter, limit).await)
        }
        "task_get" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::store_ext::task_get(state, id).await)
        }
        "task_save" => {
            let req = match serde_json::from_value(args.get("req").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid req: {e}")),
            };
            respond_omni(crate::store_ext::task_save(state, req).await)
        }
        "task_update_status" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let status = match serde_json::from_value(args.get("status").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid status: {e}")),
            };
            respond_omni(crate::store_ext::task_update_status(state, id, status).await)
        }
        "task_delete" => {
            let id = get_str(&args, "id").unwrap_or_default();
            respond_omni(crate::store_ext::task_delete(state, id).await)
        }
        "audit_log_recent" => {
            let limit = args.get("limit").and_then(|v| v.as_i64());
            respond_omni(crate::store_ext::audit_log_recent(state, limit).await)
        }

        /* ---------------- gRPC / Modbus ---------------- */
        "grpc_connect" => {
            let config = match serde_json::from_value(args.get("config").cloned().unwrap_or(args.clone())) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid config: {e}")),
            };
            respond(crate::protocol_cmds::grpc_connect(state, config).await)
        }
        "grpc_call" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            let request = match serde_json::from_value(args.get("request").cloned().unwrap_or_default()) {
                Ok(v) => v,
                Err(e) => return InvokeResponse::err(format!("invalid request: {e}")),
            };
            respond(crate::protocol_cmds::grpc_call(state, connection_id, request).await)
        }
        "grpc_close" => {
            let connection_id = get_str(&args, "connectionId").unwrap_or_default();
            respond(crate::protocol_cmds::grpc_close(state, connection_id).await)
        }
        "grpc_list_connections" => respond(crate::protocol_cmds::grpc_list_connections(state).await),
        "modbus_connect" => {
            let config = match serde_json::from_value(args.get("config").cloned().unwrap_or(args.clone())) {
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
            respond(crate::protocol_cmds::modbus_write_single_register(state, id, addr, value).await)
        }
        "modbus_write_multiple_coils" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let values: Vec<bool> = args.get("values").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            respond(crate::protocol_cmds::modbus_write_multiple_coils(state, id, addr, values).await)
        }
        "modbus_write_multiple_registers" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let addr = args.get("addr").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            let values: Vec<u16> = args.get("values").and_then(|v| serde_json::from_value(v.clone()).ok()).unwrap_or_default();
            respond(crate::protocol_cmds::modbus_write_multiple_registers(state, id, addr, values).await)
        }

'''

# Avoid duplicate arms already present
skip_cmds = []
for line in block.splitlines():
    line = line.strip()
    if line.startswith('"') and '" =>' in line:
        cmd = line.split('"')[1]
        if f'"{cmd}"' in t:
            skip_cmds.append(cmd)

if skip_cmds:
    # Filter out already-registered command arms (multi-line aware: drop until next "xxx" => or comment/other)
    lines = block.splitlines(True)
    out = []
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if stripped.startswith('"') and '" =>' in stripped:
            cmd = stripped.split('"')[1]
            if cmd in skip_cmds:
                # skip until next top-level arm / section / end
                i += 1
                while i < len(lines):
                    s = lines[i].strip()
                    if s.startswith('"') and '" =>' in s:
                        break
                    if s.startswith('/*') or s == '':
                        # keep blank/comments only if not mid-arm; mid-arm has content
                        if s.startswith('/*'):
                            break
                    # if line starts a new section comment after closing brace of skipped arm
                    if s.startswith('/*') :
                        break
                    i += 1
                continue
        out.append(line)
        i += 1
    block = ''.join(out)
    print(f"skipped already registered: {len(skip_cmds)}")

p.write_text(t.replace(marker, block + marker, 1), encoding="utf-8")
print("inserted module batch arms")
