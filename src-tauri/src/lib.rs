mod commands;
mod output_buffer;
mod protocol;
mod state;

use state::AppState;
use tauri::Manager;

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
        commands::database::db_test_connection,
        commands::database::db_list_tables,
        commands::connection::conn_list,
        commands::connection::conn_save,
        commands::connection::conn_delete,
        commands::connection::conn_test,
        commands::exec::execute_action,
        commands::ssh::ssh_connect,
        commands::ssh::ssh_write,
        commands::ssh::ssh_resize,
        commands::ssh::ssh_disconnect,
        commands::ssh::sftp_list,
        commands::ssh::sftp_download,
        commands::ssh::sftp_upload,
        commands::updater::check_update,
        commands::updater::install_update,
    ]);

    // 用 CARGO_MANIFEST_DIR 拼绝对路径，避免 cwd 在不同入口（cargo test/run）下不一致。
    let out_path =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../frontend/src/ipc/bindings.ts");

    builder
        .export(specta_typescript::Typescript::default(), &out_path)
        .expect("failed to export typescript bindings");
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            let data_dir = app.path().app_data_dir().expect("无法获取应用数据目录");
            std::fs::create_dir_all(&data_dir).ok();
            let db_path = data_dir.join("omnipanel.db");
            let storage = omnipanel_store::Storage::open(&db_path, None).expect("打开本地存储失败");
            app.manage(AppState::new(app.handle().clone(), storage));
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
            // Protocol Lab — Serial
            commands::protocol::serial_scan_ports,
            commands::protocol::serial_open,
            commands::protocol::serial_write,
            commands::protocol::serial_close,
            commands::protocol::serial_set_dtr,
            commands::protocol::serial_set_rts,
            // Protocol Lab — HTTP
            commands::protocol::http_request,
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
            commands::database::db_test_connection,
            commands::database::db_list_tables,
            commands::database::db_preview_table,
            commands::database::db_execute_query,
            // Connections（统一连接模型）
            commands::connection::conn_list,
            commands::connection::conn_save,
            commands::connection::conn_delete,
            commands::connection::conn_test,
            // Execution engine（动作执行引擎）
            commands::exec::execute_action,
            // SSH
            commands::ssh::ssh_connect,
            commands::ssh::ssh_write,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_disconnect,
            commands::ssh::sftp_list,
            commands::ssh::sftp_download,
            commands::ssh::sftp_upload,
            // Updater
            commands::updater::check_update,
            commands::updater::install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
