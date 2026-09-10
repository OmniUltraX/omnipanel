use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const AWS_JS: &[u8] = include_bytes!("../../../plugins/cloud-aws/logic.js");

struct NullHost;
impl PluginHostBridge for NullHost {}

#[tokio::test]
async fn aws_logic_instantiates_and_requires_creds() {
    let executor = JsExecutor::new();
    let inst = executor
        .instantiate(
            "omni.cloud.aws",
            &LogicPackage::Js(AWS_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("AWS logic.js 应能实例化");
    let err = inst
        .call("testAccount", "{}")
        .await
        .err()
        .expect("缺凭据应失败");
    assert!(
        err.to_string().contains("AccessKey") || err.to_string().contains("Secret"),
        "actual: {err}"
    );
}
