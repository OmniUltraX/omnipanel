//! Task persistence — tasks table for workspace actions.

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::storage::{map_sqlite, Storage};

/// Serialize enum to bare string without JSON quotes.
fn enum_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

/// Parse a bare enum string back by wrapping in quotes for serde_json.
fn parse_enum<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    let quoted = format!("\"{}\"", s);
    serde_json::from_str(&quoted).ok()
}

// ─── Data Models ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskType {
    Terminal,
    Sql,
    Docker,
    Server,
    Ssh,
    Ai,
    Workflow,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Draft,
    Blocked,
    Confirmed,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskRisk {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum TaskSource {
    User,
    Ai,
    System,
}

/// Persisted workspace task/action.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Task {
    pub id: String,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub resource_id: String,
    pub resource_name: String,
    pub env_tag: String,
    pub command: String,
    pub risk: TaskRisk,
    pub status: TaskStatus,
    pub source: TaskSource,
    pub output: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SaveTaskRequest {
    pub id: Option<String>,
    pub task_type: TaskType,
    pub title: String,
    pub description: String,
    pub resource_id: String,
    pub resource_name: String,
    pub env_tag: String,
    pub command: String,
    pub risk: TaskRisk,
    pub status: TaskStatus,
    pub source: TaskSource,
}

// ─── CRUD ────────────────────────────────────────────────────

impl Storage {
    /// List tasks, optionally filtered by status.
    pub fn task_list(&self, status_filter: Option<&str>, limit: u32) -> OmniResult<Vec<Task>> {
        let sql = if let Some(_) = status_filter {
            "SELECT id, task_type, title, description, resource_id, resource_name, env_tag, command, risk, status, source, output, created_at, updated_at, started_at, finished_at
             FROM tasks WHERE status = ?1 ORDER BY updated_at DESC LIMIT ?2"
        } else {
            "SELECT id, task_type, title, description, resource_id, resource_name, env_tag, command, risk, status, source, output, created_at, updated_at, started_at, finished_at
             FROM tasks ORDER BY updated_at DESC LIMIT ?1"
        };

        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;

        let map_row = |row: &rusqlite::Row| -> rusqlite::Result<Task> {
            Ok(Task {
                id: row.get(0)?,
                task_type: parse_enum(&row.get::<_, String>(1)?)
                    .unwrap_or(TaskType::Terminal),
                title: row.get(2)?,
                description: row.get(3)?,
                resource_id: row.get(4)?,
                resource_name: row.get(5)?,
                env_tag: row.get(6)?,
                command: row.get(7)?,
                risk: parse_enum(&row.get::<_, String>(8)?)
                    .unwrap_or(TaskRisk::Low),
                status: parse_enum(&row.get::<_, String>(9)?)
                    .unwrap_or(TaskStatus::Draft),
                source: parse_enum(&row.get::<_, String>(10)?)
                    .unwrap_or(TaskSource::User),
                output: row.get(11)?,
                created_at: row.get(12)?,
                updated_at: row.get(13)?,
                started_at: row.get(14)?,
                finished_at: row.get(15)?,
            })
        };

        let rows = if let Some(sf) = status_filter {
            stmt.query_map(params![sf, limit], map_row)
        } else {
            stmt.query_map(params![limit], map_row)
        }
        .map_err(map_sqlite)?;

        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// Get a single task.
    pub fn task_get(&self, id: &str) -> OmniResult<Task> {
        self.conn()
            .query_row(
                "SELECT id, task_type, title, description, resource_id, resource_name, env_tag, command, risk, status, source, output, created_at, updated_at, started_at, finished_at
                 FROM tasks WHERE id = ?1",
                [id],
                |row| {
                    Ok(Task {
                        id: row.get(0)?,
                        task_type: parse_enum(&row.get::<_, String>(1)?)
                            .unwrap_or(TaskType::Terminal),
                        title: row.get(2)?,
                        description: row.get(3)?,
                        resource_id: row.get(4)?,
                        resource_name: row.get(5)?,
                        env_tag: row.get(6)?,
                        command: row.get(7)?,
                        risk: parse_enum(&row.get::<_, String>(8)?)
                            .unwrap_or(TaskRisk::Low),
                        status: parse_enum(&row.get::<_, String>(9)?)
                            .unwrap_or(TaskStatus::Draft),
                        source: parse_enum(&row.get::<_, String>(10)?)
                            .unwrap_or(TaskSource::User),
                        output: row.get(11)?,
                        created_at: row.get(12)?,
                        updated_at: row.get(13)?,
                        started_at: row.get(14)?,
                        finished_at: row.get(15)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    OmniError::new(ErrorCode::NotFound, format!("task '{}' not found", id))
                }
                other => map_sqlite(other),
            })
    }

    /// Create or update a task.
    pub fn task_save(&self, req: &SaveTaskRequest) -> OmniResult<Task> {
        let now = now_ms();
        let task_id = req.id.clone().unwrap_or_else(new_id);

        self.conn()
            .execute(
                "INSERT INTO tasks (id, task_type, title, description, resource_id, resource_name, env_tag, command, risk, status, source, output, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, '', ?12, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                     task_type=excluded.task_type, title=excluded.title, description=excluded.description,
                     resource_id=excluded.resource_id, resource_name=excluded.resource_name,
                     env_tag=excluded.env_tag, command=excluded.command, risk=excluded.risk,
                     status=excluded.status, source=excluded.source, updated_at=excluded.updated_at",
                params![
                    task_id,
                    enum_str(&req.task_type),
                    req.title,
                    req.description,
                    req.resource_id,
                    req.resource_name,
                    req.env_tag,
                    req.command,
                    enum_str(&req.risk),
                    enum_str(&req.status),
                    enum_str(&req.source),
                    now,
                ],
            )
            .map_err(map_sqlite)?;

        self.task_get(&task_id)
    }

    /// Update task status.
    pub fn task_update_status(&self, id: &str, status: &TaskStatus) -> OmniResult<()> {
        let now = now_ms();
        let status_str = enum_str(status);
        match status {
            TaskStatus::Running => {
                self.conn()
                    .execute(
                        "UPDATE tasks SET status = ?1, updated_at = ?2, started_at = ?2 WHERE id = ?3",
                        params![status_str, now, id],
                    )
                    .map_err(map_sqlite)?;
            }
            TaskStatus::Completed | TaskStatus::Failed | TaskStatus::Cancelled => {
                self.conn()
                    .execute(
                        "UPDATE tasks SET status = ?1, updated_at = ?2, finished_at = ?2 WHERE id = ?3",
                        params![status_str, now, id],
                    )
                    .map_err(map_sqlite)?;
            }
            _ => {
                self.conn()
                    .execute(
                        "UPDATE tasks SET status = ?1, updated_at = ?2 WHERE id = ?3",
                        params![status_str, now, id],
                    )
                    .map_err(map_sqlite)?;
            }
        }
        Ok(())
    }

    /// Append output to a task.
    pub fn task_append_output(&self, id: &str, output: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "UPDATE tasks SET output = output || ?1, updated_at = ?2 WHERE id = ?3",
                params![output, now_ms(), id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// Delete a task.
    pub fn task_delete(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM tasks WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// Count tasks by status.
    pub fn task_count_by_status(&self) -> OmniResult<Vec<(String, i64)>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT status, COUNT(*) FROM tasks GROUP BY status")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }
}

// ─── Helpers ─────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let nanos = t.as_nanos();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (nanos >> 96) as u32,
        ((nanos >> 80) & 0xFFFF) as u16,
        ((nanos >> 64) & 0xFFF) as u16,
        ((nanos >> 48) & 0xFFFF) as u16,
        nanos & 0xFFFFFFFFFFFF_u128
    )
}

// ─── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_req() -> SaveTaskRequest {
        SaveTaskRequest {
            id: None,
            task_type: TaskType::Docker,
            title: "Restart container".into(),
            description: "Restart nginx".into(),
            resource_id: "nginx-1".into(),
            resource_name: "nginx".into(),
            env_tag: "prod".into(),
            command: "docker restart nginx".into(),
            risk: TaskRisk::High,
            status: TaskStatus::Draft,
            source: TaskSource::User,
        }
    }

    #[test]
    fn save_and_list() {
        let storage = Storage::open_in_memory().unwrap();
        let task = storage.task_save(&sample_req()).unwrap();
        assert_eq!(task.title, "Restart container");
        assert_eq!(task.task_type as u8, TaskType::Docker as u8);

        let list = storage.task_list(None, 100).unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn filter_by_status() {
        let storage = Storage::open_in_memory().unwrap();
        storage.task_save(&sample_req()).unwrap();
        let mut req2 = sample_req();
        req2.status = TaskStatus::Running;
        storage.task_save(&req2).unwrap();

        let drafts = storage.task_list(Some("draft"), 100).unwrap();
        assert_eq!(drafts.len(), 1);

        let running = storage.task_list(Some("running"), 100).unwrap();
        assert_eq!(running.len(), 1);
    }

    #[test]
    fn update_status_sets_timestamps() {
        let storage = Storage::open_in_memory().unwrap();
        let task = storage.task_save(&sample_req()).unwrap();
        assert!(task.started_at.is_none());

        storage
            .task_update_status(&task.id, &TaskStatus::Running)
            .unwrap();
        let t = storage.task_get(&task.id).unwrap();
        assert!(t.started_at.is_some());
        assert!(t.finished_at.is_none());

        storage
            .task_update_status(&task.id, &TaskStatus::Completed)
            .unwrap();
        let t = storage.task_get(&task.id).unwrap();
        assert!(t.finished_at.is_some());
    }

    #[test]
    fn append_output() {
        let storage = Storage::open_in_memory().unwrap();
        let task = storage.task_save(&sample_req()).unwrap();
        storage.task_append_output(&task.id, "line 1\n").unwrap();
        storage.task_append_output(&task.id, "line 2\n").unwrap();
        let t = storage.task_get(&task.id).unwrap();
        assert_eq!(t.output, "line 1\nline 2\n");
    }

    #[test]
    fn delete_task() {
        let storage = Storage::open_in_memory().unwrap();
        let task = storage.task_save(&sample_req()).unwrap();
        storage.task_delete(&task.id).unwrap();
        assert!(storage.task_get(&task.id).is_err());
    }

    #[test]
    fn count_by_status() {
        let storage = Storage::open_in_memory().unwrap();
        storage.task_save(&sample_req()).unwrap();
        let mut req2 = sample_req();
        req2.status = TaskStatus::Completed;
        storage.task_save(&req2).unwrap();

        let counts = storage.task_count_by_status().unwrap();
        let draft_count = counts.iter().find(|(s, _)| s == "draft").map(|(_, c)| *c);
        assert_eq!(draft_count, Some(1));
    }

    #[test]
    fn upsert_updates() {
        let storage = Storage::open_in_memory().unwrap();
        let task = storage.task_save(&sample_req()).unwrap();
        let mut req = sample_req();
        req.id = Some(task.id.clone());
        req.title = "Updated".into();
        let updated = storage.task_save(&req).unwrap();
        assert_eq!(updated.title, "Updated");
        assert_eq!(storage.task_list(None, 100).unwrap().len(), 1);
    }
}
