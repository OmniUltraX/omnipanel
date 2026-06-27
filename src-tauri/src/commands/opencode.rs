use crate::commands::agents;

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeInstallStatus {
    /// 是否检测到 OpenCode CLI。
    pub installed: bool,
    /// 解析到的可执行文件路径。
    pub executable_path: Option<String>,
    /// `opencode --version` 输出（若可用）。
    pub version: Option<String>,
}

/// 检测本机是否已安装 OpenCode CLI。
#[tauri::command]
#[specta::specta]
pub async fn detect_opencode_install() -> Result<OpenCodeInstallStatus, omnipanel_error::OmniError> {
    Ok(agents::detect_opencode_for_legacy())
}
