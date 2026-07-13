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
    DockerImageProgress, DockerImageSummary, DockerKeyValue, DockerLogLine, DockerLogQuery, DockerNetworkContainer,
    DockerNetworkDetail, DockerNetworkSubnet, DockerNetworkSummary, DockerNodeSummary,
    DockerOverview, DockerProbe, DockerPruneResult, DockerPruneVolumesResult, DockerPullResult,
    DockerServiceSummary, DockerStackSummary, DockerSystemDiskUsage, DockerVolumeDetail,
    DockerVolumeSummary, local::to_container_detail, model::DockerCapabilities,
    model::DockerConnectionStatus, model::DockerDaemonConfigFile, model::DockerDiskUsageItem,
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

fn status_is_json_payload(text: &str) -> bool {
    let trimmed = text.trim();
    trimmed.starts_with('{') || trimmed.starts_with('[')
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
    pub fn auth_headers(&self) -> Vec<(String, String)> {
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
        self.request::<(), T>(reqwest::Method::GET, path, None, None)
            .await
    }

    /// 发起 POST 鉴权请求，把 `data` 字段反序列化出来。
    async fn post_json<B: serde::Serialize, T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: B,
    ) -> OmniResult<T> {
        self.request::<B, T>(reqwest::Method::POST, path, Some(body), None)
            .await
    }

    /// POST 日志下载端点（`/containers/download/log` 等）：响应体可能是纯文本或 `{ data }` 包裹。
    async fn post_text<B: serde::Serialize>(&self, path: &str, body: B) -> OmniResult<String> {
        let text = self
            .request_raw(reqwest::Method::POST, path, Some(body), None)
            .await?;
        Self::parse_text_response(text)
    }

    fn parse_text_response(text: String) -> OmniResult<String> {
        if let Ok(parsed) = serde_json::from_str::<OnePanelResponse<String>>(&text) {
            if parsed.code != 0 && parsed.code != 200 {
                return Err(OmniError::new(
                    ErrorCode::Internal,
                    format!("1Panel 业务错误: {}", parsed.message),
                ));
            }
            if let Some(data) = parsed.data {
                return Ok(data);
            }
        }
        if let Ok(parsed) = serde_json::from_str::<OnePanelResponse<serde_json::Value>>(&text) {
            if parsed.code != 0 && parsed.code != 200 {
                return Err(OmniError::new(
                    ErrorCode::Internal,
                    format!("1Panel 业务错误: {}", parsed.message),
                ));
            }
            if let Some(data) = parsed.data {
                if let Some(s) = data.as_str() {
                    return Ok(s.to_string());
                }
                return Ok(data.to_string());
            }
        }
        Ok(text)
    }

    async fn request<B, T>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<B>,
        query: Option<&[(&str, &str)]>,
    ) -> OmniResult<T>
    where
        B: serde::Serialize,
        T: for<'de> Deserialize<'de>,
    {
        let text = self
            .request_raw(method, path, body, query)
            .await?;
        if !status_is_json_payload(&text) {
            return Err(OmniError::new(
                ErrorCode::Internal,
                "1Panel 响应不是合法 JSON",
            )
            .with_cause(text.chars().take(300).collect::<String>()));
        }
        let parsed: OnePanelResponse<T> = serde_json::from_str(&text).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析 1Panel 响应失败").with_cause(e.to_string())
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

    async fn request_raw<B>(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<B>,
        query: Option<&[(&str, &str)]>,
    ) -> OmniResult<String>
    where
        B: serde::Serialize,
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
        if let Some(pairs) = query {
            req = req.query(pairs);
        }
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
        Ok(text)
    }

    /// 构造容器终端 WebSocket URL（`/api/v2/hosts/terminal/container`）。
    pub fn container_terminal_ws_url(
        &self,
        container_id: &str,
        command: &str,
        cols: u16,
        rows: u16,
    ) -> OmniResult<String> {
        let ws_base = self
            .base_url
            .replace("https://", "wss://")
            .replace("http://", "ws://");
        let mut url = reqwest::Url::parse(&format!("{ws_base}/api/v2/hosts/terminal/container"))
            .map_err(|e| {
                OmniError::new(ErrorCode::Connection, "构造 1Panel 终端 URL 失败")
                    .with_cause(e.to_string())
            })?;
        {
            let mut pairs = url.query_pairs_mut();
            pairs.append_pair("cols", &cols.to_string());
            pairs.append_pair("rows", &rows.to_string());
            pairs.append_pair("source", "container");
            pairs.append_pair("containerid", container_id.trim());
            pairs.append_pair("user", "");
            pairs.append_pair("command", command.trim());
            pairs.append_pair("operateNode", "local");
        }
        Ok(url.to_string())
    }

    /// WebSocket TLS 连接器（支持跳过自签证书校验）。
    pub fn ws_connector(&self) -> Option<tokio_tungstenite::Connector> {
        if !self.base_url.starts_with("https://") {
            return None;
        }
        let tls = native_tls::TlsConnector::builder()
            .danger_accept_invalid_certs(self.insecure)
            .build()
            .ok()?;
        Some(tokio_tungstenite::Connector::NativeTls(tls))
    }

    /// POST 分页 search 接口，兼容 `{ items, total }` 与旧版直接数组。
    async fn post_search_values(
        &self,
        path: &str,
        body: serde_json::Value,
    ) -> OmniResult<Vec<serde_json::Value>> {
        let data: serde_json::Value = self.post_json(path, body).await?;
        extract_search_items(data)
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

    /// 批量获取容器 CPU / 内存占用（1Panel `GET /containers/list/stats`）。
    pub async fn list_container_stats(&self) -> OmniResult<Vec<DockerContainerStats>> {
        fetch_onepanel_container_stats(&self.client).await
    }

    /// 创建 1Panel 容器 WebSocket 交互终端。
    pub async fn create_container_exec(
        &self,
        container_id: &str,
        shell: &str,
        cols: u16,
        rows: u16,
    ) -> OmniResult<(crate::local::DockerExecSession, crate::local::DockerExecOutput)> {
        let (session, output) = crate::onepanel_terminal::create_container_exec(
            &self.client,
            container_id,
            shell,
            cols,
            rows,
        )
        .await?;
        Ok((crate::local::DockerExecSession::OnePanel(session), output))
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

fn extract_search_items(data: serde_json::Value) -> OmniResult<Vec<serde_json::Value>> {
    if data.is_array() {
        return Ok(data
            .as_array()
            .cloned()
            .unwrap_or_default());
    }
    if let Some(items) = data.get("items") {
        if items.is_array() {
            return Ok(items.as_array().cloned().unwrap_or_default());
        }
        if items.is_null() {
            return Ok(Vec::new());
        }
    }
    Err(OmniError::new(
        ErrorCode::Internal,
        "1Panel 分页响应缺少 items 数组",
    )
    .with_cause(data.to_string()))
}

fn json_str(value: Option<&serde_json::Value>) -> String {
    value
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

fn parse_f64_value(v: &serde_json::Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn parse_u64_i64(v: &serde_json::Value) -> Option<i64> {
    v.as_u64()
        .map(|n| n as i64)
        .or_else(|| v.as_i64())
}

async fn fetch_onepanel_container_stats(
    client: &OnePanelClient,
) -> OmniResult<Vec<DockerContainerStats>> {
    let api_path = "/api/v2/containers/list/stats";
    tracing::debug!(
        target: "docker_stats",
        source = "onepanel",
        api = %api_path,
        "请求 1Panel 容器 stats API"
    );
    let raw: Vec<serde_json::Value> = client
        .get_json(api_path)
        .await
        .map_err(|e| e.with_cause("1Panel 获取容器统计失败"))?;
    tracing::debug!(
        target: "docker_stats",
        source = "onepanel",
        api = %api_path,
        raw_count = raw.len(),
        "1Panel 容器 stats 原始响应"
    );
    let stats: Vec<DockerContainerStats> = raw
        .into_iter()
        .filter_map(|v| parse_container_list_stats(&v))
        .collect();
    tracing::debug!(
        target: "docker_stats",
        source = "onepanel",
        parsed_count = stats.len(),
        sample = ?stats.first().map(|s| (s.container_id.as_str(), s.cpu_percent, s.memory_percent, s.memory_usage_bytes)),
        "1Panel 容器 stats 解析完成"
    );
    Ok(stats)
}

fn parse_container_list_stats(v: &serde_json::Value) -> Option<DockerContainerStats> {
    let container_id = json_str(
        v.get("containerID")
            .or_else(|| v.get("containerId"))
            .or_else(|| v.get("id")),
    );
    if container_id.is_empty() {
        return None;
    }
    let memory_limit = v.get("memoryLimit").and_then(parse_u64_i64);
    Some(DockerContainerStats {
        container_id: container_id.clone(),
        name: String::new(),
        cpu_percent: v
            .get("cpuPercent")
            .and_then(parse_f64_value)
            .unwrap_or(0.0),
        memory_usage_bytes: v
            .get("memoryUsage")
            .and_then(parse_u64_i64)
            .unwrap_or(0),
        memory_limit_bytes: memory_limit.filter(|limit| *limit > 0),
        memory_percent: v
            .get("memoryPercent")
            .and_then(parse_f64_value)
            .unwrap_or(0.0),
        net_rx_bytes: 0,
        net_tx_bytes: 0,
        block_read_bytes: 0,
        block_write_bytes: 0,
        timestamp_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    })
}

fn parse_container_summary(v: &serde_json::Value) -> Option<DockerContainerSummary> {
    let id = json_str(
        v.get("containerID")
            .or_else(|| v.get("id"))
            .or_else(|| v.get("containerId")),
    );
    if id.is_empty() {
        return None;
    }
    let name = json_str(v.get("name"));
    let image = json_str(
        v.get("imageName")
            .or_else(|| v.get("image"))
            .or_else(|| v.get("imageID")),
    );
    let state = json_str(v.get("state"));
    let status = json_str(v.get("runTime").or_else(|| v.get("status")));
    let running = state.eq_ignore_ascii_case("running") || status.starts_with("Up");
    let ports = v
        .get("ports")
        .map(parse_container_ports)
        .unwrap_or_default();
    let mut networks = v
        .get("network")
        .or_else(|| v.get("networks"))
        .map(parse_string_list)
        .unwrap_or_default();
    let mut extracted_ip = None::<String>;
    networks.retain(|name| {
        if is_likely_ip_address(name) {
            if extracted_ip.is_none() {
                extracted_ip = Some(name.clone());
            }
            false
        } else {
            true
        }
    });
    let (network_attachments, mut ip_address) = parse_container_network_meta(v, &networks);
    if ip_address.is_none() {
        ip_address = extracted_ip;
    }
    let network_names: Vec<String> = if network_attachments.is_empty() {
        networks
    } else {
        network_attachments
            .iter()
            .map(|item| item.name.clone())
            .collect()
    };
    let labels = parse_json_labels(v.get("labels"));
    let (compose_project, compose_service) = crate::compose::compose_fields_from_kv(&labels);
    Some(DockerContainerSummary {
        short_id: crate::short_id(&id),
        id,
        name: name.trim_start_matches('/').to_string(),
        image,
        state: if state.is_empty() {
            if running {
                "running".into()
            } else {
                "exited".into()
            }
        } else {
            state.to_lowercase()
        },
        status_text: status,
        running,
        ports,
        networks: network_names,
        ip_address,
        network_attachments,
        created_at: v
            .get("createTime")
            .or_else(|| v.get("createdAt"))
            .map(parse_i64_value)
            .unwrap_or(0),
        compose_project,
        compose_service,
    })
}

fn parse_image_summary(v: &serde_json::Value) -> Option<DockerImageSummary> {
    let id = json_str(v.get("id"));
    if id.is_empty() {
        return None;
    }
    let tags: Vec<String> = v
        .get("tags")
        .and_then(|t| t.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|item| item.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let name = json_str(v.get("name"));
    let (repository, tag) = if !tags.is_empty() {
        let first = &tags[0];
        if let Some((repo, tag)) = first.rsplit_once(':') {
            (repo.to_string(), tag.to_string())
        } else {
            (first.clone(), "latest".to_string())
        }
    } else if let Some((repo, tag)) = name.rsplit_once(':') {
        (repo.to_string(), tag.to_string())
    } else {
        (
            json_str(v.get("repository")),
            json_str(v.get("tag")).if_empty_then("latest"),
        )
    };
    let dangling = repository == "<none>" || tag == "<none>";
    let is_used = v.get("isUsed").and_then(|x| x.as_bool()).unwrap_or(false);
    Some(DockerImageSummary {
        short_id: crate::short_id(&id),
        id,
        repository,
        tag,
        size_bytes: v.get("size").map(parse_image_size_bytes).unwrap_or(0),
        created_at: v
            .get("createdAt")
            .or_else(|| v.get("createTime"))
            .map(parse_i64_value)
            .unwrap_or(0),
        containers: v
            .get("containers")
            .and_then(|x| x.as_i64())
            .unwrap_or(if is_used { 1 } else { 0 }),
        dangling,
    })
}

trait EmptyDefault {
    fn if_empty_then(self, fallback: &str) -> String;
}

impl EmptyDefault for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

async fn fetch_container_summaries(
    client: &OnePanelClient,
    page_size: u32,
) -> OmniResult<Vec<DockerContainerSummary>> {
    let raw = client
        .post_search_values(
            "/api/v2/containers/search",
            container_search_body(1, page_size),
        )
        .await
        .map_err(|e| e.with_cause("列出 1Panel 容器失败"))?;
    Ok(raw.iter().filter_map(parse_container_summary).collect())
}

async fn fetch_image_summaries(
    client: &OnePanelClient,
    page_size: u32,
) -> OmniResult<Vec<DockerImageSummary>> {
    let raw = client
        .post_search_values(
            "/api/v2/containers/image/search",
            image_search_body(1, page_size),
        )
        .await
        .map_err(|e| e.with_cause("1Panel 列出镜像失败"))?;
    Ok(raw.iter().filter_map(parse_image_summary).collect())
}

fn container_search_body(page: u32, page_size: u32) -> serde_json::Value {
    serde_json::json!({
        "name": "",
        "state": "all",
        "page": page,
        "pageSize": page_size,
        "filters": "",
        "orderBy": "createdAt",
        "order": "null",
    })
}

fn image_search_body(page: u32, page_size: u32) -> serde_json::Value {
    serde_json::json!({
        "name": "",
        "page": page,
        "pageSize": page_size,
        "orderBy": "createdAt",
        "order": "null",
    })
}

fn generic_search_body(page: u32, page_size: u32) -> serde_json::Value {
    serde_json::json!({
        "info": "",
        "page": page,
        "pageSize": page_size,
        "orderBy": "createdAt",
        "order": "null",
    })
}

fn parse_container_ports(value: &serde_json::Value) -> Vec<crate::model::DockerPort> {
    if let Some(text) = value.as_str() {
        return text
            .split(',')
            .filter_map(|p| parse_container_port_mapping(p.trim()))
            .collect();
    }
    if let Some(arr) = value.as_array() {
        return arr
            .iter()
            .filter_map(|item| {
                if let Some(mapping) = item.as_str() {
                    return parse_container_port_mapping(mapping);
                }
                let host_port = item
                    .get("hostPort")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse().ok());
                let private_port = item
                    .get("containerPort")
                    .and_then(|v| v.as_str())
                    .and_then(|s| s.parse().ok())
                    .or_else(|| item.get("privatePort").and_then(|v| v.as_u64()).map(|n| n as u16))?;
                let protocol = item
                    .get("protocol")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tcp")
                    .to_string();
                let ip = item
                    .get("hostIP")
                    .or_else(|| item.get("host"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                Some(crate::model::DockerPort {
                    private_port,
                    public_port: host_port,
                    ip,
                    protocol,
                })
            })
            .collect();
    }
    Vec::new()
}

fn parse_container_port_mapping(mapping: &str) -> Option<crate::model::DockerPort> {
    if mapping.is_empty() {
        return None;
    }
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

fn parse_container_network_meta(
    value: &serde_json::Value,
    fallback_names: &[String],
) -> (Vec<crate::model::DockerNetworkAttachment>, Option<String>) {
    let mut attachments = Vec::new();
    let network_value = value
        .get("networkList")
        .or_else(|| value.get("networks"))
        .or_else(|| value.get("network"));
    if let Some(arr) = network_value.and_then(|v| v.as_array()) {
        for item in arr {
            let Some(obj) = item.as_object() else { continue };
            let name = json_str(
                obj.get("network")
                    .or_else(|| obj.get("name"))
                    .or_else(|| obj.get("networkName")),
            );
            if name.is_empty() {
                continue;
            }
            let ip = obj
                .get("ipv4")
                .or_else(|| obj.get("ip"))
                .or_else(|| obj.get("ipAddress"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            attachments.push(crate::model::DockerNetworkAttachment {
                name,
                ip_address: ip,
            });
        }
    }
    let mut ip_address = value
        .get("ip")
        .or_else(|| value.get("ipAddress"))
        .or_else(|| value.get("ipv4"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            attachments
                .iter()
                .find_map(|item| item.ip_address.clone())
        });
    if attachments.is_empty() && !fallback_names.is_empty() {
        let mut fallback_ip = None::<String>;
        let mut names = Vec::new();
        for name in fallback_names {
            if is_likely_ip_address(name) {
                if fallback_ip.is_none() {
                    fallback_ip = Some(name.clone());
                }
            } else {
                names.push(name.clone());
            }
        }
        attachments = names
            .into_iter()
            .map(|name| crate::model::DockerNetworkAttachment {
                name,
                ip_address: None,
            })
            .collect();
        if ip_address.is_none() {
            ip_address = fallback_ip;
        }
    }
    (attachments, ip_address)
}

fn is_likely_ip_address(text: &str) -> bool {
    let s = text.trim();
    if s.is_empty() {
        return false;
    }
    if s.parse::<std::net::Ipv4Addr>().is_ok() {
        return true;
    }
    if s.contains(':') {
        return s.parse::<std::net::Ipv6Addr>().is_ok();
    }
    false
}

fn parse_string_list(value: &serde_json::Value) -> Vec<String> {
    if let Some(text) = value.as_str() {
        return text
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && s != "-")
            .collect();
    }
    if let Some(arr) = value.as_array() {
        return arr
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| item.get("network").and_then(|v| v.as_str()).map(String::from))
            })
            .filter(|s| !s.is_empty())
            .collect();
    }
    Vec::new()
}

fn parse_i64_value(value: &serde_json::Value) -> i64 {
    if let Some(n) = value.as_i64() {
        return n;
    }
    if let Some(n) = value.as_u64() {
        return n as i64;
    }
    if let Some(n) = value.as_f64() {
        return n as i64;
    }
    if let Some(text) = value.as_str() {
        if let Ok(n) = text.parse::<i64>() {
            return n;
        }
        // 1Panel 常见 RFC3339 时间戳，解析失败时返回 0
    }
    0
}

fn parse_image_size_bytes(value: &serde_json::Value) -> i64 {
    if let Some(n) = value.as_i64() {
        return n;
    }
    let Some(text) = value.as_str() else {
        return 0;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if let Ok(n) = trimmed.parse::<i64>() {
        return n;
    }
    let upper = trimmed.to_ascii_uppercase();
    let (num_part, unit) = upper
        .split_at(upper.len().saturating_sub(2));
    let multiplier = match unit {
        "KB" => 1024,
        "MB" => 1024 * 1024,
        "GB" => 1024 * 1024 * 1024,
        "TB" => 1024_i64.pow(4),
        _ => 1,
    };
    num_part
        .trim()
        .parse::<f64>()
        .map(|n| (n * multiplier as f64) as i64)
        .unwrap_or(0)
}

fn container_ref_matches(summary: &DockerContainerSummary, id: &str) -> bool {
    let needle = id.trim().trim_start_matches('/').to_lowercase();
    if needle.is_empty() {
        return false;
    }
    summary.id.to_lowercase() == needle
        || summary.short_id.to_lowercase() == needle
        || summary.name.to_lowercase() == needle
        || summary.id.to_lowercase().ends_with(&needle)
        || needle.ends_with(&summary.short_id.to_lowercase())
}

async fn resolve_container_name(client: &OnePanelClient, id: &str) -> String {
    if let Ok(list) = fetch_container_summaries(client, 500).await {
        if let Some(summary) = list.iter().find(|c| container_ref_matches(c, id)) {
            return summary.name.clone();
        }
    }
    id.trim().trim_start_matches('/').to_string()
}

fn parse_onepanel_file_mode(mode: &str) -> u32 {
    let trimmed = mode.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return trimmed.parse().unwrap_or(0);
    }
    if trimmed.len() >= 10 {
        let mut value: u32 = match trimmed.chars().next() {
            Some('d') => 0o040000,
            Some('l') => 0o120000,
            Some('b') => 0o060000,
            Some('c') => 0o020000,
            Some('p') => 0o010000,
            Some('s') => 0o140000,
            _ => 0,
        };
        for (idx, ch) in trimmed.chars().skip(1).take(9).enumerate() {
            let bit = match ch {
                'r' => 4,
                'w' => 2,
                'x' | 's' | 'S' | 't' | 'T' => 1,
                _ => 0,
            };
            value |= bit << (8 - idx);
        }
        return value;
    }
    0
}

fn parse_onepanel_file_entry(v: &serde_json::Value) -> Option<DockerFileEntry> {
    let name = json_str(v.get("name"));
    if name.is_empty() {
        return None;
    }
    let path = json_str(v.get("path")).if_empty_then(&name);
    let is_dir = v.get("isDir").and_then(|x| x.as_bool()).unwrap_or(false);
    let is_symlink = v.get("isLink").and_then(|x| x.as_bool()).unwrap_or(false);
    let mode = v
        .get("mode")
        .and_then(|x| x.as_str())
        .map(parse_onepanel_file_mode)
        .unwrap_or(0);
    Some(DockerFileEntry {
        name,
        path,
        size_bytes: v.get("size").and_then(parse_u64_i64).unwrap_or(0),
        modified_at: 0,
        mode,
        is_dir,
        is_symlink,
    })
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
        let containers = fetch_container_summaries(&self.client, 200).await?;
        let total = containers.len() as u32;
        let running = containers.iter().filter(|c| c.running).count() as u32;
        let images = fetch_image_summaries(&self.client, 200)
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
            warning_message: Some("1Panel: 部分高级功能（stats/BuildKit）暂不支持".into()),
        })
    }

    async fn list_containers(
        &self,
        filter: ContainerFilter,
    ) -> OmniResult<Vec<DockerContainerSummary>> {
        let mut out = fetch_container_summaries(&self.client, 500).await?;
        if !filter.include_all() {
            out.retain(|c| filter.matches(c.running));
        }
        Ok(out)
    }

    async fn inspect_container(&self, id: &str) -> OmniResult<DockerContainerDetail> {
        let inspect_text: String = self
            .client
            .post_json(
                "/api/v2/containers/inspect",
                serde_json::json!({ "id": id, "type": "container" }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel inspect 失败"))?;
        let value: serde_json::Value = serde_json::from_str(inspect_text.trim()).map_err(|e| {
            OmniError::new(ErrorCode::Internal, "解析 1Panel inspect JSON 失败")
                .with_cause(e.to_string())
        })?;
        let inspect_value = if value.is_array() {
            value.get(0).cloned().ok_or_else(|| {
                OmniError::new(ErrorCode::NotFound, format!("容器 {id} 不存在"))
            })?
        } else {
            value
        };
        let raw: bollard::models::ContainerInspectResponse =
            serde_json::from_value(inspect_value).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "解析容器 inspect 结构失败")
                    .with_cause(e.to_string())
            })?;
        Ok(to_container_detail(raw))
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

    async fn container_logs(&self, id: &str, query: &DockerLogQuery) -> OmniResult<Vec<DockerLogLine>> {
        let container_name = resolve_container_name(&self.client, id).await;
        let tail_value = query.tail_or_default();
        let since = query.since_for_onepanel();
        // GET /containers/search/log 为 SSE 流式接口；批量拉取应走 POST /containers/download/log
        let text = self
            .client
            .post_text(
                "/api/v2/containers/download/log",
                serde_json::json!({
                    "container": container_name,
                    "containerType": "container",
                    "since": since,
                    "tail": tail_value,
                    "timestamp": true,
                }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 拉取日志失败"))?;
        Ok(text
            .lines()
            .filter(|line| !line.is_empty())
            .map(|line| DockerLogLine {
                stream: "stdout".into(),
                message: line.to_string(),
            })
            .collect())
    }

    async fn clear_container_logs(&self, id: &str) -> OmniResult<()> {
        let container_name = resolve_container_name(&self.client, id).await;
        self.client
            .post_json::<_, serde_json::Value>(
                "/api/v2/containers/clean/log",
                serde_json::json!({ "name": container_name }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 清空容器日志失败"))?;
        Ok(())
    }

    async fn list_images(&self) -> OmniResult<Vec<DockerImageSummary>> {
        Ok(fetch_image_summaries(&self.client, 500).await?)
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
            .post_search_values(
                "/api/v2/containers/compose/search",
                generic_search_body(1, 200),
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
                    .or_else(|| v.get("workdir"))
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                config_files: v
                    .get("file")
                    .or_else(|| v.get("configFile"))
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
            DockerComposeAction::Rebuild => "up",
            DockerComposeAction::Pull => "pull",
            DockerComposeAction::Logs => "logs",
        };
        let mut body = serde_json::json!({
            "name": req.project,
            "path": req.working_dir,
            "file": req.config_file,
            "detached": req.detached,
            "services": req.services,
        });
        if matches!(action, DockerComposeAction::Rebuild) {
            body["detached"] = serde_json::json!(true);
            body["build"] = serde_json::json!(true);
            body["force"] = serde_json::json!(true);
        }
        let v: serde_json::Value = self
            .client
            .post_json(&format!("/api/v2/compose/{op}"), body)
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

    async fn list_container_stats(
        &self,
        container_ids: Option<&[String]>,
    ) -> OmniResult<Vec<DockerContainerStats>> {
        let all = fetch_onepanel_container_stats(&self.client).await?;
        Ok(match container_ids {
            Some(ids) if !ids.is_empty() => crate::stats::filter_by_container_ids(all, ids),
            _ => all,
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
            .post_search_values(
                "/api/v2/containers/network/search",
                generic_search_body(1, 200),
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
            .post_search_values(
                "/api/v2/containers/volume/search",
                generic_search_body(1, 200),
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
            .post_search_values(
                "/api/v2/containers/network/search",
                generic_search_body(1, 500),
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
            .post_search_values(
                "/api/v2/containers/volume/search",
                generic_search_body(1, 500),
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
        container_id: &str,
        path: &str,
    ) -> OmniResult<Vec<DockerFileEntry>> {
        let path = if path.trim().is_empty() { "/" } else { path };
        let raw: Vec<serde_json::Value> = self
            .client
            .post_json(
                "/api/v2/containers/files/search",
                serde_json::json!({
                    "containerID": container_id,
                    "path": path,
                }),
            )
            .await
            .map_err(|e| e.with_cause("1Panel 列出容器目录失败"))?;
        let mut entries: Vec<DockerFileEntry> = raw
            .iter()
            .filter_map(parse_onepanel_file_entry)
            .collect();
        entries.sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
        Ok(entries)
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

    async fn read_daemon_config(&self) -> OmniResult<DockerDaemonConfigFile> {
        let content: String = self
            .client
            .get_json("/api/v2/containers/daemonjson/file")
            .await
            .map_err(|e| e.with_cause("1Panel 读取 daemon.json 失败"))?;
        Ok(DockerDaemonConfigFile {
            content: if content.trim().is_empty() {
                "{}\n".to_string()
            } else {
                content
            },
            path: "daemon.json".to_string(),
            editable: true,
        })
    }

    async fn write_daemon_config(&self, content: &str) -> OmniResult<()> {
        #[derive(serde::Serialize)]
        struct Body<'a> {
            file: &'a str,
        }
        self.client
            .post_json::<Body<'_>, serde_json::Value>(
                "/api/v2/containers/daemonjson/update/byfile",
                Body { file: content },
            )
            .await
            .map(|_| ())
            .map_err(|e| e.with_cause("1Panel 更新 daemon.json 失败"))
    }

    async fn restart_docker_daemon(&self) -> OmniResult<()> {
        #[derive(serde::Serialize)]
        struct Body {
            operation: &'static str,
        }
        self.client
            .post_json::<Body, serde_json::Value>(
                "/api/v2/containers/docker/operate",
                Body {
                    operation: "restart",
                },
            )
            .await
            .map(|_| ())
            .map_err(|e| e.with_cause("1Panel 重启 Docker 失败"))
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
