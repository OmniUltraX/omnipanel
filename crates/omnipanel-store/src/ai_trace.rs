use crate::storage::{map_sqlite, Storage};
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSessionRecord {
    pub id: String,
    pub backend_id: String,
    pub source: String,
    pub workspace_id: Option<String>,
    pub terminal_session_id: Option<String>,
    pub env_tag: Option<String>,
    pub title: Option<String>,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AiTraceRecord {
    #[specta(type = f64)]
    pub id: i64,
    pub session_id: String,
    pub turn_index: i32,
    pub event_type: String,
    pub payload: String,
    #[specta(type = f64)]
    pub ts: i64,
}

impl Storage {
    pub fn ai_session_upsert(&self, session: &AiSessionRecord) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO ai_sessions (id, backend_id, source, workspace_id, terminal_session_id, env_tag, title, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   backend_id=excluded.backend_id,
                   updated_at=excluded.updated_at,
                   title=COALESCE(excluded.title, ai_sessions.title)",
                (
                    &session.id,
                    &session.backend_id,
                    &session.source,
                    &session.workspace_id,
                    &session.terminal_session_id,
                    &session.env_tag,
                    &session.title,
                    session.created_at,
                    session.updated_at,
                ),
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn ai_trace_append(
        &self,
        session_id: &str,
        turn_index: i32,
        event_type: &str,
        payload: &str,
        ts: i64,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO ai_traces (session_id, turn_index, event_type, payload, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                (session_id, turn_index, event_type, payload, ts),
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn ai_session_list(&self, source: Option<&str>) -> OmniResult<Vec<AiSessionRecord>> {
        let mut out = Vec::new();
        match source {
            Some(src) => {
                let mut stmt = self
                    .conn()
                    .prepare(
                        "SELECT id, backend_id, source, workspace_id, terminal_session_id, env_tag, title, created_at, updated_at
                         FROM ai_sessions WHERE source = ?1 ORDER BY updated_at DESC LIMIT 200",
                    )
                    .map_err(map_sqlite)?;
                let rows = stmt
                    .query_map([src], |row| {
                        Ok(AiSessionRecord {
                            id: row.get(0)?,
                            backend_id: row.get(1)?,
                            source: row.get(2)?,
                            workspace_id: row.get(3)?,
                            terminal_session_id: row.get(4)?,
                            env_tag: row.get(5)?,
                            title: row.get(6)?,
                            created_at: row.get(7)?,
                            updated_at: row.get(8)?,
                        })
                    })
                    .map_err(map_sqlite)?;
                for row in rows {
                    out.push(row.map_err(map_sqlite)?);
                }
            }
            None => {
                let mut stmt = self
                    .conn()
                    .prepare(
                        "SELECT id, backend_id, source, workspace_id, terminal_session_id, env_tag, title, created_at, updated_at
                         FROM ai_sessions ORDER BY updated_at DESC LIMIT 200",
                    )
                    .map_err(map_sqlite)?;
                let rows = stmt
                    .query_map([], |row| {
                        Ok(AiSessionRecord {
                            id: row.get(0)?,
                            backend_id: row.get(1)?,
                            source: row.get(2)?,
                            workspace_id: row.get(3)?,
                            terminal_session_id: row.get(4)?,
                            env_tag: row.get(5)?,
                            title: row.get(6)?,
                            created_at: row.get(7)?,
                            updated_at: row.get(8)?,
                        })
                    })
                    .map_err(map_sqlite)?;
                for row in rows {
                    out.push(row.map_err(map_sqlite)?);
                }
            }
        }
        Ok(out)
    }

    pub fn ai_trace_list(&self, session_id: &str) -> OmniResult<Vec<AiTraceRecord>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, session_id, turn_index, event_type, payload, ts
                 FROM ai_traces WHERE session_id = ?1 ORDER BY turn_index, id",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok(AiTraceRecord {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    turn_index: row.get(2)?,
                    event_type: row.get(3)?,
                    payload: row.get(4)?,
                    ts: row.get(5)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    pub fn builtin_tool_audit_append(
        &self,
        source: &str,
        tool_name: &str,
        duration_ms: i64,
        success: bool,
        detail: &str,
        ts: i64,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO builtin_tool_audit (source, tool_name, duration_ms, success, detail, ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                (
                    source,
                    tool_name,
                    duration_ms,
                    if success { 1 } else { 0 },
                    detail,
                    ts,
                ),
            )
            .map_err(map_sqlite)?;
        Ok(())
    }
}
