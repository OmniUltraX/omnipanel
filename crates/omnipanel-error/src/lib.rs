//! 统一错误体系：所有 crate 与 Tauri 命令共享的领域错误类型。
//!
//! 设计目标：
//! - 面向前端可读：包含错误码 `code`、可读 `message`、可选底层原因 `cause`。
//! - 跨 crate 复用：各领域 crate 用 `thiserror` 定义自有错误，再 `From` 转换为 [`OmniError`]。
//! - 贯通前端类型：派生 `serde::Serialize` 与 `specta::Type`，由 tauri-specta 生成 TS 类型。

use serde::Serialize;
use specta::Type;

/// 错误分类码。前端按 `code` 决定提示文案与重试策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    /// 未归类的内部错误
    Internal,
    /// 资源不存在（连接、会话、表等）
    NotFound,
    /// 入参非法
    InvalidInput,
    /// 连接失败（网络、拒绝、不可达）
    Connection,
    /// 认证失败（密码/密钥/Token 错误）
    Auth,
    /// 权限不足
    Permission,
    /// 操作超时
    Timeout,
    /// 数据库错误
    Database,
    /// SSH 相关错误
    Ssh,
    /// 终端/PTY 错误
    Terminal,
    /// 本地存储 / 凭据库错误
    Storage,
    /// IO 错误
    Io,
}

/// 统一错误结构。Tauri 命令统一返回 `Result<T, OmniError>`。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OmniError {
    /// 错误分类码
    pub code: ErrorCode,
    /// 面向用户的可读信息
    pub message: String,
    /// 可选的底层原因（调试用，可能含技术细节）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<String>,
}

impl OmniError {
    /// 构造一个带错误码与信息的错误。
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            cause: None,
        }
    }

    /// 附加底层原因。
    pub fn with_cause(mut self, cause: impl Into<String>) -> Self {
        self.cause = Some(cause.into());
        self
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Internal, message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::NotFound, message)
    }

    pub fn invalid_input(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidInput, message)
    }

    pub fn connection(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Connection, message)
    }

    pub fn auth(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Auth, message)
    }

    pub fn database(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Database, message)
    }

    pub fn ssh(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Ssh, message)
    }

    pub fn terminal(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Terminal, message)
    }

    pub fn storage(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::Storage, message)
    }

    /// 面向用户/前端的完整错误文案（含底层 cause）。
    pub fn user_message(&self) -> String {
        match &self.cause {
            Some(cause) => format!("{}: {cause}", self.message),
            None => self.message.clone(),
        }
    }
}

impl std::fmt::Display for OmniError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "[{:?}] {}", self.code, self.message)?;
        if let Some(cause) = &self.cause {
            write!(f, ": {cause}")?;
        }
        Ok(())
    }
}

impl std::error::Error for OmniError {}

impl From<anyhow::Error> for OmniError {
    fn from(err: anyhow::Error) -> Self {
        OmniError::internal(err.to_string())
    }
}

impl From<std::io::Error> for OmniError {
    fn from(err: std::io::Error) -> Self {
        OmniError::new(ErrorCode::Io, err.to_string())
    }
}

/// 过渡期便利：允许旧代码用字符串错误平滑迁移（归类为 Internal）。
impl From<String> for OmniError {
    fn from(message: String) -> Self {
        OmniError::internal(message)
    }
}

impl From<&str> for OmniError {
    fn from(message: &str) -> Self {
        OmniError::internal(message.to_string())
    }
}

/// 命令与服务统一返回类型。
pub type OmniResult<T> = Result<T, OmniError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_error_with_code_and_message() {
        let err = OmniError::auth("invalid password");
        assert_eq!(err.code, ErrorCode::Auth);
        assert_eq!(err.message, "invalid password");
        assert!(err.cause.is_none());
    }

    #[test]
    fn attaches_cause() {
        let err = OmniError::connection("connect failed").with_cause("timeout after 5s");
        assert_eq!(err.cause.as_deref(), Some("timeout after 5s"));
    }

    #[test]
    fn converts_from_string() {
        let err: OmniError = "boom".to_string().into();
        assert_eq!(err.code, ErrorCode::Internal);
        assert_eq!(err.message, "boom");
    }

    #[test]
    fn display_includes_code_and_message() {
        let err = OmniError::not_found("no such session");
        assert_eq!(format!("{err}"), "[NotFound] no such session");
    }

    #[test]
    fn display_includes_cause_when_present() {
        let err = OmniError::connection("MySQL 连接失败").with_cause("access denied");
        assert_eq!(format!("{err}"), "[Connection] MySQL 连接失败: access denied");
    }

    #[test]
    fn user_message_includes_cause() {
        let err = OmniError::connection("MySQL 连接失败").with_cause("access denied");
        assert_eq!(err.user_message(), "MySQL 连接失败: access denied");
    }

    #[test]
    fn serializes_to_camel_case_json() {
        let err = OmniError::database("query failed").with_cause("syntax error");
        let json = serde_json::to_string(&err).unwrap();
        assert!(json.contains("\"code\":\"database\""));
        assert!(json.contains("\"message\":\"query failed\""));
        assert!(json.contains("\"cause\":\"syntax error\""));
    }
}
