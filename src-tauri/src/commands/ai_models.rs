use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// AI 提供商配置。前端 camelCase 字段名（providerName / baseUrl / ...），
/// 通过 `#[serde(rename_all = "camelCase")]` 与之对齐。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiModelProvider {
    pub id: String,
    pub provider_name: String,
    pub api_standard: String,
    pub base_url: String,
    pub api_key: String,
    pub model_names: Vec<String>,
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
    // 文件为空或损坏时回退到默认配置,避免单个异常阻塞整个设置页
    if raw.trim().is_empty() {
        return Ok(AiModelsFile::default());
    }
    match serde_json::from_str::<AiModelsFile>(&raw) {
        Ok(file) => Ok(file),
        Err(e) => {
            // 不抛错,让前端拿到空列表继续工作,只记录一条错误
            eprintln!(
                "[ai_models_load] 解析 ai-models.json 失败,使用空配置: {e} (path={})",
                path.display()
            );
            Ok(AiModelsFile::default())
        }
    }
}

/// 原子写入 AI 模型配置 JSON 文件:先写临时文件再 rename,防止崩溃时半写。
#[tauri::command]
#[specta::specta]
pub async fn ai_models_save(app: AppHandle, file: AiModelsFile) -> Result<(), String> {
    let path = models_file_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("序列化 ai-models.json 失败: {e}"))?;
    fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("写入临时文件失败 ({}): {e}", tmp.display()))?;
    if path.exists() {
        let _ = fs::remove_file(&path);
    }
    fs::rename(&tmp, &path)
        .map_err(|e| format!("重命名临时文件失败 ({}): {e}", path.display()))?;
    Ok(())
}
