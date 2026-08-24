//! [`PluginLogicExecutor`] 的 QuickJS 实现（L2 胶水逻辑，TS/JS 友好）。
//!
//! 客体合同：
//! - 脚本在实例化时整体求值；MUST 定义全局函数
//!   `call(method: string, argsJson: string): string`（返回 JSON 字符串）；
//! - 宿主注入全局只读对象 `host`：
//!   `ping(): number`、`netFetch(url): string`、`fsRead(path): string`、
//!   `connectionUpsert(candidateJson): void`、`invoke(method, argsJson): string`；
//!   失败以 JS 异常抛出。
//!
//! 资源限制：内存 64MB、栈 1MB、单次调用默认 10s 中断阈值（防死循环）。
//! 权限不在本 crate：[`PluginHostBridge`](omnipanel_plugin::PluginHostBridge)
//! 由装配层实现并包裹权限闸 / prod 确认 / 审计。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use omnipanel_plugin::{
    LogicFuture, LogicPackage, PluginError, PluginHostBridge, PluginLogicExecutor,
    PluginLogicInstance,
};
use rquickjs::{Context, Function, Object, Runtime};

const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const STACK_LIMIT: usize = 1024 * 1024;
pub const DEFAULT_CALL_TIMEOUT: Duration = Duration::from_secs(10);



pub struct JsExecutor {
    call_timeout: Duration,
}

impl Default for JsExecutor {
    fn default() -> Self {
        Self { call_timeout: DEFAULT_CALL_TIMEOUT }
    }
}

impl JsExecutor {
    pub fn new() -> Self {
        Self::default()
    }

    /// 自定义单次调用中断阈值（测试/长任务场景）。
    pub fn with_call_timeout(timeout: Duration) -> Self {
        Self { call_timeout: timeout }
    }
}

impl PluginLogicExecutor for JsExecutor {
    fn instantiate(
        &self,
        plugin_id: &str,
        package: &LogicPackage,
        bridge: Arc<dyn PluginHostBridge>,
    ) -> Result<Box<dyn PluginLogicInstance>, PluginError> {
        match package {
            LogicPackage::Js(code) => {
                let inner = JsInstanceInner::new(plugin_id, bridge, code, self.call_timeout)
                    .map_err(|e| PluginError::Invoke(format!("JS 实例化失败: {e}")))?;
                Ok(Box::new(JsInstance {
                    inner: Arc::new(Mutex::new(inner)),
                }))
            }
            LogicPackage::Wasm(_) => Err(PluginError::Invoke("js 执行器不接受 wasm 逻辑包".into())),
        }
    }
}

struct JsInstanceInner {
    runtime: Runtime,
    context: Context,
    call_timeout: Duration,
}

impl JsInstanceInner {
    fn new(
        plugin_id: &str,
        bridge: Arc<dyn PluginHostBridge>,
        code: &[u8],
        call_timeout: Duration,
    ) -> rquickjs::Result<Self> {
        let runtime = Runtime::new()?;
        runtime.set_memory_limit(MEMORY_LIMIT);
        runtime.set_max_stack_size(STACK_LIMIT);
        let context = Context::full(&runtime)?;

        let source = String::from_utf8_lossy(code).into_owned();
        let pid = plugin_id.to_string();
        context.with(|ctx| {
            let globals = ctx.globals();
            let host = Object::new(ctx.clone())?;

            host.set(
                "ping",
                Function::new(ctx.clone(), {
                    let b = Arc::clone(&bridge);
                    move || -> i32 { b.ping() }
                }),
            )?;
            host.set(
                "netFetch",
                Function::new(ctx.clone(), {
                    let b = Arc::clone(&bridge);
                    move |url: String| -> rquickjs::Result<String> {
                        b.net_fetch(&url).map_err(|msg| {
                            rquickjs::Error::new_from_js_message("host.netFetch", "string", msg)
                        })
                    }
                }),
            )?;
            host.set(
                "fsRead",
                Function::new(ctx.clone(), {
                    let b = Arc::clone(&bridge);
                    move |path: String| -> rquickjs::Result<String> {
                        b.fs_read(&path).map_err(|msg| {
                            rquickjs::Error::new_from_js_message("host.fsRead", "string", msg)
                        })
                    }
                }),
            )?;
            host.set(
                "connectionUpsert",
                Function::new(ctx.clone(), {
                    let b = Arc::clone(&bridge);
                    move |json: String| -> rquickjs::Result<()> {
                        b.connection_upsert(&json).map_err(|msg| {
                            rquickjs::Error::new_from_js_message("host.connectionUpsert", "void", msg)
                        })
                    }
                }),
            )?;
            host.set(
                "invoke",
                Function::new(
                    ctx.clone(),
                    {
                        let b = Arc::clone(&bridge);
                        move |method: String, args: String| -> rquickjs::Result<String> {
                            b.invoke(&method, &args).map_err(|msg| {
                                rquickjs::Error::new_from_js_message("host.invoke", "string", msg)
                            })
                        }
                    },
                ),
            )?;

            globals.set("host", host)?;
            globals.set("__omniPluginId", pid)?;
            ctx.eval::<(), _>(source)?;
            Ok::<(), rquickjs::Error>(())
        })?;
        Ok(Self { runtime, context, call_timeout })
    }

    fn call(&mut self, method: &str, args_json: &str) -> Result<String, String> {
        let started = Instant::now();
        let call_timeout = self.call_timeout;
        let method = method.to_string();
        let args_json = args_json.to_string();
        self.runtime.set_interrupt_handler(Some(Box::new(move || {
            started.elapsed() >= call_timeout
        })));
        let result: Result<String, String> = self.context.with(|ctx| {
            let func: Function = match ctx.globals().get("call") {
                Ok(f) => f,
                Err(_) => {
                    return Err("插件缺少全局函数 call(method, argsJson)".into());
                }
            };
            match func.call::<(String, String), String>((method, args_json)) {
                Ok(s) => Ok(s),
                Err(rquickjs::Error::Exception) => {
                    let value = ctx.catch();
                    let detail = value
                        .as_exception()
                        .and_then(|exc| exc.message())
                        .unwrap_or_else(|| format!("{value:?}"));
                    if started.elapsed() >= call_timeout {
                        Err(format!("执行超时（{}ms 中断）", call_timeout.as_millis()))
                    } else {
                        Err(format!("JS 异常: {detail}"))
                    }
                }
                Err(other) => Err(format!("{other}")),
            }
        });
        self.runtime
            .set_interrupt_handler(None::<Box<dyn FnMut() -> bool + Send>>);
        result
    }
}

pub struct JsInstance {
    inner: Arc<Mutex<JsInstanceInner>>,
}

impl PluginLogicInstance for JsInstance {
    fn call(&self, method: &str, args_json: &str) -> LogicFuture {
        let inner = Arc::clone(&self.inner);
        let method = method.to_string();
        let args_json = args_json.to_string();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let mut guard = inner.lock().unwrap();
                guard.call(&method, &args_json)
            })
            .await
            .map_err(|e: tokio::task::JoinError| PluginError::Invoke(e.to_string()))?
            .map_err(PluginError::Invoke)
        })
    }

    fn shutdown(&mut self) {}
}
