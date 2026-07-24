//! 产品级 Skills 文件解析与读写：`~/.omnipd/skills/<id>/SKILL.md`。
//!
//! 本模块是 Skill 文件层的单一真相源，供 `omnipanel-mcp`（load_skill 工具）
//! 和 `src-tauri/commands/skills.rs`（Tauri command）共享。
//! 所有路径解析、frontmatter 解析、enabled 检查都在这里统一，避免双实现漂移。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use specta::Type;

const SKILL_FILE: &str = "SKILL.md";

/// Skill 正文文件名（目录内）。
pub const SKILL_MD_FILENAME: &str = SKILL_FILE;

/// Skill 的 YAML frontmatter。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFrontmatter {
    pub name: String,
    pub description: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

/// 解析后的 Skill（frontmatter + 正文）。
#[derive(Debug, Clone)]
pub struct ParsedSkill {
    pub frontmatter: SkillFrontmatter,
    pub body: String,
}

/// Skill 记录（列表/CRUD 用，含文件元信息）。
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

fn skills_root() -> Result<PathBuf, String> {
    crate::paths::skills_root().map_err(|e| e.to_string())
}

pub fn skill_dir(id: &str) -> Result<PathBuf, String> {
    let id = sanitize_skill_id(id)?;
    Ok(skills_root()?.join(id))
}

pub fn skill_file_path(id: &str) -> Result<PathBuf, String> {
    Ok(skill_dir(id)?.join(SKILL_FILE))
}

pub fn sanitize_skill_id(id: &str) -> Result<String, String> {
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

/// 解析 SKILL.md：frontmatter（YAML）+ 正文（Markdown）。
pub fn parse_skill_md(raw: &str) -> Result<ParsedSkill, String> {
    let trimmed = raw.trim_start();
    if !trimmed.starts_with("---") {
        return Err("SKILL.md 必须以 YAML frontmatter（---）开头".to_string());
    }
    let rest = trimmed.strip_prefix("---").unwrap_or(trimmed).trim_start();
    let end = rest
        .find("\n---")
        .ok_or_else(|| "SKILL.md frontmatter 未闭合".to_string())?;
    let yaml = &rest[..end];
    let body = rest[end + 4..]
        .trim_start_matches('\n')
        .trim_start_matches('\r');
    let frontmatter: SkillFrontmatter = serde_yaml::from_str(yaml)
        .map_err(|e| format!("解析 SKILL.md frontmatter 失败: {e}"))?;
    if frontmatter.name.trim().is_empty() {
        return Err("SKILL.md frontmatter 缺少 name".to_string());
    }
    Ok(ParsedSkill {
        frontmatter,
        // trim_end 去掉 render_skill_md 末尾追加的 `\n`，保证 roundtrip 稳定。
        body: body.trim_end_matches(['\r', '\n']).to_string(),
    })
}

/// 渲染 SKILL.md（frontmatter + 正文）。
pub fn render_skill_md(frontmatter: &SkillFrontmatter, body: &str) -> String {
    let yaml = serde_yaml::to_string(frontmatter).unwrap_or_default();
    format!("---\n{yaml}---\n\n{body}\n")
}

/// 从原始 SKILL.md 文本提取正文（去除 frontmatter）。
pub fn extract_skill_body(raw: &str) -> String {
    if let Some(rest) = raw.strip_prefix("---") {
        if let Some(idx) = rest.find("\n---") {
            let after = &rest[idx + 4..];
            // 与 parse_skill_md 保持一致：trim_start 去前导换行，trim_end 去文件末尾换行。
            return after
                .trim_start_matches(['\r', '\n'])
                .trim_end_matches(['\r', '\n'])
                .to_string();
        }
    }
    raw.to_string()
}

/// 加载单个 Skill 记录（不含正文）。
pub fn load_skill_record(id: &str) -> Result<SkillRecord, String> {
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

/// 列出所有 Skill 记录（按 name 排序）。
pub fn list_all_skill_records() -> Result<Vec<SkillRecord>, String> {
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

/// 写入 Skill（frontmatter + 正文），返回最新记录。
pub fn write_skill(
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

/// 按 name 或 id 加载已启用 Skill 的正文（供 load_skill 工具与系统提示注入）。
///
/// **统一跳过 `enabled: false` 的 skill**，确保 OmniMCP 对外路径和内部 AI 路径行为一致。
/// 匹配顺序：先匹配目录 id，再匹配 frontmatter name。
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

/// 读取启用 Skill 的 (id, name, description) 摘要，供系统提示注入。
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

/// 构建注入系统提示的 Skills 摘要段落。
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

/// 将用户在会话中选中的 Skill 正文注入系统提示（优先遵循）。
pub fn build_selected_skills_bodies_append(ids: &[String]) -> Result<String, String> {
    if ids.is_empty() {
        return Ok(String::new());
    }
    let mut parts: Vec<String> = Vec::new();
    for raw_id in ids {
        let id = raw_id.trim();
        if id.is_empty() {
            continue;
        }
        let Ok(body) = load_skill_body(id) else {
            continue;
        };
        let title = load_skill_record(id)
            .map(|r| format!("{} (id: {})", r.name, r.id))
            .unwrap_or_else(|_| format!("id: {id}"));
        parts.push(format!("### {title}\n{body}"));
    }
    if parts.is_empty() {
        return Ok(String::new());
    }
    let mut out = vec![
        "## Active Skills".to_string(),
        "用户已选择以下 Skill，请优先遵循其指引：".to_string(),
    ];
    out.extend(parts);
    Ok(out.join("\n\n"))
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

    #[test]
    fn extract_body_strips_frontmatter() {
        let raw = "---\nname: x\ndescription: y\n---\n\nBody here\n";
        assert_eq!(extract_skill_body(raw), "Body here");
    }

    #[test]
    fn parse_disabled_skill() {
        let raw = "---\nname: x\ndescription: y\nenabled: false\n---\n\nBody\n";
        let parsed = parse_skill_md(raw).unwrap();
        assert!(!parsed.frontmatter.enabled);
    }

    #[test]
    fn sanitize_rejects_path_traversal() {
        assert!(sanitize_skill_id("../etc/passwd").is_err());
        assert!(sanitize_skill_id("a/b").is_err());
        assert!(sanitize_skill_id("a:b").is_err());
        assert!(sanitize_skill_id("").is_err());
        assert!(sanitize_skill_id("  ").is_err());
        assert!(sanitize_skill_id("valid-id").is_ok());
    }
}
