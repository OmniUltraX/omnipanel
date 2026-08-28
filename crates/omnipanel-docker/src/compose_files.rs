//! Compose 项目配置文件（`docker-compose.yml` / `.env`）读写。

use std::path::{Path, PathBuf};
use std::time::Instant;

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
    read_text_file_logged(path, "file")
        .await
        .map(|(content, _)| content)
}

async fn read_text_file_logged(path: &Path, label: &str) -> OmniResult<(String, bool)> {
    let started = Instant::now();
    match tokio::fs::read_to_string(path).await {
        Ok(content) => {
            tracing::debug!(
                target: "docker_compose_files",
                label,
                path = %path.display(),
                bytes = content.len(),
                elapsed_ms = started.elapsed().as_millis(),
                "读取本地 Compose 文件成功"
            );
            Ok((content, true))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            tracing::debug!(
                target: "docker_compose_files",
                label,
                path = %path.display(),
                elapsed_ms = started.elapsed().as_millis(),
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
        let (fallback, fallback_found) =
            read_text_file_logged(&working_env, "env_fallback").await?;
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
    let total = Instant::now();
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
    let compose_started = Instant::now();
    let env_started = Instant::now();
    let (compose_result, env_result) = tokio::join!(
        read_text_file(&compose_path),
        resolve_env_content_local(working_dir, &compose_path, &env_path),
    );
    let compose_content = compose_result?;
    let compose_ms = compose_started.elapsed().as_millis();
    let (env_content, resolved_env_path) = env_result?;
    let env_ms = env_started.elapsed().as_millis();
    tracing::debug!(
        target: "docker_compose_files",
        project = %req.project,
        compose_bytes = compose_content.len(),
        env_bytes = env_content.len(),
        resolved_env_path = %resolved_env_path.display(),
        compose_ms,
        env_ms,
        total_ms = total.elapsed().as_millis(),
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

/// 优先 SFTP 同会话读两个文件；失败则回退到一次 shell（长度前缀 + cat，无 base64）。
async fn read_remote_compose_and_env(
    session: &SshSession,
    compose_path: &str,
    env_primary: &str,
    env_fallback: &str,
) -> OmniResult<(String, String, String)> {
    match read_remote_compose_and_env_sftp(session, compose_path, env_primary, env_fallback).await {
        Ok(result) => Ok(result),
        Err(error) => {
            tracing::debug!(
                target: "docker_compose_files",
                compose_path,
                error = %error,
                "SFTP 读取 Compose 失败，回退 shell cat"
            );
            read_remote_compose_and_env_shell(session, compose_path, env_primary, env_fallback)
                .await
        }
    }
}

async fn read_remote_compose_and_env_sftp(
    session: &SshSession,
    compose_path: &str,
    env_primary: &str,
    env_fallback: &str,
) -> OmniResult<(String, String, String)> {
    let started = Instant::now();
    let need_fallback = env_fallback != env_primary && !env_fallback.is_empty();
    let paths: Vec<&str> = if need_fallback {
        vec![compose_path, env_primary, env_fallback]
    } else {
        vec![compose_path, env_primary]
    };
    let texts = session.sftp_read_texts_optional(&paths).await?;
    let compose_content = texts.first().cloned().flatten().unwrap_or_default();
    let primary_env = texts.get(1).cloned().flatten().unwrap_or_default();
    let (resolved_env_path, env_content) = if !primary_env.is_empty() {
        (env_primary.to_string(), primary_env)
    } else if need_fallback {
        let fallback_env = texts.get(2).cloned().flatten().unwrap_or_default();
        if !fallback_env.is_empty() {
            (env_fallback.to_string(), fallback_env)
        } else {
            (env_primary.to_string(), String::new())
        }
    } else {
        (env_primary.to_string(), String::new())
    };
    tracing::debug!(
        target: "docker_compose_files",
        compose_path,
        env_path = %resolved_env_path,
        compose_bytes = compose_content.len(),
        env_bytes = env_content.len(),
        elapsed_ms = started.elapsed().as_millis(),
        via = "sftp",
        "一次 SFTP 读取 compose/.env 完成"
    );
    Ok((compose_content, resolved_env_path, env_content))
}

/// shell 回退：长度前缀 + 原始 cat（避免把文件塞进 shell 变量做 base64）。
async fn read_remote_compose_and_env_shell(
    session: &SshSession,
    compose_path: &str,
    env_primary: &str,
    env_fallback: &str,
) -> OmniResult<(String, String, String)> {
    let started = Instant::now();
    // 协议（字节）：compose_len\n + compose_bytes + env_path\n + env_len\n + env_bytes
    let script = format!(
        r#"
set +e
compose_path={compose}
env_primary={env_primary}
env_fallback={env_fallback}
if [ -r "$compose_path" ]; then
  compose_size=$(wc -c < "$compose_path" | tr -d ' \t')
else
  compose_size=0
fi
printf '%s\n' "$compose_size"
if [ "$compose_size" -gt 0 ] 2>/dev/null; then
  cat "$compose_path"
fi
env_path="$env_primary"
if [ -s "$env_primary" ]; then
  env_path="$env_primary"
elif [ -n "$env_fallback" ] && [ "$env_fallback" != "$env_primary" ] && [ -s "$env_fallback" ]; then
  env_path="$env_fallback"
fi
if [ -r "$env_path" ] && [ -s "$env_path" ]; then
  env_size=$(wc -c < "$env_path" | tr -d ' \t')
else
  env_size=0
fi
printf '%s\n' "$env_path"
printf '%s\n' "$env_size"
if [ "$env_size" -gt 0 ] 2>/dev/null; then
  cat "$env_path"
fi
"#,
        compose = shell_quote(compose_path),
        env_primary = shell_quote(env_primary),
        env_fallback = shell_quote(env_fallback),
    );
    let out = session.exec_capture(&script).await?;
    let elapsed_ms = started.elapsed().as_millis();
    if out.exit_code != 0 {
        return Err(
            OmniError::new(ErrorCode::Internal, "读取远端 Compose 配置文件失败")
                .with_cause(out.stderr.trim().to_string()),
        );
    }
    let (compose_content, rest) = take_length_prefixed_chunk(&out.stdout)?;
    let (env_path_line, after_path) = rest.split_once('\n').ok_or_else(|| {
        OmniError::new(
            ErrorCode::Internal,
            "解析远端 Compose 响应失败：缺少 env_path",
        )
    })?;
    let resolved_env_path = {
        let trimmed = env_path_line.trim();
        if trimmed.is_empty() {
            env_primary.to_string()
        } else {
            trimmed.to_string()
        }
    };
    let (env_content, _) = take_length_prefixed_chunk(after_path)?;
    tracing::debug!(
        target: "docker_compose_files",
        compose_path,
        env_path = %resolved_env_path,
        compose_bytes = compose_content.len(),
        env_bytes = env_content.len(),
        elapsed_ms,
        via = "shell",
        "一次 shell 读取 compose/.env 完成"
    );
    Ok((compose_content, resolved_env_path, env_content))
}

fn take_length_prefixed_chunk(input: &str) -> OmniResult<(String, &str)> {
    let (len_line, rest) = input.split_once('\n').ok_or_else(|| {
        OmniError::new(ErrorCode::Internal, "解析远端 Compose 响应失败：缺少长度行")
    })?;
    let len: usize = len_line
        .trim()
        .parse()
        .map_err(|error: std::num::ParseIntError| {
            OmniError::new(ErrorCode::Internal, "解析远端 Compose 响应失败：长度非法")
                .with_cause(error.to_string())
        })?;
    if rest.len() < len {
        return Err(OmniError::new(
            ErrorCode::Internal,
            format!(
                "解析远端 Compose 响应失败：声明 {len} 字节，实际剩余 {}",
                rest.len()
            ),
        ));
    }
    if !rest.is_char_boundary(len) {
        return Err(OmniError::new(
            ErrorCode::Internal,
            "解析远端 Compose 响应失败：长度未落在 UTF-8 字符边界",
        ));
    }
    Ok((rest[..len].to_string(), &rest[len..]))
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
    let total = Instant::now();
    let working_dir = require_working_dir(req.working_dir.as_deref())?;
    let (compose_path, env_path) =
        resolve_compose_file_paths(working_dir, req.config_file.as_deref());
    let compose_path = compose_path.to_string_lossy().into_owned();
    let env_path = env_path.to_string_lossy().into_owned();
    let working_env = format!("{}/.env", working_dir.trim_end_matches('/'));
    tracing::debug!(
        target: "docker_compose_files",
        project = %req.project,
        working_dir,
        config_file = ?req.config_file,
        compose_path = %compose_path,
        env_path = %env_path,
        "read_ssh_compose_project_files 开始"
    );
    let read_started = Instant::now();
    let (compose_content, resolved_env_path, env_content) =
        read_remote_compose_and_env(session, &compose_path, &env_path, &working_env).await?;
    let read_ms = read_started.elapsed().as_millis();
    tracing::debug!(
        target: "docker_compose_files",
        project = %req.project,
        compose_bytes = compose_content.len(),
        env_bytes = env_content.len(),
        resolved_env_path = %resolved_env_path,
        compose_ms = read_ms,
        env_ms = 0_u128,
        total_ms = total.elapsed().as_millis(),
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
