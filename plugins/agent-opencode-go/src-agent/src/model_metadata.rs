//! OpenCode Go 各模型使用的 HTTP 协议（来自 [models.dev](https://models.dev/api.json)）。

use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const MODEL_METADATA_URL: &str = "https://models.dev/api.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireApi {
    OpenAiCompletions,
    OpenAiResponses,
    AnthropicMessages,
}

impl WireApi {
    pub fn from_provider_npm(npm: &str) -> Option<Self> {
        match npm.trim() {
            "@ai-sdk/openai" => Some(Self::OpenAiResponses),
            "@ai-sdk/openai-compatible" => Some(Self::OpenAiCompletions),
            "@ai-sdk/anthropic" => Some(Self::AnthropicMessages),
            _ => None,
        }
    }
}

/// 解析 models.dev 中 `opencode-go` 段的模型 → 协议映射。
pub fn parse_opencode_go_wire_apis(body: &Value) -> HashMap<String, WireApi> {
    let provider = body
        .get("opencode-go")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let default_npm = provider.get("npm").and_then(Value::as_str).unwrap_or("");
    let models = provider
        .get("models")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut out = HashMap::new();
    for (id, entry) in models {
        let npm = entry
            .get("provider")
            .and_then(|p| p.get("npm"))
            .and_then(Value::as_str)
            .unwrap_or(default_npm);
        if let Some(api) = WireApi::from_provider_npm(npm) {
            out.insert(id, api);
        }
    }
    out
}

const CACHE_TTL: Duration = Duration::from_secs(12 * 60 * 60);

#[derive(Serialize, Deserialize)]
struct WireCacheFile {
    fetched_at_ms: u64,
    apis: HashMap<String, String>,
}

fn wire_cache_path() -> PathBuf {
    let base = std::env::var("LOCALAPPDATA")
        .or_else(|_| std::env::var("HOME"))
        .unwrap_or_else(|_| ".".into());
    PathBuf::from(base)
        .join("omnipanel")
        .join("opencode-go-wire.json")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

fn wire_to_token(api: WireApi) -> &'static str {
    match api {
        WireApi::OpenAiCompletions => "completions",
        WireApi::OpenAiResponses => "responses",
        WireApi::AnthropicMessages => "anthropic",
    }
}

fn token_to_wire(token: &str) -> Option<WireApi> {
    match token {
        "completions" => Some(WireApi::OpenAiCompletions),
        "responses" => Some(WireApi::OpenAiResponses),
        "anthropic" => Some(WireApi::AnthropicMessages),
        _ => None,
    }
}

fn read_cache() -> Option<(u64, HashMap<String, WireApi>)> {
    let raw = std::fs::read_to_string(wire_cache_path()).ok()?;
    let file: WireCacheFile = serde_json::from_str(&raw).ok()?;
    let apis = file
        .apis
        .into_iter()
        .filter_map(|(id, token)| token_to_wire(&token).map(|api| (id, api)))
        .collect::<HashMap<_, _>>();
    if apis.is_empty() {
        return None;
    }
    Some((file.fetched_at_ms, apis))
}

fn write_cache(apis: &HashMap<String, WireApi>) {
    let path = wire_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let file = WireCacheFile {
        fetched_at_ms: now_ms(),
        apis: apis
            .iter()
            .map(|(id, api)| (id.clone(), wire_to_token(*api).to_string()))
            .collect(),
    };
    if let Ok(raw) = serde_json::to_string(&file) {
        let _ = std::fs::write(path, raw);
    }
}

fn fetch_remote(client: &Client) -> Result<HashMap<String, WireApi>, String> {
    let client = client.clone();
    let body: Value = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(async move {
            let response = client
                .get(MODEL_METADATA_URL)
                .timeout(Duration::from_secs(20))
                .send()
                .await
                .map_err(|e| format!("拉取 models.dev 失败: {e}"))?;
            let status = response.status();
            if !status.is_success() {
                return Err(format!("models.dev HTTP {status}"));
            }
            response
                .json()
                .await
                .map_err(|e| format!("models.dev JSON 无效: {e}"))
        })?;
    let map = parse_opencode_go_wire_apis(&body);
    if map.is_empty() {
        return Err("models.dev 未包含可用的 opencode-go 协议映射".into());
    }
    write_cache(&map);
    Ok(map)
}

pub fn fetch_opencode_go_wire_apis(client: &Client) -> Result<HashMap<String, WireApi>, String> {
    if let Some((fetched_at_ms, apis)) = read_cache() {
        let fresh = now_ms().saturating_sub(fetched_at_ms) < CACHE_TTL.as_millis() as u64;
        if fresh {
            return Ok(apis);
        }
        return fetch_remote(client).or(Ok(apis));
    }
    fetch_remote(client)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_per_model_and_default_npm() {
        let body = json!({
            "opencode-go": {
                "npm": "@ai-sdk/openai-compatible",
                "models": {
                    "mimo-v2.6-pro": { "id": "mimo-v2.6-pro" },
                    "muse-spark-1.3-contributor": {
                        "provider": { "npm": "@ai-sdk/openai" }
                    },
                    "claude-haiku-5-5": {
                        "provider": { "npm": "@ai-sdk/anthropic" }
                    }
                }
            }
        });
        let map = parse_opencode_go_wire_apis(&body);
        assert_eq!(map.get("mimo-v2.6-pro"), Some(&WireApi::OpenAiCompletions));
        assert_eq!(
            map.get("muse-spark-1.3-contributor"),
            Some(&WireApi::OpenAiResponses)
        );
        assert_eq!(
            map.get("claude-haiku-5-5"),
            Some(&WireApi::AnthropicMessages)
        );
    }
}
