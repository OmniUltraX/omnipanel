use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, map_sqlite};

/// 单条向量分块记录。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunkRecord {
    pub id: String,
    pub entry_id: String,
    #[specta(type = f64)]
    pub chunk_index: i64,
    pub content: String,
    pub embedding: Vec<f32>,
    #[specta(type = f64)]
    pub created_at: i64,
}

/// 条目向量化状态摘要。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeVectorStatus {
    pub entry_id: String,
    #[specta(type = f64)]
    pub chunk_count: i64,
    #[specta(type = f64)]
    pub embedded_at: i64,
}

/// 文本块预览（不含 embedding，供 UI 展示）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunkPreview {
    pub id: String,
    pub entry_id: String,
    #[specta(type = f64)]
    pub chunk_index: i64,
    pub content: String,
    #[specta(type = f64)]
    pub created_at: i64,
}

/// 分页查询文本块结果。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChunkListResult {
    pub chunks: Vec<KnowledgeChunkPreview>,
    #[specta(type = f64)]
    pub total: i64,
    #[specta(type = f64)]
    pub offset: i64,
    #[specta(type = f64)]
    pub limit: i64,
}

/// 语义检索命中（供后续 RAG 使用）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeVectorHit {
    pub entry_id: String,
    pub chunk_index: i64,
    pub content: String,
    pub score: f64,
}

/// 单文档召回测试结果（含文本块 ID 与匹配度）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeRecallHit {
    pub id: String,
    pub entry_id: String,
    #[specta(type = f64)]
    pub chunk_index: i64,
    pub content: String,
    pub score: f64,
}

/// 按字符数分块，带重叠区。
pub fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<String> {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    let chunk_size = chunk_size.max(1);
    let overlap = overlap.min(chunk_size.saturating_sub(1));
    let step = chunk_size - overlap;

    let chars: Vec<char> = trimmed.chars().collect();
    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < chars.len() {
        let end = (start + chunk_size).min(chars.len());
        chunks.push(chars[start..end].iter().collect());
        if end >= chars.len() {
            break;
        }
        start += step;
    }
    chunks
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f64 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f64;
    let mut norm_a = 0.0f64;
    let mut norm_b = 0.0f64;
    for (left, right) in a.iter().zip(b.iter()) {
        let x = *left as f64;
        let y = *right as f64;
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    if norm_a <= 0.0 || norm_b <= 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

impl Storage {
    /// 替换某条目的全部分块向量。
    pub fn replace_knowledge_chunks(
        &self,
        entry_id: &str,
        chunks: &[KnowledgeChunkRecord],
    ) -> OmniResult<()> {
        let conn = self.conn();
        let tx = conn.unchecked_transaction().map_err(map_sqlite)?;
        tx.execute(
            "DELETE FROM knowledge_chunks WHERE entry_id = ?1",
            [entry_id],
        )
        .map_err(map_sqlite)?;
        for chunk in chunks {
            let embedding_json = serde_json::to_string(&chunk.embedding).map_err(|e| {
                OmniError::new(ErrorCode::InvalidInput, "embedding 序列化失败")
                    .with_cause(e.to_string())
            })?;
            tx.execute(
                "INSERT INTO knowledge_chunks (id, entry_id, chunk_index, content, embedding, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    chunk.id,
                    chunk.entry_id,
                    chunk.chunk_index,
                    chunk.content,
                    embedding_json,
                    chunk.created_at,
                ],
            )
            .map_err(map_sqlite)?;
        }
        tx.commit().map_err(map_sqlite)?;
        Ok(())
    }

    /// 查询条目向量化状态；无分块时返回 None。
    pub fn knowledge_vector_status(&self, entry_id: &str) -> OmniResult<Option<KnowledgeVectorStatus>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT COUNT(*), MAX(created_at) FROM knowledge_chunks WHERE entry_id = ?1",
            )
            .map_err(map_sqlite)?;
        let (count, embedded_at): (i64, Option<i64>) = stmt
            .query_row([entry_id], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(map_sqlite)?;
        if count <= 0 {
            return Ok(None);
        }
        Ok(Some(KnowledgeVectorStatus {
            entry_id: entry_id.to_string(),
            chunk_count: count,
            embedded_at: embedded_at.unwrap_or(0),
        }))
    }

    /// 分页列出条目的文本块（按 chunk_index 排序，不含向量）。
    pub fn list_knowledge_chunks_page(
        &self,
        entry_id: &str,
        offset: i64,
        limit: i64,
    ) -> OmniResult<KnowledgeChunkListResult> {
        let conn = self.conn();
        let limit = limit.clamp(1, 100);
        let offset = offset.max(0);

        let total: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM knowledge_chunks WHERE entry_id = ?1",
                [entry_id],
                |row| row.get(0),
            )
            .map_err(map_sqlite)?;

        let mut stmt = conn
            .prepare(
                "SELECT id, entry_id, chunk_index, content, created_at
                 FROM knowledge_chunks
                 WHERE entry_id = ?1
                 ORDER BY chunk_index ASC
                 LIMIT ?2 OFFSET ?3",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map(rusqlite::params![entry_id, limit, offset], |row| {
                Ok(KnowledgeChunkPreview {
                    id: row.get(0)?,
                    entry_id: row.get(1)?,
                    chunk_index: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(map_sqlite)?;
        let chunks = rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)?;

        Ok(KnowledgeChunkListResult {
            chunks,
            total,
            offset,
            limit,
        })
    }

    /// 删除指定文本块并重新编号剩余块的 chunk_index。
    pub fn delete_knowledge_chunks(
        &self,
        entry_id: &str,
        chunk_ids: &[String],
    ) -> OmniResult<(i64, i64)> {
        if chunk_ids.is_empty() {
            let remaining = self
                .knowledge_vector_status(entry_id)?
                .map(|s| s.chunk_count)
                .unwrap_or(0);
            return Ok((0, remaining));
        }

        let conn = self.conn();
        let tx = conn.unchecked_transaction().map_err(map_sqlite)?;
        let mut deleted = 0i64;
        for chunk_id in chunk_ids {
            deleted += tx
                .execute(
                    "DELETE FROM knowledge_chunks WHERE entry_id = ?1 AND id = ?2",
                    rusqlite::params![entry_id, chunk_id],
                )
                .map_err(map_sqlite)? as i64;
        }

        let mut stmt = tx
            .prepare(
                "SELECT id FROM knowledge_chunks WHERE entry_id = ?1 ORDER BY chunk_index ASC",
            )
            .map_err(map_sqlite)?;
        let remaining_ids: Vec<String> = stmt
            .query_map([entry_id], |row| row.get(0))
            .map_err(map_sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_sqlite)?;
        drop(stmt);

        for (index, chunk_id) in remaining_ids.iter().enumerate() {
            tx.execute(
                "UPDATE knowledge_chunks SET chunk_index = ?1 WHERE id = ?2",
                rusqlite::params![index as i64, chunk_id],
            )
            .map_err(map_sqlite)?;
        }

        tx.commit().map_err(map_sqlite)?;
        Ok((deleted, remaining_ids.len() as i64))
    }

    /// 列出条目的全部分块文本（按 chunk_index 排序，不含向量）。
    pub fn list_knowledge_chunks(&self, entry_id: &str) -> OmniResult<Vec<KnowledgeChunkPreview>> {
        Ok(self
            .list_knowledge_chunks_page(entry_id, 0, i64::MAX / 4)?
            .chunks)
    }

    /// 向量相似度检索（在当前库内全量扫描，适合中小规模知识库）。
    pub fn search_knowledge_vectors(
        &self,
        query_embedding: &[f32],
        top_n: usize,
    ) -> OmniResult<Vec<KnowledgeVectorHit>> {
        if query_embedding.is_empty() || top_n == 0 {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT entry_id, chunk_index, content, embedding FROM knowledge_chunks")
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(map_sqlite)?;

        let mut hits = Vec::new();
        for row in rows {
            let (entry_id, chunk_index, content, embedding_json) = row.map_err(map_sqlite)?;
            let embedding: Vec<f32> = serde_json::from_str(&embedding_json).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "embedding 反序列化失败")
                    .with_cause(e.to_string())
            })?;
            let score = cosine_similarity(query_embedding, &embedding);
            hits.push(KnowledgeVectorHit {
                entry_id,
                chunk_index,
                content,
                score,
            });
        }
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        hits.truncate(top_n);
        Ok(hits)
    }

    /// 对单篇文档的全部文本块计算与 query 向量的相似度（按分数降序）。
    pub fn recall_knowledge_entry_vectors(
        &self,
        entry_id: &str,
        query_embedding: &[f32],
    ) -> OmniResult<Vec<KnowledgeRecallHit>> {
        if query_embedding.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn();
        let mut stmt = conn
            .prepare(
                "SELECT id, entry_id, chunk_index, content, embedding
                 FROM knowledge_chunks
                 WHERE entry_id = ?1",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([entry_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(map_sqlite)?;

        let mut hits = Vec::new();
        for row in rows {
            let (id, entry_id, chunk_index, content, embedding_json) = row.map_err(map_sqlite)?;
            let embedding: Vec<f32> = serde_json::from_str(&embedding_json).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "embedding 反序列化失败")
                    .with_cause(e.to_string())
            })?;
            let score = cosine_similarity(query_embedding, &embedding);
            hits.push(KnowledgeRecallHit {
                id,
                entry_id,
                chunk_index,
                content,
                score,
            });
        }
        hits.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunk_text_respects_overlap() {
        let text = "abcdefghijklmnopqrstuvwxyz";
        let chunks = chunk_text(text, 10, 2);
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0], "abcdefghij");
    }
}
