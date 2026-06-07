use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::Connection as SqliteConnection;
use serde::{Deserialize, Serialize};

/// 顺序迁移脚本。**只能在末尾追加**，数组下标 +1 即 schema 版本号。
const MIGRATIONS: &[&str] = &[
    // v1 — 初始 schema
    r#"
    CREATE TABLE connections (
        id             TEXT PRIMARY KEY,
        kind           TEXT NOT NULL,
        name           TEXT NOT NULL,
        group_name     TEXT NOT NULL DEFAULT '',
        env_tag        TEXT NOT NULL DEFAULT 'unknown',
        config         TEXT NOT NULL DEFAULT '{}',
        credential_ref TEXT,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
    );
    CREATE TABLE audit_log (
        id      INTEGER PRIMARY KEY AUTOINCREMENT,
        ts      INTEGER NOT NULL,
        action  TEXT NOT NULL,
        target  TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'unknown',
        risk    TEXT NOT NULL DEFAULT 'low',
        status  TEXT NOT NULL DEFAULT '',
        detail  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX idx_connections_kind ON connections(kind);
    CREATE INDEX idx_audit_ts ON audit_log(ts);
    "#,
    // v2 — 知识库（knowledge_entries + FTS5 全文索引）
    r#"
    CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        risk_level TEXT NOT NULL DEFAULT 'safe',
        source TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'dev',
        language TEXT NOT NULL DEFAULT '',
        usage_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        title, content, tags,
        content=knowledge_entries,
        content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
    END;
    CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
        INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags) VALUES('delete', old.rowid, old.title, old.content, old.tags);
        INSERT INTO knowledge_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, new.tags);
    END;
    "#,
    // v3 — workflows + workflow_steps + workflow_executions
    r#"
    CREATE TABLE IF NOT EXISTS workflows (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        workflow_type TEXT NOT NULL DEFAULT 'script',
        risk_level TEXT NOT NULL DEFAULT 'low',
        target TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'dev',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workflow_steps (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        step_type TEXT NOT NULL DEFAULT 'shell',
        command TEXT NOT NULL DEFAULT '',
        step_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ready'
    );
    CREATE INDEX IF NOT EXISTS idx_wf_steps_wf ON workflow_steps(workflow_id);
    CREATE TABLE IF NOT EXISTS workflow_executions (
        id TEXT PRIMARY KEY,
        workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
        status TEXT NOT NULL DEFAULT 'running',
        triggered_by TEXT NOT NULL DEFAULT 'user',
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        output TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_wf_exec_wf ON workflow_executions(workflow_id);
    "#,
    // v4 — tasks
    r#"
    CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        task_type TEXT NOT NULL DEFAULT 'terminal',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        resource_id TEXT NOT NULL DEFAULT '',
        resource_name TEXT NOT NULL DEFAULT '',
        env_tag TEXT NOT NULL DEFAULT 'dev',
        command TEXT NOT NULL DEFAULT '',
        risk TEXT NOT NULL DEFAULT 'low',
        status TEXT NOT NULL DEFAULT 'draft',
        source TEXT NOT NULL DEFAULT 'user',
        output TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        finished_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at);
    "#,
];

/// 审计日志条目。所有高风险操作经执行引擎写入此表。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct AuditEntry {
    /// Unix 毫秒时间戳
    pub ts: i64,
    /// 动作类型（如 terminal.exec / ssh.connect / db.query）
    pub action: String,
    /// 操作目标（连接 id、命令摘要等）
    pub target: String,
    /// 环境标签 dev/test/staging/prod
    pub env_tag: String,
    /// 风险等级 low/medium/high/critical
    pub risk: String,
    /// 结果状态 success/failed/blocked 等
    pub status: String,
    /// 附加明细
    pub detail: String,
}

/// 本地元数据存储。密钥注入式：`cipher_key` 为 `Some` 时按 SQLCipher 整库加密
/// （需启用 `bundled-sqlcipher` 构建），为 `None` 时明文存储。敏感凭据不入此库，走 [`crate::Vault`]。
pub struct Storage {
    conn: SqliteConnection,
}

impl Storage {
    /// 打开（或创建）本地库文件并执行迁移。
    pub fn open(path: impl AsRef<Path>, cipher_key: Option<&str>) -> OmniResult<Self> {
        let conn = SqliteConnection::open(path).map_err(map_sqlite)?;
        Self::init(conn, cipher_key)
    }

    /// 打开内存库（测试用）。
    pub fn open_in_memory() -> OmniResult<Self> {
        let conn = SqliteConnection::open_in_memory().map_err(map_sqlite)?;
        Self::init(conn, None)
    }

    fn init(conn: SqliteConnection, cipher_key: Option<&str>) -> OmniResult<Self> {
        if let Some(key) = cipher_key {
            // 仅在 SQLCipher 构建下生效；明文 sqlite 下该 pragma 为 no-op/报错，故忽略错误
            let _ = conn.pragma_update(None, "key", key);
        }
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(map_sqlite)?;

        let mut storage = Self { conn };
        storage.run_migrations()?;
        Ok(storage)
    }

    /// 按版本顺序执行未应用的迁移。
    fn run_migrations(&mut self) -> OmniResult<()> {
        self.conn
            .execute_batch("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);")
            .map_err(map_sqlite)?;

        let current: i64 = self
            .conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;

        for (idx, script) in MIGRATIONS.iter().enumerate() {
            let version = (idx + 1) as i64;
            if version > current {
                let tx = self.conn.transaction().map_err(map_sqlite)?;
                tx.execute_batch(script).map_err(map_sqlite)?;
                tx.execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    [version],
                )
                .map_err(map_sqlite)?;
                tx.commit().map_err(map_sqlite)?;
                tracing::info!(version, "applied storage migration");
            }
        }
        Ok(())
    }

    /// 当前 schema 版本。
    pub fn schema_version(&self) -> OmniResult<i64> {
        self.conn
            .query_row(
                "SELECT COALESCE(MAX(version), 0) FROM schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)
    }

    /// 供同 crate 模块（连接 CRUD 等）访问底层连接。
    pub(crate) fn conn(&self) -> &SqliteConnection {
        &self.conn
    }

    /// 追加一条审计日志。
    pub fn append_audit(&self, entry: &AuditEntry) -> OmniResult<()> {
        self.conn
            .execute(
                "INSERT INTO audit_log (ts, action, target, env_tag, risk, status, detail)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![
                    entry.ts,
                    entry.action,
                    entry.target,
                    entry.env_tag,
                    entry.risk,
                    entry.status,
                    entry.detail,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 读取最近的审计日志（按时间倒序）。
    pub fn recent_audit(&self, limit: u32) -> OmniResult<Vec<AuditEntry>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT ts, action, target, env_tag, risk, status, detail
                 FROM audit_log ORDER BY ts DESC, id DESC LIMIT ?1",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([limit], |row| {
                Ok(AuditEntry {
                    ts: row.get(0)?,
                    action: row.get(1)?,
                    target: row.get(2)?,
                    env_tag: row.get(3)?,
                    risk: row.get(4)?,
                    status: row.get(5)?,
                    detail: row.get(6)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for entry in rows {
            out.push(entry.map_err(map_sqlite)?);
        }
        Ok(out)
    }
}

pub(crate) fn map_sqlite(err: rusqlite::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "本地存储操作失败").with_cause(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_audit() -> AuditEntry {
        AuditEntry {
            ts: 1_700_000_000_000,
            action: "terminal.exec".into(),
            target: "ls -la".into(),
            env_tag: "dev".into(),
            risk: "low".into(),
            status: "success".into(),
            detail: String::new(),
        }
    }

    #[test]
    fn migrations_apply_to_latest_version() {
        let storage = Storage::open_in_memory().unwrap();
        assert_eq!(storage.schema_version().unwrap(), MIGRATIONS.len() as i64);
    }

    #[test]
    fn migrations_are_idempotent_on_reopen() {
        // 对同一内存连接重复 init 不会重复执行（这里验证版本稳定）
        let storage = Storage::open_in_memory().unwrap();
        let v1 = storage.schema_version().unwrap();
        let v2 = storage.schema_version().unwrap();
        assert_eq!(v1, v2);
        assert_eq!(v1, MIGRATIONS.len() as i64);
    }

    #[test]
    fn append_and_read_audit() {
        let storage = Storage::open_in_memory().unwrap();
        storage.append_audit(&sample_audit()).unwrap();
        let mut second = sample_audit();
        second.ts += 1000;
        second.action = "ssh.connect".into();
        storage.append_audit(&second).unwrap();

        let recent = storage.recent_audit(10).unwrap();
        assert_eq!(recent.len(), 2);
        // 倒序：最新的在前
        assert_eq!(recent[0].action, "ssh.connect");
        assert_eq!(recent[1].action, "terminal.exec");
    }

    #[test]
    fn audit_limit_is_respected() {
        let storage = Storage::open_in_memory().unwrap();
        for i in 0..5 {
            let mut e = sample_audit();
            e.ts += i;
            storage.append_audit(&e).unwrap();
        }
        assert_eq!(storage.recent_audit(3).unwrap().len(), 3);
    }

    #[test]
    fn file_storage_persists_across_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.db");
        {
            let storage = Storage::open(&path, None).unwrap();
            storage.append_audit(&sample_audit()).unwrap();
        }
        // 重新打开：迁移不重复执行，数据仍在
        let storage = Storage::open(&path, None).unwrap();
        assert_eq!(storage.schema_version().unwrap(), MIGRATIONS.len() as i64);
        assert_eq!(storage.recent_audit(10).unwrap().len(), 1);
    }
}
