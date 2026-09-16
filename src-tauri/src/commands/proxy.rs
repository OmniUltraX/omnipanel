use std::time::Duration;

use reqwest::Client;
use tauri::State;

use crate::state::{AppState, ProxyConfig};

pub use omnipanel_protocol::proxy::{
    build_proxy_client, is_loopback_http_url, normalize_localhost_url,
};

/// 按目标 URL 构建 HTTP 客户端（薄包装：OmniResult → String，供壳内其它命令复用）。
pub fn build_http_client_for_url(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> Result<Client, String> {
    omnipanel_protocol::proxy::build_http_client_for_url(url, proxy_config, timeout)
        .map_err(|e| e.to_string())
}

/// Set the proxy configuration from frontend settings.
#[tauri::command]
#[specta::specta]
pub async fn set_proxy_config(
    state: State<'_, AppState>,
    config: ProxyConfig,
) -> Result<(), String> {
    *state.proxy_config.lock().await = config.clone();
    let store_proxy = omnipanel_store::HttpProxyConfig {
        enabled: config.enabled,
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        username: config.username,
        has_password: !config.password.is_empty(),
        password: config.password,
    };
    omnipanel_store::save_http_proxy_config(&store_proxy).map_err(|e| e.to_string())?;
    Ok(())
}

/// Get the current proxy configuration (for backend use).
#[tauri::command]
#[specta::specta]
pub async fn get_proxy_config(state: State<'_, AppState>) -> Result<ProxyConfig, String> {
    Ok(state.proxy_config.lock().await.clone())
}
