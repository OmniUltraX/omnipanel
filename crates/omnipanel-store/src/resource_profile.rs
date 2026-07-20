//! 资源档案：为 SSH 主机 / 数据库连接 / Docker 主机等资源沉淀可观测快照，
//! 供 AI 在后续类似场景下快速召回与诊断。
//!
//! 设计：
//! - 每个资源由 `(resource_type, resource_id)` 唯一标识（如 `("ssh", "prod-web-01")`）。
//! - 同一资源可有多类观测：`observation_kind`（hardware / services / overview / schema_summary 等）。
//! - 每类观测保留历史记录，但 `get_latest_resource_profile` 只返回每类最新一条。
//! - 与 `knowledge_entries` 松耦合：knowledge 可选择性关联 `resource_type` + `resource_id`。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::storage::{Storage, map_sqlite};

/// 单条资源观测记录。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceObservation {
    pub id: String,
    /// "ssh" | "database" | "docker" | "files"
    pub resource_type: String,
    /// 连接名或唯一标识
    pub resource_id: String,
    /// "hardware" | "services" | "topology" | "key_paths" | "overview" | "schema_summary" | "table_relations" | "index_health" | "users" | "note"
    pub observation_kind: String,
    /// JSON 负载（自由结构）
    #[specta(type = serde_json::Value)]
    pub payload: Value,
    #[specta(type = f64)]
    pub observed_at: i64,
    /// "auto"（采集器）/ "manual"（用户录入）/ "ai"（AI 工具更新）
    pub observer: String,
}

/// 资源档案摘要：用于 `list_resources_with_profiles` 列表展示与 `find_similar`。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProfileSummary {
    pub resource_type: String,
    pub resource_id: String,
    /// 每类观测的最新时间戳（Unix 毫秒）
    #[specta(type = f64)]
    pub latest_observed_at: i64,
    /// 观测种类数
    #[specta(type = f64)]
    pub observation_kinds: i64,
    /// 该资源关联的 knowledge 条目数
    #[specta(type = f64)]
    pub knowledge_count: i64,
    /// 资源指纹：用于相似度匹配的关键属性摘要（JSON）
    #[specta(type = serde_json::Value)]
    pub fingerprint: Value,
}

impl Storage {
    /// 保存一条资源观测（INSERT，不替换；同 kind 历史保留）。
    pub fn save_resource_observation(&self, obs: &ResourceObservation) -> OmniResult<()> {
        let payload_str = serde_json::to_string(&obs.payload).map_err(|e| {
            OmniError::new(ErrorCode::InvalidInput, "payload 序列化失败").with_cause(e.to_string())
        })?;
        self.conn()
            .execute(
                "INSERT INTO resource_observations
                    (id, resource_type, resource_id, observation_kind, payload, observed_at, observer)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    obs.id,
                    obs.resource_type,
                    obs.resource_id,
                    obs.observation_kind,
                    payload_str,
                    obs.observed_at,
                    obs.observer,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 列出资源的全部观测（按时间倒序），可选过滤 `observation_kind`。
    pub fn list_resource_observations(
        &self,
        resource_type: &str,
        resource_id: &str,
        observation_kind: Option<&str>,
    ) -> OmniResult<Vec<ResourceObservation>> {
        let sql = match observation_kind {
            Some(_) => "SELECT id, resource_type, resource_id, observation_kind, payload, observed_at, observer
                        FROM resource_observations
                        WHERE resource_type = ?1 AND resource_id = ?2 AND observation_kind = ?3
                        ORDER BY observed_at DESC",
            None => "SELECT id, resource_type, resource_id, observation_kind, payload, observed_at, observer
                     FROM resource_observations
                     WHERE resource_type = ?1 AND resource_id = ?2
                     ORDER BY observed_at DESC",
        };
        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;
        let rows = match observation_kind {
            Some(kind) => stmt.query_map(
                rusqlite::params![resource_type, resource_id, kind],
                map_observation_row,
            ),
            None => stmt.query_map(
                rusqlite::params![resource_type, resource_id],
                map_observation_row,
            ),
        }
        .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 获取资源最新档案：每类 observation_kind 取最新一条，组装为 JSON 对象。
    /// 返回结构：`{ "resource_type": "...", "resource_id": "...", "observations": { kind: payload, ... }, "latest_observed_at": ts }`
    pub fn get_latest_resource_profile(
        &self,
        resource_type: &str,
        resource_id: &str,
    ) -> OmniResult<Option<Value>> {
        let observations = self.list_resource_observations(resource_type, resource_id, None)?;
        if observations.is_empty() {
            return Ok(None);
        }
        let mut latest_by_kind: std::collections::HashMap<String, Value> =
            std::collections::HashMap::new();
        let mut latest_ts: i64 = 0;
        for obs in observations {
            // list_resource_observations 已按 observed_at DESC 排序，首个即最新
            let kind = obs.observation_kind.clone();
            if !latest_by_kind.contains_key(&kind) {
                latest_by_kind.insert(
                    kind,
                    serde_json::json!({
                        "payload": obs.payload,
                        "observed_at": obs.observed_at,
                        "observer": obs.observer,
                    }),
                );
                if obs.observed_at > latest_ts {
                    latest_ts = obs.observed_at;
                }
            }
        }
        Ok(Some(serde_json::json!({
            "resource_type": resource_type,
            "resource_id": resource_id,
            "latest_observed_at": latest_ts,
            "observations": latest_by_kind,
        })))
    }

    /// 列出所有有观测记录的资源摘要（按最新观测时间倒序）。
    pub fn list_resources_with_profiles(
        &self,
        resource_type: Option<&str>,
    ) -> OmniResult<Vec<ResourceProfileSummary>> {
        let sql = match resource_type {
            Some(_) => "SELECT resource_type, resource_id, MAX(observed_at) AS latest_ts,
                        COUNT(DISTINCT observation_kind) AS kinds
                        FROM resource_observations
                        WHERE resource_type = ?1
                        GROUP BY resource_type, resource_id
                        ORDER BY latest_ts DESC",
            None => "SELECT resource_type, resource_id, MAX(observed_at) AS latest_ts,
                     COUNT(DISTINCT observation_kind) AS kinds
                     FROM resource_observations
                     GROUP BY resource_type, resource_id
                     ORDER BY latest_ts DESC",
        };
        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;

        let raw_rows: Vec<(String, String, i64, i64)> = match resource_type {
            Some(rt) => {
                let rows = stmt
                    .query_map(rusqlite::params![rt], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    })
                    .map_err(map_sqlite)?;
                rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_sqlite)?
            }
            None => {
                let rows = stmt
                    .query_map([], |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, i64>(2)?,
                            row.get::<_, i64>(3)?,
                        ))
                    })
                    .map_err(map_sqlite)?;
                rows.collect::<rusqlite::Result<Vec<_>>>().map_err(map_sqlite)?
            }
        };

        let mut summaries: Vec<ResourceProfileSummary> = Vec::new();
        for (rt, rid, latest_ts, kinds) in raw_rows {
            let knowledge_count = self.count_knowledge_for_resource(&rt, &rid)?;
            let fingerprint = self.build_resource_fingerprint(&rt, &rid)?;
            summaries.push(ResourceProfileSummary {
                resource_type: rt,
                resource_id: rid,
                latest_observed_at: latest_ts,
                observation_kinds: kinds,
                knowledge_count,
                fingerprint,
            });
        }
        Ok(summaries)
    }

    /// 删除资源的全部观测（用于重置档案）。
    pub fn delete_resource_observations(
        &self,
        resource_type: &str,
        resource_id: &str,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM resource_observations WHERE resource_type = ?1 AND resource_id = ?2",
                rusqlite::params![resource_type, resource_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 查找相似资源：基于指纹的简单匹配（同 resource_type、共享关键字段值）。
    /// 返回的列表已按相似度排序，最多 `limit` 条。
    pub fn find_similar_resources(
        &self,
        resource_type: &str,
        resource_id: &str,
        limit: usize,
    ) -> OmniResult<Vec<ResourceProfileSummary>> {
        let target_fingerprint = self.build_resource_fingerprint(resource_type, resource_id)?;
        if target_fingerprint.is_null() {
            return Ok(Vec::new());
        }

        let candidates =
            self.list_resources_with_profiles(Some(resource_type))?;
        let mut scored: Vec<(ResourceProfileSummary, usize)> = Vec::new();
        for candidate in candidates {
            if candidate.resource_id == resource_id {
                continue;
            }
            let score = compute_fingerprint_similarity(&target_fingerprint, &candidate.fingerprint);
            if score > 0 {
                scored.push((candidate, score));
            }
        }
        scored.sort_by(|a, b| b.1.cmp(&a.1));
        Ok(scored.into_iter().take(limit).map(|(s, _)| s).collect())
    }

    /// 列出资源关联的 knowledge 条目（按更新时间倒序）。
    pub fn list_knowledge_for_resource(
        &self,
        resource_type: &str,
        resource_id: &str,
    ) -> OmniResult<Vec<crate::KnowledgeEntry>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, kind, title, content, tags, risk_level, source, env_tag, language,
                        usage_count, created_at, updated_at, parent_id, node_type, sort_order,
                        resource_type, resource_id
                 FROM knowledge_entries
                 WHERE resource_type = ?1 AND resource_id = ?2
                 ORDER BY updated_at DESC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map(rusqlite::params![resource_type, resource_id], |row| {
                let tags_json: String = row.get(4)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(crate::KnowledgeEntry {
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
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 统计资源关联的 knowledge 条目数。
    pub fn count_knowledge_for_resource(
        &self,
        resource_type: &str,
        resource_id: &str,
    ) -> OmniResult<i64> {
        let count: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM knowledge_entries
                 WHERE resource_type = ?1 AND resource_id = ?2",
                rusqlite::params![resource_type, resource_id],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        Ok(count)
    }

    /// Phase 5 子任务 3：计算某资源某 kind 最近两次观测的 diff。
    ///
    /// 返回结构：
    /// ```json
    /// {
    ///   "has_previous": true,
    ///   "current_observed_at": 1700000000000,
    ///   "previous_observed_at": 1699000000000,
    ///   "added_keys": ["new_table"],
    ///   "removed_keys": ["dropped_column"],
    ///   "changed_keys": [{"key": "size_mb", "from": 100, "to": 150}],
    ///   "summary": "新增 1 项, 移除 1 项, 变化 1 项"
    /// }
    /// ```
    ///
    /// 若不足两次观测，`has_previous` 为 false，其余字段省略。
    pub fn compute_observation_diff(
        &self,
        resource_type: &str,
        resource_id: &str,
        observation_kind: &str,
    ) -> OmniResult<Value> {
        let obs = self.list_resource_observations(resource_type, resource_id, Some(observation_kind))?;
        if obs.len() < 2 {
            return Ok(serde_json::json!({
                "has_previous": false,
                "current_observed_at": obs.first().map(|o| o.observed_at),
            }));
        }
        let current = &obs[0];
        let previous = &obs[1];

        let cur_obj = current.payload.as_object();
        let prev_obj = previous.payload.as_object();

        let mut added_keys: Vec<String> = Vec::new();
        let mut removed_keys: Vec<String> = Vec::new();
        let mut changed_keys: Vec<Value> = Vec::new();

        if let Some(cur) = cur_obj {
            if let Some(prev) = prev_obj {
                for k in cur.keys() {
                    if !prev.contains_key(k) {
                        added_keys.push(k.clone());
                    } else if prev.get(k) != cur.get(k) {
                        changed_keys.push(serde_json::json!({
                            "key": k,
                            "from": prev.get(k),
                            "to": cur.get(k),
                        }));
                    }
                }
                for k in prev.keys() {
                    if !cur.contains_key(k) {
                        removed_keys.push(k.clone());
                    }
                }
            } else {
                // previous 不是 object → 全部视为新增
                for k in cur.keys() {
                    added_keys.push(k.clone());
                }
            }
        } else if let Some(prev) = prev_obj {
            // current 不是 object → 全部视为移除
            for k in prev.keys() {
                removed_keys.push(k.clone());
            }
        }

        let added = added_keys.len();
        let removed = removed_keys.len();
        let changed = changed_keys.len();
        Ok(serde_json::json!({
            "has_previous": true,
            "current_observed_at": current.observed_at,
            "previous_observed_at": previous.observed_at,
            "added_keys": added_keys,
            "removed_keys": removed_keys,
            "changed_keys": changed_keys,
            "summary": format!("新增 {added} 项, 移除 {removed} 项, 变化 {changed} 项"),
        }))
    }

    /// 构建资源指纹：从最新 hardware（SSH）或 overview（DB）观测提取关键字段。
    fn build_resource_fingerprint(
        &self,
        resource_type: &str,
        resource_id: &str,
    ) -> OmniResult<Value> {
        let kinds = match resource_type {
            "ssh" => vec!["hardware", "services"],
            // Phase 5 子任务 2：把 table_relations 纳入指纹，让相似召回能基于
            // 表关系结构匹配（例如两台都频繁 JOIN user/order/payment 的 OLTP 库）。
            "database" => vec!["overview", "schema_summary", "table_relations"],
            _ => vec!["overview"],
        };
        let mut fingerprint = serde_json::Map::new();
        for kind in kinds {
            let obs = self.list_resource_observations(resource_type, resource_id, Some(kind))?;
            if let Some(latest) = obs.first() {
                fingerprint.insert(
                    kind.to_string(),
                    serde_json::json!({
                        "observed_at": latest.observed_at,
                        "payload": latest.payload,
                    }),
                );
            }
        }
        Ok(Value::Object(fingerprint))
    }
}

fn map_observation_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ResourceObservation> {
    let payload_str: String = row.get(4)?;
    let payload: Value = serde_json::from_str(&payload_str).unwrap_or(Value::Null);
    Ok(ResourceObservation {
        id: row.get(0)?,
        resource_type: row.get(1)?,
        resource_id: row.get(2)?,
        observation_kind: row.get(3)?,
        payload,
        observed_at: row.get(5)?,
        observer: row.get(6)?,
    })
}

/// 简单的指纹相似度评分：逐字段比对，命中一个加 1 分。
/// 指纹结构：`{ "hardware": { "payload": { "os": "...", "cpu": ... } }, ... }`
fn compute_fingerprint_similarity(target: &Value, candidate: &Value) -> usize {
    let target_obj = match target.as_object() {
        Some(o) => o,
        None => return 0,
    };
    let candidate_obj = match candidate.as_object() {
        Some(o) => o,
        None => return 0,
    };
    let mut score = 0;
    for (kind, target_kind_val) in target_obj {
        if let Some(candidate_kind_val) = candidate_obj.get(kind) {
            let target_payload = target_kind_val.get("payload").cloned().unwrap_or(Value::Null);
            let candidate_payload =
                candidate_kind_val.get("payload").cloned().unwrap_or(Value::Null);
            if let Some(t) = target_payload.as_object() {
                if let Some(c) = candidate_payload.as_object() {
                    for (key, t_val) in t {
                        if let Some(c_val) = c.get(key) {
                            // 标量字段相等加分；数组字段有交集加分
                            if t_val == c_val {
                                score += 2;
                            } else if let (Some(t_arr), Some(c_arr)) =
                                (t_val.as_array(), c_val.as_array())
                            {
                                let c_set: std::collections::HashSet<&Value> =
                                    c_arr.iter().collect();
                                if t_arr.iter().any(|v| c_set.contains(v)) {
                                    score += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    score
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn sample_obs(
        id: &str,
        resource_type: &str,
        resource_id: &str,
        kind: &str,
        payload: Value,
        ts: i64,
    ) -> ResourceObservation {
        ResourceObservation {
            id: id.to_string(),
            resource_type: resource_type.to_string(),
            resource_id: resource_id.to_string(),
            observation_kind: kind.to_string(),
            payload,
            observed_at: ts,
            observer: "auto".to_string(),
        }
    }

    #[test]
    fn save_and_list_observations() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o1",
                "ssh",
                "host-a",
                "hardware",
                serde_json::json!({ "os": "Ubuntu 22.04", "cpu": 8 }),
                1_700_000_000_000,
            ))
            .unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o2",
                "ssh",
                "host-a",
                "services",
                serde_json::json!({ "running": ["nginx", "docker"] }),
                1_700_000_001_000,
            ))
            .unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o3",
                "ssh",
                "host-b",
                "hardware",
                serde_json::json!({ "os": "Ubuntu 22.04", "cpu": 16 }),
                1_700_000_002_000,
            ))
            .unwrap();

        let host_a = storage
            .list_resource_observations("ssh", "host-a", None)
            .unwrap();
        assert_eq!(host_a.len(), 2);
        // 按时间倒序：services 应在前
        assert_eq!(host_a[0].observation_kind, "services");

        let host_a_hw = storage
            .list_resource_observations("ssh", "host-a", Some("hardware"))
            .unwrap();
        assert_eq!(host_a_hw.len(), 1);
        assert_eq!(host_a_hw[0].observation_kind, "hardware");
    }

    #[test]
    fn get_latest_profile_returns_per_kind_latest() {
        let storage = Storage::open_in_memory().unwrap();
        // 旧 hardware 观测
        storage
            .save_resource_observation(&sample_obs(
                "o1",
                "ssh",
                "host-a",
                "hardware",
                serde_json::json!({ "os": "Ubuntu 20.04" }),
                1_700_000_000_000,
            ))
            .unwrap();
        // 新 hardware 观测（覆盖旧值）
        storage
            .save_resource_observation(&sample_obs(
                "o2",
                "ssh",
                "host-a",
                "hardware",
                serde_json::json!({ "os": "Ubuntu 22.04" }),
                1_700_000_005_000,
            ))
            .unwrap();
        // services 观测
        storage
            .save_resource_observation(&sample_obs(
                "o3",
                "ssh",
                "host-a",
                "services",
                serde_json::json!({ "running": ["nginx"] }),
                1_700_000_003_000,
            ))
            .unwrap();

        let profile = storage
            .get_latest_resource_profile("ssh", "host-a")
            .unwrap()
            .expect("profile should exist");

        assert_eq!(profile["resource_type"], "ssh");
        assert_eq!(profile["resource_id"], "host-a");
        assert_eq!(profile["latest_observed_at"], 1_700_000_005_000i64);
        // 每类只保留最新一条
        let observations = profile["observations"].as_object().unwrap();
        assert_eq!(observations.len(), 2);
        assert_eq!(
            observations["hardware"]["payload"]["os"],
            "Ubuntu 22.04"
        );
    }

    #[test]
    fn get_latest_profile_returns_none_for_unknown_resource() {
        let storage = Storage::open_in_memory().unwrap();
        let profile = storage
            .get_latest_resource_profile("ssh", "nonexistent")
            .unwrap();
        assert!(profile.is_none());
    }

    #[test]
    fn list_resources_with_profiles_groups_by_resource() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o1",
                "ssh",
                "host-a",
                "hardware",
                serde_json::json!({}),
                1_700_000_000_000,
            ))
            .unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o2",
                "ssh",
                "host-a",
                "services",
                serde_json::json!({}),
                1_700_000_001_000,
            ))
            .unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o3",
                "ssh",
                "host-b",
                "hardware",
                serde_json::json!({}),
                1_700_000_002_000,
            ))
            .unwrap();

        let summaries = storage.list_resources_with_profiles(None).unwrap();
        assert_eq!(summaries.len(), 2);
        // host-b 最新观测时间更晚，应在前
        assert_eq!(summaries[0].resource_id, "host-b");
        assert_eq!(summaries[0].observation_kinds, 1);
        assert_eq!(summaries[1].resource_id, "host-a");
        assert_eq!(summaries[1].observation_kinds, 2);

        let ssh_only = storage.list_resources_with_profiles(Some("ssh")).unwrap();
        assert_eq!(ssh_only.len(), 2);

        let db_only = storage.list_resources_with_profiles(Some("database")).unwrap();
        assert!(db_only.is_empty());
    }

    #[test]
    fn find_similar_resources_matches_by_fingerprint() {
        let storage = Storage::open_in_memory().unwrap();
        // 目标资源 host-a：Ubuntu 22.04 + 8 核
        storage
            .save_resource_observation(&sample_obs(
                "o1",
                "ssh",
                "host-a",
                "hardware",
                serde_json::json!({ "os": "Ubuntu 22.04", "cpu": 8 }),
                1_700_000_000_000,
            ))
            .unwrap();
        // host-b：Ubuntu 22.04 + 16 核（应相似：os 相同 → +2）
        storage
            .save_resource_observation(&sample_obs(
                "o2",
                "ssh",
                "host-b",
                "hardware",
                serde_json::json!({ "os": "Ubuntu 22.04", "cpu": 16 }),
                1_700_000_001_000,
            ))
            .unwrap();
        // host-c：CentOS 7 + 32 核（应不相似：os 和 cpu 都不同）
        storage
            .save_resource_observation(&sample_obs(
                "o3",
                "ssh",
                "host-c",
                "hardware",
                serde_json::json!({ "os": "CentOS 7", "cpu": 32 }),
                1_700_000_002_000,
            ))
            .unwrap();

        let similar = storage.find_similar_resources("ssh", "host-a", 5).unwrap();
        // host-b 应在结果中（os 相同 → +2）
        assert!(similar.iter().any(|s| s.resource_id == "host-b"));
        // host-c 应不在结果中（os 和 cpu 都不同 → 0 分）
        assert!(!similar.iter().any(|s| s.resource_id == "host-c"));
        // host-a 自身不应在结果中
        assert!(!similar.iter().any(|s| s.resource_id == "host-a"));
    }

    #[test]
    fn delete_resource_observations_clears_all_kinds() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o1",
                "ssh",
                "host-a",
                "hardware",
                serde_json::json!({}),
                1_700_000_000_000,
            ))
            .unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o2",
                "ssh",
                "host-a",
                "services",
                serde_json::json!({}),
                1_700_000_001_000,
            ))
            .unwrap();
        storage
            .save_resource_observation(&sample_obs(
                "o3",
                "ssh",
                "host-b",
                "hardware",
                serde_json::json!({}),
                1_700_000_002_000,
            ))
            .unwrap();

        storage.delete_resource_observations("ssh", "host-a").unwrap();
        let host_a = storage
            .list_resource_observations("ssh", "host-a", None)
            .unwrap();
        assert!(host_a.is_empty());
        let host_b = storage
            .list_resource_observations("ssh", "host-b", None)
            .unwrap();
        assert_eq!(host_b.len(), 1);
    }

    #[test]
    fn fingerprint_similarity_handles_arrays() {
        let target = serde_json::json!({
            "services": { "payload": { "running": ["nginx", "redis"] } }
        });
        let candidate = serde_json::json!({
            "services": { "payload": { "running": ["redis", "mysql"] } }
        });
        let score = compute_fingerprint_similarity(&target, &candidate);
        // redis 命中 → +1 分（数组交集）
        assert_eq!(score, 1);

        let target = serde_json::json!({
            "hardware": { "payload": { "os": "Ubuntu" } }
        });
        let candidate = serde_json::json!({
            "hardware": { "payload": { "os": "Ubuntu" } }
        });
        let score = compute_fingerprint_similarity(&target, &candidate);
        // os 完全相等 → +2 分（标量相等）
        assert_eq!(score, 2);
    }

    #[test]
    fn observation_diff_detects_added_removed_changed() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_resource_observation(&sample_obs(
            "obs1", "database", "conn1", "overview",
            serde_json::json!({ "version": "8.0", "tables": 10 }),
            1000,
        )).unwrap();
        storage.save_resource_observation(&sample_obs(
            "obs2", "database", "conn1", "overview",
            serde_json::json!({ "version": "8.1", "tables": 12, "new_key": "x" }),
            2000,
        )).unwrap();

        let diff = storage.compute_observation_diff("database", "conn1", "overview").unwrap();
        assert_eq!(diff["has_previous"], Value::Bool(true));
        let added = diff["added_keys"].as_array().unwrap();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0], Value::String("new_key".to_string()));
        let removed = diff["removed_keys"].as_array().unwrap();
        assert_eq!(removed.len(), 0);
        let changed = diff["changed_keys"].as_array().unwrap();
        assert_eq!(changed.len(), 2); // version + tables
    }

    #[test]
    fn observation_diff_returns_no_previous_when_only_one_observation() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_resource_observation(&sample_obs(
            "obs1", "ssh", "host1", "hardware",
            serde_json::json!({ "os": "Ubuntu" }),
            1000,
        )).unwrap();

        let diff = storage.compute_observation_diff("ssh", "host1", "hardware").unwrap();
        assert_eq!(diff["has_previous"], Value::Bool(false));
        assert_eq!(diff["current_observed_at"], Value::Number(serde_json::Number::from(1000)));
    }

    /// Phase 5 子任务 4：E2E 验证磁盘清理闭环。
    ///
    /// 场景：p4-prod 主机磁盘告警 → AI 采集快照 → 用户清理 /var/log 后沉淀 case 笔记
    /// → 关联到 skill-disk-cleanup 技能。之后 p7-staging 出现类似磁盘压力时，
    /// AI 通过 find_similar_resources 召回 p4-prod，进而读取关联的 case 笔记与 skill。
    ///
    /// 验证链路：
    /// 1. SSH 快照（hardware 含 disk_layout）→ 跨主机相似匹配
    /// 2. knowledge case 关联 resource_type=ssh/resource_id=p4-prod
    /// 3. skill ↔ knowledge 双向 link（list_knowledge_for_skill / list_skills_for_knowledge）
    /// 4. count_knowledge_for_resource 与 get_latest_resource_profile 闭环查询
    #[test]
    fn disk_cleanup_closedloop_e2e() {
        let storage = Storage::open_in_memory().unwrap();
        let base_ts = 1_700_000_000_000i64;

        // ── 步骤 1：三台主机的硬件快照 ──────────────────────────────
        // p4-prod：Ubuntu 22.04 + 8 核 + root 50G / /var 20G 磁盘布局
        storage
            .save_resource_observation(&sample_obs(
                "hw-p4",
                "ssh",
                "p4-prod",
                "hardware",
                serde_json::json!({
                    "os": "Ubuntu 22.04",
                    "cpu": 8,
                    "kernel": "5.15.0",
                    "disk_layout": ["root 50G", "/var 20G", "/tmp 5G"],
                }),
                base_ts,
            ))
            .unwrap();
        // p7-staging：同 OS / 同磁盘布局，但 cpu 不同 → 应仍相似（os+kernel+disk_layout 命中）
        storage
            .save_resource_observation(&sample_obs(
                "hw-p7",
                "ssh",
                "p7-staging",
                "hardware",
                serde_json::json!({
                    "os": "Ubuntu 22.04",
                    "cpu": 16,
                    "kernel": "5.15.0",
                    "disk_layout": ["root 50G", "/var 20G", "/tmp 5G"],
                }),
                base_ts + 60_000,
            ))
            .unwrap();
        // web-edge-01：CentOS 7 + 完全不同磁盘布局 → 不应相似
        storage
            .save_resource_observation(&sample_obs(
                "hw-web",
                "ssh",
                "web-edge-01",
                "hardware",
                serde_json::json!({
                    "os": "CentOS 7",
                    "cpu": 4,
                    "kernel": "3.10.0",
                    "disk_layout": ["root 20G"],
                }),
                base_ts + 120_000,
            ))
            .unwrap();

        // ── 步骤 2：p7-staging 查找相似资源，应召回 p4-prod，不应召回 web-edge-01 ──
        let similar = storage
            .find_similar_resources("ssh", "p7-staging", 5)
            .unwrap();
        assert!(
            similar.iter().any(|s| s.resource_id == "p4-prod"),
            "p4-prod 应当通过 os/kernel/disk_layout 命中相似召回: {:?}",
            similar.iter().map(|s| &s.resource_id).collect::<Vec<_>>()
        );
        assert!(
            !similar.iter().any(|s| s.resource_id == "web-edge-01"),
            "web-edge-01 不应出现在相似结果中"
        );

        // ── 步骤 3：为 p4-prod 沉淀 case 笔记（resource_type/resource_id 关联） ──
        let case_id = "case-disk-cleanup-p4";
        let case_entry = crate::KnowledgeEntry {
            id: case_id.to_string(),
            kind: "case".to_string(),
            title: "p4-prod 磁盘清理案例".to_string(),
            content: "## 现象\n/var 爆满（>95%）\n## 处置\n1. journalctl --vacuum-size=200M\n2. find /var/log -name '*.gz' -mtime +30 -delete\n3. docker system prune -af".to_string(),
            tags: vec!["disk".to_string(), "cleanup".to_string()],
            risk_level: "medium".to_string(),
            source: "manual".to_string(),
            env_tag: "production".to_string(),
            language: "markdown".to_string(),
            usage_count: 0,
            created_at: base_ts + 180_000,
            updated_at: base_ts + 180_000,
            parent_id: String::new(),
            node_type: "document".to_string(),
            sort_order: 0,
            resource_type: "ssh".to_string(),
            resource_id: "p4-prod".to_string(),
        };
        storage.save_knowledge(&case_entry).unwrap();

        // ── 步骤 4：list_knowledge_for_resource 应返回该 case ──
        let p4_knowledge = storage
            .list_knowledge_for_resource("ssh", "p4-prod")
            .unwrap();
        assert_eq!(p4_knowledge.len(), 1, "p4-prod 应有 1 条关联 knowledge");
        assert_eq!(p4_knowledge[0].id, case_id);
        assert_eq!(p4_knowledge[0].resource_type, "ssh");
        assert_eq!(p4_knowledge[0].resource_id, "p4-prod");

        // count_knowledge_for_resource 同步验证
        let p4_count = storage.count_knowledge_for_resource("ssh", "p4-prod").unwrap();
        assert_eq!(p4_count, 1);

        // ── 步骤 5：创建 skill-disk-cleanup 技能 DB 记录 ──
        let skill_id = "skill-disk-cleanup";
        let skill_record = crate::SkillDbRecord {
            id: skill_id.to_string(),
            name: "Linux 磁盘清理".to_string(),
            description: "通用 Linux 主机磁盘满处置流程：journal/log/docker 三件套".to_string(),
            enabled: true,
            version: 1,
            parent_version_id: String::new(),
            path: "skills/disk-cleanup/SKILL.md".to_string(),
            success_count: 0,
            failure_count: 0,
            last_applied_at: None,
            shareable: true,
            created_at: base_ts + 200_000,
            updated_at: base_ts + 200_000,
        };
        storage.save_skill_db(&skill_record).unwrap();

        // ── 步骤 6：关联 skill ↔ knowledge（link_kind="case"） ──
        storage
            .link_skill_knowledge(skill_id, case_id, "case")
            .unwrap();

        // ── 步骤 7：双向 link 查询 ──
        let skill_to_knowledge = storage.list_knowledge_for_skill(skill_id).unwrap();
        assert_eq!(skill_to_knowledge.len(), 1, "skill 应关联 1 条 knowledge");
        assert_eq!(skill_to_knowledge[0].knowledge_id, case_id);
        assert_eq!(skill_to_knowledge[0].link_kind, "case");

        let knowledge_to_skills = storage.list_skills_for_knowledge(case_id).unwrap();
        assert_eq!(knowledge_to_skills.len(), 1, "knowledge 应被 1 个 skill 关联");
        assert_eq!(knowledge_to_skills[0], skill_id.to_string());

        // ── 步骤 8：get_latest_resource_profile 闭环验证 ──
        let p4_profile = storage
            .get_latest_resource_profile("ssh", "p4-prod")
            .unwrap()
            .expect("p4-prod 档案应存在");
        assert_eq!(p4_profile["resource_type"], "ssh");
        assert_eq!(p4_profile["resource_id"], "p4-prod");
        assert_eq!(
            p4_profile["observations"]["hardware"]["payload"]["os"],
            "Ubuntu 22.04"
        );
        assert_eq!(
            p4_profile["observations"]["hardware"]["payload"]["disk_layout"][0],
            "root 50G"
        );

        // ── 步骤 9：list_resources_with_profiles 摘要含 knowledge_count ──
        let summaries = storage.list_resources_with_profiles(Some("ssh")).unwrap();
        let p4_summary = summaries
            .iter()
            .find(|s| s.resource_id == "p4-prod")
            .expect("p4-prod 应在资源摘要列表中");
        assert_eq!(p4_summary.knowledge_count, 1, "p4-prod 的 knowledge_count 应为 1");
        assert_eq!(p4_summary.observation_kinds, 1, "p4-prod 只有 hardware 一种观测");
        assert!(
            !p4_summary.fingerprint.is_null(),
            "p4-prod 指纹不应为空"
        );

        // ── 步骤 10：unlink 后双向 link 应同步清空 ──
        storage.unlink_skill_knowledge(skill_id, case_id).unwrap();
        let after_unlink = storage.list_knowledge_for_skill(skill_id).unwrap();
        assert!(after_unlink.is_empty(), "unlink 后 skill 不应再有 knowledge 关联");
        // knowledge 条目本身仍在
        let p4_knowledge_after = storage
            .list_knowledge_for_resource("ssh", "p4-prod")
            .unwrap();
        assert_eq!(p4_knowledge_after.len(), 1, "unlink skill 不应删除 knowledge 条目本身");
    }
}
