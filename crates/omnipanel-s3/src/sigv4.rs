//! AWS SigV4 自签 S3 兼容客户端（阿里云 OSS / 七牛 Kodo）。
//!
//! rust-s3 在 OSS 上常出现 SignatureDoesNotMatch（query/Host 编码与服务端不一致）；
//! 此处对齐 `omnipanel-assistant` 已验证可工作的签名实现。
//!
//! 诊断：403/SignatureDoesNotMatch 时会把客户端 canonical_request / string_to_sign
//! 与服务端错误 XML（HostId、StringToSign 等）一并写入日志与 OmniError.cause，
//! 便于对照是「算法路径错了」还是「凭证/Region/Host 不一致」。

use chrono::Utc;
use hmac::{Hmac, Mac};
use percent_encoding::{utf8_percent_encode, AsciiSet, CONTROLS};
use reqwest::Client;
use sha2::{Digest, Sha256};

use omnipanel_error::{ErrorCode, OmniError};

use crate::{S3ListPage, parse_list_bucket_xml};

type HmacSha256 = Hmac<Sha256>;

/// AWS SigV4 URI 编码字符集（与 rust-s3 / AWS 文档一致）。
const FRAGMENT: &AsciiSet = &CONTROLS
    .add(b':')
    .add(b'?')
    .add(b'#')
    .add(b'[')
    .add(b']')
    .add(b'@')
    .add(b'!')
    .add(b'$')
    .add(b'&')
    .add(b'\'')
    .add(b'(')
    .add(b')')
    .add(b'*')
    .add(b'+')
    .add(b',')
    .add(b';')
    .add(b'=')
    .add(b'"')
    .add(b' ')
    .add(b'<')
    .add(b'>')
    .add(b'%')
    .add(b'{')
    .add(b'}')
    .add(b'|')
    .add(b'\\')
    .add(b'^')
    .add(b'`');

const FRAGMENT_SLASH: &AsciiSet = &FRAGMENT.add(b'/');

fn uri_encode(s: &str, encode_slash: bool) -> String {
    if encode_slash {
        utf8_percent_encode(s, FRAGMENT_SLASH).to_string()
    } else {
        utf8_percent_encode(s, FRAGMENT).to_string()
    }
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Result<Vec<u8>, OmniError> {
    let mut mac = HmacSha256::new_from_slice(key).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "HMAC 初始化失败").with_cause(e.to_string())
    })?;
    mac.update(data);
    Ok(mac.finalize().into_bytes().to_vec())
}

fn signing_key(secret: &str, date: &str, region: &str) -> Result<Vec<u8>, OmniError> {
    let k_date = hmac_sha256(format!("AWS4{secret}").as_bytes(), date.as_bytes())?;
    let k_region = hmac_sha256(&k_date, region.as_bytes())?;
    let k_service = hmac_sha256(&k_region, b"s3")?;
    hmac_sha256(&k_service, b"aws4_request")
}

/// 构建并排序 canonical query（签名与实际 URL 共用同一字符串）。
fn build_canonical_query(pairs: &[(String, String)]) -> String {
    let mut encoded: Vec<(String, String)> = pairs
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    encoded.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    encoded
        .into_iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

/// object key 路径：保留 `/`，其余按 SigV4 编码。
fn canonical_object_uri(key: &str) -> String {
    let key = key.trim_start_matches('/');
    if key.is_empty() {
        return "/".to_string();
    }
    format!("/{}", uri_encode(key, false))
}

/// XML 转义 ETag（ETag 通常带引号，需转义为 &quot;）。
pub(crate) fn xml_escape_etag(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn mask_access_key(ak: &str) -> String {
    let t = ak.trim();
    if t.len() <= 8 {
        return format!("len={}", t.len());
    }
    format!("{}…{}(len={})", &t[..4], &t[t.len() - 4..], t.len())
}

fn xml_tag<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

/// 从 OSS/S3 错误 XML 提取对照字段；并粗判服务端按 V1 还是 V4 在验签。
fn summarize_server_error(xml: &str) -> String {
    let code = xml_tag(xml, "Code").unwrap_or("-");
    let host_id = xml_tag(xml, "HostId").unwrap_or("-");
    let resource = xml_tag(xml, "Resource").unwrap_or("-");
    let request_id = xml_tag(xml, "RequestId").unwrap_or("-");
    let ak = xml_tag(xml, "OSSAccessKeyId")
        .or_else(|| xml_tag(xml, "AWSAccessKeyId"))
        .unwrap_or("-");
    let sig_provided = xml_tag(xml, "SignatureProvided").unwrap_or("-");
    let string_to_sign = xml_tag(xml, "StringToSign").unwrap_or("-");
    let canonical_request = xml_tag(xml, "CanonicalRequest").unwrap_or("-");
    let ec = xml_tag(xml, "EC").unwrap_or("-");

    let algo_guess = if string_to_sign.starts_with("AWS4-HMAC-SHA256") {
        "server_string_to_sign≈SigV4"
    } else if string_to_sign.contains('\n')
        && !string_to_sign.starts_with("AWS4")
        && string_to_sign != "-"
    {
        "server_string_to_sign≈OSS-V1(HMAC-SHA1) — 客户端若发 AWS4 则算法路径不匹配"
    } else if canonical_request != "-" {
        "server_has_CanonicalRequest≈SigV4"
    } else {
        "server_string_to_sign_absent — 对照 Resource/HostId；完整 XML 见下方"
    };

    format!(
        "algo_guess={algo_guess}\n\
         Code={code}\n\
         HostId={host_id}\n\
         Resource={resource}\n\
         RequestId={request_id}\n\
         AccessKeyId={ak}\n\
         SignatureProvided={sig_provided}\n\
         EC={ec}\n\
         StringToSign=<<\n{string_to_sign}\n>>\n\
         CanonicalRequest=<<\n{canonical_request}\n>>"
    )
}

#[derive(Debug, Clone)]
struct SigDebug {
    method: String,
    url: String,
    host: String,
    bucket: String,
    region: String,
    api_host: String,
    scheme: String,
    ak_masked: String,
    sk_len: usize,
    sk_had_leading_or_trailing_ws: bool,
    canonical_uri: String,
    canonical_query: String,
    signed_headers: String,
    credential_scope: String,
    amz_date: String,
    payload_hash: String,
    canonical_request: String,
    string_to_sign: String,
    auth_scheme: String,
}

impl SigDebug {
    fn format_block(&self) -> String {
        format!(
            "backend=aliyun_oss_sigv4 service=s3\n\
             method={}\n\
             url={}\n\
             host={}\n\
             bucket={}\n\
             region(signing)={}\n\
             api_host={}\n\
             scheme={}\n\
             access_key={}\n\
             secret_key_len={} had_edge_whitespace={}\n\
             amz_date={}\n\
             credential_scope={}\n\
             signed_headers={}\n\
             auth_scheme={}\n\
             canonical_uri={}\n\
             canonical_query={}\n\
             payload_hash={}\n\
             canonical_request=<<\n{}\n>>\n\
             string_to_sign=<<\n{}\n>>",
            self.method,
            self.url,
            self.host,
            self.bucket,
            self.region,
            self.api_host,
            self.scheme,
            self.ak_masked,
            self.sk_len,
            self.sk_had_leading_or_trailing_ws,
            self.amz_date,
            self.credential_scope,
            self.signed_headers,
            self.auth_scheme,
            self.canonical_uri,
            self.canonical_query,
            self.payload_hash,
            self.canonical_request,
            self.string_to_sign,
        )
    }
}

fn http_error_with_sig_debug(op: &str, status: u16, body: &str, sig: &SigDebug) -> OmniError {
    let server = summarize_server_error(body);
    let client = sig.format_block();
    let server_sts = xml_tag(body, "StringToSign").unwrap_or("");
    let sts_match = !server_sts.is_empty() && server_sts == sig.string_to_sign;
    let credential_hint = if sts_match {
        "\n--- verdict ---\nStringToSign 与服务端完全一致 → 请求构造/签名算法正确；SignatureDoesNotMatch 只能是 AccessKeySecret 与 AccessKeyId 不成对（或混用了其他云厂商的 Secret）。请到对应云控制台重新复制成对密钥并保存。\n"
    } else if sig.sk_len == 40 && sig.ak_masked.contains("LTAI") {
        "\n--- verdict ---\nAccessKey 像阿里云（LTAI…），SecretKey 长度 40 像七牛；请勿混用两家密钥。\n"
    } else {
        ""
    };
    let cause = format!(
        "[aliyun-oss-sig-debug]{credential_hint}--- server ---\n{server}\n--- client ---\n{client}\n--- raw_xml ---\n{body}"
    );
    tracing::warn!(
        target: "aliyun_oss_sig",
        op = %op,
        status = status,
        host = %sig.host,
        region = %sig.region,
        ak = %sig.ak_masked,
        sk_len = sig.sk_len,
        sts_match,
        credential_scope = %sig.credential_scope,
        "OSS 签名失败诊断\n{cause}"
    );
    let message = if sts_match {
        format!(
            "[aliyun-oss] {op} 签名失败：待签串一致但 Secret 不匹配，请重新填写成对的 AccessKey/SecretKey（HTTP {status}）"
        )
    } else {
        format!("[aliyun-oss] {op} 失败（HTTP {status}）")
    };
    OmniError::new(ErrorCode::Io, message)
        .with_cause(cause.chars().take(12_000).collect::<String>())
}

/// 阿里云 OSS / 七牛 S3 兼容客户端（SigV4 自签）。
pub struct SigV4Client {
    http: Client,
    access_key: String,
    secret_key: String,
    sk_had_edge_whitespace: bool,
    bucket: String,
    /// SigV4 region，如 `cn-beijing`
    region: String,
    /// 不含 bucket 的 API host，如 `oss-cn-beijing.aliyuncs.com`
    api_host: String,
    scheme: String,
}

impl SigV4Client {
    /// `api_endpoint`：区域 API 根，如 `https://oss-cn-beijing.aliyuncs.com`（不含 bucket 子域）。
    /// `signing_region`：如 `cn-beijing`（不要带 `oss-` 前缀）。
    pub fn new(
        access_key: &str,
        secret_key: &str,
        bucket: &str,
        signing_region: &str,
        api_endpoint: &str,
    ) -> Result<Self, OmniError> {
        let sk_had_edge_whitespace = secret_key != secret_key.trim();
        let access_key = access_key.trim().to_string();
        let secret_key = secret_key.trim().to_string();
        let bucket = bucket.trim().to_string();
        let region = signing_region.trim().to_string();
        if access_key.is_empty() || secret_key.is_empty() {
            return Err(OmniError::invalid_input("请填写 Access Key 与 Secret Key"));
        }
        if bucket.is_empty() {
            return Err(OmniError::invalid_input("请填写 Bucket"));
        }
        if region.is_empty() {
            return Err(OmniError::invalid_input("请填写 Region"));
        }
        let ep = api_endpoint.trim();
        if ep.is_empty() {
            return Err(OmniError::invalid_input("请填写 Endpoint"));
        }
        let scheme = if ep.to_ascii_lowercase().starts_with("http://") {
            "http".to_string()
        } else {
            "https".to_string()
        };
        let after = ep
            .strip_prefix("https://")
            .or_else(|| ep.strip_prefix("http://"))
            .unwrap_or(ep);
        let api_host = after
            .split('/')
            .next()
            .unwrap_or(after)
            .split(':')
            .next()
            .unwrap_or(after)
            .to_string();
        if api_host.is_empty() {
            return Err(OmniError::invalid_input("无效的 Endpoint"));
        }

        tracing::info!(
            target: "aliyun_oss_sig",
            bucket = %bucket,
            region = %region,
            api_host = %api_host,
            scheme = %scheme,
            access_key = %mask_access_key(&access_key),
            secret_key_len = secret_key.len(),
            sk_had_edge_whitespace,
            "创建阿里云 OSS SigV4 客户端"
        );

        Ok(Self {
            http: Client::new(),
            access_key,
            secret_key,
            sk_had_edge_whitespace,
            bucket,
            region,
            api_host,
            scheme,
        })
    }

    fn virtual_host(&self) -> String {
        format!("{}.{}", self.bucket, self.api_host)
    }

    async fn signed_request(
        &self,
        method: &str,
        canonical_uri: &str,
        query_pairs: &[(String, String)],
        body: &[u8],
        extra_headers: &[(&str, &str)],
    ) -> Result<(reqwest::Response, SigDebug), OmniError> {
        let host = self.virtual_host();
        let canonical_query = build_canonical_query(query_pairs);
        let payload_hash = hex::encode(Sha256::digest(body));

        let now = Utc::now();
        let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
        let date_stamp = now.format("%Y%m%d").to_string();

        let mut header_lines = vec![
            format!("host:{host}"),
            format!("x-amz-content-sha256:{payload_hash}"),
            format!("x-amz-date:{amz_date}"),
        ];
        for (k, v) in extra_headers {
            header_lines.push(format!("{}:{v}", k.to_ascii_lowercase()));
        }
        header_lines.sort();
        let canonical_headers = format!("{}\n", header_lines.join("\n"));
        let mut signed_names: Vec<String> = header_lines
            .iter()
            .map(|line| {
                line.split_once(':')
                    .map(|(n, _)| n.to_string())
                    .unwrap_or_default()
            })
            .collect();
        signed_names.sort();
        let signed_headers = signed_names.join(";");

        let canonical_request = format!(
            "{method}\n{canonical_uri}\n{canonical_query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}"
        );
        let canonical_hash = hex::encode(Sha256::digest(canonical_request.as_bytes()));
        let credential_scope = format!("{date_stamp}/{}/s3/aws4_request", self.region);
        let string_to_sign =
            format!("AWS4-HMAC-SHA256\n{amz_date}\n{credential_scope}\n{canonical_hash}");
        let key = signing_key(&self.secret_key, &date_stamp, &self.region)?;
        let signature = hex::encode(hmac_sha256(&key, string_to_sign.as_bytes())?);
        let authorization = format!(
            "AWS4-HMAC-SHA256 Credential={}/{credential_scope}, SignedHeaders={signed_headers}, Signature={signature}",
            self.access_key
        );

        let mut url = format!("{}://{}{}", self.scheme, host, canonical_uri);
        if !canonical_query.is_empty() {
            url.push('?');
            url.push_str(&canonical_query);
        }

        let sig_debug = SigDebug {
            method: method.to_string(),
            url: url.clone(),
            host: host.clone(),
            bucket: self.bucket.clone(),
            region: self.region.clone(),
            api_host: self.api_host.clone(),
            scheme: self.scheme.clone(),
            ak_masked: mask_access_key(&self.access_key),
            sk_len: self.secret_key.len(),
            sk_had_leading_or_trailing_ws: self.sk_had_edge_whitespace,
            canonical_uri: canonical_uri.to_string(),
            canonical_query: canonical_query.clone(),
            signed_headers: signed_headers.clone(),
            credential_scope: credential_scope.clone(),
            amz_date: amz_date.clone(),
            payload_hash: payload_hash.clone(),
            canonical_request: canonical_request.clone(),
            string_to_sign: string_to_sign.clone(),
            auth_scheme: "AWS4-HMAC-SHA256".into(),
        };

        tracing::debug!(
            target: "aliyun_oss_sig",
            method = %sig_debug.method,
            url = %sig_debug.url,
            host = %sig_debug.host,
            region = %sig_debug.region,
            credential_scope = %sig_debug.credential_scope,
            "即将发送已签名 OSS 请求\n{}",
            sig_debug.format_block()
        );

        let http_method = method.parse::<reqwest::Method>().map_err(|e| {
            OmniError::new(ErrorCode::Internal, "无效 HTTP 方法").with_cause(e.to_string())
        })?;

        let mut req = self
            .http
            .request(http_method, &url)
            .header("Host", &host)
            .header("x-amz-content-sha256", &payload_hash)
            .header("x-amz-date", &amz_date)
            .header("Authorization", authorization);
        for (k, v) in extra_headers {
            req = req.header(*k, *v);
        }
        if !body.is_empty()
            || method.eq_ignore_ascii_case("PUT")
            || method.eq_ignore_ascii_case("POST")
        {
            req = req.body(body.to_vec());
        }

        let resp = req.send().await.map_err(|e| {
            OmniError::new(ErrorCode::Connection, "阿里云 OSS 请求失败").with_cause(e.to_string())
        })?;
        Ok((resp, sig_debug))
    }

    /// ListObjectsV2。
    pub async fn list_objects_v2(
        &self,
        prefix: String,
        delimiter: Option<String>,
        continuation_token: Option<String>,
        max_keys: Option<usize>,
    ) -> Result<S3ListPage, OmniError> {
        let mut pairs = vec![
            ("list-type".into(), "2".into()),
            ("prefix".into(), prefix),
        ];
        if let Some(d) = delimiter {
            pairs.push(("delimiter".into(), d));
        }
        if let Some(t) = continuation_token {
            pairs.push(("continuation-token".into(), t));
        }
        if let Some(n) = max_keys {
            pairs.push(("max-keys".into(), n.to_string()));
        }

        let (resp, sig_debug) = self.signed_request("GET", "/", &pairs, &[], &[]).await?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取 OSS 列表响应失败").with_cause(e.to_string())
        })?;
        if !(200..300).contains(&status) {
            let text = String::from_utf8_lossy(&body);
            return Err(http_error_with_sig_debug(
                "listObjectsV2",
                status,
                &text,
                &sig_debug,
            ));
        }
        parse_list_bucket_xml(&body)
    }

    /// 下载对象（整文件进内存）。
    pub async fn get_object(&self, key: &str) -> Result<Vec<u8>, OmniError> {
        let uri = canonical_object_uri(key);
        let (resp, sig_debug) = self.signed_request("GET", &uri, &[], &[], &[]).await?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取 OSS 对象失败").with_cause(e.to_string())
        })?;
        if !(200..300).contains(&status) {
            let text = String::from_utf8_lossy(&body);
            return Err(http_error_with_sig_debug(
                "getObject",
                status,
                &text,
                &sig_debug,
            ));
        }
        Ok(body.to_vec())
    }

    /// 范围下载（Range GET，供流式下载 / 断点续传）。
    pub async fn get_object_range(
        &self,
        key: &str,
        start: u64,
        end: Option<u64>,
    ) -> Result<Vec<u8>, OmniError> {
        let uri = canonical_object_uri(key);
        let range = match end {
            Some(e) if e > start => format!("bytes={}-{}", start, e.saturating_sub(1)),
            _ => format!("bytes={}-", start),
        };
        let (resp, sig_debug) = self
            .signed_request("GET", &uri, &[], &[], &[("range", &range)])
            .await?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取 OSS 对象分片失败").with_cause(e.to_string())
        })?;
        // 200（整对象）与 206（部分内容）都接受
        if status != 200 && status != 206 {
            let text = String::from_utf8_lossy(&body);
            return Err(http_error_with_sig_debug(
                "getObjectRange",
                status,
                &text,
                &sig_debug,
            ));
        }
        Ok(body.to_vec())
    }

    /// 发起分块上传，返回 UploadId（`POST /?uploads`）。
    pub async fn initiate_multipart_upload(&self, key: &str) -> Result<String, OmniError> {
        let uri = canonical_object_uri(key);
        let (resp, sig_debug) = self
            .signed_request("POST", &uri, &[("uploads".to_string(), String::new())], &[], &[])
            .await?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取 OSS 分块上传初始化响应失败").with_cause(e.to_string())
        })?;
        if !(200..300).contains(&status) {
            let text = String::from_utf8_lossy(&body);
            return Err(http_error_with_sig_debug(
                "initiateMultipartUpload",
                status,
                &text,
                &sig_debug,
            ));
        }
        let text = String::from_utf8_lossy(&body);
        xml_tag(&text, "UploadId")
            .map(|s| s.to_string())
            .ok_or_else(|| {
                OmniError::new(ErrorCode::Io, "OSS 分块上传初始化响应缺少 UploadId").with_cause(text.into_owned())
            })
    }

    /// 上传单个分片（`PUT ?partNumber=&uploadId=`），返回 ETag。
    pub async fn upload_part(
        &self,
        key: &str,
        part_number: u32,
        upload_id: &str,
        data: &[u8],
    ) -> Result<String, OmniError> {
        let uri = canonical_object_uri(key);
        let pairs = vec![
            ("partNumber".to_string(), part_number.to_string()),
            ("uploadId".to_string(), upload_id.to_string()),
        ];
        let (resp, sig_debug) = self
            .signed_request(
                "PUT",
                &uri,
                &pairs,
                data,
                &[("content-type", "application/octet-stream")],
            )
            .await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let text = resp.text().await.unwrap_or_default();
            return Err(http_error_with_sig_debug(
                &format!("uploadPart#{part_number}"),
                status,
                &text,
                &sig_debug,
            ));
        }
        resp.headers()
            .get("etag")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .ok_or_else(|| OmniError::new(ErrorCode::Io, "OSS 分片上传响应缺少 ETag"))
    }

    /// 服务端分片复制（`PUT ?partNumber=&uploadId=` + `x-amz-copy-source`）。
    ///
    /// `copy_source`：`/bucket/key`（同桶可省略 bucket，写 `/key` 亦可，服务端按桶解析）。
    /// `copy_range`：可选，`bytes=start-end`（用于大对象按分片范围复制）。
    /// 返回 ETag。
    pub async fn upload_part_copy(
        &self,
        key: &str,
        part_number: u32,
        upload_id: &str,
        copy_source: &str,
        copy_range: Option<&str>,
    ) -> Result<String, OmniError> {
        let uri = canonical_object_uri(key);
        let pairs = vec![
            ("partNumber".to_string(), part_number.to_string()),
            ("uploadId".to_string(), upload_id.to_string()),
        ];
        let mut headers = vec![("x-amz-copy-source", copy_source)];
        if let Some(range) = copy_range {
            headers.push(("x-amz-copy-source-range", range));
        }
        // UploadPartCopy 无请求体：SHA256 为空串
        let (resp, sig_debug) = self.signed_request("PUT", &uri, &pairs, &[], &headers).await?;
        let status = resp.status().as_u16();
        let body = resp.bytes().await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取分片复制响应失败").with_cause(e.to_string())
        })?;
        if !(200..300).contains(&status) {
            let text = String::from_utf8_lossy(&body);
            return Err(http_error_with_sig_debug(
                &format!("uploadPartCopy#{part_number}"),
                status,
                &text,
                &sig_debug,
            ));
        }
        let text = String::from_utf8_lossy(&body);
        // 响应体为 CopyPartResult XML，内含 <ETag>..</ETag>
        xml_tag(&text, "ETag")
            .map(|s| s.to_string())
            .ok_or_else(|| {
                OmniError::new(ErrorCode::Io, "OSS 分片复制响应缺少 ETag").with_cause(text.into_owned())
            })
    }

    /// 完成分块上传（`POST ?uploadId=` + CompleteMultipartUpload XML）。
    pub async fn complete_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u32, String)],
    ) -> Result<(), OmniError> {
        let uri = canonical_object_uri(key);
        let mut xml = String::from("<CompleteMultipartUpload>");
        for (num, etag) in parts {
            xml.push_str(&format!(
                "<Part><PartNumber>{num}</PartNumber><ETag>{}</ETag></Part>",
                xml_escape_etag(etag)
            ));
        }
        xml.push_str("</CompleteMultipartUpload>");
        let pairs = vec![("uploadId".to_string(), upload_id.to_string())];
        let (resp, sig_debug) = self
            .signed_request(
                "POST",
                &uri,
                &pairs,
                xml.as_bytes(),
                &[("content-type", "application/xml")],
            )
            .await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let text = resp.text().await.unwrap_or_default();
            return Err(http_error_with_sig_debug(
                "completeMultipartUpload",
                status,
                &text,
                &sig_debug,
            ));
        }
        Ok(())
    }

    /// 中止分块上传（`DELETE ?uploadId=`）。
    pub async fn abort_multipart_upload(&self, key: &str, upload_id: &str) -> Result<(), OmniError> {
        let uri = canonical_object_uri(key);
        let pairs = vec![("uploadId".to_string(), upload_id.to_string())];
        let (resp, sig_debug) = self.signed_request("DELETE", &uri, &pairs, &[], &[]).await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) && status != 404 {
            let text = resp.text().await.unwrap_or_default();
            return Err(http_error_with_sig_debug(
                "abortMultipartUpload",
                status,
                &text,
                &sig_debug,
            ));
        }
        Ok(())
    }

    /// 上传对象（覆盖）。
    pub async fn put_object(&self, key: &str, data: &[u8]) -> Result<(), OmniError> {
        let uri = canonical_object_uri(key);
        let content_type = "application/octet-stream";
        let (resp, sig_debug) = self
            .signed_request("PUT", &uri, &[], data, &[("content-type", content_type)])
            .await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let text = resp.text().await.unwrap_or_default();
            return Err(http_error_with_sig_debug(
                "putObject",
                status,
                &text,
                &sig_debug,
            ));
        }
        Ok(())
    }

    /// 删除对象。
    pub async fn delete_object(&self, key: &str) -> Result<(), OmniError> {
        let uri = canonical_object_uri(key);
        let (resp, sig_debug) = self.signed_request("DELETE", &uri, &[], &[], &[]).await?;
        let status = resp.status().as_u16();
        // 204 / 200 / 404 都视为删除成功
        if !(200..300).contains(&status) && status != 404 {
            let text = resp.text().await.unwrap_or_default();
            return Err(http_error_with_sig_debug(
                "deleteObject",
                status,
                &text,
                &sig_debug,
            ));
        }
        Ok(())
    }

    /// HEAD 对象返回 `Content-Length`（字节）。
    pub async fn head_object_size(&self, key: &str) -> Result<u64, OmniError> {
        let uri = canonical_object_uri(key);
        let (resp, sig_debug) = self.signed_request("HEAD", &uri, &[], &[], &[]).await?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let text = resp.text().await.unwrap_or_default();
            return Err(http_error_with_sig_debug("headObject", status, &text, &sig_debug));
        }
        let len = resp
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        Ok(len)
    }

    /// HEAD 对象（用于连接探测）。
    pub async fn head_object(&self, key: &str) -> Result<u16, OmniError> {
        let uri = canonical_object_uri(key);
        let (resp, sig_debug) = self.signed_request("HEAD", &uri, &[], &[], &[]).await?;
        let status = resp.status().as_u16();
        if status == 403 {
            tracing::warn!(
                target: "aliyun_oss_sig",
                status,
                "HEAD 返回 403\n{}",
                sig_debug.format_block()
            );
        }
        Ok(status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_sorts_and_encodes_slash() {
        let q = build_canonical_query(&[
            ("prefix".into(), "".into()),
            ("delimiter".into(), "/".into()),
            ("list-type".into(), "2".into()),
        ]);
        assert_eq!(q, "delimiter=%2F&list-type=2&prefix=");
    }

    #[test]
    fn object_uri_keeps_slash() {
        assert_eq!(canonical_object_uri("a/b.txt"), "/a/b.txt");
        assert_eq!(canonical_object_uri("/"), "/");
        assert_eq!(canonical_object_uri(""), "/");
    }

    #[test]
    fn virtual_host_from_new() {
        let c = SigV4Client::new(
            "ak",
            "sk",
            "teacher-chat",
            "cn-beijing",
            "https://oss-cn-beijing.aliyuncs.com",
        )
        .expect("client");
        assert_eq!(c.region, "cn-beijing");
        assert_eq!(c.virtual_host(), "teacher-chat.oss-cn-beijing.aliyuncs.com");
    }

    #[test]
    fn summarize_detects_oss_v1_string_to_sign() {
        let xml = r#"<Error>
  <Code>SignatureDoesNotMatch</Code>
  <HostId>bucket.oss-cn-hangzhou.aliyuncs.com</HostId>
  <StringToSign>GET

Tue, 23 May 2023 15:24:55 GMT
/bucket/</StringToSign>
</Error>"#;
        let s = summarize_server_error(xml);
        assert!(s.contains("OSS-V1"));
        assert!(s.contains("bucket.oss-cn-hangzhou.aliyuncs.com"));
    }

    #[test]
    fn summarize_detects_sigv4_string_to_sign() {
        let xml = r#"<Error>
  <Code>SignatureDoesNotMatch</Code>
  <StringToSign>AWS4-HMAC-SHA256
20260727T000000Z
20260727/cn-beijing/s3/aws4_request
abcd</StringToSign>
</Error>"#;
        let s = summarize_server_error(xml);
        assert!(s.contains("SigV4"));
    }
}
