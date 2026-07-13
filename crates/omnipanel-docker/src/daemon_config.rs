//! Docker daemon.json 读写与 Docker 服务重启。

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;

use crate::model::DockerDaemonConfigFile;

const LINUX_DAEMON_PATH: &str = "/etc/docker/daemon.json";

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn default_daemon_json() -> String {
    "{}\n".to_string()
}

/// 本机 daemon.json 候选路径。
pub fn local_daemon_config_path() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            let user_path = PathBuf::from(home).join(".docker").join("daemon.json");
            if user_path.exists() {
                return user_path;
            }
        }
        if let Ok(program_data) = std::env::var("ProgramData") {
            return PathBuf::from(program_data)
                .join("docker")
                .join("config")
                .join("daemon.json");
        }
        PathBuf::from("daemon.json")
    }
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home).join(".docker").join("daemon.json");
        }
        PathBuf::from(".docker/daemon.json")
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        PathBuf::from(LINUX_DAEMON_PATH)
    }
}

async fn read_local_text(path: &Path) -> OmniResult<(String, bool)> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => Ok((content, true)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok((default_daemon_json(), false))
        }
        Err(error) => Err(
            OmniError::new(ErrorCode::Internal, "读取 Docker 配置文件失败")
                .with_cause(format!("{}: {error}", path.display())),
        ),
    }
}

async fn write_local_text(path: &Path, content: &str) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|e| {
            OmniError::new(ErrorCode::Internal, "创建 Docker 配置目录失败")
                .with_cause(format!("{}: {e}", parent.display()))
        })?;
    }
    tokio::fs::write(path, content).await.map_err(|e| {
        OmniError::new(ErrorCode::Internal, "写入 Docker 配置文件失败")
            .with_cause(format!("{}: {e}", path.display()))
    })
}

pub async fn read_local_daemon_config() -> OmniResult<DockerDaemonConfigFile> {
    let path = local_daemon_config_path();
    let (content, found) = read_local_text(&path).await?;
    Ok(DockerDaemonConfigFile {
        content: if found && content.trim().is_empty() {
            default_daemon_json()
        } else {
            content
        },
        path: path.to_string_lossy().into_owned(),
        editable: true,
    })
}

pub async fn write_local_daemon_config(content: &str) -> OmniResult<()> {
    let path = local_daemon_config_path();
    write_local_text(&path, content).await
}

async fn read_remote_text(session: &SshSession, path: &str) -> OmniResult<(String, bool)> {
    let cmd = format!("cat {}", shell_quote(path));
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        if stderr.contains("No such file") || stderr.contains("not found") {
            return Ok((default_daemon_json(), false));
        }
        return Err(
            OmniError::new(ErrorCode::Internal, "读取 Docker 配置文件失败")
                .with_cause(stderr.to_string()),
        );
    }
    Ok((out.stdout, true))
}

async fn write_remote_text_privileged(session: &SshSession, path: &str, content: &str) -> OmniResult<()> {
    let parent = Path::new(path)
        .parent()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/etc/docker".to_string());
    let encoded = STANDARD.encode(content.as_bytes());
    let cmd = format!(
        "mkdir -p {} 2>/dev/null; printf '%s' '{}' | base64 -d | tee {} > /dev/null 2>&1 || (sudo mkdir -p {} && printf '%s' '{}' | base64 -d | sudo tee {} > /dev/null)",
        shell_quote(&parent),
        encoded,
        shell_quote(path),
        shell_quote(&parent),
        encoded,
        shell_quote(path),
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        return Err(
            OmniError::new(ErrorCode::Internal, "写入 Docker 配置文件失败")
                .with_cause(out.stderr.trim().to_string()),
        );
    }
    Ok(())
}

pub async fn read_ssh_daemon_config(session: &SshSession) -> OmniResult<DockerDaemonConfigFile> {
    let candidates = [LINUX_DAEMON_PATH, "/usr/local/etc/docker/daemon.json"];
    for path in candidates {
        let (content, found) = read_remote_text(session, path).await?;
        if found {
            return Ok(DockerDaemonConfigFile {
                content: if content.trim().is_empty() {
                    default_daemon_json()
                } else {
                    content
                },
                path: path.to_string(),
                editable: true,
            });
        }
    }
    Ok(DockerDaemonConfigFile {
        content: default_daemon_json(),
        path: LINUX_DAEMON_PATH.to_string(),
        editable: true,
    })
}

pub async fn write_ssh_daemon_config(session: &SshSession, content: &str) -> OmniResult<()> {
    write_remote_text_privileged(session, LINUX_DAEMON_PATH, content).await
}

pub async fn restart_ssh_docker_daemon(session: &SshSession) -> OmniResult<()> {
    let cmd = "systemctl restart docker 2>/dev/null || service docker restart 2>/dev/null || sudo systemctl restart docker 2>/dev/null || sudo service docker restart";
    let out = session.exec_capture(cmd).await?;
    if out.exit_code != 0 {
        return Err(
            OmniError::new(ErrorCode::Internal, "重启 Docker 服务失败")
                .with_cause(out.stderr.trim().to_string()),
        );
    }
    Ok(())
}

pub fn remote_engine_daemon_config() -> DockerDaemonConfigFile {
    DockerDaemonConfigFile {
        content: default_daemon_json(),
        path: "daemon.json".to_string(),
        editable: false,
    }
}
