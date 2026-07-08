use async_trait::async_trait;
use omnipanel_store::WebSearchBackend;

use super::super::common::{
    build_http_client, classify_reqwest_error, BackendError, RequestCtx, SearchHit, SearchRequest,
    WebSecrets,
};
use super::SearchProvider;

pub struct DdgSearch;

#[async_trait]
impl SearchProvider for DdgSearch {
    fn id(&self) -> &'static str {
        WebSearchBackend::Ddg.as_str()
    }

    fn is_available(&self, _secrets: &WebSecrets) -> bool {
        true
    }

    async fn search(
        &self,
        req: &SearchRequest,
        ctx: &RequestCtx<'_>,
        _secrets: &WebSecrets,
    ) -> Result<Vec<SearchHit>, BackendError> {
        let url = format!(
            "https://html.duckduckgo.com/html/?q={}",
            url::form_urlencoded::byte_serialize(req.query.as_bytes()).collect::<String>()
        );
        let client = build_http_client(&url, ctx.proxy, ctx.timeout)?;
        let html = client
            .get(&url)
            .send()
            .await
            .map_err(classify_reqwest_error)?
            .text()
            .await
            .map_err(classify_reqwest_error)?;

        parse_ddg_html(&html, req.max_results)
    }
}

pub fn parse_ddg_html(html: &str, max_results: usize) -> Result<Vec<SearchHit>, BackendError> {
    let mut hits = Vec::new();
    let mut rest = html;
    while hits.len() < max_results {
        let Some(a_start) = rest.find(r#"class="result__a""#) else {
            break;
        };
        rest = &rest[a_start..];
        let Some(href_pos) = rest.find("href=\"") else {
            break;
        };
        let after_href = &rest[href_pos + 6..];
        let Some(url_end) = after_href.find('"') else {
            break;
        };
        let raw_url = &after_href[..url_end];
        let title_end = after_href.find("</a>").unwrap_or(after_href.len());
        let title_html = &after_href[..title_end.min(after_href.len())];
        let title = strip_html_tags(title_html);

        let snippet = rest
            .find(r#"class="result__snippet""#)
            .and_then(|pos| {
                let chunk = &rest[pos..];
                chunk.find('>').map(|gt| {
                    let text = &chunk[gt + 1..];
                    strip_html_tags(
                        text.split("</a>")
                            .next()
                            .unwrap_or(text)
                            .split("</div>")
                            .next()
                            .unwrap_or(text),
                    )
                })
            })
            .unwrap_or_default();

        if !raw_url.is_empty() {
            hits.push(SearchHit {
                title,
                url: raw_url.to_string(),
                snippet,
                author: None,
            });
        }
        rest = &rest[href_pos + 6 + url_end..];
    }
    Ok(hits)
}

fn strip_html_tags(input: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in input.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    html_unescape(&out).trim().to_string()
}

fn html_unescape(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ddg_extracts_one_result() {
        let html = r#"<a class="result__a" href="https://example.com">Example</a><div class="result__snippet">Hello world</div>"#;
        let hits = parse_ddg_html(html, 5).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].url, "https://example.com");
    }
}
