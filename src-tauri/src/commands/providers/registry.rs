use std::fs;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use omnipanel_store::{ai_config_dir, ai_providers_path};

use crate::state::AppState;

const PROVIDERS_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct HttpProviderRecord {
    pub id: String,
    pub provider_name: String,
    pub api_standard: String,
    pub base_url: String,
    #[serde(default)]
    pub model_names: Vec<String>,
    #[serde(default)]
    pub manual_model_names: Vec<String>,
    #[serde(default)]
    pub excluded_model_names: Vec<String>,
    #[serde(default)]
    pub disabled_model_names: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    #[specta(type = f64)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub http_providers: Vec<HttpProviderRecord>,
}

fn default_version() -> u32 {
    PROVIDERS_VERSION
}

pub fn load_providers_file() -> Result<ProvidersFile, String> {
    let path = ai_providers_path().map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(ProvidersFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(ProvidersFile::default());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn save_providers_file(file: &ProvidersFile) -> Result<(), String> {
    let dir = ai_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = ai_providers_path().map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn provider_registry_load(_state: State<'_, AppState>) -> Result<ProvidersFile, String> {
    load_providers_file()
}

#[tauri::command]
#[specta::specta]
pub async fn provider_registry_save(
    _state: State<'_, AppState>,
    file: ProvidersFile,
) -> Result<(), String> {
    save_providers_file(&file)
}
