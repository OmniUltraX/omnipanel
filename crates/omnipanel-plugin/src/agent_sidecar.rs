//! 已安装 agent 插件的 sidecar 驱动解析。
//! 官方 Cursor / WorkBuddy / Trae / OpenCode Go 与第三方一样：装上并启用后走这条路径。

use std::path::{Path, PathBuf};

use crate::kind::PluginKind;
use crate::manifest::{PluginManifest, PluginRuntime};
use crate::registry::PluginRegistry;
use crate::source::PluginSource;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstalledAgentDriver {
    pub source_id: String,
    pub title: String,
    pub driver_path: PathBuf,
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

/// Windows 上 `entry.driver` 常不带后缀，优先落真实存在的 `.exe`。
fn resolve_driver_file(root: &Path, plugin_id: &str, rel: &str) -> PathBuf {
    let path = join_plugin_rel(root, plugin_id, rel);
    if path.is_file() {
        return path;
    }
    #[cfg(windows)]
    if path.extension().is_none() {
        let mut with_exe = path.clone();
        with_exe.set_extension("exe");
        if with_exe.is_file() {
            return with_exe;
        }
    }
    path
}

fn declared_sources(manifest: &PluginManifest) -> Vec<(String, String)> {
    manifest
        .contributes
        .agent_sources
        .iter()
        .filter_map(|value| {
            let id = value.get("id")?.as_str()?.trim();
            if id.is_empty() {
                return None;
            }
            let title = value
                .get("title")
                .and_then(|item| item.as_str())
                .map(str::trim)
                .filter(|title| !title.is_empty())
                .unwrap_or(id);
            Some((id.to_string(), title.to_string()))
        })
        .collect()
}

/// 已激活、磁盘安装、`runtime=sidecar` 的 Agent 来源。文件是否存在由宿主再校验。
pub fn collect_activated_installed_agent_drivers(
    registry: &PluginRegistry,
    plugins_root: &Path,
) -> Vec<InstalledAgentDriver> {
    let mut out = Vec::new();
    for item in registry.list() {
        if item.kind != PluginKind::Agent
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
        let driver_path = resolve_driver_file(plugins_root, &entry.manifest.id, rel);
        for (source_id, title) in declared_sources(&entry.manifest) {
            out.push(InstalledAgentDriver {
                source_id,
                title,
                driver_path: driver_path.clone(),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PluginPlatform;

    fn echo_manifest() -> PluginManifest {
        PluginManifest::from_json(
            r#"{
                "id": "omni.sample.agent-echo",
                "version": "0.1.0",
                "kind": "agent",
                "runtime": "sidecar",
                "permissions": ["net:connect"],
                "entry": { "driver": "bin/agent.mjs" },
                "contributes": {
                    "agentSources": [{ "id": "echo", "title": "Echo" }]
                }
            }"#,
        )
        .expect("样板清单合法")
    }

    #[test]
    fn installed_agent_sidecar_resolves_driver() {
        let mut registry = PluginRegistry::new();
        registry.register_installed(echo_manifest()).expect("登记");
        registry
            .set_enabled("omni.sample.agent-echo", true)
            .expect("启用");
        registry.activate_enabled(PluginPlatform::current());
        let root = Path::new("/plugins");
        let found = collect_activated_installed_agent_drivers(&registry, root);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].source_id, "echo");
        assert_eq!(found[0].title, "Echo");
        assert!(
            found[0].driver_path.ends_with(
                Path::new("omni.sample.agent-echo")
                    .join("bin")
                    .join("agent.mjs")
            )
        );
    }
}
