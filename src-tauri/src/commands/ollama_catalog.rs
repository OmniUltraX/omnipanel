//! Ollama Library 目录：从 ollama.com/library 拉取热度清单并缓存。

use std::fs;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use regex::Regex;
use reqwest::Client;
use serde::{Deserialize, Serialize};

use omnipanel_store::ai_config_dir;

const LIBRARY_URL: &str = "https://ollama.com/library";
const CACHE_FILE: &str = "ollama_library_cache.json";
const CACHE_TTL: Duration = Duration::from_secs(24 * 3600);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryModelEntry {
    pub name: String,
    pub pulls: u64,
    /// 页面标签：tools / embedding / 7b / 8b / …
    pub tags: Vec<String>,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LibraryCacheFile {
    fetched_at_ms: u64,
    models: Vec<LibraryModelEntry>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn cache_path() -> Result<std::path::PathBuf, String> {
    let dir = ai_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(CACHE_FILE))
}

fn parse_pull_count(raw: &str) -> u64 {
    let s = raw.trim().replace(',', "");
    if let Some(n) = s.strip_suffix('M').or_else(|| s.strip_suffix('m')) {
        return (n.parse::<f64>().unwrap_or(0.0) * 1_000_000.0) as u64;
    }
    if let Some(n) = s.strip_suffix('K').or_else(|| s.strip_suffix('k')) {
        return (n.parse::<f64>().unwrap_or(0.0) * 1_000.0) as u64;
    }
    s.parse::<u64>().unwrap_or(0)
}

/// 解析 ollama.com/library HTML，提取模型名 / 拉取量 / 标签 / 简介。
pub fn parse_library_html(html: &str) -> Vec<LibraryModelEntry> {
    let card_re = Regex::new(
        r#"(?s)href="/library/([a-zA-Z0-9._-]+)"[^>]*>.*?<p class="max-w-lg[^"]*"[^>]*>(.*?)</p>(.*?)<span\s*>([\d,.]+[KMkm]?)</span>\s*<span[^>]*>[\s\S]*?Pulls"#,
    )
    .expect("library card regex");
    let tag_re = Regex::new(r#"text-(?:indigo|blue)-600[^>]*>([a-zA-Z0-9._+-]+)</span>"#)
        .expect("tag regex");

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for cap in card_re.captures_iter(html) {
        let name = cap.get(1).map(|m| m.as_str()).unwrap_or("").to_string();
        if name.is_empty() || !seen.insert(name.clone()) {
            continue;
        }
        let description = cap
            .get(2)
            .map(|m| html_unescape_lite(m.as_str()))
            .unwrap_or_default();
        let mid = cap.get(3).map(|m| m.as_str()).unwrap_or("");
        let pulls = parse_pull_count(cap.get(4).map(|m| m.as_str()).unwrap_or("0"));
        let mut tags: Vec<String> = tag_re
            .captures_iter(mid)
            .filter_map(|c| c.get(1).map(|m| m.as_str().to_lowercase()))
            .collect();
        tags.sort();
        tags.dedup();
        out.push(LibraryModelEntry {
            name,
            pulls,
            tags,
            description,
        });
    }
    out.sort_by(|a, b| b.pulls.cmp(&a.pulls));
    out
}

fn html_unescape_lite(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .trim()
        .to_string()
}

fn read_cache() -> Option<LibraryCacheFile> {
    let path = cache_path().ok()?;
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_cache(models: &[LibraryModelEntry]) -> Result<(), String> {
    let path = cache_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let file = LibraryCacheFile {
        fetched_at_ms: now_ms(),
        models: models.to_vec(),
    };
    let raw = serde_json::to_string_pretty(&file).map_err(|e| e.to_string())?;
    fs::write(path, raw).map_err(|e| e.to_string())
}

fn cache_fresh(file: &LibraryCacheFile) -> bool {
    let age = now_ms().saturating_sub(file.fetched_at_ms);
    age < CACHE_TTL.as_millis() as u64
}

/// 内置兜底清单（离线 / 解析失败时使用）。
pub fn seed_catalog() -> Vec<LibraryModelEntry> {
    vec![
        LibraryModelEntry {
            name: "qwen2.5-coder".into(),
            pulls: 18_600_000,
            tags: vec!["tools".into(), "7b".into(), "14b".into(), "32b".into()],
            description: "编码向 Qwen2.5 Coder".into(),
        },
        LibraryModelEntry {
            name: "qwen3-coder".into(),
            pulls: 7_400_000,
            tags: vec!["tools".into(), "30b".into()],
            description: "新一代编码模型".into(),
        },
        LibraryModelEntry {
            name: "deepseek-r1".into(),
            pulls: 90_000_000,
            tags: vec!["1.5b".into(), "7b".into(), "8b".into(), "14b".into()],
            description: "推理向 DeepSeek R1 蒸馏系列".into(),
        },
        LibraryModelEntry {
            name: "qwen2.5".into(),
            pulls: 35_000_000,
            tags: vec!["0.5b".into(), "1.5b".into(), "3b".into(), "7b".into(), "14b".into()],
            description: "中文友好通用对话".into(),
        },
        LibraryModelEntry {
            name: "qwen3".into(),
            pulls: 32_000_000,
            tags: vec!["0.6b".into(), "1.7b".into(), "4b".into(), "8b".into(), "14b".into()],
            description: "Qwen3 通用 / 思考".into(),
        },
        LibraryModelEntry {
            name: "llama3.2".into(),
            pulls: 77_000_000,
            tags: vec!["1b".into(), "3b".into()],
            description: "轻量 Llama 3.2".into(),
        },
        LibraryModelEntry {
            name: "gemma3".into(),
            pulls: 38_000_000,
            tags: vec!["1b".into(), "4b".into(), "12b".into(), "27b".into()],
            description: "Gemma 3 多尺寸".into(),
        },
        LibraryModelEntry {
            name: "nomic-embed-text".into(),
            pulls: 79_000_000,
            tags: vec!["embedding".into()],
            description: "通用文本向量".into(),
        },
        LibraryModelEntry {
            name: "bge-m3".into(),
            pulls: 5_000_000,
            tags: vec!["embedding".into()],
            description: "多语言 / 中文友好向量".into(),
        },
        LibraryModelEntry {
            name: "mxbai-embed-large".into(),
            pulls: 12_700_000,
            tags: vec!["embedding".into()],
            description: "高质量英文向量".into(),
        },
    ]
}

async fn fetch_library_html() -> Result<String, String> {
    let client = Client::builder()
        .no_proxy()
        .user_agent("OmniPanel/0.1 (+https://github.com/omnipanel; local-model-catalog)")
        .connect_timeout(Duration::from_secs(8))
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(LIBRARY_URL)
        .send()
        .await
        .map_err(|e| format!("请求 ollama.com/library 失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ollama.com/library HTTP {}", resp.status()));
    }
    resp.text()
        .await
        .map_err(|e| format!("读取 library 正文失败: {e}"))
}

/// 获取目录：优先新鲜缓存 → 联网刷新 → 过期缓存 → 内置种子。
pub async fn load_library_catalog(force_refresh: bool) -> (Vec<LibraryModelEntry>, String) {
    if !force_refresh {
        if let Some(cache) = read_cache() {
            if cache_fresh(&cache) && !cache.models.is_empty() {
                return (cache.models, "cache".into());
            }
        }
    }

    match fetch_library_html().await {
        Ok(html) => {
            let parsed = parse_library_html(&html);
            if parsed.len() >= 8 {
                let _ = write_cache(&parsed);
                return (parsed, "network".into());
            }
            // 解析偏少时仍写入，但回退种子补全热度场景
            let mut merged = seed_catalog();
            for m in parsed {
                if let Some(existing) = merged.iter_mut().find(|x| x.name == m.name) {
                    *existing = m;
                } else {
                    merged.push(m);
                }
            }
            merged.sort_by(|a, b| b.pulls.cmp(&a.pulls));
            let _ = write_cache(&merged);
            (merged, "network+seed".into())
        }
        Err(_) => {
            if let Some(cache) = read_cache() {
                if !cache.models.is_empty() {
                    return (cache.models, "stale_cache".into());
                }
            }
            (seed_catalog(), "seed".into())
        }
    }
}

pub fn catalog_source_label(source: &str) -> &str {
    match source {
        "cache" => "本地缓存（24h）",
        "network" => "ollama.com/library",
        "network+seed" => "ollama.com/library + 内置补全",
        "stale_cache" => "过期缓存（联网失败）",
        _ => "内置清单",
    }
}
