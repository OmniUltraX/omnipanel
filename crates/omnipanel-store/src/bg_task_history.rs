use crate::storage::{map_sqlite, Storage};
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};

/// 被动后台任务终态历史（与 WorkerPool `BackgroundTaskInfo` 字段对齐）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct BgTaskHistoryRecord {
    pub id: String,
    pub module: String,
    pub kind: String,
    pub title: String,
    pub progress: String,
    /// pending/running/completed/failed/cancelled
    pub status: String,
    pub index: u32,
    pub total: u32,
    pub row_completed: Option<u32>,
    pub row_total: Option<u32>,
    #[specta(type = f64)]
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub finished_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

const HISTORY_CAP: u32 = 500;

impl Storage {
    /// 写入或更新终态任务；随后修剪超额旧记录。
    pub fn upsert_bg_task_history(&self, rec: &BgTaskHistoryRecord) -> OmniResult<()> {
        let created_at = rec.finished_at.unwrap_or(rec.started_at);
        self.conn()
            .execute(
                "INSERT INTO bg_task_history (
                    id, module, kind, title, progress, status,
                    index_n, total, row_completed, row_total,
                    started_at, finished_at, error, created_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                 ON CONFLICT(id) DO UPDATE SET
                    module=excluded.module,
                    kind=excluded.kind,
                    title=excluded.title,
                    progress=excluded.progress,
                    status=excluded.status,
                    index_n=excluded.index_n,
                    total=excluded.total,
                    row_completed=excluded.row_completed,
                    row_total=excluded.row_total,
                    started_at=excluded.started_at,
                    finished_at=excluded.finished_at,
                    error=excluded.error",
                rusqlite::params![
                    rec.id,
                    rec.module,
                    rec.kind,
                    rec.title,
                    rec.progress,
                    rec.status,
                    rec.index,
                    rec.total,
                    rec.row_completed,
                    rec.row_total,
                    rec.started_at,
                    rec.finished_at,
                    rec.error,
                    created_at,
                ],
            )
            .map_err(map_sqlite)?;
        self.prune_bg_task_history(HISTORY_CAP)?;
        Ok(())
    }

    /// 按结束时间倒序列出终态历史。
    pub fn list_bg_task_history(&self, limit: u32) -> OmniResult<Vec<BgTaskHistoryRecord>> {
        let limit = limit.clamp(1, HISTORY_CAP);
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, module, kind, title, progress, status,
                        index_n, total, row_completed, row_total,
                        started_at, finished_at, error
                 FROM bg_task_history
                 ORDER BY COALESCE(finished_at, started_at) DESC
                 LIMIT ?1",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([limit], |row| {
                Ok(BgTaskHistoryRecord {
                    id: row.get(0)?,
                    module: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    progress: row.get(4)?,
                    status: row.get(5)?,
                    index: row.get::<_, i64>(6)? as u32,
                    total: row.get::<_, i64>(7)? as u32,
                    row_completed: row
                        .get::<_, Option<i64>>(8)?
                        .map(|v| v as u32),
                    row_total: row.get::<_, Option<i64>>(9)?.map(|v| v as u32),
                    started_at: row.get(10)?,
                    finished_at: row.get(11)?,
                    error: row.get(12)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    fn prune_bg_task_history(&self, keep: u32) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM bg_task_history WHERE id NOT IN (
                    SELECT id FROM bg_task_history
                    ORDER BY COALESCE(finished_at, started_at) DESC
                    LIMIT ?1
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

    fn sample(id: &str, finished: i64) -> BgTaskHistoryRecord {
        BgTaskHistoryRecord {
            id: id.into(),
            module: "database".into(),
            kind: "dbDataSyncAnalysis".into(),
            title: "sync".into(),
            progress: "done".into(),
            status: "completed".into(),
            index: 1,
            total: 1,
            row_completed: None,
            row_total: None,
            started_at: finished - 1000,
            finished_at: Some(finished),
            error: None,
        }
    }

    #[test]
    fn upsert_list_and_prune() {
        let storage = Storage::open_in_memory().unwrap();
        for i in 0..505 {
            storage
                .upsert_bg_task_history(&sample(&format!("t{i}"), 1_700_000_000_000 + i))
                .unwrap();
        }
        let list = storage.list_bg_task_history(1000).unwrap();
        assert_eq!(list.len(), 500);
        assert_eq!(list[0].id, "t504");
    }
}
