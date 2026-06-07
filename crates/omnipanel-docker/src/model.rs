//! Docker 模块对外数据模型。
//!
//! 所有类型派生 `Serialize`/`Deserialize`/`specta::Type`，由 tauri-specta 生成前端 TS 类型。
//! 不同来源（本地 Engine / SSH 宿主机 / 远程 API / 面板适配）最终都映射到这一套统一模型上。

use serde::{Deserialize, Serialize};

/// Docker 连接来源。前端只消费统一资源模型，来源差异由后端 adapter 屏蔽。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum DockerConnectionSource {
    /// 本地 Docker Engine / Docker Desktop。
    LocalEngine,
    /// 远程 Docker Engine API（TCP/TLS）。
    RemoteEngine,
    /// 通过 SSH 宿主机调用远程 `docker` CLI。
    SshEngine,
    /// 通过 1Panel 面板 API 适配。
    OnePanel,
    /// 预留：宝塔 / Portainer 等其他面板 API。
    PanelAdapter,
}

impl DockerConnectionSource {
    pub fn parse(s: &str) -> Self {
        match s {
            "local-engine" => Self::LocalEngine,
            "remote-engine" => Self::RemoteEngine,
            "ssh-engine" => Self::SshEngine,
            "onepanel" => Self::OnePanel,
            "panel-adapter" => Self::PanelAdapter,
            _ => Self::LocalEngine,
        }
    }
}

/// 连接状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DockerConnectionStatus {
    Online,
    Degraded,
    Offline,
}

/// 连接级能力探测结果。前端据此决定页签/按钮显隐与降级。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerCapabilities {
    pub can_overview: bool,
    pub can_stream_logs: bool,
    pub can_container_exec: bool,
    pub can_inspect: bool,
    pub can_manage_containers: bool,
    pub can_manage_images: bool,
    pub can_compose: bool,
    pub can_prune: bool,
    pub read_only: bool,
    pub source: DockerConnectionSource,
}

impl DockerCapabilities {
    /// 本地 / SSH Engine 的默认全量能力。
    pub fn full(source: DockerConnectionSource) -> Self {
        Self {
            can_overview: true,
            can_stream_logs: true,
            can_container_exec: true,
            can_inspect: true,
            can_manage_containers: true,
            can_manage_images: true,
            can_compose: true,
            can_prune: true,
            read_only: false,
            source,
        }
    }

    /// SSH 宿主机 adapter：完整功能，exec_pty 已支持 docker exec -it。
    pub fn ssh_engine() -> Self {
        Self {
            can_overview: true,
            can_stream_logs: true,
            can_container_exec: true,
            can_inspect: true,
            can_manage_containers: true,
            can_manage_images: true,
            can_compose: true,
            can_prune: true,
            read_only: false,
            source: DockerConnectionSource::SshEngine,
        }
    }

    /// 1Panel 适配器能力：基础 CRUD；exec/stats/build/push/pull/容器文件 暂不支持。
    pub fn onepanel() -> Self {
        Self {
            can_overview: true,
            can_stream_logs: false,
            can_container_exec: false,
            can_inspect: true,
            can_manage_containers: true,
            can_manage_images: true,
            can_compose: true,
            can_prune: true,
            read_only: false,
            source: DockerConnectionSource::OnePanel,
        }
    }
}

/// 连接信息（列表与工作区头部展示）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerConnectionInfo {
    pub connection_id: String,
    pub name: String,
    pub source: DockerConnectionSource,
    pub status: DockerConnectionStatus,
    pub host_label: String,
    pub environment: String,
    pub engine_version: Option<String>,
    pub api_version: Option<String>,
    pub containers_running: u32,
    pub containers_total: u32,
    pub warning_message: Option<String>,
    /// 与 SSH / Server 模块贯通上下文用：绑定的 SSH 连接 id。
    pub bound_ssh_connection_id: Option<String>,
}

/// 探测结果。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerProbe {
    pub status: DockerConnectionStatus,
    pub engine_version: Option<String>,
    pub api_version: Option<String>,
    pub capabilities: DockerCapabilities,
    pub warning_message: Option<String>,
}

/// 资源统计（总览页）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerResourceSummary {
    pub containers_total: u32,
    pub containers_running: u32,
    pub containers_stopped: u32,
    pub images: u32,
}

/// 总览页数据。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerOverview {
    pub capabilities: DockerCapabilities,
    pub summary: DockerResourceSummary,
    pub engine_version: Option<String>,
    pub warning_message: Option<String>,
}

/// 端口映射。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerPort {
    pub private_port: u16,
    pub public_port: Option<u16>,
    pub protocol: String,
    pub ip: Option<String>,
}

impl DockerPort {
    /// 渲染为 `0.0.0.0:8080->80/tcp` 风格文本。
    pub fn label(&self) -> String {
        match self.public_port {
            Some(public) => {
                let ip = self.ip.as_deref().unwrap_or("0.0.0.0");
                format!("{ip}:{public}->{}/{}", self.private_port, self.protocol)
            }
            None => format!("{}/{}", self.private_port, self.protocol),
        }
    }
}

/// 容器列表项。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerSummary {
    pub id: String,
    pub short_id: String,
    pub name: String,
    pub image: String,
    /// 归一化生命周期：running / exited / paused / restarting / created / dead / unknown。
    pub state: String,
    /// Docker 原始状态文本，例如 "Up 2 hours"。
    pub status_text: String,
    pub running: bool,
    pub ports: Vec<DockerPort>,
    pub networks: Vec<String>,
    #[specta(type = f64)]
    pub created_at: i64,
}

/// 键值对（环境变量、标签）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerKeyValue {
    pub key: String,
    pub value: String,
}

/// 挂载信息。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerMount {
    pub kind: String,
    pub source: String,
    pub destination: String,
    pub read_only: bool,
}

/// 网络挂载。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkAttachment {
    pub name: String,
    pub ip_address: Option<String>,
}

/// 容器详情。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerDetail {
    pub summary: DockerContainerSummary,
    pub command: Option<String>,
    pub restart_policy: Option<String>,
    #[specta(type = Option<f64>)]
    pub exit_code: Option<i64>,
    pub env: Vec<DockerKeyValue>,
    pub mounts: Vec<DockerMount>,
    pub networks: Vec<DockerNetworkAttachment>,
}

/// 容器生命周期动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DockerContainerAction {
    Start,
    Stop,
    Restart,
    Kill,
    Pause,
    Unpause,
    Remove,
}

impl DockerContainerAction {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "start" => Some(Self::Start),
            "stop" => Some(Self::Stop),
            "restart" => Some(Self::Restart),
            "kill" => Some(Self::Kill),
            "pause" => Some(Self::Pause),
            "unpause" => Some(Self::Unpause),
            "remove" => Some(Self::Remove),
            _ => None,
        }
    }

    /// 是否为高风险动作（前端需二次确认 + 审计）。
    pub fn is_destructive(self) -> bool {
        matches!(self, Self::Kill | Self::Remove)
    }

    /// 远程 SSH 场景对应的 docker 子命令。
    pub fn cli_verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Kill => "kill",
            Self::Pause => "pause",
            Self::Unpause => "unpause",
            Self::Remove => "rm -f",
        }
    }
}

/// 日志行。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerLogLine {
    /// stdout / stderr。
    pub stream: String,
    pub message: String,
}

/// 镜像列表项。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageSummary {
    pub id: String,
    pub short_id: String,
    pub repository: String,
    pub tag: String,
    #[specta(type = f64)]
    pub size_bytes: i64,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub containers: i64,
    pub dangling: bool,
}

/// 镜像清理结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerPruneResult {
    pub deleted: Vec<String>,
    #[specta(type = f64)]
    pub freed_space_bytes: i64,
}

/// 镜像详情。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageDetail {
    /// 与 `DockerImageSummary.id` 相同。
    pub id: String,
    /// 所有 repo:tag 引用。
    pub repo_tags: Vec<String>,
    pub architecture: Option<String>,
    pub os: Option<String>,
    pub driver: Option<String>,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub size_bytes: i64,
    pub author: Option<String>,
    pub comment: Option<String>,
    pub config: DockerImageConfig,
    /// 历史层（`docker history` 精简版）。
    pub history: Vec<DockerImageHistoryLayer>,
}

/// `docker inspect .Config` 关键字段。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageConfig {
    pub env: Vec<String>,
    pub cmd: Option<String>,
    pub entrypoint: Option<String>,
    pub working_dir: Option<String>,
    pub user: Option<String>,
    pub exposed_ports: Vec<String>,
    pub labels: Vec<DockerKeyValue>,
    pub volumes: Vec<String>,
}

/// `docker history` 单层。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageHistoryLayer {
    pub id: String,
    #[specta(type = f64)]
    pub created_at: i64,
    pub created_by: String,
    #[specta(type = f64)]
    pub size_bytes: i64,
    pub comment: String,
    pub tags: Vec<String>,
}

/// Compose 项目（按 `com.docker.compose.project` 标签聚合容器得到）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerComposeProject {
    pub name: String,
    pub working_dir: Option<String>,
    pub config_files: Option<String>,
    pub service_count: u32,
    pub container_count: u32,
    pub running_container_count: u32,
    pub services: Vec<DockerComposeService>,
}

/// Compose 服务（按 `com.docker.compose.service` 标签聚合）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerComposeService {
    pub name: String,
    pub image: String,
    pub container_count: u32,
    pub running_container_count: u32,
}

/// 镜像拉取/推送/构建的进度事件。前端按行渲染进度。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerImageProgress {
    pub id: String,
    pub status: String,
    pub progress: Option<f64>,
    pub detail: Option<String>,
}

/// 镜像拉取结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerPullResult {
    pub image: String,
    pub tag: String,
    pub digest: Option<String>,
}

/// 镜像构建结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerBuildResult {
    pub tag: String,
    pub image_id: Option<String>,
}

/// Compose 生命周期动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "lowercase")]
pub enum DockerComposeAction {
    #[default]
    Up,
    Down,
    Restart,
    Pull,
    Logs,
}

/// 单条 Compose 命令的入参。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerComposeRequest {
    pub project: String,
    pub working_dir: Option<String>,
    pub config_file: Option<String>,
    pub services: Vec<String>,
    pub detached: bool,
}

/// 单条 Compose 命令的结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerComposeResult {
    pub action: DockerComposeAction,
    pub project: String,
    pub stdout_excerpt: String,
    pub stderr_excerpt: String,
    pub exit_code: i32,
}

/// 容器统计快照。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerStats {
    pub container_id: String,
    pub name: String,
    pub cpu_percent: f64,
    #[specta(type = f64)]
    pub memory_usage_bytes: i64,
    #[specta(type = f64)]
    pub memory_limit_bytes: Option<i64>,
    pub memory_percent: f64,
    #[specta(type = f64)]
    pub net_rx_bytes: i64,
    #[specta(type = f64)]
    pub net_tx_bytes: i64,
    #[specta(type = f64)]
    pub block_read_bytes: i64,
    #[specta(type = f64)]
    pub block_write_bytes: i64,
    #[specta(type = f64)]
    pub timestamp_ms: i64,
}

/// 网络摘要。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkSummary {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub internal: bool,
    #[specta(type = f64)]
    pub created_at: i64,
}

/// 创建网络请求。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerCreateNetworkRequest {
    pub name: String,
    pub driver: Option<String>,
    pub internal: bool,
    pub subnet: Option<String>,
}

/// 网络详情。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkDetail {
    /// 与 `DockerNetworkSummary.id` 相同。
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    pub internal: bool,
    pub enable_ipv6: bool,
    #[specta(type = f64)]
    pub created_at: i64,
    /// 子网 + 网关 列表（来自 IPAM）。
    pub subnets: Vec<DockerNetworkSubnet>,
    /// 当前已连接容器。
    pub containers: Vec<DockerNetworkContainer>,
    pub labels: Vec<DockerKeyValue>,
    /// 网络选项（如 `com.docker.network.bridge.name=br0`）。
    pub options: Vec<DockerKeyValue>,
}

/// IPAM 子网条目。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkSubnet {
    pub subnet: Option<String>,
    pub gateway: Option<String>,
    pub ip_range: Option<String>,
}

/// 已挂接网络容器摘要。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerNetworkContainer {
    pub container_id: String,
    pub name: String,
    pub endpoint_id: Option<String>,
    pub mac_address: Option<String>,
    pub ipv4_address: Option<String>,
    pub ipv6_address: Option<String>,
}

/// 卷摘要。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolumeSummary {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub size_bytes: i64,
    pub in_use: bool,
}

/// 卷清理结果。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerPruneVolumesResult {
    pub deleted: Vec<String>,
    #[specta(type = f64)]
    pub freed_space_bytes: i64,
}

/// 创建卷请求。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerCreateVolumeRequest {
    pub name: String,
    pub driver: Option<String>,
    pub labels: Vec<(String, String)>,
}

/// 卷详情。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerVolumeDetail {
    /// 与 `DockerVolumeSummary.name` 相同。
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub scope: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub size_bytes: i64,
    pub labels: Vec<DockerKeyValue>,
    /// 驱动选项。
    pub options: Vec<DockerKeyValue>,
    /// 引用计数字段（来自 `Volume.UsageData.RefCount`）。
    #[specta(type = f64)]
    pub reference_count: i64,
}

/// 容器内文件条目。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerFileEntry {
    pub name: String,
    pub path: String,
    #[specta(type = f64)]
    pub size_bytes: i64,
    #[specta(type = f64)]
    pub modified_at: i64,
    pub mode: u32,
    pub is_dir: bool,
    pub is_symlink: bool,
}

/// 镜像构建的输入上下文。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerBuildContext {
    pub context_dir: String,
    pub tag: String,
    pub dockerfile: Option<String>,
    pub build_args: Vec<String>,
    pub use_build_kit: bool,
}
