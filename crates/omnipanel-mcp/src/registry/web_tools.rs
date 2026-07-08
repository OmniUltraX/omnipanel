//! 内置 Web 搜索 / 网页抓取工具（Exa → DuckDuckGo → Jina 多后端路由）。

use std::sync::Arc;
use std::time::Duration;

use omnipanel_store::{
    exa_api_key_configured, load_exa_api_key, load_http_proxy_config, load_web_search_config,
    HttpProxyConfig, WebSearchBackend,
};
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;
use tokio::sync::Mutex;

const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,[::1],::1";

#[derive(Debug, Serialize)]
pub struct SearchHit {
    title: String,
    url: String,
    snippet: String,
}

fn loopback_no_proxy() -> Option<reqwest::NoProxy> {
    reqwest::NoProxy::from_string(LOOPBACK_NO_PROXY)
}

fn is_loopback_http_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| {
            let host = host.trim().trim_start_matches('[').trim_end_matches(']');
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .map(|ip| ip.is_loopback())
                    .unwrap_or(false)
        }))
        .unwrap_or(false)
}

pub fn build_http_client(url: &str, proxy: &HttpProxyConfig, timeout: Duration) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("OmniPanel/1.0 (web-tools)");

    if is_loopback_http_url(url) {
        builder = builder.no_proxy();
    } else if proxy.enabled && !proxy.host.is_empty() {
        let proxy_url = format!("{}://{}:{}", proxy.protocol, proxy.host, proxy.port);
        let mut p = reqwest::Proxy::all(&proxy_url).map_err(|e| e.to_string())?;
        if !proxy.username.is_empty() {
            p = p.basic_auth(&proxy.username, &proxy.password);
        }
        p = p.no_proxy(loopback_no_proxy());
        builder = builder.proxy(p);
    }

    builder.build().map_err(|e| e.to_string())
}

fn effective_proxy(override_proxy: Option<&HttpProxyConfig>) -> HttpProxyConfig {
    override_proxy
        .cloned()
        .or_else(|| load_http_proxy_config().ok())
        .unwrap_or_default()
}

pub async fn search(
    args: Value,
    _storage: Arc<Mutex<omnipanel_store::Storage>>,
    proxy_override: Option<HttpProxyConfig>,
) -> Result<(String, bool), String> {
    let config = load_web_search_config().map_err(|e| e.to_string())?;
    if !config.enabled {
        return Err("Web 搜索已在设置中禁用".to_string());
    }

    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "query 不能为空".to_string())?;

    let max_results = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(10)
        .clamp(1, 20) as usize;

    let proxy = effective_proxy(proxy_override.as_ref());
    let backend = WebSearchBackend::parse(&config.backend);

    let hits = match backend {
        WebSearchBackend::Exa => search_exa(query, max_results, &proxy).await?,
        WebSearchBackend::Ddg => search_ddg(query, max_results, &proxy).await?,
        WebSearchBackend::Jina => search_jina(query, max_results, &proxy).await?,
        WebSearchBackend::Auto => search_auto(query, max_results, &proxy).await?,
    };

    Ok((serde_json::to_string(&hits).unwrap_or_else(|_| "[]".to_string()), true))
}

pub async fn search_auto(query: &str, max_results: usize, proxy: &HttpProxyConfig) -> Result<Vec<SearchHit>, String> {
    if exa_api_key_configured() {
        if let Ok(hits) = search_exa(query, max_results, proxy).await {
            if !hits.is_empty() {
                return Ok(hits);
            }
        }
    }
    if let Ok(hits) = search_ddg(query, max_results, proxy).await {
        if !hits.is_empty() {
            return Ok(hits);
        }
    }
    search_jina(query, max_results, proxy).await
}

pub async fn search_exa(query: &str, max_results: usize, proxy: &HttpProxyConfig) -> Result<Vec<SearchHit>, String> {
    let api_key = load_exa_api_key()
        .map_err(|e| e.to_string())?
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| "未配置 Exa API Key".to_string())?;

    let url = "https://api.exa.ai/search";
    let client = build_http_client(url, proxy, Duration::from_secs(30))?;
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
        .map_err(|e| format!("Exa 请求失败: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("Exa HTTP {}", resp.status()));
    }

    let json: Value = resp.json().await.map_err(|e| e.to_string())?;
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
            });
        }
    }
    Ok(hits)
}

async fn search_ddg(query: &str, max_results: usize, proxy: &HttpProxyConfig) -> Result<Vec<SearchHit>, String> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
    );
    let client = build_http_client(&url, proxy, Duration::from_secs(25))?;
    let html = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("DuckDuckGo 请求失败: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    parse_ddg_html(&html, max_results)
}

fn parse_ddg_html(html: &str, max_results: usize) -> Result<Vec<SearchHit>, String> {
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
                        text.split("</a>").next().unwrap_or(text).split("</div>").next().unwrap_or(text),
                    )
                })
            })
            .unwrap_or_default();

        if !raw_url.is_empty() {
            hits.push(SearchHit {
                title,
                url: raw_url.to_string(),
                snippet,
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

async fn search_jina(query: &str, max_results: usize, proxy: &HttpProxyConfig) -> Result<Vec<SearchHit>, String> {
    let url = format!(
        "https://s.jina.ai/{}",
        url::form_urlencoded::byte_serialize(query.as_bytes()).collect::<String>()
    );
    let client = build_http_client(&url, proxy, Duration::from_secs(30))?;
    let text = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Jina Search 请求失败: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;

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
            });
        }
    }
    if hits.is_empty() && !text.trim().is_empty() {
        hits.push(SearchHit {
            title: query.to_string(),
            url: String::new(),
            snippet: text.chars().take(800).collect(),
        });
    }
    Ok(hits)
}

pub async fn fetch(
    args: Value,
    _storage: Arc<Mutex<omnipanel_store::Storage>>,
    proxy_override: Option<HttpProxyConfig>,
) -> Result<(String, bool), String> {
    let target = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "url 不能为空".to_string())?;

    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("markdown");

    let proxy = effective_proxy(proxy_override.as_ref());
    let jina_url = format!("https://r.jina.ai/{target}");
    let client = build_http_client(&jina_url, &proxy, Duration::from_secs(45))?;
    let body = client
        .get(&jina_url)
        .send()
        .await
        .map_err(|e| format!("Jina Reader 请求失败: {e}"))?
        .text()
        .await
        .map_err(|e| e.to_string())?;

    let content = if format.eq_ignore_ascii_case("text") {
        body.lines().skip_while(|l| l.starts_with("Title:") || l.starts_with("URL:") || l.trim().is_empty()).collect::<Vec<_>>().join("\n")
    } else {
        body
    };

    Ok((serde_json::json!({ "url": target, "content": content }).to_string(), true))
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
