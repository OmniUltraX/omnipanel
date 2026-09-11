use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const AZURE_JS: &[u8] = include_bytes!("../../../plugins/cloud-azure/logic.js");

struct NullHost;
impl PluginHostBridge for NullHost {}

#[tokio::test]
async fn azure_logic_instantiates_and_requires_creds() {
    let executor = JsExecutor::new();
    let inst = executor
        .instantiate(
            "omni.cloud.azure",
            &LogicPackage::Js(AZURE_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("Azure logic.js 应能实例化");
    let err = inst
        .call("testAccount", "{}")
        .await
        .err()
        .expect("缺凭据应失败");
    assert!(
        err.to_string().contains("tenant")
            || err.to_string().contains("subscription")
            || err.to_string().contains("Client")
            || err.to_string().contains("client")
            || err.to_string().contains("密钥"),
        "actual: {err}"
    );
}
