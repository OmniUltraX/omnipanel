//! Skills / Agent Prompt / Provider Registry（store + 文件层）。

use std::fs;
use std::path::{Path, PathBuf};

use omnipanel_store::{
    chunk_text, list_all_skill_records, list_prompt_entries, load_skill_body, load_skill_record,
    parse_skill_md, reset_prompt, save_prompt, sanitize_skill_id, skill_dir, skill_file_path,
    write_skill, AgentPromptEntry, EmbeddingProviderConfig, SkillApplication, SkillDbRecord,
    SkillFrontmatter, SkillRecord, SkillVectorStatus, SKILL_MD_FILENAME,
};
use serde::{Deserialize, Serialize};

use crate::state::ServerState;

const SKILL_FILE: &str = SKILL_MD_FILENAME;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub body: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateInput {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub body: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateInput {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
}

async fn ensure_skill_db_sync(state: &ServerState) -> Result<(), String> {
    let file_records = list_all_skill_records().map_err(|e| format!("列出 skills 失败: {e}"))?;
    let storage = state.storage.lock().await;
    for fr in file_records {
        if storage
            .get_skill_db(&fr.id)
            .map_err(|e| e.to_string())?
            .is_none()
        {
            let db_rec = SkillDbRecord {
                id: fr.id.clone(),
                name: fr.name.clone(),
                description: fr.description.clone(),
                enabled: fr.enabled,
                version: 1,
                parent_version_id: String::new(),
                path: fr.path.clone(),
                success_count: 0,
                failure_count: 0,
                last_applied_at: None,
                shareable: false,
                created_at: fr.created_at,
                updated_at: fr.updated_at,
            };
            storage
                .save_skill_db(&db_rec)
                .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn upsert_skill_db_v1(state: &ServerState, record: &SkillRecord) -> Result<(), String> {
    let storage = state.storage.lock().await;
    let existing = storage.get_skill_db(&record.id).map_err(|e| e.to_string())?;
    let db_rec = if let Some(mut existing) = existing {
        existing.name = record.name.clone();
        existing.description = record.description.clone();
        existing.enabled = record.enabled;
        existing.path = record.path.clone();
        existing.updated_at = record.updated_at;
        existing
    } else {
        SkillDbRecord {
            id: record.id.clone(),
            name: record.name.clone(),
            description: record.description.clone(),
            enabled: record.enabled,
            version: 1,
            parent_version_id: String::new(),
            path: record.path.clone(),
            success_count: 0,
            failure_count: 0,
            last_applied_at: None,
            shareable: false,
            created_at: record.created_at,
            updated_at: record.updated_at,
        }
    };
    storage.save_skill_db(&db_rec).map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn skill_list() -> Result<Vec<SkillRecord>, String> {
    list_all_skill_records()
}

pub async fn skill_get(id: String) -> Result<SkillDetail, String> {
    let record = load_skill_record(&id)?;
    let file = skill_file_path(&id)?;
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(SkillDetail {
        id: record.id,
        name: record.name,
        description: record.description,
        enabled: record.enabled,
        body: raw,
    })
}

pub async fn skill_create(
    state: &ServerState,
    input: SkillCreateInput,
) -> Result<SkillRecord, String> {
    let id = sanitize_skill_id(&input.id)?;
    let dir = skill_dir(&id)?;
    if dir.exists() {
        return Err(format!("Skill 已存在: {id}"));
    }

    let default_body = "# Skill\n\n在此编写技能说明。\n";
    let (frontmatter, body) = if input.body.trim_start().starts_with("---") {
        let parsed = parse_skill_md(&input.body)?;
        (parsed.frontmatter, parsed.body)
    } else {
        (
            SkillFrontmatter {
                name: if input.name.trim().is_empty() {
                    id.clone()
                } else {
                    input.name.trim().to_string()
                },
                description: input.description.trim().to_string(),
                enabled: input.enabled,
            },
            if input.body.trim().is_empty() {
                default_body.to_string()
            } else {
                input.body
            },
        )
    };

    let record = write_skill(&id, frontmatter, &body)?;
    upsert_skill_db_v1(state, &record).await?;
    Ok(record)
}

pub async fn skill_update(
    state: &ServerState,
    input: SkillUpdateInput,
) -> Result<SkillRecord, String> {
    let file = skill_file_path(&input.id)?;
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut parsed = parse_skill_md(&raw)?;

    if let Some(body) = input.body {
        if body.trim_start().starts_with("---") {
            parsed = parse_skill_md(&body)?;
        } else {
            parsed.body = body;
        }
    }
    if let Some(name) = input.name {
        parsed.frontmatter.name = name.trim().to_string();
    }
    if let Some(description) = input.description {
        parsed.frontmatter.description = description.trim().to_string();
    }
    if let Some(enabled) = input.enabled {
        parsed.frontmatter.enabled = enabled;
    }

    let record = write_skill(&input.id, parsed.frontmatter, &parsed.body)?;
    upsert_skill_db_v1(state, &record).await?;
    Ok(record)
}

pub async fn skill_remove(state: &ServerState, id: String) -> Result<(), String> {
    let dir = skill_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    let storage = state.storage.lock().await;
    storage.delete_skill_db(&id).map_err(|e| e.to_string())?;
    Ok(())
}

pub async fn skill_set_enabled(
    state: &ServerState,
    id: String,
    enabled: bool,
) -> Result<SkillRecord, String> {
    skill_update(
        state,
        SkillUpdateInput {
            id,
            name: None,
            description: None,
            body: None,
            enabled: Some(enabled),
        },
    )
    .await
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        let dest = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            fs::copy(entry.path(), dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub async fn skill_import(state: &ServerState, source_path: String) -> Result<SkillRecord, String> {
    let source = PathBuf::from(source_path.trim());
    if !source.exists() {
        return Err("源路径不存在".to_string());
    }
    let skill_md = if source.is_dir() {
        let candidate = source.join(SKILL_FILE);
        if !candidate.exists() {
            return Err(format!("目录中未找到 {SKILL_FILE}"));
        }
        candidate
    } else if source.file_name().and_then(|s| s.to_str()) == Some(SKILL_FILE) {
        source.to_path_buf()
    } else {
        return Err(format!("请提供 Skill 目录或 {SKILL_FILE} 文件路径"));
    };

    let raw = fs::read_to_string(&skill_md).map_err(|e| e.to_string())?;
    let _parsed = parse_skill_md(&raw)?;
    let id = if source.is_dir() {
        source
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("imported-skill")
            .to_string()
    } else {
        source
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .unwrap_or("imported-skill")
            .to_string()
    };
    let id = sanitize_skill_id(&id)?;
    let dest_dir = skill_dir(&id)?;
    if dest_dir.exists() {
        fs::remove_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    }
    if source.is_dir() {
        copy_dir_recursive(&source, &dest_dir)?;
    } else {
        fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
        fs::copy(&skill_md, dest_dir.join(SKILL_FILE)).map_err(|e| e.to_string())?;
    }
    let record = load_skill_record(&id)?;
    upsert_skill_db_v1(state, &record).await?;
    Ok(record)
}

pub async fn skill_get_db(
    state: &ServerState,
    id: String,
) -> Result<Option<SkillDbRecord>, String> {
    ensure_skill_db_sync(state).await?;
    let storage = state.storage.lock().await;
    storage.get_skill_db(&id).map_err(|e| e.to_string())
}

pub async fn skill_list_db(state: &ServerState) -> Result<Vec<SkillDbRecord>, String> {
    ensure_skill_db_sync(state).await?;
    let storage = state.storage.lock().await;
    storage.list_skills_db().map_err(|e| e.to_string())
}

pub async fn agent_prompt_list() -> Result<Vec<AgentPromptEntry>, String> {
    list_prompt_entries().map_err(|e| e.to_string())
}

pub async fn agent_prompt_save(id: String, content: String) -> Result<AgentPromptEntry, String> {
    save_prompt(&id, &content).map_err(|e| e.to_string())
}

pub async fn agent_prompt_reset(id: String) -> Result<AgentPromptEntry, String> {
    reset_prompt(&id).map_err(|e| e.to_string())
}

const PROVIDERS_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
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
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CliProviderRecord {
    pub id: String,
    pub display_name: String,
    pub protocol: String,
    #[serde(default)]
    pub binary: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProvidersFile {
    #[serde(default = "default_providers_version")]
    pub version: u32,
    #[serde(default)]
    pub http_providers: Vec<HttpProviderRecord>,
    #[serde(default)]
    pub cli_providers: Vec<CliProviderRecord>,
}

fn default_providers_version() -> u32 {
    PROVIDERS_VERSION
}

pub async fn provider_registry_load() -> Result<ProvidersFile, String> {
    let path = omnipanel_store::ai_providers_path().map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(ProvidersFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(ProvidersFile::default());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub async fn provider_registry_save(file: ProvidersFile) -> Result<(), String> {
    let dir = omnipanel_store::ai_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = omnipanel_store::ai_providers_path().map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

/* -------------------- CLI Provider Registry -------------------- */

#[derive(Debug, Clone, Deserialize)]
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
    pub env: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CliProviderOverride {
    #[serde(default)]
    enabled: Option<bool>,
    #[serde(default)]
    manual_model_names: Option<Vec<String>>,
    #[serde(default)]
    disabled_model_names: Option<Vec<String>>,
}

fn cli_provider_overrides_path() -> Result<std::path::PathBuf, String> {
    Ok(omnipanel_store::ai_config_dir()
        .map_err(|e| e.to_string())?
        .join("cli-provider-overrides.json"))
}

fn load_cli_provider_overrides() -> Result<std::collections::HashMap<String, CliProviderOverride>, String> {
    let path = cli_provider_overrides_path()?;
    if !path.exists() {
        return Ok(std::collections::HashMap::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if raw.trim().is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_cli_provider_overrides(
    overrides: &std::collections::HashMap<String, CliProviderOverride>,
) -> Result<(), String> {
    let dir = omnipanel_store::ai_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = cli_provider_overrides_path()?;
    let raw = serde_json::to_string_pretty(overrides).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn apply_cli_provider_override(
    mut provider: CliProviderRecord,
    ov: &CliProviderOverride,
) -> CliProviderRecord {
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
    let path = omnipanel_store::cli_providers_path().map_err(|e| e.to_string())?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

fn save_custom_cli_providers(providers: &[CliProviderRecord]) -> Result<(), String> {
    let dir = omnipanel_store::ai_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = omnipanel_store::cli_providers_path().map_err(|e| e.to_string())?;
    let raw = serde_json::to_string_pretty(providers).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn builtin_cli_providers() -> Vec<CliProviderRecord> {
    crate::agents_detect::detect_all_agents_sync()
        .into_iter()
        .map(|agent| {
            let id = crate::agents_detect::agent_kind_key(agent.kind);
            let display_name = match agent.kind {
                crate::agents_detect::AgentKind::Omniagent => "OmniAgent（遗留）".to_string(),
                crate::agents_detect::AgentKind::Cursor => "Cursor".to_string(),
                crate::agents_detect::AgentKind::Opencode => "OpenCode".to_string(),
                crate::agents_detect::AgentKind::Qwen => "Qwen Code".to_string(),
            };
            let installed = agent.installed;
            let is_legacy = agent.kind == crate::agents_detect::AgentKind::Omniagent;
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
                env: std::collections::HashMap::new(),
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
                    match agent.kind {
                        crate::agents_detect::AgentKind::Cursor => {
                            vec!["--list-models".to_string()]
                        }
                        crate::agents_detect::AgentKind::Opencode => vec!["models".to_string()],
                        crate::agents_detect::AgentKind::Qwen => vec!["--list-models".to_string()],
                        crate::agents_detect::AgentKind::Omniagent => Vec::new(),
                    }
                } else {
                    Vec::new()
                },
            }
        })
        .collect()
}

fn merge_cli_providers(custom: Vec<CliProviderRecord>) -> Vec<CliProviderRecord> {
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
        if provider.builtin && provider.binary.is_none() {
            provider.enabled = false;
            provider.model_discovery_command = None;
            provider.model_discovery_args.clear();
        }
    }
    Ok(merged)
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
    expires: std::time::Instant,
}

static MODEL_CACHE: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<String, ModelCacheEntry>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashMap::new()));

const MODEL_CACHE_TTL: std::time::Duration = std::time::Duration::from_secs(300);

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
            if entry.expires > std::time::Instant::now() {
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
                expires: std::time::Instant::now() + MODEL_CACHE_TTL,
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
            let comspec = std::env::var("COMSPEC")
                .unwrap_or_else(|_| r"C:\Windows\System32\cmd.exe".to_string());
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
            let ids: Vec<String> = data
                .into_iter()
                .map(|m| m.id)
                .filter(|id| !id.is_empty())
                .collect();
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

/* -------------------- Skill 版本链 / 应用记录 / 向量化 -------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersionChainEntry {
    pub id: String,
    pub version: i64,
    pub created_at: i64,
}

pub async fn skill_get_version_chain(
    state: &ServerState,
    id: String,
) -> Result<Vec<SkillVersionChainEntry>, String> {
    ensure_skill_db_sync(state).await?;
    let storage = state.storage.lock().await;
    let chain = storage
        .get_skill_version_chain(&id)
        .map_err(|e| e.to_string())?;
    Ok(chain
        .into_iter()
        .map(|(cid, version, created_at)| SkillVersionChainEntry {
            id: cid,
            version,
            created_at,
        })
        .collect())
}

pub async fn skill_list_applications(
    state: &ServerState,
    id: String,
    limit: Option<f64>,
) -> Result<Vec<SkillApplication>, String> {
    let limit = (limit.unwrap_or(20.0) as usize).clamp(1, 200);
    let storage = state.storage.lock().await;
    storage
        .list_skill_applications(&id, limit)
        .map_err(|e| e.to_string())
}

pub async fn skill_update_application_outcome(
    state: &ServerState,
    application_id: String,
    outcome: String,
    feedback: Option<String>,
) -> Result<(), String> {
    let outcome_trim = outcome.trim();
    if !matches!(
        outcome_trim,
        "success" | "failure" | "partial" | "pending" | "refined"
    ) {
        return Err(format!(
            "outcome 非法：{outcome_trim}（应为 success / failure / partial / pending / refined）"
        ));
    }
    let feedback = feedback.unwrap_or_default();
    let storage = state.storage.lock().await;
    storage
        .update_skill_application_outcome(&application_id, outcome_trim, &feedback)
        .map_err(|e| e.to_string())?;
    if let Some(app) = storage
        .get_skill_application(&application_id)
        .map_err(|e| e.to_string())?
    {
        storage
            .recalc_skill_stats(&app.skill_id)
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVectorizeArgs {
    pub skill_id: String,
    pub provider: EmbeddingProviderConfig,
    #[serde(default = "default_skill_chunk_size")]
    pub chunk_size: u32,
    #[serde(default = "default_skill_chunk_overlap")]
    pub chunk_overlap: u32,
}

fn default_skill_chunk_size() -> u32 {
    800
}

fn default_skill_chunk_overlap() -> u32 {
    120
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillVectorizeResult {
    pub skill_id: String,
    pub chunk_count: u32,
}

async fn vectorize_one_skill(
    state: &ServerState,
    skill_id: &str,
    provider: &EmbeddingProviderConfig,
    chunk_size: u32,
    chunk_overlap: u32,
) -> Result<SkillVectorizeResult, String> {
    let record = load_skill_record(skill_id)?;
    let body = load_skill_body(skill_id)?;
    let source = format!(
        "{}\n\n{}\n\n{}",
        record.name.trim(),
        record.description.trim(),
        body.trim()
    );
    let chunk_size = chunk_size.clamp(100, 8000) as usize;
    let overlap = chunk_overlap.clamp(0, chunk_size.saturating_sub(1) as u32) as usize;
    let pieces = chunk_text(&source, chunk_size, overlap);
    if pieces.is_empty() {
        return Err("Skill 内容为空，无法向量化".to_string());
    }
    let mut embeddings = Vec::with_capacity(pieces.len());
    const BATCH: usize = 32;
    for batch in pieces.chunks(BATCH) {
        let batch_inputs: Vec<String> = batch.to_vec();
        let vectors = crate::embedding_cmds::fetch_provider_embeddings(provider, &batch_inputs).await?;
        embeddings.extend(vectors);
    }
    let chunks: Vec<(String, String, Vec<f32>)> = pieces
        .into_iter()
        .enumerate()
        .zip(embeddings.into_iter())
        .map(|((index, content), embedding)| {
            (format!("{skill_id}:chunk:{index}"), content, embedding)
        })
        .collect();
    let chunk_count = chunks.len() as u32;
    {
        let storage = state.storage.lock().await;
        storage
            .replace_skill_chunks(skill_id, &chunks)
            .map_err(|e| e.to_string())?;
    }
    Ok(SkillVectorizeResult {
        skill_id: skill_id.to_string(),
        chunk_count,
    })
}

pub async fn skill_vectorize(
    state: &ServerState,
    args: SkillVectorizeArgs,
) -> Result<SkillVectorizeResult, String> {
    ensure_skill_db_sync(state).await?;
    vectorize_one_skill(
        state,
        &args.skill_id,
        &args.provider,
        args.chunk_size,
        args.chunk_overlap,
    )
    .await
}

pub async fn skill_vector_status(
    state: &ServerState,
    skill_id: String,
) -> Result<Option<SkillVectorStatus>, String> {
    let storage = state.storage.lock().await;
    storage
        .skill_vector_status(&skill_id)
        .map_err(|e| e.to_string())
}

pub async fn skill_vectorize_all(
    state: &ServerState,
    provider: EmbeddingProviderConfig,
) -> Result<Vec<SkillVectorizeResult>, String> {
    ensure_skill_db_sync(state).await?;
    let records = list_all_skill_records()?;
    let mut out = Vec::new();
    for rec in records.into_iter().filter(|r| r.enabled) {
        match vectorize_one_skill(
            state,
            &rec.id,
            &provider,
            default_skill_chunk_size(),
            default_skill_chunk_overlap(),
        )
        .await
        {
            Ok(r) => out.push(r),
            Err(e) => {
                tracing::warn!(skill_id = %rec.id, error = %e, "skill 向量化失败");
            }
        }
    }
    Ok(out)
}
