//! HTML → Markdown / 纯文本转换工具。

pub fn html_to_markdown(html: &str) -> String {
    let cleaned = strip_noisy_tags(html);
    let md = html2md::parse_html(&cleaned);
    if md.trim().is_empty() {
        html_to_plain_text(html)
    } else {
        md.trim().to_string()
    }
}

pub fn html_to_plain_text(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in strip_noisy_tags(html).chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    decode_basic_entities(&out)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn meaningful_text_len(s: &str) -> usize {
    s.chars()
        .filter(|c| !c.is_whitespace() && !matches!(c, '#' | '*' | '_' | '`' | '|' | '>' | '-' | '[' | ']' | '(' | ')'))
        .count()
}

pub fn format_json_body(body: &str) -> String {
    match serde_json::from_str::<serde_json::Value>(body) {
        Ok(v) => serde_json::to_string_pretty(&v).unwrap_or_else(|_| body.trim().to_string()),
        Err(_) => body.trim().to_string(),
    }
}

pub fn looks_like_html(body: &str) -> bool {
    let head = body.trim_start().get(..256).unwrap_or(body).to_ascii_lowercase();
    head.contains("<html") || head.contains("<!doctype") || head.contains("<body")
}

fn strip_noisy_tags(html: &str) -> String {
    let mut out = html.to_string();
    for tag in ["script", "style", "noscript", "svg", "iframe"] {
        out = remove_tag_block(&out, tag);
    }
    out
}

fn remove_tag_block(html: &str, tag: &str) -> String {
    let open = format!("<{tag}");
    let close = format!("</{tag}>");
    let lower = html.to_ascii_lowercase();
    let mut result = String::with_capacity(html.len());
    let mut rest = html;
    let mut lower_rest = lower.as_str();
    while let Some(start) = lower_rest.find(&open) {
        result.push_str(&rest[..start]);
        let after_open = &rest[start..];
        let after_open_lower = &lower_rest[start..];
        if let Some(close_pos) = after_open_lower.find(&close) {
            let end = close_pos + close.len();
            rest = &after_open[end..];
            lower_rest = &after_open_lower[end..];
        } else {
            result.push_str(after_open);
            return result;
        }
    }
    result.push_str(rest);
    result
}

fn decode_basic_entities(s: &str) -> String {
    s.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn html_to_markdown_basic() {
        let html = "<html><body><h1>Title</h1><p>Hello <b>world</b></p></body></html>";
        let md = html_to_markdown(html);
        assert!(md.contains("Title"));
        assert!(md.contains("Hello"));
    }

    #[test]
    fn meaningful_text_len_ignores_markdown_noise() {
        assert!(meaningful_text_len("## Hello **world**") >= 10);
    }
}
