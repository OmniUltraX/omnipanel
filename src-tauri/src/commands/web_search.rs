use omnipanel_error::OmniError;
use omnipanel_mcp::web_tools::{build_http_client, search_auto};
use omnipanel_store::{
    delete_exa_api_key, exa_api_key_configured, load_exa_api_key, load_web_search_config,
    save_exa_api_key, save_web_search_config, WebSearchBackend, WebSearchConfig,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::time::Duration;
use tauri::State;

use crate::state::{AppState, ProxyConfig};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfigDto {
    pub enabled: bool,
    pub backend: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchTestResultDto {
    pub backend: String,
    pub ok: bool,
    pub message: String,
    pub sample_count: u32,
}

fn proxy_from_state(config: &ProxyConfig) -> omnipanel_store::HttpProxyConfig {
    omnipanel_store::HttpProxyConfig {
        enabled: config.enabled,
        protocol: config.protocol.clone(),
        host: config.host.clone(),
        port: config.port,
        username: config.username.clone(),
        password: config.password.clone(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_get_config() -> Result<WebSearchConfigDto, OmniError> {
    let cfg = load_web_search_config()?;
    Ok(WebSearchConfigDto {
        enabled: cfg.enabled,
        backend: cfg.backend,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_set_config(config: WebSearchConfigDto) -> Result<(), OmniError> {
    save_web_search_config(&WebSearchConfig {
        enabled: config.enabled,
        backend: config.backend,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_set_exa_key(api_key: String) -> Result<(), OmniError> {
    let key = api_key.trim();
    if key.is_empty() {
        delete_exa_api_key()?;
    } else {
        save_exa_api_key(key)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_exa_key_configured() -> Result<bool, OmniError> {
    Ok(exa_api_key_configured())
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_test_backend(
    state: State<'_, AppState>,
    backend: String,
) -> Result<WebSearchTestResultDto, OmniError> {
    let proxy = proxy_from_state(&*state.proxy_config.lock().await);
    let chosen = WebSearchBackend::parse(&backend);
    let query = "Rust programming language";

    let result = match chosen {
        WebSearchBackend::Exa => {
            let key = load_exa_api_key()?.unwrap_or_default();
            if key.trim().is_empty() {
                WebSearchTestResultDto {
                    backend: "exa".into(),
                    ok: false,
                    message: "未配置 Exa API Key".into(),
                    sample_count: 0,
                }
            } else {
                test_exa(query, &proxy).await
            }
        }
        WebSearchBackend::Ddg => test_ddg(query, &proxy).await,
        WebSearchBackend::Jina => test_jina(query, &proxy).await,
        WebSearchBackend::Auto => match search_auto(query, 3, &proxy).await {
            Ok(hits) => WebSearchTestResultDto {
                backend: "auto".into(),
                ok: !hits.is_empty(),
                message: if hits.is_empty() {
                    "未返回结果".into()
                } else {
                    format!("成功，返回 {} 条", hits.len())
                },
                sample_count: hits.len() as u32,
            },
            Err(e) => WebSearchTestResultDto {
                backend: "auto".into(),
                ok: false,
                message: e,
                sample_count: 0,
            },
        },
    };

    Ok(result)
}

async fn test_exa(query: &str, proxy: &omnipanel_store::HttpProxyConfig) -> WebSearchTestResultDto {
    use omnipanel_mcp::web_tools;
    match web_tools::search_exa(query, 3, proxy).await {
        Ok(hits) => WebSearchTestResultDto {
            backend: "exa".into(),
            ok: !hits.is_empty(),
            message: format!("成功，返回 {} 条", hits.len()),
            sample_count: hits.len() as u32,
        },
        Err(e) => WebSearchTestResultDto {
            backend: "exa".into(),
            ok: false,
            message: e,
            sample_count: 0,
        },
    }
}

async fn test_ddg(query: &str, proxy: &omnipanel_store::HttpProxyConfig) -> WebSearchTestResultDto {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
    );
    match build_http_client(&url, proxy, Duration::from_secs(20)) {
        Ok(client) => match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => WebSearchTestResultDto {
                backend: "ddg".into(),
                ok: true,
                message: "DuckDuckGo 可访问".into(),
                sample_count: 0,
            },
            Ok(resp) => WebSearchTestResultDto {
                backend: "ddg".into(),
                ok: false,
                message: format!("HTTP {}", resp.status()),
                sample_count: 0,
            },
            Err(e) => WebSearchTestResultDto {
                backend: "ddg".into(),
                ok: false,
                message: e.to_string(),
                sample_count: 0,
            },
        },
        Err(e) => WebSearchTestResultDto {
            backend: "ddg".into(),
            ok: false,
            message: e,
            sample_count: 0,
        },
    }
}

async fn test_jina(query: &str, proxy: &omnipanel_store::HttpProxyConfig) -> WebSearchTestResultDto {
    let url = format!(
        "https://s.jina.ai/{}",
        url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
    );
    match build_http_client(&url, proxy, Duration::from_secs(20)) {
        Ok(client) => match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => WebSearchTestResultDto {
                backend: "jina".into(),
                ok: true,
                message: "Jina Search 可访问".into(),
                sample_count: 0,
            },
            Ok(resp) => WebSearchTestResultDto {
                backend: "jina".into(),
                ok: false,
                message: format!("HTTP {}", resp.status()),
                sample_count: 0,
            },
            Err(e) => WebSearchTestResultDto {
                backend: "jina".into(),
                ok: false,
                message: e.to_string(),
                sample_count: 0,
            },
        },
        Err(e) => WebSearchTestResultDto {
            backend: "jina".into(),
            ok: false,
            message: e,
            sample_count: 0,
        },
    }
}
