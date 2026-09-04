//! ABI 管道自检：wat 客体导入 omni.ping、导出 call 返回固定 JSON。

use omnipanel_plugin::{LogicPackage, PluginHostBridge, PluginLogicExecutor, PluginLogicInstance};
use omnipanel_plugin_wasm::WasmExecutor;
use std::sync::Arc;

/// call() -> 返回 data 段里的 `{"ok":true}`（len=11, ptr=0），并调用一次 omni.ping
const ECHO_GUEST_WAT: &str = r#"
(module
  (import "omni" "ping" (func $ping (result i32)))
  (memory (export "memory") 1)
  (global $alloc_ptr (mut i32) (i32.const 1024))
  (func $alloc (export "omni_alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $alloc_ptr))
    (global.set $alloc_ptr (i32.add (global.get $alloc_ptr) (local.get $n)))
    (local.get $p))
  (data (i32.const 0) "{\"ok\":true}")
  (func (export "call") (param i32 i32 i32 i32) (result i64)
    (drop (call $ping))
    (i64.or
      (i64.extend_i32_u (i32.const 0))
      (i64.shl (i64.extend_i32_u (i32.const 11)) (i64.const 32))))
)
"#;

#[tokio::test]
async fn abi_pipeline_roundtrip() {
    let executor = WasmExecutor::new();
    let mut instance = executor
        .instantiate(
            "omni.engine.l1-starter",
            &LogicPackage::Wasm(wat::parse_str(ECHO_GUEST_WAT).unwrap()),
            Arc::new(NullHost),
        )
        .expect("实例化失败");
    let result = instance.call("anything", "{}").await.expect("call 失败");
    assert_eq!(result, r#"{"ok":true}"#);
    instance.shutdown();
}

#[tokio::test]
async fn invalid_wasm_fails_cleanly() {
    let executor = WasmExecutor::new();
    let err = executor
        .instantiate(
            "p",
            &LogicPackage::Wasm(b"not wasm".to_vec()),
            Arc::new(NullHost),
        )
        .err()
        .expect("应编译失败");
    assert!(err.to_string().contains("逻辑包编译失败"));
}

/// 客体调用 omni.net_fetch 并把宿主回写结果原样返回（验证 omni_alloc 回写协议）。
const NET_GUEST_WAT: &str = r#"
(module
  (import "omni" "net_fetch" (func $nf (param i32 i32) (result i64)))
  (memory (export "memory") 1)
  (global $alloc_ptr (mut i32) (i32.const 1024))
  (func $alloc (export "omni_alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $alloc_ptr))
    (global.set $alloc_ptr (i32.add (global.get $alloc_ptr) (local.get $n)))
    (local.get $p))
  (func (export "call") (param i32 i32 i32 i32) (result i64)
    ;; url 写在 64..72："/targets"
    (i32.store8 (i32.const 64) (i32.const 47))
    (i32.store8 (i32.const 65) (i32.const 116))
    (i32.store8 (i32.const 66) (i32.const 103))
    (i32.store8 (i32.const 67) (i32.const 101))
    (i32.store8 (i32.const 68) (i32.const 116))
    (i32.store8 (i32.const 69) (i32.const 115))
    (call $nf (i32.const 64) (i32.const 8)))
)
"#;

// 桥注入点说明：装配层通过实例存储传入真实桥（PluginHostBridge）；
// 本测试经 NullBridge 验证错误回传链路：宿主函数 → omni_alloc 回写 →
// 客体原样返回 → 宿主按错误标志解码。
#[tokio::test]
async fn host_bridge_error_roundtrip_via_alloc() {
    let executor = WasmExecutor::new();
    let mut instance = executor
        .instantiate(
            "p",
            &LogicPackage::Wasm(wat::parse_str(NET_GUEST_WAT).unwrap()),
            Arc::new(NullHost),
        )
        .expect("实例化失败");
    // NullBridge 的 net_fetch 返回 "net.fetch 未装配" —— 经 omni_alloc 回写、
    // 客体原样返回、宿主按错误标志解码
    let err = instance.call("x", "{}").await.err().expect("应为桥错误");
    assert!(err.to_string().contains("未装配"), "actual: {err}");
}

struct NullHost;
impl PluginHostBridge for NullHost {}
