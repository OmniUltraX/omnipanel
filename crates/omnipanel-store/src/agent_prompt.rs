//! 智能体提示词：
//! - 共享协议提示词：`~/.omnipd/prompts/system-prompt.md`（ACP Client Tools）
//! - 各 Agent 角色提示词：`~/.omnipd/prompts/agents/{id}.md`（设置页按模块编辑）
//!
//! 已存在的用户文件**不会**被覆盖，便于本地配置。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{LazyLock, Mutex};
use std::time::SystemTime;

use omnipanel_error::OmniResult;

use crate::paths::{map_io, prompts_root};

/// 提示词文件名（位于 `~/.omnipd/prompts/`）。
pub mod files {
    /// ACP / Client Tools 协议层提示词（非模块角色）。
    pub const SYSTEM_PROMPT: &str = "system-prompt.md";
    /// 兼容旧版文件名（仅用于首次迁移读取）。
    pub const LEGACY_CLIENT_TOOLS_PREAMBLE: &str = "client-tools-preamble.md";
    /// 各 Agent 角色提示词目录。
    pub const AGENTS_DIR: &str = "agents";
}

/// 可配置的逻辑 Agent 提示词 id（与前端 `AgentId` 对齐）。
pub const AGENT_PROMPT_IDS: &[&str] = &[
    "chat",
    "terminal", // 含原 SSH（已并入终端模块）
    "database",
    "docker",
    "server",
    "files",
    "knowledge",
    "protocol",
    "workflow",
    "tasks",
];

const DEFAULT_SYSTEM_PROMPT: &str = include_str!("../resources/prompts/system-prompt.md");
const DEFAULT_TERMINAL_AGENT_PROMPT: &str =
    include_str!("../resources/prompts/agents/terminal.md");

/// 历史短版默认文案：仍等于这些内容时，启动时可升级为专业终端提示词（不覆盖用户自定义）。
const LEGACY_TERMINAL_AGENT_PROMPTS: &[&str] = &[
    "你是 OmniPanel 的「终端」Agent，专注终端会话、命令与输出分析；仅使用终端相关工具。",
    "你是 OmniPanel 的「终端」Agent，覆盖本地终端与 SSH 远程会话、命令执行与主机相关操作；仅使用终端模块工具（含原 SSH 工具）。",
];

struct CachedFile {
    mtime: Option<SystemTime>,
    content: String,
}

static SYSTEM_CACHE: Mutex<Option<CachedFile>> = Mutex::new(None);
static AGENT_CACHE: LazyLock<Mutex<HashMap<String, CachedFile>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn default_agent_prompt(id: &str) -> &'static str {
    match id {
        "chat" => {
            "你是 OmniPanel 的「聊天助手」Agent。你只负责对话、解释与建议，不能调用任何工具或执行操作。若用户需要操作终端/SSH/数据库/Docker 等，请说明应切换到对应模块 Agent。"
        }
        "terminal" => DEFAULT_TERMINAL_AGENT_PROMPT,
        "database" => {
            "你是 OmniPanel 的「数据库」Agent，专注连接、Schema 与 SQL；仅使用数据库相关工具。"
        }
        "docker" => {
            "你是 OmniPanel 的「Docker」Agent，专注容器/镜像/Compose；仅使用 Docker 相关工具。"
        }
        "server" => {
            "你是 OmniPanel 的「服务器」Agent，专注主机运维与监控；仅使用服务器相关工具。"
        }
        "files" => {
            "你是 OmniPanel 的「文件」Agent，专注文件浏览与读写；仅使用文件相关工具。"
        }
        "knowledge" => {
            "你是 OmniPanel 的「知识库」Agent，专注文档与检索；仅使用知识库相关工具。"
        }
        "protocol" => "你是 OmniPanel 的「协议调试」Agent；仅使用协议相关工具。",
        "workflow" => "你是 OmniPanel 的「工作流」Agent；仅使用工作流相关工具。",
        "tasks" => "你是 OmniPanel 的「任务」Agent；仅使用任务相关工具。",
        _ => "你是 OmniPanel 的助手 Agent，请按用户意图协助完成任务。",
    }
}

fn upgrade_legacy_terminal_prompt_if_needed() -> OmniResult<()> {
    let path = agent_prompt_path("terminal")?;
    if !path.exists() {
        return Ok(());
    }
    let Ok(current) = fs::read_to_string(&path) else {
        return Ok(());
    };
    let trimmed = current.trim();
    if !LEGACY_TERMINAL_AGENT_PROMPTS
        .iter()
        .any(|legacy| trimmed == *legacy)
    {
        return Ok(());
    }
    fs::write(&path, DEFAULT_TERMINAL_AGENT_PROMPT).map_err(map_io)?;
    clear_prompt_cache();
    Ok(())
}

fn write_if_missing(path: &PathBuf, content: &str) -> OmniResult<()> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(map_io)?;
    }
    fs::write(path, content).map_err(map_io)?;
    Ok(())
}

fn agents_dir() -> OmniResult<PathBuf> {
    Ok(prompts_root()?.join(files::AGENTS_DIR))
}

fn agent_prompt_path(id: &str) -> OmniResult<PathBuf> {
    Ok(agents_dir()?.join(format!("{id}.md")))
}

fn is_known_agent_id(id: &str) -> bool {
    AGENT_PROMPT_IDS.contains(&id)
}

/// 首次将内置默认提示词写入用户目录（已存在则跳过）。
pub fn ensure_default_prompts() -> OmniResult<()> {
    let root = prompts_root()?;
    let path = root.join(files::SYSTEM_PROMPT);
    if !path.exists() {
        let legacy = root.join(files::LEGACY_CLIENT_TOOLS_PREAMBLE);
        if legacy.exists() {
            if let Ok(legacy_content) = fs::read_to_string(&legacy) {
                if !legacy_content.trim().is_empty() {
                    write_if_missing(&path, &legacy_content)?;
                } else {
                    write_if_missing(&path, DEFAULT_SYSTEM_PROMPT)?;
                }
            } else {
                write_if_missing(&path, DEFAULT_SYSTEM_PROMPT)?;
            }
        } else {
            write_if_missing(&path, DEFAULT_SYSTEM_PROMPT)?;
        }
    }

    let dir = agents_dir()?;
    fs::create_dir_all(&dir).map_err(map_io)?;
    for id in AGENT_PROMPT_IDS {
        let agent_path = dir.join(format!("{id}.md"));
        write_if_missing(&agent_path, default_agent_prompt(id))?;
    }
    // 将历史短版 terminal 默认提示词升级为专业运维版（用户自定义内容不覆盖）。
    let _ = upgrade_legacy_terminal_prompt_if_needed();

    Ok(())
}

/// 清空内存缓存（保存/重置后调用）。
pub fn clear_prompt_cache() {
    if let Ok(mut cache) = SYSTEM_CACHE.lock() {
        *cache = None;
    }
    if let Ok(mut cache) = AGENT_CACHE.lock() {
        cache.clear();
    }
}

fn read_file_or_default(path: &PathBuf, default: &str) -> String {
    match fs::read_to_string(path) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => default.to_string(),
    }
}

fn load_cached(
    cache: &Mutex<Option<CachedFile>>,
    path: &PathBuf,
    default: &str,
) -> String {
    let meta_mtime = fs::metadata(path).ok().and_then(|m| m.modified().ok());
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.mtime == meta_mtime && !cached.content.trim().is_empty() {
                return cached.content.clone();
            }
        }
    }
    let content = read_file_or_default(path, default);
    if let Ok(mut guard) = cache.lock() {
        *guard = Some(CachedFile {
            mtime: meta_mtime,
            content: content.clone(),
        });
    }
    content
}

fn load_system_prompt() -> String {
    let _ = ensure_default_prompts();
    let path = match prompts_root() {
        Ok(root) => root.join(files::SYSTEM_PROMPT),
        Err(_) => return DEFAULT_SYSTEM_PROMPT.to_string(),
    };
    load_cached(&SYSTEM_CACHE, &path, DEFAULT_SYSTEM_PROMPT)
}

fn load_agent_prompt_file(id: &str) -> String {
    let _ = ensure_default_prompts();
    let default = default_agent_prompt(id);
    let path = match agent_prompt_path(id) {
        Ok(p) => p,
        Err(_) => return default.to_string(),
    };
    let meta_mtime = fs::metadata(&path).ok().and_then(|m| m.modified().ok());
    if let Ok(cache) = AGENT_CACHE.lock() {
        if let Some(cached) = cache.get(id) {
            if cached.mtime == meta_mtime && !cached.content.trim().is_empty() {
                return cached.content.clone();
            }
        }
    }
    let content = read_file_or_default(&path, default);
    if let Ok(mut cache) = AGENT_CACHE.lock() {
        cache.insert(
            id.to_string(),
            CachedFile {
                mtime: meta_mtime,
                content: content.clone(),
            },
        );
    }
    content
}

/// 提示词条目（设置页编辑）。
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptEntry {
    /// Agent id，如 `chat` / `terminal`；协议层为 `system-prompt.md`
    pub id: String,
    pub content: String,
    /// 用户目录绝对路径
    pub path: String,
}

/// 列出各模块 Agent 角色提示词（不含协议层 system-prompt）。
pub fn list_prompt_entries() -> OmniResult<Vec<AgentPromptEntry>> {
    ensure_default_prompts()?;
    let mut entries = Vec::with_capacity(AGENT_PROMPT_IDS.len());
    for id in AGENT_PROMPT_IDS {
        let path = agent_prompt_path(id)?;
        entries.push(AgentPromptEntry {
            id: (*id).to_string(),
            content: load_agent_prompt_file(id),
            path: path.to_string_lossy().into_owned(),
        });
    }
    Ok(entries)
}

/// 保存 Agent 角色提示词。
pub fn save_prompt(id: &str, content: &str) -> OmniResult<AgentPromptEntry> {
    let id = id.trim();
    if !is_known_agent_id(id) {
        return Err(omnipanel_error::OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            format!("未知 Agent 提示词: {id}"),
        ));
    }
    let path = agent_prompt_path(id)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(map_io)?;
    }
    fs::write(&path, content).map_err(map_io)?;
    clear_prompt_cache();
    Ok(AgentPromptEntry {
        id: id.to_string(),
        content: content.to_string(),
        path: path.to_string_lossy().into_owned(),
    })
}

/// 恢复内置默认并写回磁盘。
pub fn reset_prompt(id: &str) -> OmniResult<AgentPromptEntry> {
    let id = id.trim();
    if !is_known_agent_id(id) {
        return Err(omnipanel_error::OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            format!("未知 Agent 提示词: {id}"),
        ));
    }
    save_prompt(id, default_agent_prompt(id))
}

/// 按 Agent id 读取角色提示词（运行时注入）。
pub fn agent_prompt(agent_id: &str) -> String {
    let id = agent_id.trim();
    if !is_known_agent_id(id) {
        return default_agent_prompt("chat").to_string();
    }
    load_agent_prompt_file(id)
}

/// ACP Client Tools 协议层提示词。
pub fn system_prompt() -> String {
    load_system_prompt()
}

/// 兼容旧调用名。
pub fn client_tools_preamble() -> String {
    system_prompt()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_non_empty() {
        assert!(!DEFAULT_SYSTEM_PROMPT.trim().is_empty());
        assert!(DEFAULT_SYSTEM_PROMPT.contains("OmniPanel Client Tool API"));
        for id in AGENT_PROMPT_IDS {
            assert!(!default_agent_prompt(id).trim().is_empty(), "{id}");
        }
    }

    #[test]
    fn ensure_and_load_roundtrip() {
        ensure_default_prompts().expect("seed prompts");
        let preamble = system_prompt();
        assert!(preamble.contains("tool_calls") || preamble.contains("OmniPanel"));
        let chat = agent_prompt("chat");
        assert!(chat.contains("聊天助手") || chat.contains("chat"));
        let terminal = default_agent_prompt("terminal");
        assert!(terminal.contains("服务与健康检查"));
        assert!(terminal.contains("资源占用"));
        assert!(terminal.contains("环境安装"));
        let list = list_prompt_entries().expect("list");
        assert_eq!(list.len(), AGENT_PROMPT_IDS.len());
        assert!(list.iter().any(|e| e.id == "terminal"));
    }
}
