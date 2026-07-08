use async_trait::async_trait;
use omnipanel_store::{FetchConfig, JinaDomainMode};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};

use super::super::common::{
    build_http_client, classify_reqwest_error, jina_host, map_http_status, BackendError,
    FetchRequest, FetchResult, RequestCtx, WebSecrets,
};
use super::FetchProvider;

pub struct JinaFetch;

#[async_trait]
impl FetchProvider for JinaFetch {
    fn id(&self) -> &'static str {
        "jina"
    }

    async fn fetch(
        &self,
        req: &FetchRequest,
        ctx: &RequestCtx<'_>,
        secrets: &WebSecrets,
        fetch_cfg: &FetchConfig,
    ) -> Result<FetchResult, BackendError> {
        let domain_mode = JinaDomainMode::parse(&fetch_cfg.jina.domain);
        let hosts: Vec<&str> = match domain_mode {
            JinaDomainMode::Cn => vec!["jinaai.cn"],
            JinaDomainMode::Ai => vec!["jina.ai"],
            JinaDomainMode::Auto => vec!["jinaai.cn", "jina.ai"],
        };

        let mut last_err = None;
        for host in hosts {
            match fetch_on_host(req, ctx, secrets, fetch_cfg, host).await {
                Ok(result) => return Ok(result),
                Err(err) if domain_mode == JinaDomainMode::Auto && err.is_retryable_network() => {
                    last_err = Some(err);
                    continue;
                }
                Err(err) => return Err(err),
            }
        }
        Err(last_err.unwrap_or_else(|| BackendError::Network {
            kind: super::super::common::NetKind::Other,
            source: "Jina Reader 全部镜像失败".into(),
        }))
    }
}

async fn fetch_on_host(
    req: &FetchRequest,
    ctx: &RequestCtx<'_>,
    secrets: &WebSecrets,
    fetch_cfg: &FetchConfig,
    host: &str,
) -> Result<FetchResult, BackendError> {
    let jina_url = format!("https://r.{host}/{}", req.url.trim());
    let client = build_http_client(&jina_url, ctx.proxy, ctx.timeout)?;

    let return_format = normalize_format(&req.format);
    let mut headers = HeaderMap::new();
    headers.insert(
        "x-return-format",
        HeaderValue::from_str(return_format)
            .map_err(|e| BackendError::Config(e.to_string()))?,
    );
    if fetch_cfg.jina.no_cache {
        headers.insert(
            "x-no-cache",
            HeaderValue::from_static("true"),
        );
    }
    if let Some(key) = secrets.jina.as_ref().filter(|k| !k.trim().is_empty()) {
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", key.trim()))
                .map_err(|e| BackendError::Config(e.to_string()))?,
        );
    }

    let resp = client
        .get(&jina_url)
        .headers(headers)
        .send()
        .await
        .map_err(classify_reqwest_error)?;
    let status = resp.status();
    let body = resp.text().await.map_err(classify_reqwest_error)?;
    if !status.is_success() {
        return Err(map_http_status(status, &body));
    }

    let content = if req.format.eq_ignore_ascii_case("text") {
        body.lines()
            .skip_while(|l| {
                l.starts_with("Title:") || l.starts_with("URL:") || l.trim().is_empty()
            })
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        body
    };

    Ok(FetchResult {
        url: req.url.clone(),
        content,
        backend: format!("jina:{host}"),
    })
}

fn normalize_format(format: &str) -> &'static str {
    match format.trim().to_ascii_lowercase().as_str() {
        "text" => "text",
        "html" => "html",
        _ => "markdown",
    }
}

pub fn jina_fetch_url(target: &str, mode: JinaDomainMode, prefer_cn: bool) -> String {
    let host = jina_host(mode, prefer_cn);
    format!("https://r.{host}/{}", target.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnipanel_store::JinaDomainMode;

    #[test]
    fn jina_fetch_url_uses_cn_mirror() {
        let url = jina_fetch_url("https://example.com", JinaDomainMode::Cn, true);
        assert!(url.starts_with("https://r.jinaai.cn/"));
    }

    #[test]
    fn normalize_format_maps_text() {
        assert_eq!(normalize_format("text"), "text");
        assert_eq!(normalize_format("markdown"), "markdown");
    }
}
