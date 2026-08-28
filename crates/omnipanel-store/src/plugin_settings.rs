//! 第一方插件启用状态 — 持久化于 omnipanel.db 的 plugin_settings 表。

use omnipanel_error::OmniResult;
use rusqlite::{params, OptionalExtension};

use super::storage::{Storage, map_sqlite};

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

impl Storage {
    /// 已持久化的 (plugin_id, enabled)。未出现的插件保持编译期默认。
    pub fn plugin_enabled_list(&self) -> OmniResult<Vec<(String, bool)>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT plugin_id, enabled FROM plugin_settings ORDER BY plugin_id")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let enabled: i64 = row.get(1)?;
                Ok((id, enabled != 0))
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// 写穿单插件启用状态。
    pub fn plugin_enabled_set(&self, plugin_id: &str, enabled: bool) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO plugin_settings (plugin_id, enabled, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(plugin_id) DO UPDATE SET
                    enabled = excluded.enabled,
                    updated_at = excluded.updated_at",
                params![plugin_id, if enabled { 1 } else { 0 }, now_secs()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 卸载时清除启用记录（回到编译期默认）。
    pub fn plugin_enabled_delete(&self, plugin_id: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM plugin_settings WHERE plugin_id = ?1",
                params![plugin_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 插件非敏感状态 JSON；未写入时返回 `{}`。
    pub fn plugin_state_get(&self, plugin_id: &str) -> OmniResult<String> {
        let mut stmt = self
            .conn()
            .prepare("SELECT payload FROM plugin_state WHERE plugin_id = ?1")
            .map_err(map_sqlite)?;
        let payload: Option<String> = stmt
            .query_row(params![plugin_id], |row| row.get(0))
            .optional()
            .map_err(map_sqlite)?;
        Ok(payload.unwrap_or_else(|| "{}".into()))
    }

    pub fn plugin_state_set(&self, plugin_id: &str, payload: &str) -> OmniResult<()> {
        let _: serde_json::Value = serde_json::from_str(payload).map_err(|e| {
            omnipanel_error::OmniError::invalid_input(format!("插件状态必须是 JSON: {e}"))
        })?;
        self.conn()
            .execute(
                "INSERT INTO plugin_state (plugin_id, payload, updated_at)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(plugin_id) DO UPDATE SET
                    payload = excluded.payload,
                    updated_at = excluded.updated_at",
                params![plugin_id, payload, now_secs()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn plugin_state_delete(&self, plugin_id: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM plugin_state WHERE plugin_id = ?1",
                params![plugin_id],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_module::DEFAULT_APP_MODULES;

    #[test]
    fn plugin_settings_empty_then_set_and_overwrite() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(storage.plugin_enabled_list().unwrap().is_empty());

        storage
            .plugin_enabled_set("omni.addon.everything", false)
            .unwrap();
        let listed = storage.plugin_enabled_list().unwrap();
        assert_eq!(listed, vec![("omni.addon.everything".into(), false)]);

        storage
            .plugin_enabled_set("omni.addon.everything", true)
            .unwrap();
        storage
            .plugin_enabled_set("omni.module.nacos", false)
            .unwrap();
        let listed = storage.plugin_enabled_list().unwrap();
        assert_eq!(
            listed,
            vec![
                ("omni.addon.everything".into(), true),
                ("omni.module.nacos".into(), false),
            ]
        );
    }

    #[test]
    fn plugin_settings_migration_keeps_app_modules() {
        let storage = Storage::open_in_memory().unwrap();
        let modules = storage.app_module_list().unwrap();
        assert_eq!(modules.len(), DEFAULT_APP_MODULES.len());
        assert!(storage.plugin_enabled_list().unwrap().is_empty());
        storage
            .plugin_enabled_set("omni.engine.redis", false)
            .unwrap();
        let again = storage.app_module_list().unwrap();
        assert_eq!(again.len(), DEFAULT_APP_MODULES.len());
    }

    #[test]
    fn plugin_enabled_delete_removes_record() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .plugin_enabled_set("omni.addon.demo", false)
            .unwrap();
        storage.plugin_enabled_set("omni.addon.keep", true).unwrap();
        storage.plugin_enabled_delete("omni.addon.demo").unwrap();
        // 重复删除幂等
        storage.plugin_enabled_delete("omni.addon.demo").unwrap();
        let listed = storage.plugin_enabled_list().unwrap();
        assert_eq!(listed, vec![("omni.addon.keep".into(), true)]);
    }

    #[test]
    fn plugin_state_roundtrip_and_default() {
        let storage = Storage::open_in_memory().unwrap();
        assert_eq!(storage.plugin_state_get("omni.importer.warpgate").unwrap(), "{}");
        storage
            .plugin_state_set("omni.importer.warpgate", r#"{"sources":[]}"#)
            .unwrap();
        assert_eq!(
            storage.plugin_state_get("omni.importer.warpgate").unwrap(),
            r#"{"sources":[]}"#
        );
        storage.plugin_state_delete("omni.importer.warpgate").unwrap();
        assert_eq!(storage.plugin_state_get("omni.importer.warpgate").unwrap(), "{}");
    }
}
