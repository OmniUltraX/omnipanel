use async_trait::async_trait;
use omnipanel_store::{JinaDomainMode, WebSearchBackend};
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};

use super::super::common::{
    build_http_client, classify_reqwest_error, jina_host, map_http_status, BackendError,
    RequestCtx, SearchHit, SearchRequest, WebSecrets,
};
use super::SearchProvider;

pub struct JinaSearch;

#[async_trait]
impl SearchProvider for JinaSearch {
    fn id(&self) -> &'static str {
        WebSearchBackend::Jina.as_str()
    }

    fn is_available(&self, _secrets: &WebSecrets) -> bool {
        true
    }

    async fn search(
        &self,
        req: &SearchRequest,
        ctx: &RequestCtx<'_>,
        secrets: &WebSecrets,
    ) -> Result<Vec<SearchHit>, BackendError> {
        let domain_mode = JinaDomainMode::Auto;
        search_jina_with_domain(req, ctx, secrets, domain_mode, true).await
    }
}

pub async fn search_jina_with_domain(
    req: &SearchRequest,
    ctx: &RequestCtx<'_>,
    secrets: &WebSecrets,
    domain_mode: JinaDomainMode,
    try_fallback: bool,
) -> Result<Vec<SearchHit>, BackendError> {
    let hosts: Vec<&str> = match domain_mode {
        JinaDomainMode::Cn => vec!["jinaai.cn"],
        JinaDomainMode::Ai => vec!["jina.ai"],
        JinaDomainMode::Auto => {
            if try_fallback {
                vec!["jinaai.cn", "jina.ai"]
            } else {
                vec!["jinaai.cn"]
            }
        }
    };

    let mut last_err = None;
    for host in hosts {
        match search_jina_on_host(req, ctx, secrets, host).await {
            Ok(hits) if !hits.is_empty() => return Ok(hits),
            Ok(hits) => return Ok(hits),
            Err(err) if try_fallback && err.is_retryable_network() => {
                last_err = Some(err);
                continue;
            }
            Err(err) => return Err(err),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        BackendError::Network {
            kind: super::super::common::NetKind::Other,
            source: "Jina 搜索全部镜像失败".into(),
        }
    }))
}

async fn search_jina_on_host(
    req: &SearchRequest,
    ctx: &RequestCtx<'_>,
    secrets: &WebSecrets,
    host: &str,
) -> Result<Vec<SearchHit>, BackendError> {
    let encoded =
        url::form_urlencoded::byte_serialize(req.query.as_bytes()).collect::<String>();
    let url = format!("https://s.{host}/{encoded}");
    let client = build_http_client(&url, ctx.proxy, ctx.timeout)?;

    let mut req_builder = client.get(&url);
    if let Some(key) = secrets.jina.as_ref().filter(|k| !k.trim().is_empty()) {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", key.trim()))
                .map_err(|e| BackendError::Config(e.to_string()))?,
        );
        req_builder = req_builder.headers(headers);
    }

    let resp = req_builder
        .send()
        .await
        .map_err(classify_reqwest_error)?;
    let status = resp.status();
    let text = resp.text().await.map_err(classify_reqwest_error)?;
    if !status.is_success() {
        return Err(map_http_status(status, &text));
    }

    parse_jina_search_text(&text, req.max_results)
}

fn parse_jina_search_text(text: &str, max_results: usize) -> Result<Vec<SearchHit>, BackendError> {
    let mut hits = Vec::new();
    for block in text.split("\n\n").filter(|b| !b.trim().is_empty()) {
        if hits.len() >= max_results {
            break;
        }
        let mut title = String::new();
        let mut link = String::new();
        let mut snippet = String::new();
        for line in block.lines() {
            if let Some(t) = line.strip_prefix("Title: ") {
                title = t.trim().to_string();
            } else if let Some(u) = line.strip_prefix("URL: ") {
                link = u.trim().to_string();
            } else if !line.starts_with("Title:") && !line.starts_with("URL:") {
                snippet.push_str(line);
                snippet.push(' ');
            }
        }
        if !link.is_empty() {
            hits.push(SearchHit {
                title,
                url: link,
                snippet: snippet.trim().chars().take(400).collect(),
                author: None,
            });
        }
    }
    if hits.is_empty() && !text.trim().is_empty() {
        hits.push(SearchHit {
            title: String::new(),
            url: String::new(),
            snippet: text.chars().take(800).collect(),
            author: None,
        });
    }
    Ok(hits)
}

pub fn jina_search_url(query: &str, host: &str) -> String {
    let encoded = url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>();
    format!("https://s.{host}/{encoded}")
}

pub fn resolve_jina_search_host(mode: JinaDomainMode, prefer_cn: bool) -> &'static str {
    jina_host(mode, prefer_cn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jina_search_url_uses_cn_host() {
        let url = jina_search_url("rust", "jinaai.cn");
        assert!(url.starts_with("https://s.jinaai.cn/"));
    }
}
