//! 按 URL / 代理配置构建 reqwest Client（桌面与 Web 共用）。
//!
//! 命令层传入本模块的 [`ProxyConfig`] DTO，或自行调用后把 Client 交给协议实现。
//! 本 crate **不**依赖 src-tauri。

use std::net::IpAddr;
use std::time::Duration;

use omnipanel_error::{OmniError, OmniResult};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use specta::Type;

/// 走全局/系统代理时仍应直连的主机（loopback）。
const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,[::1],::1";

/// HTTP 代理配置 DTO（与前端设置 / 桌面 AppState 字段对齐）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
pub struct ProxyConfig {
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

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

/// 按目标 URL 构建 HTTP 客户端：
/// - loopback / 应用代理关闭：强制 `.no_proxy()`，避免 reqwest 回退到系统或环境变量代理；
/// - 应用代理开启：使用设置中的代理，并对 loopback 主机豁免。
pub fn build_http_client_for_url(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> OmniResult<Client> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10));

    if is_loopback_http_url(url) || !proxy_config.enabled || proxy_config.host.is_empty() {
        // 关闭应用代理时必须显式 no_proxy，否则仍会读 HTTP(S)_PROXY / 系统代理。
        builder = builder.no_proxy();
    } else {
        let proxy_url = format!(
            "{}://{}:{}",
            proxy_config.protocol, proxy_config.host, proxy_config.port
        );
        let mut proxy = reqwest::Proxy::all(&proxy_url)
            .map_err(|e| OmniError::invalid_input(format!("Invalid proxy configuration: {e}")))?;
        if !proxy_config.username.is_empty() {
            proxy = proxy.basic_auth(&proxy_config.username, &proxy_config.password);
        }
        proxy = proxy.no_proxy(loopback_no_proxy());
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| OmniError::internal(format!("Failed to create HTTP client: {e}")))
}

/// 构建不跟随重定向的 HTTP 客户端（Web 端部分场景需要）。
pub fn build_http_client_no_redirect(
    url: &str,
    proxy_config: &ProxyConfig,
    timeout: Duration,
) -> OmniResult<Client> {
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
            .map_err(|e| OmniError::invalid_input(format!("Invalid proxy configuration: {e}")))?;
        if !proxy_config.username.is_empty() {
            proxy = proxy.basic_auth(&proxy_config.username, &proxy_config.password);
        }
        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| OmniError::internal(format!("Failed to create HTTP client: {e}")))
}

/// 构建直连客户端（忽略系统/环境变量代理）。
fn build_direct_client() -> Client {
    Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_else(|_| Client::new())
}

/// Build a reqwest `Client` configured with the given proxy settings.
/// 应用代理关闭时强制直连，不回退到系统代理。
pub fn build_proxy_client(config: &ProxyConfig) -> Client {
    if !config.enabled || config.host.is_empty() {
        return build_direct_client();
    }

    let proxy_url = format!("{}://{}:{}", config.protocol, config.host, config.port);
    let proxy = match reqwest::Proxy::all(&proxy_url) {
        Ok(p) => p,
        Err(_) => return build_direct_client(),
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
        .unwrap_or_else(|_| build_direct_client())
}
