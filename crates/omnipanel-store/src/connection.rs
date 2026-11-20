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
    /// 云厂商账户（阿里云等），与面板并列挂在第三方服务模块。
    Cloud,
    Protocol,
    File,
    /// 插件 `kind=module` 的服务实例（Nacos 等）。
    Service,
}

impl ConnectionKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ConnectionKind::Ssh => "ssh",
            ConnectionKind::Database => "database",
            ConnectionKind::Docker => "docker",
            ConnectionKind::Panel => "panel",
            ConnectionKind::Cloud => "cloud",
            ConnectionKind::Protocol => "protocol",
            ConnectionKind::File => "file",
            ConnectionKind::Service => "service",
        }
    }

    fn parse(s: &str) -> OmniResult<Self> {
        match s {
            "ssh" => Ok(ConnectionKind::Ssh),
            "database" => Ok(ConnectionKind::Database),
            "docker" => Ok(ConnectionKind::Docker),
            "panel" => Ok(ConnectionKind::Panel),
            "cloud" => Ok(ConnectionKind::Cloud),
            "protocol" => Ok(ConnectionKind::Protocol),
            "file" => Ok(ConnectionKind::File),
            "service" => Ok(ConnectionKind::Service),
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
    /// 全局资源标签，如 `os:Ubuntu 24.04.2 LTS`（key:value 字符串列表）
    #[serde(default)]
    pub tags: Vec<String>,
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
    /// 创建设备 id。只写一次。旧数据从 `origin:` 标签迁入，之后不再当标签存。
    #[serde(default)]
    pub origin_device_id: String,
}

fn default_env_tag() -> String {
    "unknown".to_string()
}

fn default_config() -> String {
    "{}".to_string()
}

enum CreatorKeep {
    /// 库里已有创建者就不换成另一台。
    Stored,
    /// 同步正文里有创建者时采用正文，没有则沿用库里的。
    IncomingIfSet,
    /// 正文里的创建者就是最终结果，没有就是清掉。
    Incoming,
}

impl Storage {
    /// 列出全部连接（按更新时间倒序）。
    pub fn list_connections(&self) -> OmniResult<Vec<Connection>> {
        self.query_connections("SELECT id, kind, name, group_name, env_tag, tags, config, credential_ref, created_at, updated_at, origin_device_id FROM connections ORDER BY updated_at DESC", [])
    }

    /// 按类型列出连接。
    pub fn list_connections_by_kind(&self, kind: ConnectionKind) -> OmniResult<Vec<Connection>> {
        self.query_connections(
            "SELECT id, kind, name, group_name, env_tag, tags, config, credential_ref, created_at, updated_at, origin_device_id FROM connections WHERE kind = ?1 ORDER BY updated_at DESC",
            [kind.as_str()],
        )
    }

    /// 按 id 获取单个连接。
    pub fn get_connection(&self, id: &str) -> OmniResult<Option<Connection>> {
        Ok(self
            .query_connections(
                "SELECT id, kind, name, group_name, env_tag, tags, config, credential_ref, created_at, updated_at, origin_device_id FROM connections WHERE id = ?1",
                [id],
            )?
            .into_iter()
            .next())
    }

    /// 插入或更新连接（按 id upsert）。
    /// 创建设备 id 只写一次：库里已有就保留，没有则用传入值或旧 `origin:` 标签。
    pub fn save_connection(&self, conn: &Connection) -> OmniResult<()> {
        self.save_connection_inner(conn, CreatorKeep::Stored)
    }

    /// 同步检出写回。正文里已经决出的创建者要落库，不能再被本机旧标签盖回去。
    pub fn save_synced_connection(&self, conn: &Connection) -> OmniResult<()> {
        self.save_connection_inner(conn, CreatorKeep::IncomingIfSet)
    }

    /// 按创建设备字段重写创建者后写回。传入的标签就是要留下的创建者，空则清掉。
    pub fn save_connection_replacing_creator(&self, conn: &Connection) -> OmniResult<()> {
        self.save_connection_inner(conn, CreatorKeep::Incoming)
    }

    fn save_connection_inner(&self, conn: &Connection, creator: CreatorKeep) -> OmniResult<()> {
        let mut conn = conn.clone();
        let existing = self.get_connection(&conn.id)?;
        let stored = existing
            .as_ref()
            .map(|item| item.origin_device_id.clone())
            .unwrap_or_default();
        let previous_tags = existing.map(|item| item.tags);
        let previous_for_creator = match creator {
            CreatorKeep::Incoming => None,
            CreatorKeep::IncomingIfSet if crate::tag::creator_device_name(&conn.tags).is_some() => {
                None
            }
            CreatorKeep::Stored | CreatorKeep::IncomingIfSet => previous_tags.as_deref(),
        };
        crate::tag::collapse_creator_tags(&mut conn.tags, previous_for_creator);
        crate::tag::canonicalize_connection_tags(&mut conn.tags);
        conn.origin_device_id =
            crate::tag::settle_origin_device_id(&stored, &conn.origin_device_id, &conn.tags);
        crate::tag::strip_origin_tags(&mut conn.tags);
        self.conn()
            .execute(
                "INSERT INTO connections (id, kind, name, group_name, env_tag, tags, config, credential_ref, created_at, updated_at, origin_device_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    kind = excluded.kind,
                    name = excluded.name,
                    group_name = excluded.group_name,
                    env_tag = excluded.env_tag,
                    tags = excluded.tags,
                    config = excluded.config,
                    credential_ref = excluded.credential_ref,
                    updated_at = excluded.updated_at,
                    origin_device_id = excluded.origin_device_id",
                rusqlite::params![
                    conn.id,
                    conn.kind.as_str(),
                    conn.name,
                    conn.group,
                    conn.env_tag,
                    serde_json::to_string(&conn.tags).unwrap_or_else(|_| "[]".to_string()),
                    conn.config,
                    conn.credential_ref,
                    conn.created_at,
                    conn.updated_at,
                    conn.origin_device_id,
                ],
            )
            .map_err(map_sqlite)?;

        // 同步到全局标签表
        let _ = self.clear_resource_tags(crate::tag::TaggableKind::Connection, &conn.id);
        let mut user_paths = Vec::new();
        let mut seen_creator = false;
        for tag in &conn.tags {
            if let Some((key, value)) = crate::tag::system_tag_key_value(tag) {
                if key == "creator" {
                    if seen_creator {
                        continue;
                    }
                    seen_creator = true;
                }
                let _ = self.resource_set_system_key(
                    crate::tag::TaggableKind::Connection,
                    &conn.id,
                    &key,
                    &value,
                );
                continue;
            }
            if let Some(path) = crate::tag::normalize_tag_path(tag)
                .or_else(|| crate::tag::normalize_tag_segment(tag))
            {
                user_paths.push(path);
            }
        }
        let _ = self.resource_set_user_tags(
            crate::tag::TaggableKind::Connection,
            &conn.id,
            &user_paths,
        );
        Ok(())
    }

    /// 删除连接（不存在视为成功）。
    pub fn delete_connection(&self, id: &str) -> OmniResult<()> {
        let _ = self.clear_resource_tags(crate::tag::TaggableKind::Connection, id);
        if let Ok(Some(conn)) = self.get_connection(id) {
            let rt = match conn.kind {
                ConnectionKind::Ssh => "ssh",
                ConnectionKind::Database => "database",
                ConnectionKind::Docker => "docker",
                ConnectionKind::File => "files",
                ConnectionKind::Panel
                | ConnectionKind::Cloud
                | ConnectionKind::Protocol
                | ConnectionKind::Service => "ssh",
            };
            let _ = self.delete_resource_observations(rt, id);
        }
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
                let tags_json: String = row.get(5)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok((
                    Connection {
                        id: row.get(0)?,
                        kind: ConnectionKind::Ssh, // 占位，下方按 kind_str 修正
                        name: row.get(2)?,
                        group: row.get(3)?,
                        env_tag: row.get(4)?,
                        tags,
                        config: row.get(6)?,
                        credential_ref: row.get(7)?,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                        origin_device_id: row.get(10).unwrap_or_default(),
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

    /// 把还写在 `origin:` 标签上的创建设备 id 迁进字段。已经迁过的不再改。
    pub(crate) fn backfill_connection_origins(&self) -> OmniResult<()> {
        let connections = self.list_connections()?;
        for conn in connections {
            if crate::tag::origin_device_id(&conn.tags).is_some() {
                self.save_connection(&conn)?;
            }
        }
        Ok(())
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
            tags: vec![],
            config: r#"{"host":"127.0.0.1","port":22}"#.into(),
            credential_ref: Some(format!("cred-{id}")),
            created_at: 1_700_000_000,
            updated_at: 1_700_000_000,
            origin_device_id: String::new(),
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

    #[test]
    fn service_kind_roundtrip() {
        let storage = Storage::open_in_memory().unwrap();
        storage
            .save_connection(&sample("svc", ConnectionKind::Service))
            .unwrap();
        let got = storage.get_connection("svc").unwrap().unwrap();
        assert_eq!(got.kind, ConnectionKind::Service);
        assert_eq!(got.kind.as_str(), "service");
        let json = serde_json::to_string(&got.kind).unwrap();
        assert_eq!(json, "\"service\"");
        let back: ConnectionKind = serde_json::from_str(&json).unwrap();
        assert_eq!(back, ConnectionKind::Service);
    }

    #[test]
    fn origin_is_written_once_and_leaves_the_tag() {
        let storage = Storage::open_in_memory().unwrap();
        let mut conn = sample("origin", ConnectionKind::Ssh);
        conn.tags = vec!["origin:dev-a".into(), "env:prod".into()];
        storage.save_connection(&conn).unwrap();
        let saved = storage.get_connection("origin").unwrap().unwrap();
        assert_eq!(saved.origin_device_id, "dev-a");
        assert!(!saved.tags.iter().any(|tag| tag.starts_with("origin:")));
        assert!(saved.tags.iter().any(|tag| tag == "env:prod"));

        conn.origin_device_id = "dev-b".into();
        conn.tags = vec!["origin:dev-c".into()];
        storage.save_connection(&conn).unwrap();
        let again = storage.get_connection("origin").unwrap().unwrap();
        assert_eq!(again.origin_device_id, "dev-a");
    }

    #[test]
    fn save_keeps_one_creator_and_does_not_replace_it() {
        let storage = Storage::open_in_memory().unwrap();
        let mut conn = sample("creator", ConnectionKind::Ssh);
        conn.tags = vec![
            "sys/creator/MZ".into(),
            "sys/creator/MACT-HOME".into(),
            "prod".into(),
            "prod".into(),
        ];
        storage.save_connection(&conn).unwrap();
        let saved = storage.get_connection("creator").unwrap().unwrap();
        assert_eq!(
            saved
                .tags
                .iter()
                .filter(|tag| {
                    let text = tag.to_ascii_lowercase();
                    text.starts_with("creator:") || text.starts_with("sys/creator/")
                })
                .collect::<Vec<_>>(),
            vec!["sys/creator/MZ"]
        );
        assert_eq!(saved.tags.iter().filter(|tag| *tag == "prod").count(), 1);

        conn.tags = vec!["creator:MACT-HOME".into(), "os:Linux".into()];
        conn.name = "renamed".into();
        storage.save_connection(&conn).unwrap();
        let again = storage.get_connection("creator").unwrap().unwrap();
        assert_eq!(again.name, "renamed");
        assert!(again.tags.iter().any(|tag| tag == "sys/creator/MZ"));
        assert!(!again.tags.iter().any(|tag| tag.contains("MACT-HOME")));
        assert_eq!(
            again
                .tags
                .iter()
                .filter(|tag| {
                    let text = tag.to_ascii_lowercase();
                    text.starts_with("creator:") || text.starts_with("sys/creator/")
                })
                .count(),
            1
        );
    }

    #[test]
    fn synced_save_keeps_the_creator_chosen_by_the_other_device() {
        let storage = Storage::open_in_memory().unwrap();
        let mut conn = sample("creator", ConnectionKind::Ssh);
        conn.tags = vec!["sys/creator/MACT-OFFICE".into()];
        storage.save_connection(&conn).unwrap();

        conn.tags = vec!["sys/creator/MZ".into(), "sys/os/Ubuntu".into()];
        storage.save_synced_connection(&conn).unwrap();
        let saved = storage.get_connection("creator").unwrap().unwrap();
        assert!(saved.tags.iter().any(|tag| tag == "sys/creator/MZ"));
        assert!(!saved.tags.iter().any(|tag| tag.contains("MACT-OFFICE")));
    }

    #[test]
    fn replacing_creator_can_clear_the_stored_name() {
        let storage = Storage::open_in_memory().unwrap();
        let mut conn = sample("creator", ConnectionKind::Ssh);
        conn.tags = vec!["sys/creator/MACT-HOME".into()];
        storage.save_connection(&conn).unwrap();

        conn.tags = vec!["sys/os/Ubuntu".into()];
        storage.save_connection_replacing_creator(&conn).unwrap();
        let saved = storage.get_connection("creator").unwrap().unwrap();
        assert!(saved.tags.iter().all(|tag| !tag.contains("creator")));
        assert!(saved.tags.iter().any(|tag| tag.contains("Ubuntu")));
    }

    #[test]
    fn system_tag_projection_keeps_creator_that_only_lives_on_the_row() {
        let storage = Storage::open_in_memory().unwrap();
        let mut conn = sample("creator", ConnectionKind::Ssh);
        conn.tags = vec!["sys/creator/MZ".into()];
        storage.save_connection(&conn).unwrap();
        storage
            .clear_resource_tags(crate::tag::TaggableKind::Connection, "creator")
            .unwrap();

        storage
            .resource_set_system_key(
                crate::tag::TaggableKind::Connection,
                "creator",
                "os",
                "Ubuntu 24.04.4 LTS",
            )
            .unwrap();

        let saved = storage.get_connection("creator").unwrap().unwrap();
        assert!(saved.tags.iter().any(|tag| tag == "sys/creator/MZ"));
        assert!(
            saved
                .tags
                .iter()
                .any(|tag| tag == "sys/os/Ubuntu 24.04.4 LTS")
        );
    }
}
