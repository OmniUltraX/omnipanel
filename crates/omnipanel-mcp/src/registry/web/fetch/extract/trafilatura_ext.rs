//! rs-trafilatura 正文抽取（L2），带质量门控。

use rs_trafilatura::{extract_with_options, Options};
use tracing::debug;

use super::format::{html_to_markdown, meaningful_text_len};
use super::{ExtractAttempt, MIN_TEXT_LEN, MIN_TRAFILATURA_QUALITY};

pub fn extract_by_trafilatura(html: &str, url: &str, format: &str) -> Option<ExtractAttempt> {
    let mut options = Options::default();
    options.output_markdown = true;
    options.include_links = true;
    options.url = Some(url.to_string());

    let result = extract_with_options(html, &options).ok()?;
    let quality = result.extraction_quality;

    let content = pick_content(&result, format);
    let text_len = meaningful_text_len(&content);

    if text_len < MIN_TEXT_LEN {
        debug!(text_len, quality, "trafilatura: content too short");
        return None;
    }
    if quality < MIN_TRAFILATURA_QUALITY {
        debug!(text_len, quality, "trafilatura: quality below threshold");
        return None;
    }

    debug!(text_len, quality, "trafilatura: ok");
    Some(ExtractAttempt {
        content,
        method: "trafilatura",
        quality: Some(quality),
        text_len,
    })
}

fn pick_content(
    result: &rs_trafilatura::ExtractResult,
    format: &str,
) -> String {
    match format.trim().to_ascii_lowercase().as_str() {
        "html" => result
            .content_html
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| result.content_text.clone()),
        "text" => result.content_text.trim().to_string(),
        _ => result
            .content_markdown
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                result
                    .content_html
                    .as_deref()
                    .map(html_to_markdown)
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| result.content_text.trim().to_string())
            }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trafilatura_extracts_article() {
        let para = "This is a long article paragraph with enough content to pass the minimum text length threshold for extraction quality checks. ";
        let html = format!(r#"<html><head><title>Article</title></head><body>
            <nav>menu nav links sidebar advertisement footer links</nav>
            <article>
                <h1>Main Title</h1>
                <p>{para}</p>
                <p>{para}</p>
                <p>{para}</p>
            </article>
            <footer>copyright footer noise</footer>
        </body></html>"#);
        let out = extract_by_trafilatura(&html, "https://example.com/article", "markdown")
            .expect("should extract");
        assert!(out.content.contains("Main Title"));
        assert!(out.quality.unwrap_or(0.0) >= MIN_TRAFILATURA_QUALITY);
    }
}
