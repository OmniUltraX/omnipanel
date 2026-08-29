//! 插件 Runtime：清单、权限、注册表、第一方命令网关。

mod candidate;
mod contribution;
mod engine_sidecar;
mod error;
mod executor;
mod first_party;
mod installed;
mod invoke;
mod kind;
mod manifest;
mod permission;
mod platform;
mod registry;
mod source;

pub use candidate::{ImportCandidate, upsert_candidates};
pub use contribution::{
    AiContributes, AiToolContribution, AiToolExecKind, DiscoveryContribution, HomeContribution,
    HomeOpenContribution, LauncherContribution, PluginContributes, ThemeContribution,
    UiContributes,
};
pub use engine_sidecar::{
    InstalledEngineDriver, collect_activated_installed_engine_drivers, connection_form_engine_keys,
};
pub use error::PluginError;
pub use executor::{
    AutoAllow, AutoDeny, ConfirmFuture, ConfirmRequest, DisabledExecutor, LogicFuture,
    LogicPackage, PluginHostBridge, PluginLogicExecutor, PluginLogicInstance, ProdConfirmer,
    RouterExecutor,
};
pub use first_party::{
    PLUGIN_ID_ADDON_EVERYTHING, PLUGIN_ID_CLOUD_ALIYUN, PLUGIN_ID_ENGINE_CLICKHOUSE,
    PLUGIN_ID_ENGINE_MONGODB, PLUGIN_ID_ENGINE_MYSQL, PLUGIN_ID_ENGINE_POSTGRES,
    PLUGIN_ID_ENGINE_QDRANT, PLUGIN_ID_ENGINE_REDIS, PLUGIN_ID_ENGINE_SQLITE,
    PLUGIN_ID_ENGINE_SQLSERVER, PLUGIN_ID_IMPORTER_DOCKER_DB, PLUGIN_ID_IMPORTER_WARPGATE,
    PLUGIN_ID_MODULE_NACOS, PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT, PLUGIN_ID_THEME_DEFAULT,
    addon_everything, cloud_aliyun, engine_clickhouse, engine_mongodb, engine_mysql,
    engine_postgres, engine_qdrant, engine_redis, engine_sqlite, engine_sqlserver,
    first_party_asset_bytes, first_party_logic_bytes, first_party_manifests, importer_docker_db,
    importer_warpgate, module_nacos, panel_1panel, panel_bt, theme_default,
};
pub use installed::{InstalledPlugin, load_installed};
pub use invoke::{InvokeFuture, InvokeGateway, InvokeHandler};
pub use kind::PluginKind;
pub use manifest::{
    HOST_API_VERSION, PluginEntryDecl, PluginManifest, PluginMethodDecl, PluginRuntime,
};
pub use permission::PluginPermission;
pub use platform::PluginPlatform;
pub use registry::{
    ContributionIndex, PluginEntry, PluginListItem, PluginRegistry, UNSUPPORTED_REASON_PLATFORM,
};
pub use source::PluginSource;
