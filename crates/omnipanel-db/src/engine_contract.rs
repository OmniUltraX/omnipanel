//! 第一方数据库引擎合同：plugin_id / db_type 别名 / 默认运行时。
//!
//! 与仓库 `plugins/db-*/plugin.json` 对齐。DriverRegistry 的 alias 与插件门禁
//! 都走这张表，避免 sidecar `EngineKind`、前端清单、建连闭包各写一份身份。
//!
//! SQL Server 走 tiberius 进程内（`omni.engine.sqlserver`），不走 DBX JDBC。

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FirstPartyEngine {
    MySql,
    Postgres,
    Sqlite,
    SqlServer,
    Redis,
    MongoDb,
    ClickHouse,
    Qdrant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FirstPartyRuntime {
    Inproc,
    Sidecar,
}

impl FirstPartyEngine {
    pub const ALL: [Self; 8] = [
        Self::MySql,
        Self::Postgres,
        Self::Sqlite,
        Self::SqlServer,
        Self::Redis,
        Self::MongoDb,
        Self::ClickHouse,
        Self::Qdrant,
    ];

    pub fn from_db_type(db_type: &str) -> Option<Self> {
        let key = db_type.to_ascii_lowercase();
        Self::ALL
            .iter()
            .copied()
            .find(|engine| engine.keys().iter().any(|alias| *alias == key))
    }

    pub fn from_plugin_id(id: &str) -> Option<Self> {
        Self::ALL
            .iter()
            .copied()
            .find(|engine| engine.plugin_id() == id)
    }

    pub fn plugin_id(self) -> &'static str {
        match self {
            Self::MySql => "omni.engine.mysql",
            Self::Postgres => "omni.engine.postgres",
            Self::Sqlite => "omni.engine.sqlite",
            Self::SqlServer => "omni.engine.sqlserver",
            Self::Redis => "omni.engine.redis",
            Self::MongoDb => "omni.engine.mongodb",
            Self::ClickHouse => "omni.engine.clickhouse",
            Self::Qdrant => "omni.engine.qdrant",
        }
    }

    pub fn plugin_folder(self) -> &'static str {
        match self {
            Self::MySql => "db-mysql",
            Self::Postgres => "db-postgres",
            Self::Sqlite => "db-sqlite",
            Self::SqlServer => "db-sqlserver",
            Self::Redis => "db-redis",
            Self::MongoDb => "db-mongodb",
            Self::ClickHouse => "db-clickhouse",
            Self::Qdrant => "db-qdrant",
        }
    }

    pub fn keys(self) -> &'static [&'static str] {
        match self {
            Self::MySql => &["mysql", "mariadb"],
            Self::Postgres => &["postgres", "postgresql", "pg"],
            Self::Sqlite => &["sqlite", "sqlite3"],
            Self::SqlServer => &["sqlserver", "mssql", "sql server"],
            Self::Redis => &["redis"],
            Self::MongoDb => &["mongodb", "mongo"],
            Self::ClickHouse => &["clickhouse", "ch"],
            Self::Qdrant => &["qdrant"],
        }
    }

    /// 产品默认运行时。MySQL / PG 仍可用 `OMNIPANEL_SQL_SIDECAR=1` 临时切 sidecar。
    pub fn runtime(self) -> FirstPartyRuntime {
        match self {
            Self::MongoDb | Self::ClickHouse => FirstPartyRuntime::Sidecar,
            Self::MySql
            | Self::Postgres
            | Self::Sqlite
            | Self::SqlServer
            | Self::Redis
            | Self::Qdrant => FirstPartyRuntime::Inproc,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn plugin_ids_and_keys_are_unique() {
        let mut ids = HashSet::new();
        let mut keys = HashSet::new();
        for engine in FirstPartyEngine::ALL {
            assert!(ids.insert(engine.plugin_id()), "duplicate plugin_id");
            for key in engine.keys() {
                assert!(keys.insert(*key), "duplicate db_type alias {key}");
                assert_eq!(FirstPartyEngine::from_db_type(key), Some(engine));
            }
            assert_eq!(
                FirstPartyEngine::from_plugin_id(engine.plugin_id()),
                Some(engine)
            );
        }
        assert_eq!(FirstPartyEngine::from_db_type("oracle"), None);
        assert_eq!(
            FirstPartyEngine::from_db_type("sqlserver"),
            Some(FirstPartyEngine::SqlServer)
        );
        assert_eq!(
            FirstPartyEngine::from_db_type("mssql"),
            Some(FirstPartyEngine::SqlServer)
        );
    }

    #[test]
    fn default_runtime_matches_product_contract() {
        assert_eq!(FirstPartyEngine::MySql.runtime(), FirstPartyRuntime::Inproc);
        assert_eq!(
            FirstPartyEngine::Postgres.runtime(),
            FirstPartyRuntime::Inproc
        );
        assert_eq!(
            FirstPartyEngine::Sqlite.runtime(),
            FirstPartyRuntime::Inproc
        );
        assert_eq!(
            FirstPartyEngine::SqlServer.runtime(),
            FirstPartyRuntime::Inproc
        );
        assert_eq!(
            FirstPartyEngine::Qdrant.runtime(),
            FirstPartyRuntime::Inproc
        );
        assert_eq!(FirstPartyEngine::Redis.runtime(), FirstPartyRuntime::Inproc);
        assert_eq!(
            FirstPartyEngine::MongoDb.runtime(),
            FirstPartyRuntime::Sidecar
        );
        assert_eq!(
            FirstPartyEngine::ClickHouse.runtime(),
            FirstPartyRuntime::Sidecar
        );
    }
}
