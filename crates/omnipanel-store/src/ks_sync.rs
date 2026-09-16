//! 知识源管线通用状态（v40 建表）：按 `source_key` 隔离的多源配置与文件指纹。
//!
//! - `ks_source_config`：`source_key` 主键（`plugin:<plugin_id>:<source_id>`，
//!   原生思源为 `siyuan`）；密钥只存 Vault credential_ref。
//! - `ks_file_state`：`(source_key, file_key)` 联合主键，`fingerprint` 为适配器
//!   提供的变更指纹（mtime 文本 / ETag / updatedAt），字符串比对。

use rusqlite::{OptionalExtension, params};

use crate::storage::{Storage, map_sqlite};
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};
use specta::Type;

/// 知识源配置。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KsSourceConfig {
    pub source_key: String,
    pub display_name: String,
    /// 适配器种类：`siyuan-local` / `plugin`（后续 `siyuan-s3` 等）。
    pub adapter: String,
    /// 适配器配置 JSON（工作空间路径 / S3 / token 引用等；密钥进 Vault）。
    pub config_json: String,
    pub secret_ref: String,
    pub last_sync_at: i64,
    pub last_report_json: String,
}

/// 单个已同步文件的增量状态。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct KsFileState {
    pub source_key: String,
    pub file_key: String,
    pub box_id: String,
    pub rel_path: String,
    pub fingerprint: String,
    pub entry_id: String,
    /// "synced" | "archived"
    pub status: String,
    pub updated_at: i64,
}

impl Storage {
    pub fn ks_config_get(&self, source_key: &str) -> OmniResult<Option<KsSourceConfig>> {
        self.conn()
            .query_row(
                "SELECT source_key, display_name, adapter, config_json, secret_ref, last_sync_at, last_report_json FROM ks_source_config WHERE source_key = ?1",
                [source_key],
                |r| {
                    Ok(KsSourceConfig {
                        source_key: r.get(0)?,
                        display_name: r.get(1)?,
                        adapter: r.get(2)?,
                        config_json: r.get(3)?,
                        secret_ref: r.get(4)?,
                        last_sync_at: r.get(5)?,
                        last_report_json: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(map_sqlite)
    }

    pub fn ks_config_save(&self, cfg: &KsSourceConfig) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO ks_source_config (source_key, display_name, adapter, config_json, secret_ref, last_sync_at, last_report_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(source_key) DO UPDATE SET display_name = excluded.display_name, adapter = excluded.adapter, config_json = excluded.config_json, secret_ref = excluded.secret_ref, last_sync_at = excluded.last_sync_at, last_report_json = excluded.last_report_json",
                params![
                    cfg.source_key,
                    cfg.display_name,
                    cfg.adapter,
                    cfg.config_json,
                    cfg.secret_ref,
                    cfg.last_sync_at,
                    cfg.last_report_json,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn ks_file_state_get(
        &self,
        source_key: &str,
        file_key: &str,
    ) -> OmniResult<Option<KsFileState>> {
        self.conn()
            .query_row(
                "SELECT source_key, file_key, box_id, rel_path, fingerprint, entry_id, status, updated_at FROM ks_file_state WHERE source_key = ?1 AND file_key = ?2",
                params![source_key, file_key],
                |r| {
                    Ok(KsFileState {
                        source_key: r.get(0)?,
                        file_key: r.get(1)?,
                        box_id: r.get(2)?,
                        rel_path: r.get(3)?,
                        fingerprint: r.get(4)?,
                        entry_id: r.get(5)?,
                        status: r.get(6)?,
                        updated_at: r.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(map_sqlite)
    }

    pub fn ks_file_state_upsert(&self, state: &KsFileState) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO ks_file_state (source_key, file_key, box_id, rel_path, fingerprint, entry_id, status, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(source_key, file_key) DO UPDATE SET box_id = excluded.box_id, rel_path = excluded.rel_path, fingerprint = excluded.fingerprint, entry_id = excluded.entry_id, status = excluded.status, updated_at = excluded.updated_at",
                params![
                    state.source_key,
                    state.file_key,
                    state.box_id,
                    state.rel_path,
                    state.fingerprint,
                    state.entry_id,
                    state.status,
                    state.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn ks_file_state_list(&self, source_key: &str) -> OmniResult<Vec<KsFileState>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT source_key, file_key, box_id, rel_path, fingerprint, entry_id, status, updated_at FROM ks_file_state WHERE source_key = ?1 ORDER BY file_key",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([source_key], |r| {
                Ok(KsFileState {
                    source_key: r.get(0)?,
                    file_key: r.get(1)?,
                    box_id: r.get(2)?,
                    rel_path: r.get(3)?,
                    fingerprint: r.get(4)?,
                    entry_id: r.get(5)?,
                    status: r.get(6)?,
                    updated_at: r.get(7)?,
                })
            })
            .map_err(map_sqlite)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)
    }

    pub fn ks_file_state_delete(&self, source_key: &str, file_key: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM ks_file_state WHERE source_key = ?1 AND file_key = ?2",
                params![source_key, file_key],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 清空某源全部文件状态（重建同步用）。
    pub fn ks_file_state_clear(&self, source_key: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM ks_file_state WHERE source_key = ?1",
                [source_key],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    fn sample_state() -> KsFileState {
        KsFileState {
            source_key: "plugin:omni.sample.knowledge-starter:demo".to_string(),
            file_key: "doc-hello".to_string(),
            box_id: "nb-demo".to_string(),
            rel_path: "doc-hello".to_string(),
            fingerprint: "0".to_string(),
            entry_id: "ks-doc-1".to_string(),
            status: "synced".to_string(),
            updated_at: 7,
        }
    }

    #[test]
    fn config_roundtrip() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(storage.ks_config_get("plugin:x:y").unwrap().is_none());
        storage
            .ks_config_save(&KsSourceConfig {
                source_key: "plugin:x:y".to_string(),
                display_name: "演示".to_string(),
                adapter: "plugin".to_string(),
                config_json: "{}".to_string(),
                secret_ref: String::new(),
                last_sync_at: 0,
                last_report_json: String::new(),
            })
            .unwrap();
        let got = storage.ks_config_get("plugin:x:y").unwrap().unwrap();
        assert_eq!(got.display_name, "演示");
    }

    #[test]
    fn file_state_crud_scoped() {
        let storage = Storage::open_in_memory().unwrap();
        let state = sample_state();
        storage.ks_file_state_upsert(&state).unwrap();
        let got = storage
            .ks_file_state_get(&state.source_key, &state.file_key)
            .unwrap()
            .unwrap();
        assert_eq!(got.fingerprint, "0");
        // 跨源隔离：同 file_key 不同源互不可见。
        assert!(
            storage
                .ks_file_state_get("siyuan", &state.file_key)
                .unwrap()
                .is_none()
        );
        assert_eq!(
            storage.ks_file_state_list(&state.source_key).unwrap().len(),
            1
        );
        assert!(storage.ks_file_state_list("siyuan").unwrap().is_empty());
        storage
            .ks_file_state_delete(&state.source_key, &state.file_key)
            .unwrap();
        assert!(
            storage
                .ks_file_state_list(&state.source_key)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn legacy_siyuan_rows_migrated() {
        // v40 迁移把旧表行带入通用表（source_key='siyuan'）。
        let storage = Storage::open_in_memory().unwrap();
        storage
            .conn()
            .execute(
                "INSERT INTO siyuan_file_state (file_key, box_id, rel_path, mtime_ms, entry_id, status, updated_at) VALUES ('k', 'b', 'r', 123, 'e', 'synced', 4)",
                [],
            )
            .unwrap();
        // 内存库 open 即全量迁移；此处直接验证迁移 SQL 语义。
        storage
            .conn()
            .execute(
                "INSERT OR IGNORE INTO ks_file_state (source_key, file_key, box_id, rel_path, fingerprint, entry_id, status, updated_at) SELECT 'siyuan', file_key, box_id, rel_path, CAST(mtime_ms AS TEXT), entry_id, status, updated_at FROM siyuan_file_state",
                [],
            )
            .unwrap();
        let got = storage.ks_file_state_get("siyuan", "k").unwrap().unwrap();
        assert_eq!(got.fingerprint, "123");
        assert_eq!(got.entry_id, "e");
    }
}
