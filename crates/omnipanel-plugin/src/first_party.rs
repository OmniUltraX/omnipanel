use crate::manifest::PluginManifest;

pub const PLUGIN_ID_THEME_DEFAULT: &str = "omni.theme.default";
pub const PLUGIN_ID_ADDON_EVERYTHING: &str = "omni.addon.everything";
pub const PLUGIN_ID_CLOUD_ALIYUN: &str = "omni.cloud.aliyun";
pub const PLUGIN_ID_CLOUD_TENCENT: &str = "omni.cloud.tencent";
pub const PLUGIN_ID_CLOUD_HUAWEI: &str = "omni.cloud.huawei";
pub const PLUGIN_ID_CLOUD_AWS: &str = "omni.cloud.aws";
pub const PLUGIN_ID_CLOUD_AZURE: &str = "omni.cloud.azure";
pub const PLUGIN_ID_CLOUD_DIGITALOCEAN: &str = "omni.cloud.digitalocean";
pub const PLUGIN_ID_CLOUD_GCP: &str = "omni.cloud.gcp";
pub const PLUGIN_ID_CLOUD_BANDWAGON: &str = "omni.cloud.bandwagon";
pub const PLUGIN_ID_PANEL_1PANEL: &str = "omni.panel.1panel";
pub const PLUGIN_ID_PANEL_BT: &str = "omni.panel.bt";
pub const PLUGIN_ID_PANEL_HESTIA: &str = "omni.panel.hestia";
pub const PLUGIN_ID_ENGINE_QDRANT: &str = "omni.engine.qdrant";
pub const PLUGIN_ID_ENGINE_CLICKHOUSE: &str = "omni.engine.clickhouse";
pub const PLUGIN_ID_ENGINE_MONGODB: &str = "omni.engine.mongodb";
pub const PLUGIN_ID_ENGINE_MYSQL: &str = "omni.engine.mysql";
pub const PLUGIN_ID_ENGINE_POSTGRES: &str = "omni.engine.postgres";
pub const PLUGIN_ID_ENGINE_REDIS: &str = "omni.engine.redis";
pub const PLUGIN_ID_ENGINE_SQLITE: &str = "omni.engine.sqlite";
pub const PLUGIN_ID_ENGINE_SQLSERVER: &str = "omni.engine.sqlserver";
/// 独立交付插件（不进 first_party_manifests）；仅作 id 常量供测试 / 文档引用。
pub const PLUGIN_ID_MODULE_NACOS: &str = "omni.module.nacos";
pub const PLUGIN_ID_IMPORTER_WARPGATE: &str = "omni.importer.warpgate";
pub const PLUGIN_ID_IMPORTER_DOCKER_DB: &str = "omni.importer.docker-db";

/// 仓库 `plugins/<dir>/plugin.json` 是第一方清单唯一事实源。
macro_rules! first_party_manifest {
    ($dir:literal) => {{
        crate::manifest::PluginManifest::from_json(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../plugins/",
            $dir,
            "/plugin.json"
        )))
        .unwrap_or_else(|e| panic!("第一方清单 plugins/{}/plugin.json 非法: {e}", $dir))
    }};
}

pub fn theme_default() -> PluginManifest {
    first_party_manifest!("theme-default")
}

pub fn addon_everything() -> PluginManifest {
    first_party_manifest!("addon-everything")
}

/// download-only：仅供测试读清单，不进 `first_party_manifests`。
/// 运行时读盘（禁止 `include_str!`），否则独立仓 pack CI checkout 宿主时
/// 未拉 submodule 会导致整个 `omnipanel-plugin` 编译失败。
fn download_only_manifest(dir: &str) -> PluginManifest {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../plugins")
        .join(dir)
        .join("plugin.json");
    let json = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读 download-only 清单 {} 失败: {e}（需 git submodule update --init）",
            path.display()
        )
    });
    PluginManifest::from_json(&json)
        .unwrap_or_else(|e| panic!("download-only 清单 plugins/{dir}/plugin.json 非法: {e}"))
}

pub fn cloud_aliyun() -> PluginManifest {
    download_only_manifest("cloud-aliyun")
}

pub fn cloud_tencent() -> PluginManifest {
    download_only_manifest("cloud-tencent")
}

pub fn cloud_huawei() -> PluginManifest {
    download_only_manifest("cloud-huawei")
}

pub fn cloud_aws() -> PluginManifest {
    download_only_manifest("cloud-aws")
}

pub fn cloud_azure() -> PluginManifest {
    download_only_manifest("cloud-azure")
}

pub fn cloud_digitalocean() -> PluginManifest {
    download_only_manifest("cloud-digitalocean")
}

pub fn cloud_gcp() -> PluginManifest {
    download_only_manifest("cloud-gcp")
}

pub fn cloud_bandwagon() -> PluginManifest {
    download_only_manifest("cloud-bandwagon")
}

pub fn panel_1panel() -> PluginManifest {
    first_party_manifest!("panel-1panel")
}

pub fn panel_bt() -> PluginManifest {
    first_party_manifest!("panel-bt")
}

pub fn panel_hestia() -> PluginManifest {
    first_party_manifest!("panel-hestia")
}

pub fn engine_qdrant() -> PluginManifest {
    first_party_manifest!("db-qdrant")
}

pub fn engine_clickhouse() -> PluginManifest {
    first_party_manifest!("db-clickhouse")
}

pub fn engine_mongodb() -> PluginManifest {
    first_party_manifest!("db-mongodb")
}

pub fn engine_mysql() -> PluginManifest {
    first_party_manifest!("db-mysql")
}

pub fn engine_postgres() -> PluginManifest {
    first_party_manifest!("db-postgres")
}

pub fn engine_redis() -> PluginManifest {
    first_party_manifest!("db-redis")
}

pub fn engine_sqlite() -> PluginManifest {
    first_party_manifest!("db-sqlite")
}

pub fn engine_sqlserver() -> PluginManifest {
    first_party_manifest!("db-sqlserver")
}

pub fn importer_warpgate() -> PluginManifest {
    first_party_manifest!("importer-warpgate")
}

pub fn importer_docker_db() -> PluginManifest {
    first_party_manifest!("importer-docker-db")
}

/// 第一方 L2 逻辑包（内置插件不落盘时由宿主嵌入装载）。
/// 全部云厂商已 download-only，不在此嵌入。
pub fn first_party_logic_bytes(plugin_id: &str, logic_rel: &str) -> Option<Vec<u8>> {
    let rel = logic_rel.trim().replace('\\', "/");
    match (plugin_id, rel.as_str()) {
        (PLUGIN_ID_IMPORTER_WARPGATE, "logic.js") => Some(
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/importer-warpgate/logic.js"
            ))
            .as_bytes()
            .to_vec(),
        ),
        (PLUGIN_ID_PANEL_HESTIA, "logic.js") => Some(
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/panel-hestia/logic.js"
            ))
            .as_bytes()
            .to_vec(),
        ),
        _ => None,
    }
}

/// 第一方包内资产（首页图标等）；路径须相对且禁止 `..`。
pub fn first_party_asset_bytes(plugin_id: &str, rel: &str) -> Option<Vec<u8>> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.contains("://")
        || rel.split('/').any(|seg| seg == "..")
    {
        return None;
    }
    match (plugin_id, rel.as_str()) {
        (PLUGIN_ID_IMPORTER_WARPGATE, "icon.svg") => Some(
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/importer-warpgate/icon.svg"
            ))
            .as_bytes()
            .to_vec(),
        ),
        (PLUGIN_ID_IMPORTER_DOCKER_DB, "icon.svg") => Some(
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/importer-docker-db/icon.svg"
            ))
            .as_bytes()
            .to_vec(),
        ),
        (PLUGIN_ID_THEME_DEFAULT, "tokens.json") => Some(
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/theme-default/tokens.json"
            ))
            .as_bytes()
            .to_vec(),
        ),
        _ => None,
    }
}

pub fn first_party_manifests() -> Vec<PluginManifest> {
    vec![
        theme_default(),
        addon_everything(),
        // 全部云厂商 → download-only（安装后经 Runtime 装载）
        panel_1panel(),
        panel_bt(),
        panel_hestia(),
        engine_qdrant(),
        engine_clickhouse(),
        engine_mongodb(),
        engine_mysql(),
        engine_postgres(),
        engine_redis(),
        engine_sqlite(),
        engine_sqlserver(),
        importer_warpgate(),
        importer_docker_db(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_id_constants_match_json() {
        assert_eq!(theme_default().id, PLUGIN_ID_THEME_DEFAULT);
        assert_eq!(addon_everything().id, PLUGIN_ID_ADDON_EVERYTHING);
        assert_eq!(cloud_aliyun().id, PLUGIN_ID_CLOUD_ALIYUN);
        assert_eq!(cloud_aliyun().logic_entry(), Some("logic.js"));
        assert_eq!(cloud_tencent().id, PLUGIN_ID_CLOUD_TENCENT);
        assert_eq!(cloud_tencent().logic_entry(), Some("logic.js"));
        assert_eq!(cloud_huawei().id, PLUGIN_ID_CLOUD_HUAWEI);
        assert_eq!(cloud_huawei().logic_entry(), Some("logic.js"));
        assert_eq!(cloud_aws().id, PLUGIN_ID_CLOUD_AWS);
        assert_eq!(cloud_aws().logic_entry(), Some("logic.js"));
        assert_eq!(cloud_azure().id, PLUGIN_ID_CLOUD_AZURE);
        assert_eq!(cloud_azure().logic_entry(), Some("logic.js"));
        assert_eq!(cloud_digitalocean().id, PLUGIN_ID_CLOUD_DIGITALOCEAN);
        assert_eq!(cloud_digitalocean().logic_entry(), Some("logic.js"));
        assert_eq!(cloud_gcp().id, PLUGIN_ID_CLOUD_GCP);
        assert_eq!(cloud_gcp().logic_entry(), Some("logic.js"));
        assert_eq!(cloud_bandwagon().id, PLUGIN_ID_CLOUD_BANDWAGON);
        assert_eq!(cloud_bandwagon().logic_entry(), Some("logic.js"));
        // 全部云厂商已 download-only：不进 first_party，也不嵌入 logic.js
        for id in [
            PLUGIN_ID_CLOUD_ALIYUN,
            PLUGIN_ID_CLOUD_TENCENT,
            PLUGIN_ID_CLOUD_HUAWEI,
            PLUGIN_ID_CLOUD_AWS,
            PLUGIN_ID_CLOUD_AZURE,
            PLUGIN_ID_CLOUD_DIGITALOCEAN,
            PLUGIN_ID_CLOUD_GCP,
            PLUGIN_ID_CLOUD_BANDWAGON,
        ] {
            assert!(
                !first_party_manifests().iter().any(|m| m.id == id),
                "{id} 不应在 first_party_manifests"
            );
            assert!(first_party_logic_bytes(id, "logic.js").is_none());
        }
        assert_eq!(panel_1panel().id, PLUGIN_ID_PANEL_1PANEL);
        assert_eq!(panel_bt().id, PLUGIN_ID_PANEL_BT);
        assert_eq!(panel_hestia().id, PLUGIN_ID_PANEL_HESTIA);
        assert_eq!(panel_hestia().logic_entry(), Some("logic.js"));
        assert_eq!(engine_qdrant().id, PLUGIN_ID_ENGINE_QDRANT);
        assert_eq!(engine_clickhouse().id, PLUGIN_ID_ENGINE_CLICKHOUSE);
        assert_eq!(engine_mongodb().id, PLUGIN_ID_ENGINE_MONGODB);
        assert_eq!(engine_mysql().id, PLUGIN_ID_ENGINE_MYSQL);
        assert_eq!(engine_postgres().id, PLUGIN_ID_ENGINE_POSTGRES);
        assert_eq!(engine_redis().id, PLUGIN_ID_ENGINE_REDIS);
        assert_eq!(engine_sqlite().id, PLUGIN_ID_ENGINE_SQLITE);
        assert_eq!(engine_sqlserver().id, PLUGIN_ID_ENGINE_SQLSERVER);
        assert_eq!(importer_warpgate().id, PLUGIN_ID_IMPORTER_WARPGATE);
        assert_eq!(importer_docker_db().id, PLUGIN_ID_IMPORTER_DOCKER_DB);
        // Nacos 已改为独立 download 插件，不在 first_party_manifests 内
        assert!(!first_party_manifests()
            .iter()
            .any(|m| m.id == PLUGIN_ID_MODULE_NACOS));
    }

    #[test]
    fn cloud_aliyun_declares_capabilities_and_methods() {
        let manifest = cloud_aliyun();
        let methods: Vec<_> = manifest.methods.iter().map(|m| m.name.as_str()).collect();
        assert!(methods.contains(&"listResources"));
        assert!(methods.contains(&"invokeAction"));
        let caps = manifest
            .contributes
            .cloud
            .as_ref()
            .expect("cloud.capabilities")
            .capabilities
            .iter()
            .map(|c| c.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            caps,
            vec![
                "compute",
                "compute.lite",
                "network.securityGroup",
                "network.eip",
                "network.loadBalancer",
                "database",
                "database.cache",
                "storage.disk",
                "objectStorage",
                "domains",
                "certs"
            ]
        );
        assert!(manifest.contributes.ui.panel_tabs.is_empty());
    }

    #[test]
    fn cloud_tencent_declares_same_capability_ids() {
        let manifest = cloud_tencent();
        let caps: Vec<_> = manifest
            .contributes
            .cloud
            .as_ref()
            .expect("cloud.capabilities")
            .capabilities
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(
            caps,
            vec![
                "compute",
                "compute.lite",
                "network.securityGroup",
                "network.eip",
                "network.loadBalancer",
                "database",
                "database.cache",
                "storage.disk",
                "objectStorage",
                "domains",
                "certs"
            ]
        );
        assert_eq!(manifest.logic_entry(), Some("logic.js"));
        manifest.validate().expect("腾讯云 L2 清单应通过校验");
    }

    #[test]
    fn cloud_huawei_declares_same_capability_ids() {
        let manifest = cloud_huawei();
        let caps: Vec<_> = manifest
            .contributes
            .cloud
            .as_ref()
            .expect("cloud.capabilities")
            .capabilities
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(
            caps,
            vec![
                "compute",
                "compute.lite",
                "network.securityGroup",
                "network.eip",
                "network.loadBalancer",
                "database",
                "database.cache",
                "storage.disk",
                "objectStorage",
                "domains",
                "certs"
            ]
        );
        assert_eq!(manifest.logic_entry(), Some("logic.js"));
        manifest.validate().expect("华为云 L2 清单应通过校验");
    }

    #[test]
    fn clickhouse_form_keeps_optional_database() {
        let form = engine_clickhouse()
            .contributes
            .ui
            .connection_form
            .expect("clickhouse 必须声明 connectionForm");
        let fields = form
            .get("fields")
            .and_then(|v| v.as_array())
            .expect("fields");
        let database = fields
            .iter()
            .find(|f| f.get("key").and_then(|k| k.as_str()) == Some("database"))
            .expect("database field");
        assert_eq!(
            database.get("optional").and_then(|v| v.as_bool()),
            Some(true)
        );
    }

    #[test]
    fn clickhouse_declares_sidecar_runtime() {
        let manifest = engine_clickhouse();
        assert_eq!(manifest.runtime, Some(crate::PluginRuntime::Sidecar));
        assert_eq!(
            manifest.driver_entry(),
            Some("bin/omnipanel-engine-clickhouse")
        );
        manifest
            .validate()
            .expect("clickhouse sidecar 清单应通过校验");
    }

    #[test]
    fn redis_declares_inproc_runtime() {
        let manifest = engine_redis();
        assert_eq!(manifest.runtime, Some(crate::PluginRuntime::Inproc));
        assert_eq!(manifest.driver_entry(), None);
        manifest.validate().expect("redis inproc 清单应通过校验");
    }

    #[test]
    fn mongodb_declares_sidecar_runtime() {
        let manifest = engine_mongodb();
        assert_eq!(manifest.runtime, Some(crate::PluginRuntime::Sidecar));
        assert_eq!(
            manifest.driver_entry(),
            Some("bin/omnipanel-engine-mongodb")
        );
        manifest.validate().expect("mongodb sidecar 清单应通过校验");
    }

    #[test]
    fn qdrant_declares_inproc_runtime() {
        let manifest = engine_qdrant();
        assert_eq!(manifest.runtime, Some(crate::PluginRuntime::Inproc));
        assert_eq!(manifest.driver_entry(), None);
        manifest.validate().expect("qdrant inproc 清单应通过校验");
    }

    fn engine_form_key(manifest: &PluginManifest) -> &str {
        manifest
            .contributes
            .ui
            .connection_form
            .as_ref()
            .and_then(|v| v.get("engineKey"))
            .and_then(|v| v.as_str())
            .expect("engine 插件必须声明 engineKey")
    }

    #[test]
    fn sql_engines_declare_inproc_runtime() {
        for (manifest, key) in [
            (engine_mysql(), "mysql"),
            (engine_postgres(), "postgresql"),
            (engine_sqlite(), "sqlite"),
            (engine_sqlserver(), "sqlserver"),
        ] {
            assert_eq!(manifest.runtime, Some(crate::PluginRuntime::Inproc));
            assert_eq!(manifest.driver_entry(), None);
            assert_eq!(engine_form_key(&manifest), key);
            manifest.validate().expect("sql inproc 清单应通过校验");
        }
    }

    #[test]
    fn sqlserver_is_supported_inproc() {
        let manifest = engine_sqlserver();
        assert_eq!(manifest.runtime, Some(crate::PluginRuntime::Inproc));
        assert_eq!(engine_form_key(&manifest), "sqlserver");
        let supported = manifest
            .contributes
            .ui
            .connection_form
            .as_ref()
            .and_then(|v| v.get("supported"))
            .and_then(|v| v.as_bool());
        assert_eq!(supported, Some(true));
        manifest.validate().expect("sqlserver 清单应通过校验");
    }

    #[test]
    fn nacos_is_not_first_party_logic_embed() {
        assert!(first_party_logic_bytes(PLUGIN_ID_MODULE_NACOS, "logic.js").is_none());
    }

    fn read_download_only_logic(dir: &str) -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../plugins")
            .join(dir)
            .join("logic.js");
        std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("读 {} 失败: {e}", path.display()))
    }

    #[test]
    fn tencent_is_download_only_not_embedded() {
        assert!(first_party_logic_bytes(PLUGIN_ID_CLOUD_TENCENT, "logic.js").is_none());
        let src = read_download_only_logic("cloud-tencent");
        assert!(src.contains("TC3-HMAC-SHA256"));
        assert!(src.contains("host.netFetch"));
        assert!(src.contains("host.hash"));
    }

    #[test]
    fn huawei_is_download_only_not_embedded() {
        assert!(first_party_logic_bytes(PLUGIN_ID_CLOUD_HUAWEI, "logic.js").is_none());
        let src = read_download_only_logic("cloud-huawei");
        assert!(src.contains("SDK-HMAC-SHA256"));
        assert!(src.contains("host.netFetch"));
        assert!(src.contains("host.hash"));
    }

    #[test]
    fn hestia_embeds_logic_js() {
        let bytes = first_party_logic_bytes(PLUGIN_ID_PANEL_HESTIA, "logic.js")
            .expect("应嵌入 HestiaCP logic.js");
        let src = String::from_utf8(bytes).unwrap();
        assert!(src.contains("v-list-web-domains"));
        assert!(src.contains("host.netFetch"));
        assert!(first_party_logic_bytes(PLUGIN_ID_PANEL_HESTIA, "other.js").is_none());
    }

    #[test]
    fn warpgate_embeds_logic_js() {
        let bytes = first_party_logic_bytes(PLUGIN_ID_IMPORTER_WARPGATE, "logic.js")
            .expect("应嵌入 warpgate logic.js");
        let src = String::from_utf8(bytes).unwrap();
        assert!(src.contains("fetchTargets"));
        assert!(src.contains("@warpgate/admin/api/targets"));
        assert!(first_party_logic_bytes(PLUGIN_ID_IMPORTER_WARPGATE, "other.js").is_none());
    }

    #[test]
    fn warpgate_declares_home_and_embeds_icon() {
        let manifest = importer_warpgate();
        let home = manifest
            .contributes
            .ui
            .home
            .as_ref()
            .expect("Warpgate 应声明 ui.home");
        assert!(home.show);
        assert_eq!(home.open.kind, "importer");
        assert_eq!(home.open.id, "warpgate");
        assert_eq!(home.icon, "icon.svg");
        assert_eq!(home.title, "plugins.names.warpgate");
        let importer = manifest
            .contributes
            .importers
            .first()
            .expect("示例 importer 应声明 contributes.importers");
        assert_eq!(
            importer.get("id").and_then(|v| v.as_str()),
            Some("warpgate")
        );
        assert_eq!(
            importer.get("fetchMethod").and_then(|v| v.as_str()),
            Some("fetchTargets")
        );
        assert!(
            importer
                .get("fields")
                .and_then(|v| v.as_array())
                .is_some_and(|fields| !fields.is_empty())
        );
        manifest.validate().expect("Warpgate 清单应通过校验");
        let icon = first_party_asset_bytes(PLUGIN_ID_IMPORTER_WARPGATE, "icon.svg")
            .expect("应嵌入 warpgate icon.svg");
        assert!(String::from_utf8(icon).unwrap().contains("<svg"));
        assert!(first_party_asset_bytes(PLUGIN_ID_IMPORTER_WARPGATE, "../icon.svg").is_none());
    }

    #[test]
    fn theme_default_tokens_path_and_asset() {
        let manifest = theme_default();
        manifest.validate().expect("theme-default 清单应通过校验");
        assert_eq!(
            manifest
                .contributes
                .themes
                .as_ref()
                .expect("themes")
                .tokens,
            "tokens.json"
        );
        let bytes = first_party_asset_bytes(PLUGIN_ID_THEME_DEFAULT, "tokens.json")
            .expect("应嵌入 theme-default tokens.json");
        let text = String::from_utf8(bytes).unwrap();
        assert!(text.contains("\"terminal\""));
        assert!(first_party_asset_bytes(PLUGIN_ID_THEME_DEFAULT, "../tokens.json").is_none());
    }

    #[test]
    fn theme_tokens_rejects_traversal() {
        let mut manifest = theme_default();
        manifest.contributes.themes = Some(crate::ThemeContribution {
            tokens: "../evil.json".into(),
        });
        assert!(manifest.validate().is_err());
        manifest.contributes.themes = Some(crate::ThemeContribution {
            tokens: "tokens.json".into(),
        });
        assert!(manifest.validate().is_ok());
    }

    #[test]
    fn docker_db_declares_home_and_scanners() {
        let manifest = importer_docker_db();
        let home = manifest
            .contributes
            .ui
            .home
            .as_ref()
            .expect("Docker 库扫描应声明 ui.home");
        assert!(home.show);
        assert_eq!(home.open.kind, "importer");
        assert_eq!(home.open.id, "docker-db");
        assert_eq!(home.icon, "icon.svg");
        assert_eq!(home.title, "plugins.names.dockerDb");
        let importer = manifest
            .contributes
            .importers
            .first()
            .expect("应声明 contributes.importers");
        assert_eq!(
            importer.get("id").and_then(|v| v.as_str()),
            Some("docker-db")
        );
        assert_eq!(
            importer.get("sourceKind").and_then(|v| v.as_str()),
            Some("dockerConnections")
        );
        assert!(importer.get("fetchMethod").is_none());
        let scanners = importer
            .get("scanners")
            .and_then(|v| v.as_array())
            .expect("dockerConnections 必须声明 scanners");
        assert_eq!(scanners.len(), 10);
        manifest.validate().expect("Docker 库扫描清单应通过校验");
        let icon = first_party_asset_bytes(PLUGIN_ID_IMPORTER_DOCKER_DB, "icon.svg")
            .expect("应嵌入 docker-db icon.svg");
        assert!(String::from_utf8(icon).unwrap().contains("<svg"));
    }
}
