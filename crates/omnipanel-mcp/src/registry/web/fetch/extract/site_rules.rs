//! 站点级 CSS 选择器正文抽取（L1）。

use scraper::{Html, Selector};
use tracing::debug;

use super::format::{html_to_markdown, html_to_plain_text, meaningful_text_len};
use super::{ExtractAttempt, MIN_TEXT_LEN};

struct SiteRule {
    host_suffix: &'static str,
    content_selectors: &'static [&'static str],
    title_selectors: &'static [&'static str],
}

const SITE_RULES: &[SiteRule] = &[
    SiteRule {
        host_suffix: "zhihu.com",
        content_selectors: &[".RichContent", ".Post-RichText", "article"],
        title_selectors: &[".QuestionHeader-title", "h1.QuestionHeader-title", "h1"],
    },
    SiteRule {
        host_suffix: "mp.weixin.qq.com",
        content_selectors: &["#js_content"],
        title_selectors: &["#activity_name", ".rich_media_title", "h1"],
    },
    SiteRule {
        host_suffix: "github.com",
        content_selectors: &["article.markdown-body", ".markdown-body"],
        title_selectors: &["h1", ".gh-header-title"],
    },
    SiteRule {
        host_suffix: "juejin.cn",
        content_selectors: &["article", ".article-content", ".markdown-body"],
        title_selectors: &["h1", ".article-title"],
    },
    SiteRule {
        host_suffix: "sspai.com",
        content_selectors: &["article", ".article-content", "#content"],
        title_selectors: &["h1", ".article-title"],
    },
    SiteRule {
        host_suffix: "36kr.com",
        content_selectors: &[".article-wrapper", "article", ".article-content"],
        title_selectors: &["h1"],
    },
    SiteRule {
        host_suffix: "csdn.net",
        content_selectors: &["#content_views", "article", ".blog-content-box"],
        title_selectors: &["h1", ".title-article"],
    },
];

pub fn extract_by_site_rule(html: &str, url: &str, format: &str) -> Option<ExtractAttempt> {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_ascii_lowercase))?;
    let rule = SITE_RULES.iter().find(|r| host.ends_with(r.host_suffix))?;
    let document = Html::parse_document(html);

    let title_html = select_first_html(&document, rule.title_selectors);
    let content_html = select_best_html(&document, rule.content_selectors)?;
    let combined = match title_html {
        Some(title) if !content_html.contains(&title) => format!("{title}\n{content_html}"),
        _ => content_html,
    };

    let content = render_fragment(&combined, format);
    let text_len = meaningful_text_len(&content);
    if text_len < MIN_TEXT_LEN {
        debug!(
            host = %host,
            text_len,
            rule = rule.host_suffix,
            "site rule: content too short"
        );
        return None;
    }

    debug!(host = %host, text_len, rule = rule.host_suffix, "site rule: ok");
    Some(ExtractAttempt {
        content,
        method: "site_rule",
        quality: None,
        text_len,
    })
}

fn select_first_html(document: &Html, selectors: &[&str]) -> Option<String> {
    for sel in selectors {
        if let Ok(selector) = Selector::parse(sel) {
            if let Some(el) = document.select(&selector).next() {
                let html = el.html();
                if meaningful_text_len(&html_to_plain_text(&html)) >= 3 {
                    return Some(html);
                }
            }
        }
    }
    None
}

fn select_best_html(document: &Html, selectors: &[&str]) -> Option<String> {
    let mut best: Option<(usize, String)> = None;
    for sel in selectors {
        let Ok(selector) = Selector::parse(sel) else {
            continue;
        };
        for el in document.select(&selector) {
            let html = el.html();
            let len = meaningful_text_len(&html_to_plain_text(&html));
            if len < MIN_TEXT_LEN {
                continue;
            }
            match &best {
                Some((best_len, _)) if *best_len >= len => {}
                _ => best = Some((len, html)),
            }
        }
    }
    best.map(|(_, html)| html)
}

fn render_fragment(html: &str, format: &str) -> String {
    match format.trim().to_ascii_lowercase().as_str() {
        "html" => html.to_string(),
        "text" => html_to_plain_text(html),
        _ => html_to_markdown(html),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zhihu_rule_extracts_rich_content() {
        let body = "这是一段足够长的知乎正文内容，用于验证站点规则能够正确抽取 RichContent 区域里的文字。".repeat(6);
        let html = format!(r#"<html><body>
            <h1 class="QuestionHeader-title">测试问题</h1>
            <div class="RichContent"><p>{body}</p></div>
        </body></html>"#);
        let out = extract_by_site_rule(&html, "https://www.zhihu.com/question/123", "markdown")
            .expect("should extract");
        assert!(out.content.contains("测试问题"));
        assert!(out.content.contains("知乎正文"));
    }

    #[test]
    fn weixin_rule_extracts_js_content() {
        let body = "微信公众号正文段落，内容需要超过最小长度阈值才能被认定为有效抽取结果。".repeat(7);
        let html = format!(r#"<html><body>
            <h1 id="activity_name">微信标题</h1>
            <div id="js_content"><p>{body}</p></div>
        </body></html>"#);
        let out = extract_by_site_rule(&html, "https://mp.weixin.qq.com/s/abc", "markdown")
            .expect("should extract");
        assert!(out.content.contains("微信标题"));
        assert!(out.content.contains("公众号正文"));
    }
}
