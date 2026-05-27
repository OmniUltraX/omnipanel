mod commands;
mod protocol;
mod state;
mod terminal;

use state::AppState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            app.manage(AppState::new(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Terminal
            commands::terminal::create_terminal,
            commands::terminal::write_terminal,
            commands::terminal::resize_terminal,
            commands::terminal::close_terminal,
            commands::terminal::get_shell_type,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
