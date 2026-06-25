mod background;
mod commands;
mod log_store;
mod output_buffer;
mod panel;
mod protocol;
mod state;

use std::sync::Arc;

use state::AppState;
use tauri::Manager;
use tokio::sync::Mutex;

/// reqwest 0.13（rmcp、tauri-plugin-updater 等）使用 rustls-no-provider，
/// 必须在首次构建 TLS Client 前安装 crypto provider。沿用 ring 后端，避免 Windows 上 aws-lc-rs 依赖 NASM。
fn ensure_rustls_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_some() {
        return;
    }
    rustls::crypto::ring::default_provider()
        .install_default()
        .expect("install rustls ring crypto provider");
}

/// 仅在 debug 构建时，用 tauri-specta 导出前端 IPC 类型与 typed client。
/// 运行期命令注册仍走 `tauri::generate_handler!`，specta 不接管路由，零运行时风险。
#[cfg(debug_assertions)]
fn export_ipc_bindings() {
    use tauri_specta::{Builder, collect_commands};

    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::terminal::create_terminal,
        commands::terminal::write_terminal,
        commands::terminal::resize_terminal,
        commands::terminal::close_terminal,
        commands::terminal::terminal_snapshot,
        commands::database::db_list_connections,
        commands::database::db_save_connection,
        commands::database::db_delete_connection,
        commands::database::db_load_schema_filters,
        commands::database::db_save_schema_filters,
        commands::database::db_load_schema_tree_expanded,
        commands::database::db_save_schema_tree_expanded,
        commands::database::db_load_schema_cache,
        commands::database::db_save_schema_cache,
        commands::database::db_test_connection,
        commands::database::db_list_databases,
        commands::database::db_create_database,
        commands::database::db_introspect_schema,
        commands::database::db_list_connection_users,
        commands::database::db_introspect_table,
        commands::database::db_list_tables,
        commands::database::db_table_ddl,
        commands::connection::conn_list,
        commands::connection::conn_save,
        commands::connection::conn_delete,
        commands::connection::conn_test,
        commands::pool::pool_get_summary,
        commands::panel::panel_1panel_request,
        commands::panel::panel_1panel_test_connection,
        commands::panel::panel_1panel_app_icon,
        commands::panel::panel_1panel_request_text,
        commands::panel::panel_bt_request,
        commands::panel::panel_bt_test_connection,
        commands::docker::docker_list_connections,
        commands::docker::docker_probe_connection,
        commands::docker::docker_reset_ssh_session,
        commands::docker::docker_get_local_engine_status,
        commands::docker::docker_start_local_engine,
        commands::docker::docker_get_overview,
        commands::docker::docker_get_system_disk_usage,
        commands::docker::docker_list_containers,
        commands::docker::docker_inspect_container,
        commands::docker::docker_container_action,
        commands::docker::docker_container_logs,
        commands::docker::docker_stream_container_logs,
        commands::docker::docker_stop_log_stream,
        commands::docker::docker_list_images,
        commands::docker::docker_remove_image,
        commands::docker::docker_prune_images,
        commands::docker::docker_prune_build_cache,
        commands::docker::docker_inspect_image,
        commands::docker::docker_image_history,
        commands::docker::docker_create_exec_session,
        commands::docker::docker_exec_write,
        commands::docker::docker_exec_resize,
        commands::docker::docker_exec_close,
        commands::docker::docker_list_compose_projects,
        commands::docker::docker_compose_action,
        commands::docker::docker_list_networks,
        commands::docker::docker_create_network,
        commands::docker::docker_remove_network,
        commands::docker::docker_inspect_network,
        commands::docker::docker_connect_network,
        commands::docker::docker_disconnect_network,
        commands::docker::docker_list_volumes,
        commands::docker::docker_create_volume,
        commands::docker::docker_remove_volume,
        commands::docker::docker_inspect_volume,
        commands::docker::docker_prune_volumes,
        commands::docker::docker_list_container_dir,
        commands::docker::docker_read_container_file,
        commands::docker::docker_write_container_file,
        commands::docker::docker_pull_image,
        commands::docker::docker_push_image,
        commands::docker::docker_tag_image,
        commands::docker::docker_build_image,
        commands::docker::docker_stream_stats,
        commands::docker::docker_stop_stats_stream,
        commands::docker::docker_probe_ssh_docker,
        commands::docker::docker_list_ssh_hosts,
        commands::docker::docker_scan_ssh_docker_hosts,
        commands::docker::docker_create_container,
        commands::docker::docker_swarm_init,
        commands::docker::docker_swarm_join,
        commands::docker::docker_swarm_leave,
        commands::docker::docker_swarm_inspect,
        commands::docker::docker_service_list,
        commands::docker::docker_service_create,
        commands::docker::docker_service_update,
        commands::docker::docker_service_remove,
        commands::docker::docker_service_logs,
        commands::docker::docker_node_list,
        commands::docker::docker_node_inspect,
        commands::docker::docker_node_update,
        commands::docker::docker_node_remove,
        commands::docker::docker_stack_deploy,
        commands::docker::docker_stack_list,
        commands::docker::docker_stack_remove,
        commands::docker::docker_stack_services,
        commands::exec::execute_action,
        commands::ssh::ssh_connect,
        commands::ssh::ssh_write,
        commands::ssh::ssh_resize,
        commands::ssh::ssh_disconnect,
        commands::ssh::sftp_list,
        commands::ssh::sftp_download,
        commands::ssh::sftp_upload,
        commands::ssh::sftp_mkdir,
        commands::ssh::sftp_remove,
        commands::ssh::sftp_rename,
        commands::ssh::sftp_chmod,
        commands::ssh::ssh_list_config_hosts,
        commands::ssh::ssh_sync_config_hosts,
        commands::ssh::ssh_connect_config_host,
        commands::ssh::ssh_process_list,
        commands::ssh::ssh_pool_load_overview,
        commands::ssh::ssh_pool_release,
        commands::ssh::ssh_pool_fetch_stats,
        commands::ssh::ssh_pool_get_statuses,
        commands::ssh::ssh_pool_get_active_sessions,
        commands::ssh::ssh_pool_subscribe_monitoring,
        commands::ssh::ssh_pool_unsubscribe_monitoring,
        commands::ssh::ssh_pool_load_processes,
        commands::ssh::ssh_pool_process_detail,
        commands::ssh::ssh_pool_kill_process,
        commands::system::local_fetch_stats,
        commands::system::local_list_processes,
        commands::system::local_process_detail,
        commands::system::local_kill_process,
        commands::system::list_system_fonts,
        commands::ssh::ssh_create_tunnel,
        commands::ssh::ssh_close_tunnel,
        commands::ssh::ssh_list_tunnels,
        commands::ssh::ssh_list_keys,
        commands::ssh::ssh_generate_key,
        commands::ssh::ssh_import_key,
        commands::ssh::ssh_delete_key,
        commands::ssh::ssh_read_key_public,
        commands::fileio::write_text_file,
        commands::file_manager::file_list_connections,
        commands::file_manager::file_save_connection,
        commands::file_manager::file_test_connection,
        commands::file_manager::file_list_dir,
        commands::file_manager::file_read_file,
        commands::file_manager::file_upload_file,
        commands::file_manager::file_download_file,
        commands::file_manager::file_mkdir,
        commands::file_manager::file_rename,
        commands::file_manager::file_delete,
        commands::file_manager::file_local_quick_paths,
        commands::file_index::file_index_build,
        commands::file_index::file_index_search,
        commands::file_index::file_index_status,
        commands::file_index::file_index_clear,
        commands::file_index::file_index_cancel,
        commands::file_index::file_index_storage_info,
        commands::file_index::set_file_index_storage_dir,
        commands::updater::check_update,
        commands::updater::install_update,
        commands::knowledge::knowledge_list,
        commands::knowledge::knowledge_get,
        commands::knowledge::knowledge_save,
        commands::knowledge::knowledge_delete,
        commands::knowledge::knowledge_search,
        commands::knowledge::knowledge_tags,
        commands::knowledge::knowledge_increment_usage,
        commands::knowledge::knowledge_todo_list,
        commands::knowledge::knowledge_todo_save,
        commands::knowledge::knowledge_todo_delete,
        commands::knowledge::knowledge_import_pdf,
        commands::knowledge_vector::knowledge_vectorize,
        commands::knowledge_vector::knowledge_vector_status,
        commands::workflow::workflow_list,
        commands::workflow::workflow_get,
        commands::workflow::workflow_save,
        commands::workflow::workflow_delete,
        commands::workflow::workflow_executions,
        commands::workflow::workflow_run,
        commands::workflow::workflow_stop,
        commands::workflow::workflow_get_execution,
        // Task（任务）
        commands::task::task_list,
        commands::task::task_get,
        commands::task::task_save,
        commands::task::task_update_status,
        commands::task::task_delete,
        commands::task::task_run,
        commands::task::task_stop,
        commands::task::task_get_output,
        // Protocol Lab — gRPC
        commands::grpc::grpc_connect,
        commands::grpc::grpc_call,
        commands::grpc::grpc_list_connections,
        commands::grpc::grpc_close,
        // Protocol Lab — HTTP history & collections
        commands::protocol::http_save_request,
        commands::protocol::http_list_requests,
        commands::protocol::http_delete_request,
        commands::protocol::http_add_history,
        commands::protocol::http_list_history,
        commands::protocol::http_clear_history,
        commands::protocol::http_save_collection,
        commands::protocol::http_list_collections,
        commands::protocol::http_delete_collection,
        // Protocol Lab — Sniffer
        commands::protocol::sniffer_list_interfaces,
        commands::protocol::sniffer_start_capture,
        commands::protocol::sniffer_stop_capture,
        commands::protocol::sniffer_get_packets,
        commands::protocol::sniffer_get_stats,
        // Modbus
        commands::protocol::modbus_connect,
        commands::protocol::modbus_read_coils,
        commands::protocol::modbus_read_discrete_inputs,
        commands::protocol::modbus_read_holding_registers,
        commands::protocol::modbus_read_input_registers,
        commands::protocol::modbus_write_single_coil,
        commands::protocol::modbus_write_single_register,
        commands::protocol::modbus_write_multiple_coils,
        commands::protocol::modbus_write_multiple_registers,
        commands::protocol::modbus_disconnect,
        commands::proxy::set_proxy_config,
        commands::proxy::get_proxy_config,
        // AI 模型持久化
        commands::ai_models::ai_models_load,
        commands::ai_models::ai_models_save,
        commands::db_sql_files::db_sql_files_load,
        commands::db_sql_files::db_sql_files_save,
        // MCP 服务管理
        commands::mcp::mcp_list_services,
        commands::mcp::mcp_upsert_service,
        commands::mcp::mcp_delete_service,
        commands::mcp::mcp_set_service_enabled,
        commands::mcp::mcp_set_service_running,
        commands::mcp::mcp_list_service_tools,
        commands::mcp::mcp_call_tool,
        
    ]);

    // 用 CARGO_MANIFEST_DIR 拼绝对路径，避免 cwd 在不同入口（cargo test/run）下不一致。
    let out_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend/src/ipc/bindings.ts");

    builder
        .export(specta_typescript::Typescript::default(), &out_path)
        .expect("failed to export typescript bindings");
}

fn try_migrate_legacy_storage(target: &std::path::Path, app: &tauri::App) {
    if target.is_file() {
        return;
    }
    let Ok(old_dir) = app.path().app_data_dir() else {
        return;
    };
    let legacy = old_dir.join("omnipanel.db");
    if !legacy.is_file() {
        return;
    }
    let _ = std::fs::copy(&legacy, target);
    tracing::info!(
        from = %legacy.display(),
        to = %target.display(),
        "已迁移旧版本地存储"
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    ensure_rustls_crypto_provider();
    tracing_subscriber::fmt::init();

    #[cfg(debug_assertions)]
    export_ipc_bindings();

    // 仅生成 IPC bindings 后退出（供脚本调用，不启动窗口）。
    #[cfg(debug_assertions)]
    if std::env::var("OMNIPANEL_GEN_BINDINGS_ONLY").is_ok() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let db_path =
                omnipanel_store::meta_db_path().expect("无法定位 ~/.omnipd/store/omnipanel.db");
            if let Some(parent) = db_path.parent() {
                std::fs::create_dir_all(parent).ok();
            }
            try_migrate_legacy_storage(&db_path, app);
            let storage = omnipanel_store::Storage::open(&db_path, None).expect("打开本地存储失败");
            let _ = omnipanel_store::FileIndexStorage::import_from_meta_storage_if_empty(&storage)
                .expect("迁移旧版文件索引失败");
            let file_index_storage = Arc::new(Mutex::new(
                omnipanel_store::FileIndexStorage::open_at_dir("")
                    .expect("打开文件索引存储失败"),
            ));
            let storage = Arc::new(Mutex::new(storage));
            let db_connections =
                omnipanel_store::DatabaseConnectionStore::open().expect("加载数据库连接配置失败");
            tracing::info!(
                root = %omnipanel_store::omnipd_root().expect("omnipd root").display(),
                "应用数据目录已就绪"
            );

            let mcp_manager = tauri::async_runtime::block_on(
                commands::mcp::init_mcp_manager(storage.clone()),
            )
            .expect("启动 MCP 管理器失败");

            let app_state = AppState::new(
                app.handle().clone(),
                storage,
                file_index_storage,
                String::new(),
                db_connections,
                mcp_manager,
            );
            let pool_storage = app_state.storage.clone();
            let ssh_pool = app_state.ssh_pool.clone();
            let ai_registry = app_state.ai_registry.clone();
            app.manage(app_state);

            // Try to auto-register Ollama provider (silent skip if unavailable)
            tauri::async_runtime::spawn(async move {
                match omnipanel_ai::providers::ollama::OllamaProvider::discover_default().await {
                    Some(provider) => {
                        let mut reg = ai_registry.lock().await;
                        reg.register(Box::new(provider));
                        tracing::info!("Ollama provider auto-registered with discovered models");
                    }
                    None => {
                        tracing::debug!("Ollama not available at localhost:11434, skipping");
                    }
                }
            });

            // 启动 SSH 端口探测后台任务
            background::BackgroundScheduler::start(ssh_pool, pool_storage, app.handle().clone());

            if let Some(window) = app.get_webview_window("main") {
                window.center().ok();
                #[cfg(any(debug_assertions, feature = "debug-inspector"))]
                if std::env::var("OMNIPANEL_OPEN_DEVTOOLS").is_ok() {
                    window.open_devtools();
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // AI
            commands::ai::ai_send_message,
            commands::ai::ai_list_models,
            commands::ai::ai_set_provider,
            commands::ai::ai_list_providers,
            commands::ai::ai_add_acp_agent,
            commands::ai::ai_get_active,
            commands::ai::ai_add_custom_provider,
            // Protocol Lab — Serial
            commands::protocol::serial_scan_ports,
            commands::protocol::serial_open,
            commands::protocol::serial_write,
            commands::protocol::serial_close,
            commands::protocol::serial_set_dtr,
            commands::protocol::serial_set_rts,
            // Protocol Lab — HTTP
            commands::protocol::http_request,
            commands::protocol::http_save_request,
            commands::protocol::http_list_requests,
            commands::protocol::http_delete_request,
            commands::protocol::http_add_history,
            commands::protocol::http_list_history,
            commands::protocol::http_clear_history,
            commands::protocol::http_save_collection,
            commands::protocol::http_list_collections,
            commands::protocol::http_delete_collection,
            // Protocol Lab — WebSocket
            commands::protocol::ws_connect,
            commands::protocol::ws_send_text,
            commands::protocol::ws_send_binary,
            commands::protocol::ws_ping,
            commands::protocol::ws_close,
            // Protocol Lab — MQTT
            commands::protocol::mqtt_connect,
            commands::protocol::mqtt_subscribe,
            commands::protocol::mqtt_unsubscribe,
            commands::protocol::mqtt_publish,
            commands::protocol::mqtt_disconnect,
            // Protocol Lab — Sniffer
            commands::protocol::sniffer_list_interfaces,
            commands::protocol::sniffer_start_capture,
            commands::protocol::sniffer_stop_capture,
            commands::protocol::sniffer_get_packets,
            commands::protocol::sniffer_get_stats,
            // Modbus
            commands::protocol::modbus_connect,
            commands::protocol::modbus_read_coils,
            commands::protocol::modbus_read_discrete_inputs,
            commands::protocol::modbus_read_holding_registers,
            commands::protocol::modbus_read_input_registers,
            commands::protocol::modbus_write_single_coil,
            commands::protocol::modbus_write_single_register,
            commands::protocol::modbus_write_multiple_coils,
            commands::protocol::modbus_write_multiple_registers,
            commands::protocol::modbus_disconnect,
            // Terminal
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::terminal_snapshot,
            // Database
            commands::database::db_list_connections,
            commands::database::db_save_connection,
            commands::database::db_delete_connection,
            commands::database::db_load_schema_filters,
            commands::database::db_save_schema_filters,
            commands::database::db_load_schema_tree_expanded,
            commands::database::db_save_schema_tree_expanded,
            commands::database::db_load_schema_cache,
            commands::database::db_save_schema_cache,
            commands::database::db_test_connection,
            commands::database::db_list_databases,
            commands::database::db_create_database,
            commands::database::db_introspect_schema,
            commands::database::db_list_connection_users,
            commands::database::db_introspect_table,
            commands::database::db_list_tables,
            commands::database::db_table_ddl,
            commands::database::db_preview_table,
            commands::database::db_count_table,
            commands::database::db_count_tables,
            commands::database::db_execute_query,
            commands::database::db_redis_search_keys,
            commands::database::db_refresh_schema_node,
            // Connections（统一连接模型）
            commands::connection::conn_list,
            commands::connection::conn_save,
            commands::connection::conn_delete,
            commands::connection::conn_test,
            commands::pool::pool_get_summary,
            // 面板 API
            commands::panel::panel_1panel_request,
            commands::panel::panel_1panel_test_connection,
            commands::panel::panel_1panel_app_icon,
            commands::panel::panel_1panel_request_text,
            commands::panel::panel_bt_request,
            commands::panel::panel_bt_test_connection,
            // Docker（容器工作区）
            commands::docker::docker_list_connections,
            commands::docker::docker_probe_connection,
            commands::docker::docker_reset_ssh_session,
            commands::docker::docker_get_local_engine_status,
            commands::docker::docker_start_local_engine,
            commands::docker::docker_get_overview,
            commands::docker::docker_get_system_disk_usage,
            commands::docker::docker_list_containers,
            commands::docker::docker_inspect_container,
            commands::docker::docker_container_action,
            commands::docker::docker_container_logs,
            commands::docker::docker_stream_container_logs,
            commands::docker::docker_stop_log_stream,
            commands::docker::docker_stream_stats,
            commands::docker::docker_stop_stats_stream,
            commands::docker::docker_list_images,
            commands::docker::docker_remove_image,
            commands::docker::docker_prune_images,
            commands::docker::docker_prune_build_cache,
            commands::docker::docker_inspect_image,
            commands::docker::docker_image_history,
            commands::docker::docker_create_exec_session,
            commands::docker::docker_exec_write,
            commands::docker::docker_exec_resize,
            commands::docker::docker_exec_close,
            commands::docker::docker_list_compose_projects,
            commands::docker::docker_pull_image,
            commands::docker::docker_push_image,
            commands::docker::docker_tag_image,
            commands::docker::docker_build_image,
            commands::docker::docker_compose_action,
            commands::docker::docker_list_networks,
            commands::docker::docker_create_network,
            commands::docker::docker_remove_network,
            commands::docker::docker_inspect_network,
            commands::docker::docker_connect_network,
            commands::docker::docker_disconnect_network,
            commands::docker::docker_list_volumes,
            commands::docker::docker_create_volume,
            commands::docker::docker_remove_volume,
            commands::docker::docker_inspect_volume,
            commands::docker::docker_prune_volumes,
            commands::docker::docker_list_container_dir,
            commands::docker::docker_read_container_file,
            commands::docker::docker_write_container_file,
            commands::docker::docker_probe_ssh_docker,
            commands::docker::docker_list_ssh_hosts,
            commands::docker::docker_scan_ssh_docker_hosts,
            commands::docker::docker_create_container,
            commands::docker::docker_swarm_init,
            commands::docker::docker_swarm_join,
            commands::docker::docker_swarm_leave,
            commands::docker::docker_swarm_inspect,
            commands::docker::docker_service_list,
            commands::docker::docker_service_create,
            commands::docker::docker_service_update,
            commands::docker::docker_service_remove,
            commands::docker::docker_service_logs,
            commands::docker::docker_node_list,
            commands::docker::docker_node_inspect,
            commands::docker::docker_node_update,
            commands::docker::docker_node_remove,
            commands::docker::docker_stack_deploy,
            commands::docker::docker_stack_list,
            commands::docker::docker_stack_remove,
            commands::docker::docker_stack_services,
            commands::exec::execute_action,
            // SSH
            commands::ssh::ssh_connect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_disconnect,
            commands::ssh::sftp_list,
            commands::ssh::sftp_download,
            commands::ssh::sftp_upload,
            commands::ssh::sftp_mkdir,
            commands::ssh::sftp_remove,
            commands::ssh::ssh_list_config_hosts,
            commands::ssh::ssh_sync_config_hosts,
            commands::ssh::ssh_connect_config_host,
            commands::ssh::ssh_process_list,
            commands::ssh::sftp_rename,
            commands::ssh::sftp_chmod,
            commands::ssh::ssh_create_tunnel,
            commands::ssh::ssh_close_tunnel,
            commands::ssh::ssh_list_tunnels,
            commands::ssh::ssh_list_keys,
            commands::ssh::ssh_generate_key,
            commands::ssh::ssh_import_key,
            commands::ssh::ssh_delete_key,
            commands::ssh::ssh_read_key_public,
            commands::ssh::ssh_pool_load_overview,
            commands::ssh::ssh_pool_release,
            commands::ssh::ssh_pool_fetch_stats,
            commands::ssh::ssh_pool_get_statuses,
            commands::ssh::ssh_pool_get_active_sessions,
            commands::ssh::ssh_pool_subscribe_monitoring,
            commands::ssh::ssh_pool_unsubscribe_monitoring,
            commands::ssh::ssh_pool_load_processes,
            commands::ssh::ssh_pool_process_detail,
            commands::ssh::ssh_pool_kill_process,
            // Local system monitor
            commands::system::local_fetch_stats,
            commands::system::local_list_processes,
            commands::system::local_process_detail,
            commands::system::local_kill_process,
            commands::system::list_system_fonts,
            // Updater
            commands::updater::check_update,
            commands::updater::install_update,
            // Backend logs
            commands::log::get_backend_logs,
            // 通用文件 I/O（用户通过 dialog 授权路径后写入）
            commands::fileio::write_text_file,
            commands::file_manager::file_list_connections,
            commands::file_manager::file_save_connection,
            commands::file_manager::file_test_connection,
            commands::file_manager::file_list_dir,
            commands::file_manager::file_read_file,
            commands::file_manager::file_upload_file,
            commands::file_manager::file_download_file,
            commands::file_manager::file_mkdir,
            commands::file_manager::file_rename,
            commands::file_manager::file_delete,
            commands::file_manager::file_local_quick_paths,
        commands::file_index::file_index_build,
        commands::file_index::file_index_search,
        commands::file_index::file_index_status,
        commands::file_index::file_index_clear,
        commands::file_index::file_index_cancel,
        commands::file_index::file_index_storage_info,
        commands::file_index::set_file_index_storage_dir,
            commands::log::clear_backend_logs,
            // Knowledge（知识库）
            commands::knowledge::knowledge_list,
            commands::knowledge::knowledge_get,
            commands::knowledge::knowledge_save,
            commands::knowledge::knowledge_delete,
            commands::knowledge::knowledge_search,
            commands::knowledge::knowledge_tags,
            commands::knowledge::knowledge_increment_usage,
            commands::knowledge::knowledge_todo_list,
            commands::knowledge::knowledge_todo_save,
            commands::knowledge::knowledge_todo_delete,
        commands::knowledge::knowledge_import_pdf,
            commands::knowledge_vector::knowledge_vectorize,
            commands::knowledge_vector::knowledge_vector_status,
            // Workflow（工作流）
            commands::workflow::workflow_list,
            commands::workflow::workflow_get,
            commands::workflow::workflow_save,
            commands::workflow::workflow_delete,
            commands::workflow::workflow_executions,
            commands::workflow::workflow_run,
            commands::workflow::workflow_stop,
            commands::workflow::workflow_get_execution,
            // Task（任务）
            commands::task::task_list,
            commands::task::task_get,
            commands::task::task_save,
            commands::task::task_update_status,
            commands::task::task_delete,
            commands::task::task_run,
            commands::task::task_stop,
            commands::task::task_get_output,
            // Protocol Lab — gRPC
            commands::grpc::grpc_connect,
            commands::grpc::grpc_call,
            commands::grpc::grpc_list_connections,
            commands::grpc::grpc_close,
            // Proxy
            commands::proxy::set_proxy_config,
            commands::proxy::get_proxy_config,
            // Debug（排查打包问题）
            commands::debug::debug_open_devtools,
            // AI 模型持久化
            commands::ai_models::ai_models_load,
            commands::ai_models::ai_models_save,
            commands::db_sql_files::db_sql_files_load,
            commands::db_sql_files::db_sql_files_save,
            // MCP 服务管理
            commands::mcp::mcp_list_services,
            commands::mcp::mcp_upsert_service,
            commands::mcp::mcp_delete_service,
            commands::mcp::mcp_set_service_enabled,
            commands::mcp::mcp_set_service_running,
            commands::mcp::mcp_list_service_tools,
        commands::mcp::mcp_call_tool,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
