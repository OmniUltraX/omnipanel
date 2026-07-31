//! 数据库模块持久化：`~/.omnipd/database/connections.json`。

use std::collections::HashMap;
use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::paths;
use crate::ssh_vault::db_password_ref;
use crate::vault::Vault;

/// 数据库连接配置（与前端 `DbConnectionConfig` / Tauri IPC 一致）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DbConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 明文仅提交时存在；持久化与列表返回为空，用 `has_password` 表示钥匙串是否有密码。
    #[serde(default)]
    pub password: String,
    pub database: String,
    /// 是否启用 SSL（MySQL 等）。
    #[serde(default)]
    pub ssl: bool,
    #[serde(default)]
    pub status: String,
    /// 是否启用；`false` 表示连接已关闭（禁用），不参与查询与库表加载。
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    /// 钥匙串中是否已保存密码。
    #[serde(default)]
    pub has_password: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Serialize, Deserialize)]
struct ConnectionsFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    connections: Vec<DbConnectionConfig>,
}

fn default_version() -> u32 {
    1
}

fn map_io(err: std::io::Error) -> OmniError {
    OmniError::new(ErrorCode::Io, "读写数据库连接配置失败").with_cause(err.to_string())
}

fn map_json(err: serde_json::Error) -> OmniError {
    OmniError::new(ErrorCode::Storage, "解析数据库连接配置失败").with_cause(err.to_string())
}

/// 从磁盘加载全部连接；文件不存在时返回空列表。
pub fn load_database_connections() -> OmniResult<Vec<DbConnectionConfig>> {
    let path = paths::database_connections_path()?;
    load_database_connections_from(&path)
}

pub fn load_database_connections_from(path: &Path) -> OmniResult<Vec<DbConnectionConfig>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let content = std::fs::read_to_string(path).map_err(map_io)?;
    if content.trim().is_empty() {
        return Ok(Vec::new());
    }
    let file: ConnectionsFile = serde_json::from_str(&content).map_err(map_json)?;
    Ok(file.connections)
}

/// 将全部连接写回 `connections.json`（原子替换）。
pub fn save_database_connections(connections: &[DbConnectionConfig]) -> OmniResult<()> {
    let path = paths::database_connections_path()?;
    save_database_connections_to(&path, connections)
}

pub fn save_database_connections_to(
    path: &Path,
    connections: &[DbConnectionConfig],
) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(map_io)?;
    }
    let file = ConnectionsFile {
        version: 1,
        connections: connections.to_vec(),
    };
    let json = serde_json::to_string_pretty(&file).map_err(map_json)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(map_io)?;
    std::fs::rename(&tmp, path).map_err(map_io)?;
    Ok(())
}

/// 运行期连接仓库：启动时加载，变更后写回磁盘。
pub struct DatabaseConnectionStore {
    path: std::path::PathBuf,
    inner: std::sync::Mutex<HashMap<String, DbConnectionConfig>>,
}

impl DatabaseConnectionStore {
    pub fn open() -> OmniResult<Self> {
        let path = paths::database_connections_path()?;
        Self::open_at(&path)
    }

    pub fn open_at(path: &Path) -> OmniResult<Self> {
        let list = load_database_connections_from(path)?;
        // 迁移：明文密码进 Vault 并 scrub
        let mut migrated = Vec::new();
        for mut conn in list {
            if !conn.password.trim().is_empty() {
                let _ = Vault::store(&db_password_ref(&conn.id), &conn.password);
                conn.has_password = true;
                conn.password.clear();
            } else {
                conn.has_password = Vault::get(&db_password_ref(&conn.id))
                    .ok()
                    .is_some_and(|p| !p.is_empty());
            }
            migrated.push(conn);
        }
        let _ = save_database_connections_to(path, &migrated);
        let map = migrated
            .into_iter()
            .map(|conn| (conn.id.clone(), conn))
            .collect();
        Ok(Self {
            path: path.to_path_buf(),
            inner: std::sync::Mutex::new(map),
        })
    }

    pub fn list(&self) -> OmniResult<Vec<DbConnectionConfig>> {
        let store = self.inner.lock().map_err(|_| lock_err())?;
        let mut list: Vec<_> = store
            .values()
            .cloned()
            .map(|mut c| {
                c.has_password = Vault::get(&db_password_ref(&c.id))
                    .ok()
                    .is_some_and(|p| !p.is_empty())
                    || c.has_password;
                c.password.clear();
                c
            })
            .collect();
        list.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(list)
    }

    /// 取连接并注入 Vault 密码（供后端建连）。
    pub fn get_with_secret(&self, id: &str) -> OmniResult<Option<DbConnectionConfig>> {
        let store = self.inner.lock().map_err(|_| lock_err())?;
        let Some(mut conn) = store.get(id).cloned() else {
            return Ok(None);
        };
        fill_db_password_from_vault(&mut conn);
        Ok(Some(conn))
    }

    pub fn save(&self, mut connection: DbConnectionConfig) -> OmniResult<DbConnectionConfig> {
        if connection.id.is_empty() {
            connection.id = new_connection_id();
        }
        if connection.status.is_empty() {
            connection.status = "unknown".to_string();
        }
        if !connection.password.trim().is_empty() {
            Vault::store(&db_password_ref(&connection.id), connection.password.trim())?;
            connection.has_password = true;
        } else {
            connection.has_password = Vault::get(&db_password_ref(&connection.id))
                .ok()
                .is_some_and(|p| !p.is_empty())
                || connection.has_password;
        }
        connection.password.clear();
        let mut store = self.inner.lock().map_err(|_| lock_err())?;
        store.insert(connection.id.clone(), connection.clone());
        let snapshot: Vec<_> = store.values().cloned().collect();
        drop(store);
        save_database_connections_to(&self.path, &snapshot)?;
        Ok(connection)
    }

    pub fn delete(&self, id: &str) -> OmniResult<()> {
        let mut store = self.inner.lock().map_err(|_| lock_err())?;
        store.remove(id);
        let snapshot: Vec<_> = store.values().cloned().collect();
        drop(store);
        save_database_connections_to(&self.path, &snapshot)?;
        let _ = Vault::delete(&db_password_ref(id));
        Ok(())
    }
}

/// 从钥匙串填充密码（就地）。
pub fn fill_db_password_from_vault(conn: &mut DbConnectionConfig) {
    if !conn.password.trim().is_empty() {
        return;
    }
    if let Ok(pw) = Vault::get(&db_password_ref(&conn.id)) {
        if !pw.is_empty() {
            conn.password = pw;
            conn.has_password = true;
        }
    }
}

fn lock_err() -> OmniError {
    OmniError::new(ErrorCode::Internal, "数据库连接存储锁已中毒")
}

fn new_connection_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        now.as_secs(),
        (now.as_nanos() & 0xffff) as u16,
        ((now.as_nanos() >> 16) as u16 & 0xfff),
        ((now.as_nanos() >> 28) as u16 & 0x3fff) | 0x8000,
        (now.as_nanos() >> 44) & 0xffff_ffff_ffff
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str) -> DbConnectionConfig {
        DbConnectionConfig {
            id: id.into(),
            name: format!("db-{id}"),
            db_type: "mysql".into(),
            host: "127.0.0.1".into(),
            port: 3306,
            user: "root".into(),
            password: "secret".into(),
            database: "app".into(),
            ssl: false,
            status: "unknown".into(),
            enabled: true,
            has_password: false,
        }
    }

    #[test]
    fn save_and_reload_connections_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let a = sample("a");
        save_database_connections_to(&path, std::slice::from_ref(&a)).unwrap();
        let loaded = load_database_connections_from(&path).unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, "a");
        assert_eq!(loaded[0].password, "secret");
    }

    #[test]
    fn store_persists_across_open() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        {
            let store = DatabaseConnectionStore::open_at(&path).unwrap();
            store.save(sample("x")).unwrap();
        }
        let store = DatabaseConnectionStore::open_at(&path).unwrap();
        assert_eq!(store.list().unwrap().len(), 1);
        store.delete("x").unwrap();
        assert!(store.list().unwrap().is_empty());
    }
}
