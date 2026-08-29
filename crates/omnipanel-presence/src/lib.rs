//! 操作系统在场验证 + 短命 token（action + target 绑定，一次性消费）。

mod actions;
mod sql;
mod token;
mod verifier;

pub use actions::{
    ACTION_DB_DROP_DATABASE, ACTION_DB_DROP_TABLE, ACTION_DB_RESTART, TYPED_RESTART,
    drop_database_target, drop_table_objects_target, drop_table_target, expected_typed,
    restart_target,
};
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
