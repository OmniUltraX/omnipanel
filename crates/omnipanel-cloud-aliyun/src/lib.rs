//! 阿里云能力 Driver：HMAC 客户端、资源映射、InvokeGateway 实现。

pub mod client;
pub mod disk;
pub mod dns;
pub mod driver;
pub mod eip;
pub mod invoke;
pub mod kvstore;
pub mod mapping;
pub mod metrics;
pub mod rds;
pub mod registry;
pub mod security_group;
pub mod slb;
pub mod types;

pub use client::{
    AliyunCredentials, CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket,
    CloudSwasInstance,
};
pub use driver::{AliyunCloudDriver, CloudProviderDriver};
pub use invoke::{handle_invoke, is_declared_method};
pub use registry::{driver_for, resolve_plugin_id};
pub use types::{
    is_write_action, CloudAccountSnapshot, CloudAction, CloudActionResult, CloudChildRow,
    CloudLogEntry, CloudLogPage, CloudLogQuery, CloudMetricPoint, CloudMetricQuery, CloudMetricSeries,
    CloudNetworkRule, CloudRegion, CloudRelatedRef, CloudResourceDetail, CloudResourceFilter,
    CloudResourceRow, ACTION_ADD_RECORD, ACTION_ATTACH, ACTION_AUTHORIZE_RULE, ACTION_CREATE_SNAPSHOT,
    ACTION_DELETE_RECORD, ACTION_DETACH, ACTION_MODIFY_BANDWIDTH, ACTION_REBOOT, ACTION_REVOKE_RULE,
    ACTION_START, ACTION_STOP, ACTION_UPDATE_RECORD, CAP_CDN, CAP_CERTS, CAP_COMPUTE, CAP_COMPUTE_LITE,
    CAP_DATABASE, CAP_DATABASE_CACHE, CAP_DNS, CAP_DOMAINS, CAP_LOAD_BALANCER, CAP_NETWORK_EIP,
    CAP_OBJECT_STORAGE, CAP_SECURITY_GROUP, CAP_STORAGE_DISK, PLUGIN_ID_ALIYUN,
};
