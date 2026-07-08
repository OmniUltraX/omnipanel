use std::net::IpAddr;
use std::time::Duration;

use reqwest::Client;
use tauri::State;

use crate::state::{AppState, ProxyConfig};

/// 走全局/系统代理时仍应直连的主机（loopback）。
const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,[::1],::1";

fn loopback_no_proxy() -> Option<reqwest::NoProxy> {
    reqwest::NoProxy::from_string(LOOPBACK_NO_PROXY)
}

/// 判断 HTTP(S) URL 是否指向本机 loopback。
pub fn is_loopback_http_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(is_loopback_http_host))
        .unwrap_or(false)
}

fn is_loopback_http_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// 将 `localhost` 规范为 `127.0.0.1`，避免部分环境下 localhost 解析/代理异常。
pub fn normalize_localhost_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(mut parsed) => {
            if parsed
                .host_str()
                .is_some_and(|h| h.eq_ignore_ascii_case("localhost"))
            {
                let _ = parsed.set_host(Some("127.0.0.1"));
            }
            parsed.to_string()
        }
        Err(_) => url.to_string(),
    }
}

/// 按目标 URL 构建 HTTP 客户端：loopback 强制不走代理；其余按应用代理配置。
pub fn build_http_client_for_url(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10));

    if is_loopback_http_url(url) {
        builder = builder.no_proxy();
    } else if proxy_config.enabled && !proxy_config.host.is_empty() {
        let proxy_url = format!(
            "{}://{}:{}",
            proxy_config.protocol, proxy_config.host, proxy_config.port
        );
        let mut proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("Invalid proxy configuration: {e}"))?;
        if !proxy_config.username.is_empty() {
            proxy = proxy.basic_auth(&proxy_config.username, &proxy_config.password);
        }
        proxy = proxy.no_proxy(loopback_no_proxy());
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
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

/// Build a reqwest `Client` configured with the given proxy settings.
pub fn build_proxy_client(config: &ProxyConfig) -> Client {
    if !config.enabled || config.host.is_empty() {
        return Client::new();
    }

    let proxy_url = format!("{}://{}:{}", config.protocol, config.host, config.port);
    let proxy = match reqwest::Proxy::all(&proxy_url) {
        Ok(p) => p,
        Err(_) => return Client::new(),
    };

    let mut proxy = if !config.username.is_empty() {
        proxy.basic_auth(&config.username, &config.password)
    } else {
        proxy
    };
    proxy = proxy.no_proxy(loopback_no_proxy());

    Client::builder()
        .proxy(proxy)
        .build()
        .unwrap_or_else(|_| Client::new())
}
