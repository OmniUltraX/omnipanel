//! `DbDriver` 注册表：按 `db_type`（含别名）分发 connect，取代散落的 match 主路径。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use omnipanel_error::{OmniError, OmniResult};

use crate::engine_contract::FirstPartyEngine;
use crate::{mysql, postgres, qdrant, sqlite, sqlserver, DbDriver, DbParams};

type ConnectFuture = Pin<Box<dyn Future<Output = OmniResult<Box<dyn DbDriver>>> + Send>>;
type ConnectFn = Box<dyn Fn(DbParams) -> ConnectFuture + Send + Sync>;

pub struct DriverRegistration {
    pub keys: Vec<&'static str>,
    pub connect: ConnectFn,
    pub connect_exclusive: Option<ConnectFn>,
}

#[derive(Default)]
pub struct DriverRegistry {
    by_key: HashMap<String, usize>,
    entries: Vec<DriverRegistration>,
}

impl DriverRegistry {
    pub fn register(&mut self, registration: DriverRegistration) {
        let idx = self.entries.len();
        for key in &registration.keys {
            self.by_key.insert((*key).to_ascii_lowercase(), idx);
        }
        self.entries.push(registration);
    }

    pub fn contains(&self, db_type: &str) -> bool {
        self.by_key.contains_key(&db_type.to_ascii_lowercase())
    }

    #[allow(dead_code)]
    pub fn aliases(&self) -> Vec<String> {
        self.by_key.keys().cloned().collect()
    }

    pub async fn connect(&self, params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
        let key = params.db_type.to_ascii_lowercase();
        let idx = *self.by_key.get(&key).ok_or_else(|| {
            OmniError::invalid_input(format!("不支持的数据库类型：{}", params.db_type))
        })?;
        (self.entries[idx].connect)(params.clone()).await
    }

    pub async fn connect_exclusive(&self, params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
        let key = params.db_type.to_ascii_lowercase();
        let idx = *self.by_key.get(&key).ok_or_else(|| {
            OmniError::invalid_input(format!("手动事务暂不支持该引擎：{}", params.db_type))
        })?;
        match &self.entries[idx].connect_exclusive {
            Some(connect) => connect(params.clone()).await,
            None => Err(OmniError::invalid_input(format!(
                "手动事务暂不支持该引擎：{}",
                params.db_type
            ))),
        }
    }
}

fn boxed_driver<D: DbDriver + 'static>(driver: D) -> Box<dyn DbDriver> {
    Box::new(driver)
}

fn seed_builtin_drivers() -> DriverRegistry {
    let mut registry = DriverRegistry::default();

    registry.register(DriverRegistration {
        keys: FirstPartyEngine::MySql.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move {
                if let Some(launch) = crate::sidecar::launch_for_params(&params) {
                    return Ok(boxed_driver(
                        crate::sidecar::connect_launch(&launch, &params).await?,
                    ));
                }
                Ok(boxed_driver(mysql::MySqlDriver::connect(&params).await?))
            })
        }),
        connect_exclusive: Some(Box::new(|params| {
            Box::pin(async move {
                if let Some(launch) = crate::sidecar::launch_for_params(&params) {
                    return Ok(boxed_driver(
                        crate::sidecar::connect_launch(&launch, &params).await?,
                    ));
                }
                Ok(boxed_driver(
                    mysql::MySqlDriver::connect_exclusive(&params).await?,
                ))
            })
        })),
    });

    registry.register(DriverRegistration {
        keys: FirstPartyEngine::Postgres.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move {
                if let Some(launch) = crate::sidecar::launch_for_params(&params) {
                    return Ok(boxed_driver(
                        crate::sidecar::connect_launch(&launch, &params).await?,
                    ));
                }
                Ok(boxed_driver(postgres::PgDriver::connect(&params).await?))
            })
        }),
        connect_exclusive: Some(Box::new(|params| {
            Box::pin(async move {
                if let Some(launch) = crate::sidecar::launch_for_params(&params) {
                    return Ok(boxed_driver(
                        crate::sidecar::connect_launch(&launch, &params).await?,
                    ));
                }
                Ok(boxed_driver(
                    postgres::PgDriver::connect_exclusive(&params).await?,
                ))
            })
        })),
    });

    registry.register(DriverRegistration {
        keys: FirstPartyEngine::Sqlite.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move { Ok(boxed_driver(sqlite::SqliteDriver::connect(&params).await?)) })
        }),
        connect_exclusive: None,
    });

    registry.register(DriverRegistration {
        keys: FirstPartyEngine::SqlServer.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move {
                Ok(boxed_driver(sqlserver::SqlServerDriver::connect(&params).await?))
            })
        }),
        connect_exclusive: Some(Box::new(|params| {
            Box::pin(async move {
                Ok(boxed_driver(sqlserver::SqlServerDriver::connect(&params).await?))
            })
        })),
    });

    registry.register(DriverRegistration {
        keys: FirstPartyEngine::Redis.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move {
                Ok(boxed_driver(
                    crate::sidecar::connect_engine(crate::sidecar::EngineKind::Redis, &params)
                        .await?,
                ))
            })
        }),
        connect_exclusive: None,
    });

    registry.register(DriverRegistration {
        keys: FirstPartyEngine::MongoDb.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move {
                let mut params = params;
                if params.database.trim().is_empty() {
                    params.database = "admin".to_string();
                }
                Ok(boxed_driver(
                    crate::sidecar::connect_engine(crate::sidecar::EngineKind::MongoDb, &params)
                        .await?,
                ))
            })
        }),
        connect_exclusive: None,
    });

    // Qdrant 实现仍在本 crate；插件只声明引擎 key / 表单 / inproc。
    registry.register(DriverRegistration {
        keys: FirstPartyEngine::Qdrant.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move { Ok(boxed_driver(qdrant::QdrantDriver::connect(&params).await?)) })
        }),
        connect_exclusive: None,
    });

    // ClickHouse 走 T1 sidecar（omnipanel-engine-clickhouse）；本 crate 只保留 HTTP 实现给 sidecar 进程用。
    registry.register(DriverRegistration {
        keys: FirstPartyEngine::ClickHouse.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move { Ok(boxed_driver(crate::sidecar::connect_clickhouse(&params).await?)) })
        }),
        connect_exclusive: None,
    });

    registry
}

static GLOBAL: OnceLock<DriverRegistry> = OnceLock::new();

pub fn global_driver_registry() -> &'static DriverRegistry {
    GLOBAL.get_or_init(seed_builtin_drivers)
}

pub async fn connect_registered(params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
    let registry = global_driver_registry();
    if registry.contains(&params.db_type) {
        return registry.connect(params).await;
    }
    if let Some(launch) = crate::sidecar::launch_for_params(params) {
        return crate::sidecar::connect_launch(&launch, params)
            .await
            .map(boxed_driver);
    }
    Err(OmniError::invalid_input(format!(
        "不支持的数据库类型：{}",
        params.db_type
    )))
}

pub async fn connect_exclusive_registered(params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
    global_driver_registry().connect_exclusive(params).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtins_include_core_engines_and_qdrant() {
        let guard = global_driver_registry();
        for key in [
            "mysql",
            "mariadb",
            "postgres",
            "postgresql",
            "sqlite",
            "sqlserver",
            "mssql",
            "redis",
            "mongodb",
            "qdrant",
            "clickhouse",
            "ch",
        ]
        {
            assert!(guard.contains(key), "missing driver alias {key}");
        }
        assert!(!guard.contains("oracle"));
        assert!(guard.aliases().iter().any(|k| k == "qdrant"));
        for engine in crate::FirstPartyEngine::ALL {
            for key in engine.keys() {
                assert!(
                    guard.contains(key),
                    "DriverRegistry 缺少 FirstPartyEngine alias {key}"
                );
            }
        }
    }
}
