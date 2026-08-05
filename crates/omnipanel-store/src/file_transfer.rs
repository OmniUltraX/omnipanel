use crate::storage::{map_sqlite, Storage};
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};

/// 文件传输任务的持久化记录（扁平结构，对应 `file_transfer_jobs` 表）。
///
/// 与 `src-tauri/src/commands/file_transfer/types.rs::FileTransferJob` 一一对应，
/// 但把 `source` / `dest` 两个 `FileTransferEndpoint` 展开为 `src_*` / `dst_*` 列。
/// `op` / `route` / `state` 用字符串存储（小写驼峰），由调用方与枚举互转。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct FileTransferJobRecord {
    pub id: String,
    pub batch_id: String,
    /// "copy" | "move"
    pub op: String,
    pub src_connection_id: String,
    pub src_path: String,
    /// "file" | "dir"
    pub src_kind: String,
    pub src_name: String,
    pub dst_connection_id: String,
    pub dst_path: String,
    pub dst_kind: String,
    pub dst_name: String,
    /// "fastpath" | "remoteDirect" | "relay"
    pub route: String,
    pub route_reason: String,
    /// "queued" | "probing" | "running" | "done" | "error" | "cancelled"
    pub state: String,
    pub bytes_done: f64,
    pub bytes_total: Option<f64>,
    pub speed_bps: Option<f64>,
    pub progress: f64,
    pub error: Option<String>,
    pub source_fingerprint: Option<String>,
    pub partial_path: Option<String>,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

const DONE_KEEP: u32 = 20;

impl Storage {
    /// 写入或更新一条传输任务记录。
    pub fn upsert_file_transfer_job(&self, rec: &FileTransferJobRecord) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO file_transfer_jobs (
                    id, batch_id, op,
                    src_connection_id, src_path, src_kind, src_name,
                    dst_connection_id, dst_path, dst_kind, dst_name,
                    route, route_reason, state,
                    bytes_done, bytes_total, speed_bps, progress,
                    error, source_fingerprint, partial_path,
                    created_at, updated_at
                 ) VALUES (
                    ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11,
                    ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23
                 )
                 ON CONFLICT(id) DO UPDATE SET
                    batch_id=excluded.batch_id,
                    op=excluded.op,
                    src_connection_id=excluded.src_connection_id,
                    src_path=excluded.src_path,
                    src_kind=excluded.src_kind,
                    src_name=excluded.src_name,
                    dst_connection_id=excluded.dst_connection_id,
                    dst_path=excluded.dst_path,
                    dst_kind=excluded.dst_kind,
                    dst_name=excluded.dst_name,
                    route=excluded.route,
                    route_reason=excluded.route_reason,
                    state=excluded.state,
                    bytes_done=excluded.bytes_done,
                    bytes_total=excluded.bytes_total,
                    speed_bps=excluded.speed_bps,
                    progress=excluded.progress,
                    error=excluded.error,
                    source_fingerprint=excluded.source_fingerprint,
                    partial_path=excluded.partial_path,
                    updated_at=excluded.updated_at",
                rusqlite::params![
                    rec.id,
                    rec.batch_id,
                    rec.op,
                    rec.src_connection_id,
                    rec.src_path,
                    rec.src_kind,
                    rec.src_name,
                    rec.dst_connection_id,
                    rec.dst_path,
                    rec.dst_kind,
                    rec.dst_name,
                    rec.route,
                    rec.route_reason,
                    rec.state,
                    rec.bytes_done,
                    rec.bytes_total,
                    rec.speed_bps,
                    rec.progress,
                    rec.error,
                    rec.source_fingerprint,
                    rec.partial_path,
                    rec.created_at,
                    rec.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 删除单条任务。
    pub fn delete_file_transfer_job(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM file_transfer_jobs WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 列出所有未完成 + 最近 `DONE_KEEP` 条已完成/取消的任务。
    /// 用于应用启动时恢复传输状态（断点续传握手的基础）。
    pub fn list_active_file_transfer_jobs(&self) -> OmniResult<Vec<FileTransferJobRecord>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, batch_id, op,
                        src_connection_id, src_path, src_kind, src_name,
                        dst_connection_id, dst_path, dst_kind, dst_name,
                        route, route_reason, state,
                        bytes_done, bytes_total, speed_bps, progress,
                        error, source_fingerprint, partial_path,
                        created_at, updated_at
                 FROM file_transfer_jobs
                 WHERE state IN ('queued', 'probing', 'running', 'error')
                    OR id IN (
                        SELECT id FROM file_transfer_jobs
                        WHERE state IN ('done', 'cancelled')
                        ORDER BY created_at DESC
                        LIMIT ?1
                    )
                 ORDER BY created_at DESC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([DONE_KEEP], |row| {
                Ok(FileTransferJobRecord {
                    id: row.get(0)?,
                    batch_id: row.get(1)?,
                    op: row.get(2)?,
                    src_connection_id: row.get(3)?,
                    src_path: row.get(4)?,
                    src_kind: row.get(5)?,
                    src_name: row.get(6)?,
                    dst_connection_id: row.get(7)?,
                    dst_path: row.get(8)?,
                    dst_kind: row.get(9)?,
                    dst_name: row.get(10)?,
                    route: row.get(11)?,
                    route_reason: row.get(12)?,
                    state: row.get(13)?,
                    bytes_done: row.get(14)?,
                    bytes_total: row.get(15)?,
                    speed_bps: row.get(16)?,
                    progress: row.get(17)?,
                    error: row.get(18)?,
                    source_fingerprint: row.get(19)?,
                    partial_path: row.get(20)?,
                    created_at: row.get::<_, i64>(21)?,
                    updated_at: row.get::<_, i64>(22)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 删除所有已完成 / 取消的任务。
    pub fn clear_finished_file_transfer_jobs(&self) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM file_transfer_jobs WHERE state IN ('done', 'cancelled')",
                [],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }
}
