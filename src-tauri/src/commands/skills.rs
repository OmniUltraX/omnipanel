//! 产品级 Skills 管理：`~/.omnipd/skills/<id>/SKILL.md`。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::state::AppState;

const SKILL_FILE: &str = "SKILL.md";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    pub path: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SkillFrontmatter {
    name: String,
    description: String,
    #[serde(default = "default_enabled")]
    enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone)]
struct ParsedSkill {
    frontmatter: SkillFrontmatter,
    body: String,
}

fn skills_root() -> Result<PathBuf, String> {
    omnipanel_store::skills_root().map_err(|e| e.to_string())
}

fn skill_dir(id: &str) -> Result<PathBuf, String> {
    let id = sanitize_skill_id(id)?;
    Ok(skills_root()?.join(id))
}

fn skill_file_path(id: &str) -> Result<PathBuf, String> {
    Ok(skill_dir(id)?.join(SKILL_FILE))
}

fn sanitize_skill_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim();
    if trimmed.is_empty() {
        return Err("Skill ID 不能为空".to_string());
    }
    if trimmed.contains(['/', '\\', ':']) || trimmed.contains("..") {
        return Err("Skill ID 包含非法字符".to_string());
    }
    Ok(trimmed.to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_skill_md(raw: &str) -> Result<ParsedSkill, String> {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return Err("SKILL.md 必须以 YAML frontmatter（---）开头".to_string());
    }
    let rest = trimmed.strip_prefix("---").unwrap_or(trimmed).trim_start();
    let end = rest
        .find("\n---")
        .ok_or_else(|| "SKILL.md frontmatter 未闭合".to_string())?;
    let yaml = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n').trim_start_matches('\r');
    let frontmatter: SkillFrontmatter = serde_yaml::from_str(yaml)
        .map_err(|e| format!("解析 SKILL.md frontmatter 失败: {e}"))?;
    if frontmatter.name.trim().is_empty() {
        return Err("SKILL.md frontmatter 缺少 name".to_string());
    }
    Ok(ParsedSkill {
        frontmatter,
        body: body.to_string(),
    })
}

fn render_skill_md(frontmatter: &SkillFrontmatter, body: &str) -> String {
    let yaml = serde_yaml::to_string(frontmatter).unwrap_or_default();
    format!("---\n{yaml}---\n\n{body}\n")
}

fn dir_timestamps(path: &Path) -> (i64, i64) {
    let meta = fs::metadata(path).ok();
    let created = meta
        .as_ref()
        .and_then(|m| m.created().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or_else(now_ms);
    let modified = meta
        .as_ref()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(created);
    (created, modified)
}

fn load_skill_record(id: &str) -> Result<SkillRecord, String> {
    let id = sanitize_skill_id(id)?;
    let dir = skill_dir(&id)?;
    let file = dir.join(SKILL_FILE);
    if !file.exists() {
        return Err(format!("Skill 不存在: {id}"));
    }
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let parsed = parse_skill_md(&raw)?;
    let (created_at, updated_at) = dir_timestamps(&dir);
    Ok(SkillRecord {
        id: id.clone(),
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description,
        enabled: parsed.frontmatter.enabled,
        path: dir.to_string_lossy().into_owned(),
        created_at,
        updated_at,
    })
}

fn write_skill(
    id: &str,
    frontmatter: SkillFrontmatter,
    body: &str,
) -> Result<SkillRecord, String> {
    let id = sanitize_skill_id(id)?;
    let dir = skill_dir(&id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join(SKILL_FILE);
    let content = render_skill_md(&frontmatter, body);
    fs::write(&file, content).map_err(|e| e.to_string())?;
    load_skill_record(&id)
}

/// 构建注入系统提示的 Skills 摘要。
pub fn build_skills_system_append() -> Result<String, String> {
    let skills = list_enabled_skill_summaries()?;
    if skills.is_empty() {
        return Ok(String::new());
    }
    let mut lines = vec![
        "## Skills".to_string(),
        "以下 Skill 可按需通过 load_skill 工具加载完整内容：".to_string(),
    ];
    for (id, name, desc) in skills {
        lines.push(format!("- {name} (id: {id}): {desc}"));
    }
    Ok(lines.join("\n"))
}

/// 读取启用 Skill 的 name+description，供内部编排系统提示注入。
pub fn list_enabled_skill_summaries() -> Result<Vec<(String, String, String)>, String> {
    let root = skills_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if let Ok(record) = load_skill_record(&id) {
            if record.enabled {
                out.push((record.id, record.name, record.description));
            }
        }
    }
    out.sort_by(|a, b| a.1.cmp(&b.1));
    Ok(out)
}

/// 按 name 或 id 加载 Skill 正文（供 load_skill 工具）。
pub fn load_skill_body(name_or_id: &str) -> Result<String, String> {
    let key = name_or_id.trim();
    if key.is_empty() {
        return Err("skill name 不能为空".to_string());
    }
    let root = skills_root()?;
    if !root.exists() {
        return Err(format!("未找到 Skill: {key}"));
    }
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        let file = entry.path().join(SKILL_FILE);
        if !file.exists() {
            continue;
        }
        let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
        let parsed = parse_skill_md(&raw)?;
        if !parsed.frontmatter.enabled {
            continue;
        }
        if id == key || parsed.frontmatter.name == key {
            return Ok(parsed.body);
        }
    }
    Err(format!("未找到已启用的 Skill: {key}"))
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
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let parsed = parse_skill_md(&raw)?;
    Ok(SkillDetail {
        id: record.id,
        name: record.name,
        description: record.description,
        enabled: record.enabled,
        body: parsed.body,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn skill_list(_state: State<'_, AppState>) -> Result<Vec<SkillRecord>, String> {
    let root = skills_root()?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut records = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().into_owned();
        if let Ok(record) = load_skill_record(&id) {
            records.push(record);
        }
    }
    records.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(records)
}

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillCreateInput {
    pub id: String,
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub body: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn skill_create(_state: State<'_, AppState>, input: SkillCreateInput) -> Result<SkillRecord, String> {
    let id = sanitize_skill_id(&input.id)?;
    let dir = skill_dir(&id)?;
    if dir.exists() {
        return Err(format!("Skill 已存在: {id}"));
    }
    write_skill(
        &id,
        SkillFrontmatter {
            name: input.name.trim().to_string(),
            description: input.description.trim().to_string(),
            enabled: input.enabled,
        },
        if input.body.trim().is_empty() {
            "# Skill\n\n在此编写技能说明。\n"
        } else {
            input.body.as_str()
        },
    )
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
pub async fn skill_update(_state: State<'_, AppState>, input: SkillUpdateInput) -> Result<SkillRecord, String> {
    let file = skill_file_path(&input.id)?;
    let raw = fs::read_to_string(&file).map_err(|e| e.to_string())?;
    let mut parsed = parse_skill_md(&raw)?;
    if let Some(name) = input.name {
        parsed.frontmatter.name = name.trim().to_string();
    }
    if let Some(description) = input.description {
        parsed.frontmatter.description = description.trim().to_string();
    }
    if let Some(enabled) = input.enabled {
        parsed.frontmatter.enabled = enabled;
    }
    if let Some(body) = input.body {
        parsed.body = body;
    }
    write_skill(&input.id, parsed.frontmatter, &parsed.body)
}

#[tauri::command]
#[specta::specta]
pub async fn skill_remove(_state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = skill_dir(&id)?;
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| e.to_string())?;
    }
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
    _state: State<'_, AppState>,
    source_path: String,
) -> Result<SkillRecord, String> {
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
    load_skill_record(&id)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_render_roundtrip() {
        let fm = SkillFrontmatter {
            name: "demo".to_string(),
            description: "desc".to_string(),
            enabled: true,
        };
        let body = "Hello skill";
        let md = render_skill_md(&fm, body);
        let parsed = parse_skill_md(&md).unwrap();
        assert_eq!(parsed.frontmatter.name, "demo");
        assert_eq!(parsed.body, body);
    }
}
