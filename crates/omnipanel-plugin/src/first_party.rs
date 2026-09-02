use crate::manifest::PluginManifest;

pub const PLUGIN_ID_THEME_DEFAULT: &str = "omni.theme.default";
pub const PLUGIN_ID_ADDON_EVERYTHING: &str = "omni.addon.everything";
pub const PLUGIN_ID_CLOUD_ALIYUN: &str = "omni.cloud.aliyun";
pub const PLUGIN_ID_CLOUD_TENCENT: &str = "omni.cloud.tencent";
pub const PLUGIN_ID_PANEL_1PANEL: &str = "omni.panel.1panel";
pub const PLUGIN_ID_PANEL_BT: &str = "omni.panel.bt";
pub const PLUGIN_ID_ENGINE_QDRANT: &str = "omni.engine.qdrant";
pub const PLUGIN_ID_ENGINE_CLICKHOUSE: &str = "omni.engine.clickhouse";
pub const PLUGIN_ID_ENGINE_MONGODB: &str = "omni.engine.mongodb";
pub const PLUGIN_ID_ENGINE_MYSQL: &str = "omni.engine.mysql";
pub const PLUGIN_ID_ENGINE_POSTGRES: &str = "omni.engine.postgres";
pub const PLUGIN_ID_ENGINE_REDIS: &str = "omni.engine.redis";
pub const PLUGIN_ID_ENGINE_SQLITE: &str = "omni.engine.sqlite";
pub const PLUGIN_ID_ENGINE_SQLSERVER: &str = "omni.engine.sqlserver";
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

pub fn cloud_aliyun() -> PluginManifest {
    first_party_manifest!("cloud-aliyun")
}

pub fn cloud_tencent() -> PluginManifest {
    first_party_manifest!("cloud-tencent")
}

pub fn panel_1panel() -> PluginManifest {
    first_party_manifest!("panel-1panel")
}

pub fn panel_bt() -> PluginManifest {
    first_party_manifest!("panel-bt")
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

pub fn module_nacos() -> PluginManifest {
    first_party_manifest!("module-nacos")
}

pub fn importer_warpgate() -> PluginManifest {
    first_party_manifest!("importer-warpgate")
}

pub fn importer_docker_db() -> PluginManifest {
    first_party_manifest!("importer-docker-db")
}

/// 第一方 L2 逻辑包（内置插件不落盘时由宿主嵌入装载）。
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
        (PLUGIN_ID_MODULE_NACOS, "logic.js") => Some(
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../plugins/module-nacos/logic.js"
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
        _ => None,
    }
}

pub fn first_party_manifests() -> Vec<PluginManifest> {
    vec![
        theme_default(),
        addon_everything(),
        cloud_aliyun(),
        cloud_tencent(),
        panel_1panel(),
        panel_bt(),
        engine_qdrant(),
        engine_clickhouse(),
        engine_mongodb(),
        engine_mysql(),
        engine_postgres(),
        engine_redis(),
        engine_sqlite(),
        engine_sqlserver(),
        module_nacos(),
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
        assert_eq!(cloud_tencent().id, PLUGIN_ID_CLOUD_TENCENT);
        assert_eq!(panel_1panel().id, PLUGIN_ID_PANEL_1PANEL);
        assert_eq!(panel_bt().id, PLUGIN_ID_PANEL_BT);
        assert_eq!(engine_qdrant().id, PLUGIN_ID_ENGINE_QDRANT);
        assert_eq!(engine_clickhouse().id, PLUGIN_ID_ENGINE_CLICKHOUSE);
        assert_eq!(engine_mongodb().id, PLUGIN_ID_ENGINE_MONGODB);
        assert_eq!(engine_mysql().id, PLUGIN_ID_ENGINE_MYSQL);
        assert_eq!(engine_postgres().id, PLUGIN_ID_ENGINE_POSTGRES);
        assert_eq!(engine_redis().id, PLUGIN_ID_ENGINE_REDIS);
        assert_eq!(engine_sqlite().id, PLUGIN_ID_ENGINE_SQLITE);
        assert_eq!(engine_sqlserver().id, PLUGIN_ID_ENGINE_SQLSERVER);
        assert_eq!(module_nacos().id, PLUGIN_ID_MODULE_NACOS);
        let nacos = module_nacos();
        nacos.validate().expect("nacos 清单应通过校验");
        assert_eq!(nacos.logic_entry(), Some("logic.js"));
        let caps: Vec<_> = nacos
            .contributes
            .module
            .as_ref()
            .expect("module.capabilities")
            .capabilities
            .iter()
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(caps, vec!["namespace", "config", "discovery", "cluster"]);
        assert_eq!(importer_warpgate().id, PLUGIN_ID_IMPORTER_WARPGATE);
        assert_eq!(importer_docker_db().id, PLUGIN_ID_IMPORTER_DOCKER_DB);
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
    fn nacos_embeds_logic_js() {
        let bytes = first_party_logic_bytes(PLUGIN_ID_MODULE_NACOS, "logic.js")
            .expect("应嵌入 nacos logic.js");
        let src = String::from_utf8(bytes).unwrap();
        assert!(src.contains("publishConfig"));
        assert!(src.contains("rollbackConfig"));
        assert!(src.contains("probeHealth"));
        assert!(first_party_logic_bytes(PLUGIN_ID_MODULE_NACOS, "other.js").is_none());
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
