use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use omnipanel_ai::{fetch_provider_models, FetchModelsError, RemoteModelInfo};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{ai_provider_key_ref, Vault};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

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
    /// 请求时是否自动补 `/v1`（已以 /v1 结尾则不会重复）。缺省 true 以兼容旧配置。
    #[serde(default = "default_append_v1")]
    pub append_v1: bool,
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

fn default_append_v1() -> bool {
    true
}

fn models_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join("ai-models.json"))
}

fn scrub_provider_for_disk(mut p: AiModelProvider) -> Result<AiModelProvider, String> {
    if !p.api_key.trim().is_empty() {
        Vault::store(&ai_provider_key_ref(&p.id), p.api_key.trim())
            .map_err(|e| format!("保存 API Key 到钥匙串失败: {}", e.message))?;
        p.has_api_key = true;
    } else {
        p.has_api_key = Vault::get(&ai_provider_key_ref(&p.id))
            .ok()
            .is_some_and(|k| !k.is_empty())
            || p.has_api_key;
    }
    p.api_key.clear();
    Ok(p)
}

fn redact_provider_for_frontend(mut p: AiModelProvider) -> AiModelProvider {
    p.has_api_key = Vault::get(&ai_provider_key_ref(&p.id))
        .ok()
        .is_some_and(|k| !k.is_empty())
        || p.has_api_key
        || !p.api_key.trim().is_empty();
    // 迁移：磁盘仍有明文时写入 Vault（失败时仍清空前端明文，避免落盘）
    if !p.api_key.trim().is_empty() {
        if Vault::store(&ai_provider_key_ref(&p.id), p.api_key.trim()).is_ok() {
            p.has_api_key = true;
        }
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

/// 接口 `/models` 拉取到的单条模型（与前端 `ApiModelInfo` 对齐）。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FetchedProviderModel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub created: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
}

impl From<RemoteModelInfo> for FetchedProviderModel {
    fn from(model: RemoteModelInfo) -> Self {
        Self {
            id: model.id,
            created: model.created,
            owned_by: model.owned_by,
        }
    }
}

fn map_fetch_models_error(err: FetchModelsError) -> OmniError {
    match err {
        FetchModelsError::InvalidBaseUrl => OmniError::invalid_input("Base URL 无效"),
        FetchModelsError::Http { status, body } => {
            let message = if body.is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}: {body}")
            };
            let code = if matches!(status, 401 | 403) {
                ErrorCode::Auth
            } else {
                ErrorCode::Connection
            };
            OmniError::new(code, message)
        }
        FetchModelsError::Network(message) => OmniError::connection(message),
        FetchModelsError::Parse(cause) => {
            OmniError::internal("模型列表响应无法解析").with_cause(cause)
        }
    }
}

/// 经 Rust HTTP 客户端拉取 `{baseUrl}/models`，避开 WebView CORS。
#[tauri::command]
#[specta::specta]
pub async fn ai_models_fetch_list(
    state: State<'_, AppState>,
    base_url: String,
    api_key: String,
    api_standard: Option<String>,
) -> Result<Vec<FetchedProviderModel>, OmniError> {
    let root = base_url.trim().trim_end_matches('/');
    if root.is_empty() {
        return Err(OmniError::invalid_input("Base URL 无效"));
    }
    let proxy_config = state.proxy_config.lock().await.clone();
    let client = crate::commands::proxy::build_http_client_for_url(
        root,
        &proxy_config,
        Duration::from_secs(30),
    )
    .map_err(|e| OmniError::connection("创建 HTTP 客户端失败").with_cause(e))?;

    let models = fetch_provider_models(&client, root, &api_key, api_standard.as_deref())
        .await
        .map_err(map_fetch_models_error)?;
    Ok(models.into_iter().map(FetchedProviderModel::from).collect())
}

/// 前端在 ACP 同步等场景按需取回 Vault 中的 API Key。
#[tauri::command]
#[specta::specta]
pub async fn ai_models_resolve_api_key(provider_id: String) -> Result<String, String> {
    let id = provider_id.trim();
    if id.is_empty() {
        return Err("provider_id 不能为空".into());
    }
    let key = Vault::get(&ai_provider_key_ref(id)).unwrap_or_default();
    if key.trim().is_empty() {
        return Err("未找到该提供商的 API Key，请重新填写并保存".into());
    }
    Ok(key)
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
    let mut scrubbed = Vec::with_capacity(file.providers.len());
    for p in file.providers {
        scrubbed.push(scrub_provider_for_disk(p)?);
    }
    file.providers = scrubbed;
    ai_models_save_inner(&path, &file)
}
