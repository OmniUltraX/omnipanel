//! 本地 HTML 正文抽取瀑布：站点规则 → trafilatura → 整页 html2md。

mod format;
mod site_rules;
mod trafilatura_ext;

use tracing::debug;

use super::super::common::BackendError;
pub use format::{format_json_body, html_to_markdown, html_to_plain_text, looks_like_html};

pub const MIN_TEXT_LEN: usize = 200;
pub const MIN_TRAFILATURA_QUALITY: f64 = 0.6;

#[derive(Debug, Clone)]
pub struct ExtractAttempt {
    pub content: String,
    pub method: &'static str,
    pub quality: Option<f64>,
    pub text_len: usize,
}

/// 对 HTML 正文执行三级抽取，全部不达标则返回 Parse 错误以触发 Jina 降级。
pub fn extract_html_content(html: &str, url: &str, format: &str) -> Result<ExtractAttempt, BackendError> {
    if let Some(attempt) = site_rules::extract_by_site_rule(html, url, format) {
        debug!(method = attempt.method, text_len = attempt.text_len, "extract: ok");
        return Ok(attempt);
    }

    if let Some(attempt) = trafilatura_ext::extract_by_trafilatura(html, url, format) {
        debug!(
            method = attempt.method,
            text_len = attempt.text_len,
            quality = ?attempt.quality,
            "extract: ok"
        );
        return Ok(attempt);
    }

    let content = match format.trim().to_ascii_lowercase().as_str() {
        "html" => html.to_string(),
        "text" => html_to_plain_text(html),
        _ => html_to_markdown(html),
    };
    let text_len = format::meaningful_text_len(&content);
    if text_len >= MIN_TEXT_LEN {
        debug!(text_len, method = "html2md", "extract: ok");
        return Ok(ExtractAttempt {
            content,
            method: "html2md",
            quality: None,
            text_len,
        });
    }

    Err(BackendError::Parse(format!(
        "本地正文抽取质量不足（有效字符 {text_len} < {MIN_TEXT_LEN}），将尝试降级"
    )))
}

pub fn convert_body(body: &str, content_type: &str, format: &str, url: &str) -> Result<String, BackendError> {
    let fmt = format.trim().to_ascii_lowercase();
    let is_html = content_type.contains("text/html")
        || content_type.contains("application/xhtml")
        || looks_like_html(body);
    let is_json = content_type.contains("json");

    match fmt.as_str() {
        "html" if is_html => extract_html_content(body, url, "html").map(|a| a.content),
        "text" if is_html => extract_html_content(body, url, "text").map(|a| a.content),
        "html" => Ok(body.to_string()),
        "text" => {
            if is_html {
                extract_html_content(body, url, "text").map(|a| a.content)
            } else {
                Ok(body.trim().to_string())
            }
        }
        _ => {
            if is_json {
                Ok(format_json_body(body))
            } else if is_html {
                extract_html_content(body, url, "markdown").map(|a| a.content)
            } else {
                Ok(body.trim().to_string())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convert_json_to_pretty() {
        let body = r#"{"a":1}"#;
        let out = convert_body(body, "application/json", "markdown", "https://example.com").unwrap();
        assert!(out.contains("\"a\""));
    }

    #[test]
    fn waterfall_prefers_site_rule_over_html2md() {
        let body = "站点规则优先：这段知乎正文足够长，应当由 L1 站点选择器命中而不是走整页 html2md 兜底逻辑。".repeat(5);
        let html = format!(r#"<html><body>
            <div class="RichContent"><p>{body}</p></div>
            <div class="noise">nav noise sidebar advertisement</div>
        </body></html>"#);
        let attempt =
            extract_html_content(&html, "https://www.zhihu.com/question/1", "markdown").unwrap();
        assert_eq!(attempt.method, "site_rule");
    }
}
