//! 客户端 → 助手端：脱敏元数据快照采集、STS、OSS 上传。

mod collect;
mod error;
mod notify;
mod oss;
mod push;
mod sanitize;
mod sts;
mod types;

pub use collect::{
    default_collectors, assemble_modules, CollectContext, MetadataCollector, ModuleCollectResult,
};
pub use error::{AssistantErrorKind, map_assistant_error};
pub use notify::{notify_snapshot_uploaded, SnapshotNotifyRequest};
pub use oss::{upload_snapshot_json, OssUploadResult};
pub use push::{push_snapshot, PushOptions, PushSnapshotResult};
pub use sanitize::{
    sanitize_connection_meta, sanitize_db_connection_meta, sanitize_http_request_meta,
    sanitize_knowledge_meta, sanitize_task_meta, strip_secret_keys,
};
pub use sts::{fetch_oss_sts, AuthContext, OssStsCredentials};
pub use types::*;
