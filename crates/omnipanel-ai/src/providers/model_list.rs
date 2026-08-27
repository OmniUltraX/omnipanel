//! 从 OpenAI / Anthropic 兼容接口拉取远端模型列表。
//!
//! 必须走 reqwest（原生 HTTP），不能走 WebView `fetch`：多数云厂商
//! `/models` 不返回 CORS 头，浏览器会直接变成 `TypeError: Failed to fetch`。

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// 接口 `/models` 返回的单条模型。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteModelInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
}

#[derive(Debug, Error)]
pub enum FetchModelsError {
    #[error("invalid_base_url")]
    InvalidBaseUrl,
    #[error("http_{status}")]
    Http { status: u16, body: String },
    #[error("{0}")]
    Network(String),
    #[error("parse: {0}")]
    Parse(String),
}

fn json_i64(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_u64().map(|n| n as i64))
        .or_else(|| value.as_f64().filter(|n| n.is_finite()).map(|n| n as i64))
}

fn parse_item(item: &Value) -> Option<RemoteModelInfo> {
    let obj = item.as_object()?;
    let id = obj
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| obj.get("name").and_then(Value::as_str))?
        .trim();
    if id.is_empty() {
        return None;
    }
    let owned_by = obj
        .get("owned_by")
        .or_else(|| obj.get("ownedBy"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    Some(RemoteModelInfo {
        id: id.to_string(),
        created: obj.get("created").and_then(json_i64),
        owned_by,
    })
}

fn collect_raw_items(value: &Value) -> Vec<&Value> {
    match value {
        Value::Array(arr) => arr.iter().collect(),
        Value::Object(obj) => {
            if let Some(Value::Array(arr)) = obj.get("data") {
                return arr.iter().collect();
            }
            if let Some(Value::Array(arr)) = obj.get("models") {
                return arr.iter().collect();
            }
            if let Some(nested) = obj.get("data") {
                return collect_raw_items(nested);
            }
            Vec::new()
        }
        _ => Vec::new(),
    }
}

/// 解析 OpenAI `{ data: [...] }` / `{ models: [...] }` / 顶层数组。
pub fn parse_models_payload(value: &Value) -> Vec<RemoteModelInfo> {
    let mut seen = std::collections::HashSet::new();
    let mut models = Vec::new();
    for item in collect_raw_items(value) {
        let Some(model) = parse_item(item) else {
            continue;
        };
        let key = model.id.to_lowercase();
        if !seen.insert(key) {
            continue;
        }
        models.push(model);
    }
    models.sort_by(|a, b| a.id.cmp(&b.id));
    models
}

fn truncate_body(body: &str) -> String {
    let trimmed = body.trim();
    const LIMIT: usize = 240;
    if trimmed.chars().count() <= LIMIT {
        return trimmed.to_string();
    }
    let mut out: String = trimmed.chars().take(LIMIT).collect();
    out.push('…');
    out
}

fn format_network_error(err: &reqwest::Error, url: &str) -> String {
    if err.is_connect() {
        format!("无法连接模型 API（{url}）：网络连接失败，请检查本机网络、代理与 Base URL")
    } else if err.is_timeout() {
        format!("无法连接模型 API（{url}）：请求超时")
    } else if err.is_request() {
        format!("无法连接模型 API（{url}）：请求发送失败，请检查代理与 API 地址")
    } else {
        format!("无法连接模型 API（{url}）：{err}")
    }
}

/// GET `{baseUrl}/models`，按 api_standard 选择鉴权头。
pub async fn fetch_provider_models(
    client: &Client,
    base_url: &str,
    api_key: &str,
    api_standard: Option<&str>,
) -> Result<Vec<RemoteModelInfo>, FetchModelsError> {
    let root = base_url.trim().trim_end_matches('/');
    if root.is_empty() {
        return Err(FetchModelsError::InvalidBaseUrl);
    }

    let url = format!("{root}/models");
    let mut req = client.get(&url).header("Accept", "application/json");
    let key = api_key.trim();
    let anthropic = api_standard.is_some_and(|s| s.eq_ignore_ascii_case("anthropic"));
    if anthropic {
        if !key.is_empty() {
            req = req
                .header("x-api-key", key)
                .header("anthropic-version", "2023-06-01");
        }
    } else if !key.is_empty() {
        req = req.header("Authorization", format!("Bearer {key}"));
    }

    let resp = req
        .send()
        .await
        .map_err(|e| FetchModelsError::Network(format_network_error(&e, &url)))?;
    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| FetchModelsError::Network(format_network_error(&e, &url)))?;
    if !status.is_success() {
        return Err(FetchModelsError::Http {
            status: status.as_u16(),
            body: truncate_body(&body),
        });
    }

    let payload: Value =
        serde_json::from_str(&body).map_err(|e| FetchModelsError::Parse(e.to_string()))?;
    Ok(parse_models_payload(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parse_openai_list() {
        let payload = json!({
            "object": "list",
            "data": [
                { "id": "sensenova-6.8-flash-lite", "created": 1710000000, "owned_by": "sensenova" },
                { "id": "deepseek-v4-flash", "owned_by": "deepseek" },
                { "id": "sensenova-6.8-flash-lite" },
            ]
        });
        let models = parse_models_payload(&payload);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "deepseek-v4-flash");
        assert_eq!(models[1].id, "sensenova-6.8-flash-lite");
        assert_eq!(models[1].created, Some(1_710_000_000));
        assert_eq!(models[1].owned_by.as_deref(), Some("sensenova"));
    }

    #[test]
    fn parse_models_key_and_name_fallback() {
        let payload = json!({
            "models": [
                { "name": "gpt-4o" },
                { "id": "  " },
            ]
        });
        let models = parse_models_payload(&payload);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gpt-4o");
    }

    #[test]
    fn parse_nested_data_object() {
        let payload = json!({
            "code": 0,
            "data": {
                "data": [
                    { "id": "glm-5.2" }
                ]
            }
        });
        let models = parse_models_payload(&payload);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "glm-5.2");
    }

    #[test]
    fn parse_top_level_array() {
        let payload = json!([{ "id": "a" }, { "id": "b" }]);
        let models = parse_models_payload(&payload);
        assert_eq!(
            models.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            ["a", "b"]
        );
    }
}
