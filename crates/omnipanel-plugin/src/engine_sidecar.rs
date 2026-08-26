//! 已安装 engine 插件的 sidecar 驱动解析：安装目录 + `entry.driver` + connectionForm 别名。

use std::path::{Path, PathBuf};

use crate::kind::PluginKind;
use crate::manifest::{PluginManifest, PluginRuntime};
use crate::registry::PluginRegistry;
use crate::source::PluginSource;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledEngineDriver {
    pub plugin_id: String,
    pub aliases: Vec<String>,
    pub driver_path: PathBuf,
}

/// 从 `contributes.ui.connectionForm` 取出 engineKey 与 aliases（小写、去重）。
pub fn connection_form_engine_keys(manifest: &PluginManifest) -> Vec<String> {
    let Some(form) = manifest.contributes.ui.connection_form.as_ref() else {
        return Vec::new();
    };
    let mut keys = Vec::new();
    if let Some(key) = form.get("engineKey").and_then(|v| v.as_str()) {
        push_key(&mut keys, key);
    }
    if let Some(aliases) = form.get("aliases").and_then(|v| v.as_array()) {
        for item in aliases {
            if let Some(alias) = item.as_str() {
                push_key(&mut keys, alias);
            }
        }
    }
    keys
}

fn push_key(keys: &mut Vec<String>, raw: &str) {
    let key = raw.trim().to_ascii_lowercase();
    if !key.is_empty() && !keys.iter().any(|existing| existing == &key) {
        keys.push(key);
    }
}

fn join_plugin_rel(root: &Path, plugin_id: &str, rel: &str) -> PathBuf {
    let mut path = root.join(plugin_id);
    for seg in rel.split(['/', '\\']) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        path.push(seg);
    }
    path
}

/// 已激活、磁盘安装、`runtime=sidecar` 的引擎：解析安装目录下的 driver 路径。
/// 文件是否存在由宿主再校验（测试里可以只断言路径拼装）。
pub fn collect_activated_installed_engine_drivers(
    registry: &PluginRegistry,
    plugins_root: &Path,
) -> Vec<InstalledEngineDriver> {
    let mut out = Vec::new();
    for item in registry.list() {
        if item.kind != PluginKind::Engine
            || item.source != PluginSource::Installed
            || !item.activated
        {
            continue;
        }
        let Some(entry) = registry.get(&item.id) else {
            continue;
        };
        if entry.manifest.runtime != Some(PluginRuntime::Sidecar) {
            continue;
        }
        let Some(rel) = entry.manifest.driver_entry() else {
            continue;
        };
        let aliases = connection_form_engine_keys(&entry.manifest);
        if aliases.is_empty() {
            continue;
        }
        out.push(InstalledEngineDriver {
            plugin_id: item.id,
            aliases,
            driver_path: join_plugin_rel(plugins_root, &entry.manifest.id, rel),
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PluginPlatform;

    fn oracle_manifest() -> PluginManifest {
        PluginManifest::from_json(
            r#"{
                "id": "omni.engine.oracle",
                "version": "0.1.0",
                "kind": "engine",
                "runtime": "sidecar",
                "permissions": ["net:connect"],
                "entry": { "driver": "bin/agent.mjs" },
                "contributes": {
                    "ui": {
                        "connectionForm": {
                            "engineKey": "oracle",
                            "aliases": ["oracle", "orcl"]
                        }
                    }
                }
            }"#,
        )
        .expect("样板清单合法")
    }

    #[test]
    fn keys_include_engine_key_and_aliases() {
        let keys = connection_form_engine_keys(&oracle_manifest());
        assert_eq!(keys, vec!["oracle", "orcl"]);
    }

    #[test]
    fn activated_installed_sidecar_is_collected() {
        let mut registry = PluginRegistry::new();
        registry
            .register_installed(oracle_manifest())
            .unwrap();
        registry
            .activate_on("omni.engine.oracle", PluginPlatform::current())
            .unwrap();
        let root = PathBuf::from("/tmp/omni-plugins");
        let found = collect_activated_installed_engine_drivers(&registry, &root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].plugin_id, "omni.engine.oracle");
        assert_eq!(found[0].aliases, vec!["oracle", "orcl"]);
        assert_eq!(
            found[0].driver_path,
            root.join("omni.engine.oracle").join("bin").join("agent.mjs")
        );
    }

    #[test]
    fn disabled_installed_sidecar_is_skipped() {
        let mut registry = PluginRegistry::new();
        registry
            .register_installed(oracle_manifest())
            .unwrap();
        registry
            .activate_on("omni.engine.oracle", PluginPlatform::current())
            .unwrap();
        registry.set_enabled("omni.engine.oracle", false).unwrap();
        let found = collect_activated_installed_engine_drivers(
            &registry,
            Path::new("/tmp/omni-plugins"),
        );
        assert!(found.is_empty());
    }
}
