//! Skill 数据库层（v24 迁移引入）。
//!
//! 与 `skill.rs`（文件层）的关系：
//! - `skill.rs` 仍是 SKILL.md 文件的单一真相源（body / frontmatter 读写）
//! - 本模块提供 DB 元数据：版本链、应用历史、成功率、knowledge 关联、向量分块
//! - `skill_create` / `skill_update` 命令同时写文件和 DB（双写），保持一致
//!
//! 表结构见 v24 迁移：skills / skill_applications / skill_knowledge_links / skill_chunks

use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, map_sqlite};

/// Skill DB 记录（与文件层 SkillRecord 互补，增加版本链和应用统计）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillDbRecord {
    pub id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
    #[specta(type = f64)]
    pub version: i64,
    /// 上一版本 id（版本链）；空字符串表示初版
    pub parent_version_id: String,
    pub path: String,
    #[specta(type = f64)]
    pub success_count: i64,
    #[specta(type = f64)]
    pub failure_count: i64,
    /// 最近一次应用时间（毫秒）；null 表示从未应用
    #[serde(default)]
    #[specta(type = f64)]
    pub last_applied_at: Option<i64>,
    pub shareable: bool,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

/// Skill 应用记录（每次 AI 调用 skill 时追加一条）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillApplication {
    pub id: String,
    pub skill_id: String,
    pub session_id: String,
    pub resource_type: String,
    pub resource_id: String,
    /// "pending" | "success" | "failure" | "partial"
    pub outcome: String,
    pub feedback: String,
    #[specta(type = f64)]
    pub applied_at: i64,
}

/// Skill 与 Knowledge 的关联。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SkillKnowledgeLink {
    pub skill_id: String,
    pub knowledge_id: String,
    /// "related" | "source" | "case"
    pub link_kind: String,
    #[specta(type = f64)]
    pub created_at: i64,
}

impl Storage {
    // ── skills 表 CRUD ──────────────────────────────────────────────

    /// 按 id 获取 skill DB 记录。
    pub fn get_skill_db(&self, id: &str) -> OmniResult<Option<SkillDbRecord>> {
        Ok(self
            .query_skills_db(
                "SELECT id, name, description, enabled, version, parent_version_id, path,
                        success_count, failure_count, last_applied_at, shareable,
                        created_at, updated_at
                 FROM skills WHERE id = ?1",
                [id],
            )?
            .into_iter()
            .next())
    }

    /// 列出所有 skill DB 记录（按 name 排序）。
    pub fn list_skills_db(&self) -> OmniResult<Vec<SkillDbRecord>> {
        self.query_skills_db(
            "SELECT id, name, description, enabled, version, parent_version_id, path,
                    success_count, failure_count, last_applied_at, shareable,
                    created_at, updated_at
             FROM skills ORDER BY name ASC",
            [],
        )
    }

    /// 列出已启用的 skill（按 name 排序）。
    pub fn list_enabled_skills_db(&self) -> OmniResult<Vec<SkillDbRecord>> {
        self.query_skills_db(
            "SELECT id, name, description, enabled, version, parent_version_id, path,
                    success_count, failure_count, last_applied_at, shareable,
                    created_at, updated_at
             FROM skills WHERE enabled = 1 ORDER BY name ASC",
            [],
        )
    }

    /// 插入或更新 skill DB 记录（upsert by id）。
    pub fn save_skill_db(&self, record: &SkillDbRecord) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO skills (id, name, description, enabled, version, parent_version_id,
                     path, success_count, failure_count, last_applied_at, shareable,
                     created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
                 ON CONFLICT(id) DO UPDATE SET
                    name = excluded.name,
                    description = excluded.description,
                    enabled = excluded.enabled,
                    version = excluded.version,
                    parent_version_id = excluded.parent_version_id,
                    path = excluded.path,
                    success_count = excluded.success_count,
                    failure_count = excluded.failure_count,
                    last_applied_at = excluded.last_applied_at,
                    shareable = excluded.shareable,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    record.id,
                    record.name,
                    record.description,
                    record.enabled as i32,
                    record.version,
                    record.parent_version_id,
                    record.path,
                    record.success_count,
                    record.failure_count,
                    record.last_applied_at,
                    record.shareable as i32,
                    record.created_at,
                    record.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 删除 skill DB 记录（级联删除 applications / links / chunks）。
    pub fn delete_skill_db(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM skills WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }

    // ── skill_applications 表 ───────────────────────────────────────

    /// 追加一条 skill 应用记录。
    pub fn save_skill_application(&self, app: &SkillApplication) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO skill_applications
                    (id, skill_id, session_id, resource_type, resource_id, outcome, feedback, applied_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                rusqlite::params![
                    app.id,
                    app.skill_id,
                    app.session_id,
                    app.resource_type,
                    app.resource_id,
                    app.outcome,
                    app.feedback,
                    app.applied_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 更新应用记录的 outcome（success/failure/partial）+ feedback。
    pub fn update_skill_application_outcome(
        &self,
        app_id: &str,
        outcome: &str,
        feedback: &str,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "UPDATE skill_applications SET outcome = ?2, feedback = ?3 WHERE id = ?1",
                rusqlite::params![app_id, outcome, feedback],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 按 id 获取单条应用记录（用于在 update outcome 后重算对应 skill 的统计）。
    pub fn get_skill_application(&self, app_id: &str) -> OmniResult<Option<SkillApplication>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, skill_id, session_id, resource_type, resource_id, outcome, feedback, applied_at
                 FROM skill_applications WHERE id = ?1",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([app_id], |row| {
                Ok(SkillApplication {
                    id: row.get(0)?,
                    skill_id: row.get(1)?,
                    session_id: row.get(2)?,
                    resource_type: row.get(3)?,
                    resource_id: row.get(4)?,
                    outcome: row.get(5)?,
                    feedback: row.get(6)?,
                    applied_at: row.get(7)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out.into_iter().next())
    }

    /// 列出某 skill 的应用历史（按时间倒序，可限制条数）。
    pub fn list_skill_applications(
        &self,
        skill_id: &str,
        limit: usize,
    ) -> OmniResult<Vec<SkillApplication>> {
        let limit_i64 = limit as i64;
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, skill_id, session_id, resource_type, resource_id, outcome, feedback, applied_at
                 FROM skill_applications
                 WHERE skill_id = ?1
                 ORDER BY applied_at DESC
                 LIMIT ?2",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map(rusqlite::params![skill_id, limit_i64], |row| {
                Ok(SkillApplication {
                    id: row.get(0)?,
                    skill_id: row.get(1)?,
                    session_id: row.get(2)?,
                    resource_type: row.get(3)?,
                    resource_id: row.get(4)?,
                    outcome: row.get(5)?,
                    feedback: row.get(6)?,
                    applied_at: row.get(7)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 更新 skill 的应用统计（成功/失败计数 + 最近应用时间）。
    /// 在 `update_skill_application_outcome` 之后调用，重算聚合计数。
    pub fn recalc_skill_stats(&self, skill_id: &str) -> OmniResult<()> {
        let now = now_millis();
        self.conn()
            .execute(
                "UPDATE skills SET
                    success_count = (
                        SELECT COUNT(*) FROM skill_applications
                        WHERE skill_id = ?1 AND outcome = 'success'
                    ),
                    failure_count = (
                        SELECT COUNT(*) FROM skill_applications
                        WHERE skill_id = ?1 AND outcome = 'failure'
                    ),
                    last_applied_at = ?2,
                    updated_at = ?2
                 WHERE id = ?1",
                rusqlite::params![skill_id, now],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    // ── skill_knowledge_links 表 ───────────────────────────────────

    /// 关联 skill 与 knowledge 条目（已存在则忽略）。
    pub fn link_skill_knowledge(
        &self,
        skill_id: &str,
        knowledge_id: &str,
        link_kind: &str,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT OR IGNORE INTO skill_knowledge_links
                    (skill_id, knowledge_id, link_kind, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![skill_id, knowledge_id, link_kind, now_millis()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 解除 skill 与 knowledge 的关联。
    pub fn unlink_skill_knowledge(&self, skill_id: &str, knowledge_id: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM skill_knowledge_links WHERE skill_id = ?1 AND knowledge_id = ?2",
                rusqlite::params![skill_id, knowledge_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 列出 skill 关联的 knowledge 条目 id。
    pub fn list_knowledge_for_skill(&self, skill_id: &str) -> OmniResult<Vec<SkillKnowledgeLink>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT skill_id, knowledge_id, link_kind, created_at
                 FROM skill_knowledge_links
                 WHERE skill_id = ?1
                 ORDER BY created_at DESC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([skill_id], |row| {
                Ok(SkillKnowledgeLink {
                    skill_id: row.get(0)?,
                    knowledge_id: row.get(1)?,
                    link_kind: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 列出 knowledge 条目关联的 skill id。
    pub fn list_skills_for_knowledge(&self, knowledge_id: &str) -> OmniResult<Vec<String>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT skill_id FROM skill_knowledge_links WHERE knowledge_id = ?1")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([knowledge_id], |row| row.get::<_, String>(0))
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    // ── skill_chunks 表 ────────────────────────────────────────────

    /// 保存（覆盖）skill 的向量分块。
    pub fn save_skill_chunks(&self, skill_id: &str, chunks: &[(String, String, String)]) -> OmniResult<()> {
        // 先删除旧分块
        self.conn()
            .execute("DELETE FROM skill_chunks WHERE skill_id = ?1", [skill_id])
            .map_err(map_sqlite)?;
        let now = now_millis();
        for (idx, (chunk_id, content, embedding)) in chunks.iter().enumerate() {
            self.conn()
                .execute(
                    "INSERT INTO skill_chunks (id, skill_id, chunk_index, content, embedding, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![chunk_id, skill_id, idx as i64, content, embedding, now],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    /// 列出 skill 的分块内容（不含 embedding，用于预览）。
    pub fn list_skill_chunks(&self, skill_id: &str) -> OmniResult<Vec<(String, i64, String)>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT id, chunk_index, content FROM skill_chunks WHERE skill_id = ?1 ORDER BY chunk_index ASC")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([skill_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?))
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 获取 skill 的分块 embedding（用于 RAG 召回）。
    /// 返回 (chunk_id, content, embedding) 三元组列表。
    pub fn list_skill_chunks_with_embedding(
        &self,
        skill_id: &str,
    ) -> OmniResult<Vec<(String, String, String)>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT id, content, embedding FROM skill_chunks WHERE skill_id = ?1 ORDER BY chunk_index ASC")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([skill_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    // ── 版本链 ─────────────────────────────────────────────────────

    /// 获取 skill 的版本链（从当前 id 向前追溯 parent_version_id）。
    /// 返回按版本从新到旧排列的 (id, version, created_at) 列表。
    pub fn get_skill_version_chain(&self, skill_id: &str) -> OmniResult<Vec<(String, i64, i64)>> {
        let mut chain = Vec::new();
        let mut current = skill_id.to_string();
        for _ in 0..50 {
            // 防止循环引用
            let row: Option<(String, i64, i64, String)> = self
                .conn()
                .query_row(
                    "SELECT id, version, created_at, parent_version_id FROM skills WHERE id = ?1",
                    [&current],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                )
                .ok();
            match row {
                Some((id, version, created_at, parent)) => {
                    chain.push((id, version, created_at));
                    if parent.is_empty() {
                        break;
                    }
                    current = parent;
                }
                None => break,
            }
        }
        Ok(chain)
    }

    // ── 内部辅助 ───────────────────────────────────────────────────

    fn query_skills_db<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> OmniResult<Vec<SkillDbRecord>> {
        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(params, |row| {
                let enabled: i32 = row.get(3)?;
                let shareable: i32 = row.get(10)?;
                let last_applied_at: Option<i64> = row.get(9)?;
                Ok(SkillDbRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    enabled: enabled != 0,
                    version: row.get(4)?,
                    parent_version_id: row.get(5)?,
                    path: row.get(6)?,
                    success_count: row.get(7)?,
                    failure_count: row.get(8)?,
                    last_applied_at,
                    shareable: shareable != 0,
                    created_at: row.get(11)?,
                    updated_at: row.get(12)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }
}

fn now_millis() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_skill(id: &str, name: &str) -> SkillDbRecord {
        SkillDbRecord {
            id: id.to_string(),
            name: name.to_string(),
            description: format!("Desc for {name}"),
            enabled: true,
            version: 1,
            parent_version_id: String::new(),
            path: format!("~/.omnipd/skills/{id}/SKILL.md"),
            success_count: 0,
            failure_count: 0,
            last_applied_at: None,
            shareable: false,
            created_at: 1_700_000_000_000,
            updated_at: 1_700_000_000_000,
        }
    }

    #[test]
    fn save_and_get_skill_db() {
        let storage = Storage::open_in_memory().unwrap();
        let skill = sample_skill("s1", "disk-cleanup");
        storage.save_skill_db(&skill).unwrap();
        let got = storage.get_skill_db("s1").unwrap().unwrap();
        assert_eq!(got.name, "disk-cleanup");
        assert_eq!(got.version, 1);
        assert!(got.enabled);
        assert!(!got.shareable);
    }

    #[test]
    fn list_enabled_skills_db() {
        let storage = Storage::open_in_memory().unwrap();
        let s1 = sample_skill("s1", "alpha");
        let mut s2 = sample_skill("s2", "beta");
        s2.enabled = false;
        storage.save_skill_db(&s1).unwrap();
        storage.save_skill_db(&s2).unwrap();
        let enabled = storage.list_enabled_skills_db().unwrap();
        assert_eq!(enabled.len(), 1);
        assert_eq!(enabled[0].id, "s1");
    }

    #[test]
    fn delete_skill_db_cascades() {
        let storage = Storage::open_in_memory().unwrap();
        let skill = sample_skill("s1", "test");
        storage.save_skill_db(&skill).unwrap();
        let app = SkillApplication {
            id: "app1".to_string(),
            skill_id: "s1".to_string(),
            session_id: "sess1".to_string(),
            resource_type: "ssh".to_string(),
            resource_id: "host-a".to_string(),
            outcome: "success".to_string(),
            feedback: String::new(),
            applied_at: 1_700_000_000_000,
        };
        storage.save_skill_application(&app).unwrap();
        storage.delete_skill_db("s1").unwrap();
        assert!(storage.get_skill_db("s1").unwrap().is_none());
        // 应用记录应被级联删除
        let apps = storage.list_skill_applications("s1", 10).unwrap();
        assert_eq!(apps.len(), 0);
    }

    #[test]
    fn skill_application_and_recalc_stats() {
        let storage = Storage::open_in_memory().unwrap();
        let skill = sample_skill("s1", "test");
        storage.save_skill_db(&skill).unwrap();

        // 追加 3 条应用记录
        for i in 0..3 {
            let outcome = if i < 2 { "success" } else { "failure" };
            let app = SkillApplication {
                id: format!("app{i}"),
                skill_id: "s1".to_string(),
                session_id: String::new(),
                resource_type: "ssh".to_string(),
                resource_id: "host-a".to_string(),
                outcome: outcome.to_string(),
                feedback: String::new(),
                applied_at: 1_700_000_000_000 + i,
            };
            storage.save_skill_application(&app).unwrap();
        }

        storage.recalc_skill_stats("s1").unwrap();
        let got = storage.get_skill_db("s1").unwrap().unwrap();
        assert_eq!(got.success_count, 2);
        assert_eq!(got.failure_count, 1);
        assert!(got.last_applied_at.is_some());
    }

    #[test]
    fn link_and_list_knowledge() {
        let storage = Storage::open_in_memory().unwrap();
        let skill = sample_skill("s1", "test");
        storage.save_skill_db(&skill).unwrap();

        // 需要先有 knowledge_entries（外键约束）
        // 直接插入一条最小 knowledge 条目
        storage
            .conn()
            .execute(
                "INSERT INTO knowledge_entries (id, kind, title, content, tags, risk_level, source, env_tag, language, usage_count, created_at, updated_at)
                 VALUES ('k1', 'case', 'Case 1', 'content', '[]', 'safe', 'test', 'dev', '', 0, 1, 1)",
                [],
            )
            .unwrap();

        storage
            .link_skill_knowledge("s1", "k1", "related")
            .unwrap();
        let links = storage.list_knowledge_for_skill("s1").unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].knowledge_id, "k1");

        let skills = storage.list_skills_for_knowledge("k1").unwrap();
        assert_eq!(skills, vec!["s1".to_string()]);

        storage.unlink_skill_knowledge("s1", "k1").unwrap();
        let links_after = storage.list_knowledge_for_skill("s1").unwrap();
        assert_eq!(links_after.len(), 0);
    }

    #[test]
    fn skill_chunks_save_and_list() {
        let storage = Storage::open_in_memory().unwrap();
        let skill = sample_skill("s1", "test");
        storage.save_skill_db(&skill).unwrap();

        let chunks = vec![
            ("c1".to_string(), "chunk 1 content".to_string(), "[0.1, 0.2]".to_string()),
            ("c2".to_string(), "chunk 2 content".to_string(), "[0.3, 0.4]".to_string()),
        ];
        storage.save_skill_chunks("s1", &chunks).unwrap();

        let listed = storage.list_skill_chunks("s1").unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].1, 0);
        assert_eq!(listed[1].1, 1);

        let with_emb = storage.list_skill_chunks_with_embedding("s1").unwrap();
        assert_eq!(with_emb.len(), 2);
        assert_eq!(with_emb[0].2, "[0.1, 0.2]");

        // 重新保存覆盖旧分块
        let chunks2 = vec![("c3".to_string(), "new chunk".to_string(), "[0.5]".to_string())];
        storage.save_skill_chunks("s1", &chunks2).unwrap();
        let listed2 = storage.list_skill_chunks("s1").unwrap();
        assert_eq!(listed2.len(), 1);
    }

    #[test]
    fn version_chain_traces_parents() {
        let storage = Storage::open_in_memory().unwrap();
        // v1
        let mut v1 = sample_skill("s1", "test");
        v1.version = 1;
        v1.parent_version_id = String::new();
        storage.save_skill_db(&v1).unwrap();

        // v2（parent = s1）
        let v2 = SkillDbRecord {
            id: "s2".to_string(),
            name: "test".to_string(),
            description: "v2".to_string(),
            enabled: true,
            version: 2,
            parent_version_id: "s1".to_string(),
            path: String::new(),
            success_count: 0,
            failure_count: 0,
            last_applied_at: None,
            shareable: false,
            created_at: 1_700_000_001_000,
            updated_at: 1_700_000_001_000,
        };
        storage.save_skill_db(&v2).unwrap();

        // v3（parent = s2）
        let mut v3 = v2.clone();
        v3.id = "s3".to_string();
        v3.version = 3;
        v3.parent_version_id = "s2".to_string();
        v3.created_at = 1_700_000_002_000;
        storage.save_skill_db(&v3).unwrap();

        let chain = storage.get_skill_version_chain("s3").unwrap();
        assert_eq!(chain.len(), 3);
        assert_eq!(chain[0].0, "s3");
        assert_eq!(chain[0].1, 3);
        assert_eq!(chain[1].0, "s2");
        assert_eq!(chain[2].0, "s1");
    }
}
