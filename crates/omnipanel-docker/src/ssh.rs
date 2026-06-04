//! SSH 宿主机 Docker 适配器：复用现有 [`SshSession`]，调用远端 `docker` CLI。
//!
//! 以自由函数形式提供（借用外部 `&SshSession`，由命令层从活跃会话池取得），
//! 与 [`crate::local`] 共享 [`crate::model`] 数据结构与 [`crate::compose`] 聚合逻辑。

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::compose::{ComposeContainerRow, aggregate_compose};
use crate::local::to_container_detail;
use crate::model::*;
use crate::{ContainerFilter, DockerAdapter, normalize_name, short_id};

/// SSH 宿主机 Docker 适配器：持有一个可复用的 `SshSession`（由命令层缓存于会话池），
/// 每次操作在独立 exec channel 上调用远端 `docker` CLI。
pub struct SshDockerAdapter {
    session: Arc<Mutex<SshSession>>,
}

impl SshDockerAdapter {
    pub fn new(session: Arc<Mutex<SshSession>>) -> Self {
        Self { session }
    }
}

#[async_trait]
impl DockerAdapter for SshDockerAdapter {
    async fn probe(&self) -> OmniResult<DockerProbe> {
        probe(&*self.session.lock().await).await
    }
    async fn overview(&self) -> OmniResult<DockerOverview> {
        overview(&*self.session.lock().await).await
    }
    async fn list_containers(
        &self,
        filter: ContainerFilter,
    ) -> OmniResult<Vec<DockerContainerSummary>> {
        list_containers(&*self.session.lock().await, filter).await
    }
    async fn inspect_container(&self, id: &str) -> OmniResult<DockerContainerDetail> {
        inspect_container(&*self.session.lock().await, id).await
    }
    async fn container_action(&self, id: &str, action: DockerContainerAction) -> OmniResult<()> {
        container_action(&*self.session.lock().await, id, action).await
    }
    async fn container_logs(&self, id: &str, tail: i64) -> OmniResult<Vec<DockerLogLine>> {
        container_logs(&*self.session.lock().await, id, tail).await
    }
    async fn list_images(&self) -> OmniResult<Vec<DockerImageSummary>> {
        list_images(&*self.session.lock().await).await
    }
    async fn remove_image(&self, id: &str, force: bool) -> OmniResult<()> {
        remove_image(&*self.session.lock().await, id, force).await
    }
    async fn prune_images(&self) -> OmniResult<DockerPruneResult> {
        prune_images(&*self.session.lock().await).await
    }
    async fn list_compose_projects(&self) -> OmniResult<Vec<DockerComposeProject>> {
        list_compose_projects(&*self.session.lock().await).await
    }
}

/// 探测远端 Docker 可用性与版本。
pub async fn probe(session: &SshSession) -> OmniResult<DockerProbe> {
    let out = session
        .exec_capture("docker version --format '{{.Server.Version}}|{{.Server.APIVersion}}'")
        .await?;
    if out.exit_code != 0 {
        let detail = out.stderr.trim();
        let (status, msg) = classify_docker_error(detail);
        return Ok(DockerProbe {
            status,
            engine_version: None,
            api_version: None,
            capabilities: DockerCapabilities::full(DockerConnectionSource::SshEngine),
            warning_message: Some(msg),
        });
    }
    let line = out.stdout.trim();
    let (version, api) = line.split_once('|').unwrap_or((line, ""));
    Ok(DockerProbe {
        status: DockerConnectionStatus::Online,
        engine_version: non_empty(version),
        api_version: non_empty(api),
        capabilities: DockerCapabilities::full(DockerConnectionSource::SshEngine),
        warning_message: None,
    })
}

/// 远端总览统计。
pub async fn overview(session: &SshSession) -> OmniResult<DockerOverview> {
    let containers = list_containers(session, ContainerFilter::All).await?;
    let running = containers.iter().filter(|c| c.running).count() as u32;
    let total = containers.len() as u32;
    let images = list_images(session)
        .await
        .map(|i| i.len() as u32)
        .unwrap_or(0);
    let version = probe(session).await.ok().and_then(|p| p.engine_version);
    Ok(DockerOverview {
        capabilities: DockerCapabilities::full(DockerConnectionSource::SshEngine),
        summary: DockerResourceSummary {
            containers_total: total,
            containers_running: running,
            containers_stopped: total - running,
            images,
        },
        engine_version: version,
        warning_message: None,
    })
}

/// 远端容器列表。
pub async fn list_containers(
    session: &SshSession,
    filter: ContainerFilter,
) -> OmniResult<Vec<DockerContainerSummary>> {
    let cmd = if filter.include_all() {
        "docker ps -a --no-trunc --format '{{json .}}'"
    } else {
        "docker ps --no-trunc --format '{{json .}}'"
    };
    let out = session.exec_capture(cmd).await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("列出远端容器失败", &out.stderr));
    }
    let mut result = Vec::new();
    for line in out.stdout.lines().filter(|l| !l.trim().is_empty()) {
        let row: PsRow = serde_json::from_str(line).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析 docker ps 输出失败").with_cause(e.to_string())
        })?;
        let summary = row.into_summary();
        if filter.matches(summary.running) {
            result.push(summary);
        }
    }
    Ok(result)
}

/// 远端容器详情（复用 `docker inspect` 的 Engine API 同构 JSON）。
pub async fn inspect_container(
    session: &SshSession,
    id: &str,
) -> OmniResult<DockerContainerDetail> {
    let out = session
        .exec_capture(&format!("docker inspect {}", shell_quote(id)))
        .await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("查看远端容器详情失败", &out.stderr));
    }
    let mut parsed: Vec<bollard::models::ContainerInspectResponse> =
        serde_json::from_str(out.stdout.trim()).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析 docker inspect 输出失败")
                .with_cause(e.to_string())
        })?;
    let raw = parsed
        .pop()
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("远端容器 {id} 不存在")))?;
    Ok(to_container_detail(raw))
}

/// 远端容器生命周期动作。
pub async fn container_action(
    session: &SshSession,
    id: &str,
    action: DockerContainerAction,
) -> OmniResult<()> {
    let cmd = format!("docker {} {}", action.cli_verb(), shell_quote(id));
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端容器操作失败")?;
    Ok(())
}

/// 远端容器日志（一次性 tail）。
pub async fn container_logs(
    session: &SshSession,
    id: &str,
    tail: i64,
) -> OmniResult<Vec<DockerLogLine>> {
    let cmd = format!("docker logs --tail {tail} {}", shell_quote(id));
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("获取远端容器日志失败", &out.stderr));
    }
    let mut lines = Vec::new();
    for (stream, text) in [("stdout", &out.stdout), ("stderr", &out.stderr)] {
        for line in text.lines() {
            lines.push(DockerLogLine {
                stream: stream.to_string(),
                message: line.to_string(),
            });
        }
    }
    Ok(lines)
}

/// 远端镜像列表。
pub async fn list_images(session: &SshSession) -> OmniResult<Vec<DockerImageSummary>> {
    let out = session
        .exec_capture("docker images --no-trunc --format '{{json .}}'")
        .await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("列出远端镜像失败", &out.stderr));
    }
    let mut result = Vec::new();
    for line in out.stdout.lines().filter(|l| !l.trim().is_empty()) {
        let row: ImageRow = serde_json::from_str(line).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析 docker images 输出失败")
                .with_cause(e.to_string())
        })?;
        result.push(row.into_summary());
    }
    Ok(result)
}

/// 删除远端镜像。
pub async fn remove_image(session: &SshSession, id: &str, force: bool) -> OmniResult<()> {
    let flag = if force { "-f " } else { "" };
    let cmd = format!("docker rmi {flag}{}", shell_quote(id));
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("删除远端镜像失败")?;
    Ok(())
}

/// 清理远端悬空镜像。
pub async fn prune_images(session: &SshSession) -> OmniResult<DockerPruneResult> {
    let out = session.exec_capture("docker image prune -f").await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("清理远端镜像失败", &out.stderr));
    }
    Ok(DockerPruneResult {
        deleted: out
            .stdout
            .lines()
            .filter(|l| l.starts_with("deleted:") || l.starts_with("untagged:"))
            .map(|l| l.to_string())
            .collect(),
        freed_space_bytes: parse_reclaimed_space(&out.stdout),
    })
}

/// 远端 Compose 项目识别。
pub async fn list_compose_projects(session: &SshSession) -> OmniResult<Vec<DockerComposeProject>> {
    let out = session
        .exec_capture("docker ps -a --no-trunc --format '{{json .}}'")
        .await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("识别远端 Compose 项目失败", &out.stderr));
    }
    let mut rows = Vec::new();
    for line in out.stdout.lines().filter(|l| !l.trim().is_empty()) {
        let row: PsRow = serde_json::from_str(line).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析 docker ps 输出失败").with_cause(e.to_string())
        })?;
        let labels = parse_labels(&row.labels);
        if let Some(project) = labels.get("com.docker.compose.project") {
            rows.push(ComposeContainerRow {
                project: project.clone(),
                service: labels
                    .get("com.docker.compose.service")
                    .cloned()
                    .unwrap_or_else(|| "default".to_string()),
                working_dir: labels
                    .get("com.docker.compose.project.working_dir")
                    .cloned(),
                config_files: labels
                    .get("com.docker.compose.project.config_files")
                    .cloned(),
                image: row.image.clone(),
                running: row.state.eq_ignore_ascii_case("running"),
            });
        }
    }
    Ok(aggregate_compose(rows))
}

// ---------------------------------------------------------------------------
// 解析与工具
// ---------------------------------------------------------------------------

/// `docker ps --format '{{json .}}'` 单行结构（字段为字符串）。
#[derive(Debug, Deserialize)]
struct PsRow {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Names", default)]
    names: String,
    #[serde(rename = "Image", default)]
    image: String,
    #[serde(rename = "State", default)]
    state: String,
    #[serde(rename = "Status", default)]
    status: String,
    #[serde(rename = "Ports", default)]
    ports: String,
    #[serde(rename = "Networks", default)]
    networks: String,
    #[serde(rename = "Labels", default)]
    labels: String,
}

impl PsRow {
    fn into_summary(self) -> DockerContainerSummary {
        let running = self.state.eq_ignore_ascii_case("running") || self.status.starts_with("Up");
        let name = self
            .names
            .split(',')
            .next()
            .map(normalize_name)
            .unwrap_or_default();
        let ports = self
            .ports
            .split(',')
            .filter_map(|p| parse_port(p.trim()))
            .collect();
        let networks = self
            .networks
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "-")
            .collect();
        DockerContainerSummary {
            short_id: short_id(&self.id),
            id: self.id,
            name,
            image: self.image,
            state: if self.state.is_empty() {
                if running {
                    "running".into()
                } else {
                    "exited".into()
                }
            } else {
                self.state.to_lowercase()
            },
            status_text: self.status,
            running,
            ports,
            networks,
            created_at: 0,
        }
    }
}

/// `docker images --format '{{json .}}'` 单行结构。
#[derive(Debug, Deserialize)]
struct ImageRow {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "Repository", default)]
    repository: String,
    #[serde(rename = "Tag", default)]
    tag: String,
    #[serde(rename = "Size", default)]
    size: String,
    #[serde(rename = "Containers", default)]
    containers: String,
}

impl ImageRow {
    fn into_summary(self) -> DockerImageSummary {
        let dangling = self.repository == "<none>" || self.tag == "<none>";
        DockerImageSummary {
            short_id: short_id(&self.id),
            id: self.id,
            repository: self.repository,
            tag: self.tag,
            size_bytes: human_size_to_bytes(&self.size),
            created_at: 0,
            containers: self.containers.parse().unwrap_or(-1),
            dangling,
        }
    }
}

/// 解析端口文本，如 `0.0.0.0:80->80/tcp` 或 `80/tcp`。
fn parse_port(text: &str) -> Option<DockerPort> {
    if text.is_empty() {
        return None;
    }
    let (mapping, proto) = text.rsplit_once('/').unwrap_or((text, "tcp"));
    if let Some((host, private)) = mapping.split_once("->") {
        let (ip, public) = host.rsplit_once(':').unwrap_or(("0.0.0.0", host));
        Some(DockerPort {
            private_port: private.trim().parse().ok()?,
            public_port: public.trim().parse().ok(),
            protocol: proto.to_string(),
            ip: Some(ip.to_string()),
        })
    } else {
        Some(DockerPort {
            private_port: mapping.trim().parse().ok()?,
            public_port: None,
            protocol: proto.to_string(),
            ip: None,
        })
    }
}

/// 解析 `k=v,k2=v2` 标签串。
fn parse_labels(text: &str) -> HashMap<String, String> {
    text.split(',')
        .filter_map(|kv| kv.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
        .collect()
}

/// 人类可读尺寸（docker SI，1000 进制）转字节。如 `142MB`、`1.2GB`、`0B`。
fn human_size_to_bytes(text: &str) -> i64 {
    let t = text.trim();
    if t.is_empty() || t == "N/A" {
        return 0;
    }
    let split = t.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let value: f64 = num.trim().parse().unwrap_or(0.0);
    let multiplier = match unit.trim().to_uppercase().as_str() {
        "B" | "" => 1.0,
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        // 兼容二进制单位写法
        "KIB" => 1_024.0,
        "MIB" => 1_048_576.0,
        "GIB" => 1_073_741_824.0,
        _ => 1.0,
    };
    (value * multiplier) as i64
}

/// 从 `docker image prune` 输出解析释放空间。
fn parse_reclaimed_space(text: &str) -> i64 {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("Total reclaimed space:"))
        .map(|s| human_size_to_bytes(s.trim()))
        .unwrap_or(0)
}

/// 把远端错误文本归类为可定位的连接/权限错误。
fn classify_docker_error(detail: &str) -> (DockerConnectionStatus, String) {
    let lower = detail.to_lowercase();
    if lower.contains("command not found") || lower.contains("not found") {
        (
            DockerConnectionStatus::Offline,
            "远端未安装 docker 或不在 PATH 中".to_string(),
        )
    } else if lower.contains("permission denied") || lower.contains("dial unix") {
        (
            DockerConnectionStatus::Degraded,
            "当前用户无权访问 Docker（需加入 docker 组或使用 sudo）".to_string(),
        )
    } else if lower.contains("cannot connect") || lower.contains("is the docker daemon running") {
        (
            DockerConnectionStatus::Offline,
            "远端 Docker 守护进程未运行".to_string(),
        )
    } else {
        (
            DockerConnectionStatus::Degraded,
            format!("Docker 探测失败：{}", detail.trim()),
        )
    }
}

fn docker_cli_error(context: &str, stderr: &str) -> OmniError {
    let (_, msg) = classify_docker_error(stderr);
    OmniError::new(ErrorCode::Internal, context.to_string()).with_cause(msg)
}

fn non_empty(s: &str) -> Option<String> {
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}

/// 极简 shell 单引号转义，避免容器 id/名称中的特殊字符。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_published_port() {
        let p = parse_port("0.0.0.0:443->443/tcp").unwrap();
        assert_eq!(p.private_port, 443);
        assert_eq!(p.public_port, Some(443));
        assert_eq!(p.protocol, "tcp");
        assert_eq!(p.ip.as_deref(), Some("0.0.0.0"));
    }

    #[test]
    fn parses_internal_only_port() {
        let p = parse_port("6379/tcp").unwrap();
        assert_eq!(p.private_port, 6379);
        assert_eq!(p.public_port, None);
    }

    #[test]
    fn parses_ps_row() {
        let line = r#"{"ID":"abc123def456","Names":"/nginx-proxy","Image":"nginx:1.25","State":"running","Status":"Up 3 days","Ports":"0.0.0.0:80->80/tcp, 0.0.0.0:443->443/tcp","Networks":"bridge","Labels":"com.docker.compose.project=app"}"#;
        let row: PsRow = serde_json::from_str(line).unwrap();
        let s = row.into_summary();
        assert_eq!(s.name, "nginx-proxy");
        assert!(s.running);
        assert_eq!(s.ports.len(), 2);
        assert_eq!(s.networks, vec!["bridge"]);
    }

    #[test]
    fn parses_human_sizes() {
        assert_eq!(human_size_to_bytes("0B"), 0);
        assert_eq!(human_size_to_bytes("142MB"), 142_000_000);
        assert_eq!(human_size_to_bytes("1.2GB"), 1_200_000_000);
        assert_eq!(human_size_to_bytes("N/A"), 0);
    }

    #[test]
    fn parses_reclaimed_space() {
        let text = "Deleted Images:\nuntagged: foo\n\nTotal reclaimed space: 1.2GB\n";
        assert_eq!(parse_reclaimed_space(text), 1_200_000_000);
    }

    #[test]
    fn classifies_permission_error() {
        let (status, _msg) = classify_docker_error("Got permission denied while trying to connect");
        assert_eq!(status, DockerConnectionStatus::Degraded);
    }
}
