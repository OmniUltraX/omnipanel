use serde::{Deserialize, Serialize};
use specta::Type;

use super::ShellKind;

/// Configuration for a terminal instance.
#[derive(Debug, Clone)]
pub struct TerminalConfig {
    /// Number of columns.
    pub cols: u16,
    /// Number of rows.
    pub rows: u16,
    /// Scrollback buffer size (lines).
    pub scrollback_lines: u32,
    /// Working directory.
    pub working_dir: Option<String>,
    /// Environment variables to set.
    pub env_vars: Vec<(String, String)>,
    /// 指定启动的 shell。None 时走 `detect_shell()` 自动检测。
    pub shell: Option<ShellSpec>,
}

/// 调用方显式指定的 shell 规格。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    /// shell 种类。
    pub kind: ShellKind,
    /// 可执行文件路径（如 "C:\\Program Files\\PowerShell\\7\\pwsh.exe"）。
    /// None 时按 kind 取默认程序名（pwsh / powershell / cmd.exe / wsl.exe）。
    pub path: Option<String>,
    /// WSL 发行版名称（仅 Wsl kind 生效），如 "Ubuntu-22.04"。None 时用默认发行版。
    pub wsl_distro: Option<String>,
}

impl Default for TerminalConfig {
    fn default() -> Self {
        Self {
            cols: 120,
            rows: 40,
            scrollback_lines: 10_000,
            working_dir: None,
            env_vars: Vec::new(),
            shell: None,
        }
    }
}
