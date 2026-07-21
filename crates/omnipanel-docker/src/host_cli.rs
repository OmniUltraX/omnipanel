//! 在 Docker 连接对应的宿主机上一次性执行 `docker …` CLI。

use std::process::Stdio;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;

use crate::model::DockerHostCliResult;

const RUN_TIMEOUT_SECS: u64 = 180;

/// 仅允许以 `docker` 开头的命令（可多行，首个非空 token 须为 docker）。
pub fn validate_docker_cli_command(command: &str) -> OmniResult<String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "命令不能为空",
        ));
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

/// 本机执行 docker CLI（本地 Engine）。
pub async fn run_local_docker_cli(command: &str) -> OmniResult<DockerHostCliResult> {
    let command = validate_docker_cli_command(command)?;
    let mut cmd = {
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
    };
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = tokio::time::timeout(
        std::time::Duration::from_secs(RUN_TIMEOUT_SECS),
        cmd.output(),
    )
    .await
    .map_err(|_| {
        OmniError::new(
            ErrorCode::Timeout,
            format!("执行 docker 命令超时（{RUN_TIMEOUT_SECS}s）"),
        )
    })?
    .map_err(|e| {
        OmniError::new(ErrorCode::Internal, "执行 docker 命令失败").with_cause(e.to_string())
    })?;

    Ok(DockerHostCliResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        exit_code: output.status.code().unwrap_or(-1),
    })
}

/// SSH 宿主机执行 docker CLI。
pub async fn run_ssh_docker_cli(
    session: &SshSession,
    command: &str,
) -> OmniResult<DockerHostCliResult> {
    let command = validate_docker_cli_command(command)?;
    let out = tokio::time::timeout(
        std::time::Duration::from_secs(RUN_TIMEOUT_SECS),
        session.exec_capture(&command),
    )
    .await
    .map_err(|_| {
        OmniError::new(
            ErrorCode::Timeout,
            format!("远端执行 docker 命令超时（{RUN_TIMEOUT_SECS}s）"),
        )
    })??;

    Ok(DockerHostCliResult {
        stdout: out.stdout,
        stderr: out.stderr,
        exit_code: out.exit_code,
    })
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
}
