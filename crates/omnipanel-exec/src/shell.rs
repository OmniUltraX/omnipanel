use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

use crate::{ActionProgress, ActionRequest, Executor, ProgressSink, ProgressStream};

/// 本地 shell 执行器：用系统 shell 运行命令，流式回流 stdout/stderr，返回退出码。
/// 适用于 terminal/docker/server 等本地命令型动作。
pub struct ShellExecutor;

#[async_trait::async_trait]
impl Executor for ShellExecutor {
    async fn execute(&self, action: &ActionRequest, sink: &ProgressSink) -> OmniResult<i32> {
        let command = action
            .command
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "动作缺少可执行命令"))?;

        let mut cmd = build_command(command);
        if let Some(cwd) = action.cwd.as_deref().filter(|c| !c.is_empty()) {
            cmd.current_dir(cwd);
        }
        cmd.stdout(std::process::Stdio::piped());
        cmd.stderr(std::process::Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| OmniError::new(ErrorCode::Io, "启动进程失败").with_cause(e.to_string()))?;

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        let id = action.id.clone();
        let sink_out = sink.clone();
        let out_task = tokio::spawn(async move {
            if let Some(stdout) = stdout {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    sink_out(ActionProgress::output(&id, ProgressStream::Stdout, line));
                }
            }
        });

        let id_err = action.id.clone();
        let sink_err = sink.clone();
        let err_task = tokio::spawn(async move {
            if let Some(stderr) = stderr {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    sink_err(ActionProgress::output(
                        &id_err,
                        ProgressStream::Stderr,
                        line,
                    ));
                }
            }
        });

        let status = child.wait().await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "等待进程结束失败").with_cause(e.to_string())
        })?;
        let _ = out_task.await;
        let _ = err_task.await;

        Ok(status.code().unwrap_or(-1))
    }
}

#[cfg(windows)]
fn build_command(command: &str) -> Command {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = Command::new("cmd");
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.arg("/C").arg(command);
    cmd
}

#[cfg(not(windows))]
fn build_command(command: &str) -> Command {
    let mut cmd = Command::new("sh");
    cmd.arg("-c").arg(command);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn collector() -> (ProgressSink, Arc<Mutex<Vec<ActionProgress>>>) {
        let store = Arc::new(Mutex::new(Vec::new()));
        let store2 = store.clone();
        let sink: ProgressSink = Arc::new(move |p| store2.lock().unwrap().push(p));
        (sink, store)
    }

    fn req(command: &str) -> ActionRequest {
        ActionRequest {
            id: "t1".into(),
            kind: "terminal".into(),
            command: Some(command.into()),
            resource_id: None,
            env_tag: None,
            cwd: None,
        }
    }

    #[tokio::test]
    async fn runs_echo_and_captures_stdout() {
        let (sink, store) = collector();
        let code = ShellExecutor
            .execute(&req("echo omnipanel"), &sink)
            .await
            .unwrap();
        assert_eq!(code, 0);
        let events = store.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|e| e.stream == ProgressStream::Stdout && e.chunk.contains("omnipanel"))
        );
    }

    #[tokio::test]
    async fn missing_command_errors() {
        let (sink, _) = collector();
        let mut r = req("");
        r.command = None;
        assert!(ShellExecutor.execute(&r, &sink).await.is_err());
    }

    #[tokio::test]
    async fn nonzero_exit_code_propagates() {
        let (sink, _) = collector();
        // exit 3 在 cmd 与 sh 下均可用
        let code = ShellExecutor.execute(&req("exit 3"), &sink).await.unwrap();
        assert_eq!(code, 3);
    }
}
