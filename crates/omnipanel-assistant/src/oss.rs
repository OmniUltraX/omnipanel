use chrono::Utc;
use hmac::{Hmac, Mac};
use omnipanel_error::OmniResult;
use reqwest::Client;
use sha2::{Digest, Sha256};
use serde::Serialize;

use crate::error::{map_assistant_error_with_cause, AssistantErrorKind};
use crate::sts::OssStsCredentials;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OssUploadResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: u64,
}

/// 上传快照 JSON。优先使用 STS 中的 `upload_url`；否则按 S3 SigV4 签名 PUT。
pub async fn upload_snapshot_json(
    http: &Client,
    sts: &OssStsCredentials,
    object_key: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    if let Some(upload_url) = sts.upload_url.as_deref().filter(|u| !u.is_empty()) {
        return put_presigned(http, upload_url, object_key, body).await;
    }
    put_s3_sig_v4(http, sts, object_key, body).await
}

async fn put_presigned(
    http: &Client,
    upload_url: &str,
    object_key: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    let resp = http
        .put(upload_url)
        .header("Content-Type", "application/json")
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| {
            map_assistant_error_with_cause(AssistantErrorKind::Upload, "OSS 上传失败", e.to_string())
        })?;
    let status = resp.status();
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(map_assistant_error_with_cause(
            AssistantErrorKind::Upload,
            format!("OSS 上传失败 (HTTP {})", status.as_u16()),
            text,
        ));
    }
    Ok(OssUploadResult {
        object_key: object_key.to_string(),
        etag,
        bytes: body.len() as u64,
    })
}

async fn put_s3_sig_v4(
    http: &Client,
    sts: &OssStsCredentials,
    object_key: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    let endpoint = sts.endpoint.trim_end_matches('/');
    let key = object_key.trim_start_matches('/');
    let host = host_from_endpoint(endpoint)?;
    let url = format!("{endpoint}/{}/{}", sts.bucket, key);

    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest(body));
    let content_type = "application/json";

    let canonical_uri = format!("/{}/{}", sts.bucket, key);
    let canonical_headers = format!(
        "content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\nx-amz-security-token:{}\n",
        sts.security_token
    );
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token";
    let canonical_request = format!(
        "PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let canonical_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", sts.region);
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_hash}");
    let signing_key = signing_key(
        &sts.access_key_secret,
        &date_stamp,
        &sts.region,
        "s3",
    )?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        sts.access_key_id
    );

    let resp = http
        .put(&url)
        .header("Content-Type", content_type)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .header("x-amz-security-token", &sts.security_token)
        .header("Authorization", authorization)
        .body(body.to_vec())
        .send()
        .await
        .map_err(|e| {
            map_assistant_error_with_cause(AssistantErrorKind::Upload, "OSS 上传失败", e.to_string())
        })?;

    let status = resp.status();
    let etag = resp
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim_matches('"').to_string());
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(map_assistant_error_with_cause(
            AssistantErrorKind::Upload,
            format!("OSS 上传失败 (HTTP {})", status.as_u16()),
            text,
        ));
    }

    Ok(OssUploadResult {
        object_key: key.to_string(),
        etag,
        bytes: body.len() as u64,
    })
}

fn host_from_endpoint(endpoint: &str) -> OmniResult<String> {
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

fn hmac_sha256(key: &[u8], data: &[u8]) -> OmniResult<Vec<u8>> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|e| {
        map_assistant_error_with_cause(AssistantErrorKind::Upload, "HMAC 初始化失败", e.to_string())
    })?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn signing_key(secret: &str, date: &str, region: &str, service: &str) -> OmniResult<Vec<u8>> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, service.as_bytes())?;
    hmac_sha256(&k_service, b"aws4_request")
}
