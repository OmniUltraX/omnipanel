//! Cursor 官方定价表。登录接口没有每百万 token 的单价，表在文档 markdown 里。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use omnipanel_ai::AgentSourceModel;

/// `.md` 后缀会 404。带 `Accept: text/markdown` 时，这个地址直接返回表格。
const PRICING_URL: &str = "https://cursor.com/docs/models-and-pricing";
const EFFORT_WORDS: &[&str] = &[
    "none", "minimal", "low", "medium", "high", "extra", "xhigh", "max", "thinking",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModelRate {
    pub key: String,
    pub input: String,
    pub output: String,
}

pub async fn load_rates(client: &Client) -> Vec<ModelRate> {
    match fetch_rates(client).await {
        Ok(rates) => {
            let _ = save_rate_cache(&rates);
            rates
        }
        Err(_) => load_rate_cache().unwrap_or_default(),
    }
}

pub fn apply_rates(models: &mut [AgentSourceModel], rates: &[ModelRate]) {
    if rates.is_empty() {
        return;
    }
    let mut by_key: HashMap<String, &ModelRate> = HashMap::new();
    for rate in rates {
        for key in alias_keys(&rate.key) {
            by_key.entry(key).or_insert(rate);
        }
    }
    for model in models {
        let rate = lookup(&by_key, &model.name).or_else(|| lookup(&by_key, &model.id));
        if let Some(rate) = rate {
            model.credits = Some(format!("${}/${}", rate.input, rate.output));
        }
    }
}

fn lookup<'a>(by_key: &HashMap<String, &'a ModelRate>, name: &str) -> Option<&'a ModelRate> {
    for key in candidate_keys(name) {
        if let Some(rate) = by_key.get(&key) {
            return Some(*rate);
        }
    }
    None
}

/// 先精确匹配，再去掉 Low / Medium / Extra High 这类档位。
/// 带 Fast 的先找单独的 Fast 行，没有再用基础价。
fn candidate_keys(name: &str) -> Vec<String> {
    let key = price_key(name);
    let mut keys = Vec::new();
    push_keys(&mut keys, &key);
    let with_fast = strip_effort(&key);
    push_keys(&mut keys, &with_fast);
    if let Some(base) = with_fast.strip_suffix(" fast") {
        push_keys(&mut keys, base.trim());
    }
    keys
}

fn push_keys(keys: &mut Vec<String>, key: &str) {
    if key.is_empty() {
        return;
    }
    for alias in alias_keys(key) {
        if !keys.contains(&alias) {
            keys.push(alias);
        }
    }
}

fn strip_effort(key: &str) -> String {
    let mut words: Vec<&str> = key.split_whitespace().collect();
    let fast = words.last() == Some(&"fast");
    if fast {
        words.pop();
    }
    while words.last().is_some_and(|word| EFFORT_WORDS.contains(word)) {
        words.pop();
    }
    if fast {
        words.push("fast");
    }
    words.join(" ")
}

async fn fetch_rates(client: &Client) -> Result<Vec<ModelRate>, String> {
    let response = client
        .get(PRICING_URL)
        .timeout(Duration::from_secs(12))
        .header("accept", "text/markdown")
        .header(
            "user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        )
        .send()
        .await
        .map_err(|e| format!("拉取 Cursor 定价失败: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("Cursor 定价页返回 {}", response.status()));
    }
    let text = response.text().await.map_err(|e| e.to_string())?;
    let rates = parse_pricing_markdown(&text);
    if rates.len() < 5 {
        return Err("Cursor 定价表解析结果太少".into());
    }
    Ok(rates)
}

pub fn parse_pricing_markdown(text: &str) -> Vec<ModelRate> {
    let mut rates = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with('|') {
            continue;
        }
        let cells: Vec<&str> = line.trim_matches('|').split('|').map(str::trim).collect();
        if cells.len() < 6 {
            continue;
        }
        let Some(input) = parse_dollar(cells[2]) else {
            continue;
        };
        let Some(output) = parse_dollar(cells[5]) else {
            continue;
        };
        let key = price_key(&plain_model_name(cells[0]));
        if key.is_empty() || !seen.insert(key.clone()) {
            continue;
        }
        rates.push(ModelRate { key, input, output });
    }
    rates
}

fn plain_model_name(cell: &str) -> String {
    let cell = cell.trim();
    if let Some(rest) = cell.strip_prefix('[') {
        if let Some((label, after)) = rest.split_once(']') {
            if after.starts_with('(') {
                return label.to_string();
            }
        }
    }
    cell.to_string()
}

fn parse_dollar(cell: &str) -> Option<String> {
    let cell = cell.trim();
    let rest = cell.strip_prefix('$')?.trim();
    if rest.is_empty() || !rest.chars().all(|ch| ch.is_ascii_digit() || ch == '.') {
        return None;
    }
    if rest.starts_with('.') || rest.ends_with('.') || rest.contains("..") {
        return None;
    }
    Some(rest.to_string())
}

/// 把显示名和目录 id 收成同一套词。数字之间的横线视作小数点：`4-7` 与 `4.7` 相同。
pub fn price_key(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if (ch == 'p' || ch == 'P')
            && out.chars().last().is_some_and(|c| c.is_ascii_digit())
            && chars.get(i + 1).is_some_and(|c| c.is_ascii_digit())
        {
            out.push('.');
            i += 1;
            continue;
        }
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            i += 1;
            continue;
        }
        if ch == '.' {
            out.push('.');
            i += 1;
            continue;
        }
        let prev_digit = out.chars().last().is_some_and(|c| c.is_ascii_digit());
        let mut j = i;
        while j < chars.len() && !chars[j].is_ascii_alphanumeric() && chars[j] != '.' {
            j += 1;
        }
        let next_digit = j < chars.len() && chars[j].is_ascii_digit();
        if prev_digit && next_digit {
            if !out.ends_with('.') {
                out.push('.');
            }
        } else if !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
        }
        i = j;
    }
    out.trim().to_string()
}

fn alias_keys(key: &str) -> Vec<String> {
    let mut keys = vec![key.to_string()];
    let fast = key.replace("fast mode", "fast");
    if fast != key {
        keys.push(fast);
    }
    keys
}

fn rate_cache_path() -> Option<PathBuf> {
    let dir = omnipanel_store::ai_config_dir().ok()?.join("agent-sources");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("cursor-pricing.json"))
}

fn save_rate_cache(rates: &[ModelRate]) -> Result<(), String> {
    let path = rate_cache_path().ok_or_else(|| "无法写入定价缓存".to_string())?;
    std::fs::write(
        path,
        serde_json::to_string(rates).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

pub fn load_rate_cache() -> Option<Vec<ModelRate>> {
    let path = rate_cache_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    let rates: Vec<ModelRate> = serde_json::from_str(&text).ok()?;
    if rates.is_empty() { None } else { Some(rates) }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
| Model | Provider | Input | Cache write | Cache read | Output | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| [Grok 4.7](https://x.ai/news/grok-4-7) | Cursor | $2 | - | $0.5 | $6 | note |
| Grok 4.7 (Fast) | Cursor | $4 | - | $1 | $12 | note |
| Composer 2.5 | Cursor | $0.5 | - | $0.2 | $2.5 | - |
| Claude Opus 4.7 (fast mode) | Anthropic | $30 | $37.5 | $3 | $150 | note |
| Plan | Price | Cursor Models | Other Models |
| Pro | $20/mo | Included | Included |
"#;

    #[test]
    fn table_keeps_token_rates_and_skips_plans() {
        let rates = parse_pricing_markdown(SAMPLE);
        assert_eq!(rates.len(), 4);
        assert_eq!(rates[0].key, "grok 4.7");
        assert_eq!(rates[0].input, "2");
        assert_eq!(rates[0].output, "6");
        assert_eq!(rates[2].input, "0.5");
        assert_eq!(rates[2].output, "2.5");
    }

    #[test]
    fn ids_match_display_names() {
        assert_eq!(price_key("grok-4.7"), "grok 4.7");
        assert_eq!(price_key("claude-opus-4-7-fast"), "claude opus 4.7 fast");
        assert_eq!(
            price_key("Claude Opus 4.7 (fast mode)"),
            "claude opus 4.7 fast mode"
        );
        let rates = parse_pricing_markdown(SAMPLE);
        let mut models = vec![
            AgentSourceModel {
                id: "grok-4.7".into(),
                name: "Grok 4.7".into(),
                ..AgentSourceModel::default()
            },
            AgentSourceModel {
                id: "claude-opus-4-7-fast".into(),
                name: "Opus".into(),
                ..AgentSourceModel::default()
            },
            AgentSourceModel {
                id: "default".into(),
                name: "Auto".into(),
                ..AgentSourceModel::default()
            },
            AgentSourceModel {
                id: "claude-opus-5-medium".into(),
                name: "Claude Opus 5 Medium".into(),
                ..AgentSourceModel::default()
            },
            AgentSourceModel {
                id: "glm-5p3-high".into(),
                name: "GLM 5.3".into(),
                ..AgentSourceModel::default()
            },
        ];
        apply_rates(&mut models, &rates);
        assert_eq!(models[0].credits.as_deref(), Some("$2/$6"));
        assert_eq!(models[1].credits.as_deref(), Some("$30/$150"));
        assert_eq!(models[2].credits.as_deref(), None);
        assert_eq!(models[3].credits.as_deref(), None);
        assert_eq!(price_key("glm-5p3-high"), "glm 5.3 high");
    }

    #[test]
    fn effort_variants_use_the_base_rate_and_fast_prefers_its_row() {
        let rates = parse_pricing_markdown(SAMPLE);
        let mut models = vec![
            AgentSourceModel {
                id: "grok-4.7-fast".into(),
                name: "Grok 4.7 Fast".into(),
                ..AgentSourceModel::default()
            },
            AgentSourceModel {
                id: "composer-2.5-fast".into(),
                name: "Composer 2.5 Fast".into(),
                ..AgentSourceModel::default()
            },
            AgentSourceModel {
                id: "claude-opus-4-7-medium".into(),
                name: "Claude Opus 4.7 Medium".into(),
                ..AgentSourceModel::default()
            },
        ];
        let mut rates = rates;
        rates.push(ModelRate {
            key: "claude opus 4.7".into(),
            input: "5".into(),
            output: "25".into(),
        });
        apply_rates(&mut models, &rates);
        assert_eq!(models[0].credits.as_deref(), Some("$4/$12"));
        assert_eq!(models[1].credits.as_deref(), Some("$0.5/$2.5"));
        assert_eq!(models[2].credits.as_deref(), Some("$5/$25"));
    }
}
