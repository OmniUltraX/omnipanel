use omnipanel_error::{ErrorCode, OmniError};
use thiserror::Error;

use crate::permission::PluginPermission;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("{0}")]
    InvalidManifest(String),
    #[error("未知插件: {0}")]
    NotFound(String),
    #[error("未知插件 kind: {0}")]
    UnknownKind(String),
    #[error("插件 {plugin_id} 缺少权限 {permission}")]
    PermissionDenied {
        plugin_id: String,
        permission: &'static str,
    },
    #[error("插件 {plugin_id} 未声明方法 {method}")]
    UnknownMethod { plugin_id: String, method: String },
    #[error("内置数据库引擎不可关闭: {0}")]
    AlwaysOn(String),
    #[error("插件 {0} 在当前平台不可用")]
    UnsupportedPlatform(String),
    #[error("{0}")]
    Invoke(String),
}

impl PluginError {
    pub fn permission_denied(plugin_id: impl Into<String>, permission: PluginPermission) -> Self {
        Self::PermissionDenied {
            plugin_id: plugin_id.into(),
            permission: permission.as_str(),
        }
    }
}

impl From<PluginError> for OmniError {
    fn from(err: PluginError) -> Self {
        let code = match &err {
            PluginError::NotFound(_) => ErrorCode::NotFound,
            PluginError::PermissionDenied { .. } => ErrorCode::Permission,
            PluginError::UnknownKind(_)
            | PluginError::InvalidManifest(_)
            | PluginError::UnknownMethod { .. }
            | PluginError::UnsupportedPlatform(_)
            | PluginError::AlwaysOn(_) => ErrorCode::InvalidInput,
            PluginError::Invoke(_) => ErrorCode::Internal,
        };
        OmniError::new(code, err.to_string())
    }
}
