//! 终端 Blocks 历史 — 持久化于 omnipanel.db，按会话/块增量 upsert。
//!
//! 与 `ai_traces` 职责分离：本模块恢复用户可见时间线；ai_traces 为审计事件流。

use crate::storage::{map_sqlite, Storage};
use omnipanel_error::OmniResult;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

const DEFAULT_MAX_SESSIONS: u32 = 24;
const DEFAULT_MAX_BLOCKS: u32 = 200;
const MAX_OUTPUT_CHARS: usize = 8_000;
const MAX_AI_TEXT_CHARS: usize = 2_000;
const MAX_AI_THREAD_ITEMS: usize = 48;

/// 保留策略（由前端设置传入；非法值在此钳制）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryRetainPolicy {
    pub max_sessions: u32,
    pub max_blocks_per_session: u32,
}

impl Default for TerminalHistoryRetainPolicy {
    fn default() -> Self {
        Self {
            max_sessions: DEFAULT_MAX_SESSIONS,
            max_blocks_per_session: DEFAULT_MAX_BLOCKS,
        }
    }
}

impl TerminalHistoryRetainPolicy {
    pub fn normalized(&self) -> Self {
        Self {
            max_sessions: self.max_sessions.clamp(1, 100),
            max_blocks_per_session: self.max_blocks_per_session.clamp(20, 500),
        }
    }
}

/// 持久化块记录（payload 为 JSON：output / reasoning / aiThread 等）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct TerminalHistoryBlockRecord {
    pub id: String,
    pub session_id: String,
    pub kind: String,
    pub command: String,
    pub title: Option<String>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub cwd: String,
    #[specta(type = f64)]
    pub timestamp: i64,
    #[specta(type = f64)]
    pub completed_at: Option<i64>,
    /// JSON 字符串：output、reasoning、aiThread、摘要及少量 UI 标志
    pub payload: String,
    #[specta(type = f64)]
    pub updated_at: i64,
}

fn trim_head(text: &str, max: usize, label: &str) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    // 按字符边界截断，避免切断 UTF-8
    let mut end = max;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…[{}]", &text[..end], label)
}

fn trim_tail(text: &str, max: usize, label: &str) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len().saturating_sub(max);
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    format!("…[{}]\n{}", label, &text[start..])
}

fn trim_ai_thread(value: &Value) -> Value {
    let Some(arr) = value.as_array() else {
        return value.clone();
    };
    let sliced = if arr.len() > MAX_AI_THREAD_ITEMS {
        &arr[arr.len() - MAX_AI_THREAD_ITEMS..]
    } else {
        arr.as_slice()
    };
    let items: Vec<Value> = sliced
        .iter()
        .map(|item| {
            let mut obj = match item.as_object() {
                Some(o) => o.clone(),
                None => return item.clone(),
            };
            let kind = obj
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("message");
            if kind == "message" {
                if let Some(content) = obj.get("content").and_then(|v| v.as_str()) {
                    obj.insert(
                        "content".into(),
                        Value::String(trim_head(content, MAX_AI_TEXT_CHARS, "内容已截断")),
                    );
                }
                if let Some(reasoning) = obj.get("reasoning").and_then(|v| v.as_str()) {
                    obj.insert(
                        "reasoning".into(),
                        Value::String(trim_head(reasoning, MAX_AI_TEXT_CHARS, "推理已截断")),
                    );
                }
            } else {
                if let Some(args) = obj.get("args").and_then(|v| v.as_str()) {
                    obj.insert(
                        "args".into(),
                        Value::String(trim_head(args, MAX_AI_TEXT_CHARS, "参数已截断")),
                    );
                }
                if let Some(result) = obj.get("result").and_then(|v| v.as_str()) {
                    obj.insert(
                        "result".into(),
                        Value::String(trim_head(result, MAX_AI_TEXT_CHARS, "结果已截断")),
                    );
                }
            }
            Value::Object(obj)
        })
        .collect();
    Value::Array(items)
}

/// 写入前统一截断 payload，避免前后端两套 trim。
pub fn sanitize_payload_json(raw: &str) -> String {
    let mut value: Value = serde_json::from_str(raw).unwrap_or_else(|_| json!({}));
    let Some(obj) = value.as_object_mut() else {
        return "{}".to_string();
    };

    if let Some(output) = obj.get("output").and_then(|v| v.as_str()) {
        obj.insert(
            "output".into(),
            Value::String(trim_tail(output, MAX_OUTPUT_CHARS, "输出已截断")),
        );
    }
    if let Some(reasoning) = obj.get("reasoning").and_then(|v| v.as_str()) {
        obj.insert(
            "reasoning".into(),
            Value::String(trim_head(reasoning, MAX_AI_TEXT_CHARS, "推理已截断")),
        );
    }
    if let Some(summary) = obj.get("aiThreadSummary").and_then(|v| v.as_str()) {
        obj.insert(
            "aiThreadSummary".into(),
            Value::String(trim_head(summary, MAX_AI_TEXT_CHARS, "摘要已截断")),
        );
    }
    if let Some(thread) = obj.get("aiThread").cloned() {
        obj.insert("aiThread".into(), trim_ai_thread(&thread));
    }

    // 运行期字段不应落盘
    obj.remove("liveOutput");
    obj.remove("attachedListing");
    obj.remove("marker");

    serde_json::to_string(&value).unwrap_or_else(|_| "{}".to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl Storage {
    pub fn terminal_history_upsert_blocks(
        &self,
        session_id: &str,
        workspace_id: Option<&str>,
        blocks: &[TerminalHistoryBlockRecord],
        policy: &TerminalHistoryRetainPolicy,
    ) -> OmniResult<()> {
        if session_id.is_empty() {
            return Ok(());
        }
        let policy = policy.normalized();
        let updated_at = now_ms();
        let conn = self.conn();
        let tx = conn.unchecked_transaction().map_err(map_sqlite)?;

        tx.execute(
            "INSERT INTO terminal_history_sessions (session_id, workspace_id, updated_at)
             VALUES (?1, ?2, ?3)
             ON CONFLICT(session_id) DO UPDATE SET
               workspace_id = COALESCE(excluded.workspace_id, terminal_history_sessions.workspace_id),
               updated_at = excluded.updated_at",
            params![session_id, workspace_id, updated_at],
        )
        .map_err(map_sqlite)?;

        for block in blocks {
            if block.id.is_empty() {
                continue;
            }
            let payload = sanitize_payload_json(&block.payload);
            let kind = if block.kind.is_empty() {
                "shell"
            } else {
                block.kind.as_str()
            };
            tx.execute(
                "INSERT INTO terminal_history_blocks (
                    id, session_id, kind, command, title, status, exit_code, cwd,
                    timestamp, completed_at, payload, updated_at
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                   session_id = excluded.session_id,
                   kind = excluded.kind,
                   command = excluded.command,
                   title = excluded.title,
                   status = excluded.status,
                   exit_code = excluded.exit_code,
                   cwd = excluded.cwd,
                   timestamp = excluded.timestamp,
                   completed_at = excluded.completed_at,
                   payload = excluded.payload,
                   updated_at = excluded.updated_at",
                params![
                    block.id,
                    session_id,
                    kind,
                    block.command,
                    block.title,
                    block.status,
                    block.exit_code,
                    block.cwd,
                    block.timestamp,
                    block.completed_at,
                    payload,
                    updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        }

        // 会话内超限：删最旧块
        let max_blocks = policy.max_blocks_per_session as i64;
        tx.execute(
            "DELETE FROM terminal_history_blocks
             WHERE session_id = ?1
               AND id NOT IN (
                 SELECT id FROM terminal_history_blocks
                 WHERE session_id = ?1
                 ORDER BY timestamp DESC, updated_at DESC
                 LIMIT ?2
               )",
            params![session_id, max_blocks],
        )
        .map_err(map_sqlite)?;

        // 全局会话超限：删最旧会话（CASCADE 删块）
        let max_sessions = policy.max_sessions as i64;
        tx.execute(
            "DELETE FROM terminal_history_sessions
             WHERE session_id NOT IN (
               SELECT session_id FROM terminal_history_sessions
               ORDER BY updated_at DESC
               LIMIT ?1
             )",
            params![max_sessions],
        )
        .map_err(map_sqlite)?;

        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    pub fn terminal_history_load_session(
        &self,
        session_id: &str,
    ) -> OmniResult<Vec<TerminalHistoryBlockRecord>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, session_id, kind, command, title, status, exit_code, cwd,
                        timestamp, completed_at, payload, updated_at
                 FROM terminal_history_blocks
                 WHERE session_id = ?1
                 ORDER BY timestamp ASC, updated_at ASC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([session_id], |row| {
                Ok(TerminalHistoryBlockRecord {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    kind: row.get(2)?,
                    command: row.get(3)?,
                    title: row.get(4)?,
                    status: row.get(5)?,
                    exit_code: row.get(6)?,
                    cwd: row.get(7)?,
                    timestamp: row.get(8)?,
                    completed_at: row.get(9)?,
                    payload: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    pub fn terminal_history_remove_block(&self, session_id: &str, block_id: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM terminal_history_blocks WHERE id = ?1 AND session_id = ?2",
                params![block_id, session_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn terminal_history_clear_session(&self, session_id: &str) -> OmniResult<()> {
        // CASCADE 会删块；显式删 session 行
        self.conn()
            .execute(
                "DELETE FROM terminal_history_sessions WHERE session_id = ?1",
                params![session_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn terminal_history_clear_all(&self) -> OmniResult<()> {
        let conn = self.conn();
        let tx = conn.unchecked_transaction().map_err(map_sqlite)?;
        tx.execute("DELETE FROM terminal_history_blocks", [])
            .map_err(map_sqlite)?;
        tx.execute("DELETE FROM terminal_history_sessions", [])
            .map_err(map_sqlite)?;
        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    pub fn terminal_history_counts(&self) -> OmniResult<(u32, u32)> {
        let sessions: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM terminal_history_sessions",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        let blocks: i64 = self
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM terminal_history_blocks",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        Ok((sessions.max(0) as u32, blocks.max(0) as u32))
    }

    pub fn terminal_history_prune(&self, policy: &TerminalHistoryRetainPolicy) -> OmniResult<()> {
        let policy = policy.normalized();
        let conn = self.conn();
        let tx = conn.unchecked_transaction().map_err(map_sqlite)?;
        let max_sessions = policy.max_sessions as i64;
        let max_blocks = policy.max_blocks_per_session as i64;

        tx.execute(
            "DELETE FROM terminal_history_sessions
             WHERE session_id NOT IN (
               SELECT session_id FROM terminal_history_sessions
               ORDER BY updated_at DESC
               LIMIT ?1
             )",
            params![max_sessions],
        )
        .map_err(map_sqlite)?;

        // 每个会话裁块：用子查询按 session 处理
        let session_ids: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT session_id FROM terminal_history_sessions")
                .map_err(map_sqlite)?;
            let rows = stmt
                .query_map([], |row| row.get(0))
                .map_err(map_sqlite)?;
            let mut ids = Vec::new();
            for row in rows {
                ids.push(row.map_err(map_sqlite)?);
            }
            ids
        };

        for sid in session_ids {
            tx.execute(
                "DELETE FROM terminal_history_blocks
                 WHERE session_id = ?1
                   AND id NOT IN (
                     SELECT id FROM terminal_history_blocks
                     WHERE session_id = ?1
                     ORDER BY timestamp DESC, updated_at DESC
                     LIMIT ?2
                   )",
                params![sid, max_blocks],
            )
            .map_err(map_sqlite)?;
        }

        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_block(id: &str, session: &str, ts: i64, output: &str) -> TerminalHistoryBlockRecord {
        TerminalHistoryBlockRecord {
            id: id.into(),
            session_id: session.into(),
            kind: "shell".into(),
            command: "echo hi".into(),
            title: None,
            status: "completed".into(),
            exit_code: Some(0),
            cwd: "/tmp".into(),
            timestamp: ts,
            completed_at: Some(ts),
            payload: json!({ "output": output }).to_string(),
            updated_at: ts,
        }
    }

    #[test]
    fn upsert_load_and_prune_blocks() {
        let storage = Storage::open_in_memory().unwrap();
        let policy = TerminalHistoryRetainPolicy {
            max_sessions: 2,
            max_blocks_per_session: 20,
        };

        storage
            .terminal_history_upsert_blocks(
                "s1",
                None,
                &[
                    sample_block("b1", "s1", 100, "out1"),
                    sample_block("b2", "s1", 200, "out2"),
                ],
                &policy,
            )
            .unwrap();

        let loaded = storage.terminal_history_load_session("s1").unwrap();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].id, "b1");
        assert!(loaded[0].payload.contains("out1"));

        // 超限会话淘汰
        storage
            .terminal_history_upsert_blocks(
                "s2",
                None,
                &[sample_block("c1", "s2", 300, "x")],
                &policy,
            )
            .unwrap();
        storage
            .terminal_history_upsert_blocks(
                "s3",
                None,
                &[sample_block("d1", "s3", 400, "y")],
                &policy,
            )
            .unwrap();

        let (sessions, _) = storage.terminal_history_counts().unwrap();
        assert_eq!(sessions, 2);
        assert!(storage.terminal_history_load_session("s1").unwrap().is_empty());
    }

    #[test]
    fn sanitize_truncates_long_output() {
        let long = "a".repeat(20_000);
        let raw = json!({ "output": long, "liveOutput": { "x": 1 }, "attachedListing": [] }).to_string();
        let cleaned = sanitize_payload_json(&raw);
        let v: Value = serde_json::from_str(&cleaned).unwrap();
        let out = v["output"].as_str().unwrap();
        assert!(out.len() < 20_000);
        assert!(out.contains("输出已截断"));
        assert!(v.get("liveOutput").is_none());
        assert!(v.get("attachedListing").is_none());
    }

    #[test]
    fn remove_and_clear() {
        let storage = Storage::open_in_memory().unwrap();
        let policy = TerminalHistoryRetainPolicy::default();
        storage
            .terminal_history_upsert_blocks(
                "s1",
                None,
                &[
                    sample_block("b1", "s1", 1, "a"),
                    sample_block("b2", "s1", 2, "b"),
                ],
                &policy,
            )
            .unwrap();
        storage.terminal_history_remove_block("s1", "b1").unwrap();
        assert_eq!(storage.terminal_history_load_session("s1").unwrap().len(), 1);
        storage.terminal_history_clear_session("s1").unwrap();
        assert!(storage.terminal_history_load_session("s1").unwrap().is_empty());
    }
}
