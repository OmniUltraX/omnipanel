//! JsExecutor 行为测试：回显 / 宿主桥注入 / 缺失合同 / 死循环中断。

use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor, PluginLogicInstance};
use omnipanel_plugin_js::JsExecutor;
use std::sync::Arc;
use std::time::Duration;

const ECHO_JS: &[u8] = br#"
globalThis.call = function (method, argsJson) {
  return JSON.stringify({ ok: true, method });
};
"#;

const HOST_JS: &[u8] = br#"
globalThis.call = function (_method, _args) {
  let msg;
  try {
    host.netFetch("https://example.com/x");
    msg = "unexpected-success";
  } catch (e) {
    msg = String(e);
  }
  return JSON.stringify({ ping: host.ping(), msg });
};
"#;

const MISSING_CALL_JS: &[u8] = b"globalThis.hello = 1;";

const BUSY_LOOP_JS: &[u8] = b"globalThis.call = function () { while (true) {} };";

#[tokio::test]
async fn echo_roundtrip() {
    let executor = JsExecutor::new();
    let mut inst = executor
        .instantiate(
            "omni.addon.demo",
            &LogicPackage::Js(ECHO_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("实例化失败");
    let out = inst.call("ping", "{}").await.expect("call 失败");
    assert!(out.contains(r#""ok":true"#), "actual: {out}");
    assert!(out.contains("ping"), "actual: {out}");
}

#[tokio::test]
async fn host_object_injected_and_errors_surface() {
    let executor = JsExecutor::new();
    let mut inst = executor
        .instantiate(
            "omni.addon.demo",
            &LogicPackage::Js(HOST_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("实例化失败");
    // NullBridge：netFetch 抛「未装配」异常，ping 返回 0
    let out = inst.call("x", "{}").await.expect("call 失败");
    assert!(out.contains(r#""ping":0"#), "actual: {out}");
    assert!(out.contains("未装配"), "actual: {out}");
}

#[tokio::test]
async fn missing_call_contract_fails_cleanly() {
    let executor = JsExecutor::new();
    let mut inst = executor
        .instantiate(
            "p",
            &LogicPackage::Js(MISSING_CALL_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("实例化失败");
    let err = inst.call("x", "{}").await.err().expect("应报缺少 call");
    assert!(
        err.to_string().contains("call(method, argsJson)"),
        "actual: {err}"
    );
}

#[tokio::test]
async fn busy_loop_interrupted_by_timeout() {
    let executor = JsExecutor::with_call_timeout(Duration::from_millis(150));
    let mut inst = executor
        .instantiate(
            "p",
            &LogicPackage::Js(BUSY_LOOP_JS.to_vec()),
            Arc::new(NullHost),
        )
        .expect("实例化失败");
    let started = std::time::Instant::now();
    let err = inst.call("x", "{}").await.err().expect("应被超时中断");
    assert!(err.to_string().contains("执行超时"), "actual: {err}");
    assert!(started.elapsed() < Duration::from_secs(3), "中断应快速生效");
}

struct NullHost;
impl PluginHostBridge for NullHost {}
