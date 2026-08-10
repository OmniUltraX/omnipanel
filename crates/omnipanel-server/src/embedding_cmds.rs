//! Embedding 配置同步与向量请求（供 Skill 向量化使用）。

use omnipanel_error::OmniError;
use omnipanel_store::{load_embedding_provider, save_embedding_provider, EmbeddingProviderConfig};
use reqwest::Client;
use serde::{Deserialize, Serialize};

pub async fn embedding_provider_sync(provider: EmbeddingProviderConfig) -> Result<(), OmniError> {
    save_embedding_provider(&provider).map_err(|e| OmniError::invalid_input(e.user_message()))
}

pub async fn embedding_provider_get() -> Result<Option<EmbeddingProviderConfig>, OmniError> {
    load_embedding_provider().map_err(|e| OmniError::invalid_input(e.user_message()))
}

fn is_ollama_embedding_provider(provider: &EmbeddingProviderConfig) -> bool {
    provider.provider_id == "ollama" || provider.api_standard.eq_ignore_ascii_case("ollama")
}

fn embedding_http_client() -> Result<Client, String> {
    Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))
}

fn normalize_localhost_host(url: &str) -> String {
    url.replace("://localhost", "://127.0.0.1")
}

fn ollama_root_url(base_url: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    let without_v1 = trimmed.strip_suffix("/v1").unwrap_or(trimmed);
    normalize_localhost_host(without_v1)
}

async fn fetch_openai_embeddings(
    client: &Client,
    base_url: &str,
    api_key: &str,
    model: &str,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let url = format!("{}/embeddings", base_url.trim_end_matches('/'));
    #[derive(Serialize)]
    struct Body<'a> {
        model: &'a str,
        input: &'a [String],
        encoding_format: &'static str,
    }
    #[derive(Deserialize)]
    struct EmbeddingItem {
        embedding: Vec<f32>,
        index: usize,
    }
    #[derive(Deserialize)]
    struct Response {
        data: Vec<EmbeddingItem>,
    }

    let mut req = client.post(&url).json(&Body {
        model,
        input: inputs,
        encoding_format: "float",
    });
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 embedding 接口失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("embedding 接口返回 {status}: {body}"));
    }
    let parsed: Response = resp
        .json()
        .await
        .map_err(|e| format!("解析 embedding 响应失败: {e}"))?;
    let mut ordered = vec![Vec::new(); inputs.len()];
    for item in parsed.data {
        if item.index < ordered.len() {
            ordered[item.index] = item.embedding;
        }
    }
    if ordered.iter().any(|item| item.is_empty()) {
        return Err("embedding 响应缺少部分向量".to_string());
    }
    Ok(ordered)
}

async fn fetch_ollama_embeddings(
    client: &Client,
    base_url: &str,
    model: &str,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    let root = ollama_root_url(base_url);
    let url = format!("{root}/api/embed");
    #[derive(Serialize)]
    struct Body<'a> {
        model: &'a str,
        input: &'a [String],
    }
    #[derive(Deserialize)]
    struct Response {
        embeddings: Vec<Vec<f32>>,
    }

    let resp = client
        .post(&url)
        .json(&Body { model, input: inputs })
        .send()
        .await
        .map_err(|e| format!("请求 Ollama embedding 接口失败 ({url}): {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if status.as_u16() == 404 || status.as_u16() == 405 {
            let openai_base = format!("{root}/v1");
            return fetch_openai_embeddings(client, &openai_base, "", model, inputs).await;
        }
        return Err(format!("Ollama embedding 接口返回 {status}: {body}"));
    }
    let parsed: Response = resp
        .json()
        .await
        .map_err(|e| format!("解析 Ollama embedding 响应失败: {e}"))?;
    if parsed.embeddings.len() != inputs.len() {
        return Err(format!(
            "Ollama embedding 数量不匹配：期望 {}，实际 {}",
            inputs.len(),
            parsed.embeddings.len()
        ));
    }
    if parsed.embeddings.iter().any(|item| item.is_empty()) {
        return Err("Ollama embedding 响应包含空向量".to_string());
    }
    Ok(parsed.embeddings)
}

pub async fn fetch_provider_embeddings(
    provider: &EmbeddingProviderConfig,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let client = embedding_http_client()?;
    if is_ollama_embedding_provider(provider) {
        fetch_ollama_embeddings(&client, &provider.base_url, &provider.model_name, inputs).await
    } else {
        fetch_openai_embeddings(
            &client,
            &provider.base_url,
            &provider.api_key,
            &provider.model_name,
            inputs,
        )
        .await
    }
}
