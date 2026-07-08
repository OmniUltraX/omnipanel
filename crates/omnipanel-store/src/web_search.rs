//! Web 搜索工具配置与 Exa API Key（Vault）。

use std::fs;

use serde::{Deserialize, Serialize};

use crate::paths::web_search_config_path;
use crate::vault::Vault;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};

pub const WEB_SEARCH_EXA_KEY_REF: &str = "web-search-exa-key";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum WebSearchBackend {
    Auto,
    Exa,
    Ddg,
    Jina,
}

impl WebSearchBackend {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Exa => "exa",
            Self::Ddg => "ddg",
            Self::Jina => "jina",
        }
    }

    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "exa" => Self::Exa,
            "ddg" | "duckduckgo" => Self::Ddg,
            "jina" => Self::Jina,
            _ => Self::Auto,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WebSearchConfig {
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub backend: String,
}

fn default_enabled() -> bool {
    true
}

impl Default for WebSearchConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            backend: WebSearchBackend::Auto.as_str().to_string(),
        }
    }
}

pub fn load_web_search_config() -> OmniResult<WebSearchConfig> {
    let path = web_search_config_path()?;
    if !path.exists() {
        return Ok(WebSearchConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| OmniError::new(ErrorCode::InvalidInput, e.to_string()))
}

pub fn save_web_search_config(config: &WebSearchConfig) -> OmniResult<()> {
    let path = web_search_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, e.to_string()))?;
    fs::write(&path, raw).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))
}

pub fn load_exa_api_key() -> OmniResult<Option<String>> {
    match Vault::get(WEB_SEARCH_EXA_KEY_REF) {
        Ok(key) => Ok(Some(key)),
        Err(OmniError { code: ErrorCode::NotFound, .. }) => Ok(None),
        Err(err) => Err(err),
    }
}

pub fn save_exa_api_key(key: &str) -> OmniResult<()> {
    Vault::store(WEB_SEARCH_EXA_KEY_REF, key.trim())
}

pub fn delete_exa_api_key() -> OmniResult<()> {
    Vault::delete(WEB_SEARCH_EXA_KEY_REF)
}

pub fn exa_api_key_configured() -> bool {
    load_exa_api_key()
        .ok()
        .flatten()
        .is_some_and(|k| !k.trim().is_empty())
}
