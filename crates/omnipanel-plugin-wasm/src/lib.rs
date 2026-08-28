//! [`PluginLogicExecutor`] 的 wasmtime 实现。
//!
//! 客体 ABI：
//! - 必需导出：`memory`、`call(method_ptr, method_len, args_ptr, args_len) -> i64`
//!   （返回 `(len << 32) | ptr`；len 字段最高位为 1 表示结果是错误文本）；
//!   可选导出：`omni_alloc(size) -> ptr`（宿主回写数据时在客体内分配）；
//!   缺失时需要回传数据的宿主函数返回错误包（ptr=-1 且错误标志置位）。
//! - 导入命名空间 `omni`（结果经 omni_alloc 回写、i64 打包返回，同上编码）：
//!   `ping() -> i32`
//!   `net_fetch(url_ptr, url_len) -> i64`
//!   `fs_read(path_ptr, path_len) -> i64`
//!   `connection_upsert(json_ptr, json_len) -> i64`
//!   `invoke(m_ptr, m_len, a_ptr, a_len) -> i64`
//!   `vault_get/has/put/delete`、`state_get/set`（i64 打包，同 net_fetch）
//!
//! 权限不在本 crate：[`PluginHostBridge`] 由装配层实现并包裹
//! 权限闸 / prod 确认 / 审计；本 crate 只做引擎与 ABI。

use omnipanel_plugin::{
    LogicFuture, LogicPackage, PluginError, PluginHostBridge, PluginLogicExecutor,
    PluginLogicInstance,
};
use wasmtime::{Caller, Engine, Linker, Module, Store, TypedFunc};

const LEN_ERROR_BIT: u64 = 1 << 63;
const ERR_PACKED: i64 = ((LEN_ERROR_BIT >> 32) as u32 as i64) << 32 | (-1i32 as u32 as i64);

struct BridgeCtx<'b> {
    bridge: &'b dyn PluginHostBridge,
}

pub struct WasmExecutor {
    engine: Engine,
}

impl Default for WasmExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmExecutor {
    pub fn new() -> Self {
        Self {
            engine: Engine::default(),
        }
    }
}

impl PluginLogicExecutor for WasmExecutor {
    fn instantiate(
        &self,
        plugin_id: &str,
        package: &LogicPackage,
        bridge: std::sync::Arc<dyn omnipanel_plugin::PluginHostBridge>,
    ) -> Result<Box<dyn PluginLogicInstance>, PluginError> {
        match package {
            LogicPackage::Wasm(bytes) => {
                let module = Module::from_binary(&self.engine, bytes)
                    .map_err(|e| PluginError::Invoke(format!("逻辑包编译失败: {e}")))?;
                Ok(Box::new(WasmInstance {
                    engine: self.engine.clone(),
                    module,
                    bridge,
                }))
            }
            LogicPackage::Js(_) => Err(PluginError::Invoke("wasm 执行器不接受 js 逻辑包".into())),
        }
    }
}

struct WasmInstance {
    engine: Engine,
    module: Module,
    bridge: std::sync::Arc<dyn omnipanel_plugin::PluginHostBridge>,
}

impl PluginLogicInstance for WasmInstance {
    fn call(&self, method: &str, args_json: &str) -> LogicFuture {
        let engine = self.engine.clone();
        let module = self.module.clone();
        let method = method.to_string();
        let args_json = args_json.to_string();
        let bridge = std::sync::Arc::clone(&self.bridge);
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                run_call(&engine, &module, bridge.as_ref(), &method, &args_json)
            })
            .await
            .map_err(|e| PluginError::Invoke(e.to_string()))?
        })
    }

    fn shutdown(&mut self) {}
}

fn pack(ptr: usize, len: usize, error: bool) -> i64 {
    let mut packed = ((len as u64) << 32) | (ptr as u64);
    if error {
        packed |= LEN_ERROR_BIT;
    }
    packed as i64
}

/// 宿主函数公共尾：把桥结果经 omni_alloc 写入客体内存并按 ABI 打包返回。
fn return_to_guest(mut caller: Caller<'_, BridgeCtx<'_>>, payload: Result<Vec<u8>, String>) -> i64 {
    let (bytes, error) = match payload {
        Ok(data) => (data, false),
        Err(msg) => (msg.into_bytes(), true),
    };
    let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return ERR_PACKED;
    };
    let alloc: TypedFunc<i32, i32> = match caller
        .get_export("omni_alloc")
        .and_then(|f| f.into_func())
        .and_then(|f| f.typed::<i32, i32>(&caller).ok())
    {
        Some(f) => f,
        None => return ERR_PACKED,
    };
    let ptr = match alloc.call(&mut caller, bytes.len() as i32) {
        Ok(p) => p,
        Err(_) => return ERR_PACKED,
    };
    if memory
        .write(&mut caller, ptr.max(0) as usize, &bytes)
        .is_err()
    {
        return ERR_PACKED;
    }
    pack(ptr.max(0) as usize, bytes.len(), error)
}

fn read_guest_str(caller: &mut Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32) -> String {
    let Some(memory) = caller.get_export("memory").and_then(|e| e.into_memory()) else {
        return String::new();
    };
    let mut buf = vec![0u8; len.max(0) as usize];
    if memory.read(caller, ptr.max(0) as usize, &mut buf).is_err() {
        return String::new();
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn run_call(
    engine: &Engine,
    module: &Module,
    bridge: &dyn PluginHostBridge,
    method: &str,
    args_json: &str,
) -> Result<String, PluginError> {
    let mut store = Store::new(engine, BridgeCtx { bridge });
    let mut linker: Linker<BridgeCtx<'_>> = Linker::new(engine);
    wire_imports(&mut linker)?;

    let instance = linker
        .instantiate(&mut store, module)
        .map_err(|e| PluginError::Invoke(format!("实例化失败: {e}")))?;
    let call = instance
        .get_typed_func::<(i32, i32, i32, i32), i64>(&mut store, "call")
        .map_err(|_| PluginError::Invoke("逻辑包缺少导出 call".into()))?;

    let _ = (method, args_json);
    let packed = call
        .call(&mut store, (0, 0, 0, 0))
        .map_err(|e| PluginError::Invoke(format!("call 失败: {e}")))?;

    let len_field = ((packed as u64) >> 32) as u32;
    let error = len_field & (LEN_ERROR_BIT >> 32) as u32 != 0;
    let len = (len_field & !(LEN_ERROR_BIT >> 32) as u32) as usize;
    let ptr = (packed & 0xffff_ffff) as usize;
    let memory = instance
        .get_memory(&mut store, "memory")
        .ok_or_else(|| PluginError::Invoke("逻辑包缺少导出 memory".into()))?;
    let mut buf = vec![0u8; len];
    memory
        .read(&store, ptr, &mut buf)
        .map_err(|e| PluginError::Invoke(e.to_string()))?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    if error {
        Err(PluginError::Invoke(text))
    } else {
        Ok(text)
    }
}

fn wire_imports(linker: &mut Linker<BridgeCtx<'_>>) -> Result<(), PluginError> {
    linker
        .func_wrap("omni", "ping", |ctx: Caller<'_, BridgeCtx<'_>>| -> i32 {
            ctx.data().bridge.ping()
        })
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "net_fetch",
            |mut caller: Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32| -> i64 {
                let url = read_guest_str(&mut caller, ptr, len);
                let payload = caller.data().bridge.net_fetch(&url).map(String::into_bytes);
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "fs_read",
            |mut caller: Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32| -> i64 {
                let path = read_guest_str(&mut caller, ptr, len);
                let payload = caller.data().bridge.fs_read(&path).map(String::into_bytes);
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "connection_upsert",
            |mut caller: Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32| -> i64 {
                let candidate = read_guest_str(&mut caller, ptr, len);
                let payload = caller
                    .data()
                    .bridge
                    .connection_upsert(&candidate)
                    .map(|_| Vec::new());
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "invoke",
            |mut caller: Caller<'_, BridgeCtx<'_>>,
             m_ptr: i32,
             m_len: i32,
             a_ptr: i32,
             a_len: i32|
             -> i64 {
                let method = read_guest_str(&mut caller, m_ptr, m_len);
                let args = read_guest_str(&mut caller, a_ptr, a_len);
                let payload = caller
                    .data()
                    .bridge
                    .invoke(&method, &args)
                    .map(String::into_bytes);
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "vault_get",
            |mut caller: Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32| -> i64 {
                let key = read_guest_str(&mut caller, ptr, len);
                let payload = caller.data().bridge.vault_get(&key).map(String::into_bytes);
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "vault_has",
            |mut caller: Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32| -> i64 {
                let key = read_guest_str(&mut caller, ptr, len);
                let payload = caller
                    .data()
                    .bridge
                    .vault_has(&key)
                    .map(|has| if has { b"true".to_vec() } else { b"false".to_vec() });
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "vault_put",
            |mut caller: Caller<'_, BridgeCtx<'_>>,
             k_ptr: i32,
             k_len: i32,
             s_ptr: i32,
             s_len: i32|
             -> i64 {
                let key = read_guest_str(&mut caller, k_ptr, k_len);
                let secret = read_guest_str(&mut caller, s_ptr, s_len);
                let payload = caller
                    .data()
                    .bridge
                    .vault_put(&key, &secret)
                    .map(|_| Vec::new());
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "vault_delete",
            |mut caller: Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32| -> i64 {
                let key = read_guest_str(&mut caller, ptr, len);
                let payload = caller
                    .data()
                    .bridge
                    .vault_delete(&key)
                    .map(|_| Vec::new());
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "state_get",
            |caller: Caller<'_, BridgeCtx<'_>>| -> i64 {
                let payload = caller.data().bridge.state_get().map(String::into_bytes);
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    linker
        .func_wrap(
            "omni",
            "state_set",
            |mut caller: Caller<'_, BridgeCtx<'_>>, ptr: i32, len: i32| -> i64 {
                let payload_text = read_guest_str(&mut caller, ptr, len);
                let payload = caller
                    .data()
                    .bridge
                    .state_set(&payload_text)
                    .map(|_| Vec::new());
                return_to_guest(caller, payload)
            },
        )
        .map_err(wasmtime_err)?;

    Ok(())
}

fn wasmtime_err(e: wasmtime::Error) -> PluginError {
    PluginError::Invoke(e.to_string())
}
