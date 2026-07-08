use omnipanel_error::OmniError;
use omnipanel_mcp::web::{
    fetch::test_fetch,
    search::{search_auto_for_test, test_provider},
    BackendError,
};
use omnipanel_store::{
    delete_exa_api_key, delete_jina_api_key, delete_zhihu_secret, exa_api_key_configured,
    jina_api_key_configured, load_web_search_config, save_exa_api_key, save_jina_api_key,
    save_web_search_config, save_zhihu_secret, zhihu_secret_configured, FetchConfig, JinaOpts,
    SearchConfig, WebSearchBackend, WebSearchConfig,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::state::{AppState, ProxyConfig};

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfigDto {
    pub backend: String,
    pub auto_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct JinaOptsDto {
    pub domain: String,
    pub no_cache: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FetchConfigDto {
    pub backend: String,
    pub jina: JinaOptsDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfigDto {
    pub version: u32,
    pub enabled: bool,
    pub search: SearchConfigDto,
    pub fetch: FetchConfigDto,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchTestResultDto {
    pub backend: String,
    pub ok: bool,
    pub error_kind: Option<String>,
    pub message: String,
    pub sample_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WebFetchTestResultDto {
    pub backend: String,
    pub ok: bool,
    pub error_kind: Option<String>,
    pub message: String,
    pub length: u32,
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

fn config_to_dto(cfg: &WebSearchConfig) -> WebSearchConfigDto {
    WebSearchConfigDto {
        version: cfg.version,
        enabled: cfg.enabled,
        search: SearchConfigDto {
            backend: cfg.search.backend.clone(),
            auto_order: cfg.search.auto_order.clone(),
        },
        fetch: FetchConfigDto {
            backend: cfg.fetch.backend.clone(),
            jina: JinaOptsDto {
                domain: cfg.fetch.jina.domain.clone(),
                no_cache: cfg.fetch.jina.no_cache,
            },
        },
    }
}

fn dto_to_config(dto: &WebSearchConfigDto) -> WebSearchConfig {
    WebSearchConfig {
        version: dto.version,
        enabled: dto.enabled,
        search: SearchConfig {
            backend: dto.search.backend.clone(),
            auto_order: dto.search.auto_order.clone(),
        },
        fetch: FetchConfig {
            backend: dto.fetch.backend.clone(),
            jina: JinaOpts {
                domain: dto.fetch.jina.domain.clone(),
                no_cache: dto.fetch.jina.no_cache,
            },
        },
    }
}

fn backend_error_to_dto(backend: &str, err: BackendError) -> WebSearchTestResultDto {
    WebSearchTestResultDto {
        backend: backend.into(),
        ok: false,
        error_kind: Some(err.kind_label().into()),
        message: err.to_string(),
        sample_count: 0,
    }
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_get_config() -> Result<WebSearchConfigDto, OmniError> {
    let cfg = load_web_search_config()?;
    Ok(config_to_dto(&cfg))
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_set_config(config: WebSearchConfigDto) -> Result<(), OmniError> {
    save_web_search_config(&dto_to_config(&config))
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
pub async fn web_search_set_zhihu_secret(secret: String) -> Result<(), OmniError> {
    let value = secret.trim();
    if value.is_empty() {
        delete_zhihu_secret()?;
    } else {
        save_zhihu_secret(value)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_zhihu_secret_configured() -> Result<bool, OmniError> {
    Ok(zhihu_secret_configured())
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_set_jina_key(api_key: String) -> Result<(), OmniError> {
    let key = api_key.trim();
    if key.is_empty() {
        delete_jina_api_key()?;
    } else {
        save_jina_api_key(key)?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_jina_key_configured() -> Result<bool, OmniError> {
    Ok(jina_api_key_configured())
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
        WebSearchBackend::Auto => match search_auto_for_test(query, 3, &proxy).await {
            Ok(hits) => WebSearchTestResultDto {
                backend: "auto".into(),
                ok: !hits.is_empty(),
                error_kind: None,
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
                error_kind: Some("aggregate".into()),
                message: e,
                sample_count: 0,
            },
        },
        other => {
            let id = other.as_str();
            match test_provider(id, query, 3, &proxy).await {
                Ok(hits) => WebSearchTestResultDto {
                    backend: id.into(),
                    ok: !hits.is_empty(),
                    error_kind: None,
                    message: format!("成功，返回 {} 条", hits.len()),
                    sample_count: hits.len() as u32,
                },
                Err(err) => backend_error_to_dto(id, err),
            }
        }
    };

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub async fn web_search_test_fetch(
    state: State<'_, AppState>,
    url: String,
) -> Result<WebFetchTestResultDto, OmniError> {
    let proxy = proxy_from_state(&*state.proxy_config.lock().await);
    let target = url.trim();
    if target.is_empty() {
        return Ok(WebFetchTestResultDto {
            backend: "jina".into(),
            ok: false,
            error_kind: Some("config".into()),
            message: "URL 不能为空".into(),
            length: 0,
        });
    }

    match test_fetch(target, &proxy).await {
        Ok(result) => Ok(WebFetchTestResultDto {
            backend: result.backend,
            ok: !result.content.is_empty(),
            error_kind: None,
            message: if result.content.is_empty() {
                "抓取成功但内容为空".into()
            } else {
                format!("成功，返回 {} 字符", result.content.len())
            },
            length: result.content.len() as u32,
        }),
        Err(err) => Ok(WebFetchTestResultDto {
            backend: "jina".into(),
            ok: false,
            error_kind: Some(err.kind_label().into()),
            message: err.to_string(),
            length: 0,
        }),
    }
}
