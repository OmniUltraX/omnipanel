use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use omnipanel_store::{
    KnowledgeChunkListResult, KnowledgeChunkRecord, KnowledgeRecallHit,
    KnowledgeVectorStatus, Storage, chunk_text,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::sync::Mutex;

use crate::state::AppState;

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingProviderConfig {
    pub provider_id: String,
    pub model_name: String,
    pub base_url: String,
    pub api_key: String,
    pub api_standard: String,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeVectorizeArgs {
    pub entry_id: String,
    pub provider: EmbeddingProviderConfig,
    pub chunk_size: u32,
    pub chunk_overlap: u32,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeVectorizeResult {
    pub entry_id: String,
    #[specta(type = f64)]
    pub chunk_count: u32,
    #[specta(type = f64)]
    pub embedded_at: i64,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDeleteChunksResult {
    pub entry_id: String,
    #[specta(type = f64)]
    pub deleted: i64,
    #[specta(type = f64)]
    pub remaining: i64,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_chunk_id(entry_id: &str, index: usize) -> String {
    format!("{entry_id}:chunk:{index}")
}

fn is_ollama_embedding_provider(provider: &EmbeddingProviderConfig) -> bool {
    provider.provider_id == "ollama" || provider.api_standard.eq_ignore_ascii_case("ollama")
}

/// Ollama / 本地 embedding 请求不走系统代理，避免 localhost 被代理拦截。
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
        // 旧版 Ollama 可能尚未提供 /api/embed，回退 OpenAI 兼容端点
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

pub(crate) async fn fetch_provider_embeddings(
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

#[cfg(test)]
mod embedding_tests {
    use super::{is_ollama_embedding_provider, ollama_root_url, EmbeddingProviderConfig};

    #[test]
    fn ollama_root_strips_v1_and_normalizes_localhost() {
        assert_eq!(
            ollama_root_url("http://localhost:11434/v1"),
            "http://127.0.0.1:11434"
        );
        assert_eq!(ollama_root_url("http://127.0.0.1:11434"), "http://127.0.0.1:11434");
    }

    #[test]
    fn detects_ollama_provider() {
        let provider = EmbeddingProviderConfig {
            provider_id: "ollama".into(),
            model_name: "nomic-embed-text".into(),
            base_url: "http://localhost:11434/v1".into(),
            api_key: String::new(),
            api_standard: "ollama".into(),
        };
        assert!(is_ollama_embedding_provider(&provider));
    }
}

/// 将知识条目分块并向量化存储（同步命令，供兼容调用）。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_vectorize(
    state: State<'_, AppState>,
    args: KnowledgeVectorizeArgs,
) -> Result<KnowledgeVectorizeResult, OmniError> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync> =
        Arc::new(|_msg, _index, _total, _row_done, _row_total| {});
    execute_knowledge_vectorize(state.storage.clone(), args, cancel, progress)
        .await
        .map_err(OmniError::connection)
}

/// 后台任务执行：分块、嵌入、持久化；通过 progress 回调更新任务进度。
pub async fn execute_knowledge_vectorize(
    storage: Arc<Mutex<Storage>>,
    args: KnowledgeVectorizeArgs,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<KnowledgeVectorizeResult, String> {
    if args.provider.api_standard.to_lowercase() == "anthropic" {
        return Err(
            "Anthropic 提供商暂不支持 embedding，请在设置中选用 OpenAI 兼容模型".to_string(),
        );
    }
    let chunk_size = args.chunk_size.clamp(100, 8000) as usize;
    let chunk_overlap = args.chunk_overlap.clamp(0, chunk_size as u32 - 1) as usize;

    let entry = {
        let storage_guard = storage.lock().await;
        storage_guard
            .get_knowledge(&args.entry_id)
            .map_err(|e| e.user_message())?
            .ok_or_else(|| "知识条目不存在".to_string())?
    };

    if entry.node_type == "folder" {
        return Err("文件夹不支持向量化，请选择文档".to_string());
    }

    let source = format!("{}\n\n{}", entry.title.trim(), entry.content.trim());
    let entry_title = entry.title.clone();
    let pieces = chunk_text(&source, chunk_size, chunk_overlap);
    if pieces.is_empty() {
        return Err("文档内容为空，无法向量化".to_string());
    }

    let chunk_total = pieces.len() as u32;
    progress(
        format!("正在分块：{entry_title}（{chunk_total} 段）"),
        0,
        1,
        Some(0),
        Some(chunk_total),
    );

    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }

    let client = embedding_http_client().map_err(|e| e)?;
    let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(pieces.len());
    const BATCH: usize = 32;
    let batch_total = ((pieces.len() + BATCH - 1) / BATCH) as u32;
    for (batch_idx, batch) in pieces.chunks(BATCH).enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let batch_index = (batch_idx + 1) as u32;
        progress(
            format!(
                "正在嵌入 ({batch_index}/{batch_total})：{entry_title}"
            ),
            batch_index,
            batch_total,
            Some(embeddings.len() as u32),
            Some(chunk_total),
        );
        let batch_inputs: Vec<String> = batch.to_vec();
        let batch_vectors = if is_ollama_embedding_provider(&args.provider) {
            fetch_ollama_embeddings(
                &client,
                &args.provider.base_url,
                &args.provider.model_name,
                &batch_inputs,
            )
            .await
        } else {
            fetch_openai_embeddings(
                &client,
                &args.provider.base_url,
                &args.provider.api_key,
                &args.provider.model_name,
                &batch_inputs,
            )
            .await
        }
        .map_err(|e| {
            format!(
                "provider {} / {}: {e}",
                args.provider.provider_id, args.provider.model_name
            )
        })?;
        embeddings.extend(batch_vectors);
        progress(
            format!(
                "正在嵌入 ({batch_index}/{batch_total})：{entry_title}"
            ),
            batch_index,
            batch_total,
            Some(embeddings.len() as u32),
            Some(chunk_total),
        );
    }

    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }

    progress(
        format!("正在保存：{entry_title}"),
        batch_total,
        batch_total,
        Some(chunk_total),
        Some(chunk_total),
    );

    let embedded_at = now_millis();
    let records: Vec<KnowledgeChunkRecord> = pieces
        .into_iter()
        .enumerate()
        .zip(embeddings.into_iter())
        .map(|((index, content), embedding)| KnowledgeChunkRecord {
            id: new_chunk_id(&args.entry_id, index),
            entry_id: args.entry_id.clone(),
            chunk_index: index as i64,
            content,
            embedding,
            created_at: embedded_at,
        })
        .collect();

    let chunk_count = records.len() as u32;
    {
        let storage_guard = storage.lock().await;
        storage_guard
            .replace_knowledge_chunks(&args.entry_id, &records)
            .map_err(|e| e.user_message())?;
    }

    progress(
        format!("向量化完成：{entry_title}（{chunk_count} 段）"),
        batch_total,
        batch_total,
        Some(chunk_total),
        Some(chunk_total),
    );

    Ok(KnowledgeVectorizeResult {
        entry_id: args.entry_id,
        chunk_count,
        embedded_at,
    })
}

/// 查询条目的向量化状态。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_vector_status(
    state: State<'_, AppState>,
    entry_id: String,
) -> Result<Option<KnowledgeVectorStatus>, OmniError> {
    let storage = state.storage.lock().await;
    storage.knowledge_vector_status(&entry_id)
}

/// 分页列出条目的向量化文本块（不含 embedding）。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_list_chunks(
    state: State<'_, AppState>,
    entry_id: String,
    offset: Option<u32>,
    limit: Option<u32>,
) -> Result<KnowledgeChunkListResult, OmniError> {
    const DEFAULT_LIMIT: i64 = 12;
    let storage = state.storage.lock().await;
    storage.list_knowledge_chunks_page(
        &entry_id,
        offset.unwrap_or(0) as i64,
        limit.map(|n| n as i64).unwrap_or(DEFAULT_LIMIT),
    )
}

/// 删除条目的指定文本块。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_delete_chunks(
    state: State<'_, AppState>,
    entry_id: String,
    chunk_ids: Vec<String>,
) -> Result<KnowledgeDeleteChunksResult, OmniError> {
    let storage = state.storage.lock().await;
    let (deleted, remaining) = storage.delete_knowledge_chunks(&entry_id, &chunk_ids)?;
    Ok(KnowledgeDeleteChunksResult {
        entry_id,
        deleted,
        remaining,
    })
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRecallTestArgs {
    pub entry_id: String,
    pub query: String,
    pub provider: EmbeddingProviderConfig,
    /// 返回的最大文本块数；缺省为 5。
    pub top_k: Option<u32>,
    /// 余弦相似度下限（0–1）；缺省为 0.5。
    pub min_score: Option<f64>,
}

/// 对单篇文档执行向量召回测试，返回匹配文本块及相似度。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_recall_test(
    state: State<'_, AppState>,
    args: KnowledgeRecallTestArgs,
) -> Result<Vec<KnowledgeRecallHit>, OmniError> {
    if args.provider.api_standard.to_lowercase() == "anthropic" {
        return Err(OmniError::invalid_input(
            "Anthropic 提供商暂不支持 embedding，请在设置中选用 OpenAI 兼容模型",
        ));
    }
    let query = args.query.trim();
    if query.is_empty() {
        return Err(OmniError::invalid_input("请输入召回测试查询"));
    }

    {
        let storage = state.storage.lock().await;
        let status = storage.knowledge_vector_status(&args.entry_id)?;
        if status.map(|s| s.chunk_count).unwrap_or(0) <= 0 {
            return Err(OmniError::invalid_input("文档尚未向量化，请先执行解析"));
        }
    }

    let query_vectors = fetch_provider_embeddings(&args.provider, &[query.to_string()])
        .await
        .map_err(|e| {
            OmniError::connection(format!(
                "provider {} / {}: {e}",
                args.provider.provider_id, args.provider.model_name
            ))
        })?;
    let query_embedding = query_vectors
        .into_iter()
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| OmniError::connection("query embedding 为空"))?;

    let top_k = args.top_k.unwrap_or(5).clamp(1, 500) as usize;
    let min_score = args.min_score.unwrap_or(0.5).clamp(0.0, 1.0);

    let storage = state.storage.lock().await;
    storage.recall_knowledge_entry_vectors(
        &args.entry_id,
        &query_embedding,
        top_k,
        min_score,
    )
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeQueryHit {
    pub entry_id: String,
    pub title: String,
    #[specta(type = f64)]
    pub chunk_index: i64,
    pub content: String,
    pub score: f64,
}

#[derive(Debug, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeQueryDocumentArgs {
    pub provider: EmbeddingProviderConfig,
    pub key: String,
    pub top_n: Option<u32>,
}

#[tauri::command]
#[specta::specta]
pub async fn knowledge_query_document(
    state: State<'_, AppState>,
    args: KnowledgeQueryDocumentArgs,
) -> Result<Vec<KnowledgeQueryHit>, OmniError> {
    if args.provider.api_standard.to_lowercase() == "anthropic" {
        return Err(OmniError::invalid_input(
            "Anthropic 提供商暂不支持 embedding，请在设置中选用 OpenAI 兼容模型",
        ));
    }
    let key = args.key.trim();
    if key.is_empty() {
        return Err(OmniError::invalid_input("查询关键字不能为空"));
    }

    let query_vectors = fetch_provider_embeddings(&args.provider, &[key.to_string()])
        .await
        .map_err(|e| {
            OmniError::connection(format!(
                "provider {} / {}: {e}",
                args.provider.provider_id, args.provider.model_name
            ))
        })?;
    let query_embedding = query_vectors
        .into_iter()
        .next()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| OmniError::connection("query embedding 为空"))?;

    let top_n = args.top_n.unwrap_or(5).clamp(1, 50) as usize;

    let storage = state.storage.lock().await;
    let hits = storage.search_knowledge_vectors(&query_embedding, top_n)?;

    let mut results = Vec::with_capacity(hits.len());
    for hit in hits {
        let title = storage
            .get_knowledge(&hit.entry_id)?
            .map(|e| e.title)
            .unwrap_or_default();
        results.push(KnowledgeQueryHit {
            entry_id: hit.entry_id,
            title,
            chunk_index: hit.chunk_index,
            content: hit.content,
            score: hit.score,
        });
    }
    Ok(results)
}
