//! 知识库向量化 / 召回 / 跨文档检索（Web 端，对齐桌面 `knowledge_vector.rs`）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use omnipanel_store::{
    chunk_text, EmbeddingProviderConfig, KnowledgeChunkRecord, KnowledgeRecallHit,
    KnowledgeVectorStatus, Storage,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::embedding_cmds::fetch_provider_embeddings;
use crate::state::ServerState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeVectorizeArgs {
    pub entry_id: String,
    pub provider: EmbeddingProviderConfig,
    pub chunk_size: u32,
    pub chunk_overlap: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeVectorizeResult {
    pub entry_id: String,
    pub chunk_count: u32,
    pub embedded_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRecallTestArgs {
    pub entry_id: String,
    pub query: String,
    pub provider: EmbeddingProviderConfig,
    pub top_k: Option<u32>,
    pub min_score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeQueryHit {
    pub entry_id: String,
    pub title: String,
    pub chunk_index: i64,
    pub content: String,
    pub score: f64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeQueryDocumentArgs {
    pub provider: EmbeddingProviderConfig,
    pub key: String,
    pub top_n: Option<u32>,
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

/// 将知识条目分块并向量化存储。
pub async fn knowledge_vectorize(
    state: &ServerState,
    args: KnowledgeVectorizeArgs,
) -> Result<KnowledgeVectorizeResult, OmniError> {
    let cancel = Arc::new(AtomicBool::new(false));
    let progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync> =
        Arc::new(|_msg, _i, _t, _rd, _rt| {});
    execute_knowledge_vectorize(state.storage.clone(), args, cancel, progress).await
}

/// 后台任务执行：分块、嵌入、持久化。
pub async fn execute_knowledge_vectorize(
    storage: Arc<Mutex<Storage>>,
    args: KnowledgeVectorizeArgs,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<KnowledgeVectorizeResult, OmniError> {
    if args.provider.api_standard.to_lowercase() == "anthropic" {
        return Err(OmniError::invalid_input(
            "Anthropic 提供商暂不支持 embedding，请在设置中选用 OpenAI 兼容模型",
        ));
    }
    let chunk_size = args.chunk_size.clamp(100, 8000) as usize;
    let chunk_overlap = args.chunk_overlap.clamp(0, chunk_size as u32 - 1) as usize;

    let entry = {
        let storage_guard = storage.lock().await;
        storage_guard
            .get_knowledge(&args.entry_id)?
            .ok_or_else(|| OmniError::invalid_input("知识条目不存在"))?
    };

    if entry.node_type == "folder" {
        return Err(OmniError::invalid_input("文件夹不支持向量化，请选择文档"));
    }

    let source = format!("{}\n\n{}", entry.title.trim(), entry.content.trim());
    let entry_title = entry.title.clone();
    let pieces = chunk_text(&source, chunk_size, chunk_overlap);
    if pieces.is_empty() {
        return Err(OmniError::invalid_input("文档内容为空，无法向量化"));
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
        return Err(OmniError::invalid_input("cancelled"));
    }

    let mut embeddings: Vec<Vec<f32>> = Vec::with_capacity(pieces.len());
    const BATCH: usize = 32;
    let batch_total = ((pieces.len() + BATCH - 1) / BATCH) as u32;
    for (batch_idx, batch) in pieces.chunks(BATCH).enumerate() {
        if cancel.load(Ordering::Relaxed) {
            return Err(OmniError::invalid_input("cancelled"));
        }
        let batch_index = (batch_idx + 1) as u32;
        progress(
            format!("正在嵌入 ({batch_index}/{batch_total})：{entry_title}"),
            batch_index,
            batch_total,
            Some(embeddings.len() as u32),
            Some(chunk_total),
        );
        let batch_inputs: Vec<String> = batch.to_vec();
        let batch_vectors = fetch_provider_embeddings(&args.provider, &batch_inputs)
            .await
            .map_err(|e| {
                OmniError::connection(format!(
                    "provider {} / {}: {e}",
                    args.provider.provider_id, args.provider.model_name
                ))
            })?;
        embeddings.extend(batch_vectors);
    }

    if cancel.load(Ordering::Relaxed) {
        return Err(OmniError::invalid_input("cancelled"));
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
        storage_guard.replace_knowledge_chunks(&args.entry_id, &records)?;
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
pub async fn knowledge_vector_status(
    state: &ServerState,
    entry_id: String,
) -> Result<Option<KnowledgeVectorStatus>, OmniError> {
    let storage = state.storage.lock().await;
    storage.knowledge_vector_status(&entry_id)
}

/// 对单篇文档执行向量召回测试。
pub async fn knowledge_recall_test(
    state: &ServerState,
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
    storage.recall_knowledge_entry_vectors(&args.entry_id, &query_embedding, top_k, min_score)
}

/// 跨文档向量检索（按关键字 embedding）。
pub async fn knowledge_query_document(
    state: &ServerState,
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
        let _ = storage.increment_usage(&hit.entry_id);
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
