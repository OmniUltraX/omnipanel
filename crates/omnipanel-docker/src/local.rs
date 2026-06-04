//! 本地 Docker Engine 适配器：基于 `bollard`，连接本机 Docker Desktop / Engine。

use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::query_parameters::{
    ListContainersOptionsBuilder, ListImagesOptionsBuilder, LogsOptionsBuilder,
    RemoveContainerOptionsBuilder, RemoveImageOptionsBuilder,
};
use futures::{Stream, StreamExt};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

/// 交互式 exec 会话的输出流（原始终端字节，已从 bollard `LogOutput` 提取）。
pub type DockerExecOutput = Pin<Box<dyn Stream<Item = OmniResult<Vec<u8>>> + Send>>;

/// 一个已附加的容器交互终端会话：持有 stdin 写端与用于 resize 的 Docker 句柄。
pub struct DockerExecSession {
    docker: Docker,
    exec_id: String,
    // 用 Mutex 包裹写端，使 DockerExecSession: Sync（Tauri 命令跨 await 借用要求）。
    input: Mutex<Pin<Box<dyn AsyncWrite + Send>>>,
}

impl DockerExecSession {
    /// 写入用户输入到容器 stdin。
    pub async fn write(&self, data: &[u8]) -> OmniResult<()> {
        let mut input = self.input.lock().await;
        input.write_all(data).await.map_err(|e| {
            OmniError::new(ErrorCode::Internal, "写入容器终端失败").with_cause(e.to_string())
        })?;
        input.flush().await.map_err(|e| {
            OmniError::new(ErrorCode::Internal, "刷新容器终端失败").with_cause(e.to_string())
        })
    }

    /// 调整容器 TTY 尺寸。
    pub async fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        self.docker
            .resize_exec(
                &self.exec_id,
                ResizeExecOptions {
                    height: rows,
                    width: cols,
                },
            )
            .await
            .map_err(map_bollard)
    }
}

use crate::compose::{ComposeContainerRow, aggregate_compose};
use crate::model::*;
use crate::{ContainerFilter, DockerAdapter, normalize_name, short_id};

const COMPOSE_PROJECT: &str = "com.docker.compose.project";
const COMPOSE_SERVICE: &str = "com.docker.compose.service";
const COMPOSE_WORKDIR: &str = "com.docker.compose.project.working_dir";
const COMPOSE_CONFIG: &str = "com.docker.compose.project.config_files";

/// 本地 Engine 适配器。持有一个 `bollard::Docker` 客户端（连接是惰性的，真正 IO 在调用时发生）。
pub struct LocalDockerAdapter {
    docker: Docker,
}

impl LocalDockerAdapter {
    /// 用本机默认方式连接（Unix socket / Windows 命名管道）。
    pub fn connect() -> OmniResult<Self> {
        let docker = Docker::connect_with_defaults().map_err(map_bollard_connect)?;
        Ok(Self { docker })
    }
}

impl LocalDockerAdapter {
    /// 在容器内创建交互式 exec 会话（tty）。返回会话句柄与原始输出流。
    /// 命令层负责把输出流通过 Tauri event 回传，并保存会话句柄用于写入/resize/关闭。
    pub async fn create_exec(
        &self,
        container: &str,
        cmd: Vec<String>,
        cols: u16,
        rows: u16,
    ) -> OmniResult<(DockerExecSession, DockerExecOutput)> {
        let config = CreateExecOptions {
            attach_stdin: Some(true),
            attach_stdout: Some(true),
            attach_stderr: Some(true),
            tty: Some(true),
            cmd: Some(cmd),
            ..Default::default()
        };
        let created = self
            .docker
            .create_exec(container, config)
            .await
            .map_err(map_bollard)?;
        let started = self
            .docker
            .start_exec(&created.id, None::<StartExecOptions>)
            .await
            .map_err(map_bollard)?;

        match started {
            StartExecResults::Attached { output, input } => {
                let _ = self
                    .docker
                    .resize_exec(
                        &created.id,
                        ResizeExecOptions {
                            height: rows,
                            width: cols,
                        },
                    )
                    .await;
                let mapped: DockerExecOutput = Box::pin(
                    output.map(|item| item.map(|log| exec_log_bytes(&log)).map_err(map_bollard)),
                );
                Ok((
                    DockerExecSession {
                        docker: self.docker.clone(),
                        exec_id: created.id,
                        input: Mutex::new(input),
                    },
                    mapped,
                ))
            }
            StartExecResults::Detached => {
                Err(OmniError::new(ErrorCode::Internal, "exec 会话未附加到终端"))
            }
        }
    }

    /// 流式跟随容器日志，逐行回调 `sink`，直到流结束或 `stop` 置位。
    /// `follow=true` 时持续跟随；命令层在独立任务中驱动，把每行通过 Tauri event 回传前端。
    pub async fn stream_logs<F>(
        &self,
        id: &str,
        tail: i64,
        follow: bool,
        stop: Arc<AtomicBool>,
        mut sink: F,
    ) -> OmniResult<()>
    where
        F: FnMut(DockerLogLine) + Send,
    {
        let options = LogsOptionsBuilder::default()
            .stdout(true)
            .stderr(true)
            .follow(follow)
            .timestamps(false)
            .tail(&tail.to_string())
            .build();
        let mut stream = self.docker.logs(id, Some(options));
        while let Some(item) = stream.next().await {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let log = item.map_err(map_bollard)?;
            let (stream_name, bytes) = split_log_output(&log);
            let text = String::from_utf8_lossy(bytes);
            for line in text.split_inclusive('\n') {
                sink(DockerLogLine {
                    stream: stream_name.to_string(),
                    message: line.trim_end_matches(['\n', '\r']).to_string(),
                });
            }
        }
        Ok(())
    }
}

/// bollard 连接类错误 → OmniError（连通性问题）。
fn map_bollard_connect(err: bollard::errors::Error) -> OmniError {
    OmniError::new(ErrorCode::Connection, "无法连接本地 Docker Engine").with_cause(err.to_string())
}

/// bollard 操作类错误 → OmniError。
fn map_bollard(err: bollard::errors::Error) -> OmniError {
    let msg = err.to_string();
    // Docker 守护进程不可用时归类为连接错误，其余归类内部错误。
    if msg.contains("error trying to connect") || msg.contains("No such file or directory") {
        OmniError::new(ErrorCode::Connection, "Docker 未安装或未启动").with_cause(msg)
    } else {
        OmniError::new(ErrorCode::Internal, "Docker 操作失败").with_cause(msg)
    }
}

#[async_trait]
impl DockerAdapter for LocalDockerAdapter {
    async fn probe(&self) -> OmniResult<DockerProbe> {
        match self.docker.version().await {
            Ok(v) => Ok(DockerProbe {
                status: DockerConnectionStatus::Online,
                engine_version: v.version,
                api_version: v.api_version,
                capabilities: DockerCapabilities::full(DockerConnectionSource::LocalEngine),
                warning_message: None,
            }),
            Err(e) => Ok(DockerProbe {
                status: DockerConnectionStatus::Offline,
                engine_version: None,
                api_version: None,
                capabilities: DockerCapabilities::full(DockerConnectionSource::LocalEngine),
                warning_message: Some(format!("Docker 未安装或未启动：{e}")),
            }),
        }
    }

    async fn overview(&self) -> OmniResult<DockerOverview> {
        let containers = self.list_containers(ContainerFilter::All).await?;
        let running = containers.iter().filter(|c| c.running).count() as u32;
        let total = containers.len() as u32;
        let images = self
            .list_images()
            .await
            .map(|i| i.len() as u32)
            .unwrap_or(0);
        let version = self.docker.version().await.ok();
        Ok(DockerOverview {
            capabilities: DockerCapabilities::full(DockerConnectionSource::LocalEngine),
            summary: DockerResourceSummary {
                containers_total: total,
                containers_running: running,
                containers_stopped: total - running,
                images,
            },
            engine_version: version.and_then(|v| v.version),
            warning_message: None,
        })
    }

    async fn list_containers(
        &self,
        filter: ContainerFilter,
    ) -> OmniResult<Vec<DockerContainerSummary>> {
        let options = ListContainersOptionsBuilder::default()
            .all(filter.include_all())
            .build();
        let raw = self
            .docker
            .list_containers(Some(options))
            .await
            .map_err(map_bollard)?;

        let mut out = Vec::with_capacity(raw.len());
        for c in raw {
            let summary = to_container_summary(c);
            if filter.matches(summary.running) {
                out.push(summary);
            }
        }
        Ok(out)
    }

    async fn inspect_container(&self, id: &str) -> OmniResult<DockerContainerDetail> {
        let raw = self
            .docker
            .inspect_container(id, None)
            .await
            .map_err(map_bollard)?;
        Ok(to_container_detail(raw))
    }

    async fn container_action(&self, id: &str, action: DockerContainerAction) -> OmniResult<()> {
        match action {
            DockerContainerAction::Start => self
                .docker
                .start_container(id, None)
                .await
                .map_err(map_bollard),
            DockerContainerAction::Stop => self
                .docker
                .stop_container(id, None)
                .await
                .map_err(map_bollard),
            DockerContainerAction::Restart => self
                .docker
                .restart_container(id, None)
                .await
                .map_err(map_bollard),
            DockerContainerAction::Kill => self
                .docker
                .kill_container(id, None)
                .await
                .map_err(map_bollard),
            DockerContainerAction::Pause => {
                self.docker.pause_container(id).await.map_err(map_bollard)
            }
            DockerContainerAction::Unpause => {
                self.docker.unpause_container(id).await.map_err(map_bollard)
            }
            DockerContainerAction::Remove => {
                let options = RemoveContainerOptionsBuilder::default().force(true).build();
                self.docker
                    .remove_container(id, Some(options))
                    .await
                    .map_err(map_bollard)
            }
        }
    }

    async fn container_logs(&self, id: &str, tail: i64) -> OmniResult<Vec<DockerLogLine>> {
        let options = LogsOptionsBuilder::default()
            .stdout(true)
            .stderr(true)
            .timestamps(false)
            .tail(&tail.to_string())
            .build();
        let mut stream = self.docker.logs(id, Some(options));
        let mut lines = Vec::new();
        while let Some(item) = stream.next().await {
            let log = item.map_err(map_bollard)?;
            let (stream_name, bytes) = split_log_output(&log);
            let text = String::from_utf8_lossy(bytes);
            for line in text.split_inclusive('\n') {
                lines.push(DockerLogLine {
                    stream: stream_name.to_string(),
                    message: line.trim_end_matches(['\n', '\r']).to_string(),
                });
            }
        }
        Ok(lines)
    }

    async fn list_images(&self) -> OmniResult<Vec<DockerImageSummary>> {
        let options = ListImagesOptionsBuilder::default().all(false).build();
        let raw = self
            .docker
            .list_images(Some(options))
            .await
            .map_err(map_bollard)?;
        Ok(raw.into_iter().flat_map(to_image_summaries).collect())
    }

    async fn remove_image(&self, id: &str, force: bool) -> OmniResult<()> {
        let options = RemoveImageOptionsBuilder::default().force(force).build();
        self.docker
            .remove_image(id, Some(options), None)
            .await
            .map_err(map_bollard)?;
        Ok(())
    }

    async fn prune_images(&self) -> OmniResult<DockerPruneResult> {
        let res = self
            .docker
            .prune_images(None::<bollard::query_parameters::PruneImagesOptions>)
            .await
            .map_err(map_bollard)?;
        let deleted = res
            .images_deleted
            .unwrap_or_default()
            .into_iter()
            .filter_map(|d| d.deleted.or(d.untagged))
            .collect();
        Ok(DockerPruneResult {
            deleted,
            freed_space_bytes: res.space_reclaimed.unwrap_or(0),
        })
    }

    async fn list_compose_projects(&self) -> OmniResult<Vec<DockerComposeProject>> {
        let options = ListContainersOptionsBuilder::default().all(true).build();
        let raw = self
            .docker
            .list_containers(Some(options))
            .await
            .map_err(map_bollard)?;

        let rows: Vec<ComposeContainerRow> = raw
            .into_iter()
            .filter_map(|c| {
                let labels = c.labels.clone().unwrap_or_default();
                let project = labels.get(COMPOSE_PROJECT)?.clone();
                let service = labels
                    .get(COMPOSE_SERVICE)
                    .cloned()
                    .unwrap_or_else(|| "default".to_string());
                let running = c
                    .status
                    .as_deref()
                    .map(|s| s.starts_with("Up"))
                    .unwrap_or(false);
                Some(ComposeContainerRow {
                    project,
                    service,
                    working_dir: labels.get(COMPOSE_WORKDIR).cloned(),
                    config_files: labels.get(COMPOSE_CONFIG).cloned(),
                    image: c.image.clone().unwrap_or_default(),
                    running,
                })
            })
            .collect();

        Ok(aggregate_compose(rows))
    }
}

/// 提取 `LogOutput` 的原始字节（用于 tty exec，不区分 stdout/stderr）。
fn exec_log_bytes(log: &LogOutput) -> Vec<u8> {
    match log {
        LogOutput::StdErr { message }
        | LogOutput::StdOut { message }
        | LogOutput::StdIn { message }
        | LogOutput::Console { message } => message.to_vec(),
    }
}

/// 拆分 bollard `LogOutput` 为 (stream 名, 字节)。
fn split_log_output(log: &LogOutput) -> (&'static str, &[u8]) {
    match log {
        LogOutput::StdErr { message } => ("stderr", message),
        LogOutput::StdOut { message } => ("stdout", message),
        LogOutput::StdIn { message } => ("stdout", message),
        LogOutput::Console { message } => ("stdout", message),
    }
}

fn to_container_summary(c: bollard::models::ContainerSummary) -> DockerContainerSummary {
    let id = c.id.unwrap_or_default();
    let name = c
        .names
        .as_ref()
        .and_then(|n| n.first())
        .map(|n| normalize_name(n))
        .unwrap_or_else(|| short_id(&id));
    let status_text = c.status.clone().unwrap_or_default();
    let state = c
        .state
        .as_ref()
        .map(|s| format!("{s:?}").to_lowercase())
        .unwrap_or_else(|| status_text.clone());
    let running = state == "running" || status_text.starts_with("Up");
    let ports = c
        .ports
        .unwrap_or_default()
        .into_iter()
        .map(|p| DockerPort {
            private_port: p.private_port,
            public_port: p.public_port,
            protocol: p
                .typ
                .map(|t| format!("{t:?}").to_lowercase())
                .unwrap_or_else(|| "tcp".into()),
            ip: p.ip,
        })
        .collect();
    let networks = c
        .network_settings
        .and_then(|n| n.networks)
        .map(|m| m.into_keys().collect())
        .unwrap_or_default();

    DockerContainerSummary {
        short_id: short_id(&id),
        id,
        name,
        image: c.image.unwrap_or_default(),
        state,
        status_text,
        running,
        ports,
        networks,
        created_at: c.created.unwrap_or(0),
    }
}

pub(crate) fn to_container_detail(
    c: bollard::models::ContainerInspectResponse,
) -> DockerContainerDetail {
    let id = c.id.unwrap_or_default();
    let name = c
        .name
        .as_deref()
        .map(normalize_name)
        .unwrap_or_else(|| short_id(&id));
    let state = c.state.as_ref();
    let running = state.and_then(|s| s.running).unwrap_or(false);
    let exit_code = state.and_then(|s| s.exit_code);
    let status_text = state
        .and_then(|s| s.status.as_ref())
        .map(|s| format!("{s:?}"))
        .unwrap_or_default();
    let config = c.config.as_ref();
    let image = config.and_then(|cfg| cfg.image.clone()).unwrap_or_default();
    let command = config.and_then(|cfg| cfg.cmd.as_ref()).map(|c| c.join(" "));
    let env = config
        .and_then(|cfg| cfg.env.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|kv| {
            let (key, value) = kv.split_once('=').unwrap_or((kv.as_str(), ""));
            DockerKeyValue {
                key: key.to_string(),
                value: value.to_string(),
            }
        })
        .collect();
    let restart_policy = c
        .host_config
        .as_ref()
        .and_then(|h| h.restart_policy.as_ref())
        .and_then(|p| p.name.as_ref())
        .map(|n| format!("{n:?}").to_lowercase());
    let mounts = c
        .mounts
        .unwrap_or_default()
        .into_iter()
        .map(|m| DockerMount {
            kind: m
                .typ
                .map(|t| format!("{t:?}").to_lowercase())
                .unwrap_or_default(),
            source: m.source.unwrap_or_default(),
            destination: m.destination.unwrap_or_default(),
            read_only: !m.rw.unwrap_or(true),
        })
        .collect();
    let networks = c
        .network_settings
        .and_then(|n| n.networks)
        .unwrap_or_default()
        .into_iter()
        .map(|(name, ep)| DockerNetworkAttachment {
            name,
            ip_address: ep.ip_address.filter(|s| !s.is_empty()),
        })
        .collect();

    let summary = DockerContainerSummary {
        short_id: short_id(&id),
        id,
        name,
        image,
        state: if running {
            "running".into()
        } else {
            status_text.to_lowercase()
        },
        status_text,
        running,
        ports: Vec::new(),
        networks: Vec::new(),
        created_at: 0,
    };

    DockerContainerDetail {
        summary,
        command,
        restart_policy,
        exit_code,
        env,
        mounts,
        networks,
    }
}

/// 一个 bollard 镜像可能有多个 repo_tag，拆成多行展示。
fn to_image_summaries(img: bollard::models::ImageSummary) -> Vec<DockerImageSummary> {
    let id = img.id.clone();
    let sid = short_id(&id);
    let tags = if img.repo_tags.is_empty() {
        vec!["<none>:<none>".to_string()]
    } else {
        img.repo_tags.clone()
    };
    tags.into_iter()
        .map(|full| {
            let (repo, tag) = full.rsplit_once(':').unwrap_or((full.as_str(), "<none>"));
            let dangling = repo == "<none>" || tag == "<none>";
            DockerImageSummary {
                id: id.clone(),
                short_id: sid.clone(),
                repository: repo.to_string(),
                tag: tag.to_string(),
                size_bytes: img.size,
                created_at: img.created,
                containers: img.containers,
                dangling,
            }
        })
        .collect()
}
