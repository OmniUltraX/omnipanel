//! S3 对象存储客户端（Web 端复用版）。
//!
//! 从桌面端 `src-tauri/src/commands/{file_manager,s3_list_compat,aliyun_oss}.rs`
//! 下沉的纯 Rust 实现，供 `omnipanel-server`（Web 端）与桌面端共用同一套 S3 语义：
//!
//! - **供应商识别**：AWS / 阿里云 OSS / 腾讯云 COS / 七牛 Kodo（按 Endpoint 域名优先，
//!   其次 provider 字段，兜底 AWS）。
//! - **双路径**：阿里云 / 七牛走自签 SigV4（rust-s3 在这些兼容服务上易
//!   SignatureDoesNotMatch）；其余走 rust-s3 官方客户端（腾讯 COS 用 path-style，
//!   本地/自建 MinIO 等按 host 自动判定）。
//! - **ListObjectsV2 兼容解析**：部分厂商响应缺 `<Name>`，自定义 XML 解析兜底。
//! - **端点归一化**：用户把 endpoint 填成 `https://bucket.oss-cn-xxx.aliyuncs.com`
//!   时剥离 bucket 子域，避免拼出非法双层子域。

use serde::Deserialize;

use omnipanel_error::{ErrorCode, OmniError};

pub mod sigv4;

/// S3 文件连接配置（与桌面端 `FileConnConfig` 的 S3 字段同构）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    #[serde(default)]
    pub bucket: String,
    /// aws | aliyun | tencent | qiniu；缺省 aws（兼容旧连接）
    #[serde(default)]
    pub provider: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub endpoint: String,
    #[serde(default, rename = "accessKey")]
    pub access_key: String,
    #[serde(default)]
    pub prefix: String,
}

impl S3Config {
    /// 从 Web 端 `FileConnConfig`（files.rs）的 JSON 字段构造。
    pub fn from_serde_json(v: &serde_json::Value) -> Self {
        let get = |k: &str| {
            v.get(k)
                .and_then(|x| x.as_str())
                .unwrap_or_default()
                .to_string()
        };
        Self {
            bucket: get("bucket"),
            provider: get("provider"),
            region: get("region"),
            endpoint: get("endpoint"),
            access_key: get("accessKey"),
            prefix: get("prefix"),
        }
    }
}

/// 供应商枚举。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum S3ProviderKind {
    Aws,
    Aliyun,
    Tencent,
    Qiniu,
}

/// 按 Endpoint 域名 / provider 字段识别供应商。
pub fn s3_provider_of(cfg: &S3Config) -> S3ProviderKind {
    let ep = cfg.endpoint.to_ascii_lowercase();
    if ep.contains("qiniucs.com") || ep.contains(".qiniu.com") {
        return S3ProviderKind::Qiniu;
    }
    if ep.contains("aliyuncs.com") {
        return S3ProviderKind::Aliyun;
    }
    if ep.contains("myqcloud.com") || ep.contains("qcloud.com") {
        return S3ProviderKind::Tencent;
    }
    match cfg.provider.trim().to_ascii_lowercase().as_str() {
        "aliyun" | "oss" | "aliyun-oss" => S3ProviderKind::Aliyun,
        "tencent" | "cos" | "tencent-cos" => S3ProviderKind::Tencent,
        "qiniu" | "kodo" => S3ProviderKind::Qiniu,
        _ => {
            if ep.contains("aliyun") {
                S3ProviderKind::Aliyun
            } else if ep.contains("qcloud") {
                S3ProviderKind::Tencent
            } else if ep.contains("qiniu") {
                S3ProviderKind::Qiniu
            } else {
                S3ProviderKind::Aws
            }
        }
    }
}

/// 阿里云 / 七牛走自签 SigV4 兼容客户端。
pub fn uses_sigv4_compat_client(cfg: &S3Config) -> bool {
    matches!(
        s3_provider_of(cfg),
        S3ProviderKind::Aliyun | S3ProviderKind::Qiniu
    )
}

/// 默认 Endpoint（未填 endpoint 时按供应商 + region 生成）。
pub fn default_s3_endpoint(provider: S3ProviderKind, region: &str) -> String {
    let r = region.trim();
    if r.is_empty() {
        return String::new();
    }
    match provider {
        S3ProviderKind::Aliyun => {
            let oss_region = if r.starts_with("oss-") {
                r.to_string()
            } else {
                format!("oss-{r}")
            };
            format!("https://{oss_region}.aliyuncs.com")
        }
        S3ProviderKind::Tencent => format!("https://cos.{r}.myqcloud.com"),
        S3ProviderKind::Qiniu => format!("https://s3.{r}.qiniucs.com"),
        S3ProviderKind::Aws => {
            if r == "us-east-1" {
                "https://s3.amazonaws.com".into()
            } else {
                format!("https://s3.{r}.amazonaws.com")
            }
        }
    }
}

/// 阿里云签名 region：控制台常填 oss-cn-beijing，SigV4 用 cn-beijing。
pub fn aliyun_signing_region(region: &str) -> String {
    let r = region.trim();
    if let Some(rest) = r.strip_prefix("oss-") {
        rest.to_string()
    } else {
        r.to_string()
    }
}

fn strip_virtual_hosted_bucket_host(host: &str, bucket: &str) -> String {
    let Some((first, rest)) = host.split_once('.') else {
        return host.to_string();
    };
    if rest.is_empty() {
        return host.to_string();
    }
    let first_l = first.to_ascii_lowercase();
    let rest_l = rest.to_ascii_lowercase();
    let bucket_l = bucket.trim().to_ascii_lowercase();

    // 当前 bucket 作为子域：bucket.oss-cn-xxx.aliyuncs.com
    if !bucket_l.is_empty() && first_l == bucket_l {
        return rest.to_string();
    }
    // 阿里云 OSS 虚拟主机：*.oss-*.aliyuncs.com / *.oss.*.aliyuncs.com
    if (rest_l.starts_with("oss-") || rest_l.starts_with("oss.") || rest_l.starts_with("s3.oss-"))
        && rest_l.contains("aliyuncs.com")
    {
        return rest.to_string();
    }
    // AWS S3 虚拟主机
    if rest_l == "s3.amazonaws.com"
        || (rest_l.starts_with("s3.") && rest_l.ends_with(".amazonaws.com"))
        || (rest_l.starts_with("s3-") && rest_l.ends_with(".amazonaws.com"))
    {
        return rest.to_string();
    }
    // 腾讯云 COS
    if rest_l.starts_with("cos.") && rest_l.contains("myqcloud.com") {
        return rest.to_string();
    }
    // 七牛 Kodo S3：*.s3.*.qiniucs.com
    if rest_l.starts_with("s3.") && rest_l.contains("qiniucs.com") {
        return rest.to_string();
    }
    host.to_string()
}

/// 将虚拟主机风格 endpoint 规范为「区域 / 服务 endpoint」。
pub fn normalize_s3_api_endpoint(endpoint: &str, bucket: &str) -> String {
    let raw = endpoint.trim().trim_end_matches('/');
    if raw.is_empty() {
        return String::new();
    }
    let (scheme, after_scheme) = if let Some(idx) = raw.find("://") {
        (&raw[..idx], &raw[idx + 3..])
    } else {
        ("https", raw)
    };
    let host_port = after_scheme
        .split('/')
        .next()
        .unwrap_or(after_scheme)
        .trim();
    if host_port.is_empty() {
        return String::new();
    }
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) => (h, Some(p)),
        _ => (host_port, None),
    };
    let normalized_host = strip_virtual_hosted_bucket_host(host, bucket);
    match port {
        Some(p) => format!("{scheme}://{normalized_host}:{p}"),
        None => format!("{scheme}://{normalized_host}"),
    }
}

/// 解析 endpoint 的 host（去端口）。
pub fn endpoint_host_of(endpoint: &str) -> String {
    let raw = endpoint.trim();
    let after_scheme = raw.split_once("://").map(|(_, rest)| rest).unwrap_or(raw);
    let host_port = after_scheme.split('/').next().unwrap_or(after_scheme);
    host_port
        .rsplit_once(':')
        .and_then(|(h, p)| {
            if !h.is_empty() && p.chars().all(|c| c.is_ascii_digit()) {
                Some(h.to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| host_port.to_string())
}

fn is_path_style_s3_host(host: &str) -> bool {
    let h = host.trim();
    if h.is_empty() {
        return false;
    }
    h.eq_ignore_ascii_case("localhost") || h.parse::<std::net::IpAddr>().is_ok()
}

/// 阿里云 / 七牛密钥长度约定。长度明显错位时几乎必定是混用了另一家的密钥。
pub fn validate_s3_credentials_for_provider(
    provider: S3ProviderKind,
    access_key: &str,
    secret: &str,
) -> Result<(), OmniError> {
    let ak = access_key.trim();
    let sk = secret.trim();
    match provider {
        S3ProviderKind::Qiniu => {
            if !sk.is_empty() && sk.len() != 40 {
                return Err(OmniError::invalid_input(format!(
                    "七牛 SecretKey 长度异常（当前 {}，应为 40）。请编辑连接，从七牛控制台重新复制 SecretKey 并保存（勿混用阿里云密钥）",
                    sk.len()
                )));
            }
            if !ak.is_empty() && ak.len() != 40 {
                return Err(OmniError::invalid_input(format!(
                    "七牛 AccessKey 长度异常（当前 {}，应为 40）。请编辑连接，从七牛控制台重新复制 AccessKey 并保存",
                    ak.len()
                )));
            }
        }
        S3ProviderKind::Aliyun => {
            if !sk.is_empty() && sk.len() == 40 {
                return Err(OmniError::invalid_input(
                    "阿里云 SecretKey 长度异常（当前 40，通常为 30）。很像粘成了七牛 SecretKey；请到阿里云 RAM 控制台重新复制与 AccessKey 成对的 Secret，保存后再试",
                ));
            }
            if !sk.is_empty() && sk.len() != 30 {
                return Err(OmniError::invalid_input(format!(
                    "阿里云 SecretKey 长度异常（当前 {}，通常为 30）。请编辑连接，从阿里云控制台重新复制 SecretKey 并保存",
                    sk.len()
                )));
            }
            if !ak.is_empty() && !ak.starts_with("LTAI") {
                return Err(OmniError::invalid_input(
                    "阿里云 AccessKey 通常以 LTAI 开头。请确认未填入七牛或其他云的 AccessKey",
                ));
            }
        }
        _ => {}
    }
    Ok(())
}

/// ListObjectsV2 分页结果（与桌面端 `S3ListPage` 同构）。
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

// ── ListBucketResult XML 兼容解析（缺 `<Name>` 等字段的厂商） ─────────────

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

/// 解析出 `cfg.endpoint` 与 region 的最终 API endpoint / 签名 region。
pub struct S3Endpoint {
    pub api_endpoint: String,
    pub signing_region: String,
    pub prefer_path_style: bool,
}

/// 计算最终 API endpoint 与签名 region（桌面端 `s3_bucket` / `sigv4_compat_client` 共用逻辑）。
pub fn resolve_s3_endpoint(cfg: &S3Config) -> Result<S3Endpoint, OmniError> {
    let provider = s3_provider_of(cfg);
    let region_input = cfg.region.trim();
    let endpoint = if cfg.endpoint.trim().is_empty() {
        let fallback_region = if region_input.is_empty() {
            match provider {
                S3ProviderKind::Aliyun => "oss-cn-beijing",
                S3ProviderKind::Tencent => "ap-beijing",
                S3ProviderKind::Qiniu => "cn-north-1",
                S3ProviderKind::Aws => "us-east-1",
            }
        } else {
            region_input
        };
        default_s3_endpoint(provider, fallback_region)
    } else {
        normalize_s3_api_endpoint(&cfg.endpoint, &cfg.bucket)
    };
    if endpoint.is_empty() {
        return Err(OmniError::invalid_input("请填写 Region 或 Endpoint"));
    }

    let signing_region = match provider {
        S3ProviderKind::Aliyun => aliyun_signing_region(if region_input.is_empty() {
            "oss-cn-beijing"
        } else {
            region_input
        }),
        S3ProviderKind::Tencent => {
            if region_input.is_empty() {
                "ap-beijing".into()
            } else {
                region_input.to_string()
            }
        }
        S3ProviderKind::Qiniu => {
            if region_input.is_empty() {
                "cn-north-1".into()
            } else {
                region_input.to_string()
            }
        }
        S3ProviderKind::Aws => {
            if region_input.is_empty() {
                "us-east-1".into()
            } else {
                region_input.to_string()
            }
        }
    };

    let endpoint_host = endpoint_host_of(&endpoint);
    let prefer_path_style = match provider {
        // 阿里云 OSS：官方仅支持虚拟主机（Bucket 作子域）；path-style 会 SignatureDoesNotMatch
        S3ProviderKind::Aliyun => false,
        // 七牛 S3：虚拟主机 / path-style 均支持，默认虚拟主机
        S3ProviderKind::Qiniu => false,
        // 腾讯云 COS：path-style 更稳（含 AppId 的桶名）
        S3ProviderKind::Tencent => true,
        S3ProviderKind::Aws => is_path_style_s3_host(&endpoint_host),
    };

    Ok(S3Endpoint {
        api_endpoint: endpoint,
        signing_region,
        prefer_path_style,
    })
}

/// 统一 S3 客户端（自动路由 SigV4 自签 / rust-s3）。
pub struct S3Client {
    cfg: S3Config,
    secret: String,
}

impl S3Client {
    pub fn new(cfg: S3Config, secret: String) -> Result<Self, OmniError> {
        validate_s3_credentials_for_provider(
            s3_provider_of(&cfg),
            &cfg.access_key,
            &secret,
        )?;
        if cfg.bucket.trim().is_empty() {
            return Err(OmniError::invalid_input("请填写 Bucket"));
        }
        Ok(Self { cfg, secret })
    }

    /// 列出对象（ListObjectsV2，Delimiter 由调用方传）。
    pub async fn list_objects_v2(
        &self,
        prefix: String,
        delimiter: Option<String>,
        continuation_token: Option<String>,
        max_keys: Option<usize>,
    ) -> Result<S3ListPage, OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client
                .list_objects_v2(prefix, delimiter, continuation_token, max_keys)
                .await;
        }
        let bucket = self.rust_s3_bucket()?;
        s3_list_page(&bucket, prefix, delimiter, continuation_token, max_keys).await
    }

    /// 下载对象（整文件进内存）。
    pub async fn get_object(&self, key: &str) -> Result<Vec<u8>, OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.get_object(key).await;
        }
        let bucket = self.rust_s3_bucket()?;
        let response = bucket.get_object(key).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 下载失败").with_cause(e.to_string())
        })?;
        Ok(response.bytes().to_vec())
    }

    /// 范围下载（Range GET，供流式下载 / 断点续传）。返回 `(数据, 实际总长度)`。
    ///
    /// `end` 为 None 时从 `start` 读到对象末尾。
    pub async fn get_object_range(
        &self,
        key: &str,
        start: u64,
        end: Option<u64>,
    ) -> Result<Vec<u8>, OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.get_object_range(key, start, end).await;
        }
        let bucket = self.rust_s3_bucket()?;
        // rust-s3 的 end 为「包含」语义（bytes=start-end），此处把排他 end 转成包含。
        let response = bucket
            .get_object_range(key, start, end.map(|e| e.saturating_sub(1)))
            .await
            .map_err(|e| OmniError::new(ErrorCode::Io, "S3 分片下载失败").with_cause(e.to_string()))?;
        let status = response.status_code();
        // 416 = 请求范围超出对象末尾 → 视为已读完，返回空（调用方据此结束分块下载）
        if status == 416 {
            return Ok(Vec::new());
        }
        if !(200..300).contains(&status) {
            return Err(OmniError::new(
                ErrorCode::Io,
                format!("S3 分片下载失败（HTTP {status}）"),
            ));
        }
        Ok(response.bytes().to_vec())
    }

    /// 分块上传单个文件：分片 upload（每片 `chunk_size`，不整文件进内存），返回完成后的总字节数。
    /// 任一分片失败自动 abort（清理残留 upload）。
    pub async fn upload_object_multipart(
        &self,
        key: &str,
        data: &[u8],
        chunk_size: usize,
    ) -> Result<u64, OmniError> {
        if data.is_empty() {
            self.put_object(key, data).await?;
            return Ok(0);
        }
        let chunk_size = chunk_size.max(1024 * 1024);
        let upload_id = self.initiate_multipart_upload(key).await?;
        let mut parts: Vec<(u32, String)> = Vec::new();
        let mut offset = 0usize;
        let mut part_number: u32 = 1;
        let result = async {
            while offset < data.len() {
                let end = (offset + chunk_size).min(data.len());
                let etag = self
                    .upload_part(key, part_number, &upload_id, &data[offset..end])
                    .await?;
                parts.push((part_number, etag));
                offset = end;
                part_number += 1;
            }
            self.complete_multipart_upload(key, &upload_id, &parts).await?;
            Ok(data.len() as u64)
        }
        .await;
        if result.is_err() {
            let _ = self.abort_multipart_upload(key, &upload_id).await;
        }
        result
    }

    /// 上传对象（覆盖）。
    pub async fn put_object(&self, key: &str, data: &[u8]) -> Result<(), OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.put_object(key, data).await;
        }
        let bucket = self.rust_s3_bucket()?;
        bucket.put_object(key, data).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 上传失败").with_cause(e.to_string())
        })?;
        Ok(())
    }

    /// 删除对象。
    pub async fn delete_object(&self, key: &str) -> Result<(), OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.delete_object(key).await;
        }
        let bucket = self.rust_s3_bucket()?;
        bucket.delete_object(key).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 删除对象失败").with_cause(e.to_string())
        })?;
        Ok(())
    }

    /// 发起分块上传（rust-s3 路径），返回 UploadId。
    pub async fn initiate_multipart_upload(&self, key: &str) -> Result<String, OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.initiate_multipart_upload(key).await;
        }
        let bucket = self.rust_s3_bucket()?;
        let msg = bucket
            .initiate_multipart_upload(key, "application/octet-stream")
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 分块上传初始化失败").with_cause(e.to_string())
            })?;
        Ok(msg.upload_id)
    }

    /// 上传单个分片（rust-s3 路径），返回 ETag。
    pub async fn upload_part(
        &self,
        key: &str,
        part_number: u32,
        upload_id: &str,
        data: &[u8],
    ) -> Result<String, OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.upload_part(key, part_number, upload_id, data).await;
        }
        let bucket = self.rust_s3_bucket()?;
        let part = bucket
            .put_multipart_chunk(data.to_vec(), key, part_number, upload_id, "application/octet-stream")
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, format!("S3 分片 {part_number} 上传失败")).with_cause(e.to_string())
            })?;
        Ok(part.etag)
    }

    /// 完成分块上传（rust-s3 路径）。
    pub async fn complete_multipart_upload(
        &self,
        key: &str,
        upload_id: &str,
        parts: &[(u32, String)],
    ) -> Result<(), OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.complete_multipart_upload(key, upload_id, parts).await;
        }
        let bucket = self.rust_s3_bucket()?;
        let s3_parts = parts
            .iter()
            .map(|(num, etag)| s3::serde_types::Part {
                part_number: *num,
                etag: etag.clone(),
            })
            .collect();
        bucket
            .complete_multipart_upload(key, upload_id, s3_parts)
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 分块上传完成失败").with_cause(e.to_string())
            })?;
        Ok(())
    }

    /// 中止分块上传。
    pub async fn abort_multipart_upload(&self, key: &str, upload_id: &str) -> Result<(), OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.abort_multipart_upload(key, upload_id).await;
        }
        let bucket = self.rust_s3_bucket()?;
        bucket.abort_upload(key, upload_id).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 分块上传中止失败").with_cause(e.to_string())
        })
    }

    /// HEAD 对象（用于连接探测），返回 HTTP 状态码。
    pub async fn head_object(&self, key: &str) -> Result<u16, OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            let client = self.sigv4_client()?;
            return client.head_object(key).await;
        }
        let bucket = self.rust_s3_bucket()?;
        let (_, status) = bucket.head_object(key).await.map_err(|e| {
            OmniError::new(ErrorCode::Connection, "S3 连接测试失败").with_cause(e.to_string())
        })?;
        Ok(status)
    }

    /// 同桶服务端拷贝（不经本机；阿里云/七牛自签路径不支持则报错）。
    pub async fn copy_object_internal(&self, from_key: &str, to_key: &str) -> Result<(), OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "当前 S3 兼容端点暂不支持服务端拷贝",
            ));
        }
        let bucket = self.rust_s3_bucket()?;
        let code = bucket
            .copy_object_internal(from_key, to_key)
            .await
            .map_err(|e| {
                OmniError::new(ErrorCode::Io, "S3 服务端拷贝失败").with_cause(e.to_string())
            })?;
        if !(200..300).contains(&code) {
            return Err(OmniError::new(
                ErrorCode::Io,
                format!("S3 服务端拷贝失败（HTTP {code}）"),
            ));
        }
        Ok(())
    }

    /// 跨桶服务端拷贝（目标凭据需能读源桶；自签路径不支持则报错）。
    pub async fn copy_object_from_bucket(
        &self,
        source_bucket: &str,
        source_key: &str,
        dest_key: &str,
    ) -> Result<(), OmniError> {
        if uses_sigv4_compat_client(&self.cfg) {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "当前 S3 兼容端点暂不支持跨桶服务端拷贝",
            ));
        }
        use s3::command::Command;
        use s3::request::tokio_backend::HyperRequest;
        use s3::request::Request;

        let bucket = self.rust_s3_bucket()?;
        let from = format!(
            "{}/{}",
            source_bucket.trim_matches('/'),
            source_key.trim_start_matches('/')
        );
        let command = Command::CopyObject { from: from.as_str() };
        let request = HyperRequest::new(bucket.as_ref(), dest_key, command).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 跨桶拷贝请求失败").with_cause(e.to_string())
        })?;
        let response = request.response_data(false).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "S3 跨桶拷贝失败").with_cause(e.to_string())
        })?;
        let code = response.status_code();
        if !(200..300).contains(&code) {
            return Err(OmniError::new(
                ErrorCode::Io,
                format!("S3 跨桶拷贝失败（HTTP {code}）"),
            ));
        }
        Ok(())
    }

    fn sigv4_client(&self) -> Result<sigv4::SigV4Client, OmniError> {
        let ep = resolve_s3_endpoint(&self.cfg)?;
        sigv4::SigV4Client::new(
            &self.cfg.access_key,
            &self.secret,
            &self.cfg.bucket,
            &ep.signing_region,
            &ep.api_endpoint,
        )
    }

    fn rust_s3_bucket(&self) -> Result<Box<s3::bucket::Bucket>, OmniError> {
        use s3::creds::Credentials;
        use s3::region::Region;

        let ep = resolve_s3_endpoint(&self.cfg)?;
        let region = Region::Custom {
            region: ep.signing_region,
            endpoint: ep.api_endpoint,
        };
        let creds = Credentials::new(Some(&self.cfg.access_key), Some(&self.secret), None, None, None)
            .map_err(|e| OmniError::new(ErrorCode::Auth, "S3 凭据无效").with_cause(e.to_string()))?;
        let mut bucket = s3::bucket::Bucket::new(&self.cfg.bucket, region, creds).map_err(|e| {
            OmniError::new(ErrorCode::Connection, "创建 S3 客户端失败").with_cause(e.to_string())
        })?;
        if ep.prefer_path_style {
            bucket.set_path_style();
        }
        Ok(bucket)
    }
}

/// rust-s3 ListObjectsV2（兼容缺 `Name` 等字段的 S3 兼容服务）。
pub async fn s3_list_page(
    bucket: &s3::bucket::Bucket,
    prefix: String,
    delimiter: Option<String>,
    continuation_token: Option<String>,
    max_keys: Option<usize>,
) -> Result<S3ListPage, OmniError> {
    let command = s3::command::Command::ListObjectsV2 {
        prefix,
        delimiter,
        continuation_token,
        start_after: None,
        max_keys,
    };
    let request = s3::request::tokio_backend::HyperRequest::new(bucket, "/", command)
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "创建 S3 列表请求失败").with_cause(e.to_string())
        })?;
    use s3::request::Request;
    let response = request
        .response_data(false)
        .await
        .map_err(|e| OmniError::new(ErrorCode::Io, "S3 列表请求失败").with_cause(e.to_string()))?;
    let status = response.status_code();
    let body = response.as_slice();
    if !(200..300).contains(&status) {
        let text = String::from_utf8_lossy(body);
        return Err(OmniError::new(
            ErrorCode::Io,
            format!("列出 S3 对象失败（HTTP {status}）"),
        )
        .with_cause(text.chars().take(500).collect::<String>()));
    }
    parse_list_bucket_xml(body)
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
        let page = parse_list_bucket_xml(xml.as_bytes()).expect("parse");
        assert!(!page.is_truncated);
        assert_eq!(page.common_prefixes.len(), 1);
        assert_eq!(page.common_prefixes[0], "assistant/");
        assert_eq!(page.contents.len(), 1);
        assert_eq!(page.contents[0].key, "readme.txt");
        assert_eq!(page.contents[0].size, 12);
    }

    fn cfg() -> S3Config {
        S3Config::default()
    }

    #[test]
    fn normalize_s3_api_endpoint_strips_bucket() {
        assert_eq!(
            normalize_s3_api_endpoint("https://old-bucket.oss-cn-beijing.aliyuncs.com", "new-bucket"),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            normalize_s3_api_endpoint("https://oss-cn-beijing.aliyuncs.com", "any"),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            normalize_s3_api_endpoint("https://my.s3.us-east-1.amazonaws.com", "x"),
            "https://s3.us-east-1.amazonaws.com"
        );
        assert_eq!(
            normalize_s3_api_endpoint("http://127.0.0.1:9000", "minio"),
            "http://127.0.0.1:9000"
        );
    }

    #[test]
    fn default_endpoints_by_provider() {
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Aliyun, "oss-cn-beijing"),
            "https://oss-cn-beijing.aliyuncs.com"
        );
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Aliyun, "cn-hangzhou"),
            "https://oss-cn-hangzhou.aliyuncs.com"
        );
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Tencent, "ap-beijing"),
            "https://cos.ap-beijing.myqcloud.com"
        );
        assert_eq!(
            default_s3_endpoint(S3ProviderKind::Qiniu, "cn-north-1"),
            "https://s3.cn-north-1.qiniucs.com"
        );
    }

    #[test]
    fn provider_detection_by_endpoint() {
        let mut c = cfg();
        c.endpoint = "https://s3.cn-north-1.qiniucs.com".into();
        assert_eq!(s3_provider_of(&c), S3ProviderKind::Qiniu);
        c.endpoint = "https://oss-cn-beijing.aliyuncs.com".into();
        assert_eq!(s3_provider_of(&c), S3ProviderKind::Aliyun);
        c.endpoint = "https://cos.ap-beijing.myqcloud.com".into();
        assert_eq!(s3_provider_of(&c), S3ProviderKind::Tencent);
    }

    #[test]
    fn credential_length_validation() {
        let err = validate_s3_credentials_for_provider(
            S3ProviderKind::Qiniu,
            "a".repeat(20).as_str(),
            "b".repeat(40).as_str(),
        );
        assert!(err.is_err());
        let err = validate_s3_credentials_for_provider(
            S3ProviderKind::Aliyun,
            "LTAI1234",
            "s".repeat(40).as_str(),
        );
        assert!(err.is_err());
    }

    #[test]
    fn xml_escape_etag_handles_quotes() {
        // rust-s3 返回的 ETag 带引号（"abc"），转义后应可安全嵌入 XML
        let escaped = crate::sigv4::xml_escape_etag(r#""abc""#);
        assert_eq!(escaped, "&quot;abc&quot;");
    }
}
