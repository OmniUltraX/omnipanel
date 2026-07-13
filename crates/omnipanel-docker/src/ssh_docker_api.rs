//! SSH 宿主机 Docker Engine API：通过 `curl --unix-socket /var/run/docker.sock` 访问。
//!
//! 读操作走 Engine HTTP API，与本地 `bollard` 返回同构 JSON；写操作仍由 [`crate::ssh`] 使用 `docker` CLI。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use serde::de::DeserializeOwned;

pub const DOCKER_SOCK: &str = "/var/run/docker.sock";

pub struct SshDockerApi<'a> {
    session: &'a SshSession,
}

impl<'a> SshDockerApi<'a> {
    pub fn new(session: &'a SshSession) -> Self {
        Self { session }
    }

    pub async fn get(&self, path_and_query: &str) -> OmniResult<String> {
        self.curl("GET", path_and_query).await
    }

    pub async fn get_json<T: DeserializeOwned>(&self, path_and_query: &str) -> OmniResult<T> {
        let body = self.get(path_and_query).await?;
        parse_docker_api_json(&body)
    }

    async fn curl(&self, method: &str, path_and_query: &str) -> OmniResult<String> {
        let url = format!("http://localhost{path_and_query}");
        let cmd = format!(
            "curl -sS -X {method} --unix-socket {} {}",
            shell_quote(DOCKER_SOCK),
            shell_quote(&url)
        );
        let out = self.session.exec_capture(&cmd).await?;
        if out.exit_code != 0 {
            return Err(map_curl_failure(&out.stderr, &out.stdout, "Docker Engine API 请求失败"));
        }
        let body = out.stdout;
        if let Some(err) = docker_api_error_message(body.trim()) {
            return Err(OmniError::new(ErrorCode::Internal, "Docker Engine API 错误").with_cause(err));
        }
        Ok(body)
    }
}

pub fn url_path_segment(value: &str) -> String {
    let trimmed = value.trim().trim_start_matches('/');
    let mut out = String::with_capacity(trimmed.len());
    for b in trimmed.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn parse_docker_api_json<T: DeserializeOwned>(body: &str) -> OmniResult<T> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Err(OmniError::new(
            ErrorCode::Internal,
            "Docker Engine API 返回空响应",
        ));
    }
    if let Some(err) = docker_api_error_message(trimmed) {
        return Err(OmniError::new(ErrorCode::Internal, "Docker Engine API 错误").with_cause(err));
    }
    serde_json::from_str(trimmed).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析 Docker Engine API JSON 失败")
            .with_cause(e.to_string())
    })
}

fn docker_api_error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    if value.is_object()
        && value.get("message").is_some()
        && value.get("Id").is_none()
        && value.get("Containers").is_none()
        && value.get("Volumes").is_none()
        && !value.as_array().is_some_and(|a| !a.is_empty())
    {
        return value
            .get("message")
            .and_then(|m| m.as_str())
            .map(str::to_string);
    }
    None
}

pub fn map_curl_failure(stderr: &str, stdout: &str, context: &str) -> OmniError {
    if let Some(msg) = docker_api_error_message(stdout.trim()) {
        return OmniError::new(ErrorCode::Internal, context.to_string()).with_cause(msg);
    }
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    OmniError::new(ErrorCode::Internal, context.to_string()).with_cause(detail.to_string())
}

pub fn classify_docker_api_error(detail: &str) -> (crate::model::DockerConnectionStatus, String) {
    let lower = detail.to_lowercase();
    if lower.contains("curl:")
        && (lower.contains("not found") || lower.contains("command not found"))
    {
        (
            crate::model::DockerConnectionStatus::Offline,
            "远端未安装 curl，无法访问 Docker Engine API".to_string(),
        )
    } else if lower.contains("permission denied")
        || lower.contains("dial unix")
        || lower.contains("connect to unix")
        || lower.contains("couldn't connect to server")
        || lower.contains("could not connect to server")
    {
        (
            crate::model::DockerConnectionStatus::Degraded,
            "当前用户无权访问 /var/run/docker.sock（需加入 docker 组）".to_string(),
        )
    } else if lower.contains("no such file or directory") && lower.contains("docker.sock") {
        (
            crate::model::DockerConnectionStatus::Offline,
            "远端 Docker 守护进程未运行或未暴露 unix socket".to_string(),
        )
    } else if lower.contains("cannot connect") || lower.contains("is the docker daemon running") {
        (
            crate::model::DockerConnectionStatus::Offline,
            "远端 Docker 守护进程未运行".to_string(),
        )
    } else {
        (
            crate::model::DockerConnectionStatus::Degraded,
            format!("Docker API 探测失败：{}", detail.trim()),
        )
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_container_name_segments() {
        assert_eq!(url_path_segment("abc123"), "abc123");
        assert_eq!(url_path_segment("/my_app"), "my_app");
        assert_eq!(url_path_segment("a/b"), "a%2Fb");
    }

    #[test]
    fn detects_api_error_payload() {
        let msg = docker_api_error_message(r#"{"message":"No such container: foo"}"#);
        assert_eq!(msg.as_deref(), Some("No such container: foo"));
    }
}
