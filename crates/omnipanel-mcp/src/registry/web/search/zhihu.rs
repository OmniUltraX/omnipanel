use async_trait::async_trait;
use omnipanel_store::WebSearchBackend;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

use super::super::common::{
    build_http_client, classify_reqwest_error, map_http_status, BackendError, RequestCtx,
    SearchHit, SearchRequest, SearchScope, WebSecrets,
};
use super::SearchProvider;

const ZHIHU_BASE: &str = "https://developer.zhihu.com";

pub struct ZhihuSearch;

#[async_trait]
impl SearchProvider for ZhihuSearch {
    fn id(&self) -> &'static str {
        WebSearchBackend::Zhihu.as_str()
    }

    fn is_available(&self, secrets: &WebSecrets) -> bool {
        secrets.zhihu_configured()
    }

    async fn search(
        &self,
        req: &SearchRequest,
        ctx: &RequestCtx<'_>,
        secrets: &WebSecrets,
    ) -> Result<Vec<SearchHit>, BackendError> {
        let secret = secrets
            .zhihu
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| BackendError::Config("未配置知乎 Access Secret".into()))?;

        let (path, max_count) = if req.scope == SearchScope::Zhihu {
            ("/api/v1/content/zhihu_search", req.max_results.clamp(1, 10))
        } else {
            ("/api/v1/content/global_search", req.max_results.clamp(1, 20))
        };

        let url = format!(
            "{ZHIHU_BASE}{path}?Query={}&Count={max_count}",
            url::form_urlencoded::byte_serialize(req.query.as_bytes()).collect::<String>()
        );

        let client = build_http_client(&url, ctx.proxy, ctx.timeout)?;
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);

        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {secret}"))
                .map_err(|e| BackendError::Config(e.to_string()))?,
        );
        headers.insert(
            "X-Request-Timestamp",
            HeaderValue::from_str(&ts.to_string())
                .map_err(|e| BackendError::Config(e.to_string()))?,
        );

        let resp = client
            .get(&url)
            .headers(headers)
            .send()
            .await
            .map_err(classify_reqwest_error)?;

        let status = resp.status();
        let body = resp.text().await.map_err(classify_reqwest_error)?;
        if !status.is_success() {
            return Err(map_http_status(status, &body));
        }

        parse_zhihu_response(&body, max_count)
    }
}

fn parse_zhihu_response(body: &str, max_results: usize) -> Result<Vec<SearchHit>, BackendError> {
    let json: Value =
        serde_json::from_str(body).map_err(|e| BackendError::Parse(e.to_string()))?;

    if let Some(code) = json.get("Code").and_then(|v| v.as_i64()) {
        if code != 0 {
            let msg = json
                .get("Message")
                .and_then(|v| v.as_str())
                .unwrap_or("知乎 API 错误");
            return Err(BackendError::Http {
                status: code as u16,
                body: msg.to_string(),
            });
        }
    }

    let items = json
        .pointer("/Data/Items")
        .or_else(|| json.pointer("/data/items"))
        .or_else(|| json.get("Items"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut hits = Vec::new();
    for item in items.into_iter().take(max_results) {
        let title = pick_str(&item, &["Title", "title"]).unwrap_or_default();
        let url = pick_str(&item, &["Url", "URL", "url"]).unwrap_or_default();
        let snippet = pick_str(&item, &["Summary", "Abstract", "summary", "abstract"])
            .unwrap_or_default();
        let author = pick_str(&item, &["AuthorName", "author_name", "authorName"]);
        if !url.is_empty() || !title.is_empty() {
            hits.push(SearchHit {
                title,
                url,
                snippet: snippet.chars().take(400).collect(),
                author,
            });
        }
    }

    Ok(hits)
}

fn pick_str(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(s) = value.get(*key).and_then(|v| v.as_str()) {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    None
}
