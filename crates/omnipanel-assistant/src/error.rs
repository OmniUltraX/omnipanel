use omnipanel_error::{ErrorCode, OmniError};

/// Assistant 模块业务错误分类（映射到 OmniError.code + message）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssistantErrorKind {
    Auth,
    Sts,
    Collect,
    Upload,
    Encode,
}

impl AssistantErrorKind {
    pub fn to_error_code(self) -> ErrorCode {
        match self {
            Self::Auth => ErrorCode::Auth,
            Self::Sts => ErrorCode::Auth,
            Self::Collect => ErrorCode::Internal,
            Self::Upload => ErrorCode::Connection,
            Self::Encode => ErrorCode::Internal,
        }
    }
}

pub fn map_assistant_error(kind: AssistantErrorKind, message: impl Into<String>) -> OmniError {
    OmniError::new(kind.to_error_code(), message)
}

pub fn map_assistant_error_with_cause(
    kind: AssistantErrorKind,
    message: impl Into<String>,
    cause: impl Into<String>,
) -> OmniError {
    map_assistant_error(kind, message).with_cause(cause)
}
