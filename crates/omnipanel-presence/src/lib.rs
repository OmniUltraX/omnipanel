//! 操作系统在场验证 + 短命 token（action + target 绑定，一次性消费）。

mod actions;
mod critical;
mod sql;
mod token;
mod verifier;

pub use actions::{
    ACTION_AI_TOOL, ACTION_CLOUD_LIFECYCLE, ACTION_DB_ALTER_DROP, ACTION_DB_DROP_DATABASE,
    ACTION_DB_DROP_TABLE, ACTION_DB_DROP_USER, ACTION_DB_FLUSH, ACTION_DB_KILL, ACTION_DB_RESTART,
    ACTION_DB_TRUNCATE, ACTION_DOCKER_COMPOSE_DOWN, ACTION_DOCKER_CONTAINER_REMOVE,
    ACTION_DOCKER_ENGINE_RESTART, ACTION_DOCKER_IMAGE_REMOVE, ACTION_DOCKER_NETWORK_REMOVE,
    ACTION_DOCKER_VOLUME_REMOVE, ACTION_FILES_DELETE, ACTION_PANEL_DELETE, ACTION_PLUGIN_HOST,
    ACTION_SSH_EXEC, ACTION_SSH_KILL, TYPED_RESTART, drop_database_target,
    drop_table_objects_target, drop_table_target, expected_typed, is_known_action, pipe_target,
    restart_target,
};
pub use critical::{panel_request_is_destructive, ssh_command_is_critical};
pub use sql::{DangerousSql, classify_sql, ensure_sql_presence};
pub use token::{PresenceTokenIssued, TokenStore, now_unix_ms};
pub use verifier::{
    PresenceCapability, PresenceKind, PresenceVerifier, UnavailableVerifier, platform_verifier,
};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};

/// 签发失败 / 校验失败的统一错误。
pub fn presence_denied(message: impl Into<String>) -> OmniError {
    OmniError::new(ErrorCode::Permission, message)
}

/// 校验 token 后执行（供 command 复用）。
pub fn require_grant(store: &TokenStore, token: Option<&str>, action: &str, target: &str) -> OmniResult<()> {
    let Some(token) = token.map(str::trim).filter(|s| !s.is_empty()) else {
        return Err(presence_denied("该操作需要在场验证"));
    };
    store.consume(token, action, target)
}
