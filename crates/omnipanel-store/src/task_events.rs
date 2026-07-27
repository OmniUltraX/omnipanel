use crate::storage::{map_sqlite, Storage};
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};

/// 任务中心统一事件索引（历史时间轴筛选用）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventRecord {
    pub id: String,
    /// bg_task | workflow | loop | approval | other
    pub source: String,
    pub ref_id: String,
    pub module: String,
    pub workspace_id: Option<String>,
    pub resource_id: Option<String>,
    pub title: String,
    pub status: String,
    pub env_tag: String,
    pub risk: String,
    #[specta(type = f64)]
    pub ts: i64,
    pub detail: String,
}

#[derive(Debug, Clone)]
pub struct TaskEventFilter {
    pub module: Option<String>,
    pub workspace_id: Option<String>,
    pub resource_id: Option<String>,
    pub source: Option<String>,
    pub limit: u32,
}

impl Default for TaskEventFilter {
    fn default() -> Self {
        Self {
            module: None,
            workspace_id: None,
            resource_id: None,
            source: None,
            limit: 200,
        }
    }
}

const EVENT_CAP: u32 = 2000;

impl Storage {
    pub fn upsert_task_event(&self, ev: &TaskEventRecord) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO task_events (
                    id, source, ref_id, module, workspace_id, resource_id,
                    title, status, env_tag, risk, ts, detail
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                    source=excluded.source,
                    ref_id=excluded.ref_id,
                    module=excluded.module,
                    workspace_id=excluded.workspace_id,
                    resource_id=excluded.resource_id,
                    title=excluded.title,
                    status=excluded.status,
                    env_tag=excluded.env_tag,
                    risk=excluded.risk,
                    ts=excluded.ts,
                    detail=excluded.detail",
                rusqlite::params![
                    ev.id,
                    ev.source,
                    ev.ref_id,
                    ev.module,
                    ev.workspace_id,
                    ev.resource_id,
                    ev.title,
                    ev.status,
                    ev.env_tag,
                    ev.risk,
                    ev.ts,
                    ev.detail,
                ],
            )
            .map_err(map_sqlite)?;
        self.prune_task_events(EVENT_CAP)?;
        Ok(())
    }

    pub fn list_task_events(&self, filter: &TaskEventFilter) -> OmniResult<Vec<TaskEventRecord>> {
        let limit = filter.limit.clamp(1, EVENT_CAP);
        let mut sql = String::from(
            "SELECT id, source, ref_id, module, workspace_id, resource_id,
                    title, status, env_tag, risk, ts, detail
             FROM task_events WHERE 1=1",
        );
        let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(m) = filter.module.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND module = ?");
            params.push(Box::new(m.to_string()));
        }
        if let Some(w) = filter.workspace_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND workspace_id = ?");
            params.push(Box::new(w.to_string()));
        }
        if let Some(r) = filter.resource_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND resource_id = ?");
            params.push(Box::new(r.to_string()));
        }
        if let Some(s) = filter.source.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND source = ?");
            params.push(Box::new(s.to_string()));
        }
        sql.push_str(" ORDER BY ts DESC LIMIT ?");
        params.push(Box::new(limit as i64));

        let mut stmt = self.conn().prepare(&sql).map_err(map_sqlite)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> =
            params.iter().map(|p| p.as_ref()).collect();
        let rows = stmt
            .query_map(param_refs.as_slice(), |row| {
                Ok(TaskEventRecord {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    ref_id: row.get(2)?,
                    module: row.get(3)?,
                    workspace_id: row.get(4)?,
                    resource_id: row.get(5)?,
                    title: row.get(6)?,
                    status: row.get(7)?,
                    env_tag: row.get(8)?,
                    risk: row.get(9)?,
                    ts: row.get(10)?,
                    detail: row.get(11)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    fn prune_task_events(&self, keep: u32) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM task_events WHERE id NOT IN (
                    SELECT id FROM task_events ORDER BY ts DESC LIMIT ?1
                 )",
                [keep],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_filters_by_module() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .upsert_task_event(&TaskEventRecord {
                id: "e1".into(),
                source: "bg_task".into(),
                ref_id: "bg-1".into(),
                module: "database".into(),
                workspace_id: Some("ws1".into()),
                resource_id: None,
                title: "a".into(),
                status: "completed".into(),
                env_tag: "dev".into(),
                risk: "low".into(),
                ts: 100,
                detail: "{}".into(),
            })
            .unwrap();
        storage
            .upsert_task_event(&TaskEventRecord {
                id: "e2".into(),
                source: "bg_task".into(),
                ref_id: "bg-2".into(),
                module: "ai".into(),
                workspace_id: None,
                resource_id: None,
                title: "b".into(),
                status: "failed".into(),
                env_tag: "prod".into(),
                risk: "high".into(),
                ts: 200,
                detail: "{}".into(),
            })
            .unwrap();

        let db_only = storage
            .list_task_events(&TaskEventFilter {
                module: Some("database".into()),
                limit: 50,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(db_only.len(), 1);
        assert_eq!(db_only[0].id, "e1");
    }
}
