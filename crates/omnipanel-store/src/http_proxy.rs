//! HTTP 代理配置持久化（与前端 `ProxyConfig` 字段对齐）。

use std::fs;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::paths::http_proxy_config_path;
use crate::ssh_vault::http_proxy_password_ref;
use crate::vault::Vault;

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
    /// 明文仅提交时存在；持久化后为空。
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub has_password: bool,
}

fn default_protocol() -> String {
    "http".to_string()
}

pub fn load_http_proxy_config() -> OmniResult<HttpProxyConfig> {
    let path = http_proxy_config_path()?;
    if !path.exists() {
        return Ok(HttpProxyConfig::default());
    }
    let raw =
        fs::read_to_string(&path).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    let mut cfg: HttpProxyConfig = serde_json::from_str(&raw)
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, e.to_string()))?;
    if !cfg.password.trim().is_empty() {
        let _ = Vault::store(http_proxy_password_ref(), cfg.password.trim());
        cfg.password.clear();
        cfg.has_password = true;
        let _ = save_http_proxy_config(&cfg);
    } else {
        cfg.has_password = Vault::get(http_proxy_password_ref())
            .ok()
            .is_some_and(|p| !p.is_empty());
    }
    cfg.password.clear();
    Ok(cfg)
}

/// 加载并注入 Vault 密码（供 HTTP 客户端建连）。
pub fn load_http_proxy_config_with_secret() -> OmniResult<HttpProxyConfig> {
    let mut cfg = load_http_proxy_config()?;
    if let Ok(pw) = Vault::get(http_proxy_password_ref()) {
        cfg.password = pw;
        cfg.has_password = !cfg.password.is_empty();
    }
    Ok(cfg)
}

pub fn save_http_proxy_config(config: &HttpProxyConfig) -> OmniResult<()> {
    let path = http_proxy_config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| OmniError::new(ErrorCode::Io, e.to_string()))?;
    }
    let mut to_save = config.clone();
    if !config.password.trim().is_empty() {
        Vault::store(http_proxy_password_ref(), config.password.trim())?;
        to_save.has_password = true;
    } else {
        to_save.has_password = Vault::get(http_proxy_password_ref())
            .ok()
            .is_some_and(|p| !p.is_empty())
            || config.has_password;
    }
    to_save.password.clear();
    let raw = serde_json::to_string_pretty(&to_save)
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
            has_password: false,
        };
        let raw = serde_json::to_string(&cfg).unwrap();
        fs::write(&file, raw).unwrap();
        let loaded: HttpProxyConfig =
            serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert!(loaded.enabled);
        assert_eq!(loaded.port, 7890);
        let _ = fs::remove_dir_all(dir);
    }
}
