//! S3 ListObjects 兼容解析：部分厂商（阿里云 OSS 等）响应缺少 `<Name>`，
//! rust-s3 0.35 的 `ListBucketResult` 将其标为必填，导致 `missing field Name`。

use s3::bucket::Bucket;
use s3::command::Command;
use s3::request::Request;
use s3::request::tokio_backend::HyperRequest;
use serde::Deserialize;

use omnipanel_error::{ErrorCode, OmniError};

#[derive(Debug, Clone, Default)]
pub struct S3ListPage {
    pub is_truncated: bool,
    pub next_continuation_token: Option<String>,
    pub contents: Vec<S3ListedObject>,
    pub common_prefixes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct S3ListedObject {
    pub key: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct XmlListBucketResult {
    #[serde(rename = "Name", default)]
    _name: Option<String>,
    #[serde(
        rename = "IsTruncated",
        default,
        deserialize_with = "deserialize_xml_bool"
    )]
    is_truncated: bool,
    #[serde(rename = "NextContinuationToken", default)]
    #[serde(alias = "NextMarker")]
    next_continuation_token: Option<String>,
    #[serde(rename = "Contents", default)]
    contents: Vec<XmlObject>,
    #[serde(rename = "CommonPrefixes", default)]
    common_prefixes: Vec<XmlCommonPrefix>,
}

#[derive(Debug, Deserialize)]
struct XmlObject {
    #[serde(rename = "Key")]
    key: String,
    #[serde(rename = "Size", default, deserialize_with = "deserialize_xml_u64")]
    size: u64,
}

#[derive(Debug, Deserialize)]
struct XmlCommonPrefix {
    #[serde(rename = "Prefix")]
    prefix: String,
}

fn deserialize_xml_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = Option::<String>::deserialize(deserializer)?.unwrap_or_default();
    let t = s.trim();
    Ok(t.eq_ignore_ascii_case("true") || t == "1")
}

fn deserialize_xml_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let s = Option::<String>::deserialize(deserializer)?.unwrap_or_default();
    Ok(s.trim().parse().unwrap_or(0))
}

/// ListObjectsV2（兼容缺 `Name` 等字段的 S3 兼容服务）。
pub async fn s3_list_page(
    bucket: &Bucket,
    prefix: String,
    delimiter: Option<String>,
    continuation_token: Option<String>,
    max_keys: Option<usize>,
) -> Result<S3ListPage, OmniError> {
    let command = Command::ListObjectsV2 {
        prefix,
        delimiter,
        continuation_token,
        start_after: None,
        max_keys,
    };
    let request = HyperRequest::new(bucket, "/", command).await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "创建 S3 列表请求失败").with_cause(e.to_string())
    })?;
    let response = request
        .response_data(false)
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, "S3 列表请求失败").with_cause(e.to_string()))?;
    let status = response.status_code();
    let body = response.as_slice();
    if !(200..300).contains(&status) {
        let text = String::from_utf8_lossy(body);
        return Err(
            OmniError::new(ErrorCode::Io, format!("列出 S3 对象失败（HTTP {status}）"))
                .with_cause(text.chars().take(500).collect::<String>()),
        );
    }

    parse_list_bucket_xml(body)
}

/// 解析 ListBucketResult XML（兼容缺 `Name`）。
pub fn parse_list_bucket_xml(body: &[u8]) -> Result<S3ListPage, OmniError> {
    let parsed: XmlListBucketResult = quick_xml::de::from_reader(body).map_err(|e| {
        OmniError::new(ErrorCode::Io, "列出 S3 对象失败").with_cause(format!("serde xml: {e}"))
    })?;

    Ok(S3ListPage {
        is_truncated: parsed.is_truncated,
        next_continuation_token: parsed.next_continuation_token,
        contents: parsed
            .contents
            .into_iter()
            .map(|o| S3ListedObject {
                key: o.key,
                size: o.size,
            })
            .collect(),
        common_prefixes: parsed
            .common_prefixes
            .into_iter()
            .map(|p| p.prefix)
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_list_without_name_field() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <Prefix></Prefix>
  <MaxKeys>200</MaxKeys>
  <IsTruncated>false</IsTruncated>
  <CommonPrefixes>
    <Prefix>assistant/</Prefix>
  </CommonPrefixes>
  <Contents>
    <Key>readme.txt</Key>
    <Size>12</Size>
    <LastModified>2026-01-01T00:00:00.000Z</LastModified>
    <ETag>"abc"</ETag>
  </Contents>
</ListBucketResult>"#;
        let parsed: XmlListBucketResult = quick_xml::de::from_str(xml).expect("parse");
        assert!(!parsed.is_truncated);
        assert_eq!(parsed.common_prefixes.len(), 1);
        assert_eq!(parsed.common_prefixes[0].prefix, "assistant/");
        assert_eq!(parsed.contents.len(), 1);
        assert_eq!(parsed.contents[0].key, "readme.txt");
        assert_eq!(parsed.contents[0].size, 12);
    }
}
