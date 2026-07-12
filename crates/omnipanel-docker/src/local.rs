//! 本地 Docker Engine 适配器：基于 `bollard`，连接本机 Docker Desktop / Engine。

use std::io::Read;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use bollard::Docker;
use bollard::container::LogOutput;
use bollard::exec::{CreateExecOptions, ResizeExecOptions, StartExecOptions, StartExecResults};
use bollard::query_parameters::{
    BuildImageOptionsBuilder, CreateImageOptionsBuilder, ListContainersOptionsBuilder,
    ListImagesOptionsBuilder, ListNetworksOptionsBuilder, ListVolumesOptionsBuilder,
    LogsOptionsBuilder, PushImageOptionsBuilder, RemoveContainerOptionsBuilder,
    RemoveImageOptionsBuilder, RemoveVolumeOptionsBuilder, StatsOptionsBuilder,
    TagImageOptionsBuilder,
};
use bytes::Bytes;
use futures::{Stream, StreamExt};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshPtySession;
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio::sync::Mutex;

/// 交互式 exec 会话的输出流（原始终端字节，已从 bollard `LogOutput` 提取）。
pub type DockerExecOutput = Pin<Box<dyn Stream<Item = OmniResult<Vec<u8>>> + Send>>;

/// 一个已附加的容器交互终端会话。
/// 本地 Engine 走 bollard `exec`；SSH 宿主机走 [`SshPtySession`]（远端 `docker exec -it`）。
pub enum DockerExecSession {
    /// bollard 本地 exec：持有 Docker 句柄与 stdin 写端。
    Local {
        docker: Docker,
        exec_id: String,
        input: Mutex<Pin<Box<dyn AsyncWrite + Send>>>,
    },
    /// SSH 宿主机 PTY exec：复用 omnipanel-ssh 的 SshPtySession。
    Ssh(SshPtySession),
}

impl DockerExecSession {
    /// 写入用户输入到容器 stdin。
    pub async fn write(&self, data: &[u8]) -> OmniResult<()> {
        match self {
            Self::Local { input, .. } => {
                let mut input = input.lock().await;
                input.write_all(data).await.map_err(|e| {
                    OmniError::new(ErrorCode::Internal, "写入容器终端失败")
                        .with_cause(e.to_string())
                })?;
                input.flush().await.map_err(|e| {
                    OmniError::new(ErrorCode::Internal, "刷新容器终端失败")
                        .with_cause(e.to_string())
                })?;
                Ok(())
            }
            Self::Ssh(pty) => pty.write(data).await,
        }
    }

    /// 调整容器 TTY 尺寸。
    pub async fn resize(&self, cols: u16, rows: u16) -> OmniResult<()> {
        match self {
            Self::Local {
                docker, exec_id, ..
            } => docker
                .resize_exec(
                    exec_id,
                    ResizeExecOptions {
                        height: rows,
                        width: cols,
                    },
                )
                .await
                .map_err(map_bollard),
            Self::Ssh(pty) => pty.resize(cols, rows).await,
        }
    }

    /// 关闭会话并释放底层 SSH exec / bollard 资源。
    pub async fn close(self) -> OmniResult<()> {
        match self {
            Self::Local { .. } => Ok(()),
            Self::Ssh(pty) => pty.close().await,
        }
    }
}

use crate::compose::{ComposeContainerRow, aggregate_compose};
use crate::model::*;
use crate::{ContainerFilter, DockerAdapter, normalize_name, short_id};

/// 把 `repo:tag` 拆成 (repo, tag)；无 `:` 时 tag 默认为 "latest"。
fn split_image_ref(image: &str) -> (&str, &str) {
    match image.rsplit_once(':') {
        Some((repo, tag)) => (repo, tag),
        None => (image, "latest"),
    }
}

/// 把 `context_dir` 打包成 tar 的分块 Vec（64KiB/块）。用于本地 bollard `/build` 上传。
/// 此实现一次性完成 tar 写入；中等大小项目（数 GB 内）够用。
fn tar_directory_chunks(dir: &std::path::Path) -> std::io::Result<Vec<Vec<u8>>> {
    let mut tar = tar::Builder::new(Vec::<u8>::new());
    for entry in walkdir::WalkDir::new(dir).follow_links(false).into_iter() {
        let entry = entry?;
        let path = entry.path();
        let rel = path.strip_prefix(dir).unwrap_or(path);
        if rel.as_os_str().is_empty() {
            continue;
        }
        let metadata = entry.metadata()?;
        if metadata.is_file() {
            // 文件：tar append 后再清空 Builder buffer
            tar.append_path_with_name(path, rel)?;
        } else if metadata.is_dir() {
            tar.append_dir(rel, path)?;
        }
    }
    let bytes = tar
        .into_inner()
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;
    const CHUNK: usize = 64 * 1024;
    let chunks = bytes.chunks(CHUNK).map(|c| c.to_vec()).collect::<Vec<_>>();
    Ok(chunks)
}

/// 计算 `current / total` 比例；缺任一项时返回 None。
fn progress_ratio(p: Option<&bollard::models::ProgressDetail>) -> Option<f64> {
    let p = p?;
    let c = p.current? as f64;
    let t = p.total? as f64;
    if t <= 0.0 {
        None
    } else {
        Some((c / t).clamp(0.0, 1.0))
    }
}

/// 渲染 `45.6MB / 120MB` 风格描述；缺任一项时退化为单值。
fn progress_detail_str(p: Option<&bollard::models::ProgressDetail>) -> Option<String> {
    let p = p?;
    let c = p.current?;
    let t = p.total?;
    Some(format!("{} / {}", human_bytes(c), human_bytes(t)))
}

fn human_bytes(bytes: i64) -> String {
    let b = bytes.max(0) as f64;
    if b < 1024.0 {
        format!("{:.0} B", b)
    } else if b < 1024.0 * 1024.0 {
        format!("{:.1} KB", b / 1024.0)
    } else if b < 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} MB", b / 1024.0 / 1024.0)
    } else {
        format!("{:.2} GB", b / 1024.0 / 1024.0 / 1024.0)
    }
}

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

    /// 用一个已构造好的 bollard 客户端构造适配器。
    /// 远程 Engine（TCP / TLS）走这条路：上层用 `bollard::Docker::connect_with_*` 构造客户端，
    /// 适配器本身不关心连接来源，从而本地/远程走同一份实现。
    pub fn with_docker(docker: Docker) -> Self {
        Self { docker }
    }

    /// 取出底层 bollard 客户端（用于命令层把 adapter 拆成连接引用与目标）。
    pub fn into_docker(self) -> Docker {
        self.docker
    }

    /// 构造远程 Engine（明文 HTTP）适配器。
    pub fn connect_remote_http(host: &str, port: u16) -> OmniResult<Self> {
        let url = format!("http://{host}:{port}");
        let docker = Docker::connect_with_http(&url, 4, bollard::API_DEFAULT_VERSION)
            .map_err(map_bollard_connect)?;
        Ok(Self { docker })
    }

    /// 构造远程 Engine（TLS）适配器。证书以 PEM 字符串传入。
    /// 内部把 PEM 写到临时文件后调用 bollard 的 `connect_with_ssl`（其签名要求 `&Path`）。
    pub fn connect_remote_https(
        host: &str,
        port: u16,
        ca_pem: Option<&str>,
        client_cert_pem: Option<&str>,
        client_key_pem: Option<&str>,
    ) -> OmniResult<Self> {
        let url = format!("https://{host}:{port}");
        // 任何 cert 缺失时，写一个空 PEM 文件，bollard 允许这种"无校验"用法。
        let dir = tempfile::tempdir().map_err(|e| {
            OmniError::new(ErrorCode::Internal, "无法创建临时目录以保存 TLS 证书")
                .with_cause(e.to_string())
        })?;
        let ca_path = write_pem(&dir, "ca.pem", ca_pem)?;
        let cert_path = write_pem(&dir, "client.cert.pem", client_cert_pem)?;
        let key_path = write_pem(&dir, "client.key.pem", client_key_pem)?;
        let docker = Docker::connect_with_ssl(
            &url,
            &key_path,
            &cert_path,
            &ca_path,
            4,
            bollard::API_DEFAULT_VERSION,
        )
        .map_err(map_bollard_connect)?;
        // dir 在函数返回时被 drop，临时文件随之清理；这与 `connect_with_ssl` 在启动连接后
        // 不再读盘的行为一致。drop 的 dir 在最后一行后发生，但 docker 客户端已持有连接配置。
        Ok(Self { docker })
    }
}

/// 把 PEM 字符串写入临时目录下的固定文件名。若 PEM 为空，写空文件以满足 bollard 的 `&Path` 签名。
fn write_pem(
    dir: &tempfile::TempDir,
    name: &str,
    pem: Option<&str>,
) -> OmniResult<std::path::PathBuf> {
    let path = dir.path().join(name);
    let content = pem.unwrap_or("");
    std::fs::write(&path, content).map_err(|e| {
        OmniError::new(ErrorCode::Internal, format!("写入 TLS 证书 {name} 失败"))
            .with_cause(e.to_string())
    })?;
    Ok(path)
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
                    DockerExecSession::Local {
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

    /// 流式容器 stats。回调 `sink` 持续接收统计快照，直到 `stop` 置位。
    pub async fn stream_stats<F>(
        &self,
        container_id: &str,
        stop: Arc<AtomicBool>,
        mut sink: F,
    ) -> OmniResult<()>
    where
        F: FnMut(DockerContainerStats),
    {
        let options = StatsOptionsBuilder::default()
            .stream(true)
            .one_shot(false)
            .build();
        let stream = self.docker.stats(container_id, Some(options));
        tokio::pin!(stream);
        while let Some(item) = stream.next().await {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match item {
                Ok(s) => sink(convert_stats(container_id, &s)),
                Err(e) => return Err(map_bollard(e)),
            }
        }
        Ok(())
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

/// 解析 ISO-8601 时间字符串为 Unix 毫秒。
///
/// bollard 多数场景下使用 `String` 而非强类型时间，因此这里手动解析。
/// 返回 0 表示无值或解析失败（前端按 `-` 渲染）。
fn parse_iso_to_unix_ms(s: Option<&str>) -> i64 {
    let Some(s) = s else { return 0 };
    // 形如 "2024-05-01T12:34:56.789Z" 或 "2024-05-01 12:34:56 +0000 UTC"
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(trimmed) {
        return dt.timestamp_millis();
    }
    // 退化：尝试 "YYYY-MM-DD HH:MM:SS"
    if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%d %H:%M:%S") {
        return naive.and_utc().timestamp_millis();
    }
    0
}

/// 把 bollard 的 `ContainerStatsResponse` 收敛成本 crate 的 `DockerContainerStats`。
fn convert_stats(
    fallback_id: &str,
    s: &bollard::models::ContainerStatsResponse,
) -> DockerContainerStats {
    let id = s.id.clone().unwrap_or_else(|| fallback_id.to_string());
    let name = s
        .name
        .clone()
        .unwrap_or_else(|| id.clone())
        .trim_start_matches('/')
        .to_string();
    let cpu_percent = cpu_percent(s);
    let (mem_usage, mem_limit, mem_percent) = memory_stats(s);
    let (rx, tx) = network_stats(s);
    let (blk_r, blk_w) = blkio_stats(s);
    // 简化：`read` 字段类型依赖 bollard-stubs feature，这里统一用 wall clock，
    // 对实时监控精度影响可忽略。
    let ts_ms = chrono_like_now_ms();
    DockerContainerStats {
        container_id: id,
        name,
        cpu_percent,
        memory_usage_bytes: mem_usage,
        memory_limit_bytes: mem_limit,
        memory_percent: mem_percent,
        net_rx_bytes: rx,
        net_tx_bytes: tx,
        block_read_bytes: blk_r,
        block_write_bytes: blk_w,
        timestamp_ms: ts_ms,
    }
}

fn cpu_percent(s: &bollard::models::ContainerStatsResponse) -> f64 {
    let cpu = match s.cpu_stats.as_ref() {
        Some(c) => c,
        None => return 0.0,
    };
    let precpu = match s.precpu_stats.as_ref() {
        Some(c) => c,
        None => return 0.0,
    };
    let cpu_total = cpu
        .cpu_usage
        .as_ref()
        .and_then(|u| u.total_usage)
        .unwrap_or(0) as f64;
    let pre_total = precpu
        .cpu_usage
        .as_ref()
        .and_then(|u| u.total_usage)
        .unwrap_or(0) as f64;
    let cpu_sys = cpu.system_cpu_usage.unwrap_or(0) as f64;
    let pre_sys = precpu.system_cpu_usage.unwrap_or(0) as f64;
    let delta_cpu = cpu_total - pre_total;
    let delta_sys = cpu_sys - pre_sys;
    let n_cpus = cpu
        .online_cpus
        .or_else(|| {
            cpu.cpu_usage
                .as_ref()
                .and_then(|u| u.percpu_usage.as_ref().map(|v| v.len() as u32))
        })
        .unwrap_or(1)
        .max(1) as f64;
    if delta_sys <= 0.0 {
        0.0
    } else {
        ((delta_cpu / delta_sys) * n_cpus * 100.0).clamp(0.0, 100.0 * n_cpus)
    }
}

fn memory_stats(s: &bollard::models::ContainerStatsResponse) -> (i64, Option<i64>, f64) {
    let m = match s.memory_stats.as_ref() {
        Some(m) => m,
        None => return (0, None, 0.0),
    };
    let usage = m.usage.unwrap_or(0);
    let limit = m.limit.map(|l| l as i64);
    // cgroup v1: `stats` map contains "total_inactive_file"；
    // cgroup v2: 包含 "inactive_file"；都尝试以兼容。
    let total_inactive: u64 = m
        .stats
        .as_ref()
        .and_then(|sm| {
            sm.get("total_inactive_file")
                .or_else(|| sm.get("inactive_file"))
                .copied()
        })
        .unwrap_or(0);
    let used: i64 = (usage.saturating_sub(total_inactive) as i64).max(0);
    let percent = match limit {
        Some(l) if l > 0 => (used as f64 / l as f64) * 100.0,
        _ => 0.0,
    };
    (used, limit, percent.clamp(0.0, 100.0))
}

fn network_stats(s: &bollard::models::ContainerStatsResponse) -> (i64, i64) {
    let nets = match s.networks.as_ref() {
        Some(n) => n,
        None => return (0, 0),
    };
    let mut rx = 0i64;
    let mut tx = 0i64;
    for n in nets.values() {
        rx = rx.saturating_add(n.rx_bytes.unwrap_or(0) as i64);
        tx = tx.saturating_add(n.tx_bytes.unwrap_or(0) as i64);
    }
    (rx, tx)
}

fn blkio_stats(s: &bollard::models::ContainerStatsResponse) -> (i64, i64) {
    let b = match s.blkio_stats.as_ref() {
        Some(b) => b,
        None => return (0, 0),
    };
    let mut r = 0i64;
    let mut w = 0i64;
    if let Some(svc) = b.io_service_bytes_recursive.as_ref() {
        for entry in svc {
            if let (Some(op), Some(val)) = (entry.op.as_deref(), entry.value) {
                match op {
                    "read" | "Read" => r = r.saturating_add(val as i64),
                    "write" | "Write" => w = w.saturating_add(val as i64),
                    _ => {}
                }
            }
        }
    }
    (r, w)
}

/// 退化路径：当 `read` 字段为空（部分边缘情况）时，用系统时间代替。
fn chrono_like_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
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

fn map_disk_usage_item(
    total_size: Option<i64>,
    reclaimable: Option<i64>,
    total_count: Option<i64>,
    active_count: Option<i64>,
) -> DockerDiskUsageItem {
    DockerDiskUsageItem {
        size_bytes: total_size.unwrap_or(0),
        reclaimable_bytes: reclaimable.unwrap_or(0),
        total_count: total_count.unwrap_or(0),
        active_count: active_count.unwrap_or(0),
    }
}

fn map_system_data_usage(resp: bollard::models::SystemDataUsageResponse) -> DockerSystemDiskUsage {
    DockerSystemDiskUsage {
        images: resp
            .image_usage
            .as_ref()
            .map(|u| {
                map_disk_usage_item(u.total_size, u.reclaimable, u.total_count, u.active_count)
            })
            .unwrap_or_default(),
        containers: resp
            .container_usage
            .as_ref()
            .map(|u| {
                map_disk_usage_item(u.total_size, u.reclaimable, u.total_count, u.active_count)
            })
            .unwrap_or_default(),
        volumes: resp
            .volume_usage
            .as_ref()
            .map(|u| {
                map_disk_usage_item(u.total_size, u.reclaimable, u.total_count, u.active_count)
            })
            .unwrap_or_default(),
        build_cache: resp
            .build_cache_usage
            .as_ref()
            .map(|u| {
                map_disk_usage_item(u.total_size, u.reclaimable, u.total_count, u.active_count)
            })
            .unwrap_or_default(),
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

    async fn create_container(&self, req: &DockerCreateContainerRequest) -> OmniResult<String> {
        use bollard::models::{ContainerCreateBody, HostConfig, PortBinding, PortMap};
        use bollard::query_parameters::CreateContainerOptions;
        use std::collections::HashMap;

        let mut host_config = HostConfig::default();

        // Port mappings: "8080:80/tcp" → port_bindings
        if !req.ports.is_empty() {
            let mut port_map: PortMap = HashMap::new();
            for mapping in &req.ports {
                let parts: Vec<&str> = mapping.split(':').collect();
                if parts.len() >= 2 {
                    let host_port = parts[0].to_string();
                    let container_part = parts[1];
                    let (container_port, proto) =
                        if let Some((p, pr)) = container_part.split_once('/') {
                            (p.to_string(), pr.to_string())
                        } else {
                            (container_part.to_string(), "tcp".to_string())
                        };
                    let key = format!("{}/{}", container_port, proto);
                    port_map
                        .entry(key)
                        .or_insert_with(|| Some(vec![]))
                        .as_mut()
                        .unwrap()
                        .push(PortBinding {
                            host_ip: Some("0.0.0.0".to_string()),
                            host_port: Some(host_port),
                            ..Default::default()
                        });
                }
            }
            host_config.port_bindings = Some(port_map);
        }

        // Volume binds: "/host:/container[:ro]"
        if !req.volumes.is_empty() {
            host_config.binds = Some(req.volumes.clone());
        }

        // Restart policy
        if let Some(ref policy) = req.restart_policy {
            let name = match policy.as_str() {
                "always" => bollard::models::RestartPolicyNameEnum::ALWAYS,
                "on-failure" => bollard::models::RestartPolicyNameEnum::ON_FAILURE,
                "unless-stopped" => bollard::models::RestartPolicyNameEnum::UNLESS_STOPPED,
                _ => bollard::models::RestartPolicyNameEnum::EMPTY,
            };
            host_config.restart_policy = Some(bollard::models::RestartPolicy {
                name: Some(name),
                ..Default::default()
            });
        }

        if req.auto_remove {
            host_config.auto_remove = Some(true);
        }

        // Build networking config
        let networking_config = req.network.as_ref().map(|net| {
            use bollard::models::{EndpointSettings, NetworkingConfig};
            let mut endpoints = HashMap::new();
            endpoints.insert(net.clone(), EndpointSettings::default());
            NetworkingConfig {
                endpoints_config: Some(endpoints),
            }
        });

        let config = ContainerCreateBody {
            image: Some(req.image.clone()),
            env: if req.env.is_empty() {
                None
            } else {
                Some(req.env.clone())
            },
            cmd: req.cmd.clone(),
            host_config: Some(host_config),
            networking_config,
            ..Default::default()
        };

        let options = req.name.as_ref().map(|n| CreateContainerOptions {
            name: Some(n.clone()),
            ..Default::default()
        });

        let resp = self
            .docker
            .create_container(options, config)
            .await
            .map_err(map_bollard)?;

        Ok(resp.id)
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

    async fn inspect_image(&self, id: &str) -> OmniResult<DockerImageDetail> {
        let raw = self.docker.inspect_image(id).await.map_err(map_bollard)?;
        let cfg = raw.config.clone().unwrap_or_default();
        let env = cfg.env.clone().unwrap_or_default();
        let labels_map = cfg.labels.clone().unwrap_or_default();
        let exposed = cfg.exposed_ports.clone().unwrap_or_default();
        let volumes = cfg.volumes.clone().unwrap_or_default();
        let config = DockerImageConfig {
            env,
            cmd: cfg.cmd.clone().map(|v| v.join(" ")),
            entrypoint: cfg.entrypoint.clone().map(|v| v.join(" ")),
            working_dir: cfg.working_dir.clone(),
            user: cfg.user.clone(),
            exposed_ports: exposed,
            labels: labels_map
                .into_iter()
                .map(|(k, v)| DockerKeyValue { key: k, value: v })
                .collect(),
            volumes,
        };
        let repo_tags = raw.repo_tags.clone().unwrap_or_default();
        Ok(DockerImageDetail {
            id: raw.id.clone().unwrap_or_else(|| id.to_string()),
            repo_tags,
            architecture: raw.architecture,
            os: raw.os,
            driver: None,
            created_at: parse_iso_to_unix_ms(raw.created.as_deref()),
            size_bytes: raw.size.unwrap_or(0),
            author: raw.author,
            comment: raw.comment,
            config,
            history: Vec::new(),
        })
    }

    async fn image_history(&self, id: &str) -> OmniResult<Vec<DockerImageHistoryLayer>> {
        let raw = self.docker.image_history(id).await.map_err(map_bollard)?;
        Ok(raw
            .into_iter()
            .map(|h| DockerImageHistoryLayer {
                id: h.id,
                created_at: h.created.saturating_mul(1000),
                created_by: h.created_by,
                size_bytes: h.size,
                comment: h.comment,
                tags: h.tags,
            })
            .collect())
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

    async fn pull_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        let (name, tag) = split_image_ref(image);
        let options = CreateImageOptionsBuilder::default()
            .from_image(name)
            .tag(tag)
            .build();
        let mut stream = self.docker.create_image(Some(options), None, None);
        while let Some(item) = stream.next().await {
            let info = item.map_err(map_bollard)?;
            if let Some(error) = info.error_detail {
                let msg = error.message.unwrap_or_else(|| "拉取失败".into());
                return Err(OmniError::new(ErrorCode::Internal, "拉取镜像失败").with_cause(msg));
            }
            if let Some(s) = info.status.as_deref() {
                if let Some(cb) = progress.as_ref() {
                    cb(DockerImageProgress {
                        id: info.id.clone().unwrap_or_default(),
                        status: s.to_string(),
                        progress: progress_ratio(info.progress_detail.as_ref()),
                        detail: progress_detail_str(info.progress_detail.as_ref()),
                    });
                }
            }
        }
        Ok(DockerPullResult {
            image: name.to_string(),
            tag: tag.to_string(),
            digest: None,
        })
    }

    async fn push_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        let (name, tag) = split_image_ref(image);
        let options = PushImageOptionsBuilder::default().tag(tag).build();
        let mut stream = self.docker.push_image(name, Some(options), None);
        while let Some(item) = stream.next().await {
            let info = item.map_err(map_bollard)?;
            if let Some(error) = info.error_detail {
                let msg = error.message.unwrap_or_else(|| "推送失败".into());
                return Err(OmniError::new(ErrorCode::Internal, "推送镜像失败").with_cause(msg));
            }
            if let Some(s) = info.status.as_deref() {
                if let Some(cb) = progress.as_ref() {
                    cb(DockerImageProgress {
                        id: String::new(),
                        status: s.to_string(),
                        progress: progress_ratio(info.progress_detail.as_ref()),
                        detail: progress_detail_str(info.progress_detail.as_ref()),
                    });
                }
            }
        }
        Ok(DockerPullResult {
            image: name.to_string(),
            tag: tag.to_string(),
            digest: None,
        })
    }

    async fn tag_image(&self, source: &str, target: &str) -> OmniResult<()> {
        let (source_repo, source_tag) = split_image_ref(source);
        let (target_repo, _target_tag) = split_image_ref(target);
        let options = TagImageOptionsBuilder::default()
            .repo(source_repo)
            .tag(source_tag)
            .build();
        self.docker
            .tag_image(target_repo, Some(options))
            .await
            .map_err(map_bollard)
            .map(|_| ())
    }

    async fn build_image(
        &self,
        ctx: &DockerBuildContext,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerBuildResult> {
        let context_dir = std::path::PathBuf::from(&ctx.context_dir);
        if !context_dir.is_dir() {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("构建目录不存在：{}", ctx.context_dir),
            ));
        }
        let dockerfile_path = ctx
            .dockerfile
            .clone()
            .unwrap_or_else(|| "Dockerfile".to_string());
        let options = BuildImageOptionsBuilder::default()
            .t(ctx.tag.as_str())
            .dockerfile(dockerfile_path.as_str())
            .rm(true)
            .forcerm(true)
            .q(false)
            .pull("")
            .build();

        // 把 context_dir 打包成 tar 流喂给 bollard /build。
        // 出于内存考虑，用 64KiB chunked async stream 输出。
        let tar_chunks = tar_directory_chunks(&context_dir)
            .map_err(|e| OmniError::new(ErrorCode::Internal, format!("打包构建目录失败: {}", e)))?;
        let chunk_stream = futures::stream::iter(tar_chunks.into_iter().map(Bytes::from));
        let body = bollard::body_stream(chunk_stream);

        let stream = self.docker.build_image(options, None, Some(body));
        tokio::pin!(stream);
        let mut image_id: Option<String> = None;
        while let Some(item) = stream.next().await {
            match item {
                Ok(info) => {
                    if let Some(id) = info.id.as_deref() {
                        if !id.is_empty() {
                            image_id = Some(id.to_string());
                        }
                    }
                    if let Some(cb) = progress.as_ref() {
                        let line = info
                            .stream
                            .as_deref()
                            .or(info.status.as_deref())
                            .unwrap_or("")
                            .trim();
                        if !line.is_empty() {
                            cb(DockerImageProgress {
                                id: info.id.clone().unwrap_or_default(),
                                status: line.to_string(),
                                progress: progress_ratio(info.progress_detail.as_ref()),
                                detail: progress_detail_str(info.progress_detail.as_ref()),
                            });
                        }
                    }
                }
                Err(e) => {
                    return Err(map_bollard(e));
                }
            }
        }
        Ok(DockerBuildResult {
            tag: ctx.tag.clone(),
            image_id,
        })
    }

    async fn compose_action(
        &self,
        action: DockerComposeAction,
        req: &DockerComposeRequest,
    ) -> OmniResult<DockerComposeResult> {
        // 本地 Engine 没有稳定的 compose API（bollard 只暴露 Swarm services），
        // 走 `docker compose` CLI 子进程以保持与 SSH 路径行为一致。
        let mut args: Vec<String> = vec!["compose".to_string()];
        let sub = match action {
            DockerComposeAction::Up => "up",
            DockerComposeAction::Down => "down",
            DockerComposeAction::Restart => "restart",
            DockerComposeAction::Pull => "pull",
            DockerComposeAction::Logs => "logs",
        };
        args.push(sub.to_string());
        args.push("-p".to_string());
        args.push(req.project.clone());
        if let Some(cf) = &req.config_file {
            args.push("-f".to_string());
            args.push(cf.clone());
        }
        match action {
            DockerComposeAction::Up => {
                if req.detached {
                    args.push("-d".to_string());
                }
            }
            DockerComposeAction::Logs => {
                args.push("--tail".to_string());
                args.push("200".to_string());
            }
            _ => {}
        }
        for svc in &req.services {
            args.push(svc.clone());
        }

        let mut cmd = tokio::process::Command::new("docker");
        cmd.args(&args);
        if let Some(wd) = &req.working_dir {
            cmd.current_dir(wd);
        }
        cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
        let output = cmd.output().await.map_err(|e| {
            OmniError::new(ErrorCode::Internal, "启动 docker compose 失败")
                .with_cause(e.to_string())
        })?;
        let exit_code = output.status.code().unwrap_or(-1);
        Ok(DockerComposeResult {
            action,
            project: req.project.clone(),
            stdout_excerpt: truncate(&String::from_utf8_lossy(&output.stdout), 8 * 1024),
            stderr_excerpt: truncate(&String::from_utf8_lossy(&output.stderr), 8 * 1024),
            exit_code,
        })
    }

    async fn stream_stats(
        &self,
        container_id: &str,
        stop: Arc<AtomicBool>,
        mut sink: Box<dyn FnMut(DockerContainerStats) + Send>,
    ) -> OmniResult<()> {
        let options = StatsOptionsBuilder::default()
            .stream(true)
            .one_shot(false)
            .build();
        let stream = self.docker.stats(container_id, Some(options));
        tokio::pin!(stream);
        while let Some(item) = stream.next().await {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            match item {
                Ok(s) => sink(convert_stats(container_id, &s)),
                Err(e) => return Err(map_bollard(e)),
            }
        }
        Ok(())
    }

    // -------- 网络 --------

    async fn list_networks(&self) -> OmniResult<Vec<DockerNetworkSummary>> {
        let options = ListNetworksOptionsBuilder::default().build();
        let raw = self
            .docker
            .list_networks(Some(options))
            .await
            .map_err(map_bollard)?;
        Ok(raw
            .into_iter()
            .map(|n| DockerNetworkSummary {
                id: n.id.unwrap_or_default(),
                name: n.name.unwrap_or_default(),
                driver: n.driver.unwrap_or_default(),
                scope: n.scope.unwrap_or_default(),
                internal: n.internal.unwrap_or(false),
                created_at: parse_iso_to_unix_ms(n.created.as_deref()),
            })
            .collect())
    }

    async fn create_network(&self, req: &DockerCreateNetworkRequest) -> OmniResult<String> {
        use bollard::models::{Ipam, IpamConfig, NetworkCreateRequest};
        let ipam = req.subnet.as_ref().map(|subnet| Ipam {
            driver: Some("default".to_string()),
            config: Some(vec![IpamConfig {
                subnet: Some(subnet.clone()),
                ..Default::default()
            }]),
            ..Default::default()
        });
        let cfg = NetworkCreateRequest {
            name: req.name.clone(),
            driver: req.driver.clone(),
            internal: Some(req.internal),
            ipam,
            ..Default::default()
        };
        let resp = self.docker.create_network(cfg).await.map_err(map_bollard)?;
        Ok(resp.id)
    }

    async fn remove_network(&self, name: &str) -> OmniResult<()> {
        self.docker.remove_network(name).await.map_err(map_bollard)
    }

    async fn connect_container_to_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        use bollard::models::NetworkConnectRequest;
        let cfg = NetworkConnectRequest {
            container: container_id.to_string(),
            ..Default::default()
        };
        self.docker
            .connect_network(network, cfg)
            .await
            .map_err(map_bollard)
    }

    async fn disconnect_container_from_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        use bollard::models::NetworkDisconnectRequest;
        let cfg = NetworkDisconnectRequest {
            container: container_id.to_string(),
            force: Some(false),
        };
        self.docker
            .disconnect_network(network, cfg)
            .await
            .map_err(map_bollard)
    }

    async fn inspect_network(&self, id: &str) -> OmniResult<DockerNetworkDetail> {
        let raw = self
            .docker
            .inspect_network(id, None::<bollard::query_parameters::InspectNetworkOptions>)
            .await
            .map_err(map_bollard)?;
        let subnets = raw
            .ipam
            .as_ref()
            .and_then(|i| i.config.clone())
            .unwrap_or_default()
            .into_iter()
            .map(|c| DockerNetworkSubnet {
                subnet: c.subnet,
                gateway: c.gateway,
                ip_range: c.ip_range,
            })
            .collect();
        let containers = raw
            .containers
            .unwrap_or_default()
            .into_iter()
            .map(|(id, c)| DockerNetworkContainer {
                container_id: id,
                name: c.name.unwrap_or_default(),
                endpoint_id: c.endpoint_id,
                mac_address: c.mac_address,
                ipv4_address: c.ipv4_address,
                ipv6_address: c.ipv6_address,
            })
            .collect();
        let labels = raw
            .labels
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| DockerKeyValue { key: k, value: v })
            .collect();
        let options = raw
            .options
            .unwrap_or_default()
            .into_iter()
            .map(|(k, v)| DockerKeyValue { key: k, value: v })
            .collect();
        Ok(DockerNetworkDetail {
            id: raw.id.unwrap_or_else(|| id.to_string()),
            name: raw.name.unwrap_or_default(),
            driver: raw.driver.unwrap_or_default(),
            scope: raw.scope.unwrap_or_default(),
            internal: raw.internal.unwrap_or(false),
            enable_ipv6: raw.enable_ipv6.unwrap_or(false),
            created_at: parse_iso_to_unix_ms(raw.created.as_deref()),
            subnets,
            containers,
            labels,
            options,
        })
    }

    // -------- 卷 --------

    async fn list_volumes(&self) -> OmniResult<Vec<DockerVolumeSummary>> {
        let options = ListVolumesOptionsBuilder::default().build();
        let resp = self
            .docker
            .list_volumes(Some(options))
            .await
            .map_err(map_bollard)?;
        let raw = resp.volumes.unwrap_or_default();
        let mut summaries = Vec::with_capacity(raw.len());
        for v in raw {
            summaries.push(DockerVolumeSummary {
                name: v.name,
                driver: v.driver,
                mountpoint: v.mountpoint,
                created_at: 0,
                size_bytes: v.usage_data.as_ref().map(|u| u.size).unwrap_or(-1),
                in_use: v.usage_data.as_ref().map(|u| u.ref_count).unwrap_or(0) > 0,
            });
        }
        Ok(summaries)
    }

    async fn create_volume(&self, req: &DockerCreateVolumeRequest) -> OmniResult<String> {
        use bollard::models::VolumeCreateRequest;
        let labels: std::collections::HashMap<String, String> =
            req.labels.iter().cloned().collect();
        let cfg = VolumeCreateRequest {
            name: Some(req.name.clone()),
            driver: req.driver.clone(),
            labels: if labels.is_empty() {
                None
            } else {
                Some(labels)
            },
            ..Default::default()
        };
        let resp = self.docker.create_volume(cfg).await.map_err(map_bollard)?;
        Ok(resp.name)
    }

    async fn remove_volume(&self, name: &str, force: bool) -> OmniResult<()> {
        let options = RemoveVolumeOptionsBuilder::default().force(force).build();
        self.docker
            .remove_volume(name, Some(options))
            .await
            .map_err(map_bollard)
    }

    async fn inspect_volume(&self, name: &str) -> OmniResult<DockerVolumeDetail> {
        let raw = self
            .docker
            .inspect_volume(name)
            .await
            .map_err(map_bollard)?;
        let labels = raw
            .labels
            .into_iter()
            .map(|(k, v)| DockerKeyValue { key: k, value: v })
            .collect();
        let options = raw
            .options
            .into_iter()
            .map(|(k, v)| DockerKeyValue { key: k, value: v })
            .collect();
        let (size_bytes, ref_count) = raw
            .usage_data
            .as_ref()
            .map(|u| (u.size, u.ref_count))
            .unwrap_or((-1, 0));
        let scope = match raw.scope {
            Some(bollard::models::VolumeScopeEnum::LOCAL) => "local",
            Some(bollard::models::VolumeScopeEnum::GLOBAL) => "global",
            _ => "local",
        }
        .to_string();
        Ok(DockerVolumeDetail {
            name: raw.name,
            driver: raw.driver,
            mountpoint: raw.mountpoint,
            scope,
            created_at: parse_iso_to_unix_ms(raw.created_at.as_deref()),
            labels,
            options,
            size_bytes,
            reference_count: ref_count,
        })
    }

    async fn prune_volumes(&self) -> OmniResult<DockerPruneVolumesResult> {
        let resp = self
            .docker
            .prune_volumes(None::<bollard::query_parameters::PruneVolumesOptions>)
            .await
            .map_err(map_bollard)?;
        Ok(DockerPruneVolumesResult {
            deleted: resp.volumes_deleted.unwrap_or_default(),
            freed_space_bytes: resp.space_reclaimed.unwrap_or(0),
        })
    }

    async fn system_disk_usage(&self) -> OmniResult<DockerSystemDiskUsage> {
        let resp = self
            .docker
            .df(None::<bollard::query_parameters::DataUsageOptions>)
            .await
            .map_err(map_bollard)?;
        Ok(map_system_data_usage(resp))
    }

    async fn prune_build_cache(&self) -> OmniResult<DockerPruneResult> {
        let resp = self
            .docker
            .prune_build(None::<bollard::query_parameters::PruneBuildOptions>)
            .await
            .map_err(map_bollard)?;
        Ok(DockerPruneResult {
            deleted: resp.caches_deleted.unwrap_or_default(),
            freed_space_bytes: resp.space_reclaimed.unwrap_or(0),
        })
    }

    // -------- 容器内文件 --------

    async fn list_container_dir(
        &self,
        container_id: &str,
        path: &str,
    ) -> OmniResult<Vec<DockerFileEntry>> {
        // bollard 没有直接列出目录 API：下载 path/.. 的 tar 后解 tar。
        // 仅当 `path` 是目录时有效（当 path 指向文件时返回空）。
        use bollard::query_parameters::DownloadFromContainerOptionsBuilder;
        use futures::StreamExt;
        let options = DownloadFromContainerOptionsBuilder::default()
            .path(path)
            .build();
        let stream = self
            .docker
            .download_from_container(container_id, Some(options));
        tokio::pin!(stream);
        let mut tar_bytes: Vec<u8> = Vec::new();
        while let Some(item) = stream.next().await {
            match item.map_err(map_bollard)? {
                bytes if bytes.is_empty() => break,
                bytes => tar_bytes.extend_from_slice(&bytes),
            }
        }
        let mut entries = Vec::new();
        let cursor = std::io::Cursor::new(tar_bytes);
        let mut archive = tar::Archive::new(cursor);
        for file in archive.entries().map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析容器目录 tar 失败").with_cause(e.to_string())
        })? {
            let file = file.map_err(|e| {
                OmniError::new(ErrorCode::Internal, "解析 tar 条目失败").with_cause(e.to_string())
            })?;
            let header = file.header().clone();
            let raw_name = header.path().map_err(|e| {
                OmniError::new(ErrorCode::Internal, "解析 tar 路径失败").with_cause(e.to_string())
            })?;
            let name = raw_name
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let rel_path = raw_name.to_string_lossy().to_string();
            let size = header.size().unwrap_or(0) as i64;
            let mtime = header.mtime().unwrap_or(0) as i64 * 1000;
            let mode = header.mode().unwrap_or(0);
            let is_dir = header.entry_type().is_dir();
            let is_symlink = header.entry_type().is_symlink();
            if name.is_empty() {
                continue;
            }
            entries.push(DockerFileEntry {
                name,
                path: rel_path,
                size_bytes: size,
                modified_at: mtime,
                mode,
                is_dir,
                is_symlink,
            });
        }
        Ok(entries)
    }

    async fn read_container_file(
        &self,
        container_id: &str,
        path: &str,
        max_bytes: i64,
    ) -> OmniResult<Vec<u8>> {
        use bollard::query_parameters::DownloadFromContainerOptionsBuilder;
        use futures::StreamExt;
        let options = DownloadFromContainerOptionsBuilder::default()
            .path(path)
            .build();
        let stream = self
            .docker
            .download_from_container(container_id, Some(options));
        tokio::pin!(stream);
        let mut tar_bytes: Vec<u8> = Vec::new();
        while let Some(item) = stream.next().await {
            match item.map_err(map_bollard)? {
                bytes if bytes.is_empty() => break,
                bytes => tar_bytes.extend_from_slice(&bytes),
            }
        }
        let cursor = std::io::Cursor::new(tar_bytes);
        let mut archive = tar::Archive::new(cursor);
        let mut file = archive
            .entries()
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "解析容器文件 tar 失败")
                    .with_cause(e.to_string())
            })?
            .next()
            .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "容器内文件不存在"))?
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "读取 tar 条目失败").with_cause(e.to_string())
            })?;
        let mut buf = Vec::new();
        let limit = if max_bytes > 0 {
            max_bytes as usize
        } else {
            usize::MAX
        };
        let mut total = 0usize;
        let mut chunk = [0u8; 8192];
        loop {
            let n = file.read(&mut chunk).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "读取文件内容失败").with_cause(e.to_string())
            })?;
            if n == 0 {
                break;
            }
            total += n;
            if total > limit {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    format!("文件超过 {} 字节限制", limit),
                ));
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok(buf)
    }

    async fn write_container_file(
        &self,
        container_id: &str,
        path: &str,
        data: Vec<u8>,
    ) -> OmniResult<()> {
        use bollard::query_parameters::UploadToContainerOptionsBuilder;
        // bollard 接收 tar 流；将单文件打包进 tar 再上传。
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        let mut tar_buf = Vec::<u8>::new();
        {
            // file_name = path basename
            let name = std::path::Path::new(path)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| path.to_string());
            let mut builder = tar::Builder::new(&mut tar_buf);
            builder
                .append_data(&mut header, &name, data.as_slice())
                .map_err(|e| {
                    OmniError::new(ErrorCode::Internal, "打包 tar 失败").with_cause(e.to_string())
                })?;
            builder.finish().map_err(|e| {
                OmniError::new(ErrorCode::Internal, "完成 tar 写入失败").with_cause(e.to_string())
            })?;
        }
        let dir = std::path::Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "/".to_string());
        let options = UploadToContainerOptionsBuilder::default()
            .path(dir.as_str())
            .no_overwrite_dir_non_dir("true")
            .build();
        let body = bollard::body_full(bytes::Bytes::from(tar_buf));
        self.docker
            .upload_to_container(container_id, Some(options), body)
            .await
            .map_err(map_bollard)
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

    // ── Swarm ──
    async fn swarm_init(
        &self,
        listen_addr: Option<&str>,
        advertise_addr: Option<&str>,
    ) -> OmniResult<String> {
        let req = bollard::models::SwarmInitRequest {
            listen_addr: Some(listen_addr.unwrap_or("0.0.0.0:2377").to_string()),
            advertise_addr: advertise_addr.map(|s| s.to_string()),
            ..Default::default()
        };
        let id = self.docker.init_swarm(req).await.map_err(map_bollard)?;
        Ok(id)
    }
    async fn swarm_join(
        &self,
        remote_addrs: Vec<String>,
        token: &str,
        listen_addr: Option<&str>,
    ) -> OmniResult<()> {
        let req = bollard::models::SwarmJoinRequest {
            listen_addr: Some(listen_addr.unwrap_or("0.0.0.0:2377").to_string()),
            remote_addrs: Some(remote_addrs),
            join_token: Some(token.to_string()),
            ..Default::default()
        };
        self.docker.join_swarm(req).await.map_err(map_bollard)?;
        Ok(())
    }
    async fn swarm_leave(&self, force: bool) -> OmniResult<()> {
        use bollard::query_parameters::LeaveSwarmOptionsBuilder;
        let opts = LeaveSwarmOptionsBuilder::default().force(force).build();
        self.docker
            .leave_swarm(Some(opts))
            .await
            .map_err(map_bollard)?;
        Ok(())
    }
    async fn swarm_inspect(&self) -> OmniResult<serde_json::Value> {
        let swarm = self.docker.inspect_swarm().await.map_err(map_bollard)?;
        serde_json::to_value(&swarm).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "序列化 Swarm 信息失败").with_cause(e.to_string())
        })
    }
    async fn service_list(&self) -> OmniResult<Vec<DockerServiceSummary>> {
        let services = self.docker.list_services(None).await.map_err(map_bollard)?;
        Ok(services
            .into_iter()
            .map(|s| {
                let spec = s.spec.unwrap_or_default();
                let replicas = spec
                    .mode
                    .as_ref()
                    .and_then(|m| m.replicated.as_ref())
                    .and_then(|r| r.replicas)
                    .unwrap_or(1) as u64;
                let mode_str = if spec.mode.as_ref().and_then(|m| m.global.as_ref()).is_some() {
                    "global".to_string()
                } else {
                    format!("replicated/{}", replicas)
                };
                DockerServiceSummary {
                    id: s.id.unwrap_or_default(),
                    name: spec.name.unwrap_or_default(),
                    image: spec
                        .task_template
                        .as_ref()
                        .and_then(|t| t.container_spec.as_ref())
                        .and_then(|c| c.image.clone())
                        .unwrap_or_default(),
                    mode: mode_str,
                    replicas,
                    running_replicas: replicas,
                    ports: Vec::new(),
                    created_at: String::new(),
                    updated_at: String::new(),
                }
            })
            .collect())
    }
    async fn service_create(&self, req: &DockerCreateServiceRequest) -> OmniResult<String> {
        let ports: Vec<bollard::models::EndpointPortConfig> = req
            .ports
            .iter()
            .filter_map(|p| {
                let parts: Vec<&str> = p.split(':').collect();
                if parts.len() >= 2 {
                    let host_port: i64 = parts[0].parse().ok()?;
                    let cp: Vec<&str> = parts[1].split('/').collect();
                    let container_port: i64 = cp[0].parse().ok()?;
                    let protocol = if cp.len() > 1 {
                        cp[1].to_string()
                    } else {
                        "tcp".to_string()
                    };
                    let proto = match protocol.as_str() {
                        "udp" => Some(bollard::models::EndpointPortConfigProtocolEnum::UDP),
                        _ => Some(bollard::models::EndpointPortConfigProtocolEnum::TCP),
                    };
                    Some(bollard::models::EndpointPortConfig {
                        target_port: Some(container_port),
                        published_port: Some(host_port),
                        protocol: proto,
                        publish_mode: Some(
                            bollard::models::EndpointPortConfigPublishModeEnum::INGRESS,
                        ),
                        ..Default::default()
                    })
                } else {
                    None
                }
            })
            .collect();
        let endpoint_spec = if ports.is_empty() {
            None
        } else {
            Some(bollard::models::EndpointSpec {
                ports: Some(ports),
                ..Default::default()
            })
        };
        let spec = bollard::models::ServiceSpec {
            name: Some(req.name.clone()),
            task_template: Some(bollard::models::TaskSpec {
                container_spec: Some(bollard::models::TaskSpecContainerSpec {
                    image: Some(req.image.clone()),
                    command: req.command.as_ref().map(|c| vec![c.clone()]),
                    env: Some(req.env.clone()),
                    ..Default::default()
                }),
                ..Default::default()
            }),
            mode: Some(bollard::models::ServiceSpecMode {
                replicated: Some(bollard::models::ServiceSpecModeReplicated {
                    replicas: Some(req.replicas as i64),
                }),
                ..Default::default()
            }),
            endpoint_spec,
            ..Default::default()
        };
        let resp = self
            .docker
            .create_service(spec, None)
            .await
            .map_err(map_bollard)?;
        Ok(resp.id.unwrap_or_else(|| "created".to_string()))
    }
    async fn service_update(
        &self,
        id: &str,
        replicas: Option<u64>,
        image: Option<&str>,
    ) -> OmniResult<()> {
        let current = self
            .docker
            .inspect_service(id, None)
            .await
            .map_err(map_bollard)?;
        let version = current.version.and_then(|v| v.index).unwrap_or(0);
        let mut spec = current.spec.unwrap_or_default();
        if let Some(r) = replicas {
            spec.mode = Some(bollard::models::ServiceSpecMode {
                replicated: Some(bollard::models::ServiceSpecModeReplicated {
                    replicas: Some(r as i64),
                }),
                ..Default::default()
            });
        }
        if let Some(img) = image {
            if let Some(ref mut ts) = spec.task_template {
                if let Some(ref mut cs) = ts.container_spec {
                    cs.image = Some(img.to_string());
                }
            }
        }
        use bollard::query_parameters::UpdateServiceOptionsBuilder;
        let opts = UpdateServiceOptionsBuilder::default()
            .version(version as i32)
            .build();
        self.docker
            .update_service(id, spec, opts, None)
            .await
            .map_err(map_bollard)?;
        Ok(())
    }
    async fn service_remove(&self, id: &str) -> OmniResult<()> {
        self.docker.delete_service(id).await.map_err(map_bollard)?;
        Ok(())
    }
    async fn service_logs(&self, id: &str, tail: Option<&str>) -> OmniResult<String> {
        use bollard::query_parameters::LogsOptionsBuilder;
        use futures::StreamExt;
        let opts = LogsOptionsBuilder::default()
            .stdout(true)
            .stderr(true)
            .tail(tail.unwrap_or("200"))
            .build();
        let mut stream = self.docker.service_logs(id, Some(opts));
        let mut output = String::new();
        while let Some(Ok(log)) = stream.next().await {
            let bytes = match log {
                bollard::container::LogOutput::StdOut { message }
                | bollard::container::LogOutput::StdErr { message }
                | bollard::container::LogOutput::StdIn { message }
                | bollard::container::LogOutput::Console { message } => message,
            };
            output.push_str(&String::from_utf8_lossy(&bytes));
        }
        Ok(output)
    }
    async fn node_list(&self) -> OmniResult<Vec<DockerNodeSummary>> {
        let nodes = self.docker.list_nodes(None).await.map_err(map_bollard)?;
        Ok(nodes
            .into_iter()
            .map(|n| {
                let desc = n.description.unwrap_or_default();
                let status = n.status.unwrap_or_default();
                let spec = n.spec.unwrap_or_default();
                DockerNodeSummary {
                    id: n.id.unwrap_or_default(),
                    hostname: desc.hostname.unwrap_or_default(),
                    status: status
                        .state
                        .map(|s| format!("{:?}", s))
                        .unwrap_or_else(|| "unknown".into()),
                    availability: spec
                        .availability
                        .map(|a| format!("{:?}", a))
                        .unwrap_or_else(|| "unknown".into()),
                    role: spec
                        .role
                        .map(|r| format!("{:?}", r))
                        .unwrap_or_else(|| "worker".into()),
                    engine_version: desc
                        .engine
                        .unwrap_or_default()
                        .engine_version
                        .unwrap_or_default(),
                    addr: status.addr.unwrap_or_default(),
                    labels: spec
                        .labels
                        .unwrap_or_default()
                        .into_iter()
                        .map(|(k, v)| DockerKeyValue { key: k, value: v })
                        .collect(),
                }
            })
            .collect())
    }
    async fn node_inspect(&self, id: &str) -> OmniResult<serde_json::Value> {
        let node = self.docker.inspect_node(id).await.map_err(map_bollard)?;
        serde_json::to_value(&node).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "序列化节点信息失败").with_cause(e.to_string())
        })
    }
    async fn node_update(
        &self,
        id: &str,
        availability: Option<&str>,
        labels: Option<Vec<DockerKeyValue>>,
    ) -> OmniResult<()> {
        let current = self.docker.inspect_node(id).await.map_err(map_bollard)?;
        let version = current.version.and_then(|v| v.index).unwrap_or(0);
        let mut spec = current.spec.unwrap_or_default();
        if let Some(avail) = availability {
            spec.availability = match avail {
                "active" => Some(bollard::models::NodeSpecAvailabilityEnum::ACTIVE),
                "pause" => Some(bollard::models::NodeSpecAvailabilityEnum::PAUSE),
                "drain" => Some(bollard::models::NodeSpecAvailabilityEnum::DRAIN),
                _ => spec.availability,
            };
        }
        if let Some(lbls) = labels {
            let mut m = spec.labels.unwrap_or_default();
            for l in lbls {
                m.insert(l.key, l.value);
            }
            spec.labels = Some(m);
        }
        use bollard::query_parameters::UpdateNodeOptionsBuilder;
        let opts = UpdateNodeOptionsBuilder::default()
            .version(version as i64)
            .build();
        self.docker
            .update_node(id, spec, opts)
            .await
            .map_err(map_bollard)?;
        Ok(())
    }
    async fn node_remove(&self, id: &str, force: bool) -> OmniResult<()> {
        use bollard::query_parameters::DeleteNodeOptionsBuilder;
        let opts = DeleteNodeOptionsBuilder::default().force(force).build();
        self.docker
            .delete_node(id, Some(opts))
            .await
            .map_err(map_bollard)?;
        Ok(())
    }
    async fn stack_deploy(&self, _n: &str, _c: &str, _e: Option<Vec<String>>) -> OmniResult<()> {
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "Stack deploy 需要 docker CLI，请通过 SSH 连接使用",
        ))
    }
    async fn stack_list(&self) -> OmniResult<Vec<DockerStackSummary>> {
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "Stack 操作需要 docker CLI，请通过 SSH 连接使用",
        ))
    }
    async fn stack_remove(&self, _n: &str) -> OmniResult<()> {
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "Stack 操作需要 docker CLI，请通过 SSH 连接使用",
        ))
    }
    async fn stack_services(&self, _n: &str) -> OmniResult<Vec<DockerServiceSummary>> {
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "Stack 操作需要 docker CLI，请通过 SSH 连接使用",
        ))
    }
}

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
        ip_address: None,
        network_attachments: vec![],
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
    let network_attachments: Vec<DockerNetworkAttachment> = c
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
        networks: network_attachments.iter().map(|n| n.name.clone()).collect(),
        ip_address: network_attachments
            .iter()
            .find_map(|n| n.ip_address.clone())
            .filter(|s| !s.is_empty()),
        network_attachments: network_attachments.clone(),
        created_at: 0,
    };

    DockerContainerDetail {
        summary,
        command,
        restart_policy,
        exit_code,
        env,
        mounts,
        networks: network_attachments,
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

/// 把 `s` 截到 `max_bytes` 字节内（按字符边界）。超长时附加 `…[truncated]`。
fn truncate(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}…[truncated]", &s[..cut])
}
