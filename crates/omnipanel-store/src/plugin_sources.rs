//! 插件 registry 源配置 — `plugin_registry_sources` 表（v38）。
//!
//! - 官方源内置（builtin=1，不可删）；第三方源用户自加；
//! - `pinned_keys`: JSON 数组 hex 公钥，首次添加 TOFU pin；
//! - `key_pending`: 源换 key 时暂存待确认（'' 为无），确认前沿用旧数据；
//! - `auth_ref`: keyring credential_ref（bearer token），库内无明文。

use omnipanel_error::OmniResult;
use rusqlite::{OptionalExtension, params};

use super::storage::{Storage, map_sqlite};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// registry 源行（token 明文永不进库，调用方经 keyring 另取）。
#[derive(Debug, Clone, PartialEq)]
pub struct RegistrySourceRow {
    pub id: String,
    pub url: String,
    pub enabled: bool,
    pub pinned_keys: Vec<String>,
    pub key_pending: String,
    pub auth_ref: String,
    pub builtin: bool,
}

fn parse_keys(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

impl Storage {
    pub fn registry_sources_list(&self) -> OmniResult<Vec<RegistrySourceRow>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, url, enabled, pinned_keys, key_pending, auth_ref, builtin
                 FROM plugin_registry_sources ORDER BY builtin DESC, id",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                let enabled: i64 = row.get(2)?;
                let builtin: i64 = row.get(6)?;
                let keys_raw: String = row.get(3)?;
                Ok(RegistrySourceRow {
                    id: row.get(0)?,
                    url: row.get(1)?,
                    enabled: enabled != 0,
                    pinned_keys: parse_keys(&keys_raw),
                    key_pending: row.get(4)?,
                    auth_ref: row.get(5)?,
                    builtin: builtin != 0,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 新增/覆盖源（upsert；builtin 标记仅首次写入生效，不可 trusted 提权）。
    pub fn registry_source_upsert(
        &self,
        id: &str,
        url: &str,
        pinned_keys: &[String],
        auth_ref: &str,
    ) -> OmniResult<()> {
        if id.trim().is_empty() || url.trim().is_empty() {
            return Err(omnipanel_error::OmniError::invalid_input(
                "源 id 与 url 不能为空",
            ));
        }
        let keys_json = serde_json::to_string(pinned_keys).map_err(|e| {
            omnipanel_error::OmniError::invalid_input(format!("key 序列化失败: {e}"))
        })?;
        self.conn()
            .execute(
                "INSERT INTO plugin_registry_sources
                     (id, url, enabled, pinned_keys, key_pending, auth_ref, builtin, updated_at)
                 VALUES (?1, ?2, 1, ?3, '', ?4, 0, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     url = excluded.url,
                     pinned_keys = excluded.pinned_keys,
                     auth_ref = excluded.auth_ref,
                     updated_at = excluded.updated_at",
                params![id.trim(), url.trim(), keys_json, auth_ref, now_secs()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 确保官方内置源存在（builtin=1；已存在不覆盖用户改动）。
    pub fn registry_source_ensure_builtin(&self, id: &str, url: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO plugin_registry_sources
                     (id, url, enabled, pinned_keys, key_pending, auth_ref, builtin, updated_at)
                 VALUES (?1, ?2, 1, '[]', '', '', 1, ?3)
                 ON CONFLICT(id) DO NOTHING",
                params![id, url, now_secs()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn registry_source_set_enabled(&self, id: &str, enabled: bool) -> OmniResult<()> {
        let n = self
            .conn()
            .execute(
                "UPDATE plugin_registry_sources SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                params![if enabled { 1 } else { 0 }, now_secs(), id],
            )
            .map_err(map_sqlite)?;
        if n == 0 {
            return Err(omnipanel_error::OmniError::not_found(format!(
                "未知源: {id}"
            )));
        }
        Ok(())
    }

    /// 内置源拒绝删除。
    pub fn registry_source_delete(&self, id: &str) -> OmniResult<()> {
        let n = self
            .conn()
            .execute(
                "DELETE FROM plugin_registry_sources WHERE id = ?1 AND builtin = 0",
                params![id],
            )
            .map_err(map_sqlite)?;
        if n == 0 {
            let builtin: Option<i64> = self
                .conn()
                .query_row(
                    "SELECT builtin FROM plugin_registry_sources WHERE id = ?1",
                    params![id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(map_sqlite)?;
            return Err(match builtin {
                Some(1) => omnipanel_error::OmniError::invalid_input(format!(
                    "内置源不可删除，仅可禁用: {id}"
                )),
                _ => omnipanel_error::OmniError::not_found(format!("未知源: {id}")),
            });
        }
        Ok(())
    }

    /// 换 key 暂存待确认。
    pub fn registry_source_stage_key(&self, id: &str, new_key_hex: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "UPDATE plugin_registry_sources SET key_pending = ?1, updated_at = ?2 WHERE id = ?3",
                params![new_key_hex.trim(), now_secs(), id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 直接覆盖 pinned keys（TOFU 首次 pin 用；调用方已验签）。
    pub fn registry_source_set_pinned(&self, id: &str, keys: &[String]) -> OmniResult<()> {
        let keys_json = serde_json::to_string(keys).map_err(|e| {
            omnipanel_error::OmniError::invalid_input(format!("key 序列化失败: {e}"))
        })?;
        let n = self
            .conn()
            .execute(
                "UPDATE plugin_registry_sources SET pinned_keys = ?1, updated_at = ?2 WHERE id = ?3",
                params![keys_json, now_secs(), id],
            )
            .map_err(map_sqlite)?;
        if n == 0 {
            return Err(omnipanel_error::OmniError::not_found(format!(
                "未知源: {id}"
            )));
        }
        Ok(())
    }

    /// 确认换 key：pending 并入 pinned（去重），清空 pending。
    pub fn registry_source_confirm_key(&self, id: &str) -> OmniResult<Vec<String>> {
        let row: Option<(String, String)> = self
            .conn()
            .query_row(
                "SELECT pinned_keys, key_pending FROM plugin_registry_sources WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(map_sqlite)?;
        let Some((pinned_raw, pending)) = row else {
            return Err(omnipanel_error::OmniError::not_found(format!(
                "未知源: {id}"
            )));
        };
        if pending.trim().is_empty() {
            return Err(omnipanel_error::OmniError::invalid_input(
                "没有待确认的 key",
            ));
        }
        let mut keys = parse_keys(&pinned_raw);
        if !keys.iter().any(|k| k == pending.trim()) {
            keys.push(pending.trim().to_string());
        }
        let keys_json = serde_json::to_string(&keys).map_err(|e| {
            omnipanel_error::OmniError::invalid_input(format!("key 序列化失败: {e}"))
        })?;
        self.conn()
            .execute(
                "UPDATE plugin_registry_sources SET pinned_keys = ?1, key_pending = '', updated_at = ?2 WHERE id = ?3",
                params![keys_json, now_secs(), id],
            )
            .map_err(map_sqlite)?;
        Ok(keys)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_crud_and_builtin_guard() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(storage.registry_sources_list().unwrap().is_empty());

        storage
            .registry_source_upsert(
                "community",
                "https://example.com/registry.json",
                &["abc".into()],
                "",
            )
            .unwrap();
        let listed = storage.registry_sources_list().unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].pinned_keys, vec!["abc".to_string()]);
        assert!(!listed[0].builtin);

        storage
            .registry_source_set_enabled("community", false)
            .unwrap();
        assert!(!storage.registry_sources_list().unwrap()[0].enabled);

        storage
            .registry_source_ensure_builtin("official", "https://example.com/o.json")
            .unwrap();
        // 内置源拒绝删除
        assert!(storage.registry_source_delete("official").is_err());
        // 第三方源可删；重复删除报 not_found
        storage.registry_source_delete("community").unwrap();
        assert!(storage.registry_source_delete("community").is_err());
        // 内置源仍在
        assert_eq!(storage.registry_sources_list().unwrap().len(), 1);
    }

    #[test]
    fn key_rotation_staging_and_confirm() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .registry_source_upsert(
                "community",
                "https://example.com/r.json",
                &["k1".into()],
                "",
            )
            .unwrap();
        storage
            .registry_source_stage_key("community", "k2")
            .unwrap();
        assert_eq!(
            storage.registry_sources_list().unwrap()[0].key_pending,
            "k2"
        );
        let keys = storage.registry_source_confirm_key("community").unwrap();
        assert_eq!(keys, vec!["k1".to_string(), "k2".to_string()]);
        assert!(
            storage.registry_sources_list().unwrap()[0]
                .key_pending
                .is_empty()
        );
        // 无 pending 时确认报错
        assert!(storage.registry_source_confirm_key("community").is_err());
    }

    #[test]
    fn upsert_rejects_empty_and_never_escalates_builtin() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(
            storage
                .registry_source_upsert("", "https://x", &[], "")
                .is_err()
        );
        storage
            .registry_source_ensure_builtin("official", "https://example.com/o.json")
            .unwrap();
        // upsert 同 id 也提权不了 builtin
        storage
            .registry_source_upsert("official", "https://evil.example/r.json", &[], "")
            .unwrap();
        let row = storage.registry_sources_list().unwrap()[0].clone();
        assert!(row.builtin);
        assert!(storage.registry_source_delete("official").is_err());
    }
}
