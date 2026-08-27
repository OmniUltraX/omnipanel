//! SSH 密钥库：元数据存 SQLite，私钥与口令存 Vault（`ssh-key-priv-*` / `ssh-key-pass-*`）。

use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::storage::{map_sqlite, Storage};
use crate::vault::Vault;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyRecord {
    pub id: String,
    pub name: String,
    pub key_type: String,
    pub fingerprint: String,
    pub comment: String,
    pub public_key: String,
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    #[specta(type = f64)]
    pub created_at: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub updated_at: i64,
}

pub fn ssh_key_private_ref(key_id: &str) -> String {
    format!("ssh-key-priv-{key_id}")
}

pub fn ssh_key_passphrase_ref(key_id: &str) -> String {
    format!("ssh-key-pass-{key_id}")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn gen_ssh_key_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("sshkey-{nanos:x}")
}

fn row_to_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SshKeyRecord> {
    Ok(SshKeyRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        key_type: row.get(2)?,
        fingerprint: row.get(3)?,
        comment: row.get(4)?,
        public_key: row.get(5)?,
        source_path: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

impl Storage {
    pub fn list_ssh_keys(&self) -> OmniResult<Vec<SshKeyRecord>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, key_type, fingerprint, comment, public_key, source_path, created_at, updated_at
                 FROM ssh_keys ORDER BY name COLLATE NOCASE",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], row_to_record)
            .map_err(map_sqlite)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)
    }

    pub fn get_ssh_key(&self, id: &str) -> OmniResult<Option<SshKeyRecord>> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(None);
        }
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, key_type, fingerprint, comment, public_key, source_path, created_at, updated_at
                 FROM ssh_keys WHERE id = ?1",
            )
            .map_err(map_sqlite)?;
        let mut rows = stmt.query([id]).map_err(map_sqlite)?;
        if let Some(row) = rows.next().map_err(map_sqlite)? {
            return Ok(Some(row_to_record(&row).map_err(map_sqlite)?));
        }
        Ok(None)
    }

    pub fn get_ssh_key_by_name(&self, name: &str) -> OmniResult<Option<SshKeyRecord>> {
        let name = name.trim();
        if name.is_empty() {
            return Ok(None);
        }
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, key_type, fingerprint, comment, public_key, source_path, created_at, updated_at
                 FROM ssh_keys WHERE name = ?1",
            )
            .map_err(map_sqlite)?;
        let mut rows = stmt.query([name]).map_err(map_sqlite)?;
        if let Some(row) = rows.next().map_err(map_sqlite)? {
            return Ok(Some(row_to_record(&row).map_err(map_sqlite)?));
        }
        Ok(None)
    }

    pub fn find_ssh_key_by_fingerprint(&self, fingerprint: &str) -> OmniResult<Option<SshKeyRecord>> {
        let fingerprint = fingerprint.trim();
        if fingerprint.is_empty() {
            return Ok(None);
        }
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, key_type, fingerprint, comment, public_key, source_path, created_at, updated_at
                 FROM ssh_keys WHERE fingerprint = ?1 LIMIT 1",
            )
            .map_err(map_sqlite)?;
        let mut rows = stmt.query([fingerprint]).map_err(map_sqlite)?;
        if let Some(row) = rows.next().map_err(map_sqlite)? {
            return Ok(Some(row_to_record(&row).map_err(map_sqlite)?));
        }
        Ok(None)
    }

    pub fn save_ssh_key_record(&self, record: &SshKeyRecord) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO ssh_keys (id, name, key_type, fingerprint, comment, public_key, source_path, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   key_type = excluded.key_type,
                   fingerprint = excluded.fingerprint,
                   comment = excluded.comment,
                   public_key = excluded.public_key,
                   source_path = excluded.source_path,
                   updated_at = excluded.updated_at",
                (
                    &record.id,
                    &record.name,
                    &record.key_type,
                    &record.fingerprint,
                    &record.comment,
                    &record.public_key,
                    &record.source_path,
                    record.created_at,
                    record.updated_at,
                ),
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn delete_ssh_key(&self, id: &str) -> OmniResult<bool> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(false);
        }
        let changed = self
            .conn()
            .execute("DELETE FROM ssh_keys WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        let _ = Vault::delete(&ssh_key_private_ref(id));
        let _ = Vault::delete(&ssh_key_passphrase_ref(id));
        Ok(changed > 0)
    }

    pub fn delete_ssh_key_by_name(&self, name: &str) -> OmniResult<bool> {
        let Some(record) = self.get_ssh_key_by_name(name)? else {
            return Ok(false);
        };
        self.delete_ssh_key(&record.id)
    }

    pub fn rename_ssh_key(&self, id: &str, new_name: &str) -> OmniResult<SshKeyRecord> {
        let id = id.trim();
        let new_name = new_name.trim();
        if id.is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "密钥 ID 不能为空"));
        }
        if new_name.is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "密钥名称不能为空"));
        }
        if new_name.contains('/') || new_name.contains('\\') {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "密钥名称不能包含路径分隔符",
            ));
        }
        if new_name.ends_with(".pub") {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "密钥名称不能以 .pub 结尾",
            ));
        }
        let Some(mut record) = self.get_ssh_key(id)? else {
            return Err(OmniError::new(ErrorCode::NotFound, "密钥不存在"));
        };
        if record.name == new_name {
            return Ok(record);
        }
        if self.get_ssh_key_by_name(new_name)?.is_some() {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("密钥 `{new_name}` 已存在"),
            ));
        }
        record.name = new_name.to_string();
        record.updated_at = now_secs();
        self.save_ssh_key_record(&record)?;
        Ok(record)
    }

    pub fn rename_ssh_key_by_name(&self, name: &str, new_name: &str) -> OmniResult<SshKeyRecord> {
        let name = name.trim();
        let Some(record) = self.get_ssh_key_by_name(name)? else {
            return Err(OmniError::new(
                ErrorCode::NotFound,
                format!("密钥 `{name}` 不存在"),
            ));
        };
        self.rename_ssh_key(&record.id, new_name)
    }

    /// 写入密钥库；同名称或同指纹已存在则复用并更新 Vault。
    pub fn upsert_ssh_key_from_private_pem(
        &self,
        name: &str,
        private_pem: &str,
        key_type: &str,
        fingerprint: &str,
        comment: &str,
        public_key: &str,
        source_path: &str,
        passphrase: Option<&str>,
    ) -> OmniResult<SshKeyRecord> {
        let private_pem = private_pem.trim();
        if private_pem.is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "SSH 私钥内容为空"));
        }
        let name = name.trim();
        if name.is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "SSH 密钥名称不能为空"));
        }

        let store_secrets = |id: &str| -> OmniResult<()> {
            Vault::store(&ssh_key_private_ref(id), private_pem)?;
            if let Some(pp) = passphrase.filter(|s| !s.is_empty()) {
                Vault::store(&ssh_key_passphrase_ref(id), pp)?;
            }
            Ok(())
        };

        if let Some(existing) = self.get_ssh_key_by_name(name)? {
            store_secrets(&existing.id)?;
            let mut updated = existing;
            if !fingerprint.is_empty() {
                updated.fingerprint = fingerprint.to_string();
            }
            if !public_key.is_empty() {
                updated.public_key = public_key.to_string();
            }
            if !comment.is_empty() {
                updated.comment = comment.to_string();
            }
            if !source_path.is_empty() {
                updated.source_path = source_path.to_string();
            }
            if !key_type.is_empty() {
                updated.key_type = key_type.to_string();
            }
            updated.updated_at = now_secs();
            self.save_ssh_key_record(&updated)?;
            return Ok(updated);
        }

        if !fingerprint.is_empty() {
            if let Some(existing) = self.find_ssh_key_by_fingerprint(fingerprint)? {
                store_secrets(&existing.id)?;
                return Ok(existing);
            }
        }

        let now = now_secs();
        let record = SshKeyRecord {
            id: gen_ssh_key_id(),
            name: name.to_string(),
            key_type: key_type.to_string(),
            fingerprint: fingerprint.to_string(),
            comment: comment.to_string(),
            public_key: public_key.to_string(),
            source_path: source_path.to_string(),
            created_at: now,
            updated_at: now,
        };
        store_secrets(&record.id)?;
        self.save_ssh_key_record(&record)?;
        Ok(record)
    }
}
