//! 腾讯云能力 Driver：TC3 客户端、资源映射、InvokeGateway 实现。

pub mod client;
pub mod driver;
pub mod invoke;
pub mod mapping;

pub use driver::TencentCloudDriver;
pub use invoke::{handle_invoke, is_declared_method};

pub const PLUGIN_ID_TENCENT: &str = "omni.cloud.tencent";
pub const DEFAULT_REGION: &str = "ap-guangzhou";
