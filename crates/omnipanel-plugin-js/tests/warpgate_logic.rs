//! Warpgate logic.js 合同测试：经 QuickJS 执行，mock 桥回放夹具 JSON。

use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const LOGIC_JS: &str = include_str!("../../../plugins/importer-warpgate/logic.js");

struct FixtureBridge;

impl PluginHostBridge for FixtureBridge {
    fn net_fetch(&self, spec_json: &str) -> Result<String, String> {
        // 校验 spec 形态与鉴权头
        let spec: serde_json::Value = serde_json::from_str(spec_json).map_err(|e| e.to_string())?;
        assert_eq!(
            spec["url"].as_str().unwrap(),
            "https://gw.example.com/targets"
        );
        assert_eq!(
            spec["headers"]["Authorization"].as_str().unwrap(),
            "Bearer tok-123"
        );
        Ok(
            serde_json::json!([
                { "id": "tgt-1", "name": "web-1", "kind": "ssh", "bastionHost": "gw.example.com", "bastionPort": 2222, "username": "root", "internalHost": "10.0.0.5" },
                { "id": "tgt-2", "name": "db", "kind": "mysql", "bastionHost": "gw.example.com", "bastionPort": 33306 }
            ])
            .to_string(),
        )
    }
}

#[tokio::test]
async fn fetch_targets_maps_to_bastion_candidates() {
    let executor = JsExecutor::new();
    let mut inst = executor
        .instantiate(
            "omni.importer.warpgate",
            &LogicPackage::Js(LOGIC_JS.as_bytes().to_vec()),
            Arc::new(FixtureBridge),
        )
        .expect("实例化失败");

    let out = inst
        .call(
            "fetchTargets",
            r#"{"baseUrl":"https://gw.example.com","token":"tok-123"}"#,
        )
        .await
        .expect("fetchTargets 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    let targets = parsed["targets"].as_array().unwrap();
    assert_eq!(targets.len(), 2);
    for t in targets {
        assert_eq!(t["pluginId"], "omni.importer.warpgate");
        let host = t["config"]["host"].as_str().unwrap();
        assert!(host.contains("gw.example.com"), "必须指向堡垒入口: {host}");
        assert!(!host.starts_with("10."), "禁止内网 IP 作为连接地址");
    }

    use omnipanel_plugin::PluginLogicInstance as _;
    inst.shutdown();
}
