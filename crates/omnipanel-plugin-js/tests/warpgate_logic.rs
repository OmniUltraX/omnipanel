//! Warpgate logic.js 合同测试：经 QuickJS 执行，mock 桥回放官方 Admin API。

use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;

const LOGIC_JS: &str = include_str!("../../../plugins/importer-warpgate/logic.js");

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

struct FallbackBridge;

impl PluginHostBridge for FallbackBridge {
    fn net_fetch(&self, spec_json: &str) -> Result<String, String> {
        let spec: serde_json::Value = serde_json::from_str(spec_json).map_err(|e| e.to_string())?;
        let url = spec["url"].as_str().unwrap();
        if url.contains("/@warpgate/") {
            return Err("admin api missing".into());
        }
        assert_eq!(url, "https://gw.example.com/targets");
        Ok(serde_json::json!([
            { "id": "tgt-1", "name": "web-1", "kind": "ssh", "bastionHost": "gw.example.com", "bastionPort": 2222, "username": "root", "internalHost": "10.0.0.5" },
            { "id": "tgt-2", "name": "db", "kind": "mysql", "bastionHost": "gw.example.com", "bastionPort": 33306 }
        ])
        .to_string())
    }
}

fn instantiate(bridge: Arc<dyn PluginHostBridge>) -> Box<dyn omnipanel_plugin::PluginLogicInstance> {
    JsExecutor::new()
        .instantiate(
            "omni.importer.warpgate",
            &LogicPackage::Js(LOGIC_JS.as_bytes().to_vec()),
            bridge,
        )
        .expect("实例化失败")
}

#[tokio::test]
async fn fetch_targets_maps_admin_api_to_bastion_candidates() {
    let mut inst = instantiate(Arc::new(AdminApiBridge));
    let out = inst
        .call(
            "fetchTargets",
            r#"{"baseUrl":"https://gw.example.com","token":"tok-123"}"#,
        )
        .await
        .expect("fetchTargets 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    let targets = parsed["targets"].as_array().unwrap();
    assert_eq!(targets.len(), 2, "Http 目标应被跳过");
    assert_eq!(parsed["skipped"].as_array().unwrap().len(), 1);
    for t in targets {
        assert_eq!(t["pluginId"], "omni.importer.warpgate");
        let host = t["config"]["host"].as_str().unwrap();
        assert_eq!(host, "gw.example.com", "必须指向堡垒入口: {host}");
        assert!(!host.starts_with("10."), "禁止内网 IP 作为连接地址");
        assert!(t["config"]["password"].is_null() || t["config"].get("password").is_none());
    }
    assert_eq!(targets[0]["config"]["port"], 2222);
    assert_eq!(targets[0]["config"]["user"], "admin:web-1");
    assert_eq!(targets[1]["config"]["port"], 33306);
    assert_eq!(targets[1]["config"]["user"], "admin#db");
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
async fn fetch_targets_reads_token_from_host_vault() {
    let mut inst = instantiate(Arc::new(VaultTokenBridge));
    let out = inst
        .call(
            "fetchTargets",
            r#"{"baseUrl":"https://gw.example.com","tokenKey":"src-1"}"#,
        )
        .await
        .expect("fetchTargets 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["targets"].as_array().unwrap().len(), 2);
    inst.shutdown();
}

struct VaultPasswordBridge;

impl PluginHostBridge for VaultPasswordBridge {
    fn vault_get(&self, key: &str) -> Result<String, String> {
        match key {
            "src-1" => Ok("tok-123".into()),
            "login-1" => Ok("bastion-pw".into()),
            other => Err(format!("unexpected vault key {other}")),
        }
    }
    fn net_fetch(&self, spec_json: &str) -> Result<String, String> {
        AdminApiBridge.net_fetch(spec_json)
    }
}

#[tokio::test]
async fn fetch_targets_reads_password_from_host_vault_not_token() {
    let mut inst = instantiate(Arc::new(VaultPasswordBridge));
    let out = inst
        .call(
            "fetchTargets",
            r#"{"baseUrl":"https://gw.example.com","tokenKey":"src-1","passwordKey":"login-1","pluginId":"example.importer.demo","accountId":"src-9"}"#,
        )
        .await
        .expect("fetchTargets 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    let targets = parsed["targets"].as_array().unwrap();
    assert_eq!(targets[0]["pluginId"], "example.importer.demo");
    assert_eq!(targets[0]["accountId"], "src-9");
    assert_eq!(targets[0]["config"]["password"], "bastion-pw");
    inst.shutdown();
}

#[tokio::test]
async fn fetch_targets_falls_back_to_legacy_targets_path() {
    let mut inst = instantiate(Arc::new(FallbackBridge));
    let out = inst
        .call(
            "fetchTargets",
            r#"{"baseUrl":"https://gw.example.com","token":"tok-123"}"#,
        )
        .await
        .expect("fetchTargets 失败");
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    assert_eq!(parsed["targets"].as_array().unwrap().len(), 2);
    inst.shutdown();
}

struct JunkTargetsBridge;

impl PluginHostBridge for JunkTargetsBridge {
    fn net_fetch(&self, spec_json: &str) -> Result<String, String> {
        let spec: serde_json::Value = serde_json::from_str(spec_json).map_err(|e| e.to_string())?;
        let url = spec["url"].as_str().unwrap();
        if url.contains("/@warpgate/") {
            return Err("admin api missing".into());
        }
        Ok(serde_json::json!([{ "id": "x", "name": "noise", "foo": 1 }]).to_string())
    }
}

#[tokio::test]
async fn fetch_targets_rejects_non_fixture_targets_fallback() {
    let mut inst = instantiate(Arc::new(JunkTargetsBridge));
    let err = inst
        .call(
            "fetchTargets",
            r#"{"baseUrl":"https://gw.example.com","token":"tok-123"}"#,
        )
        .await
        .expect_err("无 bastionHost 的 /targets 不应导入");
    assert!(err.to_string().contains("admin api missing"));
    inst.shutdown();
}
