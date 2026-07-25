//! 智能体提示词读写：`~/.omnipd/prompts/`。

use omnipanel_error::OmniError;
use omnipanel_store::{list_prompt_entries, reset_prompt, save_prompt, AgentPromptEntry};

fn map_err(e: OmniError) -> String {
    e.to_string()
}

/// 列出全部可配置提示词。
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt_list() -> Result<Vec<AgentPromptEntry>, String> {
    list_prompt_entries().map_err(map_err)
}

/// 保存提示词正文。
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt_save(id: String, content: String) -> Result<AgentPromptEntry, String> {
    save_prompt(&id, &content).map_err(map_err)
}

/// 恢复内置默认提示词。
#[tauri::command]
#[specta::specta]
pub async fn agent_prompt_reset(id: String) -> Result<AgentPromptEntry, String> {
    reset_prompt(&id).map_err(map_err)
}
