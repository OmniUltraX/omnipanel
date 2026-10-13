//! 读取本机 OpenCode CLI 已保存的凭据（与 `opencode auth login` / `/connect` 同源）。
//! 优先使用插件设置；未配置时再尝试 `auth.json` 与全局 `opencode.json`。

use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;

pub const PROVIDER_ID: &str = "opencode-go";

pub struct LocalRuntimeConfig {
    pub api_key: String,
    pub base_url: Option<String>,
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var("HOME")
                .ok()
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
}

/// OpenCode 数据目录：`$XDG_DATA_HOME/opencode` 或 `~/.local/share/opencode`（Windows 上同样常见）。
pub fn opencode_data_dir() -> Option<PathBuf> {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        let dir = PathBuf::from(xdg).join("opencode");
        if dir.is_dir() {
            return Some(dir);
        }
    }
    let home = home_dir()?;
    let local_share = home.join(".local").join("share").join("opencode");
    if local_share.is_dir() {
        return Some(local_share);
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local).join("opencode");
        if dir.is_dir() {
            return Some(dir);
        }
    }
    None
}

fn opencode_config_path() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("OPENCODE_CONFIG_DIR") {
        let path = PathBuf::from(dir).join("opencode.json");
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(path) = std::env::var("OPENCODE_CONFIG") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let home = home_dir()?;
    let path = home.join(".config").join("opencode").join("opencode.json");
    if path.is_file() {
        return Some(path);
    }
    let path = home.join(".config").join("opencode").join("opencode.jsonc");
    if path.is_file() {
        return Some(path);
    }
    None
}

#[derive(Debug, Deserialize)]
struct AuthEntry {
    #[serde(default)]
    r#type: String,
    key: String,
}

fn read_auth_json_key(data_dir: &Path) -> Option<String> {
    let path = data_dir.join("auth.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let root: Value = serde_json::from_str(&raw).ok()?;
    let obj = root.as_object()?;
    for id in [PROVIDER_ID, "opencode_go", "opencodezen", "opencode-zen"] {
        if let Some(entry) = obj.get(id) {
            if let Ok(parsed) = serde_json::from_value::<AuthEntry>(entry.clone()) {
                let key = parsed.key.trim();
                if !key.is_empty() {
                    return Some(key.to_string());
                }
            }
            if let Some(key) = entry.get("key").and_then(Value::as_str) {
                let key = key.trim();
                if !key.is_empty() {
                    return Some(key.to_string());
                }
            }
        }
    }
    None
}

fn read_base_url_from_config(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    let root: Value = serde_json::from_str(&raw).ok()?;
    let provider = root.get("provider")?.as_object()?;
    for id in [PROVIDER_ID, "opencode_go"] {
        let Some(node) = provider.get(id) else {
            continue;
        };
        let url = node
            .get("options")
            .and_then(|o| o.get("baseURL"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        if url.is_some() {
            return url.map(|s| s.to_string());
        }
    }
    None
}

/// 本机是否已有 OpenCode 数据（不读取密钥内容）。
pub fn local_opencode_present() -> bool {
    opencode_data_dir().is_some() || opencode_config_path().is_some()
}

/// 从本机 OpenCode 安装读取 Go 订阅 Key（及可选 baseURL）。
pub fn load_from_local_cli() -> Option<LocalRuntimeConfig> {
    let api_key = opencode_data_dir()
        .and_then(|dir| read_auth_json_key(&dir))
        .or_else(|| {
            std::env::var("OPENCODE_GO_API_KEY")
                .ok()
                .filter(|k| !k.trim().is_empty())
        })?;
    let base_url = opencode_config_path().and_then(|p| read_base_url_from_config(&p));
    Some(LocalRuntimeConfig { api_key, base_url })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn reads_opencode_go_key_from_auth_json() {
        let dir = std::env::temp_dir().join(format!("omni-opencode-auth-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("auth.json");
        let mut file = std::fs::File::create(&path).unwrap();
        file.write_all(br#"{"opencode-go":{"type":"api","key":"sk-test-local"}}"#)
            .unwrap();
        let key = read_auth_json_key(&dir).expect("key");
        assert_eq!(key, "sk-test-local");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
