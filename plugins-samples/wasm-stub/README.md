# WASM 样板

ABI：`memory` + `call(m_ptr,m_len,a_ptr,a_len)->i64` + `omni_alloc(size)->ptr`，返回 `(len<<32)|ptr`（最高位 1 = 错误）。

```bash
wat2wasm plugins-samples/wasm-stub/logic.wat -o /tmp/logic.wasm
cp /tmp/logic.wasm plugins-samples/wasm-stub/logic.wasm
node scripts/validate-plugin.mjs plugins-samples/wasm-stub
cargo run -p omnipanel-plugin-pkg --bin pack -- plugins-samples/wasm-stub wasm-stub.omni-plugin
```

宿主已真透传 `method+args_json`（经 `omni_alloc` 写入客体内存），缺 `omni_alloc` 会报可读错误。
