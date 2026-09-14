//! 思源同步：配置单行 + 文件增量状态（v39 建表）。
//!
//! - `siyuan_sync_config`：`id='default'` 单行，数据源二选一；S3 密钥只存 Vault
//!   credential_ref，不落库明文。
//! - `siyuan_file_state`：已同步文件清单（`file_key = 'local:<box>/<rel>'`），
//!   增量比对 mtime，对端删除走归档而非硬删。

use rusqlite::{OptionalExtension, params};

use crate::storage::{Storage, map_sqlite};
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};
use specta::Type;

/// 同步数据源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SiyuanSourceType {
    Local,
    S3,
}

/// 思源同步配置（`siyuan_sync_config` 表 `id='default'` 单行）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanSyncConfig {
    pub source_type: SiyuanSourceType,
    /// 本地工作空间 `data/` 目录（Local 数据源用）。
    pub workspace_path: String,
    /// S3 配置占位（S3 数据源用；`s3_secret_ref` 为 Vault credential_ref）。
    pub s3_endpoint: String,
    pub s3_bucket: String,
    pub s3_region: String,
    pub s3_access_key: String,
    pub s3_secret_ref: String,
    /// 思源云端同步目录名（默认 `main`）。
    pub s3_cloud_name: String,
    pub last_sync_at: i64,
    /// 上次同步报告 JSON（状态页展示）。
    pub last_report_json: String,
}

impl Default for SiyuanSyncConfig {
    fn default() -> Self {
        Self {
            source_type: SiyuanSourceType::Local,
            workspace_path: String::new(),
            s3_endpoint: String::new(),
            s3_bucket: String::new(),
            s3_region: String::new(),
            s3_access_key: String::new(),
            s3_secret_ref: String::new(),
            s3_cloud_name: "main".to_string(),
            last_sync_at: 0,
            last_report_json: String::new(),
        }
    }
}

impl SiyuanSyncConfig {
    /// 校验配置。Local 要求目录存在；S3 要求字段齐全（执行仍会被拒绝）。
    pub fn validate(&self) -> Result<(), String> {
        match self.source_type {
            SiyuanSourceType::Local => {
                let path = self.workspace_path.trim();
                if path.is_empty() {
                    return Err("请先配置思源工作空间 data 目录".to_string());
                }
                if !std::path::Path::new(path).is_dir() {
                    return Err(format!("思源数据目录不存在或不可读: {path}"));
                }
                Ok(())
            }
            SiyuanSourceType::S3 => {
                for (label, value) in [
                    ("endpoint", self.s3_endpoint.trim()),
                    ("bucket", self.s3_bucket.trim()),
                    ("accessKey", self.s3_access_key.trim()),
                ] {
                    if value.is_empty() {
                        return Err(format!("S3 配置不完整，缺少 {label}"));
                    }
                }
                Ok(())
            }
        }
    }
}

/// 单个已同步文件的增量状态。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SiyuanFileState {
    pub file_key: String,
    pub box_id: String,
    pub rel_path: String,
    pub mtime_ms: i64,
    pub entry_id: String,
    /// "synced" | "archived"
    pub status: String,
    pub updated_at: i64,
}

impl Storage {
    pub fn siyuan_config_get(&self) -> OmniResult<SiyuanSyncConfig> {
        let row: Option<(
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            String,
            i64,
            String,
        )> = self
            .conn()
            .query_row(
                "SELECT source_type, workspace_path, s3_endpoint, s3_bucket, s3_region, s3_access_key, s3_secret_ref, s3_cloud_name, last_sync_at, last_report_json FROM siyuan_sync_config WHERE id = 'default'",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite)?;
        let Some((
            source_type,
            workspace_path,
            s3_endpoint,
            s3_bucket,
            s3_region,
            s3_access_key,
            s3_secret_ref,
            s3_cloud_name,
            last_sync_at,
            last_report_json,
        )) = row
        else {
            return Ok(SiyuanSyncConfig::default());
        };
        Ok(SiyuanSyncConfig {
            source_type: if source_type == "s3" {
                SiyuanSourceType::S3
            } else {
                SiyuanSourceType::Local
            },
            workspace_path,
            s3_endpoint,
            s3_bucket,
            s3_region,
            s3_access_key,
            s3_secret_ref,
            s3_cloud_name,
            last_sync_at,
            last_report_json,
        })
    }

    pub fn siyuan_config_save(&self, cfg: &SiyuanSyncConfig) -> OmniResult<()> {
        let source_type = match cfg.source_type {
            SiyuanSourceType::Local => "local",
            SiyuanSourceType::S3 => "s3",
        };
        self.conn()
            .execute(
                "INSERT INTO siyuan_sync_config (id, source_type, workspace_path, s3_endpoint, s3_bucket, s3_region, s3_access_key, s3_secret_ref, s3_cloud_name, last_sync_at, last_report_json)
                 VALUES ('default', ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(id) DO UPDATE SET source_type = excluded.source_type, workspace_path = excluded.workspace_path, s3_endpoint = excluded.s3_endpoint, s3_bucket = excluded.s3_bucket, s3_region = excluded.s3_region, s3_access_key = excluded.s3_access_key, s3_secret_ref = excluded.s3_secret_ref, s3_cloud_name = excluded.s3_cloud_name, last_sync_at = excluded.last_sync_at, last_report_json = excluded.last_report_json",
                params![
                    source_type,
                    cfg.workspace_path,
                    cfg.s3_endpoint,
                    cfg.s3_bucket,
                    cfg.s3_region,
                    cfg.s3_access_key,
                    cfg.s3_secret_ref,
                    cfg.s3_cloud_name,
                    cfg.last_sync_at,
                    cfg.last_report_json,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn siyuan_file_state_get(&self, file_key: &str) -> OmniResult<Option<SiyuanFileState>> {
        self.conn()
            .query_row(
                "SELECT file_key, box_id, rel_path, mtime_ms, entry_id, status, updated_at FROM siyuan_file_state WHERE file_key = ?1",
                [file_key],
                |r| {
                    Ok(SiyuanFileState {
                        file_key: r.get(0)?,
                        box_id: r.get(1)?,
                        rel_path: r.get(2)?,
                        mtime_ms: r.get(3)?,
                        entry_id: r.get(4)?,
                        status: r.get(5)?,
                        updated_at: r.get(6)?,
                    })
                },
            )
            .optional()
            .map_err(map_sqlite)
    }

    pub fn siyuan_file_state_upsert(&self, state: &SiyuanFileState) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO siyuan_file_state (file_key, box_id, rel_path, mtime_ms, entry_id, status, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(file_key) DO UPDATE SET box_id = excluded.box_id, rel_path = excluded.rel_path, mtime_ms = excluded.mtime_ms, entry_id = excluded.entry_id, status = excluded.status, updated_at = excluded.updated_at",
                params![
                    state.file_key,
                    state.box_id,
                    state.rel_path,
                    state.mtime_ms,
                    state.entry_id,
                    state.status,
                    state.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn siyuan_file_state_list(&self) -> OmniResult<Vec<SiyuanFileState>> {
        let mut stmt = self.conn()
            .prepare(
                "SELECT file_key, box_id, rel_path, mtime_ms, entry_id, status, updated_at FROM siyuan_file_state ORDER BY file_key",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SiyuanFileState {
                    file_key: r.get(0)?,
                    box_id: r.get(1)?,
                    rel_path: r.get(2)?,
                    mtime_ms: r.get(3)?,
                    entry_id: r.get(4)?,
                    status: r.get(5)?,
                    updated_at: r.get(6)?,
                })
            })
            .map_err(map_sqlite)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)
    }

    pub fn siyuan_file_state_delete(&self, file_key: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM siyuan_file_state WHERE file_key = ?1",
                [file_key],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 清空全部文件状态（重建同步用：下轮全量重评，条目按稳定 id 回填）。
    pub fn siyuan_file_state_clear(&self) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM siyuan_file_state", [])
            .map_err(map_sqlite)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Storage;

    #[test]
    fn config_roundtrip_with_default() {
        let storage = Storage::open_in_memory().unwrap();
        let cfg = storage.siyuan_config_get().unwrap();
        assert_eq!(cfg.source_type, SiyuanSourceType::Local);
        assert_eq!(cfg.s3_cloud_name, "main");
        let mut next = cfg;
        next.workspace_path = "D:\\SiYuan\\data".to_string();
        storage.siyuan_config_save(&next).unwrap();
        let got = storage.siyuan_config_get().unwrap();
        assert_eq!(got.workspace_path, "D:\\SiYuan\\data");
    }

    #[test]
    fn file_state_crud() {
        let storage = Storage::open_in_memory().unwrap();
        let state = SiyuanFileState {
            file_key: "local:b1/d1.sy".to_string(),
            box_id: "b1".to_string(),
            rel_path: "d1.sy".to_string(),
            mtime_ms: 100,
            entry_id: "siyuan-doc-d1".to_string(),
            status: "synced".to_string(),
            updated_at: 101,
        };
        assert!(
            storage
                .siyuan_file_state_get(&state.file_key)
                .unwrap()
                .is_none()
        );
        storage.siyuan_file_state_upsert(&state).unwrap();
        let got = storage
            .siyuan_file_state_get(&state.file_key)
            .unwrap()
            .unwrap();
        assert_eq!(got.mtime_ms, 100);
        let mut next = state.clone();
        next.mtime_ms = 200;
        storage.siyuan_file_state_upsert(&next).unwrap();
        assert_eq!(storage.siyuan_file_state_list().unwrap().len(), 1);
        storage.siyuan_file_state_delete(&state.file_key).unwrap();
        assert!(storage.siyuan_file_state_list().unwrap().is_empty());
    }

    #[test]
    fn file_state_clear_empties() {
        let storage = Storage::open_in_memory().unwrap();
        let state = SiyuanFileState {
            file_key: "local:b1/d1.sy".to_string(),
            box_id: "b1".to_string(),
            rel_path: "d1.sy".to_string(),
            mtime_ms: 100,
            entry_id: "siyuan-doc-d1".to_string(),
            status: "synced".to_string(),
            updated_at: 101,
        };
        storage.siyuan_file_state_upsert(&state).unwrap();
        storage.siyuan_file_state_clear().unwrap();
        assert!(storage.siyuan_file_state_list().unwrap().is_empty());
    }

    #[test]
    fn local_requires_existing_dir() {
        let mut cfg = SiyuanSyncConfig::default();
        assert!(cfg.validate().is_err());
        cfg.workspace_path = "C:\\definitely\\not\\here".to_string();
        assert!(cfg.validate().is_err());
    }
}
