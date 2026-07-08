use async_trait::async_trait;
use omnipanel_store::WebSearchBackend;
use serde_json::Value;

use super::super::common::{
    build_http_client, classify_reqwest_error, map_http_status, BackendError, RequestCtx,
    SearchHit, SearchRequest, WebSecrets,
};
use super::SearchProvider;

pub struct ExaSearch;

#[async_trait]
impl SearchProvider for ExaSearch {
    fn id(&self) -> &'static str {
        WebSearchBackend::Exa.as_str()
    }

    fn is_available(&self, secrets: &WebSecrets) -> bool {
        secrets.exa_configured()
    }

    async fn search(
        &self,
        req: &SearchRequest,
        ctx: &RequestCtx<'_>,
        secrets: &WebSecrets,
    ) -> Result<Vec<SearchHit>, BackendError> {
        search_exa(&req.query, req.max_results, ctx, secrets).await
    }
}

pub async fn search_exa(
    query: &str,
    max_results: usize,
    ctx: &RequestCtx<'_>,
    secrets: &WebSecrets,
) -> Result<Vec<SearchHit>, BackendError> {
    let api_key = secrets
        .exa
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| BackendError::Config("未配置 Exa API Key".into()))?;

    let url = "https://api.exa.ai/search";
    let client = build_http_client(url, ctx.proxy, ctx.timeout)?;
    let body = serde_json::json!({
        "query": query,
        "numResults": max_results,
        "type": "auto",
        "contents": { "text": { "maxCharacters": 300 } }
    });

    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(classify_reqwest_error)?;

    let status = resp.status();
    let text = resp.text().await.map_err(classify_reqwest_error)?;
    if !status.is_success() {
        return Err(map_http_status(status, &text));
    }

    let json: Value = serde_json::from_str(&text).map_err(|e| BackendError::Parse(e.to_string()))?;
    let mut hits = Vec::new();
    if let Some(results) = json.get("results").and_then(|v| v.as_array()) {
        for item in results.iter().take(max_results) {
            hits.push(SearchHit {
                title: item
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                url: item
                    .get("url")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                snippet: item
                    .get("text")
                    .and_then(|v| v.as_str())
                    .or_else(|| item.get("snippet").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .chars()
                    .take(400)
                    .collect(),
                author: None,
            });
        }
    }
    Ok(hits)
}
