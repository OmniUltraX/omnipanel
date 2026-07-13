//! Compose 项目配置文件（`docker-compose.yml` / `.env`）读写。

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;

use crate::model::{
    DockerComposeProjectFiles, DockerComposeReadFilesRequest, DockerComposeWriteFilesRequest,
};

pub fn resolve_compose_file_paths(
    working_dir: &str,
    config_file: Option<&str>,
) -> (PathBuf, PathBuf) {
    let base = PathBuf::from(working_dir);
    let compose = match config_file.filter(|value| !value.trim().is_empty()) {
        Some(cf) => {
            let first = cf.split(',').next().unwrap_or(cf).trim();
            let path = PathBuf::from(first);
            if path.is_absolute() {
                path
            } else {
                base.join(path)
            }
        }
        None => base.join("docker-compose.yml"),
    };
    let env = compose
        .parent()
        .map(|parent| parent.join(".env"))
        .unwrap_or_else(|| base.join(".env"));
    (compose, env)
}

fn require_working_dir(working_dir: Option<&str>) -> OmniResult<&str> {
    working_dir
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            OmniError::new(
                ErrorCode::InvalidInput,
                "缺少 Compose 项目工作目录，无法读写配置文件",
            )
        })
}

async fn read_text_file(path: &Path) -> OmniResult<String> {
    read_text_file_logged(path, "file").await.map(|(content, _)| content)
}

async fn read_text_file_logged(path: &Path, label: &str) -> OmniResult<(String, bool)> {
    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            tracing::debug!(
                target: "docker_compose_files",
                label,
                path = %path.display(),
                bytes = content.len(),
                "读取本地 Compose 文件成功"
            );
            Ok((content, true))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(
                target: "docker_compose_files",
                label,
                path = %path.display(),
                "本地 Compose 文件不存在"
            );
            Ok((String::new(), false))
        }
        Err(error) => Err(
            OmniError::new(ErrorCode::Internal, "读取 Compose 配置文件失败")
                .with_cause(format!("{}: {error}", path.display())),
        ),
    }
}

async fn resolve_env_content_local(
    working_dir: &str,
    compose_path: &Path,
    env_path_from_compose: &Path,
) -> OmniResult<(String, PathBuf)> {
    let (content, found) = read_text_file_logged(env_path_from_compose, "env").await?;
    if found && !content.is_empty() {
        tracing::debug!(
            target: "docker_compose_files",
            env_path = %env_path_from_compose.display(),
            source = "compose_parent",
            bytes = content.len(),
            "使用 compose 同目录 .env"
        );
        return Ok((content, env_path_from_compose.to_path_buf()));
    }

    let working_env = PathBuf::from(working_dir).join(".env");
    if working_env != env_path_from_compose {
        tracing::debug!(
            target: "docker_compose_files",
            primary_env = %env_path_from_compose.display(),
            fallback_env = %working_env.display(),
            primary_found = found,
            primary_bytes = content.len(),
            "compose 同目录 .env 为空或不存在，尝试 working_dir/.env"
        );
        let (fallback, fallback_found) = read_text_file_logged(&working_env, "env_fallback").await?;
        if fallback_found && !fallback.is_empty() {
            tracing::debug!(
                target: "docker_compose_files",
                env_path = %working_env.display(),
                source = "working_dir",
                bytes = fallback.len(),
                "使用 working_dir/.env"
            );
            return Ok((fallback, working_env));
        }
    }

    tracing::debug!(
        target: "docker_compose_files",
        compose_path = %compose_path.display(),
        env_path = %env_path_from_compose.display(),
        "未找到 .env 内容，返回空字符串"
    );
    Ok((content, env_path_from_compose.to_path_buf()))
}

async fn write_text_file(path: &Path, content: &str) -> OmniResult<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(|error| {
            OmniError::new(ErrorCode::Internal, "创建 Compose 配置目录失败")
                .with_cause(error.to_string())
        })?;
    }
    tokio::fs::write(path, content).await.map_err(|error| {
        OmniError::new(ErrorCode::Internal, "写入 Compose 配置文件失败")
            .with_cause(format!("{}: {error}", path.display()))
    })
}

pub async fn read_local_compose_project_files(
    req: &DockerComposeReadFilesRequest,
) -> OmniResult<DockerComposeProjectFiles> {
    let working_dir = require_working_dir(req.working_dir.as_deref())?;
    let (compose_path, env_path) =
        resolve_compose_file_paths(working_dir, req.config_file.as_deref());
    tracing::debug!(
        target: "docker_compose_files",
        project = %req.project,
        working_dir,
        config_file = ?req.config_file,
        compose_path = %compose_path.display(),
        env_path = %env_path.display(),
        "read_local_compose_project_files 开始"
    );
    let compose_content = read_text_file(&compose_path).await?;
    let (env_content, resolved_env_path) =
        resolve_env_content_local(working_dir, &compose_path, &env_path).await?;
    tracing::debug!(
        target: "docker_compose_files",
        project = %req.project,
        compose_bytes = compose_content.len(),
        env_bytes = env_content.len(),
        resolved_env_path = %resolved_env_path.display(),
        "read_local_compose_project_files 完成"
    );
    Ok(DockerComposeProjectFiles {
        project: req.project.clone(),
        working_dir: Some(working_dir.to_string()),
        compose_path: compose_path.to_string_lossy().into_owned(),
        compose_content,
        env_path: resolved_env_path.to_string_lossy().into_owned(),
        env_content,
    })
}

pub async fn write_local_compose_project_files(
    req: &DockerComposeWriteFilesRequest,
) -> OmniResult<()> {
    let working_dir = require_working_dir(req.working_dir.as_deref())?;
    let (default_compose_path, default_env_path) =
        resolve_compose_file_paths(working_dir, req.config_file.as_deref());
    if let Some(content) = &req.compose_content {
        let path = req
            .compose_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_compose_path);
        write_text_file(&path, content).await?;
    }
    if let Some(content) = &req.env_content {
        let path = req
            .env_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or(default_env_path);
        write_text_file(&path, content).await?;
    }
    Ok(())
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

async fn read_remote_text_file(session: &SshSession, path: &str) -> OmniResult<(String, bool)> {
    let cmd = format!("cat {}", shell_quote(path));
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        let stderr = out.stderr.trim();
        if stderr.contains("No such file")
            || stderr.contains("not found")
            || stderr.contains("No such file or directory")
        {
            tracing::debug!(
                target: "docker_compose_files",
                path,
                stderr,
                "远端 Compose 文件不存在"
            );
            return Ok((String::new(), false));
        }
        tracing::debug!(
            target: "docker_compose_files",
            path,
            exit_code = out.exit_code,
            stderr,
            "读取远端 Compose 文件失败"
        );
        return Err(
            OmniError::new(ErrorCode::Internal, "读取远端 Compose 配置文件失败")
                .with_cause(stderr.to_string()),
        );
    }
    tracing::debug!(
        target: "docker_compose_files",
        path,
        bytes = out.stdout.len(),
        "读取远端 Compose 文件成功"
    );
    Ok((out.stdout, true))
}

async fn resolve_env_content_ssh(
    session: &SshSession,
    working_dir: &str,
    compose_path: &str,
    env_path_from_compose: &str,
) -> OmniResult<(String, String)> {
    let (content, found) = read_remote_text_file(session, env_path_from_compose).await?;
    if found && !content.is_empty() {
        tracing::debug!(
            target: "docker_compose_files",
            env_path = env_path_from_compose,
            source = "compose_parent",
            bytes = content.len(),
            "使用 compose 同目录 .env"
        );
        return Ok((content, env_path_from_compose.to_string()));
    }

    let working_env = format!(
        "{}/.env",
        working_dir.trim_end_matches('/')
    );
    if working_env != env_path_from_compose {
        tracing::debug!(
            target: "docker_compose_files",
            primary_env = env_path_from_compose,
            fallback_env = %working_env,
            primary_found = found,
            primary_bytes = content.len(),
            "compose 同目录 .env 为空或不存在，尝试 working_dir/.env"
        );
        let (fallback, fallback_found) = read_remote_text_file(session, &working_env).await?;
        if fallback_found && !fallback.is_empty() {
            tracing::debug!(
                target: "docker_compose_files",
                env_path = %working_env,
                source = "working_dir",
                bytes = fallback.len(),
                "使用 working_dir/.env"
            );
            return Ok((fallback, working_env));
        }
    }

    tracing::debug!(
        target: "docker_compose_files",
        compose_path,
        env_path = env_path_from_compose,
        "未找到 .env 内容，返回空字符串"
    );
    Ok((content, env_path_from_compose.to_string()))
}

async fn write_remote_text_file(session: &SshSession, path: &str, content: &str) -> OmniResult<()> {
    let parent = Path::new(path)
        .parent()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string());
    let encoded = STANDARD.encode(content.as_bytes());
    let cmd = format!(
        "mkdir -p {} && printf '%s' '{}' | base64 -d > {}",
        shell_quote(&parent),
        encoded,
        shell_quote(path)
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        return Err(
            OmniError::new(ErrorCode::Internal, "写入远端 Compose 配置文件失败")
                .with_cause(out.stderr.trim().to_string()),
        );
    }
    Ok(())
}

pub async fn read_ssh_compose_project_files(
    session: &SshSession,
    req: &DockerComposeReadFilesRequest,
) -> OmniResult<DockerComposeProjectFiles> {
    let working_dir = require_working_dir(req.working_dir.as_deref())?;
    let (compose_path, env_path) =
        resolve_compose_file_paths(working_dir, req.config_file.as_deref());
    let compose_path = compose_path.to_string_lossy().into_owned();
    let env_path = env_path.to_string_lossy().into_owned();
    tracing::debug!(
        target: "docker_compose_files",
        project = %req.project,
        working_dir,
        config_file = ?req.config_file,
        compose_path = %compose_path,
        env_path = %env_path,
        "read_ssh_compose_project_files 开始"
    );
    let (compose_content, _) = read_remote_text_file(session, &compose_path).await?;
    let (env_content, resolved_env_path) =
        resolve_env_content_ssh(session, working_dir, &compose_path, &env_path).await?;
    tracing::debug!(
        target: "docker_compose_files",
        project = %req.project,
        compose_bytes = compose_content.len(),
        env_bytes = env_content.len(),
        resolved_env_path = %resolved_env_path,
        "read_ssh_compose_project_files 完成"
    );
    Ok(DockerComposeProjectFiles {
        project: req.project.clone(),
        working_dir: Some(working_dir.to_string()),
        compose_path,
        compose_content,
        env_path: resolved_env_path,
        env_content,
    })
}

pub async fn write_ssh_compose_project_files(
    session: &SshSession,
    req: &DockerComposeWriteFilesRequest,
) -> OmniResult<()> {
    let working_dir = require_working_dir(req.working_dir.as_deref())?;
    let (default_compose_path, default_env_path) =
        resolve_compose_file_paths(working_dir, req.config_file.as_deref());
    if let Some(content) = &req.compose_content {
        let path = req
            .compose_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_compose_path.to_str().unwrap_or_default());
        write_remote_text_file(session, path, content).await?;
    }
    if let Some(content) = &req.env_content {
        let path = req
            .env_path
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(default_env_path.to_str().unwrap_or_default());
        write_remote_text_file(session, path, content).await?;
    }
    Ok(())
}
