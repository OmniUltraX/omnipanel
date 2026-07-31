use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use omnipanel_store::{ai_provider_key_ref, Vault};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 接口 /models 返回的单条模型元数据。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiModelMeta {
    /// Unix 秒级时间戳；Specta 导出为 number。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub created: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
}

/// AI 提供商配置。前端 camelCase 字段名（providerName / baseUrl / ...），
/// 通过 `#[serde(rename_all = "camelCase")]` 与之对齐。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiModelProvider {
    pub id: String,
    pub provider_name: String,
    pub api_standard: String,
    pub base_url: String,
    /// 明文仅提交时存在；load 返回空，用 `has_api_key` 表示钥匙串是否有密钥。
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub has_api_key: bool,
    pub model_names: Vec<String>,
    #[serde(default)]
    pub manual_model_names: Vec<String>,
    #[serde(default)]
    pub excluded_model_names: Vec<String>,
    #[serde(default)]
    pub disabled_model_names: Vec<String>,
    #[serde(default)]
    pub api_model_meta: HashMap<String, ApiModelMeta>,
    // 毫秒级时间戳：i64 存储，但 specta 导出为 number（远小于 2^53，无精度损失）
    #[specta(type = f64)]
    pub created_at: i64,
}

/// 持久化文件结构。版本号用于前端迁移。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiModelsFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<AiModelProvider>,
}

fn default_version() -> u32 {
    1
}

fn models_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join("ai-models.json"))
}

fn scrub_provider_for_disk(mut p: AiModelProvider) -> AiModelProvider {
    if !p.api_key.trim().is_empty() {
        let _ = Vault::store(&ai_provider_key_ref(&p.id), p.api_key.trim());
        p.has_api_key = true;
    } else {
        p.has_api_key = Vault::get(&ai_provider_key_ref(&p.id))
            .ok()
            .is_some_and(|k| !k.is_empty())
            || p.has_api_key;
    }
    p.api_key.clear();
    p
}

fn redact_provider_for_frontend(mut p: AiModelProvider) -> AiModelProvider {
    p.has_api_key = Vault::get(&ai_provider_key_ref(&p.id))
        .ok()
        .is_some_and(|k| !k.is_empty())
        || p.has_api_key
        || !p.api_key.trim().is_empty();
    // 迁移：磁盘仍有明文时写入 Vault
    if !p.api_key.trim().is_empty() {
        let _ = Vault::store(&ai_provider_key_ref(&p.id), p.api_key.trim());
        p.has_api_key = true;
    }
    p.api_key.clear();
    p
}

/// 供 chat 路径按 provider id 取密钥。
pub fn resolve_ai_provider_api_key(provider_id: &str, request_key: &str) -> String {
    if !request_key.trim().is_empty() {
        return request_key.to_string();
    }
    Vault::get(&ai_provider_key_ref(provider_id))
        .unwrap_or_default()
}

/// 读取 AI 模型配置 JSON 文件。文件不存在时返回默认空配置。
#[tauri::command]
#[specta::specta]
pub async fn ai_models_load(app: AppHandle) -> Result<AiModelsFile, String> {
    let path = models_file_path(&app)?;
    if !path.exists() {
        return Ok(AiModelsFile::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| format!("读取 ai-models.json 失败 ({}): {e}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(AiModelsFile::default());
    }
    match serde_json::from_str::<AiModelsFile>(&raw) {
        Ok(mut file) => {
            let mut need_rewrite = false;
            file.providers = file
                .providers
                .into_iter()
                .map(|p| {
                    if !p.api_key.trim().is_empty() {
                        need_rewrite = true;
                    }
                    redact_provider_for_frontend(p)
                })
                .collect();
            if need_rewrite {
                let _ = ai_models_save_inner(&path, &file);
            }
            Ok(file)
        }
        Err(e) => {
            eprintln!(
                "[ai_models_load] 解析 ai-models.json 失败,使用空配置: {e} (path={})",
                path.display()
            );
            Ok(AiModelsFile::default())
        }
    }
}

fn ai_models_save_inner(path: &PathBuf, file: &AiModelsFile) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(file)
        .map_err(|e| format!("序列化 ai-models.json 失败: {e}"))?;
    fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("写入临时文件失败 ({}): {e}", tmp.display()))?;
    if path.exists() {
        let _ = fs::remove_file(path);
    }
    fs::rename(&tmp, path).map_err(|e| format!("重命名临时文件失败 ({}): {e}", path.display()))?;
    Ok(())
}

/// 原子写入 AI 模型配置 JSON 文件:先写临时文件再 rename,防止崩溃时半写。
#[tauri::command]
#[specta::specta]
pub async fn ai_models_save(app: AppHandle, mut file: AiModelsFile) -> Result<(), String> {
    let path = models_file_path(&app)?;
    // 删除已不存在的 provider 的钥匙串条目
    let keep: std::collections::HashSet<_> = file.providers.iter().map(|p| p.id.clone()).collect();
    if path.exists() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(old) = serde_json::from_str::<AiModelsFile>(&raw) {
                for p in old.providers {
                    if !keep.contains(&p.id) {
                        let _ = Vault::delete(&ai_provider_key_ref(&p.id));
                    }
                }
            }
        }
    }
    file.providers = file
        .providers
        .into_iter()
        .map(scrub_provider_for_disk)
        .collect();
    ai_models_save_inner(&path, &file)
}
