//! 代理感知的 HTTP 客户端（Web 端等价于桌面 `commands/proxy`）。

use std::net::IpAddr;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,[::1],::1";

static PROXY_CONFIG: LazyLock<Mutex<ProxyConfig>> =
    LazyLock::new(|| Mutex::new(ProxyConfig::default()));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            protocol: "http".into(),
            host: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
        }
    }
}

pub fn proxy_config() -> ProxyConfig {
    PROXY_CONFIG
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

pub fn set_proxy_config_value(config: serde_json::Value) -> Result<(), String> {
    let cfg: ProxyConfig = serde_json::from_value(config).map_err(|e| e.to_string())?;
    let mut guard = PROXY_CONFIG.lock().map_err(|_| "proxy lock poisoned".to_string())?;
    *guard = cfg;
    Ok(())
}

fn loopback_no_proxy() -> Option<reqwest::NoProxy> {
    reqwest::NoProxy::from_string(LOOPBACK_NO_PROXY)
}

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

pub fn build_http_client_for_url(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10));

    if is_loopback_http_url(url) || !proxy_config.enabled || proxy_config.host.is_empty() {
        builder = builder.no_proxy();
    } else {
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

pub fn build_http_client_no_redirect(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none());

    if is_loopback_http_url(url) || !proxy_config.enabled || proxy_config.host.is_empty() {
        builder = builder.no_proxy();
    } else {
        let proxy_url = format!(
            "{}://{}:{}",
            proxy_config.protocol, proxy_config.host, proxy_config.port
        );
        let mut proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| format!("Invalid proxy configuration: {e}"))?;
        if !proxy_config.username.is_empty() {
            proxy = proxy.basic_auth(&proxy_config.username, &proxy_config.password);
        }
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))
}
