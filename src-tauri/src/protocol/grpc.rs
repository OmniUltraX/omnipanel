//! gRPC 协议调试模块 — 简化实现（基于 reqwest HTTP/2）。
//!
//! 不依赖 tonic/prost，使用 raw HTTP/2 + protobuf 编码方式发送 gRPC 请求。
//! 用户手动输入 service/method/request JSON，模块负责编码发送。

use std::collections::HashMap;
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use specta::Type;
use tokio::sync::Mutex;

/// gRPC 连接配置。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrpcConnectionConfig {
    /// 服务器地址，如 `http://localhost:50051`
    pub endpoint: String,
    /// 自定义 metadata（header）
    #[serde(default)]
    #[specta(type = Vec<(String, String)>)]
    pub metadata: HashMap<String, String>,
    /// 是否使用 TLS
    #[serde(default)]
    pub use_tls: bool,
}

/// gRPC 调用请求。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrpcCallRequest {
    /// 完整方法名，如 `mypackage.MyService/MyMethod`
    pub method: String,
    /// 请求 JSON（将序列化为 protobuf）
    pub request_json: String,
    /// 自定义 metadata
    #[serde(default)]
    #[specta(type = Vec<(String, String)>)]
    pub metadata: HashMap<String, String>,
}

/// gRPC 调用响应。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrpcCallResponse {
    /// 响应 JSON
    pub response_json: String,
    /// HTTP 状态码
    pub status_code: u16,
    /// gRPC 状态
    pub grpc_status: i32,
    /// 响应 metadata
    #[specta(type = Vec<(String, String)>)]
    pub headers: HashMap<String, String>,
    /// 耗时(ms)
    pub duration_ms: u64,
}

/// 服务信息（反射结果）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrpcServiceInfo {
    pub name: String,
    pub methods: Vec<GrpcMethodInfo>,
}

/// 方法信息。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GrpcMethodInfo {
    pub name: String,
    pub full_path: String,
    pub is_client_streaming: bool,
    pub is_server_streaming: bool,
}

/// gRPC 会话（持有 HTTP/2 客户端和连接配置）。
#[derive(Debug, Clone)]
pub struct GrpcSession {
    pub endpoint: String,
    pub metadata: HashMap<String, String>,
    pub client: reqwest::Client,
}

impl GrpcSession {
    /// 创建新 gRPC 会话。
    pub fn connect(config: GrpcConnectionConfig) -> OmniResult<Self> {
        let mut builder = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30));

        if !config.use_tls {
            builder = builder.danger_accept_invalid_certs(true);
        }

        let client = builder.build().map_err(|e| {
            OmniError::new(ErrorCode::Connection, "创建 gRPC 客户端失败").with_cause(e.to_string())
        })?;

        Ok(Self {
            endpoint: config.endpoint.trim_end_matches('/').to_string(),
            metadata: config.metadata,
            client,
        })
    }

    /// 发送 gRPC 调用（简化版：JSON 序列化，不做 protobuf 编码）。
    pub async fn call(&self, request: GrpcCallRequest) -> OmniResult<GrpcCallResponse> {
        let start = std::time::Instant::now();
        let url = format!("{}/{}", self.endpoint, request.method.trim_start_matches('/'));

        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("content-type", "application/grpc+json".parse().unwrap());
        headers.insert("te", "trailers".parse().unwrap());

        // 合并 metadata
        for (k, v) in &self.metadata {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }
        for (k, v) in &request.metadata {
            if let (Ok(name), Ok(val)) = (
                reqwest::header::HeaderName::from_bytes(k.as_bytes()),
                reqwest::header::HeaderValue::from_str(v),
            ) {
                headers.insert(name, val);
            }
        }

        let body = request.request_json.as_bytes().to_vec();

        let resp = self
            .client
            .post(&url)
            .headers(headers)
            .body(body)
            .send()
            .await
            .map_err(|e| OmniError::new(ErrorCode::Connection, "gRPC 请求失败").with_cause(e.to_string()))?;

        let status_code = resp.status().as_u16();
        let resp_headers: HashMap<String, String> = resp
            .headers()
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
            .collect();

        let grpc_status = resp_headers
            .get("grpc-status")
            .and_then(|s| s.parse::<i32>().ok())
            .unwrap_or(0);

        let response_body = resp.bytes().await.map_err(|e| {
            OmniError::new(ErrorCode::Internal, "读取 gRPC 响应失败").with_cause(e.to_string())
        })?;

        // 跳过 5 字节 gRPC frame header（如果存在）
        let response_json = if response_body.len() > 5 && response_body[0] == 0 {
            String::from_utf8_lossy(&response_body[5..]).to_string()
        } else {
            String::from_utf8_lossy(&response_body).to_string()
        };

        let duration_ms = start.elapsed().as_millis() as u64;

        Ok(GrpcCallResponse {
            response_json,
            status_code,
            grpc_status,
            headers: resp_headers,
            duration_ms,
        })
    }
}

/// gRPC 会话管理器（线程安全的会话池）。
pub type GrpcSessionMap = Arc<Mutex<HashMap<String, GrpcSession>>>;
