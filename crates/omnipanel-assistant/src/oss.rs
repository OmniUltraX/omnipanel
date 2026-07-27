use chrono::Utc;
use hmac::{Hmac, Mac};
use omnipanel_error::OmniResult;
use reqwest::Client;
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::error::{map_assistant_error_with_cause, AssistantErrorKind};
use crate::sts::{host_from_endpoint, OssStsCredentials};

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OssUploadResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: u64,
}

/// PUT 目标：虚拟主机风格用 `endpoint/key`；path-style 用 `endpoint/bucket/key`。
pub(crate) fn put_target(sts: &OssStsCredentials, object_key: &str) -> (String, String) {
    let endpoint = sts.endpoint.trim_end_matches('/');
    let key = object_key.trim_start_matches('/');
    if sts.uses_virtual_host() {
        (format!("{endpoint}/{key}"), format!("/{key}"))
    } else {
        (
            format!("{endpoint}/{}/{key}", sts.bucket),
            format!("/{}/{}", sts.bucket, key),
        )
    }
}

/// 去掉 object key 前多余的 bucket 段（`oss_path` 常带 `omniminiapp/...`）。
pub fn strip_bucket_prefix(object_key: &str, bucket: &str) -> String {
    let key = object_key
        .trim()
        .trim_matches(|c| c == '/' || c == '\\')
        .replace('\\', "/");
    let bucket = bucket.trim().trim_matches('/');
    if bucket.is_empty() {
        return key;
    }
    let prefix = format!("{bucket}/");
    if key == bucket {
        String::new()
    } else if let Some(rest) = key.strip_prefix(&prefix) {
        rest.trim_matches('/').to_string()
    } else {
        key
    }
}

/// 上传快照 JSON。优先使用 STS 中的 `upload_url`；否则按 S3 SigV4 签名 PUT。
pub async fn upload_snapshot_json(
    http: &Client,
    sts: &OssStsCredentials,
    object_key: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    if let Some(upload_url) = sts.upload_url.as_deref().filter(|u| !u.is_empty()) {
        return put_presigned(http, upload_url, object_key, body, "application/json").await;
    }
    put_s3_sig_v4(http, sts, object_key, body, "application/json").await
}

/// 按 object key 上传任意字节（始终 SigV4；忽略单次 `upload_url`，因其通常绑定快照 key）。
pub async fn upload_object_bytes(
    http: &Client,
    sts: &OssStsCredentials,
    object_key: &str,
    body: &[u8],
    content_type: &str,
) -> OmniResult<OssUploadResult> {
    let key = strip_bucket_prefix(object_key, &sts.bucket);
    if key.is_empty() {
        return Err(map_assistant_error_with_cause(
            AssistantErrorKind::Upload,
            "OSS object key 为空",
            object_key.to_string(),
        ));
    }
    put_s3_sig_v4(http, sts, &key, body, content_type).await
}

/// 空 body 的 SHA256（SigV4 GET / HEAD）。
const EMPTY_PAYLOAD_HASH: &str =
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// 按 object key 下载对象字节（SigV4 GET）。
pub async fn get_object_bytes(
    http: &Client,
    sts: &OssStsCredentials,
    object_key: &str,
) -> OmniResult<Vec<u8>> {
    let key = strip_bucket_prefix(object_key, &sts.bucket);
    if key.is_empty() {
        return Err(map_assistant_error_with_cause(
            AssistantErrorKind::Inbox,
            "OSS object key 为空",
            object_key.to_string(),
        ));
    }
    get_s3_sig_v4(http, sts, &key).await
}

async fn put_presigned(
    http: &Client,
    upload_url: &str,
    object_key: &str,
    body: &[u8],
    content_type: &str,
) -> OmniResult<OssUploadResult> {
    let resp = http
        .put(upload_url)
        .header("Content-Type", content_type)
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
    content_type: &str,
) -> OmniResult<OssUploadResult> {
    let key = object_key.trim_start_matches('/');
    let (url, canonical_uri) = put_target(sts, key);
    let host = host_from_endpoint(&sts.endpoint)?;

    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = hex::encode(Sha256::digest(body));
    let token = sts.security_token();

    // 永久 AK：不得带空的 x-amz-security-token（会导致签名失败）
    let (canonical_headers, signed_headers) = if let Some(tok) = token {
        (
            format!(
                "content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\nx-amz-security-token:{tok}\n"
            ),
            "content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
        )
    } else {
        (
            format!(
                "content-type:{content_type}\nhost:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
            ),
            "content-type;host;x-amz-content-sha256;x-amz-date",
        )
    };

    let canonical_request = format!(
        "PUT\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let canonical_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", sts.region);
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_hash}");
    let signing_key = signing_key(&sts.access_key_secret, &date_stamp, &sts.region, "s3")?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        sts.access_key_id
    );

    let mut req = http
        .put(&url)
        .header("Content-Type", content_type)
        .header("Host", &host)
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .header("Authorization", authorization);
    if let Some(tok) = token {
        req = req.header("x-amz-security-token", tok);
    }

    let resp = req.body(body.to_vec()).send().await.map_err(|e| {
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

async fn get_s3_sig_v4(
    http: &Client,
    sts: &OssStsCredentials,
    object_key: &str,
) -> OmniResult<Vec<u8>> {
    let key = object_key.trim_start_matches('/');
    let (url, canonical_uri) = put_target(sts, key);
    let host = host_from_endpoint(&sts.endpoint)?;

    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();
    let payload_hash = EMPTY_PAYLOAD_HASH;
    let token = sts.security_token();

    let (canonical_headers, signed_headers) = if let Some(tok) = token {
        (
            format!(
                "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\nx-amz-security-token:{tok}\n"
            ),
            "host;x-amz-content-sha256;x-amz-date;x-amz-security-token",
        )
    } else {
        (
            format!(
                "host:{host}\nx-amz-content-sha256:{payload_hash}\nx-amz-date:{amz_date}\n"
            ),
            "host;x-amz-content-sha256;x-amz-date",
        )
    };

    let canonical_request = format!(
        "GET\n{canonical_uri}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
    );
    let canonical_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
    let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", sts.region);
    let string_to_sign =
        format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_hash}");
    let signing_key = signing_key(&sts.access_key_secret, &date_stamp, &sts.region, "s3")?;
    let signature = hex::encode(hmac_sha256(&signing_key, string_to_sign.as_bytes())?);
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
        sts.access_key_id
    );

    let mut req = http
        .get(&url)
        .header("Host", &host)
        .header("x-amz-content-sha256", payload_hash)
        .header("x-amz-date", &amz_date)
        .header("Authorization", authorization);
    if let Some(tok) = token {
        req = req.header("x-amz-security-token", tok);
    }

    let resp = req.send().await.map_err(|e| {
        map_assistant_error_with_cause(AssistantErrorKind::Inbox, "OSS 下载失败", e.to_string())
    })?;

    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| {
        map_assistant_error_with_cause(AssistantErrorKind::Inbox, "读取 OSS 对象失败", e.to_string())
    })?;
    if !status.is_success() {
        let text = String::from_utf8_lossy(&bytes).into_owned();
        return Err(map_assistant_error_with_cause(
            AssistantErrorKind::Inbox,
            format!("OSS 下载失败 (HTTP {})", status.as_u16()),
            text,
        ));
    }
    Ok(bytes.to_vec())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn virtual_host_put_target_omits_bucket_segment() {
        let sts = OssStsCredentials {
            endpoint: "https://omniminiapp.oss-cn-beijing.aliyuncs.com".into(),
            bucket: "omniminiapp".into(),
            region: "cn-beijing".into(),
            cname: true,
            access_key_id: "ak".into(),
            access_key_secret: "sk".into(),
            security_token: Some("".into()),
            expiration: Some("".into()),
            object_key_prefix: None,
            upload_url: None,
        };
        let (url, uri) = put_target(&sts, "assistant/1/dev/snapshots/a.json");
        assert_eq!(
            url,
            "https://omniminiapp.oss-cn-beijing.aliyuncs.com/assistant/1/dev/snapshots/a.json"
        );
        assert_eq!(uri, "/assistant/1/dev/snapshots/a.json");
    }

    #[test]
    fn path_style_put_target_includes_bucket() {
        let sts = OssStsCredentials {
            endpoint: "https://oss-cn-beijing.aliyuncs.com".into(),
            bucket: "omniminiapp".into(),
            region: "cn-beijing".into(),
            cname: false,
            access_key_id: "ak".into(),
            access_key_secret: "sk".into(),
            security_token: None,
            expiration: None,
            object_key_prefix: None,
            upload_url: None,
        };
        let (url, uri) = put_target(&sts, "k.json");
        assert_eq!(url, "https://oss-cn-beijing.aliyuncs.com/omniminiapp/k.json");
        assert_eq!(uri, "/omniminiapp/k.json");
    }

    #[test]
    fn strip_bucket_prefix_removes_leading_bucket() {
        assert_eq!(
            strip_bucket_prefix("omniminiapp/agent_chat_message/u1/conv/0.txt", "omniminiapp"),
            "agent_chat_message/u1/conv/0.txt"
        );
        assert_eq!(
            strip_bucket_prefix("agent_chat_message/u1/0.txt", "omniminiapp"),
            "agent_chat_message/u1/0.txt"
        );
        assert_eq!(strip_bucket_prefix("omniminiapp", "omniminiapp"), "");
    }
}
