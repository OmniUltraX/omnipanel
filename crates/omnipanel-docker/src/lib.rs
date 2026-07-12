//! Docker 领域层：统一模型 + `DockerAdapter` 边界 + 本地 / SSH 两种 Engine 实现。
//!
//! 设计：
//! - `src-tauri` 只做 IPC 桥接，所有 Docker 业务逻辑收敛在此 crate。
//! - 本地 Engine 走 Rust `bollard`（[`local::LocalDockerAdapter`]）。
//! - 远程宿主机复用 SSH 调用远端 `docker` CLI（[`ssh`] 模块的自由函数，借用现有 `SshSession`）。
//! - 所有错误统一为 [`OmniError`]，命令层零散字符串错误就此收敛。

mod compose;
pub mod local;
pub mod local_engine;
pub mod model;
pub mod onepanel;
pub mod onepanel_terminal;
pub mod ssh;

use async_trait::async_trait;
use omnipanel_error::OmniResult;
use std::sync::Arc;

pub use compose::aggregate_compose;
pub use local::{DockerExecOutput, DockerExecSession, LocalDockerAdapter};
pub use local_engine::{local_engine_status, start_local_engine};
pub use model::*;
pub use onepanel::{OnePanelAdapter, OnePanelClient};
pub use ssh::SshDockerAdapter;

/// 重新导出 bollard，供命令层直接构造远程 Engine 客户端。
pub use bollard;

/// 容器列表筛选。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainerFilter {
    All,
    Running,
    Stopped,
}

impl ContainerFilter {
    pub fn parse(s: Option<&str>) -> Self {
        match s {
            Some("running") => Self::Running,
            Some("stopped") => Self::Stopped,
            _ => Self::All,
        }
    }

    /// 是否需要包含已停止容器。
    pub fn include_all(self) -> bool {
        !matches!(self, Self::Running)
    }

    pub fn matches(self, running: bool) -> bool {
        match self {
            Self::All => true,
            Self::Running => running,
            Self::Stopped => !running,
        }
    }
}

/// Docker 引擎适配器统一边界。本地 Engine 实现该 trait；
/// SSH 宿主机因需借用外部 `SshSession`，以 [`ssh`] 模块的等价自由函数提供，共享同一套解析逻辑。
#[async_trait]
pub trait DockerAdapter: Send + Sync {
    /// 探测连通性与能力。
    async fn probe(&self) -> OmniResult<DockerProbe>;
    /// 总览统计。
    async fn overview(&self) -> OmniResult<DockerOverview>;
    /// 容器列表。
    async fn list_containers(
        &self,
        filter: ContainerFilter,
    ) -> OmniResult<Vec<DockerContainerSummary>>;
    /// 容器详情。
    async fn inspect_container(&self, id: &str) -> OmniResult<DockerContainerDetail>;
    /// 容器生命周期动作。
    async fn container_action(&self, id: &str, action: DockerContainerAction) -> OmniResult<()>;
    /// 创建容器。
    async fn create_container(&self, req: &DockerCreateContainerRequest) -> OmniResult<String>;
    /// 拉取容器日志（一次性，tail 行）。流式由命令层另行处理。
    async fn container_logs(&self, id: &str, tail: i64) -> OmniResult<Vec<DockerLogLine>>;
    /// 镜像列表。
    async fn list_images(&self) -> OmniResult<Vec<DockerImageSummary>>;
    /// 镜像详情（配置 / 历史层）。
    async fn inspect_image(&self, id: &str) -> OmniResult<DockerImageDetail>;
    /// `docker history` 精简版。
    async fn image_history(&self, id: &str) -> OmniResult<Vec<DockerImageHistoryLayer>>;
    /// 删除镜像。
    async fn remove_image(&self, id: &str, force: bool) -> OmniResult<()>;
    /// 清理悬空镜像。
    async fn prune_images(&self) -> OmniResult<DockerPruneResult>;
    /// Compose 项目识别。
    async fn list_compose_projects(&self) -> OmniResult<Vec<DockerComposeProject>>;
    /// 拉取镜像。`progress` 回调（可选）逐条上报拉取阶段。
    async fn pull_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult>;
    /// 推送镜像到注册表。`progress` 回调同 `pull_image`。
    async fn push_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult>;
    /// 给已有镜像打 tag。
    async fn tag_image(&self, source: &str, target: &str) -> OmniResult<()>;
    /// 通过 Dockerfile 构建镜像。`progress` 回调（可选）逐条上报构建阶段。
    async fn build_image(
        &self,
        ctx: &DockerBuildContext,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerBuildResult>;
    /// Compose 生命周期（up/down/restart/pull）。
    async fn compose_action(
        &self,
        action: DockerComposeAction,
        req: &DockerComposeRequest,
    ) -> OmniResult<DockerComposeResult>;
    /// 流式容器 stats。`stop` 置位时停止，`sink` 持续接收统计快照。
    /// 本地 Engine 走 bollard；SSH 走 `docker stats --format '{{json .}}'`。
    async fn stream_stats(
        &self,
        container_id: &str,
        stop: Arc<std::sync::atomic::AtomicBool>,
        sink: Box<dyn FnMut(DockerContainerStats) + Send>,
    ) -> OmniResult<()>;
    /// 网络列表。
    async fn list_networks(&self) -> OmniResult<Vec<DockerNetworkSummary>>;
    /// 网络详情（IPAM + 已挂接容器）。
    async fn inspect_network(&self, name_or_id: &str) -> OmniResult<DockerNetworkDetail>;
    /// 创建网络。
    async fn create_network(&self, req: &DockerCreateNetworkRequest) -> OmniResult<String>;
    /// 删除网络。
    async fn remove_network(&self, name: &str) -> OmniResult<()>;
    /// 把容器接入网络。
    async fn connect_container_to_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()>;
    /// 把容器从网络断开。
    async fn disconnect_container_from_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()>;
    /// 卷列表。
    async fn list_volumes(&self) -> OmniResult<Vec<DockerVolumeSummary>>;
    /// 卷详情（标签 + 驱动选项 + 引用计数）。
    async fn inspect_volume(&self, name: &str) -> OmniResult<DockerVolumeDetail>;
    /// 创建卷。
    async fn create_volume(&self, req: &DockerCreateVolumeRequest) -> OmniResult<String>;
    /// 删除卷。
    async fn remove_volume(&self, name: &str, force: bool) -> OmniResult<()>;
    /// 清理未使用卷。
    async fn prune_volumes(&self) -> OmniResult<DockerPruneVolumesResult>;
    /// `docker system df` 磁盘占用汇总。
    async fn system_disk_usage(&self) -> OmniResult<DockerSystemDiskUsage>;
    /// 清理构建缓存（`docker builder prune`）。
    async fn prune_build_cache(&self) -> OmniResult<DockerPruneResult>;
    /// 列出容器内目录。
    async fn list_container_dir(
        &self,
        container_id: &str,
        path: &str,
    ) -> OmniResult<Vec<DockerFileEntry>>;
    /// 读取容器内文件（按字节返回）。最大 16 MiB 防御性检查。
    async fn read_container_file(
        &self,
        container_id: &str,
        path: &str,
        max_bytes: i64,
    ) -> OmniResult<Vec<u8>>;
    /// 写入容器内文件（覆盖）。注意：bollard 走 tar 协议，SSH 走 `docker cp`。
    async fn write_container_file(
        &self,
        container_id: &str,
        path: &str,
        data: Vec<u8>,
    ) -> OmniResult<()>;

    // ── Swarm ────────────────────────────────────────────────────────────────
    /// 初始化 Docker Swarm。
    async fn swarm_init(
        &self,
        listen_addr: Option<&str>,
        advertise_addr: Option<&str>,
    ) -> OmniResult<String>;
    /// 加入已有的 Swarm 集群。
    async fn swarm_join(
        &self,
        remote_addrs: Vec<String>,
        token: &str,
        listen_addr: Option<&str>,
    ) -> OmniResult<()>;
    /// 离开 Swarm。
    async fn swarm_leave(&self, force: bool) -> OmniResult<()>;
    /// 查看 Swarm 信息。
    async fn swarm_inspect(&self) -> OmniResult<serde_json::Value>;
    /// 列出 Swarm 服务。
    async fn service_list(&self) -> OmniResult<Vec<DockerServiceSummary>>;
    /// 创建 Swarm 服务。
    async fn service_create(&self, req: &DockerCreateServiceRequest) -> OmniResult<String>;
    /// 更新 Swarm 服务。
    async fn service_update(
        &self,
        id: &str,
        replicas: Option<u64>,
        image: Option<&str>,
    ) -> OmniResult<()>;
    /// 删除 Swarm 服务。
    async fn service_remove(&self, id: &str) -> OmniResult<()>;
    /// Swarm 服务日志。
    async fn service_logs(&self, id: &str, tail: Option<&str>) -> OmniResult<String>;
    /// 列出 Swarm 节点。
    async fn node_list(&self) -> OmniResult<Vec<DockerNodeSummary>>;
    /// 查看 Swarm 节点。
    async fn node_inspect(&self, id: &str) -> OmniResult<serde_json::Value>;
    /// 更新 Swarm 节点。
    async fn node_update(
        &self,
        id: &str,
        availability: Option<&str>,
        labels: Option<Vec<DockerKeyValue>>,
    ) -> OmniResult<()>;
    /// 删除 Swarm 节点。
    async fn node_remove(&self, id: &str, force: bool) -> OmniResult<()>;
    /// 部署 Stack（从 compose 文件）。
    async fn stack_deploy(
        &self,
        name: &str,
        compose_content: &str,
        env: Option<Vec<String>>,
    ) -> OmniResult<()>;
    /// 列出 Stack。
    async fn stack_list(&self) -> OmniResult<Vec<DockerStackSummary>>;
    /// 删除 Stack。
    async fn stack_remove(&self, name: &str) -> OmniResult<()>;
    /// 列出 Stack 中的服务。
    async fn stack_services(&self, name: &str) -> OmniResult<Vec<DockerServiceSummary>>;
}

/// 取容器 id 短格式（前 12 位）。
pub(crate) fn short_id(id: &str) -> String {
    let trimmed = id.strip_prefix("sha256:").unwrap_or(id);
    trimmed.chars().take(12).collect()
}

/// 归一化容器名：去掉前导 `/`。
pub(crate) fn normalize_name(name: &str) -> String {
    name.trim_start_matches('/').to_string()
}
