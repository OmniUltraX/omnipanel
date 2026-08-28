use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use serde_json::Value;

use crate::error::PluginError;

pub type InvokeFuture = Pin<Box<dyn Future<Output = Result<Value, PluginError>> + Send>>;

/// 第一方插件命令网关 handler（异步：可包 spawn_blocking / WASM 调度）。
pub type InvokeHandler = Arc<dyn Fn(Value) -> InvokeFuture + Send + Sync>;

/// 第一方插件命令网关：仅编译期登记的 `(plugin_id, method)` 可调用；
/// 权限与白名单校验在调用方（commands 层）按清单 `methods[]` 强制。
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

    pub async fn invoke(
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
        handler(args).await
    }

    pub fn is_declared(&self, plugin_id: &str, method: &str) -> bool {
        self.handlers
            .contains_key(&(plugin_id.to_string(), method.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn unknown_method_fails() {
        let gw = InvokeGateway::new();
        let err = gw
            .invoke("omni.addon.everything", "search", serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::UnknownMethod { .. }));
    }

    #[tokio::test]
    async fn declared_method_runs_async_handler() {
        let mut gw = InvokeGateway::new();
        gw.register(
            "demo",
            "ping",
            Arc::new(|args| Box::pin(async move { Ok(serde_json::json!({ "echo": args })) })),
        );
        let out = gw
            .invoke("demo", "ping", serde_json::json!({ "n": 1 }))
            .await
            .unwrap();
        assert_eq!(out["echo"]["n"], 1);
    }
}
