//! 客户端 → 助手端：脱敏元数据快照采集、STS、OSS 上传。
//! 另含客户端 ↔ 客户端（同账号）同步原语（`client_sync`），与助手快照路径隔离。

mod collect;
mod chat;
mod client_sync;
mod error;
mod notify;
mod oss;
mod push;
mod sanitize;
mod sts;
mod team_sync;
mod types;

pub use chat::{
    chat_index_from_notify_json, extract_inbound_message_text, fetch_chat_latest,
    parse_inbound_chat_message, set_model_from_notify_json, ChatLatestIndex, ChatSetModelNotify,
    InboundAskUserAnswer, InboundChatContextItem, InboundChatMessage,
};
pub use client_sync::{
    device_conversations_latest_object_key, device_modules_latest_object_key,
    device_sync_latest_object_key, pull_conversations_json, pull_modules_json,
    push_conversations_json, push_modules_json, validate_conversations_bundle_json,
    validate_modules_bundle_json, validate_sync_bundle_json,
    CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION, CLIENT_SYNC_SCHEMA_VERSION,
};
pub use collect::{
    default_collectors, assemble_modules, CollectContext, MetadataCollector, ModuleCollectResult,
};
pub use error::{AssistantErrorKind, map_assistant_error};
pub use notify::{notify_snapshot_uploaded, SnapshotNotifyRequest};
pub use oss::{
    get_object_bytes, get_object_bytes_optional, strip_bucket_prefix, upload_object_bytes,
    upload_snapshot_json, OssUploadResult,
};
pub use push::{push_snapshot, PushOptions, PushSnapshotResult};
pub use sanitize::{
    sanitize_ai_model_meta, sanitize_assistant_conversation_meta, sanitize_connection_meta,
    sanitize_db_connection_meta, sanitize_http_request_meta, sanitize_knowledge_meta,
    sanitize_task_meta, sanitize_terminal_session_meta, strip_secret_keys,
};
pub use sts::{fetch_oss_sts, AuthContext, OssStsCredentials};
pub use team_sync::{
    fetch_team_oss_sts, load_team_share_index, notify_team_share_created, parse_team_share_index,
    pull_team_sync_json, push_team_sync_json, save_team_share_index, team_share_item_key,
    validate_team_share_bundle_json, TeamShareIndex, TeamShareIndexItem, TEAM_SHARE_INDEX_KEY,
    TEAM_SYNC_SCHEMA_VERSION,
};
pub use types::*;
