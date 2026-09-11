use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const GCP_JS: &[u8] = include_bytes!("../../../plugins/cloud-gcp/logic.js");

struct NullHost;
impl PluginHostBridge for NullHost {}

#[tokio::test]
async fn gcp_logic_instantiates_and_requires_creds() {
    let executor = JsExecutor::new();
    let inst = executor
        .instantiate(
            "omni.cloud.gcp",
            &LogicPackage::Js(GCP_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("GCP logic.js 应能实例化");
    let err = inst
        .call("testAccount", "{}")
        .await
        .err()
        .expect("缺凭据应失败");
    assert!(
        err.to_string().contains("服务账号")
            || err.to_string().contains("JSON")
            || err.to_string().contains("private"),
        "actual: {err}"
    );
}
