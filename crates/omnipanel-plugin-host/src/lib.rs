//! 插件宿主桥：权限闸、网络、文件禁锢、vault、审计。
//! 桌面与 Web 只注入确认器与 SSH 回调。

mod bridge;
mod runtime;
mod ssh;

pub use bridge::{PluginBridge, block_on_detached};
pub use runtime::{activate_current, build_plugin_registry, empty_gateway, make_logic_executor};
pub use ssh::{DisabledSsh, InjectedConnectionGuard, SshExec, enter_injected_connection};
