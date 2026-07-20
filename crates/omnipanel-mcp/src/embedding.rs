//! Embedding HTTP 客户端（供 Skill 向量化 / 混合召回使用）。
//! 与 `src-tauri/commands/knowledge_vector.rs` 行为对齐：Ollama 走 /api/embed，其余走 OpenAI 兼容。

use omnipanel_store::EmbeddingProviderConfig;
use reqwest::Client;

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
    #[derive(serde::Deserialize)]
    struct EmbeddingItem {
        index: usize,
        embedding: Vec<f32>,
    }
    #[derive(serde::Deserialize)]
    struct EmbeddingResponse {
        data: Vec<EmbeddingItem>,
    }

    let url = format!("{}/embeddings", base_url.trim_end_matches('/'));
    let mut req = client.post(&url).json(&serde_json::json!({
        "model": model,
        "input": inputs,
    }));
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 embedding 接口失败 ({url}): {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("embedding 接口返回 {status}: {body}"));
    }
    let parsed: EmbeddingResponse = resp
        .json()
        .await
        .map_err(|e| format!("解析 embedding 响应失败: {e}"))?;
    let mut ordered = vec![Vec::new(); inputs.len()];
    for item in parsed.data {
        if item.index < ordered.len() {
            ordered[item.index] = item.embedding;
        }
    }
    if ordered.iter().any(|v| v.is_empty()) {
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
    #[derive(serde::Deserialize)]
    struct OllamaEmbedResponse {
        embeddings: Vec<Vec<f32>>,
    }

    let root = ollama_root_url(base_url);
    let url = format!("{root}/api/embed");
    let resp = client
        .post(&url)
        .json(&serde_json::json!({
            "model": model,
            "input": inputs,
        }))
        .send()
        .await
        .map_err(|e| format!("请求 Ollama embedding 接口失败 ({url}): {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        // 兼容部分 OpenAI 兼容网关挂在 Ollama 上
        if status.as_u16() == 404 {
            let openai_base = format!("{root}/v1");
            return fetch_openai_embeddings(client, &openai_base, "", model, inputs).await;
        }
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("Ollama embedding 接口返回 {status}: {body}"));
    }
    let parsed: OllamaEmbedResponse = resp
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

/// 按提供商批量获取 embeddings。
pub async fn fetch_provider_embeddings(
    provider: &EmbeddingProviderConfig,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    if inputs.is_empty() {
        return Ok(Vec::new());
    }
    if provider.api_standard.eq_ignore_ascii_case("anthropic") {
        return Err("Anthropic 提供商暂不支持 embedding".to_string());
    }
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

/// 分块 + 嵌入（不持有 DB 锁）；调用方再 `replace_skill_chunks`。
pub async fn embed_skill_chunks(
    skill_id: &str,
    title: &str,
    description: &str,
    body: &str,
) -> Result<Vec<(String, String, Vec<f32>)>, String> {
    use omnipanel_store::{chunk_text, resolve_embedding_provider_for_backend};

    let source = format!("{}\n\n{}\n\n{}", title.trim(), description.trim(), body.trim());
    let pieces = chunk_text(&source, 800, 120);
    if pieces.is_empty() {
        return Err("Skill 内容为空，无法向量化".to_string());
    }
    let provider = resolve_embedding_provider_for_backend();
    let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(pieces.len());
    const BATCH: usize = 32;
    for batch in pieces.chunks(BATCH) {
        let batch_inputs: Vec<String> = batch.to_vec();
        let batch_vectors = fetch_provider_embeddings(&provider, &batch_inputs)
            .await
            .map_err(|e| {
                format!(
                    "provider {} / {}: {e}",
                    provider.provider_id, provider.model_name
                )
            })?;
        embeddings.extend(batch_vectors);
    }
    Ok(pieces
        .into_iter()
        .enumerate()
        .zip(embeddings.into_iter())
        .map(|((index, content), embedding)| {
            (format!("{skill_id}:chunk:{index}"), content, embedding)
        })
        .collect())
}

/// 将文本分块并写入 skill_chunks（失败返回 Err，调用方决定是否忽略）。
pub async fn vectorize_skill_text(
    storage: &std::sync::Arc<tokio::sync::Mutex<omnipanel_store::Storage>>,
    skill_id: &str,
    title: &str,
    description: &str,
    body: &str,
) -> Result<u32, String> {
    let chunks = embed_skill_chunks(skill_id, title, description, body).await?;
    let count = chunks.len() as u32;
    let guard = storage.lock().await;
    guard
        .replace_skill_chunks(skill_id, &chunks)
        .map_err(|e| e.to_string())?;
    Ok(count)
}
