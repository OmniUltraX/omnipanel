//! 全局标签词表与资源绑定。

use std::collections::{BTreeSet, HashMap, HashSet};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::storage::{map_sqlite, Storage};

/// 可打标资源种类。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaggableKind {
    Connection,
    Knowledge,
    Workflow,
    HttpRequest,
    HttpCollection,
    HttpEnvironment,
    Skill,
    ThirdPartyAccount,
    Task,
}

impl TaggableKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Connection => "connection",
            Self::Knowledge => "knowledge",
            Self::Workflow => "workflow",
            Self::HttpRequest => "http_request",
            Self::HttpCollection => "http_collection",
            Self::HttpEnvironment => "http_environment",
            Self::Skill => "skill",
            Self::ThirdPartyAccount => "third_party_account",
            Self::Task => "task",
        }
    }

    pub fn parse(raw: &str) -> OmniResult<Self> {
        match raw {
            "connection" => Ok(Self::Connection),
            "knowledge" => Ok(Self::Knowledge),
            "workflow" => Ok(Self::Workflow),
            "http_request" => Ok(Self::HttpRequest),
            "http_collection" => Ok(Self::HttpCollection),
            "http_environment" => Ok(Self::HttpEnvironment),
            "skill" => Ok(Self::Skill),
            "third_party_account" => Ok(Self::ThirdPartyAccount),
            "task" => Ok(Self::Task),
            _ => Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知资源类型: {raw}"),
            )),
        }
    }
}

/// 标签来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TagSource {
    User,
    System,
    Ai,
}

impl TagSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::System => "system",
            Self::Ai => "ai",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "system" => Self::System,
            "ai" => Self::Ai,
            _ => Self::User,
        }
    }
}

/// 多选筛选模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type, Default)]
#[serde(rename_all = "snake_case")]
pub enum TagMatchMode {
    #[default]
    And,
    Or,
}

impl TagMatchMode {
    pub fn parse(raw: &str) -> Self {
        match raw {
            "or" | "OR" => Self::Or,
            _ => Self::And,
        }
    }
}

/// 标签节点（扁平，前端组树）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TagDto {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub color: Option<String>,
    pub kind: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
    /// 绑定资源数（可选聚合）
    #[specta(type = f64)]
    pub resource_count: i64,
}

/// 资源上的标签（含 source）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceTagDto {
    pub tag: TagDto,
    pub source: String,
}

/// 按标签查询到的资源摘要。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaggedResourceSummary {
    pub resource_kind: String,
    pub resource_id: String,
    pub title: String,
    pub subtitle: Option<String>,
}

/// 全局搜索命中。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchEverywhereHit {
    pub kind: String,
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    pub score: i32,
}

fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_tag_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(1);
    let t = now_millis();
    let n = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("tag-{t}-{n}")
}

/// 规范化单段标签名（禁止 `/`）。
pub fn normalize_tag_segment(raw: &str) -> Option<String> {
    let mut s = raw.trim().to_string();
    if s.is_empty() {
        return None;
    }
    s = s.trim_start_matches('#').trim().to_string();
    for _ in 0..4 {
        let prev = s.clone();
        if (s.starts_with('"') && s.ends_with('"') && s.len() >= 2)
            || (s.starts_with('\'') && s.ends_with('\'') && s.len() >= 2)
        {
            s = s[1..s.len() - 1].trim().to_string();
        }
        s = s
            .trim_matches(|c: char| {
                c == '[' || c == ']' || c == '"' || c == '\'' || c == ',' || c.is_whitespace()
            })
            .to_string();
        s = s.trim_start_matches('#').trim().to_string();
        if s == prev {
            break;
        }
    }
    s = s.replace('/', "-").trim().to_string();
    if s.is_empty() {
        return None;
    }
    if s.chars()
        .all(|c| matches!(c, '[' | ']' | '{' | '}' | ',' | ':' | '"' | '\''))
    {
        return None;
    }
    if !s
        .chars()
        .any(|c| c.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&c))
    {
        return None;
    }
    Some(s)
}

/// 规范化完整路径（`a/b/c`）。
pub fn normalize_tag_path(raw: &str) -> Option<String> {
    let segments: Vec<String> = raw
        .split('/')
        .filter_map(|seg| normalize_tag_segment(seg))
        .collect();
    if segments.is_empty() {
        return None;
    }
    Some(segments.join("/"))
}

impl Storage {
    /// 启动时：预置 sys 树 + 迁移旧 JSON tags（幂等）。
    pub(crate) fn ensure_global_tags(&self) -> OmniResult<()> {
        self.seed_system_tags()?;
        self.migrate_legacy_tags()?;
        Ok(())
    }

    fn seed_system_tags(&self) -> OmniResult<()> {
        let now = now_millis();
        let roots = [
            ("sys", "system"),
            ("sys/os", "system"),
            ("sys/kernel", "system"),
            ("sys/arch", "system"),
            ("sys/db", "system"),
            ("sys/engine", "system"),
            ("sys/panel", "system"),
            ("sys/skill-case", "system"),
            ("env", "system"),
        ];
        for (path, kind) in roots {
            let _ = self.ensure_tag_path_with_kind(path, kind, now)?;
        }
        Ok(())
    }

    /// 从 knowledge_entries.tags / connections.tags 迁入 links（幂等）。
    fn migrate_legacy_tags(&self) -> OmniResult<()> {
        // knowledge
        let mut stmt = self
            .conn()
            .prepare("SELECT id, tags FROM knowledge_entries")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(map_sqlite)?;
        for row in rows {
            let (id, tags_json) = row.map_err(map_sqlite)?;
            let tags = parse_legacy_tags_json(&tags_json);
            for tag in tags {
                if let Some(path) = normalize_tag_path(&tag) {
                    let tag_id = self.ensure_tag_path_with_kind(&path, "user", now_millis())?;
                    self.link_resource_tag(
                        &tag_id,
                        TaggableKind::Knowledge,
                        &id,
                        TagSource::User,
                    )?;
                }
            }
            self.sync_knowledge_tags_projection(&id)?;
        }

        // connections
        let mut stmt = self
            .conn()
            .prepare("SELECT id, tags FROM connections")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(map_sqlite)?;
        for row in rows {
            let (id, tags_json) = row.map_err(map_sqlite)?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            for tag in tags {
                let (path, source) = legacy_connection_tag_to_path(&tag);
                if let Some(path) = path {
                    let kind = if source == TagSource::System {
                        "system"
                    } else {
                        "user"
                    };
                    let tag_id = self.ensure_tag_path_with_kind(&path, kind, now_millis())?;
                    self.link_resource_tag(
                        &tag_id,
                        TaggableKind::Connection,
                        &id,
                        source,
                    )?;
                }
            }
            self.sync_connection_tags_projection(&id)?;
        }
        Ok(())
    }

    /// 确保路径存在，返回叶子 tag id。
    pub fn ensure_tag_path(&self, path: &str) -> OmniResult<String> {
        let path = normalize_tag_path(path).ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "无效标签路径")
        })?;
        self.ensure_tag_path_with_kind(&path, "user", now_millis())
    }

    fn ensure_tag_path_with_kind(
        &self,
        path: &str,
        kind: &str,
        now: i64,
    ) -> OmniResult<String> {
        if let Some(existing) = self.get_tag_by_path(path)? {
            return Ok(existing.id);
        }
        let segments: Vec<&str> = path.split('/').collect();
        let mut parent_id: Option<String> = None;
        let mut current_path = String::new();
        let mut leaf_id = String::new();
        for seg in segments {
            if !current_path.is_empty() {
                current_path.push('/');
            }
            current_path.push_str(seg);
            if let Some(existing) = self.get_tag_by_path(&current_path)? {
                parent_id = Some(existing.id.clone());
                leaf_id = existing.id;
                continue;
            }
            let id = new_tag_id();
            self.conn()
                .execute(
                    "INSERT INTO tags (id, name, parent_id, path, color, kind, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6, ?7)",
                    rusqlite::params![
                        id,
                        seg,
                        parent_id.as_deref(),
                        current_path,
                        kind,
                        now,
                        now
                    ],
                )
                .map_err(map_sqlite)?;
            parent_id = Some(id.clone());
            leaf_id = id;
        }
        Ok(leaf_id)
    }

    pub fn get_tag_by_path(&self, path: &str) -> OmniResult<Option<TagDto>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, parent_id, path, color, kind, created_at, updated_at
                 FROM tags WHERE path = ?1",
            )
            .map_err(map_sqlite)?;
        let mut rows = stmt
            .query_map([path], |row| self.map_tag_row(row, 0))
            .map_err(map_sqlite)?;
        Ok(rows.next().transpose().map_err(map_sqlite)?)
    }

    pub fn get_tag(&self, id: &str) -> OmniResult<Option<TagDto>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, parent_id, path, color, kind, created_at, updated_at
                 FROM tags WHERE id = ?1",
            )
            .map_err(map_sqlite)?;
        let mut rows = stmt
            .query_map([id], |row| self.map_tag_row(row, 0))
            .map_err(map_sqlite)?;
        Ok(rows.next().transpose().map_err(map_sqlite)?)
    }

    fn map_tag_row(
        &self,
        row: &rusqlite::Row<'_>,
        count: i64,
    ) -> rusqlite::Result<TagDto> {
        let parent_id: Option<String> = row.get(2)?;
        Ok(TagDto {
            id: row.get(0)?,
            name: row.get(1)?,
            parent_id: parent_id.filter(|s| !s.is_empty()),
            path: row.get(3)?,
            color: row.get(4)?,
            kind: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            resource_count: count,
        })
    }

    pub fn tag_list_tree(&self, include_counts: bool) -> OmniResult<Vec<TagDto>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, parent_id, path, color, kind, created_at, updated_at
                 FROM tags ORDER BY path COLLATE NOCASE",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| self.map_tag_row(row, 0))
            .map_err(map_sqlite)?;
        let mut tags = Vec::new();
        for row in rows {
            tags.push(row.map_err(map_sqlite)?);
        }
        if include_counts {
            let mut count_stmt = self
                .conn()
                .prepare(
                    "SELECT tag_id, COUNT(*) FROM resource_tag_links GROUP BY tag_id",
                )
                .map_err(map_sqlite)?;
            let counts: HashMap<String, i64> = count_stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
                .map_err(map_sqlite)?
                .filter_map(|r| r.ok())
                .collect();
            for tag in &mut tags {
                tag.resource_count = counts.get(&tag.id).copied().unwrap_or(0);
            }
        }
        Ok(tags)
    }

    /// 仅返回已绑定到指定资源范围的标签（可选补齐祖先节点便于成树）。
    ///
    /// - `resource_kinds`：限定 `resource_tag_links.resource_kind`
    /// - `connection_kinds`：当 kind=connection 时，再限定 `connections.kind`（如 `ssh`）
    /// - `extra_resource_ids`：额外纳入的 connection 资源 id（如 `local-terminal`）
    pub fn tag_list_used_by(
        &self,
        include_counts: bool,
        resource_kinds: Option<&[TaggableKind]>,
        connection_kinds: Option<&[String]>,
        extra_resource_ids: Option<&[String]>,
        include_ancestors: bool,
    ) -> OmniResult<Vec<TagDto>> {
        let kinds = resource_kinds.unwrap_or(&[]);
        let conn_kinds = connection_kinds.unwrap_or(&[]);
        let extras = extra_resource_ids.unwrap_or(&[]);
        if kinds.is_empty() && conn_kinds.is_empty() && extras.is_empty() {
            return self.tag_list_tree(include_counts);
        }

        let mut direct_ids: HashSet<String> = HashSet::new();
        let mut scope_counts: HashMap<String, i64> = HashMap::new();

        let has_connection_scope = kinds.is_empty()
            || kinds.iter().any(|k| *k == TaggableKind::Connection)
            || !conn_kinds.is_empty()
            || !extras.is_empty();

        if has_connection_scope {
            let mut sql = String::from(
                "SELECT l.tag_id, COUNT(*) FROM resource_tag_links l
                 WHERE l.resource_kind = 'connection' AND (",
            );
            let mut clauses: Vec<String> = Vec::new();
            let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

            if !conn_kinds.is_empty() {
                let placeholders = conn_kinds
                    .iter()
                    .map(|_| "?")
                    .collect::<Vec<_>>()
                    .join(", ");
                clauses.push(format!(
                    "l.resource_id IN (SELECT id FROM connections WHERE kind IN ({placeholders}))"
                ));
                for k in conn_kinds {
                    params.push(Box::new(k.clone()));
                }
            }
            if !extras.is_empty() {
                let placeholders = extras
                    .iter()
                    .map(|_| "?")
                    .collect::<Vec<_>>()
                    .join(", ");
                clauses.push(format!("l.resource_id IN ({placeholders})"));
                for id in extras {
                    params.push(Box::new(id.clone()));
                }
            }
            // 仅指定了 connection kind、未限定 connection_kinds/extras 时：全部 connection
            if clauses.is_empty() && kinds.iter().any(|k| *k == TaggableKind::Connection) {
                clauses.push("1=1".into());
            }
            if clauses.is_empty() {
                // 无 connection 子句则跳过
            } else {
                sql.push_str(&clauses.join(" OR "));
                sql.push_str(") GROUP BY l.tag_id");
                let mut stmt = self.conn().prepare(&sql).map_err(map_sqlite)?;
                let param_refs: Vec<&dyn rusqlite::types::ToSql> =
                    params.iter().map(|p| p.as_ref()).collect();
                let rows = stmt
                    .query_map(param_refs.as_slice(), |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })
                    .map_err(map_sqlite)?;
                for row in rows {
                    let (tag_id, count) = row.map_err(map_sqlite)?;
                    *scope_counts.entry(tag_id.clone()).or_insert(0) += count;
                    direct_ids.insert(tag_id);
                }
            }
        }

        // 非 connection 的 resource_kinds
        let other_kinds: Vec<TaggableKind> = kinds
            .iter()
            .copied()
            .filter(|k| *k != TaggableKind::Connection)
            .collect();
        if !other_kinds.is_empty() {
            let placeholders = other_kinds
                .iter()
                .map(|_| "?")
                .collect::<Vec<_>>()
                .join(", ");
            let sql = format!(
                "SELECT l.tag_id, COUNT(*) FROM resource_tag_links l
                 WHERE l.resource_kind IN ({placeholders})
                 GROUP BY l.tag_id"
            );
            let mut stmt = self.conn().prepare(&sql).map_err(map_sqlite)?;
            let kind_strs: Vec<&str> = other_kinds.iter().map(|k| k.as_str()).collect();
            let params: Vec<&dyn rusqlite::types::ToSql> = kind_strs
                .iter()
                .map(|s| s as &dyn rusqlite::types::ToSql)
                .collect();
            let rows = stmt
                .query_map(params.as_slice(), |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(map_sqlite)?;
            for row in rows {
                let (tag_id, count) = row.map_err(map_sqlite)?;
                *scope_counts.entry(tag_id.clone()).or_insert(0) += count;
                direct_ids.insert(tag_id);
            }
        }

        if direct_ids.is_empty() {
            return Ok(vec![]);
        }

        let all_tags = self.tag_list_tree(false)?;
        let by_id: HashMap<String, TagDto> =
            all_tags.into_iter().map(|t| (t.id.clone(), t)).collect();

        let mut keep: HashSet<String> = direct_ids.clone();
        if include_ancestors {
            for id in &direct_ids {
                let mut cur = by_id.get(id);
                while let Some(tag) = cur {
                    keep.insert(tag.id.clone());
                    cur = tag
                        .parent_id
                        .as_ref()
                        .and_then(|pid| by_id.get(pid));
                }
            }
        }

        let mut out: Vec<TagDto> = keep
            .into_iter()
            .filter_map(|id| by_id.get(&id).cloned())
            .collect();
        out.sort_by(|a, b| a.path.to_lowercase().cmp(&b.path.to_lowercase()));

        if include_counts {
            for tag in &mut out {
                tag.resource_count = scope_counts.get(&tag.id).copied().unwrap_or(0);
            }
        }
        Ok(out)
    }

    pub fn tag_create(
        &self,
        name: &str,
        parent_id: Option<&str>,
        color: Option<&str>,
    ) -> OmniResult<TagDto> {
        let name = normalize_tag_segment(name).ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "无效标签名")
        })?;
        let parent_path = if let Some(pid) = parent_id {
            let parent = self
                .get_tag(pid)?
                .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "父标签不存在"))?;
            if parent.kind == "system" && parent.path == "sys"
                || parent.path.starts_with("sys/")
            {
                // 允许在 sys 下由系统创建；用户一般不该在此建
            }
            Some(parent.path)
        } else {
            None
        };
        let path = match parent_path {
            Some(p) => format!("{p}/{name}"),
            None => name.clone(),
        };
        if self.get_tag_by_path(&path)?.is_some() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "标签路径已存在"));
        }
        let now = now_millis();
        let id = new_tag_id();
        self.conn()
            .execute(
                "INSERT INTO tags (id, name, parent_id, path, color, kind, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 'user', ?6, ?7)",
                rusqlite::params![id, name, parent_id, path, color, now, now],
            )
            .map_err(map_sqlite)?;
        self.get_tag(&id)?
            .ok_or_else(|| OmniError::new(ErrorCode::Internal, "创建标签后读取失败"))
    }

    pub fn tag_rename(&self, id: &str, name: &str) -> OmniResult<TagDto> {
        let tag = self
            .get_tag(id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "标签不存在"))?;
        if tag.kind == "system" {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "系统标签不可重命名",
            ));
        }
        let name = normalize_tag_segment(name).ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "无效标签名")
        })?;
        let old_path = tag.path.clone();
        let parent_path = old_path
            .rsplit_once('/')
            .map(|(p, _)| p.to_string());
        let new_path = match parent_path {
            Some(p) => format!("{p}/{name}"),
            None => name.clone(),
        };
        if new_path != old_path {
            if self.get_tag_by_path(&new_path)?.is_some() {
                return Err(OmniError::new(ErrorCode::InvalidInput, "标签路径已存在"));
            }
            self.repath_subtree(&old_path, &new_path)?;
            self.sync_all_projections_for_tag_paths()?;
        } else {
            let now = now_millis();
            self.conn()
                .execute(
                    "UPDATE tags SET name = ?1, updated_at = ?2 WHERE id = ?3",
                    rusqlite::params![name, now, id],
                )
                .map_err(map_sqlite)?;
        }
        self.get_tag(id)?
            .ok_or_else(|| OmniError::new(ErrorCode::Internal, "重命名后读取失败"))
    }

    fn repath_subtree(&self, old_prefix: &str, new_prefix: &str) -> OmniResult<()> {
        let now = now_millis();
        let mut stmt = self
            .conn()
            .prepare("SELECT id, path FROM tags WHERE path = ?1 OR path LIKE ?2")
            .map_err(map_sqlite)?;
        let like = format!("{old_prefix}/%");
        let rows: Vec<(String, String)> = stmt
            .query_map(rusqlite::params![old_prefix, like], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .map_err(map_sqlite)?
            .filter_map(|r| r.ok())
            .collect();
        for (id, path) in rows {
            let new_path = if path == old_prefix {
                new_prefix.to_string()
            } else {
                format!("{new_prefix}{}", &path[old_prefix.len()..])
            };
            let name = new_path
                .rsplit_once('/')
                .map(|(_, n)| n.to_string())
                .unwrap_or_else(|| new_path.clone());
            self.conn()
                .execute(
                    "UPDATE tags SET path = ?1, name = ?2, updated_at = ?3 WHERE id = ?4",
                    rusqlite::params![new_path, name, now, id],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    pub fn tag_move(&self, id: &str, new_parent_id: Option<&str>) -> OmniResult<TagDto> {
        let tag = self
            .get_tag(id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "标签不存在"))?;
        if tag.kind == "system" {
            return Err(OmniError::new(ErrorCode::InvalidInput, "系统标签不可移动"));
        }
        let old_path = tag.path.clone();
        let new_parent_path = if let Some(pid) = new_parent_id {
            if pid == id {
                return Err(OmniError::new(ErrorCode::InvalidInput, "不能移动到自身"));
            }
            let parent = self
                .get_tag(pid)?
                .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "父标签不存在"))?;
            if parent.path == old_path || parent.path.starts_with(&format!("{old_path}/")) {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    "不能移动到自己的子孙",
                ));
            }
            Some(parent.path)
        } else {
            None
        };
        let new_path = match new_parent_path {
            Some(p) => format!("{p}/{}", tag.name),
            None => tag.name.clone(),
        };
        if new_path != old_path {
            if self.get_tag_by_path(&new_path)?.is_some() {
                return Err(OmniError::new(ErrorCode::InvalidInput, "目标路径已存在"));
            }
            self.conn()
                .execute(
                    "UPDATE tags SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
                    rusqlite::params![new_parent_id, now_millis(), id],
                )
                .map_err(map_sqlite)?;
            self.repath_subtree(&old_path, &new_path)?;
            self.sync_all_projections_for_tag_paths()?;
        }
        self.get_tag(id)?
            .ok_or_else(|| OmniError::new(ErrorCode::Internal, "移动后读取失败"))
    }

    pub fn tag_delete(&self, id: &str, cascade: bool) -> OmniResult<()> {
        let tag = self
            .get_tag(id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "标签不存在"))?;
        if tag.kind == "system" {
            return Err(OmniError::new(ErrorCode::InvalidInput, "系统标签不可删除"));
        }
        let child_count: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM tags WHERE parent_id = ?1",
                [id],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        if child_count > 0 && !cascade {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "标签下仍有子标签，请先删除子标签或使用级联删除",
            ));
        }
        if cascade {
            let like = format!("{}/{}", tag.path, "%");
            self.conn()
                .execute(
                    "DELETE FROM tags WHERE path = ?1 OR path LIKE ?2",
                    rusqlite::params![tag.path, like],
                )
                .map_err(map_sqlite)?;
        } else {
            self.conn()
                .execute("DELETE FROM tags WHERE id = ?1", [id])
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    pub fn tag_set_color(&self, id: &str, color: Option<&str>) -> OmniResult<TagDto> {
        let _ = self
            .get_tag(id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "标签不存在"))?;
        self.conn()
            .execute(
                "UPDATE tags SET color = ?1, updated_at = ?2 WHERE id = ?3",
                rusqlite::params![color, now_millis(), id],
            )
            .map_err(map_sqlite)?;
        self.get_tag(id)?
            .ok_or_else(|| OmniError::new(ErrorCode::Internal, "设置颜色后读取失败"))
    }

    pub fn link_resource_tag(
        &self,
        tag_id: &str,
        kind: TaggableKind,
        resource_id: &str,
        source: TagSource,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO resource_tag_links (tag_id, resource_kind, resource_id, source, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(tag_id, resource_kind, resource_id) DO UPDATE SET source = excluded.source",
                rusqlite::params![
                    tag_id,
                    kind.as_str(),
                    resource_id,
                    source.as_str(),
                    now_millis()
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn resource_list_tags(
        &self,
        kind: TaggableKind,
        resource_id: &str,
    ) -> OmniResult<Vec<ResourceTagDto>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT t.id, t.name, t.parent_id, t.path, t.color, t.kind, t.created_at, t.updated_at, l.source
                 FROM resource_tag_links l
                 JOIN tags t ON t.id = l.tag_id
                 WHERE l.resource_kind = ?1 AND l.resource_id = ?2
                 ORDER BY t.path COLLATE NOCASE",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map(rusqlite::params![kind.as_str(), resource_id], |row| {
                let tag = TagDto {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_id: row
                        .get::<_, Option<String>>(2)?
                        .filter(|s| !s.is_empty()),
                    path: row.get(3)?,
                    color: row.get(4)?,
                    kind: row.get(5)?,
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                    resource_count: 0,
                };
                let source: String = row.get(8)?;
                Ok(ResourceTagDto { tag, source })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 返回用户标签 path 列表（兼容旧 API）。
    pub fn resource_tag_paths(
        &self,
        kind: TaggableKind,
        resource_id: &str,
    ) -> OmniResult<Vec<String>> {
        Ok(self
            .resource_list_tags(kind, resource_id)?
            .into_iter()
            .map(|t| t.tag.path)
            .collect())
    }

    /// 全量替换用户标签（保留 system 绑定）。
    pub fn resource_set_user_tags(
        &self,
        kind: TaggableKind,
        resource_id: &str,
        paths: &[String],
    ) -> OmniResult<Vec<ResourceTagDto>> {
        // 删除用户/ai 绑定
        self.conn()
            .execute(
                "DELETE FROM resource_tag_links
                 WHERE resource_kind = ?1 AND resource_id = ?2 AND source IN ('user', 'ai')",
                rusqlite::params![kind.as_str(), resource_id],
            )
            .map_err(map_sqlite)?;
        let mut seen = HashSet::new();
        for path in paths {
            let Some(path) = normalize_tag_path(path) else {
                continue;
            };
            if !seen.insert(path.clone()) {
                continue;
            }
            let tag_id = self.ensure_tag_path(&path)?;
            self.link_resource_tag(&tag_id, kind, resource_id, TagSource::User)?;
        }
        self.sync_resource_projection(kind, resource_id)?;
        self.resource_list_tags(kind, resource_id)
    }

    pub fn resource_add_tag(
        &self,
        kind: TaggableKind,
        resource_id: &str,
        path: &str,
        source: TagSource,
    ) -> OmniResult<Vec<ResourceTagDto>> {
        let path = normalize_tag_path(path)
            .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "无效标签路径"))?;
        let tag_kind = if source == TagSource::System {
            "system"
        } else {
            "user"
        };
        let tag_id = self.ensure_tag_path_with_kind(&path, tag_kind, now_millis())?;
        self.link_resource_tag(&tag_id, kind, resource_id, source)?;
        self.sync_resource_projection(kind, resource_id)?;
        self.resource_list_tags(kind, resource_id)
    }

    pub fn resource_remove_tag(
        &self,
        kind: TaggableKind,
        resource_id: &str,
        tag_id: &str,
    ) -> OmniResult<Vec<ResourceTagDto>> {
        self.conn()
            .execute(
                "DELETE FROM resource_tag_links
                 WHERE resource_kind = ?1 AND resource_id = ?2 AND tag_id = ?3",
                rusqlite::params![kind.as_str(), resource_id, tag_id],
            )
            .map_err(map_sqlite)?;
        self.sync_resource_projection(kind, resource_id)?;
        self.resource_list_tags(kind, resource_id)
    }

    /// 系统键写入，如 os → sys/os/{value}
    pub fn resource_set_system_key(
        &self,
        kind: TaggableKind,
        resource_id: &str,
        key: &str,
        value: &str,
    ) -> OmniResult<()> {
        let value = value.trim();
        let key = key.trim();
        if key.is_empty() {
            return Ok(());
        }
        // 移除同 key 下旧 system 标签
        let prefix = format!("sys/{key}/");
        let existing = self.resource_list_tags(kind, resource_id)?;
        for rt in existing {
            if rt.source == "system" && rt.tag.path.starts_with(&prefix) {
                let _ = self.resource_remove_tag(kind, resource_id, &rt.tag.id);
            }
        }
        if value.is_empty() {
            self.sync_resource_projection(kind, resource_id)?;
            return Ok(());
        }
        let path = format!("sys/{key}/{value}");
        let _ = self.resource_add_tag(kind, resource_id, &path, TagSource::System)?;
        Ok(())
    }

    pub fn clear_resource_tags(&self, kind: TaggableKind, resource_id: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM resource_tag_links WHERE resource_kind = ?1 AND resource_id = ?2",
                rusqlite::params![kind.as_str(), resource_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 展开 tag_ids（含子孙），再按 AND/OR 查资源。
    pub fn tag_query_resources(
        &self,
        tag_ids: &[String],
        mode: TagMatchMode,
        kinds: Option<&[TaggableKind]>,
        include_descendants: bool,
    ) -> OmniResult<Vec<TaggedResourceSummary>> {
        if tag_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut expanded: Vec<HashSet<String>> = Vec::new();
        for tid in tag_ids {
            let tag = self
                .get_tag(tid)?
                .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "标签不存在"))?;
            let mut set = HashSet::new();
            set.insert(tag.id.clone());
            if include_descendants {
                let like = format!("{}/{}", tag.path, "%");
                let mut stmt = self
                    .conn()
                    .prepare("SELECT id FROM tags WHERE path LIKE ?1")
                    .map_err(map_sqlite)?;
                let rows = stmt
                    .query_map([&like], |row| row.get::<_, String>(0))
                    .map_err(map_sqlite)?;
                for row in rows {
                    set.insert(row.map_err(map_sqlite)?);
                }
            }
            expanded.push(set);
        }

        // 收集所有候选 tag ids
        let all_tag_ids: HashSet<&String> = expanded.iter().flatten().collect();
        if all_tag_ids.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders: String = all_tag_ids
            .iter()
            .enumerate()
            .map(|(i, _)| format!("?{}", i + 1))
            .collect::<Vec<_>>()
            .join(",");
        let mut sql = format!(
            "SELECT resource_kind, resource_id, tag_id FROM resource_tag_links WHERE tag_id IN ({placeholders})"
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = all_tag_ids
            .iter()
            .map(|id| Box::new((*id).clone()) as Box<dyn rusqlite::types::ToSql>)
            .collect();

        if let Some(kinds) = kinds {
            if !kinds.is_empty() {
                let base = params.len();
                let kind_ph: String = kinds
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", base + i + 1))
                    .collect::<Vec<_>>()
                    .join(",");
                sql.push_str(&format!(" AND resource_kind IN ({kind_ph})"));
                for k in kinds {
                    params.push(Box::new(k.as_str().to_string()));
                }
            }
        }

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let mut stmt = self.conn().prepare(&sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(map_sqlite)?;

        // resource -> set of tag_ids
        let mut resource_tags: HashMap<(String, String), HashSet<String>> = HashMap::new();
        for row in rows {
            let (rk, rid, tid) = row.map_err(map_sqlite)?;
            resource_tags
                .entry((rk, rid))
                .or_default()
                .insert(tid);
        }

        let mut matched: Vec<(String, String)> = Vec::new();
        for ((rk, rid), tags) in &resource_tags {
            let ok = match mode {
                TagMatchMode::And => expanded.iter().all(|group| group.iter().any(|t| tags.contains(t))),
                TagMatchMode::Or => expanded.iter().any(|group| group.iter().any(|t| tags.contains(t))),
            };
            if ok {
                matched.push((rk.clone(), rid.clone()));
            }
        }

        let mut out = Vec::new();
        for (rk, rid) in matched {
            if let Some(summary) = self.resolve_resource_summary(&rk, &rid)? {
                out.push(summary);
            }
        }
        out.sort_by(|a, b| {
            a.resource_kind
                .cmp(&b.resource_kind)
                .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
        });
        Ok(out)
    }

    fn resolve_resource_summary(
        &self,
        kind: &str,
        id: &str,
    ) -> OmniResult<Option<TaggedResourceSummary>> {
        let summary = match kind {
            "knowledge" => self.conn().query_row(
                "SELECT title FROM knowledge_entries WHERE id = ?1",
                [id],
                |row| {
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: row.get(0)?,
                        subtitle: None,
                    })
                },
            ),
            "connection" => self.conn().query_row(
                "SELECT name, kind FROM connections WHERE id = ?1",
                [id],
                |row| {
                    let name: String = row.get(0)?;
                    let ck: String = row.get(1)?;
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: name,
                        subtitle: Some(ck),
                    })
                },
            ),
            "workflow" => self.conn().query_row(
                "SELECT name FROM workflows WHERE id = ?1",
                [id],
                |row| {
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: row.get(0)?,
                        subtitle: None,
                    })
                },
            ),
            "http_request" => self.conn().query_row(
                "SELECT name, method FROM http_requests WHERE id = ?1",
                [id],
                |row| {
                    let name: String = row.get(0)?;
                    let method: String = row.get(1)?;
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: name,
                        subtitle: Some(method),
                    })
                },
            ),
            "http_collection" => self.conn().query_row(
                "SELECT name FROM http_collections WHERE id = ?1",
                [id],
                |row| {
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: row.get(0)?,
                        subtitle: None,
                    })
                },
            ),
            "http_environment" => self.conn().query_row(
                "SELECT name FROM http_environments WHERE id = ?1",
                [id],
                |row| {
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: row.get(0)?,
                        subtitle: None,
                    })
                },
            ),
            "skill" => self.conn().query_row(
                "SELECT name FROM skills WHERE id = ?1",
                [id],
                |row| {
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: row.get(0)?,
                        subtitle: None,
                    })
                },
            ),
            "third_party_account" => self.conn().query_row(
                "SELECT name FROM third_party_accounts WHERE id = ?1",
                [id],
                |row| {
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: row.get(0)?,
                        subtitle: None,
                    })
                },
            ),
            "task" => self.conn().query_row(
                "SELECT title FROM tasks WHERE id = ?1",
                [id],
                |row| {
                    Ok(TaggedResourceSummary {
                        resource_kind: kind.to_string(),
                        resource_id: id.to_string(),
                        title: row.get(0)?,
                        subtitle: None,
                    })
                },
            ),
            _ => return Ok(None),
        };
        match summary {
            Ok(s) => Ok(Some(s)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(map_sqlite(e)),
        }
    }

    pub fn tag_suggest(&self, query: &str, limit: i64) -> OmniResult<Vec<TagDto>> {
        let q = query.trim();
        let limit = limit.clamp(1, 50);
        if q.is_empty() {
            return Ok(self
                .tag_list_tree(false)?
                .into_iter()
                .take(limit as usize)
                .collect());
        }
        let pattern = format!("%{}%", q.replace('%', "").replace('_', ""));
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, parent_id, path, color, kind, created_at, updated_at
                 FROM tags
                 WHERE path LIKE ?1 OR name LIKE ?1
                 ORDER BY path COLLATE NOCASE
                 LIMIT ?2",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map(rusqlite::params![pattern, limit], |row| {
                self.map_tag_row(row, 0)
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    pub fn search_everywhere(
        &self,
        query: &str,
        tag_ids: &[String],
        mode: TagMatchMode,
        limit: i64,
    ) -> OmniResult<Vec<SearchEverywhereHit>> {
        let limit = limit.clamp(1, 100) as usize;
        let q = query.trim().to_lowercase();
        let mut hits: Vec<SearchEverywhereHit> = Vec::new();

        let tag_filter: Option<HashSet<(String, String)>> = if tag_ids.is_empty() {
            None
        } else {
            let resources = self.tag_query_resources(tag_ids, mode, None, true)?;
            Some(
                resources
                    .into_iter()
                    .map(|r| (r.resource_kind, r.resource_id))
                    .collect(),
            )
        };

        let allow = |kind: &str, id: &str| -> bool {
            match &tag_filter {
                None => true,
                Some(set) => set.contains(&(kind.to_string(), id.to_string())),
            }
        };

        // knowledge
        if let Ok(entries) = self.list_knowledge(None, None) {
            for e in entries {
                if !allow("knowledge", &e.id) {
                    continue;
                }
                if q.is_empty() && tag_filter.is_some() {
                    hits.push(SearchEverywhereHit {
                        kind: "knowledge".into(),
                        id: e.id,
                        title: e.title,
                        subtitle: Some("knowledge".into()),
                        score: 10,
                    });
                    continue;
                }
                if !q.is_empty() {
                    let title_l = e.title.to_lowercase();
                    let mut score = 0;
                    if title_l.contains(&q) {
                        score += 20;
                    }
                    if e.tags.iter().any(|t| t.to_lowercase().contains(&q)) {
                        score += 10;
                    }
                    if score > 0 {
                        hits.push(SearchEverywhereHit {
                            kind: "knowledge".into(),
                            id: e.id,
                            title: e.title,
                            subtitle: Some("knowledge".into()),
                            score,
                        });
                    }
                }
            }
        }

        // connections
        if let Ok(conns) = self.list_connections() {
            for c in conns {
                if !allow("connection", &c.id) {
                    continue;
                }
                if q.is_empty() && tag_filter.is_some() {
                    hits.push(SearchEverywhereHit {
                        kind: "connection".into(),
                        id: c.id,
                        title: c.name,
                        subtitle: Some(c.kind.as_str().to_string()),
                        score: 10,
                    });
                    continue;
                }
                if !q.is_empty() {
                    let name_l = c.name.to_lowercase();
                    let mut score = 0;
                    if name_l.contains(&q) {
                        score += 20;
                    }
                    if c.tags.iter().any(|t| t.to_lowercase().contains(&q)) {
                        score += 8;
                    }
                    if score > 0 {
                        hits.push(SearchEverywhereHit {
                            kind: "connection".into(),
                            id: c.id,
                            title: c.name,
                            subtitle: Some(c.kind.as_str().to_string()),
                            score,
                        });
                    }
                }
            }
        }

        // workflows
        if let Ok(wfs) = self.workflow_list() {
            for w in wfs {
                if !allow("workflow", &w.id) {
                    continue;
                }
                if q.is_empty() && tag_filter.is_some() {
                    hits.push(SearchEverywhereHit {
                        kind: "workflow".into(),
                        id: w.id,
                        title: w.name,
                        subtitle: Some("workflow".into()),
                        score: 8,
                    });
                    continue;
                }
                if !q.is_empty() && w.name.to_lowercase().contains(&q) {
                    hits.push(SearchEverywhereHit {
                        kind: "workflow".into(),
                        id: w.id,
                        title: w.name,
                        subtitle: Some("workflow".into()),
                        score: 15,
                    });
                }
            }
        }

        // tags themselves
        if !q.is_empty() || q.starts_with('#') {
            let tq = q.trim_start_matches('#');
            if let Ok(tags) = self.tag_suggest(tq, 20) {
                for t in tags {
                    hits.push(SearchEverywhereHit {
                        kind: "tag".into(),
                        id: t.id,
                        title: t.path,
                        subtitle: Some("tag".into()),
                        score: 5,
                    });
                }
            }
        }

        hits.sort_by(|a, b| b.score.cmp(&a.score).then(a.title.cmp(&b.title)));
        hits.truncate(limit);
        Ok(hits)
    }

    fn sync_resource_projection(
        &self,
        kind: TaggableKind,
        resource_id: &str,
    ) -> OmniResult<()> {
        match kind {
            TaggableKind::Knowledge => self.sync_knowledge_tags_projection(resource_id),
            TaggableKind::Connection => self.sync_connection_tags_projection(resource_id),
            _ => Ok(()),
        }
    }

    pub(crate) fn sync_knowledge_tags_projection(&self, entry_id: &str) -> OmniResult<()> {
        let paths = self.resource_tag_paths(TaggableKind::Knowledge, entry_id)?;
        let tags_json = serde_json::to_string(&paths).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "tags 序列化失败").with_cause(e.to_string())
        })?;
        // 空格分隔 path 利于 FTS；同时保留 JSON 数组形态给旧解析
        let fts_tags = paths.join(" ");
        let combined = if fts_tags.is_empty() {
            tags_json
        } else {
            // 存 JSON 数组；FTS 触发器读 tags 列，数组内 path 空格可被 MATCH 部分命中
            tags_json
        };
        self.conn()
            .execute(
                "UPDATE knowledge_entries SET tags = ?1 WHERE id = ?2",
                rusqlite::params![combined, entry_id],
            )
            .map_err(map_sqlite)?;
        let _ = fts_tags;
        Ok(())
    }

    pub(crate) fn sync_connection_tags_projection(&self, conn_id: &str) -> OmniResult<()> {
        let tags = self.resource_list_tags(TaggableKind::Connection, conn_id)?;
        let mut projected: Vec<String> = Vec::new();
        for rt in tags {
            if rt.source == "system" && rt.tag.path.starts_with("sys/") {
                // sys/os/Linux → os:Linux
                let rest = &rt.tag.path[4..];
                if let Some((key, value)) = rest.split_once('/') {
                    projected.push(format!("{key}:{value}"));
                    continue;
                }
            }
            projected.push(rt.tag.path);
        }
        let tags_json = serde_json::to_string(&projected).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "tags 序列化失败").with_cause(e.to_string())
        })?;
        self.conn()
            .execute(
                "UPDATE connections SET tags = ?1 WHERE id = ?2",
                rusqlite::params![tags_json, conn_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    fn sync_all_projections_for_tag_paths(&self) -> OmniResult<()> {
        let mut stmt = self
            .conn()
            .prepare("SELECT DISTINCT resource_kind, resource_id FROM resource_tag_links")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(map_sqlite)?;
        for row in rows {
            let (rk, rid) = row.map_err(map_sqlite)?;
            if let Ok(kind) = TaggableKind::parse(&rk) {
                self.sync_resource_projection(kind, &rid)?;
            }
        }
        Ok(())
    }
}

fn parse_legacy_tags_json(tags_json: &str) -> Vec<String> {
    let mut out = Vec::new();
    let trimmed = tags_json.trim();
    if trimmed.is_empty() || trimmed == "[]" || trimmed == "null" {
        return out;
    }
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(trimmed) {
        for tag in tags {
            expand_legacy_tag(&tag, &mut out);
        }
        return dedupe_legacy(out);
    }
    if let Ok(inner) = serde_json::from_str::<String>(trimmed) {
        return parse_legacy_tags_json(&inner);
    }
    expand_legacy_tag(trimmed, &mut out);
    dedupe_legacy(out)
}

fn expand_legacy_tag(raw: &str, out: &mut Vec<String>) {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return;
    }
    if trimmed.starts_with('[') {
        if let Ok(nested) = serde_json::from_str::<Vec<String>>(trimmed) {
            for item in nested {
                expand_legacy_tag(&item, out);
            }
            return;
        }
    }
    if let Some(tag) = normalize_tag_path(trimmed) {
        out.push(tag);
    } else if let Some(seg) = normalize_tag_segment(trimmed) {
        out.push(seg);
    }
}

fn dedupe_legacy(tags: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut out = Vec::new();
    for tag in tags {
        let key = tag.to_lowercase();
        if seen.insert(key) {
            out.push(tag);
        }
    }
    out
}

fn legacy_connection_tag_to_path(tag: &str) -> (Option<String>, TagSource) {
    let tag = tag.trim();
    if tag.is_empty() {
        return (None, TagSource::User);
    }
    if let Some((key, value)) = tag.split_once(':') {
        let key = key.trim();
        let value = value.trim();
        if !key.is_empty() && !value.is_empty() {
            let system_keys = ["os", "kernel", "arch", "db", "engine", "panel"];
            if system_keys.contains(&key) {
                if let Some(path) = normalize_tag_path(&format!("sys/{key}/{value}")) {
                    return (Some(path), TagSource::System);
                }
            }
        }
    }
    (
        normalize_tag_path(tag).or_else(|| normalize_tag_segment(tag)),
        TagSource::User,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrate_and_query_tags() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .conn()
            .execute(
                "INSERT INTO knowledge_entries (id, kind, title, content, tags, risk_level, source, env_tag, language, usage_count, created_at, updated_at, parent_id, node_type, sort_order, resource_type, resource_id)
                 VALUES ('k1', 'note', 'Doc', 'body', '[\"项目/前端\", \"#教育\"]', 'low', 'user', 'dev', 'zh', 0, 1, 1, '', 'document', 0, '', '')",
                [],
            )
            .unwrap();
        storage
            .conn()
            .execute(
                "INSERT INTO connections (id, kind, name, group_name, env_tag, tags, config, credential_ref, created_at, updated_at)
                 VALUES ('c1', 'ssh', 'Host', '', 'dev', '[\"os:Linux\", \"prod\"]', '{}', '', 1, 1)",
                [],
            )
            .unwrap();

        storage.ensure_global_tags().unwrap();

        let k_tags = storage
            .resource_list_tags(TaggableKind::Knowledge, "k1")
            .unwrap();
        assert!(k_tags.iter().any(|t| t.tag.path == "项目/前端"));
        assert!(k_tags.iter().any(|t| t.tag.path == "教育"));

        let c_tags = storage
            .resource_list_tags(TaggableKind::Connection, "c1")
            .unwrap();
        assert!(c_tags.iter().any(|t| t.tag.path.starts_with("sys/os/")));
        assert!(c_tags.iter().any(|t| t.tag.path == "prod"));

        let tree = storage.tag_list_tree(true).unwrap();
        assert!(tree.iter().any(|t| t.path == "sys"));

        let frontend = storage
            .tag_create("React", Some(&tree.iter().find(|t| t.path == "项目/前端").unwrap().id), None)
            .unwrap();
        assert_eq!(frontend.path, "项目/前端/React");

        storage
            .resource_add_tag(
                TaggableKind::Knowledge,
                "k1",
                "项目/前端/React",
                TagSource::User,
            )
            .unwrap();

        let ids: Vec<String> = tree
            .iter()
            .filter(|t| t.path == "项目/前端")
            .map(|t| t.id.clone())
            .collect();
        let found = storage
            .tag_query_resources(&ids, TagMatchMode::And, Some(&[TaggableKind::Knowledge]), true)
            .unwrap();
        assert!(found.iter().any(|r| r.resource_id == "k1"));

        storage.clear_resource_tags(TaggableKind::Connection, "c1").unwrap();
        assert!(storage
            .resource_list_tags(TaggableKind::Connection, "c1")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn and_or_modes() {
        let storage = Storage::open_in_memory().unwrap();
        storage.ensure_global_tags().unwrap();
        let a = storage.ensure_tag_path("A").unwrap();
        let b = storage.ensure_tag_path("B").unwrap();
        storage
            .conn()
            .execute(
                "INSERT INTO knowledge_entries (id, kind, title, content, tags, risk_level, source, env_tag, language, usage_count, created_at, updated_at, parent_id, node_type, sort_order, resource_type, resource_id)
                 VALUES ('k1', 'note', 'One', '', '[]', 'low', 'user', 'dev', 'zh', 0, 1, 1, '', 'document', 0, '', ''),
                        ('k2', 'note', 'Two', '', '[]', 'low', 'user', 'dev', 'zh', 0, 1, 1, '', 'document', 0, '', '')",
                [],
            )
            .unwrap();
        storage
            .link_resource_tag(&a, TaggableKind::Knowledge, "k1", TagSource::User)
            .unwrap();
        storage
            .link_resource_tag(&b, TaggableKind::Knowledge, "k1", TagSource::User)
            .unwrap();
        storage
            .link_resource_tag(&a, TaggableKind::Knowledge, "k2", TagSource::User)
            .unwrap();

        let and_hits = storage
            .tag_query_resources(
                &[a.clone(), b.clone()],
                TagMatchMode::And,
                Some(&[TaggableKind::Knowledge]),
                false,
            )
            .unwrap();
        assert_eq!(and_hits.len(), 1);
        assert_eq!(and_hits[0].resource_id, "k1");

        let or_hits = storage
            .tag_query_resources(
                &[a, b],
                TagMatchMode::Or,
                Some(&[TaggableKind::Knowledge]),
                false,
            )
            .unwrap();
        assert_eq!(or_hits.len(), 2);
    }
}
