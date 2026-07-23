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

/// 账号服务下发的 OSS 上传凭证（临时 STS 或永久 AccessKey）。
///
/// - 临时：`securityToken` / `expiration` 非空
/// - 永久：二者为空；签名时不得传空 `x-amz-security-token`
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OssStsCredentials {
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    /// 虚拟主机 / CNAME 风格 endpoint（已含 bucket），默认 false 兼容旧 path-style。
    #[serde(default)]
    pub cname: bool,
    pub access_key_id: String,
    pub access_key_secret: String,
    /// 临时 STS token；永久授权时为空或缺省。
    #[serde(default)]
    pub security_token: Option<String>,
    /// 过期时间（ISO-8601）；永久授权时为空，客户端不按时间刷新。
    #[serde(default)]
    pub expiration: Option<String>,
    #[serde(default)]
    pub object_key_prefix: Option<String>,
    /// 若服务端直接下发预签名 URL，优先使用（可跳过本地签名）。
    #[serde(default)]
    pub upload_url: Option<String>,
}

impl OssStsCredentials {
    /// 非空 securityToken；空字符串视为无 token（永久 AK）。
    pub fn security_token(&self) -> Option<&str> {
        self.security_token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    /// 非空 expiration；空则视为永久凭证。
    pub fn expiration(&self) -> Option<&str> {
        self.expiration
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    }

    pub fn is_permanent(&self) -> bool {
        self.expiration().is_none() && self.security_token().is_none()
    }

    /// 虚拟主机风格：不要再拼 `/{bucket}/{key}`。
    pub fn uses_virtual_host(&self) -> bool {
        if self.cname {
            return true;
        }
        let Ok(host) = host_from_endpoint(&self.endpoint) else {
            return false;
        };
        let prefix = format!("{}.", self.bucket);
        host.starts_with(&prefix)
    }

    fn validate(&self) -> OmniResult<()> {
        if self.access_key_id.trim().is_empty() || self.access_key_secret.trim().is_empty() {
            return Err(map_assistant_error(
                AssistantErrorKind::Sts,
                "OSS 凭证缺少 accessKeyId / accessKeySecret",
            ));
        }
        if self.endpoint.trim().is_empty() || self.bucket.trim().is_empty() {
            return Err(map_assistant_error(
                AssistantErrorKind::Sts,
                "OSS 凭证缺少 endpoint / bucket",
            ));
        }
        Ok(())
    }
}

pub(crate) fn host_from_endpoint(endpoint: &str) -> OmniResult<String> {
    let without_scheme = endpoint
        .strip_prefix("https://")
        .or_else(|| endpoint.strip_prefix("http://"))
        .unwrap_or(endpoint);
    let host = without_scheme
        .split('/')
        .next()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            map_assistant_error_with_cause(
                AssistantErrorKind::Upload,
                "无效的 OSS endpoint",
                endpoint.to_string(),
            )
        })?;
    Ok(host.to_string())
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
            map_assistant_error_with_cause(AssistantErrorKind::Sts, "申请 OSS 凭证失败", e.to_string())
        })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        map_assistant_error_with_cause(AssistantErrorKind::Sts, "读取 OSS 凭证响应失败", e.to_string())
    })?;

    if !status.is_success() {
        return Err(sts_http_error(status.as_u16(), &text));
    }

    // 兼容 { data: {...} } 或直接凭证对象
    let creds = if let Ok(env) = serde_json::from_str::<StsApiEnvelope>(&text) {
        if let Some(data) = env.data {
            data
        } else if let Some(err) = env.error.or(env.message) {
            return Err(map_assistant_error(AssistantErrorKind::Sts, err));
        } else {
            serde_json::from_str::<OssStsCredentials>(&text).map_err(|e| {
                map_assistant_error_with_cause(
                    AssistantErrorKind::Sts,
                    "解析 OSS 凭证响应失败",
                    format!("{e}; body={text}"),
                )
            })?
        }
    } else {
        serde_json::from_str::<OssStsCredentials>(&text).map_err(|e| {
            map_assistant_error_with_cause(
                AssistantErrorKind::Sts,
                "解析 OSS 凭证响应失败",
                format!("{e}; body={text}"),
            )
        })?
    };

    creds.validate()?;
    Ok(creds)
}

fn sts_http_error(status: u16, body: &str) -> OmniError {
    let lower = body.to_ascii_lowercase();
    let kind = if status == 401 || status == 403 || lower.contains("unauthorized") {
        AssistantErrorKind::Auth
    } else {
        AssistantErrorKind::Sts
    };
    map_assistant_error(kind, format!("申请 OSS 凭证失败 (HTTP {status}): {body}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permanent_creds_empty_token_and_expiration() {
        let json = r#"{
            "endpoint": "https://omniminiapp.oss-cn-beijing.aliyuncs.com",
            "bucket": "omniminiapp",
            "region": "cn-beijing",
            "cname": true,
            "accessKeyId": "ak",
            "accessKeySecret": "sk",
            "securityToken": "",
            "expiration": "",
            "objectKeyPrefix": "assistant/1/dev",
            "uploadUrl": null
        }"#;
        let c: OssStsCredentials = serde_json::from_str(json).unwrap();
        assert!(c.cname);
        assert!(c.security_token().is_none());
        assert!(c.expiration().is_none());
        assert!(c.is_permanent());
        assert!(c.uses_virtual_host());
        c.validate().unwrap();
    }

    #[test]
    fn sts_creds_keep_token() {
        let json = r#"{
            "endpoint": "https://oss-cn-beijing.aliyuncs.com",
            "bucket": "omniminiapp",
            "region": "cn-beijing",
            "accessKeyId": "ak",
            "accessKeySecret": "sk",
            "securityToken": "tok",
            "expiration": "2026-07-23T06:00:00Z"
        }"#;
        let c: OssStsCredentials = serde_json::from_str(json).unwrap();
        assert_eq!(c.security_token(), Some("tok"));
        assert!(!c.is_permanent());
        assert!(!c.uses_virtual_host());
    }
}
