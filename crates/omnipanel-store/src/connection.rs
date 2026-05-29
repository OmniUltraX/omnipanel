use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, map_sqlite};

/// 连接类型。统一覆盖工作站内所有可持久化的连接资源。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionKind {
    Ssh,
    Database,
    Docker,
    Panel,
    Protocol,
}

impl ConnectionKind {
    fn as_str(self) -> &'static str {
        match self {
            ConnectionKind::Ssh => "ssh",
            ConnectionKind::Database => "database",
            ConnectionKind::Docker => "docker",
            ConnectionKind::Panel => "panel",
            ConnectionKind::Protocol => "protocol",
        }
    }

    fn parse(s: &str) -> OmniResult<Self> {
        match s {
            "ssh" => Ok(ConnectionKind::Ssh),
            "database" => Ok(ConnectionKind::Database),
            "docker" => Ok(ConnectionKind::Docker),
            "panel" => Ok(ConnectionKind::Panel),
            "protocol" => Ok(ConnectionKind::Protocol),
            other => Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知连接类型: {other}"),
            )),
        }
    }
}

/// 统一连接模型。敏感凭据不在此，仅以 `credential_ref` 关联 [`crate::Vault`]。
/// `config` 为 JSON 文本（不同 kind 字段不同，由前端按类型解析）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub kind: ConnectionKind,
    pub name: String,
    #[serde(default)]
    pub group: String,
    #[serde(default = "default_env_tag")]
    pub env_tag: String,
    /// 连接配置 JSON 文本（host/port/user/database 等，因 kind 而异）
    #[serde(default = "default_config")]
    pub config: String,
    #[serde(default)]
    pub credential_ref: Option<String>,
    // 秒级时间戳：i64 存储，但 specta 导出为 number（远小于 2^53，无精度损失）
    #[serde(default)]
    #[specta(type = f64)]
    pub created_at: i64,
    #[serde(default)]
    #[specta(type = f64)]
    pub updated_at: i64,
}

fn default_env_tag() -> String {
    "unknown".to_string()
}

fn default_config() -> String {
    "{}".to_string()
}

impl Storage {
    /// 列出全部连接（按更新时间倒序）。
    pub fn list_connections(&self) -> OmniResult<Vec<Connection>> {
        self.query_connections("SELECT id, kind, name, group_name, env_tag, config, credential_ref, created_at, updated_at FROM connections ORDER BY updated_at DESC", [])
    }

    /// 按类型列出连接。
    pub fn list_connections_by_kind(&self, kind: ConnectionKind) -> OmniResult<Vec<Connection>> {
        self.query_connections(
            "SELECT id, kind, name, group_name, env_tag, config, credential_ref, created_at, updated_at FROM connections WHERE kind = ?1 ORDER BY updated_at DESC",
            [kind.as_str()],
        )
    }

    /// 按 id 获取单个连接。
    pub fn get_connection(&self, id: &str) -> OmniResult<Option<Connection>> {
        Ok(self
            .query_connections(
                "SELECT id, kind, name, group_name, env_tag, config, credential_ref, created_at, updated_at FROM connections WHERE id = ?1",
                [id],
            )?
            .into_iter()
            .next())
    }

    /// 插入或更新连接（按 id upsert）。
    pub fn save_connection(&self, conn: &Connection) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO connections (id, kind, name, group_name, env_tag, config, credential_ref, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    name = excluded.name,
                    group_name = excluded.group_name,
                    env_tag = excluded.env_tag,
                    config = excluded.config,
                    credential_ref = excluded.credential_ref,
                    updated_at = excluded.updated_at",
                rusqlite::params![
                    conn.id,
                    conn.kind.as_str(),
                    conn.name,
                    conn.group,
                    conn.env_tag,
                    conn.config,
                    conn.credential_ref,
                    conn.created_at,
                    conn.updated_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// 删除连接（不存在视为成功）。
    pub fn delete_connection(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM connections WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }

    fn query_connections<P: rusqlite::Params>(
        &self,
        sql: &str,
        params: P,
    ) -> OmniResult<Vec<Connection>> {
        let mut stmt = self.conn().prepare(sql).map_err(map_sqlite)?;
        let rows = stmt
            .query_map(params, |row| {
                let kind_str: String = row.get(1)?;
                Ok((
                    Connection {
                        id: row.get(0)?,
                        kind: ConnectionKind::Ssh, // 占位，下方按 kind_str 修正
                        name: row.get(2)?,
                        group: row.get(3)?,
                        env_tag: row.get(4)?,
                        config: row.get(5)?,
                        credential_ref: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    },
                    kind_str,
                ))
            })
            .map_err(map_sqlite)?;

        let mut out = Vec::new();
        for row in rows {
            let (mut conn, kind_str) = row.map_err(map_sqlite)?;
            conn.kind = ConnectionKind::parse(&kind_str)?;
            out.push(conn);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, kind: ConnectionKind) -> Connection {
        Connection {
            id: id.to_string(),
            kind,
            name: format!("conn-{id}"),
            group: "default".into(),
            env_tag: "dev".into(),
            config: r#"{"host":"127.0.0.1","port":22}"#.into(),
            credential_ref: Some(format!("cred-{id}")),
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
        }
    }

    #[test]
    fn save_and_list() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_connection(&sample("a", ConnectionKind::Ssh))
            .unwrap();
        storage
            .save_connection(&sample("b", ConnectionKind::Database))
            .unwrap();

        let all = storage.list_connections().unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn get_and_kind_roundtrip() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_connection(&sample("x", ConnectionKind::Docker))
            .unwrap();
        let got = storage.get_connection("x").unwrap().unwrap();
        assert_eq!(got.kind, ConnectionKind::Docker);
        assert_eq!(got.name, "conn-x");
        assert_eq!(got.credential_ref.as_deref(), Some("cred-x"));
    }

    #[test]
    fn upsert_updates_existing() {
        let storage = Storage::open_in_memory().unwrap();
        let mut c = sample("u", ConnectionKind::Ssh);
        storage.save_connection(&c).unwrap();
        c.name = "renamed".into();
        c.updated_at = 1_700_000_999;
        storage.save_connection(&c).unwrap();

        let all = storage.list_connections().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "renamed");
    }

    #[test]
    fn list_by_kind_filters() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_connection(&sample("s1", ConnectionKind::Ssh))
            .unwrap();
        storage
            .save_connection(&sample("s2", ConnectionKind::Ssh))
            .unwrap();
        storage
            .save_connection(&sample("d1", ConnectionKind::Database))
            .unwrap();

        assert_eq!(
            storage
                .list_connections_by_kind(ConnectionKind::Ssh)
                .unwrap()
                .len(),
            2
        );
        assert_eq!(
            storage
                .list_connections_by_kind(ConnectionKind::Database)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn delete_removes() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_connection(&sample("d", ConnectionKind::Panel))
            .unwrap();
        storage.delete_connection("d").unwrap();
        assert!(storage.get_connection("d").unwrap().is_none());
        // 再删不存在的也成功
        storage.delete_connection("d").unwrap();
    }
}
