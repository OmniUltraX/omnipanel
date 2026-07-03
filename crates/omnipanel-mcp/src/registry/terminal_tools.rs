//! 终端 MCP 工具 — OmniMCP 外部路径通过本地 shell 执行（非活动 PTY tab）。

use std::sync::{Arc, Mutex};

use omnipanel_exec::{ActionRequest, Executor, ProgressStream, ShellExecutor};
use serde_json::Value;

pub async fn run_terminal_command(args: Value) -> Result<String, String> {
    let command = args
        .get("command")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "缺少必填参数: command".to_string())?;

    let stdout = Arc::new(Mutex::new(String::new()));
    let stderr = Arc::new(Mutex::new(String::new()));
    let stdout_c = stdout.clone();
    let stderr_c = stderr.clone();

    let sink: omnipanel_exec::ProgressSink = Arc::new(move |p| {
        match p.stream {
            ProgressStream::Stdout => {
                if let Ok(mut buf) = stdout_c.lock() {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&p.chunk);
                }
            }
            ProgressStream::Stderr => {
                if let Ok(mut buf) = stderr_c.lock() {
                    if !buf.is_empty() {
                        buf.push('\n');
                    }
                    buf.push_str(&p.chunk);
                }
            }
            ProgressStream::Status => {}
        }
    });

    let action = ActionRequest {
        id: format!("omnimcp_{}", uuid_simple()),
        kind: "terminal".to_string(),
        command: Some(command.to_string()),
        resource_id: None,
        env_tag: None,
        cwd: None,
    };

    let exit_code = ShellExecutor
        .execute(&action, &sink)
        .await
        .map_err(|e| e.user_message())?;

    let out = stdout.lock().map(|g| g.clone()).unwrap_or_default();
    let err = stderr.lock().map(|g| g.clone()).unwrap_or_default();
    let output = if !out.is_empty() { out.clone() } else { err.clone() };
    Ok(serde_json::to_string(&serde_json::json!({
        "command": command,
        "exitCode": exit_code,
        "output": output,
        "stderr": err,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}
