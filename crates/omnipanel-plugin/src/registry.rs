use serde::{Deserialize, Serialize};
use specta::Type;

use crate::contribution::{AiToolContribution, LauncherContribution};
use crate::error::PluginError;
use crate::kind::PluginKind;
use crate::manifest::PluginManifest;
use crate::permission::PluginPermission;
use crate::platform::PluginPlatform;
use crate::source::PluginSource;

/// 平台不匹配时写入 `unsupported_reason` 的稳定错误码。
pub const UNSUPPORTED_REASON_PLATFORM: &str = "platform.unsupported";

/// 前端 / IPC 列表项。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginListItem {
    pub id: String,
    pub version: String,
    pub kind: PluginKind,
    pub enabled: bool,
    pub activated: bool,
    pub source: PluginSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_reason: Option<String>,
}

#[derive(Debug, Clone)]
pub struct PluginEntry {
    pub manifest: PluginManifest,
    pub enabled: bool,
    pub activated: bool,
    pub source: PluginSource,
    pub unsupported_reason: Option<String>,
}

impl PluginEntry {
    /// 第一方引擎插件始终启用：结构与其它引擎相同，但不能关闭。
    pub fn always_on(&self) -> bool {
        self.source == PluginSource::Builtin && self.manifest.kind == PluginKind::Engine
    }
}

#[derive(Debug, Clone, Default)]
pub struct ContributionIndex {
    pub launcher: Vec<(String, LauncherContribution)>,
    pub ai_tools: Vec<(String, AiToolContribution)>,
    pub sidebar_plugin_ids: Vec<String>,
    /// `(plugin_id, probe_id)`，仅已 activate 的插件。
    pub discovery: Vec<(String, String)>,
}

#[derive(Debug, Default)]
pub struct PluginRegistry {
    plugins: std::collections::BTreeMap<String, PluginEntry>,
    contributions: ContributionIndex,
}

impl PluginRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&mut self, manifest: PluginManifest) -> Result<(), PluginError> {
        self.register_with_source(manifest, PluginSource::Builtin)
    }

    /// 磁盘安装包登记（可卸载）。
    pub fn register_installed(&mut self, manifest: PluginManifest) -> Result<(), PluginError> {
        self.register_with_source(manifest, PluginSource::Installed)
    }

    pub fn register_with_source(
        &mut self,
        manifest: PluginManifest,
        source: PluginSource,
    ) -> Result<(), PluginError> {
        manifest.validate()?;
        let id = manifest.id.clone();
        self.plugins.entry(id).or_insert(PluginEntry {
            manifest,
            enabled: true,
            activated: false,
            source,
            unsupported_reason: None,
        });
        Ok(())
    }

    pub fn list(&self) -> Vec<PluginListItem> {
        self.plugins
            .values()
            .map(|e| PluginListItem {
                id: e.manifest.id.clone(),
                version: e.manifest.version.clone(),
                kind: e.manifest.kind,
                enabled: e.enabled,
                activated: e.activated,
                source: e.source,
                unsupported_reason: e.unsupported_reason.clone(),
            })
            .collect()
    }

    /// 是否为磁盘安装来源（决定设置页能否卸载）。
    pub fn is_installed(&self, id: &str) -> bool {
        self.plugins
            .get(id)
            .is_some_and(|e| e.source == PluginSource::Installed)
    }

    pub fn get(&self, id: &str) -> Option<&PluginEntry> {
        self.plugins.get(id)
    }

    pub fn contributions(&self) -> &ContributionIndex {
        &self.contributions
    }

    pub fn require_permission(
        &self,
        plugin_id: &str,
        permission: PluginPermission,
    ) -> Result<(), PluginError> {
        let entry = self
            .plugins
            .get(plugin_id)
            .ok_or_else(|| PluginError::NotFound(plugin_id.to_string()))?;
        if !entry.activated {
            return Err(PluginError::NotFound(format!(
                "{plugin_id}（未激活）"
            )));
        }
        if entry.manifest.permissions.contains(&permission) {
            Ok(())
        } else {
            Err(PluginError::permission_denied(plugin_id, permission))
        }
    }

    /// 宿主连接写入闸：缺 `connections:write` 则失败，不写库。
    pub fn authorize_connection_write(&self, plugin_id: &str) -> Result<(), PluginError> {
        self.require_permission(plugin_id, PluginPermission::ConnectionsWrite)
    }

    /// 网关白名单查询：插件存在且已 activate 才返回方法声明，否则 `UnknownMethod`。
    pub fn declared_method(
        &self,
        plugin_id: &str,
        method: &str,
    ) -> Result<crate::manifest::PluginMethodDecl, PluginError> {
        let entry = self
            .plugins
            .get(plugin_id)
            .ok_or_else(|| PluginError::NotFound(plugin_id.to_string()))?;
        if !entry.activated {
            return Err(PluginError::UnknownMethod {
                plugin_id: plugin_id.to_string(),
                method: method.to_string(),
            });
        }
        entry
            .manifest
            .declared_method(method)
            .cloned()
            .ok_or_else(|| PluginError::UnknownMethod {
                plugin_id: plugin_id.to_string(),
                method: method.to_string(),
            })
    }

    pub fn activate(&mut self, id: &str) -> Result<(), PluginError> {
        self.activate_on(id, PluginPlatform::current())
    }

    pub fn activate_on(&mut self, id: &str, os: PluginPlatform) -> Result<(), PluginError> {
        let entry = self
            .plugins
            .get_mut(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
        if !entry.enabled {
            entry.activated = false;
            return Ok(());
        }
        if !entry.manifest.supports_platform(os) {
            entry.activated = false;
            entry.unsupported_reason = Some(UNSUPPORTED_REASON_PLATFORM.to_string());
            self.rebuild_contributions();
            return Ok(());
        }
        entry.unsupported_reason = None;
        entry.activated = true;
        self.rebuild_contributions();
        Ok(())
    }

    pub fn deactivate(&mut self, id: &str) {
        if let Some(entry) = self.plugins.get_mut(id) {
            entry.activated = false;
        }
        self.rebuild_contributions();
    }

    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> Result<(), PluginError> {
        let always_on = self
            .plugins
            .get(id)
            .ok_or_else(|| PluginError::NotFound(id.to_string()))?
            .always_on();
        if !enabled && always_on {
            return Err(PluginError::AlwaysOn(id.to_string()));
        }
        {
            let entry = self
                .plugins
                .get_mut(id)
                .ok_or_else(|| PluginError::NotFound(id.to_string()))?;
            entry.enabled = enabled;
        }
        if enabled {
            self.activate(id)?;
        } else {
            self.deactivate(id);
        }
        Ok(())
    }

    /// 对已登记且 enabled 的插件尝试 activate（尊重 platforms）。
    pub fn activate_enabled(&mut self, os: PluginPlatform) {
        let ids: Vec<String> = self.plugins.keys().cloned().collect();
        for id in ids {
            let _ = self.activate_on(&id, os);
        }
    }

    fn rebuild_contributions(&mut self) {
        let mut index = ContributionIndex::default();
        for entry in self.plugins.values() {
            if !entry.activated {
                continue;
            }
            let id = entry.manifest.id.clone();
            if let Some(launcher) = entry.manifest.contributes.launcher.clone() {
                index.launcher.push((id.clone(), launcher));
            }
            if let Some(ai) = &entry.manifest.contributes.ai {
                for tool in &ai.tools {
                    index.ai_tools.push((id.clone(), tool.clone()));
                }
            }
            if entry.manifest.contributes.ui.sidebar || entry.manifest.kind == PluginKind::Module {
                index.sidebar_plugin_ids.push(id.clone());
            }
            for probe in &entry.manifest.contributes.discovery {
                index.discovery.push((id.clone(), probe.probe_id.clone()));
            }
        }
        self.contributions = index;
    }

    /// `kind=module` 且声明了 `ui.moduleKey` 的补种清单；状态由 Host 定为 closed。
    pub fn module_seeds(&self) -> Vec<(String, i32)> {
        self.plugins
            .values()
            .filter(|entry| entry.manifest.kind == PluginKind::Module)
            .filter_map(|entry| {
                let key = entry.manifest.contributes.ui.module_key.trim();
                if key.is_empty() {
                    return None;
                }
                Some((key.to_string(), 80))
            })
            .collect()
    }

    pub fn plugins_for_probe(&self, probe_id: &str) -> Vec<String> {
        self.contributions
            .discovery
            .iter()
            .filter(|(_, id)| id == probe_id)
            .map(|(plugin_id, _)| plugin_id.clone())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contribution::{AiContributes, AiToolContribution, PluginContributes};
    use crate::kind::PluginKind;
    use crate::permission::PluginPermission;

    fn addon_manifest(id: &str, platforms: Option<Vec<PluginPlatform>>) -> PluginManifest {
        PluginManifest {
            id: id.into(),
            version: "0.1.0".into(),
            kind: PluginKind::Addon,
            contributes: PluginContributes {
                launcher: Some(LauncherContribution {
                    prefix: "es".into(),
                }),
                ai: Some(AiContributes {
                    tools: vec![AiToolContribution {
                        name: "omni_everything_search".into(),
                        description: "search".into(),
                        exec_kind: crate::contribution::AiToolExecKind::Native,
                        module_key: "files".into(),
                        cross_module: true,
                        external_exposed: false,
                        input_schema: serde_json::json!({ "type": "object" }),
                    }],
                }),
                ..Default::default()
            },
            permissions: vec![PluginPermission::AiTools, PluginPermission::FsRead],
            methods: Vec::new(),
            entry: None,
            runtime: None,
            min_host_api: None,
            platforms,
        }
    }

    #[test]
    fn unknown_kind_rejected() {
        let err = PluginManifest::from_json(
            r#"{"id":"x","version":"1","kind":"translator","permissions":[]}"#,
        )
        .unwrap_err();
        assert!(matches!(err, PluginError::UnknownKind(_)));
    }

    #[test]
    fn missing_connection_write_fails() {
        let mut reg = PluginRegistry::new();
        reg.register(addon_manifest("omni.addon.everything", None))
            .unwrap();
        reg.activate("omni.addon.everything").unwrap();
        let err = reg
            .authorize_connection_write("omni.addon.everything")
            .unwrap_err();
        assert!(matches!(err, PluginError::PermissionDenied { .. }));
    }

    #[test]
    fn disable_removes_contributions() {
        let mut reg = PluginRegistry::new();
        reg.register(addon_manifest("omni.addon.everything", None))
            .unwrap();
        reg.activate("omni.addon.everything").unwrap();
        assert_eq!(reg.contributions().ai_tools.len(), 1);
        assert_eq!(reg.contributions().launcher.len(), 1);
        reg.set_enabled("omni.addon.everything", false).unwrap();
        assert!(reg.contributions().ai_tools.is_empty());
        assert!(reg.contributions().launcher.is_empty());
        assert!(!reg.get("omni.addon.everything").unwrap().activated);
    }

    #[test]
    fn discovery_contribution_indexes_activated_panel() {
        use crate::contribution::DiscoveryContribution;
        let mut reg = PluginRegistry::new();
        let mut manifest = addon_manifest("omni.panel.1panel", None);
        manifest.kind = PluginKind::Panel;
        manifest.contributes.launcher = None;
        manifest.contributes.ai = None;
        manifest.contributes.discovery = vec![DiscoveryContribution {
            probe_id: "ssh-panel".into(),
        }];
        manifest.permissions = vec![PluginPermission::ConnectionsWrite];
        reg.register(manifest).unwrap();
        reg.activate("omni.panel.1panel").unwrap();
        assert_eq!(reg.plugins_for_probe("ssh-panel"), vec!["omni.panel.1panel"]);
        reg.set_enabled("omni.panel.1panel", false).unwrap();
        assert!(reg.plugins_for_probe("ssh-panel").is_empty());
    }

    #[test]
    fn non_windows_skips_activate() {
        let mut reg = PluginRegistry::new();
        reg.register(addon_manifest(
            "omni.addon.everything",
            Some(vec![PluginPlatform::Windows]),
        ))
        .unwrap();
        reg.activate_on("omni.addon.everything", PluginPlatform::Linux)
            .unwrap();
        let item = &reg.list()[0];
        assert!(!item.activated);
        assert_eq!(
            item.unsupported_reason.as_deref(),
            Some(UNSUPPORTED_REASON_PLATFORM)
        );
        assert!(reg.contributions().ai_tools.is_empty());
    }

    #[test]
    fn theme_must_have_empty_permissions() {
        let manifest = PluginManifest {
            id: "omni.theme.default".into(),
            version: "0.1.0".into(),
            kind: PluginKind::Theme,
            contributes: PluginContributes::default(),
            permissions: vec![PluginPermission::NetConnect],
            methods: Vec::new(),
            entry: None,
            runtime: None,
            min_host_api: None,
            platforms: None,
        };
        assert!(manifest.validate().is_err());
    }

    #[test]
    fn module_seeds_from_kind_module() {
        let mut reg = PluginRegistry::new();
        reg.register(crate::first_party::module_nacos()).unwrap();
        let seeds = reg.module_seeds();
        assert_eq!(seeds, vec![("nacos".to_string(), 80)]);
    }

    fn method_manifest(id: &str, activated: bool) -> PluginManifest {
        let mut manifest = addon_manifest(id, None);
        manifest.methods = vec![crate::manifest::PluginMethodDecl {
            name: "search".into(),
            permissions: vec![PluginPermission::AiTools, PluginPermission::FsRead],
        }];
        if !activated {
            manifest.permissions = vec![];
            manifest.contributes.ai = None;
            manifest.contributes.launcher = None;
        }
        manifest
    }

    #[test]
    fn declared_method_requires_activation_and_declaration() {
        let mut reg = PluginRegistry::new();
        reg.register(method_manifest("omni.addon.demo", false)).unwrap();

        // 未激活：即使清单声明了 method 也按 UnknownMethod 拒绝
        let err = reg
            .declared_method("omni.addon.demo", "search")
            .unwrap_err();
        assert!(matches!(err, PluginError::UnknownMethod { .. }));

        // 激活后命中声明并带出权限注解
        reg.activate("omni.addon.demo").unwrap();
        let decl = reg
            .declared_method("omni.addon.demo", "search")
            .unwrap();
        assert_eq!(decl.permissions.len(), 2);

        // 未声明的 method 一律 UnknownMethod
        let err = reg
            .declared_method("omni.addon.demo", "nope")
            .unwrap_err();
        assert!(matches!(err, PluginError::UnknownMethod { .. }));

        // 未知插件 NotFound
        let err = reg.declared_method("omni.unknown", "x").unwrap_err();
        assert!(matches!(err, PluginError::NotFound(_)));
    }

    #[test]
    fn manifest_rejects_duplicate_or_empty_methods() {
        let mut manifest = method_manifest("omni.addon.dup", true);
        manifest.methods.push(crate::manifest::PluginMethodDecl {
            name: "search".into(),
            permissions: vec![],
        });
        assert!(manifest.validate().is_err());

        let mut empty = method_manifest("omni.addon.empty", true);
        empty.methods[0].name = "  ".into();
        assert!(empty.validate().is_err());
    }

    #[test]
    fn builtin_engine_cannot_be_disabled() {
        let mut reg = PluginRegistry::new();
        reg.register(crate::engine_mysql()).unwrap();
        let err = reg
            .set_enabled(crate::PLUGIN_ID_ENGINE_MYSQL, false)
            .unwrap_err();
        assert!(matches!(err, PluginError::AlwaysOn(_)));
        assert!(reg.get(crate::PLUGIN_ID_ENGINE_MYSQL).unwrap().enabled);
        assert!(reg.get(crate::PLUGIN_ID_ENGINE_MYSQL).unwrap().always_on());
        reg.set_enabled(crate::PLUGIN_ID_ENGINE_MYSQL, true).unwrap();
    }

    #[test]
    fn installed_engine_can_still_be_disabled() {
        let mut reg = PluginRegistry::new();
        let manifest = crate::engine_mysql();
        reg.register_installed(manifest).unwrap();
        reg.set_enabled(crate::PLUGIN_ID_ENGINE_MYSQL, false).unwrap();
        assert!(!reg.get(crate::PLUGIN_ID_ENGINE_MYSQL).unwrap().enabled);
    }
}
