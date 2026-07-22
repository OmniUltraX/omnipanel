use std::collections::HashMap;
use std::fs;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use omnipanel_store::{ai_config_dir, ai_providers_path, cli_providers_path};

use crate::commands::agents::{agent_kind_key, detect_all_agents_sync, AgentKind};
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CliProviderRecord {
    pub id: String,
    pub display_name: String,
    /// acp | cli_stream
    pub protocol: String,
    #[serde(default)]
    pub binary: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    #[specta(type = Option<f64>)]
    pub timeout_secs: Option<u64>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub builtin: bool,
    #[serde(default)]
    pub static_models: Vec<String>,
    #[serde(default)]
    pub manual_model_names: Vec<String>,
    #[serde(default)]
    pub disabled_model_names: Vec<String>,
    #[serde(default)]
    pub model_discovery_command: Option<String>,
    #[serde(default)]
    pub model_discovery_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default)]
    pub http_providers: Vec<HttpProviderRecord>,
    #[serde(default)]
    pub cli_providers: Vec<CliProviderRecord>,
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

fn cli_provider_overrides_path() -> Result<std::path::PathBuf, String> {
    Ok(ai_config_dir()
        .map_err(|e| e.to_string())?
        .join("cli-provider-overrides.json"))
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliProviderOverride {
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub manual_model_names: Option<Vec<String>>,
    #[serde(default)]
    pub disabled_model_names: Option<Vec<String>>,
}

fn load_cli_provider_overrides() -> Result<HashMap<String, CliProviderOverride>, String> {
    let path = cli_provider_overrides_path()?;
    if !path.exists() {
        return Ok(HashMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(HashMap::new());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_cli_provider_overrides(overrides: &HashMap<String, CliProviderOverride>) -> Result<(), String> {
    let dir = ai_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = cli_provider_overrides_path()?;
    let raw = serde_json::to_string_pretty(overrides).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn apply_cli_provider_override(mut provider: CliProviderRecord, ov: &CliProviderOverride) -> CliProviderRecord {
    if let Some(enabled) = ov.enabled {
        provider.enabled = enabled;
    }
    if let Some(names) = &ov.manual_model_names {
        provider.manual_model_names = names.clone();
    }
    if let Some(names) = &ov.disabled_model_names {
        provider.disabled_model_names = names.clone();
    }
    provider
}

fn load_custom_cli_providers() -> Result<Vec<CliProviderRecord>, String> {
    let path = cli_providers_path().map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_custom_cli_providers(providers: &[CliProviderRecord]) -> Result<(), String> {
    let dir = ai_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = cli_providers_path().map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(providers).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn list_models_args_for(kind: AgentKind) -> Vec<String> {
    match kind {
        AgentKind::Cursor => vec!["--list-models".to_string()],
        AgentKind::Opencode => vec!["models".to_string()],
        AgentKind::Qwen => vec!["--list-models".to_string()],
        AgentKind::Omniagent => Vec::new(),
    }
}

fn builtin_cli_providers() -> Vec<CliProviderRecord> {
    detect_all_agents_sync(None)
        .into_iter()
        .map(|agent| {
            let id = agent_kind_key(agent.kind);
            let display_name = match agent.kind {
                AgentKind::Omniagent => "OmniAgent（遗留）".to_string(),
                AgentKind::Cursor => "Cursor".to_string(),
                AgentKind::Opencode => "OpenCode".to_string(),
                AgentKind::Qwen => "Qwen Code".to_string(),
            };
            let installed = agent.installed;
            let is_legacy = agent.kind == AgentKind::Omniagent;
            CliProviderRecord {
                id: id.to_string(),
                display_name,
                protocol: "acp".to_string(),
                binary: if installed {
                    agent.executable_path.clone()
                } else {
                    None
                },
                args: agent.launch_args.clone(),
                env: HashMap::new(),
                cwd: None,
                timeout_secs: Some(300),
                enabled: installed && !is_legacy,
                builtin: true,
                static_models: if is_legacy {
                    vec!["default".to_string()]
                } else {
                    Vec::new()
                },
                manual_model_names: Vec::new(),
                disabled_model_names: Vec::new(),
                model_discovery_command: if installed && !is_legacy {
                    agent.executable_path.clone()
                } else {
                    None
                },
                model_discovery_args: if installed && !is_legacy {
                    list_models_args_for(agent.kind)
                } else {
                    Vec::new()
                },
            }
        })
        .collect()
}

pub fn merge_cli_providers(custom: Vec<CliProviderRecord>) -> Vec<CliProviderRecord> {
    let mut merged = builtin_cli_providers();
    for c in custom {
        if c.builtin {
            continue;
        }
        if let Some(idx) = merged.iter().position(|b| b.id == c.id) {
            merged[idx] = c;
        } else {
            merged.push(c);
        }
    }
    merged
}

pub fn cli_provider_list() -> Result<Vec<CliProviderRecord>, String> {
    let custom = load_custom_cli_providers()?;
    let overrides = load_cli_provider_overrides()?;
    let mut merged = merge_cli_providers(custom);
    for provider in &mut merged {
        if let Some(ov) = overrides.get(&provider.id) {
            *provider = apply_cli_provider_override(provider.clone(), ov);
        }
        // 未安装的内置提供者不可启用，避免 UI 与检测状态矛盾
        if provider.builtin && provider.binary.is_none() {
            provider.enabled = false;
            provider.model_discovery_command = None;
            provider.model_discovery_args.clear();
        }
    }
    Ok(merged)
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CliProviderUpsertInput {
    pub id: String,
    pub display_name: String,
    pub protocol: String,
    #[serde(default)]
    pub binary: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    #[specta(type = Option<f64>)]
    pub timeout_secs: Option<u64>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub static_models: Vec<String>,
    #[serde(default)]
    pub manual_model_names: Vec<String>,
    #[serde(default)]
    pub disabled_model_names: Vec<String>,
    #[serde(default)]
    pub model_discovery_command: Option<String>,
    #[serde(default)]
    pub model_discovery_args: Vec<String>,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CliProviderPatchInput {
    pub id: String,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub manual_model_names: Option<Vec<String>>,
    #[serde(default)]
    pub disabled_model_names: Option<Vec<String>>,
}

pub fn cli_provider_patch(input: CliProviderPatchInput) -> Result<CliProviderRecord, String> {
    let id = input.id.trim().to_string();
    if id.is_empty() {
        return Err("CLI 提供者 ID 不能为空".to_string());
    }
    invalidate_model_cache(&id);

    if input.enabled == Some(true) {
        if let Some(builtin) = builtin_cli_providers().iter().find(|b| b.id == id) {
            if builtin.binary.is_none() {
                return Err(format!("{} 未安装，无法启用", builtin.display_name));
            }
        }
    }

    let is_builtin = builtin_cli_providers().iter().any(|b| b.id == id);
    if is_builtin {
        let mut overrides = load_cli_provider_overrides()?;
        let entry = overrides.entry(id.clone()).or_default();
        if let Some(enabled) = input.enabled {
            entry.enabled = Some(enabled);
        }
        if let Some(names) = input.manual_model_names {
            entry.manual_model_names = Some(names);
        }
        if let Some(names) = input.disabled_model_names {
            entry.disabled_model_names = Some(names);
        }
        save_cli_provider_overrides(&overrides)?;
    } else {
        let mut custom = load_custom_cli_providers()?;
        let idx = custom
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| format!("未找到 CLI 提供者: {id}"))?;
        if let Some(enabled) = input.enabled {
            custom[idx].enabled = enabled;
        }
        if let Some(names) = input.manual_model_names {
            custom[idx].manual_model_names = names;
        }
        if let Some(names) = input.disabled_model_names {
            custom[idx].disabled_model_names = names;
        }
        save_custom_cli_providers(&custom)?;
    }

    cli_provider_list()?
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| format!("未找到 CLI 提供者: {id}"))
}

pub fn cli_provider_upsert(input: CliProviderUpsertInput) -> Result<CliProviderRecord, String> {
    let id = input.id.trim().to_string();
    if id.is_empty() {
        return Err("CLI 提供者 ID 不能为空".to_string());
    }
    if builtin_cli_providers().iter().any(|b| b.id == id) {
        return Err("内置 CLI 提供者不可覆盖，请使用启用开关".to_string());
    }
    let record = CliProviderRecord {
        id,
        display_name: input.display_name.trim().to_string(),
        protocol: input.protocol.trim().to_lowercase(),
        binary: input.binary,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
        timeout_secs: input.timeout_secs,
        enabled: input.enabled,
        builtin: false,
        static_models: input.static_models,
        manual_model_names: input.manual_model_names,
        disabled_model_names: input.disabled_model_names,
        model_discovery_command: input.model_discovery_command,
        model_discovery_args: input.model_discovery_args,
    };
    invalidate_model_cache(&record.id);
    let mut custom = load_custom_cli_providers()?;
    if let Some(idx) = custom.iter().position(|c| c.id == record.id) {
        custom[idx] = record.clone();
    } else {
        custom.push(record.clone());
    }
    save_custom_cli_providers(&custom)?;
    Ok(record)
}

pub fn cli_provider_remove(id: &str) -> Result<(), String> {
    if builtin_cli_providers().iter().any(|b| b.id == id) {
        return Err("无法删除内置 CLI 提供者".to_string());
    }
    let mut custom = load_custom_cli_providers()?;
    custom.retain(|c| c.id != id);
    save_custom_cli_providers(&custom)
}

struct ModelCacheEntry {
    models: Vec<String>,
    expires: Instant,
}

static MODEL_CACHE: LazyLock<Mutex<HashMap<String, ModelCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const MODEL_CACHE_TTL: Duration = Duration::from_secs(300);

fn invalidate_model_cache(provider_id: &str) {
    if let Ok(mut cache) = MODEL_CACHE.lock() {
        cache.remove(&provider_id.trim().to_lowercase());
    }
}

pub fn provider_list_models(provider_id: &str) -> Result<Vec<String>, String> {
    let key = provider_id.trim().to_lowercase();
    {
        let cache = MODEL_CACHE.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = cache.get(&key) {
            if entry.expires > Instant::now() {
                return Ok(entry.models.clone());
            }
        }
    }

    let providers = cli_provider_list()?;
    let provider = providers
        .iter()
        .find(|p| p.id == key)
        .ok_or_else(|| format!("未找到 CLI 提供者: {key}"))?;

    let mut models = if let Some(cmd) = provider.model_discovery_command.as_deref() {
        discover_models_cmd(cmd, &provider.model_discovery_args)?
    } else if !provider.static_models.is_empty() {
        provider.static_models.clone()
    } else if provider.binary.is_none() {
        return Err(format!(
            "CLI 提供者「{}」未安装，无法获取模型列表",
            provider.display_name
        ));
    } else {
        return Err(format!(
            "CLI 提供者「{}」未配置模型发现，请手动添加模型",
            provider.display_name
        ));
    };

    for manual in &provider.manual_model_names {
        if !models.iter().any(|m| m == manual) {
            models.push(manual.clone());
        }
    }
    models.sort();

    if let Ok(mut cache) = MODEL_CACHE.lock() {
        cache.insert(
            key,
            ModelCacheEntry {
                models: models.clone(),
                expires: Instant::now() + MODEL_CACHE_TTL,
            },
        );
    }
    Ok(models)
}

fn spawn_model_discovery(command: &str, args: &[String]) -> Result<std::process::Output, String> {
    use std::process::Command;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let lower = command.to_lowercase();
        if lower.ends_with(".cmd") || lower.ends_with(".bat") {
            let comspec = std::env::var("COMSPEC").unwrap_or_else(|_| {
                r"C:\Windows\System32\cmd.exe".to_string()
            });
            let mut cmd_args = vec!["/c".to_string(), command.to_string()];
            cmd_args.extend(args.iter().cloned());
            return Command::new(comspec)
                .args(cmd_args)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| format!("执行模型发现命令失败: {e}"));
        }
        return Command::new(command)
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| format!("执行模型发现命令失败: {e}"));
    }

    #[cfg(not(windows))]
    {
        Command::new(command)
            .args(args)
            .output()
            .map_err(|e| format!("执行模型发现命令失败: {e}"))
    }
}

fn parse_model_list(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    if let Ok(arr) = serde_json::from_str::<Vec<String>>(trimmed) {
        if !arr.is_empty() {
            return arr;
        }
    }

    #[derive(serde::Deserialize)]
    struct ModelsWrapper {
        models: Option<Vec<String>>,
        data: Option<Vec<ModelId>>,
    }
    #[derive(serde::Deserialize)]
    struct ModelId {
        id: String,
    }

    if let Ok(obj) = serde_json::from_str::<ModelsWrapper>(trimmed) {
        if let Some(models) = obj.models.filter(|m| !m.is_empty()) {
            return models;
        }
        if let Some(data) = obj.data {
            let ids: Vec<String> = data.into_iter().map(|m| m.id).filter(|id| !id.is_empty()).collect();
            if !ids.is_empty() {
                return ids;
            }
        }
    }

    let mut models = Vec::new();
    for line in trimmed.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let lower = line.to_lowercase();
        if lower == "available models" || lower.starts_with("tip:") {
            continue;
        }
        let id = line.split(" - ").next().unwrap_or(line).trim();
        if !id.is_empty() {
            models.push(id.to_string());
        }
    }
    models
}

fn discover_models_cmd(command: &str, args: &[String]) -> Result<Vec<String>, String> {
    let output = spawn_model_discovery(command, args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            format!("退出码: {:?}", output.status.code())
        } else {
            stderr
        };
        return Err(format!("模型发现命令失败: {detail}"));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let models = parse_model_list(&stdout);
    if !models.is_empty() {
        return Ok(models);
    }
    let from_stderr = parse_model_list(&stderr);
    if from_stderr.is_empty() {
        Err("模型发现命令未返回任何模型".to_string())
    } else {
        Ok(from_stderr)
    }
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

#[tauri::command]
#[specta::specta]
pub async fn cli_provider_list_cmd(_state: State<'_, AppState>) -> Result<Vec<CliProviderRecord>, String> {
    cli_provider_list()
}

#[tauri::command]
#[specta::specta]
pub async fn cli_provider_upsert_cmd(
    _state: State<'_, AppState>,
    input: CliProviderUpsertInput,
) -> Result<CliProviderRecord, String> {
    cli_provider_upsert(input)
}

#[tauri::command]
#[specta::specta]
pub async fn cli_provider_remove_cmd(
    _state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    cli_provider_remove(&id)
}

#[tauri::command]
#[specta::specta]
pub async fn provider_list_models_cmd(
    _state: State<'_, AppState>,
    provider_id: String,
) -> Result<Vec<String>, String> {
    provider_list_models(&provider_id)
}

#[tauri::command]
#[specta::specta]
pub async fn cli_provider_patch_cmd(
    _state: State<'_, AppState>,
    input: CliProviderPatchInput,
) -> Result<CliProviderRecord, String> {
    cli_provider_patch(input)
}
