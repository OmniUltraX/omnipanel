use tokio::process::Command;

use crate::types::McpStdioTransport;

/// Windows：子进程不弹出控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 构建 MCP stdio 子进程命令（Windows 下隐藏控制台窗口）。
pub fn stdio_command(config: &McpStdioTransport) -> Command {
    let mut command = Command::new(&config.command);
    command.args(&config.args);
    if let Some(cwd) = &config.cwd {
        if !cwd.trim().is_empty() {
            command.current_dir(cwd);
        }
    }
    for (key, value) in &config.env {
        command.env(key, value);
    }
    #[cfg(windows)]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}
