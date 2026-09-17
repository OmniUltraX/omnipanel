//! 兼容 re-export：类型经 `omnipanel-cloud`（共享 DTO，无原生 Driver IO）。

pub use omnipanel_cloud::{
    AliyunCredentials, CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket,
    CloudSwasInstance,
};
