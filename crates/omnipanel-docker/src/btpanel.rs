//! 宝塔（BT Panel）Docker 适配器。
//!
//! 通过宝塔 Docker 插件 `/btdocker/...` HTTP API 暴露容器 / 镜像 / 网络 / 卷 / Compose 项目。
//! 无对应面板接口的能力委托给绑定 SSH（[`SshDockerAdapter`]）。
//! 鉴权与 `omnipanel-server` / `src-tauri` 的宝塔客户端一致：
//! `request_time` + `request_token = md5(time + md5(api_sk))`，POST `application/x-www-form-urlencoded`。
//!
//! 文档标注多为 GET，实际面板与现有客户端统一走 POST + 表单。

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshSession;
use reqwest::cookie::Jar;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::ssh::SshDockerAdapter;
use crate::{
    short_id, ContainerFilter, DockerAdapter, DockerBuildContext, DockerBuildResult,
    DockerComposeAction, DockerComposeProject, DockerComposeProjectFiles,
    DockerComposeReadFilesRequest, DockerComposeRequest, DockerComposeResult, DockerComposeService,
    DockerContainerAction, DockerContainerDetail, DockerContainerLogInfo, DockerContainerStats,
    DockerContainerSummary, DockerCreateContainerRequest, DockerCreateNetworkRequest,
    DockerCreateServiceRequest, DockerCreateVolumeRequest, DockerFileEntry, DockerImageDetail,
    DockerImageHistoryLayer, DockerImageProgress, DockerImageSearchPage, DockerImageSummary,
    DockerKeyValue, DockerLogLine, DockerLogQuery, DockerNetworkDetail, DockerNetworkSummary,
    DockerNodeSummary, DockerOverview, DockerPort, DockerProbe, DockerPruneResult,
    DockerPruneVolumesResult, DockerPullResult, DockerServiceSummary, DockerStackSummary,
    DockerSystemDiskUsage, DockerVolumeDetail, DockerVolumeSummary,
    model::{DockerCapabilities, DockerConnectionStatus},
};

const DEFAULT_HTTP_TIMEOUT: Duration = Duration::from_secs(30);

/// 宝塔面板 Docker HTTP 客户端。
#[derive(Clone)]
pub struct BtPanelClient {
    base_url: String,
    api_key: String,
    insecure: bool,
    /// 与官方文档一致：复用 Cookie 罐，API 握手后保存面板返回的 Cookie。
    cookie_jar: Arc<Jar>,
}

impl std::fmt::Debug for BtPanelClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BtPanelClient")
            .field("base_url", &self.base_url)
            .field("api_key_len", &self.api_key.len())
            .field("insecure", &self.insecure)
            .finish()
    }
}

impl BtPanelClient {
    pub fn new(base_url: impl Into<String>, api_key: impl Into<String>, insecure: bool) -> Self {
        Self {
            base_url: normalize_base_url(&base_url.into()),
            api_key: api_key.into(),
            insecure,
            cookie_jar: Arc::new(Jar::default()),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn insecure(&self) -> bool {
        self.insecure
    }

    fn build_http_client(&self) -> OmniResult<reqwest::Client> {
        reqwest::Client::builder()
            .cookie_provider(self.cookie_jar.clone())
            // 与面板客户端一致：宝塔普遍自签证书
            .danger_accept_invalid_certs(true)
            .timeout(DEFAULT_HTTP_TIMEOUT)
            .build()
            .map_err(|e| {
                OmniError::new(ErrorCode::Connection, "构造宝塔 HTTP 客户端失败")
                    .with_cause(e.to_string())
            })
    }

    /// 生成 request_token：`md5(string(request_time) + md5(api_sk))`（小写 hex）。
    pub fn build_request_token(api_sk: &str, request_time: i64) -> String {
        let api_key_md5 = format!("{:x}", md5::compute(api_sk));
        let payload = format!("{request_time}{api_key_md5}");
        format!("{:x}", md5::compute(payload))
    }

    fn current_timestamp() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }

    fn build_form_params(&self, extra: &Map<String, Value>) -> Vec<(String, String)> {
        let request_time = Self::current_timestamp();
        let request_token = Self::build_request_token(&self.api_key, request_time);
        let mut params = vec![
            ("request_time".to_string(), request_time.to_string()),
            ("request_token".to_string(), request_token),
        ];
        for (key, value) in extra {
            if let Some(text) = value_to_form_string(value) {
                params.push((key.clone(), text));
            }
        }
        params
    }

    /// POST 表单到宝塔路径，返回解析后的 JSON。
    pub async fn post_form(&self, path: &str, extra: Map<String, Value>) -> OmniResult<Value> {
        let path = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };
        let url = format!("{}{path}", self.base_url);
        let form = self.build_form_params(&extra);
        let started = std::time::Instant::now();

        tracing::warn!(
            target: "btpanel",
            %url,
            insecure = self.insecure,
            api_key_len = self.api_key.len(),
            form_keys = ?form.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>(),
            "宝塔 HTTP POST 开始"
        );

        let client = self.build_http_client()?;
        let resp = client
            .post(&url)
            .header("Accept", "application/json, text/plain, */*")
            .form(&form)
            .send()
            .await
            .map_err(|e| {
                let detail = e.to_string();
                tracing::warn!(
                    target: "btpanel",
                    %url,
                    error = %detail,
                    insecure_flag = self.insecure,
                    elapsed_ms = started.elapsed().as_millis(),
                    "宝塔 HTTP 请求失败"
                );
                map_http_send_error(&detail, &url)
            })?;

        let status = resp.status();
        let text = resp.text().await.map_err(|e| {
            OmniError::new(ErrorCode::Connection, "读取宝塔响应失败")
                .with_cause(format!("{e} ({url})"))
        })?;

        tracing::warn!(
            target: "btpanel",
            %url,
            http_status = %status,
            body_len = text.len(),
            body_preview = %truncate_text(&text, 400),
            elapsed_ms = started.elapsed().as_millis(),
            "宝塔 HTTP 响应"
        );

        if status == reqwest::StatusCode::UNAUTHORIZED {
            return Err(OmniError::new(ErrorCode::Auth, "宝塔 API 接口密钥错误").with_cause(text));
        }
        if !status.is_success() {
            // 业务/路由类 HTTP 错误用 Internal，避免前端一律当成「实例离线」
            return Err(
                OmniError::new(ErrorCode::Internal, format!("宝塔 API 错误 ({status})"))
                    .with_cause(truncate_text(&text, 300)),
            );
        }

        let parsed = parse_response_value(&text)?;
        tracing::warn!(
            target: "btpanel",
            %url,
            shape = %summarize_json_shape(&parsed),
            "宝塔 HTTP JSON 已解析"
        );
        Ok(parsed)
    }

    /// 发起请求并校验业务 `status`（若存在）；成功时尽量解包 `msg` 载荷。
    pub async fn post_form_payload(
        &self,
        path: &str,
        extra: Map<String, Value>,
    ) -> OmniResult<Value> {
        let value = self.post_form(path, extra).await?;
        let unwrapped = unwrap_bt_payload(value)?;
        tracing::debug!(
            target: "btpanel",
            %path,
            shape = %summarize_json_shape(&unwrapped),
            "宝塔 payload 解包后"
        );
        Ok(unwrapped)
    }

    /// 动作类接口：期望 `{ status: true, msg: "..." }`。
    pub async fn post_form_ok(&self, path: &str, extra: Map<String, Value>) -> OmniResult<()> {
        let value = self.post_form(path, extra).await?;
        if let Some(status) = value.get("status") {
            if status.as_bool() == Some(false) {
                let msg = value
                    .get("msg")
                    .and_then(|m| m.as_str())
                    .unwrap_or("宝塔 API 业务失败");
                return Err(OmniError::new(ErrorCode::Internal, msg.to_string()));
            }
        }
        Ok(())
    }
}

/// 宝塔 Docker 适配器。
pub struct BtPanelAdapter {
    client: BtPanelClient,
    connection_id: String,
    ssh: Arc<SshSession>,
}

impl BtPanelAdapter {
    pub fn new(client: BtPanelClient, connection_id: String, ssh: Arc<SshSession>) -> Self {
        Self {
            client,
            connection_id,
            ssh,
        }
    }

    pub fn client(&self) -> &BtPanelClient {
        &self.client
    }

    fn ssh(&self) -> SshDockerAdapter {
        SshDockerAdapter::new(self.ssh.clone())
    }
}

fn normalize_base_url(host: &str) -> String {
    let mut normalized = host.trim().trim_end_matches('/').to_string();
    if !normalized.is_empty()
        && !normalized.starts_with("http://")
        && !normalized.starts_with("https://")
    {
        normalized = format!("http://{normalized}");
    }
    normalized
}

fn value_to_form_string(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::Bool(b) => Some(b.to_string()),
        Value::Number(n) => Some(n.to_string()),
        Value::String(s) => Some(s.clone()),
        _ => Some(value.to_string()),
    }
}

fn truncate_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    format!("{}…", &text[..max])
}

/// 包装错误上下文，保留原 message/cause，避免 `with_cause` 覆盖掉真实原因。
fn map_bt_context(err: OmniError, context: &str) -> OmniError {
    let detail = err.user_message();
    OmniError::new(err.code, context).with_cause(detail)
}

fn map_http_send_error(detail: &str, url: &str) -> OmniError {
    let lower = detail.to_ascii_lowercase();
    if lower.contains("certificate")
        || lower.contains("cert")
        || lower.contains("tls")
        || lower.contains("ssl")
        || lower.contains("handshake")
    {
        return OmniError::new(
            ErrorCode::Connection,
            "宝塔 HTTPS 证书校验失败（面板多为自签证书）",
        )
        .with_cause(format!("{detail} | {url}"));
    }
    if lower.contains("timed out") || lower.contains("timeout") {
        return OmniError::new(ErrorCode::Timeout, "连接宝塔面板超时")
            .with_cause(format!("{detail} | {url}"));
    }
    OmniError::new(ErrorCode::Connection, "宝塔面板请求失败")
        .with_cause(format!("{detail} | {url}"))
}

/// 诊断用：概括 JSON 形态（不含敏感长文本全文）。
fn summarize_json_shape(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => format!("bool:{b}"),
        Value::Number(n) => format!("number:{n}"),
        Value::String(s) => format!("string(len={})", s.len()),
        Value::Array(a) => {
            let first = a
                .first()
                .map(summarize_json_shape)
                .unwrap_or_else(|| "-".into());
            format!("array(len={}, first={})", a.len(), first)
        }
        Value::Object(o) => {
            let keys: Vec<&str> = o.keys().map(String::as_str).take(16).collect();
            let status = o.get("status").map(summarize_json_shape);
            let msg = o.get("msg").map(summarize_json_shape);
            let data = o.get("data").map(summarize_json_shape);
            format!(
                "object(keys={:?}, status={:?}, msg={:?}, data={:?})",
                keys, status, msg, data
            )
        }
    }
}

fn value_id_debug(v: &Value) -> String {
    for key in ["container_id", "id", "Id", "cid", "containerId"] {
        if let Some(val) = v.get(key) {
            return format!(
                "{key}={}",
                match val {
                    Value::String(s) => format!("string({s})"),
                    Value::Number(n) => format!("number({n})"),
                    other => summarize_json_shape(other),
                }
            );
        }
    }
    let keys: Vec<&str> = v
        .as_object()
        .map(|o| o.keys().map(String::as_str).take(12).collect())
        .unwrap_or_default();
    format!("no_id_field keys={keys:?}")
}

fn parse_response_value(text: &str) -> OmniResult<Value> {
    let trimmed = text.trim_start_matches('\u{feff}').trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("<!doctype") || lower.starts_with("<html") {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "宝塔面板返回了 HTML 页面而非 JSON（请检查面板地址/安全入口，或会话 Cookie 是否过期）",
        )
        .with_cause(truncate_text(trimmed, 300)));
    }
    serde_json::from_str(trimmed).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "宝塔面板响应不是合法 JSON").with_cause(format!(
            "{}; body: {}",
            e,
            truncate_text(trimmed, 300)
        ))
    })
}

/// 解包宝塔常见响应：`{status, msg}` 中 msg 为对象/数组时取 msg；status=false 报错。
fn unwrap_bt_payload(value: Value) -> OmniResult<Value> {
    if let Some(status) = value.get("status") {
        if status.as_bool() == Some(false) {
            let msg = value
                .get("msg")
                .and_then(|m| m.as_str())
                .unwrap_or("宝塔 API 业务失败");
            tracing::warn!(
                target: "btpanel",
                msg,
                shape = %summarize_json_shape(&value),
                "宝塔业务 status=false"
            );
            let code = if msg.contains("密钥") || msg.contains("校验") || msg.contains("权限") {
                ErrorCode::Auth
            } else {
                ErrorCode::Internal
            };
            return Err(OmniError::new(code, msg.to_string()));
        }
        if let Some(msg) = value.get("msg") {
            if msg.is_object() || msg.is_array() {
                tracing::debug!(
                    target: "btpanel",
                    from = "msg",
                    shape = %summarize_json_shape(msg),
                    "宝塔 unwrap 取 msg"
                );
                return Ok(msg.clone());
            }
            tracing::debug!(
                target: "btpanel",
                msg_shape = %summarize_json_shape(msg),
                "宝塔 msg 非对象/数组，保留整包"
            );
        }
    }
    Ok(value)
}

fn form_map(pairs: &[(&str, Value)]) -> Map<String, Value> {
    let mut map = Map::new();
    for (k, v) in pairs {
        map.insert((*k).to_string(), v.clone());
    }
    map
}

fn json_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_u64().map(|n| n as i64))
        .or_else(|| v.as_f64().map(|n| n as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
}

fn json_str(v: &Value) -> Option<&str> {
    v.as_str()
}

/// 接受 string / number 的 id 字段（宝塔部分接口把 id 写成数字）。
fn json_id_string(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
        return Some(s.to_string());
    }
    if let Some(n) = v.as_i64() {
        return Some(n.to_string());
    }
    if let Some(n) = v.as_u64() {
        return Some(n.to_string());
    }
    None
}

fn parse_ports(ports: &Value) -> Vec<DockerPort> {
    match ports {
        Value::Array(arr) => arr
            .iter()
            .filter_map(|p| {
                let private = p
                    .get("PrivatePort")
                    .or_else(|| p.get("private_port"))
                    .or_else(|| p.get("containerPort"))
                    .and_then(json_i64)? as u16;
                let public = p
                    .get("PublicPort")
                    .or_else(|| p.get("public_port"))
                    .or_else(|| p.get("hostPort"))
                    .and_then(json_i64)
                    .map(|n| n as u16);
                let protocol = p
                    .get("Type")
                    .or_else(|| p.get("type"))
                    .or_else(|| p.get("protocol"))
                    .and_then(json_str)
                    .unwrap_or("tcp")
                    .to_string();
                let ip = p
                    .get("IP")
                    .or_else(|| p.get("ip"))
                    .or_else(|| p.get("HostIp"))
                    .and_then(json_str)
                    .map(str::to_string);
                Some(DockerPort {
                    private_port: private,
                    public_port: public,
                    protocol,
                    ip,
                })
            })
            .collect(),
        Value::Object(map) => {
            let mut out = Vec::new();
            for (key, val) in map {
                // key 形如 "80/tcp"
                let (private, protocol) = match key.split_once('/') {
                    Some((port, proto)) => (port.parse::<u16>().ok(), proto.to_string()),
                    None => (key.parse::<u16>().ok(), "tcp".to_string()),
                };
                let Some(private_port) = private else {
                    continue;
                };
                if let Some(arr) = val.as_array() {
                    if arr.is_empty() {
                        out.push(DockerPort {
                            private_port,
                            public_port: None,
                            protocol: protocol.clone(),
                            ip: None,
                        });
                    } else {
                        for bind in arr {
                            let public = bind
                                .get("HostPort")
                                .or_else(|| bind.get("hostPort"))
                                .and_then(json_i64)
                                .or_else(|| bind.as_str().and_then(|s| s.parse().ok()))
                                .map(|n| n as u16);
                            let ip = bind
                                .get("HostIp")
                                .or_else(|| bind.get("hostIp"))
                                .and_then(json_str)
                                .map(str::to_string);
                            out.push(DockerPort {
                                private_port,
                                public_port: public,
                                protocol: protocol.clone(),
                                ip,
                            });
                        }
                    }
                } else {
                    out.push(DockerPort {
                        private_port,
                        public_port: None,
                        protocol,
                        ip: None,
                    });
                }
            }
            out
        }
        Value::String(s) if !s.trim().is_empty() => {
            // 降级：无法结构化时不填端口
            Vec::new()
        }
        _ => Vec::new(),
    }
}

fn normalize_state(status: &str) -> (String, bool) {
    let lower = status.trim().to_ascii_lowercase();
    let running = lower == "running" || lower.starts_with("up");
    let state = if lower.contains("running") || lower.starts_with("up") {
        "running"
    } else if lower.contains("exited") || lower.contains("exit") {
        "exited"
    } else if lower.contains("paused") {
        "paused"
    } else if lower.contains("restarting") {
        "restarting"
    } else if lower.contains("created") {
        "created"
    } else if lower.contains("dead") {
        "dead"
    } else if lower.is_empty() {
        "unknown"
    } else {
        lower.as_str()
    };
    (state.to_string(), running)
}

fn parse_container_item(v: &Value) -> Option<DockerContainerSummary> {
    let id = v
        .get("container_id")
        .or_else(|| v.get("id"))
        .or_else(|| v.get("Id"))
        .or_else(|| v.get("cid"))
        .and_then(json_id_string)
        .filter(|s| !s.is_empty())?;
    let name = v
        .get("name")
        .or_else(|| v.get("Names"))
        .and_then(|n| {
            if let Some(s) = n.as_str() {
                Some(s.trim_start_matches('/').to_string())
            } else if let Some(arr) = n.as_array() {
                arr.first()
                    .and_then(|x| x.as_str())
                    .map(|s| s.trim_start_matches('/').to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| short_id(&id));
    let image = v
        .get("image")
        .or_else(|| v.get("Image"))
        .and_then(json_str)
        .unwrap_or("")
        .to_string();
    let status_text = v
        .get("status")
        .or_else(|| v.get("State"))
        .or_else(|| v.get("status_text"))
        .and_then(json_str)
        .unwrap_or("")
        .to_string();
    let (state, running) = normalize_state(&status_text);
    let ports = v
        .get("ports")
        .or_else(|| v.get("Ports"))
        .map(parse_ports)
        .unwrap_or_default();
    let created_at = v
        .get("created")
        .or_else(|| v.get("Created"))
        .or_else(|| v.get("created_at"))
        .and_then(json_i64)
        .unwrap_or(0);

    Some(DockerContainerSummary {
        id: id.clone(),
        short_id: short_id(&id),
        name,
        image,
        state,
        status_text,
        running,
        ports,
        networks: Vec::new(),
        ip_address: None,
        network_attachments: Vec::new(),
        created_at,
        compose_project: None,
        compose_service: None,
        compose_working_dir: None,
        compose_config_files: None,
    })
}

fn extract_container_list(payload: &Value) -> Vec<DockerContainerSummary> {
    let list = payload
        .get("container_list")
        .or_else(|| payload.get("data"))
        .or_else(|| payload.get("msg"))
        .unwrap_or(payload);
    let source = if payload.get("container_list").is_some() {
        "container_list"
    } else if payload.get("data").is_some() {
        "data"
    } else if payload.get("msg").is_some() {
        "msg"
    } else {
        "root"
    };
    let arr = match list {
        Value::Array(a) => a.as_slice(),
        Value::Object(o) => {
            if let Some(Value::Array(a)) = o.get("container_list") {
                a.as_slice()
            } else if let Some(Value::Array(a)) = o.get("list") {
                a.as_slice()
            } else {
                &[]
            }
        }
        _ => &[],
    };

    let mut parsed = Vec::with_capacity(arr.len());
    let mut skipped = 0usize;
    let mut first_skip_reason: Option<String> = None;
    for item in arr {
        match parse_container_item(item) {
            Some(c) => parsed.push(c),
            None => {
                skipped += 1;
                if first_skip_reason.is_none() {
                    first_skip_reason = Some(value_id_debug(item));
                }
            }
        }
    }

    tracing::info!(
        target: "btpanel",
        payload_shape = %summarize_json_shape(payload),
        list_source = source,
        raw_count = arr.len(),
        parsed_count = parsed.len(),
        skipped_count = skipped,
        first_skip = first_skip_reason.as_deref().unwrap_or("-"),
        "宝塔容器列表解析结果"
    );
    if !arr.is_empty() && parsed.is_empty() {
        tracing::warn!(
            target: "btpanel",
            first_item = %truncate_text(&arr[0].to_string(), 500),
            "宝塔容器原始条数>0 但解析后为空（字段不匹配？）"
        );
    }
    parsed
}

fn split_image_name(name: &str) -> (String, String) {
    let name = name.trim();
    if name.is_empty() {
        return ("<none>".into(), "<none>".into());
    }
    // 忽略 digest
    let without_digest = name.split('@').next().unwrap_or(name);
    if let Some((repo, tag)) = without_digest.rsplit_once(':') {
        // 避免把 registry:port 误判为 tag
        if !tag.contains('/') {
            return (repo.to_string(), tag.to_string());
        }
    }
    (without_digest.to_string(), "latest".to_string())
}

fn parse_image_item(v: &Value) -> Option<DockerImageSummary> {
    let id = v
        .get("id")
        .or_else(|| v.get("Id"))
        .and_then(json_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return None;
    }
    let full_name = v
        .get("name")
        .or_else(|| v.get("RepoTags"))
        .and_then(|n| {
            if let Some(s) = n.as_str() {
                Some(s.to_string())
            } else if let Some(arr) = n.as_array() {
                arr.first()
                    .and_then(|x| x.as_str())
                    .map(str::to_string)
            } else {
                None
            }
        })
        .unwrap_or_default();
    let tag_field = v.get("tag").and_then(json_str).map(str::to_string);
    let (repository, tag) = if let Some(t) = tag_field {
        let repo = if full_name.is_empty() {
            "<none>".into()
        } else if let Some((r, _)) = full_name.rsplit_once(':') {
            r.to_string()
        } else {
            full_name.clone()
        };
        (repo, t)
    } else {
        split_image_name(&full_name)
    };
    let size_bytes = v
        .get("size")
        .or_else(|| v.get("Size"))
        .and_then(json_i64)
        .unwrap_or(0);
    let created_at = v
        .get("created")
        .or_else(|| v.get("Created"))
        .and_then(json_i64)
        .unwrap_or(0);
    let containers = v
        .get("used")
        .or_else(|| v.get("containers"))
        .and_then(json_i64)
        .unwrap_or(0);
    let dangling = repository == "<none>" || tag == "<none>";

    Some(DockerImageSummary {
        id: id.clone(),
        short_id: short_id(&id),
        repository,
        tag,
        size_bytes,
        created_at,
        containers,
        dangling,
    })
}

fn extract_array_payload(payload: &Value) -> &[Value] {
    match payload {
        Value::Array(a) => a.as_slice(),
        Value::Object(o) => o
            .get("data")
            .or_else(|| o.get("msg"))
            .or_else(|| o.get("list"))
            .and_then(|v| v.as_array())
            .map(|a| a.as_slice())
            .unwrap_or(&[]),
        _ => &[],
    }
}

fn parse_network_item(v: &Value) -> Option<DockerNetworkSummary> {
    let name = v
        .get("name")
        .or_else(|| v.get("Name"))
        .and_then(json_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let id = v
        .get("id")
        .or_else(|| v.get("Id"))
        .and_then(json_str)
        .unwrap_or(name.as_str())
        .to_string();
    let driver = v
        .get("driver")
        .or_else(|| v.get("Driver"))
        .and_then(json_str)
        .unwrap_or("")
        .to_string();
    let scope = v
        .get("scope")
        .or_else(|| v.get("Scope"))
        .and_then(json_str)
        .unwrap_or("local")
        .to_string();
    let internal = v
        .get("internal")
        .or_else(|| v.get("Internal"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);
    let created_at = v
        .get("created")
        .or_else(|| v.get("Created"))
        .and_then(json_i64)
        .unwrap_or(0);
    let ipv4_subnet = v
        .get("subnet")
        .or_else(|| v.get("Subnet"))
        .and_then(json_str)
        .map(str::to_string);
    let ipv4_gateway = v
        .get("gateway")
        .or_else(|| v.get("Gateway"))
        .and_then(json_str)
        .map(str::to_string);

    Some(DockerNetworkSummary {
        id,
        name,
        driver,
        scope,
        internal,
        created_at,
        ipv4_subnet,
        ipv4_gateway,
    })
}

fn parse_volume_item(v: &Value) -> Option<DockerVolumeSummary> {
    let name = v
        .get("name")
        .or_else(|| v.get("Name"))
        .and_then(json_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let driver = v
        .get("driver")
        .or_else(|| v.get("Driver"))
        .and_then(json_str)
        .unwrap_or("local")
        .to_string();
    let mountpoint = v
        .get("mountpoint")
        .or_else(|| v.get("Mountpoint"))
        .and_then(json_str)
        .unwrap_or("")
        .to_string();
    let created_at = v
        .get("created")
        .or_else(|| v.get("CreatedAt"))
        .and_then(json_i64)
        .unwrap_or(0);
    let size_bytes = v
        .get("size")
        .or_else(|| v.get("Size"))
        .and_then(json_i64)
        .unwrap_or(-1);
    let in_use = v
        .get("in_use")
        .or_else(|| v.get("InUse"))
        .and_then(|x| x.as_bool())
        .unwrap_or(false);

    Some(DockerVolumeSummary {
        name,
        driver,
        mountpoint,
        created_at,
        size_bytes,
        in_use,
    })
}

fn parse_compose_project(v: &Value) -> Option<DockerComposeProject> {
    let name = v
        .get("server_name")
        .or_else(|| v.get("name"))
        .or_else(|| v.get("project"))
        .or_else(|| v.get("Name"))
        .and_then(json_str)
        .filter(|s| !s.is_empty())?
        .to_string();
    let raw_path = v
        .get("path")
        .or_else(|| v.get("compose_file"))
        .or_else(|| v.get("config_files"))
        .and_then(json_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let (working_dir, config_files) = {
        let explicit_wd = v
            .get("working_dir")
            .or_else(|| v.get("dir"))
            .and_then(json_str)
            .map(str::to_string);
        let explicit_file = v
            .get("compose_file")
            .or_else(|| v.get("config_files"))
            .and_then(json_str)
            .filter(|s| {
                let lower = s.to_ascii_lowercase();
                lower.ends_with(".yml") || lower.ends_with(".yaml")
            })
            .map(str::to_string);
        match raw_path {
            Some(p) if is_compose_file_path(&p) => (
                explicit_wd.or_else(|| parent_dir_of(&p)),
                Some(explicit_file.unwrap_or(p)),
            ),
            Some(p) => (explicit_wd.or(Some(p)), explicit_file),
            None => (explicit_wd, explicit_file),
        }
    };
    let container_count = v
        .get("container_count")
        .or_else(|| v.get("containers"))
        .and_then(json_i64)
        .unwrap_or(0) as u32;
    let run_status = v
        .get("run_status")
        .and_then(json_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    let running_container_count = v
        .get("running")
        .or_else(|| v.get("running_count"))
        .and_then(json_i64)
        .map(|n| n as u32)
        .unwrap_or_else(|| {
            if run_status == "running" || run_status == "1" {
                container_count
            } else {
                0
            }
        });
    let services = v
        .get("services")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|s| {
                    let svc_name = s
                        .get("name")
                        .or_else(|| s.get("service"))
                        .and_then(json_str)?
                        .to_string();
                    Some(DockerComposeService {
                        name: svc_name,
                        image: s
                            .get("image")
                            .and_then(json_str)
                            .unwrap_or("")
                            .to_string(),
                        container_count: 1,
                        running_container_count: 0,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let service_count = if services.is_empty() {
        container_count
    } else {
        services.len() as u32
    };

    Some(DockerComposeProject {
        name,
        working_dir,
        config_files,
        service_count,
        container_count,
        running_container_count,
        services,
    })
}

fn parent_dir_of(path: &str) -> Option<String> {
    let p = Path::new(path);
    p.parent()
        .map(|d| d.to_string_lossy().replace('\\', "/"))
        .filter(|s| !s.is_empty())
}

fn is_compose_file_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".yml") || lower.ends_with(".yaml")
}

async fn fetch_containers(client: &BtPanelClient) -> OmniResult<Vec<DockerContainerSummary>> {
    tracing::warn!(
        target: "btpanel",
        base_url = %client.base_url(),
        "fetch_containers 开始"
    );
    let payload = client
        .post_form_payload("/btdocker/container/get_list", Map::new())
        .await
        .map_err(|e| {
            tracing::warn!(
                target: "btpanel",
                error = %e,
                detail = %e.user_message(),
                "fetch_containers HTTP/业务失败"
            );
            map_bt_context(e, "宝塔列出容器失败")
        })?;
    let list = extract_container_list(&payload);
    tracing::warn!(
        target: "btpanel",
        count = list.len(),
        "fetch_containers 完成"
    );
    Ok(list)
}

async fn fetch_images(client: &BtPanelClient) -> OmniResult<Vec<DockerImageSummary>> {
    tracing::warn!(target: "btpanel", "fetch_images 开始");
    let payload = client
        .post_form_payload("/btdocker/image/image_list", Map::new())
        .await
        .map_err(|e| {
            tracing::warn!(
                target: "btpanel",
                error = %e,
                detail = %e.user_message(),
                "fetch_images 失败"
            );
            map_bt_context(e, "宝塔列出镜像失败")
        })?;
    let raw = extract_array_payload(&payload);
    let mut parsed = Vec::new();
    let mut skipped = 0usize;
    let mut first_skip: Option<String> = None;
    for item in raw {
        match parse_image_item(item) {
            Some(img) => parsed.push(img),
            None => {
                skipped += 1;
                if first_skip.is_none() {
                    first_skip = Some(value_id_debug(item));
                }
            }
        }
    }
    tracing::warn!(
        target: "btpanel",
        payload_shape = %summarize_json_shape(&payload),
        raw_count = raw.len(),
        parsed_count = parsed.len(),
        skipped_count = skipped,
        first_skip = first_skip.as_deref().unwrap_or("-"),
        "fetch_images 解析结果"
    );
    Ok(parsed)
}

#[async_trait]
impl DockerAdapter for BtPanelAdapter {
    async fn probe(&self) -> OmniResult<DockerProbe> {
        match self
            .client
            .post_form_payload("/btdocker/setup/get_config", Map::new())
            .await
        {
            Ok(v) => {
                let installed = v
                    .get("docker_installed")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(true);
                let running = v
                    .get("service_status")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(true);
                let warning = if !installed {
                    Some("宝塔主机未安装 Docker".to_string())
                } else if !running {
                    Some("宝塔主机 Docker 服务未运行".to_string())
                } else {
                    None
                };
                let status = if installed && running {
                    DockerConnectionStatus::Online
                } else if installed {
                    DockerConnectionStatus::Degraded
                } else {
                    DockerConnectionStatus::Offline
                };
                if matches!(status, DockerConnectionStatus::Offline) {
                    return Err(OmniError::new(
                        ErrorCode::Connection,
                        warning.unwrap_or_else(|| "宝塔 Docker 不可用".into()),
                    ));
                }
                Ok(DockerProbe {
                    status,
                    engine_version: None,
                    api_version: None,
                    capabilities: DockerCapabilities::btpanel(),
                    warning_message: warning,
                })
            }
            Err(e) => {
                // 回退：用容器列表探测连通性
                match fetch_containers(&self.client).await {
                    Ok(_) => Ok(DockerProbe {
                        status: DockerConnectionStatus::Online,
                        engine_version: None,
                        api_version: None,
                        capabilities: DockerCapabilities::btpanel(),
                        warning_message: Some(format!(
                            "setup/get_config 不可用，已回退列表探测：{}",
                            e.message
                        )),
                    }),
                    Err(list_err) => Err(OmniError::new(
                        ErrorCode::Connection,
                        format!("宝塔不可达：{}", list_err.message),
                    )
                    .with_cause(e.message)),
                }
            }
        }
    }

    async fn overview(&self) -> OmniResult<DockerOverview> {
        let containers = fetch_containers(&self.client).await?;
        let total = containers.len() as u32;
        let running = containers.iter().filter(|c| c.running).count() as u32;
        let images = fetch_images(&self.client).await.unwrap_or_default();
        Ok(DockerOverview {
            capabilities: DockerCapabilities::btpanel(),
            summary: crate::model::DockerResourceSummary {
                containers_total: total,
                containers_running: running,
                containers_stopped: total.saturating_sub(running),
                images: images.len() as u32,
            },
            engine_version: None,
            warning_message: Some("无面板接口的能力走绑定 SSH".into()),
        })
    }

    async fn list_containers(
        &self,
        filter: ContainerFilter,
    ) -> OmniResult<Vec<DockerContainerSummary>> {
        tracing::info!(
            target: "btpanel",
            connection_id = %self.connection_id,
            filter = ?filter,
            "BtPanelAdapter::list_containers"
        );
        let mut out = fetch_containers(&self.client).await?;
        if !filter.include_all() {
            out.retain(|c| filter.matches(c.running));
        }
        tracing::info!(
            target: "btpanel",
            connection_id = %self.connection_id,
            after_filter = out.len(),
            "BtPanelAdapter::list_containers 完成"
        );
        Ok(out)
    }

    async fn inspect_container(&self, id: &str) -> OmniResult<DockerContainerDetail> {
        self.ssh().inspect_container(id).await
    }

    async fn container_action(&self, id: &str, action: DockerContainerAction) -> OmniResult<()> {
        let path = match action {
            DockerContainerAction::Start => "/btdocker/container/start",
            DockerContainerAction::Stop => "/btdocker/container/stop",
            DockerContainerAction::Restart => "/btdocker/container/restart",
            DockerContainerAction::Remove => {
                // 文档未统一 remove；依次尝试 remove / del
                let body = form_map(&[("id", Value::String(id.to_string()))]);
                let first = self
                    .client
                    .post_form_ok("/btdocker/container/remove", body.clone())
                    .await;
                if first.is_ok() {
                    return Ok(());
                }
                let second = self
                    .client
                    .post_form_ok("/btdocker/container/del", body)
                    .await;
                return match second {
                    Ok(()) => Ok(()),
                    Err(e2) => Err(OmniError::new(
                        ErrorCode::Internal,
                        format!(
                            "宝塔删除容器失败：已尝试 /btdocker/container/remove 与 /del。{}",
                            e2.message
                        ),
                    )
                    .with_cause(
                        first
                            .err()
                            .map(|e| e.message)
                            .unwrap_or_default(),
                    )),
                };
            }
            DockerContainerAction::Kill
            | DockerContainerAction::Pause
            | DockerContainerAction::Unpause => {
                return self.ssh().container_action(id, action).await;
            }
        };
        self.client
            .post_form_ok(path, form_map(&[("id", Value::String(id.to_string()))]))
            .await
            .map_err(|e| {
                e.with_cause(format!(
                    "宝塔容器 {} 失败",
                    match action {
                        DockerContainerAction::Start => "启动",
                        DockerContainerAction::Stop => "停止",
                        DockerContainerAction::Restart => "重启",
                        _ => "操作",
                    }
                ))
            })
    }

    async fn create_container(&self, req: &DockerCreateContainerRequest) -> OmniResult<String> {
        self.ssh().create_container(req).await
    }

    async fn container_logs(
        &self,
        id: &str,
        query: &DockerLogQuery,
    ) -> OmniResult<Vec<DockerLogLine>> {
        self.ssh().container_logs(id, query).await
    }

    async fn clear_container_logs(&self, id: &str) -> OmniResult<()> {
        self.ssh().clear_container_logs(id).await
    }

    async fn list_container_log_infos(&self) -> OmniResult<Vec<DockerContainerLogInfo>> {
        self.ssh().list_container_log_infos().await
    }

    async fn list_images(&self) -> OmniResult<Vec<DockerImageSummary>> {
        fetch_images(&self.client).await
    }

    async fn inspect_image(&self, id: &str) -> OmniResult<DockerImageDetail> {
        self.ssh().inspect_image(id).await
    }

    async fn image_history(&self, id: &str) -> OmniResult<Vec<DockerImageHistoryLayer>> {
        self.ssh().image_history(id).await
    }

    async fn remove_image(&self, id: &str, force: bool) -> OmniResult<()> {
        self.ssh().remove_image(id, force).await
    }

    async fn prune_images(&self) -> OmniResult<DockerPruneResult> {
        self.ssh().prune_images().await
    }

    async fn search_images(
        &self,
        term: &str,
        limit: u32,
    ) -> OmniResult<DockerImageSearchPage> {
        self.ssh().search_images(term, limit).await
    }

    async fn list_compose_projects(&self) -> OmniResult<Vec<DockerComposeProject>> {
        tracing::info!(
            target: "btpanel",
            connection_id = %self.connection_id,
            "BtPanelAdapter::list_compose_projects"
        );
        match self
            .client
            .post_form_payload("/btdocker/project/get_project_list", Map::new())
            .await
        {
            Ok(payload) => {
                let raw = extract_array_payload(&payload);
                let projects: Vec<_> = raw.iter().filter_map(parse_compose_project).collect();
                tracing::info!(
                    target: "btpanel",
                    payload_shape = %summarize_json_shape(&payload),
                    raw_count = raw.len(),
                    parsed_count = projects.len(),
                    "list_compose_projects HTTP 解析结果"
                );
                Ok(projects)
            }
            Err(e) => {
                tracing::warn!(
                    target: "btpanel",
                    error = %e.user_message(),
                    "宝塔 HTTP 列出 Compose 项目失败，回退绑定 SSH"
                );
                self.ssh().list_compose_projects().await
            }
        }
    }

    async fn pull_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        self.ssh().pull_image(image, progress).await
    }

    async fn push_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        self.ssh().push_image(image, progress).await
    }

    async fn tag_image(&self, source: &str, target: &str) -> OmniResult<()> {
        self.ssh().tag_image(source, target).await
    }

    async fn build_image(
        &self,
        ctx: &DockerBuildContext,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerBuildResult> {
        self.ssh().build_image(ctx, progress).await
    }

    async fn compose_action(
        &self,
        action: DockerComposeAction,
        req: &DockerComposeRequest,
    ) -> OmniResult<DockerComposeResult> {
        self.ssh().compose_action(action, req).await
    }

    async fn read_compose_project_files(
        &self,
        req: &DockerComposeReadFilesRequest,
    ) -> OmniResult<DockerComposeProjectFiles> {
        self.ssh().read_compose_project_files(req).await
    }

    async fn list_container_stats(
        &self,
        container_ids: Option<&[String]>,
    ) -> OmniResult<Vec<DockerContainerStats>> {
        self.ssh().list_container_stats(container_ids).await
    }

    async fn stream_stats(
        &self,
        container_id: &str,
        stop: Arc<std::sync::atomic::AtomicBool>,
        sink: Box<dyn FnMut(DockerContainerStats) + Send>,
    ) -> OmniResult<()> {
        self.ssh().stream_stats(container_id, stop, sink).await
    }

    async fn list_networks(&self) -> OmniResult<Vec<DockerNetworkSummary>> {
        let payload = self
            .client
            .post_form_payload("/btdocker/network/get_host_network", Map::new())
            .await
            .map_err(|e| map_bt_context(e, "宝塔列出网络失败"))?;
        let raw = extract_array_payload(&payload);
        let networks: Vec<_> = raw.iter().filter_map(parse_network_item).collect();
        tracing::info!(
            target: "btpanel",
            payload_shape = %summarize_json_shape(&payload),
            raw_count = raw.len(),
            parsed_count = networks.len(),
            "list_networks 解析结果"
        );
        Ok(networks)
    }

    async fn inspect_network(&self, name_or_id: &str) -> OmniResult<DockerNetworkDetail> {
        self.ssh().inspect_network(name_or_id).await
    }

    async fn create_network(&self, req: &DockerCreateNetworkRequest) -> OmniResult<String> {
        self.ssh().create_network(req).await
    }

    async fn remove_network(&self, name: &str) -> OmniResult<()> {
        self.ssh().remove_network(name).await
    }

    async fn prune_networks(&self) -> OmniResult<DockerPruneResult> {
        self.ssh().prune_networks().await
    }

    async fn connect_container_to_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        self.ssh()
            .connect_container_to_network(network, container_id)
            .await
    }

    async fn disconnect_container_from_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        self.ssh()
            .disconnect_container_from_network(network, container_id)
            .await
    }

    async fn list_volumes(&self) -> OmniResult<Vec<DockerVolumeSummary>> {
        let payload = self
            .client
            .post_form_payload("/btdocker/volume/get_volume_list", Map::new())
            .await
            .map_err(|e| map_bt_context(e, "宝塔列出卷失败"))?;
        let raw = extract_array_payload(&payload);
        let volumes: Vec<_> = raw.iter().filter_map(parse_volume_item).collect();
        tracing::info!(
            target: "btpanel",
            payload_shape = %summarize_json_shape(&payload),
            raw_count = raw.len(),
            parsed_count = volumes.len(),
            "list_volumes 解析结果"
        );
        Ok(volumes)
    }

    async fn inspect_volume(&self, name: &str) -> OmniResult<DockerVolumeDetail> {
        self.ssh().inspect_volume(name).await
    }

    async fn create_volume(&self, req: &DockerCreateVolumeRequest) -> OmniResult<String> {
        self.ssh().create_volume(req).await
    }

    async fn remove_volume(&self, name: &str, force: bool) -> OmniResult<()> {
        self.ssh().remove_volume(name, force).await
    }

    async fn prune_volumes(&self) -> OmniResult<DockerPruneVolumesResult> {
        self.ssh().prune_volumes().await
    }

    async fn system_disk_usage(&self) -> OmniResult<DockerSystemDiskUsage> {
        self.ssh().system_disk_usage().await
    }

    async fn prune_build_cache(&self) -> OmniResult<DockerPruneResult> {
        self.ssh().prune_build_cache().await
    }

    async fn list_container_dir(
        &self,
        container_id: &str,
        path: &str,
    ) -> OmniResult<Vec<DockerFileEntry>> {
        self.ssh().list_container_dir(container_id, path).await
    }

    async fn read_container_file(
        &self,
        container_id: &str,
        path: &str,
        max_bytes: i64,
    ) -> OmniResult<Vec<u8>> {
        self.ssh()
            .read_container_file(container_id, path, max_bytes)
            .await
    }

    async fn write_container_file(
        &self,
        container_id: &str,
        path: &str,
        data: Vec<u8>,
    ) -> OmniResult<()> {
        self.ssh()
            .write_container_file(container_id, path, data)
            .await
    }

    async fn swarm_init(
        &self,
        listen_addr: Option<&str>,
        advertise_addr: Option<&str>,
    ) -> OmniResult<String> {
        self.ssh().swarm_init(listen_addr, advertise_addr).await
    }

    async fn swarm_join(
        &self,
        remote_addrs: Vec<String>,
        token: &str,
        listen_addr: Option<&str>,
    ) -> OmniResult<()> {
        self.ssh()
            .swarm_join(remote_addrs, token, listen_addr)
            .await
    }

    async fn swarm_leave(&self, force: bool) -> OmniResult<()> {
        self.ssh().swarm_leave(force).await
    }

    async fn swarm_inspect(&self) -> OmniResult<serde_json::Value> {
        self.ssh().swarm_inspect().await
    }

    async fn service_list(&self) -> OmniResult<Vec<DockerServiceSummary>> {
        self.ssh().service_list().await
    }

    async fn service_create(&self, req: &DockerCreateServiceRequest) -> OmniResult<String> {
        self.ssh().service_create(req).await
    }

    async fn service_update(
        &self,
        id: &str,
        replicas: Option<u64>,
        image: Option<&str>,
    ) -> OmniResult<()> {
        self.ssh().service_update(id, replicas, image).await
    }

    async fn service_remove(&self, id: &str) -> OmniResult<()> {
        self.ssh().service_remove(id).await
    }

    async fn service_logs(&self, id: &str, tail: Option<&str>) -> OmniResult<String> {
        self.ssh().service_logs(id, tail).await
    }

    async fn node_list(&self) -> OmniResult<Vec<DockerNodeSummary>> {
        self.ssh().node_list().await
    }

    async fn node_inspect(&self, id: &str) -> OmniResult<serde_json::Value> {
        self.ssh().node_inspect(id).await
    }

    async fn node_update(
        &self,
        id: &str,
        availability: Option<&str>,
        labels: Option<Vec<DockerKeyValue>>,
    ) -> OmniResult<()> {
        self.ssh().node_update(id, availability, labels).await
    }

    async fn node_remove(&self, id: &str, force: bool) -> OmniResult<()> {
        self.ssh().node_remove(id, force).await
    }

    async fn stack_deploy(
        &self,
        name: &str,
        compose_content: &str,
        env: Option<Vec<String>>,
    ) -> OmniResult<()> {
        self.ssh()
            .stack_deploy(name, compose_content, env)
            .await
    }

    async fn stack_list(&self) -> OmniResult<Vec<DockerStackSummary>> {
        self.ssh().stack_list().await
    }

    async fn stack_remove(&self, name: &str) -> OmniResult<()> {
        self.ssh().stack_remove(name).await
    }

    async fn stack_services(&self, name: &str) -> OmniResult<Vec<DockerServiceSummary>> {
        self.ssh().stack_services(name).await
    }
}

/// 宝塔 Docker 连接配置（与 `Connection.config` JSON 一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BtPanelConnectionConfig {
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub insecure: bool,
}

impl BtPanelConnectionConfig {
    pub fn parse(json: &str) -> OmniResult<Self> {
        serde_json::from_str(json).map_err(|e| {
            OmniError::new(ErrorCode::InvalidInput, "宝塔连接配置解析失败")
                .with_cause(e.to_string())
        })
    }
}

/// 从配置 + 连接 id 还原适配器实例。
pub fn adapter_from_config(
    cfg: &BtPanelConnectionConfig,
    connection_id: String,
    ssh: Arc<SshSession>,
) -> BtPanelAdapter {
    BtPanelAdapter::new(
        BtPanelClient::new(&cfg.base_url, &cfg.api_key, cfg.insecure),
        connection_id,
        ssh,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_token_matches_server_formula() {
        let api_sk = "test-secret";
        let request_time = 1_700_000_000_i64;
        let api_key_md5 = format!("{:x}", md5::compute(api_sk));
        let expected = format!("{:x}", md5::compute(format!("{request_time}{api_key_md5}")));
        assert_eq!(
            BtPanelClient::build_request_token(api_sk, request_time),
            expected
        );
    }

    #[test]
    fn parse_container_from_docs_sample() {
        let v = serde_json::json!({
            "container_id": "ead805da4545",
            "name": "demo",
            "status": "running",
            "image": "nginx:latest"
        });
        let c = parse_container_item(&v).expect("parse");
        assert_eq!(c.id, "ead805da4545");
        assert!(c.running);
        assert_eq!(c.state, "running");
    }
}
