//! HTTP 代理配置持久化（与前端 `ProxyConfig` 字段对齐）。

use std::fs;

use serde::{Deserialize, Serialize};

use crate::paths::http_proxy_config_path;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};

#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpProxyConfig {
    pub enabled: bool,
    #[serde(default = "default_protocol")]
    pub protocol: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
}

fn default_protocol() -> String {
    "http".to_string()
}

pub fn load_http_proxy_config() -> OmniResult<HttpProxyConfig> {
    let path = http_proxy_config_path()?;
    if !path.exists() {
        return Ok(HttpProxyConfig::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| OmniError::new(ErrorCode::InvalidInput, e.to_string()))
}

pub fn save_http_proxy_config(config: &HttpProxyConfig) -> OmniResult<()> {
    let path = http_proxy_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    }
    let raw = serde_json::to_string_pretty(config)
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, e.to_string()))?;
    fs::write(&path, raw).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    #[test]
    fn roundtrip_proxy_config_json() {
        let dir = env::temp_dir().join(format!("omnipanel-proxy-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("proxy.json");
        let cfg = HttpProxyConfig {
            enabled: true,
            protocol: "http".into(),
            host: "127.0.0.1".into(),
            port: 7890,
            username: String::new(),
            password: String::new(),
        };
        let raw = serde_json::to_string(&cfg).unwrap();
        fs::write(&file, raw).unwrap();
        let loaded: HttpProxyConfig = serde_json::from_str(
            &fs::read_to_string(&file).unwrap(),
        )
        .unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.port, 7890);
        let _ = fs::remove_dir_all(dir);
    }
}
