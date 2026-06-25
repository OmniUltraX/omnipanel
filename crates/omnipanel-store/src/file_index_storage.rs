use std::path::{Path, PathBuf};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::Connection as SqliteConnection;

use crate::file_index::{
    FileIndexBatchItem, FileIndexSearchResult, FileIndexStatus, FileIndexEntry,
};
use crate::paths::{default_file_index_storage_dir, map_io};
use crate::storage::{Storage, map_sqlite};

const FILE_INDEX_MIGRATIONS: &[&str] = &[r#"
    CREATE TABLE IF NOT EXISTS file_index_meta (
        connection_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'idle',
        root_path TEXT NOT NULL DEFAULT '',
        indexed_count INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        started_at INTEGER NOT NULL DEFAULT 0,
        finished_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS file_index_entries (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id TEXT NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        modified INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL DEFAULT '',
        UNIQUE(connection_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_file_index_conn ON file_index_entries(connection_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS file_index_fts USING fts5(
        name, path, content,
        content=file_index_entries,
        content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS file_index_ai AFTER INSERT ON file_index_entries BEGIN
        INSERT INTO file_index_fts(rowid, name, path, content) VALUES (new.rowid, new.name, new.path, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS file_index_ad AFTER DELETE ON file_index_entries BEGIN
        INSERT INTO file_index_fts(file_index_fts, rowid, name, path, content) VALUES('delete', old.rowid, old.name, old.path, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS file_index_au AFTER UPDATE ON file_index_entries BEGIN
        INSERT INTO file_index_fts(file_index_fts, rowid, name, path, content) VALUES('delete', old.rowid, old.name, old.path, old.content);
        INSERT INTO file_index_fts(rowid, name, path, content) VALUES (new.rowid, new.name, new.path, new.content);
    END;
"#];

/// 文件索引独立 SQLite 存储（与主元数据库分离，目录可配置）。
pub struct FileIndexStorage {
    conn: SqliteConnection,
    db_path: PathBuf,
}

impl FileIndexStorage {
    pub fn open(path: impl AsRef<Path>) -> OmniResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(map_io)?;
        }
        let conn = SqliteConnection::open(&path).map_err(map_sqlite)?;
        let _ = conn.pragma_update(None, "journal_mode", "WAL");
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(map_sqlite)?;
        let mut storage = Self { conn, db_path: path };
        storage.run_migrations()?;
        Ok(storage)
    }

    pub fn open_in_memory() -> OmniResult<Self> {
        let conn = SqliteConnection::open_in_memory().map_err(map_sqlite)?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(map_sqlite)?;
        let mut storage = Self {
            conn,
            db_path: PathBuf::from(":memory:"),
        };
        storage.run_migrations()?;
        Ok(storage)
    }

    pub fn open_at_dir(dir: &str) -> OmniResult<Self> {
        let path = resolve_file_index_db_path(dir)?;
        Self::open(path)
    }

    pub fn database_path(&self) -> &Path {
        &self.db_path
    }

    pub fn is_empty(&self) -> OmniResult<bool> {
        let count: i64 = self
            .conn
            .query_row(
                "SELECT COUNT(*) FROM file_index_meta",
                [],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;
        Ok(count == 0)
    }

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
        for (i, sql) in FILE_INDEX_MIGRATIONS.iter().enumerate() {
            let version = (i + 1) as i64;
            if version <= current {
                continue;
            }
            self.conn.execute_batch(sql).map_err(map_sqlite)?;
            self.conn
                .execute(
                    "INSERT INTO schema_version (version) VALUES (?1)",
                    [version],
                )
                .map_err(map_sqlite)?;
        }
        Ok(())
    }

    pub fn get_file_index_status(&self, connection_id: &str) -> OmniResult<FileIndexStatus> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT connection_id, status, root_path, indexed_count, error, started_at, finished_at
                 FROM file_index_meta WHERE connection_id = ?1",
            )
            .map_err(map_sqlite)?;
        let row = stmt.query_row([connection_id], |row| {
            Ok(FileIndexStatus {
                connection_id: row.get(0)?,
                status: row.get(1)?,
                root_path: row.get(2)?,
                indexed_count: row.get(3)?,
                error: row.get(4)?,
                started_at: row.get(5)?,
                finished_at: row.get(6)?,
            })
        });
        match row {
            Ok(status) => Ok(status),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(FileIndexStatus {
                connection_id: connection_id.to_string(),
                status: "idle".into(),
                root_path: String::new(),
                indexed_count: 0,
                error: String::new(),
                started_at: 0,
                finished_at: 0,
            }),
            Err(e) => Err(map_sqlite(e)),
        }
    }

    pub fn begin_file_index(
        &self,
        connection_id: &str,
        root_path: &str,
        started_at: i64,
    ) -> OmniResult<()> {
        let conn = &self.conn;
        conn.execute(
            "DELETE FROM file_index_entries WHERE connection_id = ?1",
            [connection_id],
        )
        .map_err(map_sqlite)?;
        conn.execute(
            "INSERT INTO file_index_meta (connection_id, status, root_path, indexed_count, error, started_at, finished_at)
             VALUES (?1, 'building', ?2, 0, '', ?3, 0)
             ON CONFLICT(connection_id) DO UPDATE SET
                status = 'building',
                root_path = excluded.root_path,
                indexed_count = 0,
                error = '',
                started_at = excluded.started_at,
                finished_at = 0",
            rusqlite::params![connection_id, root_path, started_at],
        )
        .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn insert_file_index_batch(
        &self,
        connection_id: &str,
        items: &[FileIndexBatchItem],
    ) -> OmniResult<()> {
        if items.is_empty() {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction().map_err(map_sqlite)?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO file_index_entries (connection_id, path, name, kind, size, modified, content)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(connection_id, path) DO UPDATE SET
                        name = excluded.name,
                        kind = excluded.kind,
                        size = excluded.size,
                        modified = excluded.modified,
                        content = excluded.content",
                )
                .map_err(map_sqlite)?;
            for item in items {
                stmt.execute(rusqlite::params![
                    connection_id,
                    item.path,
                    item.name,
                    item.kind,
                    item.size as i64,
                    item.modified,
                    item.content,
                ])
                .map_err(map_sqlite)?;
            }
        }
        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    pub fn update_file_index_progress(
        &self,
        connection_id: &str,
        indexed_count: i64,
    ) -> OmniResult<()> {
        self.conn
            .execute(
                "UPDATE file_index_meta SET indexed_count = ?2 WHERE connection_id = ?1",
                rusqlite::params![connection_id, indexed_count],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn finish_file_index(
        &self,
        connection_id: &str,
        indexed_count: i64,
        finished_at: i64,
        error: Option<&str>,
    ) -> OmniResult<()> {
        let (status, err) = if let Some(msg) = error.filter(|s| !s.is_empty()) {
            ("failed", msg.to_string())
        } else {
            ("ready", String::new())
        };
        self.conn
            .execute(
                "UPDATE file_index_meta SET status = ?2, indexed_count = ?3, error = ?4, finished_at = ?5
                 WHERE connection_id = ?1",
                rusqlite::params![connection_id, status, indexed_count, err, finished_at],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn clear_file_index(&self, connection_id: &str) -> OmniResult<()> {
        self.conn
            .execute(
                "DELETE FROM file_index_entries WHERE connection_id = ?1",
                [connection_id],
            )
            .map_err(map_sqlite)?;
        self.conn
            .execute(
                "DELETE FROM file_index_meta WHERE connection_id = ?1",
                [connection_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn search_file_index(
        &self,
        connection_id: &str,
        query: &str,
        limit: i64,
    ) -> OmniResult<Vec<FileIndexSearchResult>> {
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let limit = limit.clamp(1, 500);
        let fts_query: String = query
            .split_whitespace()
            .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ");

        let sql = "SELECT e.connection_id, e.path, e.name, e.kind, e.size, e.modified,
                          snippet(file_index_fts, 2, '<mark>', '</mark>', '...', 32) as snip
                   FROM file_index_fts f
                   JOIN file_index_entries e ON e.rowid = f.rowid
                   WHERE file_index_fts MATCH ?1 AND e.connection_id = ?2
                   ORDER BY rank
                   LIMIT ?3";

        let mut stmt = self.conn.prepare(sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(rusqlite::params![fts_query, connection_id, limit], |row| {
                Ok(FileIndexSearchResult {
                    entry: FileIndexEntry {
                        connection_id: row.get(0)?,
                        path: row.get(1)?,
                        name: row.get(2)?,
                        kind: row.get(3)?,
                        size: row.get(4)?,
                        modified: row.get(5)?,
                    },
                    snippet: row.get(6)?,
                    score: 0,
                })
            })
            .map_err(map_sqlite)?;

        let mut results = Vec::new();
        for row in rows {
            results.push(row.map_err(map_sqlite)?);
        }

        let keywords: Vec<String> = query.split_whitespace().map(|w| w.to_lowercase()).collect();
        for result in &mut results {
            let name_lower = result.entry.name.to_lowercase();
            let path_lower = result.entry.path.to_lowercase();
            let mut s: i64 = 0;
            for kw in &keywords {
                if name_lower == *kw {
                    s += 100;
                } else if name_lower.starts_with(kw) {
                    s += 60;
                } else if name_lower.contains(kw) {
                    s += 30;
                }
                if path_lower.contains(kw) {
                    s += 10;
                }
            }
            result.score = s;
        }
        results.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.entry.path.cmp(&b.entry.path)));
        Ok(results)
    }

    /// 若当前库为空且主库仍含旧版内嵌索引表，则一次性导入。
    pub fn import_from_meta_storage_if_empty(meta: &Storage) -> OmniResult<bool> {
        if !meta_has_legacy_file_index(meta)? {
            return Ok(false);
        }
        let path = resolve_file_index_db_path("")?;
        let mut target = Self::open(&path)?;
        if !target.is_empty()? {
            return Ok(false);
        }
        import_legacy_file_index(meta, &target)?;
        Ok(true)
    }
}

pub fn resolve_file_index_db_path(configured_dir: &str) -> OmniResult<PathBuf> {
    let dir = configured_dir.trim();
    let storage_dir = if dir.is_empty() {
        default_file_index_storage_dir()?
    } else {
        let path = PathBuf::from(dir);
        std::fs::create_dir_all(&path).map_err(map_io)?;
        path
    };
    Ok(storage_dir.join("file-index.db"))
}

fn meta_table_exists(meta: &Storage, table: &str) -> OmniResult<bool> {
    let count: i64 = meta
        .conn()
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
            [table],
            |row| row.get(0),
        )
        .map_err(map_sqlite)?;
    Ok(count > 0)
}

fn meta_has_legacy_file_index(meta: &Storage) -> OmniResult<bool> {
    Ok(meta_table_exists(meta, "file_index_meta")? && meta_table_exists(meta, "file_index_entries")?)
}

fn import_legacy_file_index(meta: &Storage, target: &FileIndexStorage) -> OmniResult<()> {
    let metas: Vec<(String, String, String, i64, String, i64, i64)> = {
        let mut stmt = meta.conn().prepare(
            "SELECT connection_id, status, root_path, indexed_count, error, started_at, finished_at
             FROM file_index_meta",
        ).map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .map_err(map_sqlite)?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for (connection_id, status, root_path, indexed_count, error, started_at, finished_at) in metas {
        target.conn.execute(
            "INSERT INTO file_index_meta (connection_id, status, root_path, indexed_count, error, started_at, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                connection_id,
                status,
                root_path,
                indexed_count,
                error,
                started_at,
                finished_at
            ],
        ).map_err(map_sqlite)?;
    }

    let entries: Vec<(String, String, String, String, i64, i64, String)> = {
        let mut stmt = meta.conn().prepare(
            "SELECT connection_id, path, name, kind, size, modified, content FROM file_index_entries",
        ).map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })
            .map_err(map_sqlite)?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for (connection_id, path, name, kind, size, modified, content) in entries {
        target.conn.execute(
            "INSERT INTO file_index_entries (connection_id, path, name, kind, size, modified, content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![connection_id, path, name, kind, size, modified, content],
        ).map_err(map_sqlite)?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::file_index::FileIndexBatchItem;

    #[test]
    fn file_index_storage_roundtrip() {
        let storage = FileIndexStorage::open_in_memory().unwrap();
        storage
            .begin_file_index("conn-1", "/home", 1_000)
            .unwrap();
        storage
            .insert_file_index_batch(
                "conn-1",
                &[FileIndexBatchItem {
                    path: "/home/readme.md".into(),
                    name: "readme.md".into(),
                    kind: "file".into(),
                    size: 128,
                    modified: 2_000,
                    content: "hello omnipanel".into(),
                }],
            )
            .unwrap();
        storage.finish_file_index("conn-1", 1, 3_000, None).unwrap();

        let status = storage.get_file_index_status("conn-1").unwrap();
        assert_eq!(status.status, "ready");
        assert_eq!(status.indexed_count, 1);

        let hits = storage.search_file_index("conn-1", "omnipanel", 10).unwrap();
        assert_eq!(hits.len(), 1);
    }
}
