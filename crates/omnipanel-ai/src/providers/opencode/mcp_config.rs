//! 把 OmniPanel OmniMCP 写入 OpenCode 全局配置 `~/.config/opencode/opencode.json`。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

const MCP_SERVER_KEY: &str = "omnipanel";
const X_OMNI_MODULE: &str = "X-Omni-Module";

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

/// OpenCode 全局配置目录：`~/.config/opencode`（Windows 同为 `%USERPROFILE%\.config\opencode`）。
pub fn opencode_config_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(home.join(".config").join("opencode"))
}

pub fn opencode_config_json_path() -> Result<PathBuf, String> {
    Ok(opencode_config_dir()?.join("opencode.json"))
}

fn omnipanel_mcp_entry(mcp_url: &str, enabled: bool) -> Value {
    json!({
        "type": "remote",
        "url": mcp_url,
        "enabled": enabled,
        "headers": {
            X_OMNI_MODULE: "master"
        }
    })
}

/// 将 `omnipanel` MCP 条目合并进根 JSON（就地修改）。
///
/// - 若存在 `mcp.servers`（OpenCode V2），写入 `mcp.servers.omnipanel`
/// - 否则写入 `mcp.omnipanel`（当前文档的 flat 格式）
/// - 若两者皆在，两边同步，避免格式分叉
pub fn merge_omnimcp_into_root(root: &mut Value, mcp_url: &str, enabled: bool) {
    let entry = omnipanel_mcp_entry(mcp_url, enabled);
    if !root.is_object() {
        *root = json!({});
    }
    let obj = root.as_object_mut().expect("root object");
    if !obj.contains_key("$schema") {
        obj.insert(
            "$schema".into(),
            Value::String("https://opencode.ai/config.json".into()),
        );
    }

    let mcp = obj.entry("mcp").or_insert_with(|| json!({}));
    if !mcp.is_object() {
        *mcp = json!({});
    }
    let mcp_obj = mcp.as_object_mut().expect("mcp object");

    let has_servers = mcp_obj
        .get("servers")
        .map(|v| v.is_object())
        .unwrap_or(false);

    if has_servers {
        let servers = mcp_obj.entry("servers").or_insert_with(|| json!({}));
        if let Some(map) = servers.as_object_mut() {
            map.insert(MCP_SERVER_KEY.into(), entry.clone());
        }
        // 若用户曾用 V1 flat 键，一并更新，避免旧条目残留
        if mcp_obj.contains_key(MCP_SERVER_KEY) {
            mcp_obj.insert(MCP_SERVER_KEY.into(), entry);
        }
    } else {
        mcp_obj.insert(MCP_SERVER_KEY.into(), entry);
    }
}

/// 读取已有 `opencode.json`（不存在则空对象）；合并 OmniMCP 后写回。
///
/// 返回写入路径。失败不抛 panic；调用方决定是否忽略。
pub fn sync_omnimcp_into_opencode_config(mcp_url: &str, enabled: bool) -> Result<PathBuf, String> {
    let dir = opencode_config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 OpenCode 配置目录失败: {e}"))?;
    let path = dir.join("opencode.json");

    let mut root = read_json_object(&path)?;
    merge_omnimcp_into_root(&mut root, mcp_url, enabled);

    let pretty = serde_json::to_string_pretty(&root)
        .map_err(|e| format!("序列化 opencode.json 失败: {e}"))?;
    fs::write(&path, format!("{pretty}\n"))
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    Ok(path)
}

fn read_json_object(path: &Path) -> Result<Value, String> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("读取 {} 失败: {e}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_str(trimmed)
        .map_err(|e| format!("解析 {} 失败: {e}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} 根节点不是 JSON 对象", path.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_creates_flat_mcp_when_empty() {
        let mut root = json!({});
        merge_omnimcp_into_root(&mut root, "http://127.0.0.1:12756/mcp", true);
        let entry = &root["mcp"]["omnipanel"];
        assert_eq!(entry["type"], "remote");
        assert_eq!(entry["url"], "http://127.0.0.1:12756/mcp");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["headers"]["X-Omni-Module"], "master");
        assert!(root["mcp"].get("servers").is_none());
    }

    #[test]
    fn merge_preserves_other_mcp_servers() {
        let mut root = json!({
            "mcp": {
                "context7": { "type": "remote", "url": "https://mcp.context7.com/mcp" }
            }
        });
        merge_omnimcp_into_root(&mut root, "http://127.0.0.1:12757/mcp", true);
        assert!(root["mcp"]["context7"].is_object());
        assert_eq!(root["mcp"]["omnipanel"]["url"], "http://127.0.0.1:12757/mcp");
    }

    #[test]
    fn merge_v2_servers_only() {
        let mut root = json!({
            "mcp": {
                "servers": {
                    "playwright": { "type": "local", "command": ["npx", "@playwright/mcp"] }
                }
            }
        });
        merge_omnimcp_into_root(&mut root, "http://127.0.0.1:12756/mcp", false);
        assert_eq!(root["mcp"]["servers"]["omnipanel"]["enabled"], false);
        assert_eq!(
            root["mcp"]["servers"]["omnipanel"]["url"],
            "http://127.0.0.1:12756/mcp"
        );
        // 纯 V2：不额外写 flat 键，避免双注册
        assert!(root["mcp"].get("omnipanel").is_none());
        assert!(root["mcp"]["servers"]["playwright"].is_object());
    }

    #[test]
    fn merge_updates_both_when_flat_and_servers_exist() {
        let mut root = json!({
            "mcp": {
                "omnipanel": { "type": "remote", "url": "http://old/mcp", "enabled": false },
                "servers": {
                    "omnipanel": { "type": "remote", "url": "http://old/mcp", "enabled": false }
                }
            }
        });
        merge_omnimcp_into_root(&mut root, "http://127.0.0.1:12756/mcp", true);
        assert_eq!(root["mcp"]["omnipanel"]["url"], "http://127.0.0.1:12756/mcp");
        assert_eq!(root["mcp"]["omnipanel"]["enabled"], true);
        assert_eq!(
            root["mcp"]["servers"]["omnipanel"]["url"],
            "http://127.0.0.1:12756/mcp"
        );
        assert_eq!(root["mcp"]["servers"]["omnipanel"]["enabled"], true);
    }
}
