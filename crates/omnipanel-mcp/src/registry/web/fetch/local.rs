//! 本地直连抓取：reqwest GET + 三级正文抽取瀑布。

use async_trait::async_trait;
use omnipanel_store::FetchConfig;
use reqwest::header::{ACCEPT, ACCEPT_LANGUAGE, USER_AGENT};
use tracing::info;

use super::super::common::{
    build_http_client, classify_reqwest_error, map_http_status, BackendError, FetchRequest,
    FetchResult, RequestCtx, WebSecrets,
};
use super::FetchProvider;
use super::extract::convert_body;

const MAX_BODY_BYTES: usize = 5 * 1024 * 1024;
const BROWSER_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

pub struct LocalFetch;

#[async_trait]
impl FetchProvider for LocalFetch {
    fn id(&self) -> &'static str {
        "local"
    }

    async fn fetch(
        &self,
        req: &FetchRequest,
        ctx: &RequestCtx<'_>,
        _secrets: &WebSecrets,
        _fetch_cfg: &FetchConfig,
    ) -> Result<FetchResult, BackendError> {
        fetch_local(req, ctx).await
    }
}

pub async fn fetch_local(req: &FetchRequest, ctx: &RequestCtx<'_>) -> Result<FetchResult, BackendError> {
    let target = validate_fetch_url(&req.url)?;
    let client = build_http_client(target.as_str(), ctx.proxy, ctx.timeout)?;

    let resp = client
        .get(target.as_str())
        .header(USER_AGENT, BROWSER_UA)
        .header(ACCEPT, "text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8")
        .header(ACCEPT_LANGUAGE, "zh-CN,zh;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(classify_reqwest_error)?;

    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    let bytes = resp.bytes().await.map_err(classify_reqwest_error)?;
    if bytes.len() > MAX_BODY_BYTES {
        return Err(BackendError::Config(format!(
            "响应体过大 ({} bytes)，上限 {MAX_BODY_BYTES}",
            bytes.len()
        )));
    }
    let body = String::from_utf8_lossy(&bytes).into_owned();

    if !status.is_success() {
        return Err(map_http_status(status, &body));
    }

    let content = convert_body(&body, &content_type, &req.format, &req.url)?;
    if content.trim().is_empty() {
        return Err(BackendError::Parse("本地抓取结果为空".into()));
    }

    info!(
        url = %req.url,
        bytes = bytes.len(),
        format = %req.format,
        "fetch local: ok"
    );

    Ok(FetchResult {
        url: req.url.clone(),
        content,
        backend: "local".into(),
    })
}

pub fn validate_fetch_url(url: &str) -> Result<url::Url, BackendError> {
    let parsed = url::Url::parse(url.trim())
        .map_err(|e| BackendError::Config(format!("无效 URL: {e}")))?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err(BackendError::Config("仅支持 http/https URL".into())),
    }
    if let Some(host) = parsed.host_str() {
        if is_blocked_host(host) {
            return Err(BackendError::Config("不允许抓取本机或内网地址".into()));
        }
    }
    Ok(parsed)
}

fn is_blocked_host(host: &str) -> bool {
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        return ip.is_loopback() || is_private_ip(&ip);
    }
    false
}

fn is_private_ip(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        std::net::IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_localhost() {
        assert!(validate_fetch_url("http://127.0.0.1/page").is_err());
        assert!(validate_fetch_url("https://example.com").is_ok());
    }
}
