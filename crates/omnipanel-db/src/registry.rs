//! `DbDriver` 注册表：按 `db_type`（含别名）分发 connect，取代散落的 match 主路径。

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::OnceLock;

use omnipanel_error::{OmniError, OmniResult};

use crate::engine_contract::FirstPartyEngine;
use crate::sidecar_catalog::CatalogFamily;
use crate::{DbDriver, DbParams, mysql, postgres, qdrant, sqlite, sqlserver};

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
                Ok(boxed_driver(
                    sqlserver::SqlServerDriver::connect(&params).await?,
                ))
            })
        }),
        connect_exclusive: Some(Box::new(|params| {
            Box::pin(async move {
                Ok(boxed_driver(
                    sqlserver::SqlServerDriver::connect(&params).await?,
                ))
            })
        })),
    });

    registry.register(DriverRegistration {
        keys: FirstPartyEngine::Redis.keys().to_vec(),
        connect: Box::new(|params| {
            Box::pin(async move {
                Ok(boxed_driver(
                    crate::redis::RedisDriver::connect(&params).await?,
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
                match crate::sidecar::connect_engine(crate::sidecar::EngineKind::MongoDb, &params)
                    .await
                {
                    Ok(driver) => Ok(boxed_driver(driver)),
                    Err(err) => {
                        tracing::warn!("MongoDB sidecar 不可用，回退进程内驱动: {err}");
                        Ok(boxed_driver(
                            crate::mongodb::MongoDriver::connect(&params).await?,
                        ))
                    }
                }
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
            Box::pin(async move {
                Ok(boxed_driver(
                    crate::sidecar::connect_clickhouse(&params).await?,
                ))
            })
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
    if crate::sidecar::plugin_engine_claimed(&params.db_type) {
        return Err(claimed_plugin_unavailable(params));
    }
    tracing::debug!(
        db_type = %params.db_type,
        "未注册 sidecar，尝试方言兼容驱动"
    );
    connect_compatible_family(params).await
}

async fn connect_compatible_family(params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
    match family_of(params) {
        CatalogFamily::PostgresLike => Ok(boxed_driver(postgres::PgDriver::connect(params).await?)),
        CatalogFamily::MysqlLike => Ok(boxed_driver(mysql::MySqlDriver::connect(params).await?)),
        _ => Err(OmniError::invalid_input(format!(
            "不支持的数据库类型：{}",
            params.db_type
        ))),
    }
}

fn family_of(params: &DbParams) -> CatalogFamily {
    crate::sidecar_catalog::catalog_family(&params.db_type)
}

fn claimed_plugin_unavailable(params: &DbParams) -> OmniError {
    let detail = crate::sidecar::plugin_engine_claim_error(&params.db_type)
        .unwrap_or_else(|| "sidecar 无法启动".to_string());
    OmniError::connection(format!(
        "引擎 {} 已安装插件，禁止回退兼容驱动：{detail}",
        params.db_type
    ))
}

pub async fn connect_exclusive_registered(params: &DbParams) -> OmniResult<Box<dyn DbDriver>> {
    let registry = global_driver_registry();
    if registry.contains(&params.db_type) {
        return registry.connect_exclusive(params).await;
    }
    // 与普连一致：有 sidecar launch 则走同一条路径（共享 agent + session）。
    if let Some(launch) = crate::sidecar::launch_for_params(params) {
        return crate::sidecar::connect_launch(&launch, params)
            .await
            .map(boxed_driver);
    }
    if crate::sidecar::plugin_engine_claimed(&params.db_type) {
        return Err(claimed_plugin_unavailable(params));
    }
    match family_of(params) {
        CatalogFamily::PostgresLike => Ok(boxed_driver(
            postgres::PgDriver::connect_exclusive(params).await?,
        )),
        CatalogFamily::MysqlLike => Ok(boxed_driver(
            mysql::MySqlDriver::connect_exclusive(params).await?,
        )),
        CatalogFamily::OracleLike => Err(OmniError::invalid_input(format!(
            "手动事务需要先安装 {} 引擎插件，Oracle 系没有进程内回退",
            params.db_type
        ))),
        _ => Err(OmniError::invalid_input(format!(
            "手动事务暂不支持该引擎：{}",
            params.db_type
        ))),
    }
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
        ] {
            assert!(guard.contains(key), "missing driver alias {key}");
        }
        assert!(!guard.contains("oracle"));
        assert!(!guard.contains("highgo"));
        assert!(!guard.contains("dameng"));
        assert_eq!(
            crate::sidecar_catalog::catalog_family("highgo"),
            CatalogFamily::PostgresLike
        );
        assert_eq!(
            crate::sidecar_catalog::catalog_family("dameng"),
            CatalogFamily::OracleLike
        );
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

    fn dummy(db_type: &str) -> DbParams {
        DbParams {
            db_type: db_type.into(),
            host: "127.0.0.1".into(),
            port: 1,
            user: String::new(),
            password: String::new(),
            database: String::new(),
            ssl: false,
            sid: String::new(),
            sysdba: false,
        }
    }

    #[tokio::test]
    async fn claimed_plugin_does_not_fallback_to_postgres() {
        let _guard = crate::sidecar::lock_plugin_engine_for_test();
        crate::sidecar::set_plugin_engine_launches(
            Vec::<(String, crate::sidecar::EngineLaunch)>::new(),
        );
        crate::sidecar::set_plugin_engine_claims([(
            "highgo".into(),
            Some("未找到捆绑 JRE，请重新安装该引擎".into()),
        )]);
        let err = match connect_registered(&dummy("highgo")).await {
            Err(e) => e,
            Ok(_) => panic!("expected plugin claim error, got driver"),
        };
        let msg = err.to_string();
        assert!(msg.contains("已安装插件"), "{msg}");
        assert!(msg.contains("JRE"), "{msg}");
        assert!(!msg.contains("PostgreSQL 连接失败"), "{msg}");
        crate::sidecar::set_plugin_engine_claims(Vec::<(String, Option<String>)>::new());
    }

    #[tokio::test]
    async fn oracle_like_exclusive_without_plugin_errors() {
        let _guard = crate::sidecar::lock_plugin_engine_for_test();
        crate::sidecar::set_plugin_engine_launches(
            Vec::<(String, crate::sidecar::EngineLaunch)>::new(),
        );
        crate::sidecar::set_plugin_engine_claims(Vec::<(String, Option<String>)>::new());
        let err = match connect_exclusive_registered(&dummy("dameng")).await {
            Err(e) => e,
            Ok(_) => panic!("expected missing plugin error, got driver"),
        };
        let msg = err.to_string();
        assert!(msg.contains("引擎插件"), "{msg}");
        assert!(!msg.contains("PostgreSQL"), "{msg}");
    }
}
