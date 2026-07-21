//! 在 Docker 连接对应的宿主机上一次性执行 `docker …` CLI。

use std::process::Stdio;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{SshSession, StreamChunk};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::mpsc;

use crate::model::DockerHostCliResult;

/// 本地镜像已存在时 `docker run -d` 应秒级返回；保留余量给慢盘 / 首次创建网络。
const RUN_TIMEOUT_SECS: u64 = 120;

/// 仅允许以 `docker` 开头的命令（可多行，首个非空 token 须为 docker）。
pub fn validate_docker_cli_command(command: &str) -> OmniResult<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "命令不能为空"));
    }
    let first = trimmed
        .lines()
        .find_map(|line| {
            let t = line.trim();
            if t.is_empty() || t.starts_with('#') {
                None
            } else {
                t.split_whitespace().next()
            }
        })
        .unwrap_or("");
    if !first.eq_ignore_ascii_case("docker") {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "仅允许执行以 docker 开头的命令",
        ));
    }
    Ok(trimmed.to_string())
}

/// 简易 shell 分词（支持双引号 / 单引号），与前端 `tokenizeDockerCommand` 对齐。
pub fn tokenize_docker_command(command: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in command.chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                current.push(ch);
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch.is_whitespace() {
            if !current.is_empty() {
                tokens.push(std::mem::take(&mut current));
            }
            continue;
        }
        current.push(ch);
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

fn command_needs_shell(command: &str) -> bool {
    command.chars().any(|c| matches!(c, '|' | '&' | '>' | '<' | ';' | '\n'))
        || command.contains("&&")
        || command.contains("||")
}

fn append_line(buf: &mut String, line: &str) {
    if line.is_empty() {
        return;
    }
    if !buf.is_empty() && !buf.ends_with('\n') {
        buf.push('\n');
    }
    buf.push_str(line);
    if !line.ends_with('\n') {
        buf.push('\n');
    }
}

fn configure_no_window(cmd: &mut tokio::process::Command) {
    // Windows GUI 宿主进程必须隐藏控制台窗口，否则 docker.exe 可能一直挂起
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

/// 本机执行 docker CLI（本地 Engine），按行回调输出。
///
/// 优先直接 `docker <args>`（stdin 置空），避免 Tauri GUI 下 `cmd /C` 子进程
/// 在 daemon 已创建容器后仍不退出、拖到超时。
pub async fn run_local_docker_cli(
    command: &str,
    mut on_line: impl FnMut(String) + Send,
) -> OmniResult<DockerHostCliResult> {
    let command = validate_docker_cli_command(command)?;
    let mut cmd = if command_needs_shell(&command) {
        #[cfg(windows)]
        {
            let mut c = tokio::process::Command::new("cmd");
            c.args(["/C", &command]);
            c
        }
        #[cfg(not(windows))]
        {
            let mut c = tokio::process::Command::new("sh");
            c.args(["-lc", &command]);
            c
        }
    } else {
        let tokens = tokenize_docker_command(&command);
        if tokens.is_empty() || !tokens[0].eq_ignore_ascii_case("docker") {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "仅允许执行以 docker 开头的命令",
            ));
        }
        let mut c = tokio::process::Command::new("docker");
        if tokens.len() > 1 {
            c.args(&tokens[1..]);
        }
        c
    };

    // stdin 必须 null：GUI 进程继承的 stdin 会导致 docker CLI 卡住不退出
    //（本机实测：daemon 已创建容器，但 OmniPanel 仍等到超时）。
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    configure_no_window(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        OmniError::new(ErrorCode::Internal, "启动 docker 命令失败").with_cause(e.to_string())
    })?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (tx, mut rx) = mpsc::unbounded_channel::<(bool, String)>();

    let stdout_task = tokio::spawn({
        let tx = tx.clone();
        async move {
            let Some(out) = stdout else { return };
            let mut lines = BufReader::new(out).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send((false, line));
            }
        }
    });
    let stderr_task = tokio::spawn({
        let tx = tx.clone();
        async move {
            let Some(err) = stderr else { return };
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ = tx.send((true, line));
            }
        }
    });
    drop(tx);

    let pump = async {
        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();
        while let Some((is_err, line)) = rx.recv().await {
            on_line(line.clone());
            if is_err {
                append_line(&mut stderr_buf, &line);
            } else {
                append_line(&mut stdout_buf, &line);
            }
        }
        let status = child.wait().await.map_err(|e| {
            OmniError::new(ErrorCode::Internal, "等待 docker 命令结束失败").with_cause(e.to_string())
        })?;
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        Ok::<_, OmniError>(DockerHostCliResult {
            stdout: stdout_buf,
            stderr: stderr_buf,
            exit_code: status.code().unwrap_or(-1),
        })
    };

    tokio::time::timeout(std::time::Duration::from_secs(RUN_TIMEOUT_SECS), pump)
        .await
        .map_err(|_| {
            let _ = child.start_kill();
            OmniError::new(
                ErrorCode::Timeout,
                format!(
                    "执行 docker 命令超时（{RUN_TIMEOUT_SECS}s）。请检查 Docker 是否响应；容器可能已创建成功，可到「容器」页确认"
                ),
            )
        })?
}

/// SSH 宿主机执行 docker CLI（流式输出）。
pub async fn run_ssh_docker_cli(
    session: &SshSession,
    command: &str,
    mut on_line: impl FnMut(String) + Send,
) -> OmniResult<DockerHostCliResult> {
    let command = validate_docker_cli_command(command)?;
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamChunk>();
    let mut handle = session.exec_stream(&command, tx).await?;

    let collect = async {
        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();
        let mut exit_code: i32 = -1;
        while let Some(chunk) = rx.recv().await {
            match chunk {
                StreamChunk::Stdout(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.split_inclusive('\n') {
                        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
                        if !trimmed.is_empty() {
                            on_line(trimmed.to_string());
                        }
                    }
                    stdout_buf.push_str(&text);
                }
                StreamChunk::Stderr(bytes) => {
                    let text = String::from_utf8_lossy(&bytes);
                    for line in text.split_inclusive('\n') {
                        let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
                        if !trimmed.is_empty() {
                            on_line(trimmed.to_string());
                        }
                    }
                    stderr_buf.push_str(&text);
                }
                StreamChunk::Exit(code) => {
                    exit_code = code;
                }
                StreamChunk::Closed => break,
            }
        }
        Ok::<_, OmniError>(DockerHostCliResult {
            stdout: stdout_buf,
            stderr: stderr_buf,
            exit_code,
        })
    };

    match tokio::time::timeout(std::time::Duration::from_secs(RUN_TIMEOUT_SECS), collect).await {
        Ok(result) => {
            handle.stop().await;
            result
        }
        Err(_) => {
            handle.stop().await;
            Err(OmniError::new(
                ErrorCode::Timeout,
                format!(
                    "远端执行 docker 命令超时（{RUN_TIMEOUT_SECS}s）。请检查 SSH / Docker；容器可能已创建成功，可到「容器」页确认"
                ),
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_docker() {
        assert!(validate_docker_cli_command("rm -rf /").is_err());
        assert!(validate_docker_cli_command("").is_err());
    }

    #[test]
    fn accepts_docker_run() {
        let cmd = validate_docker_cli_command("docker run -d nginx").unwrap();
        assert_eq!(cmd, "docker run -d nginx");
    }

    #[test]
    fn accepts_multiline_with_comment() {
        let cmd = validate_docker_cli_command(
            "# pull then run\ndocker run -d --name demo nginx:latest\n",
        )
        .unwrap();
        assert!(cmd.contains("docker run"));
    }

    #[test]
    fn tokenizes_quoted_args() {
        let tokens = tokenize_docker_command(r#"docker run -e "A=b c" nginx"#);
        assert_eq!(tokens, vec!["docker", "run", "-e", "A=b c", "nginx"]);
    }

    #[test]
    fn detects_shell_metacharacters() {
        assert!(command_needs_shell("docker run -d nginx && echo ok"));
        assert!(!command_needs_shell(
            "docker run --name some-redis -d redis redis-server --save 60 1"
        ));
    }
}
