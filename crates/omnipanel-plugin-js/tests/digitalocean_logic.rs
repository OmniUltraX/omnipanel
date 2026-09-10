use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const DO_JS: &[u8] = include_bytes!("../../../plugins/cloud-digitalocean/logic.js");

struct NullHost;
impl PluginHostBridge for NullHost {}

#[tokio::test]
async fn digitalocean_logic_instantiates_and_requires_token() {
    let executor = JsExecutor::new();
    let inst = executor
        .instantiate(
            "omni.cloud.digitalocean",
            &LogicPackage::Js(DO_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("DigitalOcean logic.js 应能实例化");
    let err = inst
        .call("testAccount", "{}")
        .await
        .err()
        .expect("缺凭据应失败");
    assert!(
        err.to_string().contains("Token") || err.to_string().contains("token"),
        "actual: {err}"
    );
}
