//! 1Panel 服务器面板的 Docker 适配器。
//!
//! 1Panel 通过自家的 `/api/v2/...` REST API 暴露 Docker 操作。本模块把其中
//! 高频端点（容器列表 / 详情 / 启停 / 日志 / 镜像列表 / Compose 列表）包装为
//! [`crate::DockerAdapter`]；未覆盖的端点返回明确"暂不支持"错误。
//!
//! 认证：1Panel 期望请求携带两个 header：
//! - `1Panel-Timestamp`：Unix 秒
//! - `1Panel-Token`：`md5("1panel" + API_KEY + timestamp)`
//!
//! 入口基础 URL 例：`http://192.168.1.2:9999`。

use std::time::{SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::{
    ContainerFilter, DockerAdapter, DockerBuildContext, DockerBuildResult, DockerComposeAction,
    DockerComposeProject, DockerComposeRequest, DockerComposeResult, DockerContainerAction,
    DockerContainerDetail, DockerContainerStats, DockerContainerSummary,
    DockerCreateContainerRequest, DockerCreateNetworkRequest, DockerCreateServiceRequest,
    DockerCreateVolumeRequest, DockerFileEntry, DockerImageDetail, DockerImageHistoryLayer,
    DockerImageProgress, DockerImageSummary, DockerKeyValue, DockerLogLine, DockerNetworkContainer,
    DockerNetworkDetail, DockerNetworkSubnet, DockerNetworkSummary, DockerNodeSummary,
    DockerOverview, DockerProbe, DockerPruneResult, DockerPruneVolumesResult, DockerPullResult,
    DockerServiceSummary, DockerStackSummary, DockerSystemDiskUsage, DockerVolumeDetail,
    DockerVolumeSummary, model::DockerCapabilities, model::DockerConnectionStatus,
    model::DockerDiskUsageItem,
};

/// 1Panel 客户端。
#[derive(Debug, Clone)]
pub struct OnePanelClient {
    base_url: String,
    api_key: String,
    insecure: bool,
}

/// 1Panel 标准响应包装（`{ code, message, data }`）。
#[derive(Debug, Deserialize)]
struct OnePanelResponse<T> {
    #[serde(default)]
    code: i32,
    #[serde(default)]
    message: String,
    #[serde(default = "default_data")]
    data: Option<T>,
}

fn default_data<T>() -> Option<T> {
    None
}

impl OnePanelClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>, insecure: bool) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            insecure,
        }
    }

    /// 计算 1Panel-Token 头。
    fn auth_headers(&self) -> Vec<(String, String)> {
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let digest = md5::compute(format!("1panel{}{}", self.api_key, ts));
        vec![
            ("1Panel-Timestamp".to_string(), ts.to_string()),
            ("1Panel-Token".to_string(), format!("{:x}", digest)),
        ]
    }

    /// 发起 GET 鉴权请求并把 `data` 字段反序列化出来。
    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> OmniResult<T> {
        self.request::<(), T>(reqwest::Method::GET, path, None)
            .await
    }

    /// 发起 POST 鉴权请求，把 `data` 字段反序列化出来。
    async fn post_json<B: serde::Serialize, T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: B,
    ) -> OmniResult<T> {
        self.request::<B, T>(reqwest::Method::POST, path, Some(body))
            .await
    }

    async fn request<B, T>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<B>,
    ) -> OmniResult<T>
    where
        B: serde::Serialize,
        T: for<'de> Deserialize<'de>,
    {
        let url = format!("{}{}", self.base_url, path);
        let client = reqwest::Client::builder()
            .danger_accept_invalid_certs(self.insecure)
            .timeout(std::time::Duration::from_secs(20))
            .build()
            .map_err(|e| {
                OmniError::new(ErrorCode::Connection, "构造 HTTP 客户端失败")
                    .with_cause(e.to_string())
            })?;
        let mut req = client.request(method, &url);
        for (k, v) in self.auth_headers() {
            req = req.header(k, v);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().await.map_err(|e| {
            OmniError::new(ErrorCode::Connection, "1Panel 请求失败")
                .with_cause(format!("{} ({})", e, url))
        })?;
        let status = resp.status();
        let text = resp.text().await.map_err(|e| {
            OmniError::new(ErrorCode::Connection, "读取 1Panel 响应失败")
                .with_cause(format!("{} ({})", e, url))
        })?;
        if !status.is_success() {
            return Err(
                OmniError::new(ErrorCode::Connection, format!("1Panel HTTP {}", status))
                    .with_cause(format!("{}: {}", url, text)),
            );
        }
        let parsed: OnePanelResponse<T> = serde_json::from_str(&text).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析 1Panel 响应失败")
                .with_cause(format!("{}: {}", url, e))
        })?;
        if parsed.code != 0 && parsed.code != 200 {
            return Err(OmniError::new(
                ErrorCode::Internal,
                format!("1Panel 业务错误: {}", parsed.message),
            ));
        }
        parsed
            .data
            .ok_or_else(|| OmniError::new(ErrorCode::Internal, "1Panel 响应缺少 data 字段"))
    }
}

/// 1Panel Docker 适配器。
pub struct OnePanelAdapter {
    client: OnePanelClient,
    #[allow(dead_code)]
    connection_id: String,
}

impl OnePanelAdapter {
    pub fn new(client: OnePanelClient, connection_id: String) -> Self {
        Self {
            client,
            connection_id,
        }
    }

    /// 探测：调用 `GET /api/v2/dashboard/base/os` 等轻量端点。
    pub async fn probe_raw(&self) -> OmniResult<serde_json::Value> {
        self.client.get_json("/api/v2/dashboard/base/os").await
    }

    /// 探测为统一的 DockerProbe。
    pub async fn probe_formatted(&self) -> DockerProbe {
        match self.probe_raw().await {
            Ok(v) => {
                let version = v
                    .get("data")
                    .and_then(|d| d.get("os"))
                    .and_then(|s| s.as_str())
                    .map(|s| s.to_string());
                DockerProbe {
                    status: DockerConnectionStatus::Online,
                    engine_version: version,
                    api_version: None,
                    capabilities: DockerCapabilities::onepanel(),
                    warning_message: None,
                }
            }
            Err(e) => DockerProbe {
                status: DockerConnectionStatus::Degraded,
                engine_version: None,
                api_version: None,
                capabilities: DockerCapabilities::onepanel(),
                warning_message: Some(e.message),
            },
        }
    }
}

fn not_supported(method: &str) -> OmniError {
    OmniError::new(
        ErrorCode::Internal,
        format!("1Panel 适配器暂不支持 {}；可改用本地或 SSH 连接", method),
    )
}

/// 把 1Panel 响应的 `labels/options` 字段（HashMap 或 Vec<(String,String)> 形态）
/// 统一转成 `Vec<DockerKeyValue>`；字段不存在/解析失败时返回空。
fn parse_json_labels(value: Option<&serde_json::Value>) -> Vec<DockerKeyValue> {
    let Some(v) = value else { return Vec::new() };
    if let Some(map) = v.as_object() {
        return map
            .iter()
            .map(|(k, val)| DockerKeyValue {
                key: k.clone(),
                value: val.as_str().unwrap_or_default().to_string(),
            })
            .collect();
    }
    if let Some(arr) = v.as_array() {
        return arr
            .iter()
            .filter_map(|item| {
                let obj = item.as_object()?;
                let k = obj.get("key")?.as_str()?.to_string();
                let val = obj
                    .get("value")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string();
                Some(DockerKeyValue { key: k, value: val })
            })
            .collect();
    }
    Vec::new()
}

// 1Panel 容器列表响应项（关键字段）。
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnePanelContainer {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    state: String,
    #[serde(default)]
    status: String,
    #[serde(default)]
    ports: String,
    #[serde(default)]
    networks: String,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    #[allow(dead_code)]
    command: String,
    #[serde(default)]
    #[allow(dead_code)]
    labels: std::collections::HashMap<String, String>,
}

impl OnePanelContainer {
    fn into_summary(self) -> DockerContainerSummary {
        let running = self.state.eq_ignore_ascii_case("running") || self.status.starts_with("Up");
        let ports = self
            .ports
            .split(',')
            .filter_map(|p| {
                let mapping = p.trim();
                if mapping.is_empty() {
                    None
                } else {
                    let (host_part, proto) = mapping.rsplit_once('/').unwrap_or((mapping, "tcp"));
                    if let Some((host, private)) = host_part.split_once("->") {
                        let (ip, public) = host.rsplit_once(':').unwrap_or(("0.0.0.0", host));
                        Some(crate::model::DockerPort {
                            private_port: private.trim().parse().unwrap_or(0),
                            public_port: public.trim().parse().ok(),
                            ip: Some(ip.trim().to_string()),
                            protocol: proto.to_string(),
                        })
                    } else {
                        Some(crate::model::DockerPort {
                            private_port: host_part.trim().parse().unwrap_or(0),
                            public_port: None,
                            protocol: proto.to_string(),
                            ip: None,
                        })
                    }
                }
            })
            .collect();
        let networks = self
            .networks
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "-")
            .collect();
        DockerContainerSummary {
            short_id: crate::short_id(&self.id),
            id: self.id,
            name: self.name.trim_start_matches('/').to_string(),
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
            created_at: self.created_at,
        }
    }
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnePanelImage {
    #[serde(default)]
    id: String,
    #[serde(default)]
    repository: String,
    #[serde(default)]
    tag: String,
    #[serde(default)]
    size: i64,
    #[serde(default)]
    created_at: i64,
    #[serde(default)]
    containers: i64,
}

impl OnePanelImage {
    fn into_summary(self) -> DockerImageSummary {
        let dangling = self.repository == "<none>" || self.tag == "<none>";
        DockerImageSummary {
            short_id: crate::short_id(&self.id),
            id: self.id,
            repository: self.repository,
            tag: self.tag,
            size_bytes: self.size,
            created_at: self.created_at,
            containers: self.containers,
            dangling,
        }
    }
}

#[async_trait]
impl DockerAdapter for OnePanelAdapter {
    async fn probe(&self) -> OmniResult<DockerProbe> {
        // 简化：直接以格式化版返回（无需 Result 包装）。
        let p = self.probe_formatted().await;
        if matches!(p.status, DockerConnectionStatus::Online) {
            Ok(p)
        } else {
            Err(OmniError::new(
                ErrorCode::Connection,
                p.warning_message.unwrap_or_else(|| "1Panel 不可达".into()),
            ))
        }
    }

    async fn overview(&self) -> OmniResult<DockerOverview> {
        let containers: Vec<OnePanelContainer> = self
            .client
            .post_json(
                "/api/v2/containers/search",
                serde_json::json!({ "page": 1, "pageSize": 200 }),
            )
            .await
            .map_err(|e| e.with_cause("列出 1Panel 容器失败"))?;
        let total = containers.len() as u32;
        let running = containers
            .iter()
            .filter(|c| c.state.eq_ignore_ascii_case("running"))
            .count() as u32;
        let images: Vec<OnePanelImage> = self
            .client
            .post_json(
                "/api/v2/images/search",
                serde_json::json!({ "page": 1, "pageSize": 200 }),
            )
            .await
            .unwrap_or_default();
        Ok(DockerOverview {
            capabilities: DockerCapabilities::onepanel(),
            summary: crate::model::DockerResourceSummary {
                containers_total: total,
                containers_running: running,
                containers_stopped: total - running,
                images: images.len() as u32,
            },
            engine_version: None,
            warning_message: Some("1Panel: 部分高级功能（exec/stats/BuildKit）暂不支持".into()),
        })
    }

    async fn list_containers(
        &self,
        filter: ContainerFilter,
    ) -> OmniResult<Vec<DockerContainerSummary>> {
        let raw: Vec<OnePanelContainer> = self
            .client
            .post_json(
                "/api/v2/containers/search",
                serde_json::json!({ "page": 1, "pageSize": 500 }),
            )
            .await
            .map_err(|e| e.with_cause("列出 1Panel 容器失败"))?;
        let mut out: Vec<DockerContainerSummary> = raw
            .into_iter()
            .map(OnePanelContainer::into_summary)
            .collect();
        if !filter.include_all() {
            out.retain(|c| filter.matches(c.running));
        }
        Ok(out)
    }

    async fn inspect_container(&self, id: &str) -> OmniResult<DockerContainerDetail> {
        let v: serde_json::Value = self
            .client
            .post_json(
                "/api/v2/containers/inspect",
                serde_json::json!({ "id": id }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel inspect 失败"))?;
        // 直接走 SSH/本地时 inspect 字段更丰富；1Panel 仅保证基础字段。返回
        // 简化版 detail。
        let summary = DockerContainerSummary {
            short_id: crate::short_id(id),
            id: id.to_string(),
            name: v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            image: v
                .get("image")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            state: v
                .get("state")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
            status_text: String::new(),
            running: false,
            ports: vec![],
            networks: vec![],
            created_at: 0,
        };
        Ok(DockerContainerDetail {
            summary,
            command: None,
            restart_policy: None,
            exit_code: None,
            env: vec![],
            mounts: vec![],
            networks: vec![],
        })
    }

    async fn container_action(&self, id: &str, action: DockerContainerAction) -> OmniResult<()> {
        let op = match action {
            DockerContainerAction::Start => "start",
            DockerContainerAction::Stop => "stop",
            DockerContainerAction::Restart => "restart",
            DockerContainerAction::Kill => "kill",
            DockerContainerAction::Pause => "pause",
            DockerContainerAction::Unpause => "unpause",
            DockerContainerAction::Remove => "remove",
        };
        self.client
            .post_json(
                &format!("/api/v2/containers/{op}"),
                serde_json::json!({ "id": id }),
            )
            .await
            .map(|_: serde_json::Value| ())
            .map_err(|e| e.with_cause(format!("1Panel {} 失败", op)))
    }

    async fn create_container(&self, _req: &DockerCreateContainerRequest) -> OmniResult<String> {
        Err(OmniError::not_found(
            "1Panel 暂不支持直接创建容器，请通过 Compose 或面板操作",
        ))
    }

    async fn container_logs(&self, id: &str, tail: i64) -> OmniResult<Vec<DockerLogLine>> {
        let v: serde_json::Value = self
            .client
            .post_json(
                "/api/v2/containers/log",
                serde_json::json!({ "id": id, "tail": tail }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 拉取日志失败"))?;
        let text = v
            .as_str()
            .map(|s| s.to_string())
            .or_else(|| {
                v.get("data")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string())
            })
            .unwrap_or_default();
        Ok(text
            .lines()
            .map(|l| DockerLogLine {
                stream: "stdout".into(),
                message: l.to_string(),
            })
            .collect())
    }

    async fn list_images(&self) -> OmniResult<Vec<DockerImageSummary>> {
        let raw: Vec<OnePanelImage> = self
            .client
            .post_json(
                "/api/v2/images/search",
                serde_json::json!({ "page": 1, "pageSize": 500 }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 列出镜像失败"))?;
        Ok(raw.into_iter().map(OnePanelImage::into_summary).collect())
    }

    async fn remove_image(&self, id: &str, force: bool) -> OmniResult<()> {
        self.client
            .post_json(
                "/api/v2/images/remove",
                serde_json::json!({ "id": id, "force": force }),
            )
            .await
            .map(|_: serde_json::Value| ())
            .map_err(|e| e.with_cause("1Panel 删除镜像失败"))
    }

    async fn prune_images(&self) -> OmniResult<DockerPruneResult> {
        let v: serde_json::Value = self
            .client
            .post_json("/api/v2/images/prune", serde_json::json!({}))
            .await
            .map_err(|e| e.with_cause("1Panel 清理镜像失败"))?;
        Ok(DockerPruneResult {
            deleted: vec![],
            freed_space_bytes: 0,
        })
        .map(|mut r| {
            if let Some(s) = v.get("spaceReclaimed").and_then(|x| x.as_i64()) {
                r.freed_space_bytes = s;
            }
            r
        })
    }

    async fn inspect_image(&self, _id: &str) -> OmniResult<DockerImageDetail> {
        Err(not_supported("镜像详情"))
    }

    async fn image_history(&self, _id: &str) -> OmniResult<Vec<DockerImageHistoryLayer>> {
        Err(not_supported("镜像历史"))
    }

    async fn list_compose_projects(&self) -> OmniResult<Vec<DockerComposeProject>> {
        let raw: Vec<serde_json::Value> = self
            .client
            .post_json(
                "/api/v2/compose/search",
                serde_json::json!({ "page": 1, "pageSize": 200 }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 列出 Compose 失败"))?;
        let mut projects = Vec::new();
        for v in raw {
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if name.is_empty() {
                continue;
            }
            projects.push(DockerComposeProject {
                name,
                working_dir: v
                    .get("path")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                config_files: v
                    .get("file")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                service_count: 0,
                container_count: 0,
                running_container_count: 0,
                services: vec![],
            });
        }
        Ok(projects)
    }

    async fn pull_image(
        &self,
        _image: &str,
        _progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        Err(not_supported("镜像拉取"))
    }

    async fn push_image(
        &self,
        _image: &str,
        _progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        Err(not_supported("镜像推送"))
    }

    async fn tag_image(&self, _source: &str, _target: &str) -> OmniResult<()> {
        Err(not_supported("镜像打 tag"))
    }

    async fn build_image(
        &self,
        _ctx: &DockerBuildContext,
        _progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerBuildResult> {
        Err(not_supported("镜像构建"))
    }

    async fn compose_action(
        &self,
        action: DockerComposeAction,
        req: &DockerComposeRequest,
    ) -> OmniResult<DockerComposeResult> {
        let op = match action {
            DockerComposeAction::Up => "up",
            DockerComposeAction::Down => "down",
            DockerComposeAction::Restart => "restart",
            DockerComposeAction::Pull => "pull",
            DockerComposeAction::Logs => "logs",
        };
        let v: serde_json::Value = self
            .client
            .post_json(
                &format!("/api/v2/compose/{op}"),
                serde_json::json!({
                    "name": req.project,
                    "path": req.working_dir,
                    "file": req.config_file,
                    "detached": req.detached,
                    "services": req.services,
                }),
            )
            .await
            .map_err(|e| e.with_cause(format!("1Panel compose {} 失败", op)))?;
        Ok(DockerComposeResult {
            action,
            project: req.project.clone(),
            stdout_excerpt: v.to_string(),
            stderr_excerpt: String::new(),
            exit_code: 0,
        })
    }

    async fn stream_stats(
        &self,
        _container_id: &str,
        _stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
        _sink: Box<dyn FnMut(DockerContainerStats) + Send>,
    ) -> OmniResult<()> {
        Err(not_supported("stats 实时流"))
    }

    async fn list_networks(&self) -> OmniResult<Vec<DockerNetworkSummary>> {
        let raw: Vec<serde_json::Value> = self
            .client
            .post_json(
                "/api/v2/networks/search",
                serde_json::json!({ "page": 1, "pageSize": 200 }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 列出网络失败"))?;
        Ok(raw
            .into_iter()
            .map(|v| DockerNetworkSummary {
                id: v
                    .get("id")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                name: v
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                driver: v
                    .get("driver")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                scope: v
                    .get("scope")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                internal: v.get("internal").and_then(|x| x.as_bool()).unwrap_or(false),
                created_at: 0,
            })
            .collect())
    }

    async fn create_network(&self, req: &DockerCreateNetworkRequest) -> OmniResult<String> {
        self.client
            .post_json(
                "/api/v2/networks/create",
                serde_json::json!({
                    "name": req.name,
                    "driver": req.driver,
                    "internal": req.internal,
                    "subnet": req.subnet,
                }),
            )
            .await
            .map(|_: serde_json::Value| req.name.clone())
            .map_err(|e| e.with_cause("1Panel 创建网络失败"))
    }

    async fn remove_network(&self, name: &str) -> OmniResult<()> {
        self.client
            .post_json(
                "/api/v2/networks/remove",
                serde_json::json!({ "name": name }),
            )
            .await
            .map(|_: serde_json::Value| ())
            .map_err(|e| e.with_cause("1Panel 删除网络失败"))
    }

    async fn connect_container_to_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        self.client
            .post_json(
                "/api/v2/networks/connect",
                serde_json::json!({ "name": network, "container": container_id }),
            )
            .await
            .map(|_: serde_json::Value| ())
            .map_err(|e| e.with_cause("1Panel 连接网络失败"))
    }

    async fn disconnect_container_from_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        self.client
            .post_json(
                "/api/v2/networks/disconnect",
                serde_json::json!({ "name": network, "container": container_id }),
            )
            .await
            .map(|_: serde_json::Value| ())
            .map_err(|e| e.with_cause("1Panel 断开网络失败"))
    }

    async fn list_volumes(&self) -> OmniResult<Vec<DockerVolumeSummary>> {
        let raw: Vec<serde_json::Value> = self
            .client
            .post_json(
                "/api/v2/volumes/search",
                serde_json::json!({ "page": 1, "pageSize": 200 }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 列出卷失败"))?;
        Ok(raw
            .into_iter()
            .map(|v| DockerVolumeSummary {
                name: v
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                driver: v
                    .get("driver")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                mountpoint: v
                    .get("mountpoint")
                    .and_then(|x| x.as_str())
                    .unwrap_or_default()
                    .to_string(),
                created_at: 0,
                size_bytes: -1,
                in_use: false,
            })
            .collect())
    }

    async fn create_volume(&self, req: &DockerCreateVolumeRequest) -> OmniResult<String> {
        self.client
            .post_json(
                "/api/v2/volumes/create",
                serde_json::json!({
                    "name": req.name,
                    "driver": req.driver,
                    "labels": req.labels,
                }),
            )
            .await
            .map(|_: serde_json::Value| req.name.clone())
            .map_err(|e| e.with_cause("1Panel 创建卷失败"))
    }

    async fn remove_volume(&self, name: &str, force: bool) -> OmniResult<()> {
        self.client
            .post_json(
                "/api/v2/volumes/remove",
                serde_json::json!({ "name": name, "force": force }),
            )
            .await
            .map(|_: serde_json::Value| ())
            .map_err(|e| e.with_cause("1Panel 删除卷失败"))
    }

    async fn prune_volumes(&self) -> OmniResult<DockerPruneVolumesResult> {
        let v: serde_json::Value = self
            .client
            .post_json("/api/v2/volumes/prune", serde_json::json!({}))
            .await
            .map_err(|e| e.with_cause("1Panel 清理卷失败"))?;
        Ok(DockerPruneVolumesResult {
            deleted: vec![],
            freed_space_bytes: v
                .get("spaceReclaimed")
                .and_then(|x| x.as_i64())
                .unwrap_or(0),
        })
    }

    async fn system_disk_usage(&self) -> OmniResult<DockerSystemDiskUsage> {
        let (images, volumes) = tokio::try_join!(self.list_images(), self.list_volumes())?;
        let image_size: i64 = images.iter().map(|i| i.size_bytes.max(0)).sum();
        let image_reclaimable: i64 = images
            .iter()
            .filter(|i| i.dangling)
            .map(|i| i.size_bytes.max(0))
            .sum();
        let volume_size: i64 = volumes.iter().map(|v| v.size_bytes.max(0)).sum();
        let volume_reclaimable: i64 = volumes
            .iter()
            .filter(|v| !v.in_use)
            .map(|v| v.size_bytes.max(0))
            .sum();
        Ok(DockerSystemDiskUsage {
            images: DockerDiskUsageItem {
                size_bytes: image_size,
                reclaimable_bytes: image_reclaimable,
                total_count: images.len() as i64,
                active_count: images.iter().filter(|i| !i.dangling).count() as i64,
            },
            volumes: DockerDiskUsageItem {
                size_bytes: volume_size,
                reclaimable_bytes: volume_reclaimable,
                total_count: volumes.len() as i64,
                active_count: volumes.iter().filter(|v| v.in_use).count() as i64,
            },
            ..DockerSystemDiskUsage::default()
        })
    }

    async fn prune_build_cache(&self) -> OmniResult<DockerPruneResult> {
        Err(not_supported("清理构建缓存"))
    }

    async fn inspect_network(&self, name: &str) -> OmniResult<DockerNetworkDetail> {
        let raw: Vec<serde_json::Value> = self
            .client
            .post_json(
                "/api/v2/networks/search",
                serde_json::json!({ "page": 1, "pageSize": 500 }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 查询网络详情失败"))?;
        let item = raw
            .into_iter()
            .find(|v| {
                v.get("name").and_then(|x| x.as_str()) == Some(name)
                    || v.get("id").and_then(|x| x.as_str()) == Some(name)
            })
            .ok_or_else(|| not_supported("网络详情"))?;
        let subnets = item
            .get("ipam")
            .and_then(|i| i.get("config"))
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|c| DockerNetworkSubnet {
                        subnet: c.get("subnet").and_then(|x| x.as_str()).map(String::from),
                        gateway: c.get("gateway").and_then(|x| x.as_str()).map(String::from),
                        ip_range: c.get("ipRange").and_then(|x| x.as_str()).map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let containers = item
            .get("containers")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|c| DockerNetworkContainer {
                        container_id: c
                            .get("containerId")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        name: c
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        endpoint_id: c
                            .get("endpointID")
                            .and_then(|x| x.as_str())
                            .map(String::from),
                        mac_address: c
                            .get("macAddress")
                            .and_then(|x| x.as_str())
                            .map(String::from),
                        ipv4_address: c
                            .get("ipv4Address")
                            .and_then(|x| x.as_str())
                            .map(String::from),
                        ipv6_address: c
                            .get("ipv6Address")
                            .and_then(|x| x.as_str())
                            .map(String::from),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let labels = parse_json_labels(item.get("labels"));
        let options = parse_json_labels(item.get("options"));
        Ok(DockerNetworkDetail {
            id: item
                .get("id")
                .and_then(|x| x.as_str())
                .unwrap_or(name)
                .to_string(),
            name: item
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(name)
                .to_string(),
            driver: item
                .get("driver")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
            scope: item
                .get("scope")
                .and_then(|x| x.as_str())
                .unwrap_or("local")
                .to_string(),
            internal: item
                .get("internal")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            enable_ipv6: item
                .get("enableIPv6")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
            created_at: 0,
            subnets,
            containers,
            labels,
            options,
        })
    }

    async fn inspect_volume(&self, name: &str) -> OmniResult<DockerVolumeDetail> {
        let raw: Vec<serde_json::Value> = self
            .client
            .post_json(
                "/api/v2/volumes/search",
                serde_json::json!({ "page": 1, "pageSize": 500 }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 查询卷详情失败"))?;
        let item = raw
            .into_iter()
            .find(|v| v.get("name").and_then(|x| x.as_str()) == Some(name))
            .ok_or_else(|| not_supported("卷详情"))?;
        Ok(DockerVolumeDetail {
            name: item
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or(name)
                .to_string(),
            driver: item
                .get("driver")
                .and_then(|x| x.as_str())
                .unwrap_or("local")
                .to_string(),
            mountpoint: item
                .get("mountpoint")
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string(),
            scope: item
                .get("scope")
                .and_then(|x| x.as_str())
                .unwrap_or("local")
                .to_string(),
            created_at: 0,
            size_bytes: -1,
            labels: parse_json_labels(item.get("labels")),
            options: parse_json_labels(item.get("options")),
            reference_count: 0,
        })
    }

    async fn list_container_dir(
        &self,
        _container_id: &str,
        _path: &str,
    ) -> OmniResult<Vec<DockerFileEntry>> {
        Err(not_supported("容器内文件浏览"))
    }

    async fn read_container_file(
        &self,
        _container_id: &str,
        _path: &str,
        _max_bytes: i64,
    ) -> OmniResult<Vec<u8>> {
        Err(not_supported("读取容器内文件"))
    }

    async fn write_container_file(
        &self,
        _container_id: &str,
        _path: &str,
        _data: Vec<u8>,
    ) -> OmniResult<()> {
        Err(not_supported("写入容器内文件"))
    }

    async fn swarm_init(
        &self,
        _listen_addr: Option<&str>,
        _advertise_addr: Option<&str>,
    ) -> OmniResult<String> {
        Err(not_supported("Swarm 初始化"))
    }
    async fn swarm_join(
        &self,
        _remote_addrs: Vec<String>,
        _token: &str,
        _listen_addr: Option<&str>,
    ) -> OmniResult<()> {
        Err(not_supported("Swarm 加入"))
    }
    async fn swarm_leave(&self, _force: bool) -> OmniResult<()> {
        Err(not_supported("Swarm 离开"))
    }
    async fn swarm_inspect(&self) -> OmniResult<serde_json::Value> {
        Err(not_supported("Swarm 查看"))
    }
    async fn service_list(&self) -> OmniResult<Vec<DockerServiceSummary>> {
        Err(not_supported("Swarm 服务管理"))
    }
    async fn service_create(&self, _req: &DockerCreateServiceRequest) -> OmniResult<String> {
        Err(not_supported("Swarm 服务管理"))
    }
    async fn service_update(
        &self,
        _id: &str,
        _replicas: Option<u64>,
        _image: Option<&str>,
    ) -> OmniResult<()> {
        Err(not_supported("Swarm 服务管理"))
    }
    async fn service_remove(&self, _id: &str) -> OmniResult<()> {
        Err(not_supported("Swarm 服务管理"))
    }
    async fn service_logs(&self, _id: &str, _tail: Option<&str>) -> OmniResult<String> {
        Err(not_supported("Swarm 服务管理"))
    }
    async fn node_list(&self) -> OmniResult<Vec<DockerNodeSummary>> {
        Err(not_supported("Swarm 节点管理"))
    }
    async fn node_inspect(&self, _id: &str) -> OmniResult<serde_json::Value> {
        Err(not_supported("Swarm 节点管理"))
    }
    async fn node_update(
        &self,
        _id: &str,
        _availability: Option<&str>,
        _labels: Option<Vec<DockerKeyValue>>,
    ) -> OmniResult<()> {
        Err(not_supported("Swarm 节点管理"))
    }
    async fn node_remove(&self, _id: &str, _force: bool) -> OmniResult<()> {
        Err(not_supported("Swarm 节点管理"))
    }
    async fn stack_deploy(
        &self,
        _name: &str,
        _compose_content: &str,
        _env: Option<Vec<String>>,
    ) -> OmniResult<()> {
        Err(not_supported("Stack 管理"))
    }
    async fn stack_list(&self) -> OmniResult<Vec<DockerStackSummary>> {
        Err(not_supported("Stack 管理"))
    }
    async fn stack_remove(&self, _name: &str) -> OmniResult<()> {
        Err(not_supported("Stack 管理"))
    }
    async fn stack_services(&self, _name: &str) -> OmniResult<Vec<DockerServiceSummary>> {
        Err(not_supported("Stack 管理"))
    }
}

/// 1Panel 连接配置（与 `omnipanel_store::Connection.config` JSON 一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OnePanelConnectionConfig {
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub insecure: bool,
}

impl OnePanelConnectionConfig {
    /// 从 `omnipanel_store::Connection.config` 解析。
    pub fn parse(json: &str) -> OmniResult<Self> {
        serde_json::from_str(json).map_err(|e| {
            OmniError::new(ErrorCode::InvalidInput, "1Panel 连接配置解析失败")
                .with_cause(e.to_string())
        })
    }
}

/// 从配置 + 连接 id 还原适配器实例。
pub fn adapter_from_config(
    cfg: &OnePanelConnectionConfig,
    connection_id: String,
) -> OnePanelAdapter {
    OnePanelAdapter::new(
        OnePanelClient::new(&cfg.base_url, &cfg.api_key, cfg.insecure),
        connection_id,
    )
}
