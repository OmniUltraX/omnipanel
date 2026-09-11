use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const HESTIA_JS: &[u8] = include_bytes!("../../../plugins/panel-hestia/logic.js");

struct NullHost;
impl PluginHostBridge for NullHost {}

#[tokio::test]
async fn hestia_logic_instantiates_and_requires_creds() {
    let executor = JsExecutor::new();
    let inst = executor
        .instantiate(
            "omni.panel.hestia",
            &LogicPackage::Js(HESTIA_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("HestiaCP logic.js 应能实例化");
    let err = inst
        .call("testConnection", "{}")
        .await
        .err()
        .expect("缺凭据应失败");
    assert!(
        err.to_string().contains("面板地址") || err.to_string().contains("API"),
        "actual: {err}"
    );
}
