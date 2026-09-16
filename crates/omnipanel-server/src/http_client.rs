//! 代理感知的 HTTP 客户端（Web 端；实现下沉到 `omnipanel_protocol::proxy`）。

use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::Client;

pub use omnipanel_protocol::proxy::{
    ProxyConfig, build_http_client_for_url as build_http_client_for_url_omni,
    build_http_client_no_redirect as build_http_client_no_redirect_omni, is_loopback_http_url,
};

static PROXY_CONFIG: LazyLock<Mutex<ProxyConfig>> =
    LazyLock::new(|| Mutex::new(ProxyConfig::default()));

pub fn proxy_config() -> ProxyConfig {
    PROXY_CONFIG.lock().map(|g| g.clone()).unwrap_or_default()
}

pub fn set_proxy_config_value(config: serde_json::Value) -> Result<(), String> {
    let cfg: ProxyConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let mut guard = PROXY_CONFIG
        .lock()
        .map_err(|_| "proxy lock poisoned".to_string())?;
    *guard = cfg;
    Ok(())
}

pub fn build_http_client_for_url(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> Result<Client, String> {
    build_http_client_for_url_omni(url, proxy_config, timeout).map_err(|e| e.to_string())
}

pub fn build_http_client_no_redirect(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> Result<Client, String> {
    build_http_client_no_redirect_omni(url, proxy_config, timeout).map_err(|e| e.to_string())
}
