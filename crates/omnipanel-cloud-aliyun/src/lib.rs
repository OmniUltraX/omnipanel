//! 阿里云能力 Driver：HMAC 客户端、资源映射、InvokeGateway 实现。

pub mod client;
pub mod driver;
pub mod invoke;
pub mod mapping;
pub mod registry;
pub mod types;

pub use client::{
    AliyunCredentials, CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket,
    CloudSwasInstance,
};
pub use driver::{AliyunCloudDriver, CloudProviderDriver};
pub use invoke::{handle_invoke, is_declared_method};
pub use registry::{driver_for, resolve_plugin_id};
pub use types::{
    is_write_action, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudRegion,
    CloudResourceDetail, CloudResourceFilter, CloudResourceRow, ACTION_REBOOT, ACTION_START,
    ACTION_STOP, CAP_CDN, CAP_CERTS, CAP_COMPUTE, CAP_COMPUTE_LITE, CAP_DNS, CAP_DOMAINS,
    CAP_OBJECT_STORAGE, PLUGIN_ID_ALIYUN,
};
