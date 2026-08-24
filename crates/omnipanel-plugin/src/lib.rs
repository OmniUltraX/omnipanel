//! 插件 Runtime：清单、权限、注册表、第一方命令网关。

mod candidate;
mod contribution;
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

pub use candidate::{upsert_candidates, ImportCandidate};
pub use contribution::{
    AiContributes, AiToolContribution, AiToolExecKind, DiscoveryContribution, LauncherContribution,
    PluginContributes, ThemeContribution, UiContributes,
};
pub use error::PluginError;
pub use executor::{
    AutoAllow, AutoDeny, ConfirmFuture, ConfirmRequest, ProdConfirmer, LogicFuture, LogicPackage, PluginHostBridge, PluginLogicExecutor,
    PluginLogicInstance, RouterExecutor,
};
pub use first_party::{
    addon_everything, cloud_aliyun, engine_clickhouse, engine_qdrant, engine_redis,
    first_party_manifests, importer_warpgate, module_nacos, panel_1panel, panel_bt, theme_default,
    PLUGIN_ID_ADDON_EVERYTHING, PLUGIN_ID_CLOUD_ALIYUN, PLUGIN_ID_ENGINE_CLICKHOUSE,
    PLUGIN_ID_ENGINE_QDRANT, PLUGIN_ID_ENGINE_REDIS, PLUGIN_ID_IMPORTER_WARPGATE,
    PLUGIN_ID_MODULE_NACOS, PLUGIN_ID_PANEL_1PANEL, PLUGIN_ID_PANEL_BT, PLUGIN_ID_THEME_DEFAULT,
};
pub use installed::{load_installed, InstalledPlugin};
pub use invoke::{InvokeFuture, InvokeGateway, InvokeHandler};
pub use kind::PluginKind;
pub use manifest::{PluginEntryDecl, PluginManifest, PluginMethodDecl, HOST_API_VERSION};
pub use permission::PluginPermission;
pub use platform::PluginPlatform;
pub use registry::{
    ContributionIndex, PluginEntry, PluginListItem, PluginRegistry, UNSUPPORTED_REASON_PLATFORM,
};
pub use source::PluginSource;
