use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::error::PluginError;

pub type InvokeHandler = Arc<dyn Fn(Value) -> Result<Value, PluginError> + Send + Sync>;

/// 第一方插件命令网关：仅编译期登记的 `(plugin_id, method)` 可调用。
#[derive(Default)]
pub struct InvokeGateway {
    handlers: HashMap<(String, String), InvokeHandler>,
}

impl InvokeGateway {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(
        &mut self,
        plugin_id: impl Into<String>,
        method: impl Into<String>,
        handler: InvokeHandler,
    ) {
        self.handlers
            .insert((plugin_id.into(), method.into()), handler);
    }

    pub fn invoke(
        &self,
        plugin_id: &str,
        method: &str,
        args: Value,
    ) -> Result<Value, PluginError> {
        let handler = self
            .handlers
            .get(&(plugin_id.to_string(), method.to_string()))
            .ok_or_else(|| PluginError::UnknownMethod {
                plugin_id: plugin_id.to_string(),
                method: method.to_string(),
            })?;
        handler(args)
    }

    pub fn is_declared(&self, plugin_id: &str, method: &str) -> bool {
        self.handlers
            .contains_key(&(plugin_id.to_string(), method.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_method_fails() {
        let gw = InvokeGateway::new();
        let err = gw
            .invoke("omni.addon.everything", "search", serde_json::json!({}))
            .unwrap_err();
        assert!(matches!(err, PluginError::UnknownMethod { .. }));
    }

    #[test]
    fn declared_method_runs() {
        let mut gw = InvokeGateway::new();
        gw.register(
            "demo",
            "ping",
            Arc::new(|args| Ok(serde_json::json!({ "echo": args }))),
        );
        let out = gw
            .invoke("demo", "ping", serde_json::json!({ "n": 1 }))
            .unwrap();
        assert_eq!(out["echo"]["n"], 1);
    }
}
