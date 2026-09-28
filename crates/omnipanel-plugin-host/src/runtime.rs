//! 桌面与 Web 共用的逻辑执行器工厂。QuickJS 与 WASM 都硬链接。

use std::path::Path;
use std::sync::Arc;

use omnipanel_plugin::{
    InvokeGateway, PluginLogicExecutor, PluginPlatform, PluginRegistry, RouterExecutor,
    load_installed,
};
use omnipanel_plugin_js::JsExecutor;
use omnipanel_plugin_wasm::WasmExecutor;

pub fn make_logic_executor() -> Arc<dyn PluginLogicExecutor> {
    Arc::new(RouterExecutor::new(
        Some(Arc::new(WasmExecutor::new())),
        Some(Arc::new(JsExecutor::new())),
    ))
}

/// 内置清单 + 磁盘安装包。不含启用状态回放，也不做 DBX 迁移。
pub fn build_plugin_registry(plugins_root: Option<&Path>) -> PluginRegistry {
    let mut registry = PluginRegistry::new();
    for manifest in omnipanel_plugin::first_party_manifests() {
        let _ = registry.register(manifest);
    }
    if let Some(root) = plugins_root {
        for installed in load_installed(root) {
            let _ = registry.register_installed(installed.manifest);
        }
    }
    registry
}

pub fn activate_current(registry: &mut PluginRegistry) {
    registry.activate_enabled(PluginPlatform::current());
}

pub fn empty_gateway() -> Arc<InvokeGateway> {
    Arc::new(InvokeGateway::new())
}
