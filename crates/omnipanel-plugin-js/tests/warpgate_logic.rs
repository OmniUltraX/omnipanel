//! Warpgate addon logic.js 合同测试：经 QuickJS 执行，mock 桥回放官方 Admin API。

use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const LOGIC_JS: &str = include_str!("../../../plugins/addon-warpgate/logic.js");

struct AdminApiBridge;

impl PluginHostBridge for AdminApiBridge {
    fn net_fetch(&self, spec_json: &str) -> Result<String, String> {
        let spec: serde_json::Value = serde_json::from_str(spec_json).map_err(|e| e.to_string())?;
        let url = spec["url"].as_str().unwrap();
        assert_eq!(
            spec["headers"]["X-Warpgate-Token"].as_str().unwrap(),
            "tok-123"
        );
        if url.ends_with("/@warpgate/api/info") || url.ends_with("/@warpgate/admin/api/info") {
            return Ok(serde_json::json!({ "username": "admin" }).to_string());
        }
        if url.ends_with("/@warpgate/admin/api/network/listeners") {
            return Ok(serde_json::json!([
                { "name": "ssh", "state": "Listening", "address": "0.0.0.0:2222", "certificates": [] },
                { "name": "mysql", "state": "Listening", "address": "0.0.0.0:33306", "certificates": [] }
            ])
            .to_string());
        }
        if url.ends_with("/@warpgate/admin/api/targets") {
            return Ok(serde_json::json!([
                {
                    "id": "tgt-1",
                    "name": "web-1",
                    "description": "",
                    "allow_roles": [],
                    "ticket_requests_disabled": false,
                    "ticket_require_approval": false,
                    "options": { "kind": "Ssh", "host": "10.0.0.5", "port": 22 }
                },
                {
                    "id": "tgt-2",
                    "name": "db",
                    "description": "",
                    "allow_roles": [],
                    "ticket_requests_disabled": false,
                    "ticket_require_approval": false,
                    "options": { "kind": "MySql", "host": "10.0.2.20", "port": 3306 }
                },
                {
                    "id": "tgt-http",
                    "name": "portal",
                    "description": "",
                    "allow_roles": [],
                    "ticket_requests_disabled": false,
                    "ticket_require_approval": false,
                    "options": { "kind": "Http" }
                }
            ])
            .to_string());
        }
        Err(format!("unexpected url {url}"))
    }
}

fn instantiate(
    bridge: Arc<dyn PluginHostBridge>,
) -> Box<dyn omnipanel_plugin::PluginLogicInstance> {
    JsExecutor::new()
        .instantiate(
            "omni.addon.warpgate",
            &LogicPackage::Js(LOGIC_JS.as_bytes().to_vec()),
            bridge,
        )
        .expect("实例化失败")
}

#[tokio::test]
async fn list_ssh_targets_filters_non_ssh() {
    let mut inst = instantiate(Arc::new(AdminApiBridge));
    let out = inst
        .call(
            "listSshTargets",
            r#"{"baseUrl":"https://gw.example.com","token":"tok-123"}"#,
        )
        .await
        .expect("listSshTargets 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    let targets = parsed["targets"].as_array().unwrap();
    assert_eq!(targets.len(), 1, "仅 SSH target");
    assert_eq!(targets[0]["name"], "web-1");
    assert_eq!(targets[0]["bastionHost"], "gw.example.com");
    assert_eq!(targets[0]["bastionPort"], 2222);
    assert_eq!(parsed["loginUser"], "admin");
    inst.shutdown();
}

#[tokio::test]
async fn resolve_ssh_via_gateway_builds_protocol_user() {
    let mut inst = instantiate(Arc::new(AdminApiBridge));
    let out = inst
        .call(
            "resolveSshViaGateway",
            r#"{"baseUrl":"https://gw.example.com","token":"tok-123","password":"bastion-pw","targetId":"tgt-1","targetName":"web-1"}"#,
        )
        .await
        .expect("resolveSshViaGateway 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["host"], "gw.example.com");
    assert_eq!(parsed["port"], 2222);
    assert_eq!(parsed["user"], "admin:web-1");
    assert_eq!(parsed["password"], "bastion-pw");
    assert_eq!(parsed["via"], "warpgate-bastion");
    inst.shutdown();
}

struct VaultTokenBridge;

impl PluginHostBridge for VaultTokenBridge {
    fn vault_get(&self, key: &str) -> Result<String, String> {
        assert_eq!(key, "src-1");
        Ok("tok-123".into())
    }
    fn net_fetch(&self, spec_json: &str) -> Result<String, String> {
        AdminApiBridge.net_fetch(spec_json)
    }
}

#[tokio::test]
async fn list_ssh_targets_reads_token_from_host_vault() {
    let mut inst = instantiate(Arc::new(VaultTokenBridge));
    let out = inst
        .call(
            "listSshTargets",
            r#"{"baseUrl":"https://gw.example.com","tokenKey":"src-1"}"#,
        )
        .await
        .expect("listSshTargets 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["targets"].as_array().unwrap().len(), 1);
    inst.shutdown();
}

#[tokio::test]
async fn test_gateway_returns_login_user() {
    let mut inst = instantiate(Arc::new(AdminApiBridge));
    let out = inst
        .call(
            "testGateway",
            r#"{"baseUrl":"https://gw.example.com","token":"tok-123"}"#,
        )
        .await
        .expect("testGateway 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["ok"], true);
    assert_eq!(parsed["loginUser"], "admin");
    assert_eq!(parsed["bastionHost"], "gw.example.com");
    inst.shutdown();
}
