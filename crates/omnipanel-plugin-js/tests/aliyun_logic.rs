use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const ALIYUN_JS: &[u8] = include_bytes!("../../../plugins/cloud-aliyun/logic.js");

struct NullHost;
impl PluginHostBridge for NullHost {}

#[tokio::test]
async fn aliyun_logic_instantiates_and_requires_creds() {
    let executor = JsExecutor::new();
    let inst = executor
        .instantiate(
            "omni.cloud.aliyun",
            &LogicPackage::Js(ALIYUN_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("阿里云 logic.js 应能实例化");
    let err = inst
        .call("testAccount", "{}")
        .await
        .err()
        .expect("缺凭据应失败");
    assert!(
        err.to_string().contains("AccessKey") || err.to_string().contains("缺少"),
        "actual: {err}"
    );
}

#[tokio::test]
async fn aliyun_logic_declares_unknown_method() {
    let executor = JsExecutor::new();
    let inst = executor
        .instantiate(
            "omni.cloud.aliyun",
            &LogicPackage::Js(ALIYUN_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("阿里云 logic.js 应能实例化");
    let err = inst
        .call("notAMethod", "{}")
        .await
        .err()
        .expect("未知方法应失败");
    assert!(
        err.to_string().contains("UnknownMethod"),
        "actual: {err}"
    );
}
