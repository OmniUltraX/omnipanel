//! 插件逻辑执行器抽象（L2）。
//!
//! 安全骨架（权限闸 / prod 确认 / 审计 / 生命周期）与本 trait 解耦：
//! wasmtime、QuickJS、sidecar 等引擎都是可插拔实现，宪法不随内阁换届。

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use crate::error::PluginError;

/// 边界统一走 JSON 字符串，保持 trait 对象安全且与具体序列化栈解耦。
pub type LogicFuture = Pin<Box<dyn Future<Output = Result<String, PluginError>> + Send>>;

/// prod 确认请求（env_tag=prod 命中时触发交互式确认）。
#[derive(Debug, Clone)]
pub struct ConfirmRequest {
    pub plugin_id: String,
    /// 动作类型：net.fetch / fs.read
    pub action: String,
    /// 目标摘要（URL / 路径）
    pub target: String,
}

pub type ConfirmFuture = Pin<Box<dyn Future<Output = Result<bool, String>> + Send>>;

/// prod 确认器：Ok(true)=放行，Ok(false)=拒绝/超时，Err=确认通道故障。
/// 装配层实现交互式弹窗；测试用 AutoDeny/AutoAllow。
pub trait ProdConfirmer: Send + Sync {
    fn confirm(&self, req: ConfirmRequest) -> ConfirmFuture;
}

/// 拒绝一切（缺省安全态）。
#[derive(Debug, Default, Clone, Copy)]
pub struct AutoDeny;

impl ProdConfirmer for AutoDeny {
    fn confirm(&self, _req: ConfirmRequest) -> ConfirmFuture {
        Box::pin(async { Ok(false) })
    }
}

/// 放行一切（仅测试）。
#[derive(Debug, Default, Clone, Copy)]
pub struct AutoAllow;

impl ProdConfirmer for AutoAllow {
    fn confirm(&self, _req: ConfirmRequest) -> ConfirmFuture {
        Box::pin(async { Ok(true) })
    }
}

/// 逻辑包字节（当前支持 wasm 与 js；js 由 QuickJS 执行器承接）。
#[derive(Debug, Clone)]
pub enum LogicPackage {
    Wasm(Vec<u8>),
    Js(Vec<u8>),
}

impl LogicPackage {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Wasm(_) => "wasm",
            Self::Js(_) => "js",
        }
    }

    /// 按文件扩展名推断逻辑包类型。
    pub fn from_entry_bytes(path: &str, bytes: Vec<u8>) -> Self {
        if path.to_ascii_lowercase().ends_with(".js") {
            Self::Js(bytes)
        } else {
            Self::Wasm(bytes)
        }
    }
}

/// 宿主能力桥：由装配层实现（权限闸/prod 确认/审计包裹在内），
/// 各执行器引擎仅消费。同步签名 = 插件侧阻塞等待，
/// 装配层负责把整次调用放进 spawn_blocking。
pub trait PluginHostBridge: Send + Sync {
    /// 管道自检。
    fn ping(&self) -> i32 {
        0
    }
    fn net_fetch(&self, _url: &str) -> Result<String, String> {
        Err("net.fetch 未装配".into())
    }
    fn fs_read(&self, _path: &str) -> Result<String, String> {
        Err("fs.read 未装配".into())
    }
    fn connection_upsert(&self, _candidate_json: &str) -> Result<(), String> {
        Err("connection.upsert 未装配".into())
    }
    fn invoke(&self, _method: &str, _args_json: &str) -> Result<String, String> {
        Err("invoke 未装配".into())
    }
    fn vault_get(&self, _key: &str) -> Result<String, String> {
        Err("vault.get 未装配".into())
    }
    fn vault_has(&self, _key: &str) -> Result<bool, String> {
        Err("vault.has 未装配".into())
    }
    fn vault_put(&self, _key: &str, _secret: &str) -> Result<(), String> {
        Err("vault.put 未装配".into())
    }
    fn vault_delete(&self, _key: &str) -> Result<(), String> {
        Err("vault.delete 未装配".into())
    }
    fn state_get(&self) -> Result<String, String> {
        Err("state.get 未装配".into())
    }
    fn state_set(&self, _payload: &str) -> Result<(), String> {
        Err("state.set 未装配".into())
    }
}

/// 按逻辑包类型路由到对应引擎的组合执行器。
pub struct RouterExecutor {
    wasm: Option<Arc<dyn PluginLogicExecutor>>,
    js: Option<Arc<dyn PluginLogicExecutor>>,
}

impl RouterExecutor {
    pub fn new(
        wasm: Option<Arc<dyn PluginLogicExecutor>>,
        js: Option<Arc<dyn PluginLogicExecutor>>,
    ) -> Self {
        Self { wasm, js }
    }
}

impl PluginLogicExecutor for RouterExecutor {
    fn instantiate(
        &self,
        plugin_id: &str,
        package: &LogicPackage,
        bridge: Arc<dyn PluginHostBridge>,
    ) -> Result<Box<dyn PluginLogicInstance>, PluginError> {
        let (inner, kind) = match package {
            LogicPackage::Wasm(_) => (self.wasm.as_ref(), "wasm"),
            LogicPackage::Js(_) => (self.js.as_ref(), "js"),
        };
        let Some(executor) = inner else {
            return Err(PluginError::Invoke(format!(
                "{kind} 执行器未启用（构建未包含对应 feature）"
            )));
        };
        executor.instantiate(plugin_id, package, bridge)
    }
}

/// 已实例化的插件执行体。
pub trait PluginLogicInstance: Send {
    /// 调用插件导出方法；返回 JSON 字符串结果。
    fn call(&self, method: &str, args_json: &str) -> LogicFuture;
    /// 释放实例资源（deactivate 时调用；实现 MUST 幂等）。
    fn shutdown(&mut self);
}

/// 执行器工厂：按逻辑包实例化执行体。
pub trait PluginLogicExecutor: Send + Sync {
    fn instantiate(
        &self,
        plugin_id: &str,
        package: &LogicPackage,
        bridge: Arc<dyn PluginHostBridge>,
    ) -> Result<Box<dyn PluginLogicInstance>, PluginError>;
}

/// 空实现：feature 未启用时的占位，instantiate 一律失败并给出可读原因。
#[derive(Debug, Default, Clone, Copy)]
pub struct DisabledExecutor;

impl PluginLogicExecutor for DisabledExecutor {
    fn instantiate(
        &self,
        _plugin_id: &str,
        _package: &LogicPackage,
        _bridge: Arc<dyn PluginHostBridge>,
    ) -> Result<Box<dyn PluginLogicInstance>, PluginError> {
        Err(PluginError::Invoke(
            "插件逻辑执行器未启用（构建未包含 plugin-wasm feature）".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_executor_fails_with_clear_reason() {
        let err = DisabledExecutor
            .instantiate("p", &LogicPackage::Wasm(vec![]), Arc::new(NullHost))
            .err()
            .expect("应失败并给出可读原因");
        assert!(matches!(err, PluginError::Invoke(_)));
        assert!(err.to_string().contains("plugin-wasm"));
    }

    /// Mock 执行器：权限闸测试用，回显输入并记录调用序列。
    #[derive(Default)]
    pub struct MockExecutor {
        pub calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    impl PluginLogicExecutor for MockExecutor {
        fn instantiate(
            &self,
            plugin_id: &str,
            _package: &LogicPackage,
            _bridge: Arc<dyn PluginHostBridge>,
        ) -> Result<Box<dyn PluginLogicInstance>, PluginError> {
            Ok(Box::new(MockInstance {
                id: plugin_id.to_string(),
                calls: std::sync::Arc::clone(&self.calls),
            }))
        }
    }

    struct MockInstance {
        id: String,
        calls: std::sync::Arc<std::sync::Mutex<Vec<(String, String)>>>,
    }

    impl PluginLogicInstance for MockInstance {
        fn call(&self, method: &str, args_json: &str) -> LogicFuture {
            self.calls
                .lock()
                .unwrap()
                .push((method.to_string(), args_json.to_string()));
            let id = self.id.clone();
            Box::pin(async move { Ok(format!(r#"{{"instance":"{id}"}}"#)) })
        }

        fn shutdown(&mut self) {}
    }

    #[test]
    fn mock_executor_roundtrip() {
        let executor = MockExecutor::default();
        let mut inst = executor
            .instantiate("demo", &LogicPackage::Wasm(vec![]), Arc::new(NullHost))
            .unwrap();
        let out = futures_now(inst.call("ping", "{}"));
        assert!(out.contains("demo"));
        assert_eq!(executor.calls.lock().unwrap().len(), 1);
        inst.shutdown();
    }

    struct NullHost;
    impl super::PluginHostBridge for NullHost {}

    fn futures_now(fut: LogicFuture) -> String {
        // 无 tokio 依赖的极简 block_on：本 crate 测试场景 future 立即就绪
        use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
        fn noop(_: *const ()) {}
        fn rw(_: *const ()) -> RawWaker {
            RawWaker::new(std::ptr::null(), &VTABLE)
        }
        static VTABLE: RawWakerVTable = RawWakerVTable::new(rw, noop, noop, noop);
        let waker = unsafe { Waker::from_raw(RawWaker::new(std::ptr::null(), &VTABLE)) };
        let mut cx = Context::from_waker(&waker);
        let mut fut = Box::pin(fut);
        loop {
            if let Poll::Ready(v) = fut.as_mut().poll(&mut cx) {
                return v.unwrap();
            }
        }
    }
}
