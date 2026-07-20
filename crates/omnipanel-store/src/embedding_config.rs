//! Embedding 提供商配置持久化（供后端 MCP / Tauri 共用）。
//!
//! 前端在设置变更时同步写入 `~/.omnipd/ai/embedding_provider.json`，
//! Skill 向量化与混合召回在无前端上下文时从此文件读取。

use std::fs;

use omnipanel_error::{OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::paths::ai_config_dir;

const EMBEDDING_FILE: &str = "embedding_provider.json";
const DEFAULT_OLLAMA_BASE: &str = "http://127.0.0.1:11434";
const DEFAULT_OLLAMA_MODEL: &str = "nomic-embed-text";

/// Embedding 提供商配置（与前端 / Tauri `EmbeddingProviderConfig` 字段对齐）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingProviderConfig {
    pub provider_id: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_standard: String,
}

fn embedding_provider_path() -> OmniResult<std::path::PathBuf> {
    Ok(ai_config_dir()?.join(EMBEDDING_FILE))
}

/// 默认本地 Ollama embedding（best-effort 回退）。
pub fn default_ollama_embedding_provider() -> EmbeddingProviderConfig {
    EmbeddingProviderConfig {
        provider_id: "ollama".to_string(),
        model_name: DEFAULT_OLLAMA_MODEL.to_string(),
        base_url: DEFAULT_OLLAMA_BASE.to_string(),
        api_key: String::new(),
        api_standard: "ollama".to_string(),
    }
}

/// 读取已同步的 embedding 配置；文件不存在时返回 `Ok(None)`。
pub fn load_embedding_provider() -> OmniResult<Option<EmbeddingProviderConfig>> {
    let path = embedding_provider_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(&path).map_err(|e| {
        OmniError::new(
            omnipanel_error::ErrorCode::Io,
            "读取 embedding 配置失败",
        )
        .with_cause(e.to_string())
    })?;
    let cfg: EmbeddingProviderConfig = serde_json::from_str(&raw).map_err(|e| {
        OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            "解析 embedding 配置失败",
        )
        .with_cause(e.to_string())
    })?;
    if cfg.model_name.trim().is_empty() || cfg.base_url.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(cfg))
}

/// 持久化 embedding 配置。
pub fn save_embedding_provider(cfg: &EmbeddingProviderConfig) -> OmniResult<()> {
    if cfg.model_name.trim().is_empty() {
        return Err(OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            "embedding model_name 不能为空",
        ));
    }
    if cfg.base_url.trim().is_empty() {
        return Err(OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            "embedding base_url 不能为空",
        ));
    }
    let dir = ai_config_dir()?;
    fs::create_dir_all(&dir).map_err(|e| {
        OmniError::new(omnipanel_error::ErrorCode::Io, "创建 AI 配置目录失败")
            .with_cause(e.to_string())
    })?;
    let path = dir.join(EMBEDDING_FILE);
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| {
        OmniError::new(
            omnipanel_error::ErrorCode::Internal,
            "序列化 embedding 配置失败",
        )
        .with_cause(e.to_string())
    })?;
    fs::write(&path, raw).map_err(|e| {
        OmniError::new(
            omnipanel_error::ErrorCode::Io,
            "写入 embedding 配置失败",
        )
        .with_cause(e.to_string())
    })?;
    Ok(())
}

/// 解析用于 Skill/Knowledge 向量化的提供商：优先磁盘配置，否则回退默认 Ollama。
pub fn resolve_embedding_provider_for_backend() -> EmbeddingProviderConfig {
    load_embedding_provider()
        .ok()
        .flatten()
        .unwrap_or_else(default_ollama_embedding_provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_ollama_is_valid() {
        let cfg = default_ollama_embedding_provider();
        assert_eq!(cfg.provider_id, "ollama");
        assert!(!cfg.model_name.is_empty());
    }
}
