use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, map_sqlite};

/// 知识条目模型。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEntry {
    pub id: String,
    /// "snippet" | "case" | "ai"
    pub kind: String,
    pub title: String,
    /// Markdown 正文
    pub content: String,
    pub tags: Vec<String>,
    /// "safe" | "readonly" | "medium" | "dangerous"
    pub risk_level: String,
    pub source: String,
    /// "dev" | "staging" | "production"
    pub env_tag: String,
    /// 代码语言（snippet 时有意义）
    pub language: String,
    #[specta(type = f64)]
    pub usage_count: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub created_at: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub updated_at: i64,
    /// 父节点 id，空字符串表示根级
    #[serde(default)]
    pub parent_id: String,
    /// "folder" | "document"
    #[serde(default = "default_node_type")]
    pub node_type: String,
    #[serde(default)]
    #[specta(type = f64)]
    pub sort_order: i64,
    /// 关联资源类型："" / "ssh" / "database" / "docker" / "files"（v23 引入）
    #[serde(default)]
    pub resource_type: String,
    /// 关联资源 id（与 resource_type 配对使用，空字符串表示不关联）
    #[serde(default)]
    pub resource_id: String,
}

fn default_node_type() -> String {
    "document".to_string()
}

/// FTS5 搜索结果：原文 + snippet 摘要。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeSearchResult {
    pub entry: KnowledgeEntry,
    pub snippet: String,
    /// 关键词相关性评分（0-100），分数越高越相关。
    #[specta(type = f64)]
    pub score: i64,
}

/// 知识文档历史版本快照。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRevision {
    pub id: String,
    pub entry_id: String,
    pub title: String,
    pub content: String,
    #[specta(type = f64)]
    pub created_at: i64,
}

const KNOWLEDGE_REVISION_LIMIT: i64 = 50;

impl Storage {
    /// 列出知识条目（可选按 kind / tag 过滤，按更新时间倒序）。
    pub fn list_knowledge(
        &self,
        kind: Option<&str>,
        tag: Option<&str>,
    ) -> OmniResult<Vec<KnowledgeEntry>> {
        let mut sql = String::from(
            "SELECT id, kind, title, content, tags, risk_level, source, env_tag, language, usage_count, created_at, updated_at, parent_id, node_type, sort_order, resource_type, resource_id
             FROM knowledge_entries WHERE 1=1",
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
        if let Some(k) = kind {
            sql.push_str(" AND kind = ?");
            params.push(Box::new(k.to_string()));
        }
        if let Some(t) = tag {
            sql.push_str(
                " AND id IN (
                    SELECT l.resource_id FROM resource_tag_links l
                    JOIN tags tg ON tg.id = l.tag_id
                    WHERE l.resource_kind = 'knowledge'
                      AND (tg.path = ? OR tg.path LIKE ?)
                )",
            );
            let path = t.trim().trim_start_matches('#').to_string();
            params.push(Box::new(path.clone()));
            params.push(Box::new(format!("{path}/%")));
        }
        sql.push_str(" ORDER BY sort_order ASC, updated_at DESC");

        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        self.query_knowledge(&sql, param_refs.as_slice())
    }

    /// 按 id 获取单条。
    pub fn get_knowledge(&self, id: &str) -> OmniResult<Option<KnowledgeEntry>> {
        Ok(self
            .query_knowledge(
                "SELECT id, kind, title, content, tags, risk_level, source, env_tag, language, usage_count, created_at, updated_at, parent_id, node_type, sort_order, resource_type, resource_id
                 FROM knowledge_entries WHERE id = ?1",
                [id],
            )?
            .into_iter()
            .next())
    }

    /// 插入或更新（按 id upsert）。内容或标题变化时写入历史版本。
    /// tags 字段写入全局 resource_tag_links，并投影回 JSON 供 FTS。
    pub fn save_knowledge(&self, entry: &KnowledgeEntry) -> OmniResult<()> {
        if let Ok(Some(prev)) = self.get_knowledge(&entry.id) {
            if prev.content != entry.content || prev.title != entry.title {
                let _ = self.push_knowledge_revision(&prev);
            }
        }

        let tags_json = serde_json::to_string(&entry.tags).unwrap_or_else(|_| "[]".into());
        self.conn()
            .execute(
                "INSERT INTO knowledge_entries (id, kind, title, content, tags, risk_level, source, env_tag, language, usage_count, created_at, updated_at, parent_id, node_type, sort_order, resource_type, resource_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
                 ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    title = excluded.title,
                    content = excluded.content,
                    tags = excluded.tags,
                    risk_level = excluded.risk_level,
                    source = excluded.source,
                    env_tag = excluded.env_tag,
                    language = excluded.language,
                    usage_count = excluded.usage_count,
                    updated_at = excluded.updated_at,
                    parent_id = excluded.parent_id,
                    node_type = excluded.node_type,
                    sort_order = excluded.sort_order,
                    resource_type = excluded.resource_type,
                    resource_id = excluded.resource_id",
                rusqlite::params![
                    entry.id,
                    entry.kind,
                    entry.title,
                    entry.content,
                    tags_json,
                    entry.risk_level,
                    entry.source,
                    entry.env_tag,
                    entry.language,
                    entry.usage_count,
                    entry.created_at,
                    entry.updated_at,
                    entry.parent_id,
                    entry.node_type,
                    entry.sort_order,
                    entry.resource_type,
                    entry.resource_id,
                ],
            )
            .map_err(map_sqlite)?;

        // 同步用户标签到全局表
        let _ = self.resource_set_user_tags(
            crate::tag::TaggableKind::Knowledge,
            &entry.id,
            &entry.tags,
        )?;
        Ok(())
    }

    fn push_knowledge_revision(&self, entry: &KnowledgeEntry) -> OmniResult<()> {
        let id = format!("rev-{}-{}", entry.id, entry.updated_at);
        let created_at = entry.updated_at.max(1);
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO knowledge_revisions (id, entry_id, title, content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![id, entry.id, entry.title, entry.content, created_at],
            )
            .map_err(map_sqlite)?;

        // 保留最近 N 条
        self.conn()
            .execute(
                "DELETE FROM knowledge_revisions
                 WHERE entry_id = ?1 AND id NOT IN (
                    SELECT id FROM knowledge_revisions
                    WHERE entry_id = ?1
                    ORDER BY created_at DESC
                    LIMIT ?2
                 )",
                rusqlite::params![entry.id, KNOWLEDGE_REVISION_LIMIT],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 列出文档历史版本（新→旧）。
    pub fn list_knowledge_revisions(&self, entry_id: &str) -> OmniResult<Vec<KnowledgeRevision>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, entry_id, title, content, created_at
                 FROM knowledge_revisions
                 WHERE entry_id = ?1
                 ORDER BY created_at DESC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([entry_id], |row| {
                Ok(KnowledgeRevision {
                    id: row.get(0)?,
                    entry_id: row.get(1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 按版本 id 获取快照。
    pub fn get_knowledge_revision(&self, revision_id: &str) -> OmniResult<Option<KnowledgeRevision>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, entry_id, title, content, created_at
                 FROM knowledge_revisions WHERE id = ?1",
            )
            .map_err(map_sqlite)?;
        let mut rows = stmt
            .query_map([revision_id], |row| {
                Ok(KnowledgeRevision {
                    id: row.get(0)?,
                    entry_id: row.get(1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(map_sqlite)?;
        Ok(rows.next().transpose().map_err(map_sqlite)?)
    }

    /// 将历史版本恢复为当前内容（会先把当前版本写入历史）。
    pub fn restore_knowledge_revision(&self, revision_id: &str) -> OmniResult<KnowledgeEntry> {
        let revision = self
            .get_knowledge_revision(revision_id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "历史版本不存在"))?;
        let mut entry = self
            .get_knowledge(&revision.entry_id)?
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "文档不存在"))?;
        entry.title = revision.title;
        entry.content = revision.content;
        entry.updated_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        self.save_knowledge(&entry)?;
        Ok(entry)
    }

    /// 删除条目。
    pub fn delete_knowledge(&self, id: &str) -> OmniResult<()> {
        let _ = self.clear_resource_tags(crate::tag::TaggableKind::Knowledge, id);
        self.conn()
            .execute("DELETE FROM knowledge_entries WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// FTS5 全文搜索（可选按 kind 过滤）。
    pub fn search_knowledge(
        &self,
        query: &str,
        kind: Option<&str>,
    ) -> OmniResult<Vec<KnowledgeSearchResult>> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }

        // 构造 FTS5 MATCH 表达式：对每个词加 * 做前缀匹配
        let fts_query: String = query
            .split_whitespace()
            .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");

        let sql = if kind.is_some() {
            "SELECT e.id, e.kind, e.title, e.content, e.tags, e.risk_level, e.source, e.env_tag, e.language, e.usage_count, e.created_at, e.updated_at, e.parent_id, e.node_type, e.sort_order, e.resource_type, e.resource_id,
                    snippet(knowledge_fts, 1, '<mark>', '</mark>', '...', 32) as snip
             FROM knowledge_fts f
             JOIN knowledge_entries e ON e.rowid = f.rowid
             WHERE knowledge_fts MATCH ?1 AND e.kind = ?2 AND e.node_type = 'document'
             ORDER BY rank"
        } else {
            "SELECT e.id, e.kind, e.title, e.content, e.tags, e.risk_level, e.source, e.env_tag, e.language, e.usage_count, e.created_at, e.updated_at, e.parent_id, e.node_type, e.sort_order, e.resource_type, e.resource_id,
                    snippet(knowledge_fts, 1, '<mark>', '</mark>', '...', 32) as snip
             FROM knowledge_fts f
             JOIN knowledge_entries e ON e.rowid = f.rowid
             WHERE knowledge_fts MATCH ?1 AND e.node_type = 'document'
             ORDER BY rank"
        };

        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;
        let mut results = Vec::new();
        if let Some(k) = kind {
            let rows = stmt
                .query_map(rusqlite::params![fts_query, k], |row| {
                    Ok(KnowledgeSearchResult {
                        entry: Self::row_to_entry(row)?,
                        snippet: row.get::<_, String>(17)?,
                        score: 0, // 占位，稍后计算
                    })
                })
                .map_err(map_sqlite)?;
            for row in rows {
                results.push(row.map_err(map_sqlite)?);
            }
        } else {
            let rows = stmt
                .query_map([fts_query], |row| {
                    Ok(KnowledgeSearchResult {
                        entry: Self::row_to_entry(row)?,
                        snippet: row.get::<_, String>(17)?,
                        score: 0, // 占位，稍后计算
                    })
                })
                .map_err(map_sqlite)?;
            for row in rows {
                results.push(row.map_err(map_sqlite)?);
            }
        }

        // ── 关键词相关性评分 ──────────────────────────────────
        let keywords: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();

        for result in &mut results {
            let title_lower = result.entry.title.to_lowercase();
            let content_lower = result.entry.content.to_lowercase();
            let mut s: i64 = 0;

            for kw in &keywords {
                // title 完全匹配（忽略大小写）
                if title_lower == *kw {
                    s += 10;
                }
                // title 包含关键词
                if title_lower.contains(kw.as_str()) {
                    s += 5;
                }
                // content 包含关键词
                if content_lower.contains(kw.as_str()) {
                    s += 3;
                }
                // tags 匹配
                if result.entry.tags.iter().any(|t| t.to_lowercase() == *kw) {
                    s += 2;
                }
            }

            // 热度加分：usage_count，上限 5
            s += std::cmp::min(result.entry.usage_count, 5);

            result.score = s;
        }

        // 按分数降序排列
        results.sort_by(|a, b| b.score.cmp(&a.score));

        Ok(results)
    }

    /// 列出所有不重复的 tag（来自全局标签表中 knowledge 绑定）。
    pub fn list_knowledge_tags(&self) -> OmniResult<Vec<String>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT DISTINCT t.path FROM resource_tag_links l
                 JOIN tags t ON t.id = l.tag_id
                 WHERE l.resource_kind = 'knowledge'
                 ORDER BY t.path COLLATE NOCASE",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        if out.is_empty() {
            // 兼容未迁移数据
            let mut stmt = self
                .conn()
                .prepare("SELECT DISTINCT tags FROM knowledge_entries")
                .map_err(map_sqlite)?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(map_sqlite)?;
            let mut tag_set = std::collections::BTreeSet::new();
            for row in rows {
                let tags_json: String = row.map_err(map_sqlite)?;
                for tag in Self::parse_tags_field(&tags_json) {
                    tag_set.insert(tag);
                }
            }
            return Ok(tag_set.into_iter().collect());
        }
        Ok(out)
    }

    /// 递增使用次数。
    pub fn increment_usage(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "UPDATE knowledge_entries SET usage_count = usage_count + 1, updated_at = CAST(strftime('%s','now') AS INTEGER) WHERE id = ?1",
                [id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    // ── 内部辅助 ──────────────────────────────────────────────

    /// 规范化单个标签：去掉错误拆分残留的引号/方括号。
    fn normalize_knowledge_tag(raw: &str) -> Option<String> {
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

        if s.is_empty() {
            return None;
        }
        if s.chars().all(|c| matches!(c, '[' | ']' | '{' | '}' | ',' | ':' | '"' | '\'')) {
            return None;
        }
        if !s.chars().any(|c| c.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&c)) {
            return None;
        }
        Some(s)
    }

    fn expand_tag_value(raw: &str, out: &mut Vec<String>) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return;
        }
        if trimmed.starts_with('[') {
            if let Ok(nested) = serde_json::from_str::<Vec<String>>(trimmed) {
                for item in nested {
                    Self::expand_tag_value(&item, out);
                }
                return;
            }
        }
        if let Some(tag) = Self::normalize_knowledge_tag(trimmed) {
            out.push(tag);
        }
    }

    /// 解析 knowledge_entries.tags 字段（JSON 数组 / 双重编码 / 脏数据）。
    fn parse_tags_field(tags_json: &str) -> Vec<String> {
        let mut out = Vec::new();
        let trimmed = tags_json.trim();
        if trimmed.is_empty() || trimmed == "[]" || trimmed == "null" {
            return out;
        }

        if let Ok(tags) = serde_json::from_str::<Vec<String>>(trimmed) {
            for tag in tags {
                Self::expand_tag_value(&tag, &mut out);
            }
            return Self::dedupe_tags(out);
        }

        // 双重 JSON 编码：`"["a","b"]"`
        if let Ok(inner) = serde_json::from_str::<String>(trimmed) {
            return Self::parse_tags_field(&inner);
        }

        Self::expand_tag_value(trimmed, &mut out);
        Self::dedupe_tags(out)
    }

    fn dedupe_tags(tags: Vec<String>) -> Vec<String> {
        let mut seen = std::collections::BTreeSet::new();
        let mut out = Vec::new();
        for tag in tags {
            let key = tag.to_lowercase();
            if seen.insert(key) {
                out.push(tag);
            }
        }
        out
    }

    fn row_to_entry(row: &rusqlite::Row) -> rusqlite::Result<KnowledgeEntry> {
        let tags_json: String = row.get(4)?;
        let tags = Self::parse_tags_field(&tags_json);
        Ok(KnowledgeEntry {
            id: row.get(0)?,
            kind: row.get(1)?,
            title: row.get(2)?,
            content: row.get(3)?,
            tags,
            risk_level: row.get(5)?,
            source: row.get(6)?,
            env_tag: row.get(7)?,
            language: row.get(8)?,
            usage_count: row.get(9)?,
            created_at: row.get(10)?,
            updated_at: row.get(11)?,
            parent_id: row.get(12)?,
            node_type: row.get(13)?,
            sort_order: row.get(14)?,
            resource_type: row.get(15)?,
            resource_id: row.get(16)?,
        })
    }

    fn query_knowledge<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> OmniResult<Vec<KnowledgeEntry>> {
        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(params, |row| Self::row_to_entry(row))
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for entry in rows {
            out.push(entry.map_err(map_sqlite)?);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_entry(id: &str) -> KnowledgeEntry {
        KnowledgeEntry {
            id: id.to_string(),
            kind: "snippet".into(),
            title: "Test snippet".into(),
            content: "console.log('hello');".into(),
            tags: vec!["javascript".into(), "example".into()],
            risk_level: "safe".into(),
            source: "manual".into(),
            env_tag: "dev".into(),
            language: "javascript".into(),
            usage_count: 0,
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
            parent_id: String::new(),
            node_type: "document".into(),
            sort_order: 0,
            resource_type: String::new(),
            resource_id: String::new(),
        }
    }

    #[test]
    fn save_and_list_knowledge() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_knowledge(&sample_entry("k1")).unwrap();
        storage.save_knowledge(&sample_entry("k2")).unwrap();
        let all = storage.list_knowledge(None, None).unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn get_knowledge_roundtrip() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_knowledge(&sample_entry("kx")).unwrap();
        let got = storage.get_knowledge("kx").unwrap().unwrap();
        assert_eq!(got.title, "Test snippet");
        assert_eq!(got.tags, vec!["javascript", "example"]);
    }

    #[test]
    fn delete_knowledge() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_knowledge(&sample_entry("kd")).unwrap();
        storage.delete_knowledge("kd").unwrap();
        assert!(storage.get_knowledge("kd").unwrap().is_none());
    }

    #[test]
    fn list_knowledge_filter_by_kind() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_knowledge(&sample_entry("a")).unwrap();
        let mut case = sample_entry("b");
        case.kind = "case".into();
        storage.save_knowledge(&case).unwrap();

        let snippets = storage.list_knowledge(Some("snippet"), None).unwrap();
        assert_eq!(snippets.len(), 1);
        assert_eq!(snippets[0].id, "a");
    }

    #[test]
    fn list_knowledge_filter_by_tag() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_knowledge(&sample_entry("a")).unwrap();
        let mut b = sample_entry("b");
        b.tags = vec!["python".into()];
        storage.save_knowledge(&b).unwrap();

        let js = storage.list_knowledge(None, Some("javascript")).unwrap();
        assert_eq!(js.len(), 1);
        assert_eq!(js[0].id, "a");
    }

    #[test]
    fn search_knowledge_fts() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_knowledge(&sample_entry("s1")).unwrap();
        let results = storage.search_knowledge("hello", None).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].snippet.contains("<mark>"));
    }

    #[test]
    fn list_tags_collects_unique() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_knowledge(&sample_entry("a")).unwrap();
        let mut b = sample_entry("b");
        b.tags = vec!["javascript".into(), "node".into()];
        storage.save_knowledge(&b).unwrap();

        let tags = storage.list_knowledge_tags().unwrap();
        assert!(tags.contains(&"javascript".to_string()));
        assert!(tags.contains(&"node".to_string()));
        assert!(tags.contains(&"example".to_string()));
    }

    #[test]
    fn list_tags_normalizes_dirty_fragments() {
        let storage = Storage::open_in_memory().unwrap();
        // 直接写脏 JSON，模拟历史错误拆分残留
        storage
            .conn()
            .execute(
                "INSERT INTO knowledge_entries (id, kind, title, content, tags, risk_level, source, env_tag, language, usage_count, created_at, updated_at, parent_id, node_type, sort_order, resource_type, resource_id)
                 VALUES ('dirty', 'snippet', 't', 'c', ?1, 'safe', 'manual', 'dev', '', 0, 1, 1, '', 'document', 0, '', '')",
                [r#"[" \"学习数据\"", " \"学段\"]", "[ \"教育\"", "database"]"#],
            )
            .unwrap();

        let tags = storage.list_knowledge_tags().unwrap();
        assert!(tags.contains(&"学习数据".to_string()));
        assert!(tags.contains(&"学段".to_string()));
        assert!(tags.contains(&"教育".to_string()));
        assert!(tags.contains(&"database".to_string()));
        assert!(!tags.iter().any(|t| t.contains('"')));
        assert!(!tags.iter().any(|t| t.contains('[') || t.contains(']')));
    }

    #[test]
    fn increment_usage_bumps_count() {
        let storage = Storage::open_in_memory().unwrap();
        let mut e = sample_entry("u1");
        e.usage_count = 5;
        storage.save_knowledge(&e).unwrap();
        storage.increment_usage("u1").unwrap();
        let got = storage.get_knowledge("u1").unwrap().unwrap();
        assert_eq!(got.usage_count, 6);
    }
}
