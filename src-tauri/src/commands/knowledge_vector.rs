use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use omnipanel_store::{KnowledgeChunkRecord, KnowledgeVectorStatus, chunk_text};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tauri::State;

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

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_chunk_id(entry_id: &str, index: usize) -> String {
    format!("{entry_id}:chunk:{index}")
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

    let mut req = client.post(&url).json(&Body { model, input: inputs });
    if !api_key.trim().is_empty() {
        req = req.bearer_auth(api_key.trim());
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("请求 embedding 接口失败: {e}"))?;
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

/// 将知识条目分块并向量化存储。
#[tauri::command]
#[specta::specta]
pub async fn knowledge_vectorize(
    state: State<'_, AppState>,
    args: KnowledgeVectorizeArgs,
) -> Result<KnowledgeVectorizeResult, OmniError> {
    if args.provider.api_standard.to_lowercase() == "anthropic" {
        return Err(OmniError::invalid_input(
            "Anthropic 提供商暂不支持 embedding，请在设置中选用 OpenAI 兼容模型",
        ));
    }
    let chunk_size = args.chunk_size.clamp(100, 8000) as usize;
    let chunk_overlap = args.chunk_overlap.clamp(0, chunk_size as u32 - 1) as usize;

    let entry = {
        let storage = state.storage.lock().await;
        storage
            .get_knowledge(&args.entry_id)?
            .ok_or_else(|| OmniError::invalid_input("知识条目不存在"))?
    };

    if entry.node_type == "folder" {
        return Err(OmniError::invalid_input("文件夹不支持向量化，请选择文档"));
    }

    let source = format!("{}\n\n{}", entry.title.trim(), entry.content.trim());
    let pieces = chunk_text(&source, chunk_size, chunk_overlap);
    if pieces.is_empty() {
        return Err(OmniError::invalid_input("文档内容为空，无法向量化"));
    }

    let client = Client::new();
    let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(pieces.len());
    const BATCH: usize = 32;
    for batch in pieces.chunks(BATCH) {
        let batch_inputs: Vec<String> = batch.to_vec();
        let batch_vectors = fetch_openai_embeddings(
            &client,
            &args.provider.base_url,
            &args.provider.api_key,
            &args.provider.model_name,
            &batch_inputs,
        )
        .await
        .map_err(|e| {
            OmniError::connection(format!(
                "provider {} / {}: {e}",
                args.provider.provider_id, args.provider.model_name
            ))
        })?;
        embeddings.extend(batch_vectors);
    }

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
        let storage = state.storage.lock().await;
        storage.replace_knowledge_chunks(&args.entry_id, &records)?;
    }

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
