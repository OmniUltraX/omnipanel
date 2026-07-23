use omnipanel_error::{OmniError, OmniResult};
use reqwest::Client;
use serde::Deserialize;

use crate::error::{map_assistant_error, map_assistant_error_with_cause, AssistantErrorKind};

/// 调用账号服务时附带的鉴权上下文。
#[derive(Debug, Clone)]
pub struct AuthContext {
    pub api_base: String,
    pub access_token: String,
    pub app_id: String,
    pub device_id: String,
    pub device_public_key: String,
    pub http: Client,
}

/// 账号服务下发的临时 OSS/S3 凭证。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssStsCredentials {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key_id: String,
    pub access_key_secret: String,
    pub security_token: String,
    pub expiration: String,
    #[serde(default)]
    pub object_key_prefix: Option<String>,
    /// 若服务端直接下发预签名 URL，优先使用（可跳过本地签名）。
    #[serde(default)]
    pub upload_url: Option<String>,
}

#[derive(Debug, Deserialize)]
struct StsApiEnvelope {
    #[serde(default)]
    data: Option<OssStsCredentials>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// `POST {api_base}/api/assistant/oss/sts`
pub async fn fetch_oss_sts(auth: &AuthContext) -> OmniResult<OssStsCredentials> {
    let url = format!(
        "{}/api/assistant/oss/sts",
        auth.api_base.trim_end_matches('/')
    );
    let resp = auth
        .http
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .header("X-Device-Public-Key", &auth.device_public_key)
        .send()
        .await
        .map_err(|e| {
            map_assistant_error_with_cause(AssistantErrorKind::Sts, "申请 OSS STS 失败", e.to_string())
        })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        map_assistant_error_with_cause(AssistantErrorKind::Sts, "读取 STS 响应失败", e.to_string())
    })?;

    if !status.is_success() {
        return Err(sts_http_error(status.as_u16(), &text));
    }

    // 兼容 { data: {...} } 或直接凭证对象
    if let Ok(env) = serde_json::from_str::<StsApiEnvelope>(&text) {
        if let Some(data) = env.data {
            return Ok(data);
        }
        if let Some(err) = env.error.or(env.message) {
            return Err(map_assistant_error(AssistantErrorKind::Sts, err));
        }
    }

    serde_json::from_str::<OssStsCredentials>(&text).map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Sts,
            "解析 STS 响应失败",
            format!("{e}; body={text}"),
        )
    })
}

fn sts_http_error(status: u16, body: &str) -> OmniError {
    let lower = body.to_ascii_lowercase();
    let kind = if status == 401 || status == 403 || lower.contains("unauthorized") {
        AssistantErrorKind::Auth
    } else {
        AssistantErrorKind::Sts
    };
    map_assistant_error(kind, format!("申请 OSS STS 失败 (HTTP {status}): {body}"))
}
