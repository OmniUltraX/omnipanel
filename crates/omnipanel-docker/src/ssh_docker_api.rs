//! SSH 宿主机 Docker Engine API：通过 `curl --unix-socket` 访问。
//!
//! 读操作走 Engine HTTP API，与本地 `bollard` 返回同构 JSON；写操作仍由 [`crate::ssh`] 使用 `docker` CLI。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use serde::de::DeserializeOwned;

pub const DOCKER_SOCK: &str = "/var/run/docker.sock";
const DOCKER_SOCK_FALLBACK: &str = "/run/docker.sock";
const HTTP_STATUS_MARK: &str = "__OMNI_HTTP_STATUS__:";

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
        let mut last_err: Option<OmniError> = None;
        for sock in [DOCKER_SOCK, DOCKER_SOCK_FALLBACK] {
            match self.curl_on_socket(method, path_and_query, sock).await {
                Ok(body) => return Ok(body),
                Err(err) => last_err = Some(err),
            }
        }
        Err(last_err.unwrap_or_else(|| {
            OmniError::new(ErrorCode::Internal, "Docker Engine API 请求失败")
        }))
    }

    async fn curl_on_socket(
        &self,
        method: &str,
        path_and_query: &str,
        sock: &str,
    ) -> OmniResult<String> {
        let url = format!("http://localhost{path_and_query}");
        // -w 追加 HTTP 状态码，便于区分「真正空 body」与「连接/权限失败」
        let cmd = format!(
            "curl -sS -X {method} --unix-socket {} -w '\\n{}%{{http_code}}' {}",
            shell_quote(sock),
            HTTP_STATUS_MARK,
            shell_quote(&url)
        );
        let out = self.session.exec_capture(&cmd).await?;
        if out.exit_code != 0 {
            return Err(map_curl_failure(
                &out.stderr,
                &out.stdout,
                "Docker Engine API 请求失败",
            ));
        }

        let (body, status) = split_curl_http_status(&out.stdout);
        let Some(status) = status else {
            // 兼容不支持 -w 的旧 curl：退回整段 stdout
            if body.trim().is_empty() {
                return Err(OmniError::new(
                    ErrorCode::Internal,
                    "Docker Engine API 返回空响应",
                )
                .with_cause(format!(
                    "socket={sock}；请确认远端 Docker 已运行且当前用户可访问该 unix socket"
                )));
            }
            if let Some(err) = docker_api_error_message(body.trim()) {
                return Err(
                    OmniError::new(ErrorCode::Internal, "Docker Engine API 错误").with_cause(err)
                );
            }
            return Ok(body);
        };

        if !(200..300).contains(&status) {
            if let Some(err) = docker_api_error_message(body.trim()) {
                return Err(
                    OmniError::new(ErrorCode::Internal, "Docker Engine API 错误").with_cause(err)
                );
            }
            let detail = if body.trim().is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}: {}", body.trim())
            };
            return Err(
                OmniError::new(ErrorCode::Internal, "Docker Engine API 请求失败").with_cause(detail)
            );
        }

        if body.trim().is_empty() {
            // 成功状态但无 body：常见于 socket 不可用却被错误吞掉，或守护进程异常
            return Err(OmniError::new(
                ErrorCode::Internal,
                "Docker Engine API 返回空响应",
            )
            .with_cause(format!(
                "HTTP {status}，socket={sock}；请确认远端 Docker 已运行且当前用户可访问该 unix socket"
            )));
        }

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
        )
        .with_cause("响应体为空，请确认远端 Docker 守护进程可用"));
    }
    if let Some(err) = docker_api_error_message(trimmed) {
        return Err(OmniError::new(ErrorCode::Internal, "Docker Engine API 错误").with_cause(err));
    }
    serde_json::from_str(trimmed).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析 Docker Engine API JSON 失败")
            .with_cause(e.to_string())
    })
}

fn split_curl_http_status(raw: &str) -> (String, Option<u16>) {
    if let Some(idx) = raw.rfind(HTTP_STATUS_MARK) {
        let body = raw[..idx].trim_end_matches('\n').trim_end_matches('\r');
        let code_str = raw[idx + HTTP_STATUS_MARK.len()..].trim();
        let code = code_str.parse::<u16>().ok();
        return (body.to_string(), code);
    }
    (raw.to_string(), None)
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
    let stdout_body = split_curl_http_status(stdout).0;
    if let Some(msg) = docker_api_error_message(stdout_body.trim()) {
        return OmniError::new(ErrorCode::Internal, context.to_string()).with_cause(msg);
    }
    let detail = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout_body.trim()
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
            "当前用户无权访问 Docker unix socket（需加入 docker 组）".to_string(),
        )
    } else if lower.contains("空响应")
        || lower.contains("响应体为空")
        || (lower.contains("no such file or directory") && lower.contains("docker.sock"))
        || lower.contains("http 000")
    {
        (
            crate::model::DockerConnectionStatus::Offline,
            "远端 Docker 守护进程未运行或未暴露可用的 unix socket".to_string(),
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

    #[test]
    fn splits_http_status_trailer() {
        let (body, code) = split_curl_http_status("{\"Version\":\"27.0\"}\n__OMNI_HTTP_STATUS__:200");
        assert_eq!(body, "{\"Version\":\"27.0\"}");
        assert_eq!(code, Some(200));
    }

    #[test]
    fn classifies_empty_response_as_offline() {
        let (status, _) = classify_docker_api_error("Docker Engine API 返回空响应");
        assert_eq!(status, crate::model::DockerConnectionStatus::Offline);
    }
}
