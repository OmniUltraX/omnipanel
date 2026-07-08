//! Web 搜索 / 抓取工具配置与 API Key（Vault）。

use std::fs;

use serde::{Deserialize, Serialize};

use crate::paths::web_search_config_path;
use crate::vault::Vault;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};

pub const WEB_SEARCH_EXA_KEY_REF: &str = "web-search-exa-key";
pub const WEB_SEARCH_ZHIHU_SECRET_REF: &str = "web-search-zhihu-secret";
pub const WEB_SEARCH_JINA_KEY_REF: &str = "web-search-jina-key";
pub const WEB_SEARCH_CONFIG_VERSION: u32 = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchBackend {
    Auto,
    Zhihu,
    Exa,
    Ddg,
    Jina,
}

impl WebSearchBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Zhihu => "zhihu",
            Self::Exa => "exa",
            Self::Ddg => "ddg",
            Self::Jina => "jina",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "zhihu" => Self::Zhihu,
            "exa" => Self::Exa,
            "ddg" | "duckduckgo" => Self::Ddg,
            "jina" => Self::Jina,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum WebFetchBackend {
    Auto,
    Local,
    Jina,
}

impl WebFetchBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Local => "local",
            Self::Jina => "jina",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "local" | "direct" => Self::Local,
            "jina" => Self::Jina,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum JinaDomainMode {
    Auto,
    Cn,
    Ai,
}

impl JinaDomainMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cn => "cn",
            Self::Ai => "ai",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "cn" | "jinaai.cn" => Self::Cn,
            "ai" | "jina.ai" => Self::Ai,
            _ => Self::Auto,
        }
    }
}

pub fn default_auto_order() -> Vec<String> {
    vec![
        "zhihu".into(),
        "exa".into(),
        "ddg".into(),
        "jina".into(),
    ]
}

fn default_search_backend() -> String {
    WebSearchBackend::Auto.as_str().to_string()
}

fn default_fetch_backend() -> String {
    WebFetchBackend::Auto.as_str().to_string()
}

fn default_jina_domain() -> String {
    JinaDomainMode::Auto.as_str().to_string()
}

fn default_version() -> u32 {
    WEB_SEARCH_CONFIG_VERSION
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    #[serde(default = "default_search_backend")]
    pub backend: String,
    #[serde(default = "default_auto_order")]
    pub auto_order: Vec<String>,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            backend: default_search_backend(),
            auto_order: default_auto_order(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct JinaOpts {
    #[serde(default = "default_jina_domain")]
    pub domain: String,
    #[serde(default)]
    pub no_cache: bool,
}

impl Default for JinaOpts {
    fn default() -> Self {
        Self {
            domain: default_jina_domain(),
            no_cache: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FetchConfig {
    #[serde(default = "default_fetch_backend")]
    pub backend: String,
    #[serde(default)]
    pub jina: JinaOpts,
}

impl Default for FetchConfig {
    fn default() -> Self {
        Self {
            backend: default_fetch_backend(),
            jina: JinaOpts::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub search: SearchConfig,
    #[serde(default)]
    pub fetch: FetchConfig,
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            version: WEB_SEARCH_CONFIG_VERSION,
            enabled: true,
            search: SearchConfig::default(),
            fetch: FetchConfig::default(),
        }
    }
}

/// 磁盘上的原始 JSON（兼容 v1 扁平结构）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawWebSearchConfig {
    version: Option<u32>,
    enabled: Option<bool>,
    /// v1 扁平字段
    backend: Option<String>,
    search: Option<SearchConfig>,
    fetch: Option<FetchConfig>,
}

fn normalize_config(raw: RawWebSearchConfig) -> WebSearchConfig {
    if raw.search.is_some() || raw.fetch.is_some() {
        let mut cfg = WebSearchConfig {
            version: raw.version.unwrap_or(WEB_SEARCH_CONFIG_VERSION),
            enabled: raw.enabled.unwrap_or(true),
            search: raw.search.unwrap_or_default(),
            fetch: raw.fetch.unwrap_or_default(),
        };
        if cfg.version < WEB_SEARCH_CONFIG_VERSION {
            cfg.version = WEB_SEARCH_CONFIG_VERSION;
        }
        if cfg.search.auto_order.is_empty() {
            cfg.search.auto_order = default_auto_order();
        }
        return cfg;
    }

    WebSearchConfig {
        version: WEB_SEARCH_CONFIG_VERSION,
        enabled: raw.enabled.unwrap_or(true),
        search: SearchConfig {
            backend: raw
                .backend
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(default_search_backend),
            auto_order: default_auto_order(),
        },
        fetch: FetchConfig::default(),
    }
}

pub fn load_web_search_config() -> OmniResult<WebSearchConfig> {
    let path = web_search_config_path()?;
    if !path.exists() {
        return Ok(WebSearchConfig::default());
    }
    let text = fs::read_to_string(&path).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    let raw: RawWebSearchConfig = serde_json::from_str(&text)
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, e.to_string()))?;
    let cfg = normalize_config(raw);
    if cfg.version < WEB_SEARCH_CONFIG_VERSION
        || !text.contains("\"search\"")
        || !text.contains("\"fetch\"")
    {
        save_web_search_config(&cfg)?;
    }
    Ok(cfg)
}

pub fn save_web_search_config(config: &WebSearchConfig) -> OmniResult<()> {
    let path = web_search_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    }
    let mut to_save = config.clone();
    to_save.version = WEB_SEARCH_CONFIG_VERSION;
    let raw = serde_json::to_string_pretty(&to_save)
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, e.to_string()))?;
    fs::write(&path, raw).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))
}

fn vault_get_optional(ref_id: &str) -> OmniResult<Option<String>> {
    match Vault::get(ref_id) {
        Ok(key) => Ok(Some(key)),
        Err(OmniError {
            code: ErrorCode::NotFound,
            ..
        }) => Ok(None),
        Err(err) => Err(err),
    }
}

fn vault_save(ref_id: &str, value: &str) -> OmniResult<()> {
    Vault::store(ref_id, value.trim())
}

fn vault_delete(ref_id: &str) -> OmniResult<()> {
    Vault::delete(ref_id)
}

fn vault_configured(ref_id: &str) -> bool {
    vault_get_optional(ref_id)
        .ok()
        .flatten()
        .is_some_and(|k| !k.trim().is_empty())
}

pub fn load_exa_api_key() -> OmniResult<Option<String>> {
    vault_get_optional(WEB_SEARCH_EXA_KEY_REF)
}

pub fn save_exa_api_key(key: &str) -> OmniResult<()> {
    vault_save(WEB_SEARCH_EXA_KEY_REF, key)
}

pub fn delete_exa_api_key() -> OmniResult<()> {
    vault_delete(WEB_SEARCH_EXA_KEY_REF)
}

pub fn exa_api_key_configured() -> bool {
    vault_configured(WEB_SEARCH_EXA_KEY_REF)
}

pub fn load_zhihu_secret() -> OmniResult<Option<String>> {
    vault_get_optional(WEB_SEARCH_ZHIHU_SECRET_REF)
}

pub fn save_zhihu_secret(secret: &str) -> OmniResult<()> {
    vault_save(WEB_SEARCH_ZHIHU_SECRET_REF, secret)
}

pub fn delete_zhihu_secret() -> OmniResult<()> {
    vault_delete(WEB_SEARCH_ZHIHU_SECRET_REF)
}

pub fn zhihu_secret_configured() -> bool {
    vault_configured(WEB_SEARCH_ZHIHU_SECRET_REF)
}

pub fn load_jina_api_key() -> OmniResult<Option<String>> {
    vault_get_optional(WEB_SEARCH_JINA_KEY_REF)
}

pub fn save_jina_api_key(key: &str) -> OmniResult<()> {
    vault_save(WEB_SEARCH_JINA_KEY_REF, key)
}

pub fn delete_jina_api_key() -> OmniResult<()> {
    vault_delete(WEB_SEARCH_JINA_KEY_REF)
}

pub fn jina_api_key_configured() -> bool {
    vault_configured(WEB_SEARCH_JINA_KEY_REF)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_v1_flat_config() {
        let raw = RawWebSearchConfig {
            version: None,
            enabled: Some(true),
            backend: Some("exa".into()),
            search: None,
            fetch: None,
        };
        let cfg = normalize_config(raw);
        assert_eq!(cfg.version, WEB_SEARCH_CONFIG_VERSION);
        assert_eq!(cfg.search.backend, "exa");
        assert_eq!(cfg.fetch.backend, "auto");
        assert_eq!(cfg.search.auto_order.len(), 4);
    }

    #[test]
    fn normalize_v2_config() {
        let raw = RawWebSearchConfig {
            version: Some(2),
            enabled: Some(true),
            backend: None,
            search: Some(SearchConfig {
                backend: "zhihu".into(),
                auto_order: default_auto_order(),
            }),
            fetch: Some(FetchConfig::default()),
        };
        let cfg = normalize_config(raw);
        assert_eq!(cfg.search.backend, "zhihu");
    }
}
