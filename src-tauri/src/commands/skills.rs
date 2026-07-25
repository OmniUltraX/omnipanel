//! 产品级 Skills Tauri 命令：CRUD + 导入 + 启用切换 + DB 双写。
//!
//! 文件层逻辑（解析/读写/路径/enabled 检查）统一在 `omnipanel_store::skill` 模块，
//! 本文件只保留 Tauri command 的 DTO 与 thin wrapper，避免双实现漂移。
//!
//! v24 起引入 DB 元数据层（skills 表），用于版本链 / 应用历史 / 成功率统计。
//! `skill_create` / `skill_update` / `skill_remove` / `skill_import` 均双写文件 + DB。
//! 老库首次访问时由 `ensure_skill_db_sync` 懒补齐 DB 记录。

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::state::AppState;

use omnipanel_store::{
    chunk_text, list_all_skill_records, load_skill_body, load_skill_record, parse_skill_md,
    sanitize_skill_id, skill_dir, skill_file_path, write_skill, SkillApplication, SkillDbRecord,
    SkillFrontmatter, SkillRecord, SkillVectorStatus,
};

use crate::commands::knowledge_vector::{fetch_provider_embeddings, EmbeddingProviderConfig};

const SKILL_FILE: &str = "SKILL.md";

/// 懒同步：对没有 DB 记录的文件层 skill 创建 v1 DB 记录。
/// 用于在 v24 迁移后首次访问老 skill 时补齐 DB 元数据。
///
/// 必须使用 `.lock().await`：在 async 命令里对 `tokio::sync::Mutex` 调 `blocking_lock`
/// 会卡住运行时，导致前端一直停在「正在加载 Skills…」。
async fn ensure_skill_db_sync(state: &AppState) -> Result<(), String> {
    let file_records =
        list_all_skill_records().map_err(|e| format!("列出 skills 失败: {e}"))?;
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

/// 为单个 skill 创建或更新 DB 记录（version=1, parent_version_id=""）。
/// 用于 skill_create / skill_import：新 skill 总是 v1。
async fn upsert_skill_db_v1(state: &AppState, record: &SkillRecord) -> Result<(), String> {
    let storage = state.storage.lock().await;
    let existing = storage.get_skill_db(&record.id).map_err(|e| e.to_string())?;
    let db_rec = if let Some(mut existing) = existing {
        // 已有 DB 记录：保留 version / parent_version_id / 统计字段，只更新基础字段
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub body: String,
}

#[tauri::command]
#[specta::specta]
pub async fn skill_get(_state: State<'_, AppState>, id: String) -> Result<SkillDetail, String> {
    let record = load_skill_record(&id)?;
    let file = skill_file_path(&id)?;
    // 编辑器直接改完整 SKILL.md（含 frontmatter）
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    Ok(SkillDetail {
        id: record.id,
        name: record.name,
        description: record.description,
        enabled: record.enabled,
        body: raw,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn skill_list(_state: State<'_, AppState>) -> Result<Vec<SkillRecord>, String> {
    list_all_skill_records()
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateInput {
    pub id: String,
    /// 可省略：若 body 含 frontmatter，以 frontmatter 为准
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

#[tauri::command]
#[specta::specta]
pub async fn skill_create(
    state: State<'_, AppState>,
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
    // 双写：同步到 DB（v1）
    upsert_skill_db_v1(&state, &record).await?;
    Ok(record)
}

#[derive(Debug, Clone, Deserialize, Type)]
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

#[tauri::command]
#[specta::specta]
pub async fn skill_update(
    state: State<'_, AppState>,
    input: SkillUpdateInput,
) -> Result<SkillRecord, String> {
    let file = skill_file_path(&input.id)?;
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut parsed = parse_skill_md(&raw)?;

    // body 若为完整 SKILL.md（含 frontmatter），整文件覆盖；否则只更新正文
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
    // 双写：同步基础字段到 DB（保留 version / 统计字段）
    upsert_skill_db_v1(&state, &record).await?;
    Ok(record)
}

#[tauri::command]
#[specta::specta]
pub async fn skill_remove(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = skill_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
    // 双写：级联删除 DB 记录（applications / links / chunks 通过外键 CASCADE 自动删除）
    let storage = state.storage.lock().await;
    storage.delete_skill_db(&id).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn skill_set_enabled(
    _state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<SkillRecord, String> {
    skill_update(
        _state,
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

#[tauri::command]
#[specta::specta]
pub async fn skill_import(
    state: State<'_, AppState>,
    source_path: String,
) -> Result<SkillRecord, String> {
    let source = std::path::PathBuf::from(source_path.trim());
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
        source.clone()
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
    // 双写：导入的 skill 作为 v1 写入 DB
    upsert_skill_db_v1(&state, &record).await?;
    Ok(record)
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

// ── DB 元数据查询命令（供前端 SkillsSection 展示版本链 / 应用历史 / 成功率） ──────

/// 获取 skill 的 DB 元数据（版本、统计、parent_version_id 等）。
/// 如果文件层 skill 存在但 DB 记录缺失，会先懒同步创建 v1 记录。
#[tauri::command]
#[specta::specta]
pub async fn skill_get_db(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<SkillDbRecord>, String> {
    ensure_skill_db_sync(&state).await?;
    let storage = state.storage.lock().await;
    storage.get_skill_db(&id).map_err(|e| e.to_string())
}

/// 列出所有 skill 的 DB 元数据（含统计）。
/// 如果文件层 skill 存在但 DB 记录缺失，会先懒同步创建 v1 记录。
#[tauri::command]
#[specta::specta]
pub async fn skill_list_db(state: State<'_, AppState>) -> Result<Vec<SkillDbRecord>, String> {
    ensure_skill_db_sync(&state).await?;
    let storage = state.storage.lock().await;
    storage.list_skills_db().map_err(|e| e.to_string())
}

/// 版本链条目：id + 版本号 + 创建时间。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillVersionChainEntry {
    pub id: String,
    #[specta(type = f64)]
    pub version: i64,
    #[specta(type = f64)]
    pub created_at: i64,
}

/// 获取 skill 的版本链（从当前 id 向前追溯 parent_version_id，最多 50 层）。
#[tauri::command]
#[specta::specta]
pub async fn skill_get_version_chain(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<SkillVersionChainEntry>, String> {
    ensure_skill_db_sync(&state).await?;
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

/// 列出 skill 的应用历史（按时间倒序，可限制条数，默认 20）。
#[tauri::command]
#[specta::specta]
pub async fn skill_list_applications(
    state: State<'_, AppState>,
    id: String,
    limit: Option<usize>,
) -> Result<Vec<SkillApplication>, String> {
    let limit = limit.unwrap_or(20).clamp(1, 200);
    let storage = state.storage.lock().await;
    storage
        .list_skill_applications(&id, limit)
        .map_err(|e| e.to_string())
}

/// 更新 skill 应用记录的 outcome（success/failure/partial）+ feedback。
/// 供 UI 在用户标记应用结果后调用；调用后会自动重算对应 skill 的统计字段。
#[tauri::command]
#[specta::specta]
pub async fn skill_update_application_outcome(
    state: State<'_, AppState>,
    application_id: String,
    outcome: String,
    feedback: Option<String>,
) -> Result<(), String> {
    let outcome_trim = outcome.trim();
    if !matches!(outcome_trim, "success" | "failure" | "partial" | "pending" | "refined") {
        return Err(format!(
            "outcome 非法：{outcome_trim}（应为 success / failure / partial / pending / refined）"
        ));
    }
    let feedback = feedback.unwrap_or_default();
    let storage = state.storage.lock().await;
    storage
        .update_skill_application_outcome(&application_id, outcome_trim, &feedback)
        .map_err(|e| e.to_string())?;
    // 取出 application 的 skill_id 后重算统计
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

/// Skill 向量化参数。
#[derive(Debug, Clone, Deserialize, Type)]
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

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillVectorizeResult {
    pub skill_id: String,
    #[specta(type = f64)]
    pub chunk_count: u32,
}

async fn vectorize_one_skill(
    state: &AppState,
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
        let vectors = fetch_provider_embeddings(provider, &batch_inputs).await?;
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

/// 将单个 skill 分块向量化写入 skill_chunks。
#[tauri::command]
#[specta::specta]
pub async fn skill_vectorize(
    state: State<'_, AppState>,
    args: SkillVectorizeArgs,
) -> Result<SkillVectorizeResult, String> {
    ensure_skill_db_sync(&state).await?;
    vectorize_one_skill(
        &state,
        &args.skill_id,
        &args.provider,
        args.chunk_size,
        args.chunk_overlap,
    )
    .await
}

/// 查询 skill 向量化状态。
#[tauri::command]
#[specta::specta]
pub async fn skill_vector_status(
    state: State<'_, AppState>,
    skill_id: String,
) -> Result<Option<SkillVectorStatus>, String> {
    let storage = state.storage.lock().await;
    storage
        .skill_vector_status(&skill_id)
        .map_err(|e| e.to_string())
}

/// 对全部已启用 skill 批量向量化（设置页「重建索引」）。
#[tauri::command]
#[specta::specta]
pub async fn skill_vectorize_all(
    state: State<'_, AppState>,
    provider: EmbeddingProviderConfig,
) -> Result<Vec<SkillVectorizeResult>, String> {
    ensure_skill_db_sync(&state).await?;
    let records = list_all_skill_records()?;
    let mut out = Vec::new();
    for rec in records.into_iter().filter(|r| r.enabled) {
        match vectorize_one_skill(
            &state,
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
