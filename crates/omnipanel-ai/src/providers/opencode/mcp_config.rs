//! OmniPanel ↔ OpenCode 配置同步。
//!
//! ## 隔离策略
//! - **全局** `~/.config/opencode/opencode.json`：剥离 `omnipanel` MCP，避免其它项目误连 OmniMCP
//! - **工作区** `~/.config/omnipanel/opencode-ops/`：写入 OmniMCP、tool_output、compaction、运维智能体
//!
//! OpenCode 会话默认 cwd 指向该工作区，因此只有 OmniPanel 拉起的会话能看到 OmniMCP。

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

const MCP_SERVER_KEY: &str = "omnipanel";
const X_OMNI_MODULE: &str = "X-Omni-Module";

/// OmniPanel 托管的运维智能体 id（文件名 / default_agent / API agentID）。
pub const OPS_AGENT_ID: &str = "omnipanel-ops";

/// OmniPanel 托管的工具输出上限（低于 OpenCode 默认 2000 / 50KB）。
const TOOL_OUTPUT_MAX_LINES: u64 = 200;
const TOOL_OUTPUT_MAX_BYTES: u64 = 8192;

/// 自动压缩：比默认更早触发（更大 buffer），保留稍少的近期原文。
const COMPACTION_KEEP_TOKENS: u64 = 12_000;
const COMPACTION_BUFFER: u64 = 25_000;

const OPS_AGENT_MARKDOWN: &str = r##"---
description: OmniPanel 运维智能体——经 OmniMCP 管理终端、SSH、数据库、Docker 与服务器
mode: primary
color: "#3b82f6"
permission:
  edit: ask
  bash: ask
  external_directory: ask
---

你是 OmniPanel 运维智能体（omnipanel-ops）。

工作原则：
- 优先使用 OmniMCP（`omnipanel`）暴露的工具完成运维：终端、SSH、数据库、Docker、服务器面板等
- 危险操作（删除、重启、生产库写入、批量变更）先说明影响，再征求确认
- 工具输出可能很长：先用精确命令（grep / tail / 限定范围），避免无谓的全量 cat / 日志倾倒
- 回答简洁、可执行；给出命令时说明预期效果与回滚思路
"##;

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

/// OpenCode 全局配置目录：`~/.config/opencode`。
pub fn opencode_config_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(home.join(".config").join("opencode"))
}

pub fn opencode_config_json_path() -> Result<PathBuf, String> {
    Ok(opencode_config_dir()?.join("opencode.json"))
}

/// OmniPanel 专用 OpenCode 工作区（会话 cwd + 项目级配置落点）。
pub fn omnipanel_opencode_ops_dir() -> Result<PathBuf, String> {
    let home = home_dir().ok_or_else(|| "无法定位用户主目录".to_string())?;
    Ok(home.join(".config").join("omnipanel").join("opencode-ops"))
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

fn ensure_root_object(root: &mut Value) -> &mut serde_json::Map<String, Value> {
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
    obj
}

/// 将 `omnipanel` MCP 条目合并进根 JSON（就地修改）。
///
/// - 若存在 `mcp.servers`（OpenCode V2），写入 `mcp.servers.omnipanel`
/// - 否则写入 `mcp.omnipanel`（当前文档的 flat 格式）
/// - 若两者皆在，两边同步，避免格式分叉
pub fn merge_omnimcp_into_root(root: &mut Value, mcp_url: &str, enabled: bool) {
    let entry = omnipanel_mcp_entry(mcp_url, enabled);
    let obj = ensure_root_object(root);

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

/// 从根 JSON 移除 `omnipanel` MCP（flat 与 `mcp.servers` 两处）。
pub fn strip_omnimcp_from_root(root: &mut Value) -> bool {
    let Some(obj) = root.as_object_mut() else {
        return false;
    };
    let Some(mcp) = obj.get_mut("mcp") else {
        return false;
    };
    let Some(mcp_obj) = mcp.as_object_mut() else {
        return false;
    };
    let mut removed = mcp_obj.remove(MCP_SERVER_KEY).is_some();
    if let Some(servers) = mcp_obj.get_mut("servers").and_then(|v| v.as_object_mut()) {
        removed |= servers.remove(MCP_SERVER_KEY).is_some();
    }
    removed
}

/// 写入工具输出上限 + 自动压缩。
pub fn merge_runtime_defaults_into_root(root: &mut Value) {
    let obj = ensure_root_object(root);
    obj.insert(
        "tool_output".into(),
        json!({
            "max_lines": TOOL_OUTPUT_MAX_LINES,
            "max_bytes": TOOL_OUTPUT_MAX_BYTES,
        }),
    );
    obj.insert(
        "compaction".into(),
        json!({
            "auto": true,
            "keep": { "tokens": COMPACTION_KEEP_TOKENS },
            "buffer": COMPACTION_BUFFER,
        }),
    );
}

/// 写入运维智能体定义，并设为 `default_agent`。
///
/// 默认关闭其它 agent 对 `omnipanel_*` 工具的访问；仅 `omnipanel-ops` 启用。
pub fn merge_ops_agent_into_root(root: &mut Value) {
    let obj = ensure_root_object(root);
    obj.insert("default_agent".into(), Value::String(OPS_AGENT_ID.into()));

    // 项目级默认：不把 OmniMCP 工具暴露给 build/plan 等；运维 agent 再打开
    let tools = obj.entry("tools").or_insert_with(|| json!({}));
    if let Some(map) = tools.as_object_mut() {
        map.insert("omnipanel_*".into(), Value::Bool(false));
    }

    let agent = obj.entry("agent").or_insert_with(|| json!({}));
    if !agent.is_object() {
        *agent = json!({});
    }
    if let Some(map) = agent.as_object_mut() {
        map.insert(
            OPS_AGENT_ID.into(),
            json!({
                "description": "OmniPanel 运维：经 OmniMCP 管理终端 / SSH / 数据库 / Docker / 服务器",
                "mode": "primary",
                "color": "#3b82f6",
                "tools": {
                    "omnipanel_*": true
                },
                "permission": {
                    "edit": "ask",
                    "bash": "ask",
                    "external_directory": "ask"
                }
            }),
        );
    }
}

/// 同步结果：主路径 + 是否有磁盘变更。
#[derive(Debug, Clone)]
pub struct OpenCodeConfigSyncOutcome {
    pub path: PathBuf,
    /// 工作区目录（会话应使用的 cwd）。
    pub workspace_dir: PathBuf,
    pub changed: bool,
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
    let value: Value =
        serde_json::from_str(trimmed).map_err(|e| format!("解析 {} 失败: {e}", path.display()))?;
    if value.is_object() {
        Ok(value)
    } else {
        Err(format!("{} 根节点不是 JSON 对象", path.display()))
    }
}

fn write_json_object(path: &Path, root: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败 {}: {e}", parent.display()))?;
    }
    let pretty = serde_json::to_string_pretty(root)
        .map_err(|e| format!("序列化 {} 失败: {e}", path.display()))?;
    fs::write(path, format!("{pretty}\n"))
        .map_err(|e| format!("写入 {} 失败: {e}", path.display()))
}

/// 从全局 opencode.json 移除 omnipanel MCP（不碰用户其它配置）。
pub fn strip_omnimcp_from_global_config() -> Result<bool, String> {
    let path = opencode_config_json_path()?;
    if !path.exists() {
        return Ok(false);
    }
    let before = read_json_object(&path)?;
    let mut root = before.clone();
    if !strip_omnimcp_from_root(&mut root) {
        return Ok(false);
    }
    if root != before {
        write_json_object(&path, &root)?;
        return Ok(true);
    }
    Ok(false)
}

fn write_ops_agent_markdown(workspace_dir: &Path) -> Result<bool, String> {
    let agents_dir = workspace_dir.join(".opencode").join("agents");
    fs::create_dir_all(&agents_dir)
        .map_err(|e| format!("创建 agents 目录失败 {}: {e}", agents_dir.display()))?;
    let path = agents_dir.join(format!("{OPS_AGENT_ID}.md"));
    let desired = format!("{OPS_AGENT_MARKDOWN}\n");
    let changed = match fs::read_to_string(&path) {
        Ok(existing) => existing != desired,
        Err(_) => true,
    };
    if changed {
        fs::write(&path, &desired).map_err(|e| format!("写入 {} 失败: {e}", path.display()))?;
    }
    Ok(changed)
}

/// 将 OmniMCP + 运行时默认 + 运维智能体写入指定工作区的 `opencode.json`。
pub fn sync_project_opencode_workspace(
    workspace_dir: &Path,
    mcp_url: &str,
    enabled: bool,
) -> Result<(PathBuf, bool), String> {
    fs::create_dir_all(workspace_dir)
        .map_err(|e| format!("创建 OpenCode 工作区失败 {}: {e}", workspace_dir.display()))?;
    let path = workspace_dir.join("opencode.json");

    let before = read_json_object(&path)?;
    let mut root = before.clone();
    merge_omnimcp_into_root(&mut root, mcp_url, enabled);
    merge_runtime_defaults_into_root(&mut root);
    merge_ops_agent_into_root(&mut root);

    let mut changed = root != before;
    if changed {
        write_json_object(&path, &root)?;
    }
    changed |= write_ops_agent_markdown(workspace_dir)?;
    Ok((path, changed))
}

/// 初始化连接时的完整同步：
/// 1. 从**全局**配置剥离 omnipanel MCP（避免其它项目调用）
/// 2. 写入 OmniPanel ops 工作区（MCP + 截断 + compaction + 运维智能体）
pub fn sync_omnimcp_into_opencode_config(
    mcp_url: &str,
    enabled: bool,
) -> Result<OpenCodeConfigSyncOutcome, String> {
    let mut changed = strip_omnimcp_from_global_config()?;
    let workspace_dir = omnipanel_opencode_ops_dir()?;
    let (path, project_changed) =
        sync_project_opencode_workspace(&workspace_dir, mcp_url, enabled)?;
    changed |= project_changed;
    Ok(OpenCodeConfigSyncOutcome {
        path,
        workspace_dir,
        changed,
    })
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
        assert_eq!(
            root["mcp"]["omnipanel"]["url"],
            "http://127.0.0.1:12757/mcp"
        );
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
        assert_eq!(
            root["mcp"]["omnipanel"]["url"],
            "http://127.0.0.1:12756/mcp"
        );
        assert_eq!(root["mcp"]["omnipanel"]["enabled"], true);
        assert_eq!(
            root["mcp"]["servers"]["omnipanel"]["url"],
            "http://127.0.0.1:12756/mcp"
        );
        assert_eq!(root["mcp"]["servers"]["omnipanel"]["enabled"], true);
    }

    #[test]
    fn strip_removes_flat_and_servers_entries() {
        let mut root = json!({
            "mcp": {
                "omnipanel": { "type": "remote", "url": "http://x/mcp" },
                "context7": { "type": "remote", "url": "https://c" },
                "servers": {
                    "omnipanel": { "type": "remote", "url": "http://x/mcp" },
                    "playwright": { "type": "local", "command": ["npx"] }
                }
            }
        });
        assert!(strip_omnimcp_from_root(&mut root));
        assert!(root["mcp"].get("omnipanel").is_none());
        assert!(root["mcp"]["servers"].get("omnipanel").is_none());
        assert!(root["mcp"]["context7"].is_object());
        assert!(root["mcp"]["servers"]["playwright"].is_object());
    }

    #[test]
    fn merge_runtime_defaults_sets_tool_output_and_compaction() {
        let mut root = json!({});
        merge_runtime_defaults_into_root(&mut root);
        assert_eq!(root["tool_output"]["max_lines"], TOOL_OUTPUT_MAX_LINES);
        assert_eq!(root["tool_output"]["max_bytes"], TOOL_OUTPUT_MAX_BYTES);
        assert_eq!(root["compaction"]["auto"], true);
        assert_eq!(root["compaction"]["keep"]["tokens"], COMPACTION_KEEP_TOKENS);
        assert_eq!(root["compaction"]["buffer"], COMPACTION_BUFFER);
    }

    #[test]
    fn merge_ops_agent_sets_default_and_tool_gate() {
        let mut root = json!({});
        merge_ops_agent_into_root(&mut root);
        assert_eq!(root["default_agent"], OPS_AGENT_ID);
        assert_eq!(root["tools"]["omnipanel_*"], false);
        assert_eq!(root["agent"][OPS_AGENT_ID]["mode"], "primary");
        assert_eq!(root["agent"][OPS_AGENT_ID]["tools"]["omnipanel_*"], true);
    }
}
