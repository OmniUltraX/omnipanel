use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const TENCENT_JS: &[u8] = include_bytes!("../../../plugins/cloud-tencent/logic.js");

struct NullHost;
impl PluginHostBridge for NullHost {}

#[tokio::test]
async fn tencent_logic_instantiates_and_requires_creds() {
    let executor = JsExecutor::new();
    let mut inst = executor
        .instantiate(
            "omni.cloud.tencent",
            &LogicPackage::Js(TENCENT_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("腾讯云 logic.js 应能实例化");
    let err = inst
        .call("testAccount", "{}")
        .await
        .err()
        .expect("缺凭据应失败");
    assert!(
        err.to_string().contains("SecretId") || err.to_string().contains("SecretKey"),
        "actual: {err}"
    );
}
