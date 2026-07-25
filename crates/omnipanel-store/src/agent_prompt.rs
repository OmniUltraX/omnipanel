//! 智能体提示词：默认内嵌于 `resources/prompts/system-prompt.md`，
//! 首次写入 `~/.omnipd/prompts/system-prompt.md`，之后运行时读取。
//!
//! 已存在的用户文件**不会**被覆盖，便于本地配置。

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;

use omnipanel_error::OmniResult;

use crate::paths::{map_io, prompts_root};

/// 提示词文件名（位于 `~/.omnipd/prompts/`）。
pub mod files {
    /// 唯一可配置的智能体系统提示词。
    pub const SYSTEM_PROMPT: &str = "system-prompt.md";
    /// 兼容旧版文件名（仅用于首次迁移读取）。
    pub const LEGACY_CLIENT_TOOLS_PREAMBLE: &str = "client-tools-preamble.md";
}

const DEFAULT_SYSTEM_PROMPT: &str = include_str!("../resources/prompts/system-prompt.md");

struct CachedFile {
    mtime: Option<SystemTime>,
    content: String,
}

static CACHE: Mutex<Option<CachedFile>> = Mutex::new(None);

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

/// 首次将内置默认提示词写入用户目录（已存在则跳过）。
/// 若仅有旧版 `client-tools-preamble.md`，则复制为 `system-prompt.md`（不覆盖）。
pub fn ensure_default_prompts() -> OmniResult<()> {
    let root = prompts_root()?;
    let path = root.join(files::SYSTEM_PROMPT);
    if path.exists() {
        return Ok(());
    }
    let legacy = root.join(files::LEGACY_CLIENT_TOOLS_PREAMBLE);
    if legacy.exists() {
        if let Ok(legacy_content) = fs::read_to_string(&legacy) {
            if !legacy_content.trim().is_empty() {
                write_if_missing(&path, &legacy_content)?;
                return Ok(());
            }
        }
    }
    write_if_missing(&path, DEFAULT_SYSTEM_PROMPT)?;
    Ok(())
}

/// 清空内存缓存（保存/重置后调用）。
pub fn clear_prompt_cache() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

fn read_system_prompt_uncached() -> String {
    let path = match prompts_root() {
        Ok(root) => root.join(files::SYSTEM_PROMPT),
        Err(_) => return DEFAULT_SYSTEM_PROMPT.to_string(),
    };
    match fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => s,
        _ => DEFAULT_SYSTEM_PROMPT.to_string(),
    }
}

fn load_system_prompt() -> String {
    let _ = ensure_default_prompts();
    let path = match prompts_root() {
        Ok(root) => root.join(files::SYSTEM_PROMPT),
        Err(_) => return DEFAULT_SYSTEM_PROMPT.to_string(),
    };
    let meta_mtime = fs::metadata(&path).ok().and_then(|m| m.modified().ok());
    if let Ok(cache) = CACHE.lock() {
        if let Some(cached) = cache.as_ref() {
            if cached.mtime == meta_mtime && !cached.content.trim().is_empty() {
                return cached.content.clone();
            }
        }
    }
    let content = read_system_prompt_uncached();
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some(CachedFile {
            mtime: meta_mtime,
            content: content.clone(),
        });
    }
    content
}

/// 提示词条目（设置页编辑）。
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentPromptEntry {
    /// 文件名，固定为 `system-prompt.md`
    pub id: String,
    pub content: String,
    /// 用户目录绝对路径
    pub path: String,
}

/// 列出可配置提示词（仅一条）。
pub fn list_prompt_entries() -> OmniResult<Vec<AgentPromptEntry>> {
    ensure_default_prompts()?;
    let root = prompts_root()?;
    let path = root.join(files::SYSTEM_PROMPT);
    let content = load_system_prompt();
    Ok(vec![AgentPromptEntry {
        id: files::SYSTEM_PROMPT.to_string(),
        content,
        path: path.to_string_lossy().into_owned(),
    }])
}

/// 保存提示词；仅允许 `system-prompt.md`。
pub fn save_prompt(id: &str, content: &str) -> OmniResult<AgentPromptEntry> {
    let id = id.trim();
    if id != files::SYSTEM_PROMPT {
        return Err(omnipanel_error::OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            format!("未知提示词: {id}（仅支持 {}）", files::SYSTEM_PROMPT),
        ));
    }
    let root = prompts_root()?;
    let path = root.join(id);
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
    if id != files::SYSTEM_PROMPT {
        return Err(omnipanel_error::OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            format!("未知提示词: {id}"),
        ));
    }
    save_prompt(id, DEFAULT_SYSTEM_PROMPT)
}

/// 智能体系统提示词（ACP Client Tools / 通用注入）。
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
    }

    #[test]
    fn ensure_and_load_roundtrip() {
        ensure_default_prompts().expect("seed prompts");
        let preamble = system_prompt();
        assert!(preamble.contains("tool_calls") || preamble.contains("OmniPanel"));
    }
}
