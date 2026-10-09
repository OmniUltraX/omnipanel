//! Skills / Agent Prompt / Provider Registry（store + 文件层）。

use std::fs;
use std::path::{Path, PathBuf};

use omnipanel_store::{
    AgentPromptEntry, EmbeddingProviderConfig, SKILL_MD_FILENAME, SkillApplication, SkillDbRecord,
    SkillFrontmatter, SkillRecord, SkillVectorStatus, chunk_text, list_all_skill_records,
    list_prompt_entries, load_skill_body, load_skill_record, parse_skill_md, reset_prompt,
    sanitize_skill_id, save_prompt, skill_dir, skill_file_path, write_skill,
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
            storage.save_skill_db(&db_rec).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

async fn upsert_skill_db_v1(state: &ServerState, record: &SkillRecord) -> Result<(), String> {
    let storage = state.storage.lock().await;
    let existing = storage
        .get_skill_db(&record.id)
        .map_err(|e| e.to_string())?;
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
pub struct ProvidersFile {
    #[serde(default = "default_providers_version")]
    pub version: u32,
    #[serde(default)]
    pub http_providers: Vec<HttpProviderRecord>,
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
        let vectors =
            crate::embedding_cmds::fetch_provider_embeddings(provider, &batch_inputs).await?;
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
