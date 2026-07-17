//! Qdrant 向量库驱动：HTTP REST（默认 6333），API Key 走 `password` 字段。

use std::collections::BTreeSet;
use std::time::Duration;

use async_trait::async_trait;
use omnipanel_error::{OmniError, OmniResult};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{DbDriver, DbParams, QueryResult, is_query};

const DEFAULT_QDRANT_PORT: u16 = 6333;
const DEFAULT_SAMPLE_LIMIT: i64 = 200;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);

pub struct QdrantDriver {
    client: reqwest::Client,
    base_url: String,
}

#[derive(Debug, Deserialize)]
struct QdrantVersionResponse {
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    title: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CollectionsResponse {
    result: Option<CollectionsResult>,
}

#[derive(Debug, Deserialize)]
struct CollectionsResult {
    #[serde(default)]
    collections: Vec<CollectionName>,
}

#[derive(Debug, Deserialize)]
struct CollectionName {
    name: String,
}

#[derive(Debug, Deserialize)]
struct CollectionInfoResponse {
    result: Option<CollectionInfo>,
}

#[derive(Debug, Deserialize)]
struct CollectionInfo {
    #[serde(default)]
    points_count: Option<u64>,
    #[serde(default)]
    indexed_vectors_count: Option<u64>,
    config: Option<CollectionConfig>,
}

#[derive(Debug, Deserialize)]
struct CollectionConfig {
    params: Option<CollectionParams>,
}

#[derive(Debug, Deserialize)]
struct CollectionParams {
    vectors: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ScrollResponse {
    result: Option<ScrollResult>,
}

#[derive(Debug, Deserialize)]
struct ScrollResult {
    #[serde(default)]
    points: Vec<ScrollPoint>,
}

#[derive(Debug, Deserialize)]
struct ScrollPoint {
    id: Value,
    #[serde(default)]
    payload: Option<Map<String, Value>>,
    #[serde(default)]
    vector: Option<Value>,
}

/// Collection 摘要（侧栏 / 概览用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QdrantCollectionInfo {
    pub name: String,
    pub points_count: u64,
    pub vector_size: u64,
}

impl QdrantDriver {
    pub async fn connect(params: &DbParams) -> OmniResult<Self> {
        let driver = Self::from_params(params)?;
        // 测连：拉版本
        let _ = driver.version().await?;
        Ok(driver)
    }

    fn from_params(params: &DbParams) -> OmniResult<Self> {
        let host = params.host.trim();
        if host.is_empty() {
            return Err(OmniError::invalid_input("未指定 Qdrant 主机"));
        }
        let port = if params.port == 0 {
            DEFAULT_QDRANT_PORT
        } else {
            params.port
        };
        let scheme = if params.ssl { "https" } else { "http" };
        let base_url = format!("{scheme}://{host}:{port}");

        let mut headers = HeaderMap::new();
        let api_key = params.password.trim();
        if !api_key.is_empty() {
            let name = HeaderName::from_static("api-key");
            let value = HeaderValue::from_str(api_key).map_err(|e| {
                OmniError::invalid_input("API Key 含非法字符").with_cause(e.to_string())
            })?;
            headers.insert(name, value);
        }

        let client = reqwest::Client::builder()
            .default_headers(headers)
            .timeout(REQUEST_TIMEOUT)
            .user_agent("OmniPanel/1.0 (qdrant)")
            .build()
            .map_err(|e| {
                OmniError::connection("创建 Qdrant HTTP 客户端失败").with_cause(e.to_string())
            })?;

        Ok(Self { client, base_url })
    }

    async fn get_json<T: for<'de> Deserialize<'de>>(&self, path: &str) -> OmniResult<T> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self.client.get(&url).send().await.map_err(map_reqwest)?;
        let status = resp.status();
        let body = resp.text().await.map_err(map_reqwest)?;
        if !status.is_success() {
            return Err(OmniError::connection(format!(
                "Qdrant 请求失败 HTTP {}",
                status.as_u16()
            ))
            .with_cause(body.chars().take(300).collect::<String>()));
        }
        serde_json::from_str(&body).map_err(|e| {
            OmniError::database("解析 Qdrant 响应失败").with_cause(e.to_string())
        })
    }

    async fn post_json<T: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &Value,
    ) -> OmniResult<T> {
        let url = format!("{}{}", self.base_url, path);
        let resp = self
            .client
            .post(&url)
            .json(body)
            .send()
            .await
            .map_err(map_reqwest)?;
        let status = resp.status();
        let text = resp.text().await.map_err(map_reqwest)?;
        if !status.is_success() {
            return Err(OmniError::connection(format!(
                "Qdrant 请求失败 HTTP {}",
                status.as_u16()
            ))
            .with_cause(text.chars().take(300).collect::<String>()));
        }
        serde_json::from_str(&text).map_err(|e| {
            OmniError::database("解析 Qdrant 响应失败").with_cause(e.to_string())
        })
    }

    pub async fn list_collection_infos(&self) -> OmniResult<Vec<QdrantCollectionInfo>> {
        let names = self.list_tables().await?;
        let mut out = Vec::with_capacity(names.len());
        for name in names {
            let info = self
                .get_json::<CollectionInfoResponse>(&format!("/collections/{name}"))
                .await
                .ok()
                .and_then(|r| r.result);
            let points_count = info
                .as_ref()
                .and_then(|i| i.points_count.or(i.indexed_vectors_count))
                .unwrap_or(0);
            let vector_size = info
                .as_ref()
                .and_then(|i| i.config.as_ref())
                .and_then(|c| c.params.as_ref())
                .and_then(|p| p.vectors.as_ref())
                .map(vector_size_from_config)
                .unwrap_or(0);
            out.push(QdrantCollectionInfo {
                name,
                points_count,
                vector_size,
            });
        }
        Ok(out)
    }

    pub async fn delete_points(&self, collection: &str, point_ids: &[Value]) -> OmniResult<u64> {
        if collection.trim().is_empty() {
            return Err(OmniError::invalid_input("未指定 collection"));
        }
        if point_ids.is_empty() {
            return Ok(0);
        }
        let body = serde_json::json!({ "points": point_ids });
        let _: Value = self
            .post_json(
                &format!("/collections/{}/points/delete?wait=true", collection.trim()),
                &body,
            )
            .await?;
        Ok(point_ids.len() as u64)
    }
}

#[async_trait]
impl DbDriver for QdrantDriver {
    async fn version(&self) -> OmniResult<String> {
        let info = self.get_json::<QdrantVersionResponse>("/").await?;
        Ok(info
            .version
            .filter(|v| !v.is_empty())
            .or(info.title)
            .unwrap_or_else(|| "Qdrant".to_string()))
    }

    async fn list_tables(&self) -> OmniResult<Vec<String>> {
        let resp = self.get_json::<CollectionsResponse>("/collections").await?;
        let mut names: Vec<String> = resp
            .result
            .map(|r| r.collections.into_iter().map(|c| c.name).collect())
            .unwrap_or_default();
        names.sort();
        Ok(names)
    }

    async fn execute(&self, sql: &str) -> OmniResult<QueryResult> {
        let trimmed = sql.trim();
        if trimmed.is_empty() {
            return Err(OmniError::invalid_input("语句不能为空"));
        }
        if is_query(trimmed) {
            return Err(OmniError::invalid_input(
                "Qdrant 暂不支持 SQL 查询，请使用 Collection 预览浏览 Points",
            ));
        }
        Err(OmniError::invalid_input(
            "Qdrant 暂不支持通过 SQL 执行写入，请使用专用 API",
        ))
    }

    async fn preview(
        &self,
        table: &str,
        limit: i64,
        offset: i64,
        _order_by: Option<&str>,
        where_clause: Option<&str>,
    ) -> OmniResult<QueryResult> {
        if where_clause.is_some_and(|clause| !clause.trim().is_empty()) {
            return Err(OmniError::invalid_input(
                "Qdrant Collection 预览暂不支持 WHERE 过滤",
            ));
        }
        let collection = table.trim();
        if collection.is_empty() {
            return Err(OmniError::invalid_input("未指定 collection"));
        }

        let limit = limit.clamp(1, DEFAULT_SAMPLE_LIMIT) as u64;
        let offset = offset.max(0) as u64;
        // Qdrant scroll 用游标而非 skip；MVP 用放大 limit 再截断近似 offset（仅适合小偏移）
        let fetch = (limit + offset).min(DEFAULT_SAMPLE_LIMIT as u64);
        let body = serde_json::json!({
            "limit": fetch,
            "with_payload": true,
            "with_vector": true,
        });
        let resp: ScrollResponse = self
            .post_json(&format!("/collections/{collection}/points/scroll"), &body)
            .await?;
        let points = resp.result.map(|r| r.points).unwrap_or_default();
        let sliced: Vec<_> = points
            .into_iter()
            .skip(offset as usize)
            .take(limit as usize)
            .collect();

        let columns = collect_point_columns(&sliced);
        let rows = sliced
            .into_iter()
            .map(|point| point_to_row(&point, &columns))
            .collect();

        Ok(QueryResult {
            columns,
            rows,
            rows_affected: 0,
        })
    }

    async fn count(&self, table: &str, where_clause: Option<&str>) -> OmniResult<i64> {
        if where_clause.is_some_and(|clause| !clause.trim().is_empty()) {
            return Err(OmniError::invalid_input(
                "Qdrant Collection 计数暂不支持 WHERE 过滤",
            ));
        }
        let collection = table.trim();
        if collection.is_empty() {
            return Err(OmniError::invalid_input("未指定 collection"));
        }
        let info = self
            .get_json::<CollectionInfoResponse>(&format!("/collections/{collection}"))
            .await?
            .result;
        Ok(info
            .and_then(|i| i.points_count.or(i.indexed_vectors_count))
            .unwrap_or(0) as i64)
    }
}

fn vector_size_from_config(vectors: &Value) -> u64 {
    // 单向量: { "size": 384, "distance": "Cosine" }
    if let Some(size) = vectors.get("size").and_then(|v| v.as_u64()) {
        return size;
    }
    // 命名向量: { "text": { "size": 384 }, ... } → 取第一个 size
    if let Some(obj) = vectors.as_object() {
        for value in obj.values() {
            if let Some(size) = value.get("size").and_then(|v| v.as_u64()) {
                return size;
            }
        }
    }
    0
}

fn vector_dim(vector: Option<&Value>) -> u64 {
    match vector {
        Some(Value::Array(arr)) => arr.len() as u64,
        Some(Value::Object(map)) => {
            // named vectors: pick first array length
            for value in map.values() {
                if let Value::Array(arr) = value {
                    return arr.len() as u64;
                }
            }
            0
        }
        _ => 0,
    }
}

fn collect_point_columns(points: &[ScrollPoint]) -> Vec<String> {
    let mut columns = BTreeSet::new();
    columns.insert("id".to_string());
    columns.insert("vector_dim".to_string());
    for point in points {
        if let Some(payload) = &point.payload {
            for key in payload.keys() {
                columns.insert(key.clone());
            }
        }
    }
    columns.into_iter().collect()
}

fn point_to_row(point: &ScrollPoint, columns: &[String]) -> Vec<Value> {
    columns
        .iter()
        .map(|column| match column.as_str() {
            "id" => point.id.clone(),
            "vector_dim" => Value::from(vector_dim(point.vector.as_ref())),
            other => point
                .payload
                .as_ref()
                .and_then(|p| p.get(other).cloned())
                .unwrap_or(Value::Null),
        })
        .collect()
}

fn map_reqwest(err: reqwest::Error) -> OmniError {
    OmniError::connection("Qdrant 网络请求失败").with_cause(err.to_string())
}

pub async fn qdrant_list_collection_infos(
    params: &DbParams,
) -> OmniResult<Vec<QdrantCollectionInfo>> {
    let driver = QdrantDriver::from_params(params)?;
    driver.list_collection_infos().await
}

pub async fn qdrant_delete_points(
    params: &DbParams,
    collection: &str,
    point_ids: &[Value],
) -> OmniResult<u64> {
    let driver = QdrantDriver::from_params(params)?;
    driver.delete_points(collection, point_ids).await
}
