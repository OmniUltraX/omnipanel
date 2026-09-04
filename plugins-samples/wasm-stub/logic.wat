;; WASM 逻辑包样板（ABI：memory + call(m_ptr,m_len,a_ptr,a_len)->i64 + omni_alloc）
;; 构建：cargo install wat2wasm 或 npm i -g wabt && wat2wasm logic.wat -o logic.wasm
;; 打包前把 logic.wasm 与 plugin.json 一起 pack。
(module
  (import "omni" "ping" (func $ping (result i32)))
  (memory (export "memory") 1)
  (global $alloc_ptr (mut i32) (i32.const 1024))
  (func $alloc (export "omni_alloc") (param $n i32) (result i32)
    (local $p i32)
    (local.set $p (global.get $alloc_ptr))
    (global.set $alloc_ptr (i32.add (global.get $alloc_ptr) (local.get $n)))
    (local.get $p))
  (data (i32.const 0) "{\"echo\":true}")
  (func (export "call") (param $m_ptr i32) (param $m_len i32) (param $a_ptr i32) (param $a_len i32) (result i64)
    (drop (call $ping))
    ;; 最小闭环：忽略入参，返回 data 段 JSON；真回显需自行读内存拼接
    (i64.or
      (i64.extend_i32_u (i32.const 0))
      (i64.shl (i64.extend_i32_u (i32.const 13)) (i64.const 32))))
)
