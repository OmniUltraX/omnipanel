use crate::manifest::PluginManifest;

pub const PLUGIN_ID_THEME_DEFAULT: &str = "omni.theme.default";
pub const PLUGIN_ID_ADDON_EVERYTHING: &str = "omni.addon.everything";
pub const PLUGIN_ID_CLOUD_ALIYUN: &str = "omni.cloud.aliyun";
pub const PLUGIN_ID_PANEL_1PANEL: &str = "omni.panel.1panel";
pub const PLUGIN_ID_PANEL_BT: &str = "omni.panel.bt";
pub const PLUGIN_ID_ENGINE_QDRANT: &str = "omni.engine.qdrant";
pub const PLUGIN_ID_ENGINE_CLICKHOUSE: &str = "omni.engine.clickhouse";
pub const PLUGIN_ID_ENGINE_REDIS: &str = "omni.engine.redis";
pub const PLUGIN_ID_MODULE_NACOS: &str = "omni.module.nacos";
pub const PLUGIN_ID_IMPORTER_WARPGATE: &str = "omni.importer.warpgate";

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

pub fn engine_redis() -> PluginManifest {
    first_party_manifest!("db-redis")
}

pub fn module_nacos() -> PluginManifest {
    first_party_manifest!("module-nacos")
}

pub fn importer_warpgate() -> PluginManifest {
    first_party_manifest!("importer-warpgate")
}

pub fn first_party_manifests() -> Vec<PluginManifest> {
    vec![
        theme_default(),
        addon_everything(),
        cloud_aliyun(),
        panel_1panel(),
        panel_bt(),
        engine_qdrant(),
        engine_clickhouse(),
        engine_redis(),
        module_nacos(),
        importer_warpgate(),
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
        assert_eq!(panel_1panel().id, PLUGIN_ID_PANEL_1PANEL);
        assert_eq!(panel_bt().id, PLUGIN_ID_PANEL_BT);
        assert_eq!(engine_qdrant().id, PLUGIN_ID_ENGINE_QDRANT);
        assert_eq!(engine_clickhouse().id, PLUGIN_ID_ENGINE_CLICKHOUSE);
        assert_eq!(engine_redis().id, PLUGIN_ID_ENGINE_REDIS);
        assert_eq!(module_nacos().id, PLUGIN_ID_MODULE_NACOS);
        assert_eq!(importer_warpgate().id, PLUGIN_ID_IMPORTER_WARPGATE);
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
        assert_eq!(database.get("optional").and_then(|v| v.as_bool()), Some(true));
    }
}
