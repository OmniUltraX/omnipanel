//! 本机个人空间。登录前就有一行，设备不是空间。

use std::collections::{BTreeMap, BTreeSet};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, map_sqlite};

const DEFAULT_SPACE_NAME: &str = "我的空间";

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalSpaceRecord {
    pub id: String,
    pub name: String,
    pub onboarded: bool,
    #[specta(type = f64)]
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceClaimStatus {
    #[specta(type = f64)]
    pub team_id: i64,
    pub local_count: u32,
    pub remote_has_repo: bool,
    pub decision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceClaimChoice {
    #[specta(type = f64)]
    pub team_id: i64,
    #[serde(default)]
    pub decision: String,
    #[serde(default)]
    #[specta(type = Option<f64>)]
    pub publish_team_id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct LocalSpaceStatus {
    pub space: Option<LocalSpaceRecord>,
    pub connection_count: u32,
}

/// 团队仓库放在哪。访问密钥不在这里，只在本机钥匙串。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceStorageSettings {
    #[specta(type = f64)]
    pub team_id: i64,
    /// `hosted` 用我们的桶，`s3` 用自己的桶。
    pub kind: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub has_secret: bool,
    /// 自己的桶要等对象抄完才为 true。官方桶一直为 true。
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SpaceStorageInput {
    #[specta(type = f64)]
    pub team_id: i64,
    pub kind: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub access_key_id: String,
    /// 空字符串表示不改已保存的密钥。
    #[serde(default)]
    pub secret_access_key: String,
}

fn space_s3_ref(team_id: i64) -> String {
    format!("space-s3:{team_id}")
}

fn read_space_s3_secret(team_id: i64) -> (String, bool) {
    let Ok(raw) = crate::vault::Vault::get(&space_s3_ref(team_id)) else {
        return (String::new(), false);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (String::new(), false);
    };
    let access_key_id = value
        .get("accessKeyId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let secret = value
        .get("secretAccessKey")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    (access_key_id, !secret.is_empty())
}

fn write_space_s3_secret(team_id: i64, access_key_id: &str, secret: &str) -> OmniResult<()> {
    let (mut kept_id, kept_secret) = match crate::vault::Vault::get(&space_s3_ref(team_id)) {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .map(|value| {
                (
                    value
                        .get("accessKeyId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                    value
                        .get("secretAccessKey")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                )
            })
            .unwrap_or_default(),
        Err(err) if err.code == ErrorCode::NotFound => (String::new(), String::new()),
        Err(err) => return Err(err),
    };
    if !access_key_id.is_empty() {
        kept_id = access_key_id.to_string();
    }
    let secret = if secret.is_empty() {
        kept_secret
    } else {
        secret.to_string()
    };
    if kept_id.is_empty() && secret.is_empty() {
        return Ok(());
    }
    let payload = serde_json::json!({
        "accessKeyId": kept_id,
        "secretAccessKey": secret,
    });
    crate::vault::Vault::store(&space_s3_ref(team_id), &payload.to_string())
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn new_space_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(1);
        bytes = n.to_le_bytes();
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15],
    )
}

fn normalize_name(name: &str) -> String {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        DEFAULT_SPACE_NAME.to_string()
    } else {
        trimmed.to_string()
    }
}

impl Storage {
    pub fn local_space_status(&self) -> OmniResult<LocalSpaceStatus> {
        let space = self
            .conn()
            .query_row(
                "SELECT id, name, onboarded, created_at FROM local_space LIMIT 1",
                [],
                |row| {
                    Ok(LocalSpaceRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        onboarded: row.get::<_, i64>(2)? != 0,
                        created_at: row.get(3)?,
                    })
                },
            )
            .ok();
        let connection_count: i64 = self
            .conn()
            .query_row("SELECT COUNT(*) FROM connections", [], |row| row.get(0))
            .map_err(map_sqlite)?;
        Ok(LocalSpaceStatus {
            space,
            connection_count: u32::try_from(connection_count).unwrap_or(u32::MAX),
        })
    }

    /// 写入空间名称并标记首次导航已完成。没有行时新建，id 不变。
    pub fn local_space_complete(&self, name: &str) -> OmniResult<LocalSpaceRecord> {
        let name = normalize_name(name);
        if let Some(current) = self.local_space_status()?.space {
            self.conn()
                .execute(
                    "UPDATE local_space SET name = ?1, onboarded = 1 WHERE id = ?2",
                    rusqlite::params![name, current.id],
                )
                .map_err(map_sqlite)?;
            return Ok(LocalSpaceRecord {
                id: current.id,
                name,
                onboarded: true,
                created_at: current.created_at,
            });
        }
        let record = LocalSpaceRecord {
            id: new_space_id(),
            name,
            onboarded: true,
            created_at: now_secs(),
        };
        self.conn()
            .execute(
                "INSERT INTO local_space (id, name, onboarded, created_at) VALUES (?1, ?2, 1, ?3)",
                rusqlite::params![record.id, record.name, record.created_at],
            )
            .map_err(map_sqlite)?;
        Ok(record)
    }

    pub fn local_space_user_count(&self) -> OmniResult<u32> {
        let files = self.collect_space_files()?;
        let count = files
            .keys()
            .filter(|path| path.as_str() != "todos/todo-default.json")
            .count();
        Ok(u32::try_from(count).unwrap_or(u32::MAX))
    }

    pub fn space_claim_decision(&self, team_id: i64) -> OmniResult<Option<String>> {
        self.conn()
            .query_row(
                "SELECT decision FROM space_claim WHERE team_id = ?1",
                [team_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(map_sqlite)
    }

    pub fn space_claim_put(&self, team_id: i64, decision: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO space_claim (team_id, decision, decided_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(team_id) DO UPDATE SET decision = excluded.decision, decided_at = excluded.decided_at",
                rusqlite::params![team_id, decision, now_secs()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn local_only_paths(&self) -> OmniResult<BTreeSet<String>> {
        let mut stmt = self
            .conn()
            .prepare("SELECT path FROM space_local_only")
            .map_err(map_sqlite)?;
        let rows = stmt.query_map([], |row| row.get(0)).map_err(map_sqlite)?;
        let mut paths = BTreeSet::new();
        for row in rows {
            paths.insert(row.map_err(map_sqlite)?);
        }
        Ok(paths)
    }

    /// 把当前已有记录标成不上传。默认待办清单除外。
    pub fn mark_space_local_only(&self, root: &std::path::Path) -> OmniResult<u32> {
        let mut paths = self.collect_space_files()?;
        paths.remove("todos/todo-default.json");
        for prefix in ["databases", "vault"] {
            let dir = root.join(crate::space_repo::SPACE_DIR).join(prefix);
            if !dir.is_dir() {
                continue;
            }
            let entries = std::fs::read_dir(&dir).map_err(|err| {
                omnipanel_error::OmniError::new(omnipanel_error::ErrorCode::Io, err.to_string())
            })?;
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if name.ends_with(".json") {
                    paths.insert(format!("{prefix}/{name}"), Vec::new());
                }
            }
        }
        for path in paths.keys() {
            self.conn()
                .execute(
                    "INSERT OR IGNORE INTO space_local_only (path) VALUES (?1)",
                    [path],
                )
                .map_err(map_sqlite)?;
        }
        self.write_local_only_file(root)?;
        Ok(u32::try_from(paths.len()).unwrap_or(u32::MAX))
    }

    pub fn write_local_only_file(&self, root: &std::path::Path) -> OmniResult<()> {
        let paths = self.local_only_paths()?;
        let dir = root.join(crate::space_repo::REPO_DIR);
        std::fs::create_dir_all(&dir).map_err(|err| {
            omnipanel_error::OmniError::new(omnipanel_error::ErrorCode::Io, err.to_string())
        })?;
        let mut body = String::new();
        for path in paths {
            body.push_str(&path);
            body.push('\n');
        }
        std::fs::write(dir.join("local-only.txt"), body).map_err(|err| {
            omnipanel_error::OmniError::new(omnipanel_error::ErrorCode::Io, err.to_string())
        })?;
        Ok(())
    }

    pub fn resource_origins(&self) -> OmniResult<BTreeMap<String, String>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT path, origin_device_id FROM resource_origin")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(map_sqlite)?;
        let mut out = BTreeMap::new();
        for row in rows {
            let (path, origin): (String, String) = row.map_err(map_sqlite)?;
            if !path.is_empty() && !origin.trim().is_empty() {
                out.insert(path, origin);
            }
        }
        Ok(out)
    }

    /// 已有创建设备 id 不覆盖。空字符串不写入。
    pub fn save_resource_origins(&self, origins: &BTreeMap<String, String>) -> OmniResult<()> {
        let conn = self.conn();
        for (path, origin) in origins {
            let origin = origin.trim();
            if path.is_empty() || origin.is_empty() {
                continue;
            }
            conn.execute(
                "INSERT INTO resource_origin (path, origin_device_id) VALUES (?1, ?2)
                 ON CONFLICT(path) DO UPDATE SET origin_device_id = excluded.origin_device_id
                 WHERE resource_origin.origin_device_id = ''",
                rusqlite::params![path, origin],
            )
            .map_err(map_sqlite)?;
        }
        Ok(())
    }

    pub fn space_storage_get(&self, team_id: i64) -> OmniResult<SpaceStorageSettings> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT kind, endpoint, bucket, region, ready FROM space_storage WHERE team_id = ?1",
                [team_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                    ))
                },
            )
            .optional()
            .map_err(map_sqlite)?;
        let (kind, endpoint, bucket, region, ready) = row.unwrap_or_else(|| {
            (
                "hosted".to_string(),
                String::new(),
                String::new(),
                String::new(),
                1,
            )
        });
        let (access_key_id, has_secret) = read_space_s3_secret(team_id);
        Ok(SpaceStorageSettings {
            team_id,
            ready: ready != 0 || kind != "s3",
            kind,
            endpoint,
            bucket,
            region,
            access_key_id,
            has_secret,
        })
    }

    pub fn space_storage_put(&self, input: &SpaceStorageInput) -> OmniResult<SpaceStorageSettings> {
        if input.team_id <= 0 {
            return Err(OmniError::new(ErrorCode::InvalidInput, "团队 id 无效"));
        }
        let kind = if input.kind.trim() == "s3" {
            "s3"
        } else {
            "hosted"
        };
        let endpoint = input.endpoint.trim();
        let bucket = input.bucket.trim();
        let region = input.region.trim();
        if kind == "s3" && (endpoint.is_empty() || bucket.is_empty()) {
            return Err(OmniError::invalid_input("请填写 Endpoint 和 Bucket"));
        }
        let previous = self.space_storage_get(input.team_id)?;
        let same_bucket = previous.kind == "s3"
            && previous.endpoint == endpoint
            && previous.bucket == bucket
            && previous.ready;
        let ready = if kind == "hosted" || same_bucket {
            1
        } else {
            0
        };
        self.conn()
            .execute(
                "INSERT INTO space_storage (team_id, kind, endpoint, bucket, region, updated_at, ready)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(team_id) DO UPDATE SET
                    kind = excluded.kind,
                    endpoint = excluded.endpoint,
                    bucket = excluded.bucket,
                    region = excluded.region,
                    updated_at = excluded.updated_at,
                    ready = excluded.ready",
                rusqlite::params![input.team_id, kind, endpoint, bucket, region, now_secs(), ready],
            )
            .map_err(map_sqlite)?;
        write_space_s3_secret(
            input.team_id,
            input.access_key_id.trim(),
            input.secret_access_key.trim(),
        )?;
        self.space_storage_get(input.team_id)
    }

    /// 对象已经写进自己的桶，之后同步可以改走那里。
    pub fn space_storage_mark_ready(&self, team_id: i64) -> OmniResult<()> {
        self.conn()
            .execute(
                "UPDATE space_storage SET ready = 1, updated_at = ?2 WHERE team_id = ?1",
                rusqlite::params![team_id, now_secs()],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 另一台从账号上的存储说明里抄来的位置。密钥一并进钥匙串。
    pub fn space_storage_adopt(
        &self,
        team_id: i64,
        kind: &str,
        endpoint: &str,
        bucket: &str,
        region: &str,
        access_key_id: &str,
        secret: &str,
    ) -> OmniResult<()> {
        let kind = if kind == "s3" { "s3" } else { "hosted" };
        self.conn()
            .execute(
                "INSERT INTO space_storage (team_id, kind, endpoint, bucket, region, updated_at, ready)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
                 ON CONFLICT(team_id) DO UPDATE SET
                    kind = excluded.kind,
                    endpoint = excluded.endpoint,
                    bucket = excluded.bucket,
                    region = excluded.region,
                    updated_at = excluded.updated_at,
                    ready = 1",
                rusqlite::params![team_id, kind, endpoint, bucket, region, now_secs()],
            )
            .map_err(map_sqlite)?;
        if kind == "s3" {
            write_space_s3_secret(team_id, access_key_id, secret)?;
        }
        Ok(())
    }

    pub fn space_s3_credentials(&self, team_id: i64) -> OmniResult<(String, String)> {
        let raw = match crate::vault::Vault::get(&space_s3_ref(team_id)) {
            Ok(raw) => raw,
            Err(err) if err.code == ErrorCode::NotFound => {
                return Ok((String::new(), String::new()));
            }
            Err(err) => return Err(err),
        };
        let value = serde_json::from_str::<serde_json::Value>(&raw).unwrap_or_default();
        let id = value
            .get("accessKeyId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let secret = value
            .get("secretAccessKey")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        Ok((id, secret))
    }

    pub fn local_space_id(&self) -> OmniResult<Option<String>> {
        Ok(self.local_space_status()?.space.map(|space| space.id))
    }

    /// 加入已有空间后，本机临时 id 改成账号空间的 id。
    pub fn adopt_local_space_id(&self, id: &str) -> OmniResult<()> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(());
        }
        let Some(current) = self.local_space_id()? else {
            return Ok(());
        };
        if current == id {
            return Ok(());
        }
        self.conn()
            .execute(
                "UPDATE local_space SET id = ?1 WHERE id = ?2",
                rusqlite::params![id, current],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    pub fn checkpoint_wal(&self) -> OmniResult<()> {
        self.conn()
            .execute_batch("PRAGMA wal_checkpoint(FULL);")
            .map_err(map_sqlite)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::{Connection, ConnectionKind};

    fn sample_conn(id: &str) -> Connection {
        Connection {
            id: id.to_string(),
            kind: ConnectionKind::Ssh,
            name: format!("conn-{id}"),
            group: "default".into(),
            env_tag: "dev".into(),
            tags: vec![],
            config: "{}".into(),
            credential_ref: None,
            created_at: 1,
            updated_at: 1,
            origin_device_id: String::new(),
        }
    }

    #[test]
    fn complete_creates_one_space_and_keeps_id() {
        let storage = Storage::open_in_memory().unwrap();
        let status = storage.local_space_status().unwrap();
        assert!(status.space.is_none());
        assert_eq!(status.connection_count, 0);

        let first = storage.local_space_complete("  ").unwrap();
        assert_eq!(first.name, "我的空间");
        assert!(first.onboarded);

        let second = storage.local_space_complete("工作").unwrap();
        assert_eq!(second.id, first.id);
        assert_eq!(second.name, "工作");

        storage.save_connection(&sample_conn("a")).unwrap();
        let status = storage.local_space_status().unwrap();
        assert_eq!(status.connection_count, 1);
        assert_eq!(status.space.unwrap().id, first.id);
    }

    #[test]
    fn local_only_stays_in_sqlite_and_out_of_the_index() {
        let storage = Storage::open_in_memory().unwrap();
        storage.save_connection(&sample_conn("keep")).unwrap();
        let root = tempfile::tempdir().unwrap();
        storage.mark_space_local_only(root.path()).unwrap();
        let report = storage.rebuild_space_repo(root.path()).unwrap();
        assert!(report.file_count >= 1);
        let index = crate::space_repo::read_latest_index(root.path()).unwrap();
        assert!(
            !index
                .files
                .iter()
                .any(|file| file.path == "connections/keep.json")
        );
        std::fs::create_dir_all(root.path().join("space/connections")).unwrap();
        storage.apply_space_checkout(root.path()).unwrap();
        assert!(storage.get_connection("keep").unwrap().is_some());
    }

    #[test]
    fn hosted_storage_roundtrip_does_not_require_a_bucket() {
        let storage = Storage::open_in_memory().unwrap();
        let saved = storage
            .space_storage_put(&SpaceStorageInput {
                team_id: 10,
                kind: "hosted".into(),
                endpoint: String::new(),
                bucket: String::new(),
                region: String::new(),
                access_key_id: String::new(),
                secret_access_key: String::new(),
            })
            .unwrap();
        assert_eq!(saved.kind, "hosted");
        assert!(!saved.has_secret);
        assert!(saved.ready);
        let again = storage.space_storage_get(10).unwrap();
        assert_eq!(again.team_id, 10);
    }
}
