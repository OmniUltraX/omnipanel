use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, OnceLock, RwLock};

use serde_json::Value;

use super::{RegisteredTool, ToolExecutionKind};

pub type PluginNativeExecFuture =
    Pin<Box<dyn Future<Output = Result<(String, bool), String>> + Send>>;

pub type PluginNativeExecutor = Arc<dyn Fn(String, Value) -> PluginNativeExecFuture + Send + Sync>;

#[derive(Clone)]
pub struct PluginNativeTool {
    pub plugin_id: String,
    pub name: String,
    pub module_key: String,
    pub description: String,
    pub input_schema: Value,
    pub kind: ToolExecutionKind,
    pub cross_module: bool,
    pub external_exposed: bool,
    pub executor: PluginNativeExecutor,
}

impl PluginNativeTool {
    pub fn to_registered(&self) -> RegisteredTool {
        RegisteredTool {
            name: self.name.clone(),
            module_key: self.module_key.clone(),
            description: self.description.clone(),
            input_schema: self.input_schema.clone(),
            kind: self.kind,
            mcp_service_id: None,
            mcp_tool_name: None,
        }
    }
}

#[derive(Clone, Default)]
pub struct PluginToolHub {
    inner: Arc<RwLock<HashMap<String, PluginNativeTool>>>,
}

impl PluginToolHub {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, tool: PluginNativeTool) {
        let mut guard = self.inner.write().expect("plugin tool hub poisoned");
        guard.insert(tool.name.clone(), tool);
    }

    pub fn unregister_plugin(&self, plugin_id: &str) {
        let mut guard = self.inner.write().expect("plugin tool hub poisoned");
        guard.retain(|_, t| t.plugin_id != plugin_id);
    }

    pub fn get(&self, name: &str) -> Option<PluginNativeTool> {
        self.inner
            .read()
            .expect("plugin tool hub poisoned")
            .get(name)
            .cloned()
    }

    pub fn list(&self) -> Vec<PluginNativeTool> {
        self.inner
            .read()
            .expect("plugin tool hub poisoned")
            .values()
            .cloned()
            .collect()
    }

    pub fn is_native(&self, name: &str) -> bool {
        self.get(name)
            .is_some_and(|t| t.kind == ToolExecutionKind::Native)
    }

    pub fn is_cross_module(&self, name: &str) -> bool {
        self.get(name).is_some_and(|t| t.cross_module)
    }

    pub fn clear(&self) {
        self.inner
            .write()
            .expect("plugin tool hub poisoned")
            .clear();
    }
}

static GLOBAL_HUB: OnceLock<PluginToolHub> = OnceLock::new();

pub fn global_plugin_tool_hub() -> &'static PluginToolHub {
    GLOBAL_HUB.get_or_init(PluginToolHub::new)
}
