//! HTTP 请求历史与集合持久化。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::storage::Storage;

/// 保存的 HTTP 请求。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SavedHttpRequest {
    pub id: String,
    pub name: String,
    pub method: String,
    pub url: String,
    pub headers: String,
    pub body: String,
    pub auth_type: String,
    pub auth_value: String,
    pub collection_id: Option<String>,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

/// HTTP 请求历史记录。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpHistoryEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    #[specta(type = f64)]
    pub status_code: Option<i64>,
    #[specta(type = f64)]
    pub response_time_ms: Option<i64>,
    #[specta(type = f64)]
    pub request_size: Option<i64>,
    #[specta(type = f64)]
    pub response_size: Option<i64>,
    #[specta(type = f64)]
    pub created_at: i64,
    pub request_id: Option<String>,
}

/// HTTP 集合。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpCollection {
    pub id: String,
    pub name: String,
    pub description: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

impl Storage {
    pub fn http_save_request(&self, req: &SavedHttpRequest) -> OmniResult<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO http_requests (id, name, method, url, headers, body, auth_type, auth_value, collection_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![req.id, req.name, req.method, req.url, req.headers, req.body, req.auth_type, req.auth_value, req.collection_id, req.created_at, req.updated_at],
        ).map_err(|e| OmniError::new(ErrorCode::Database, "保存 HTTP 请求失败").with_cause(e.to_string()))?;
        Ok(())
    }

    pub fn http_list_requests(
        &self,
        collection_id: Option<&str>,
    ) -> OmniResult<Vec<SavedHttpRequest>> {
        let conn = self.conn();
        let mut stmt = if collection_id.is_some() {
            conn.prepare("SELECT id, name, method, url, headers, body, auth_type, auth_value, collection_id, created_at, updated_at FROM http_requests WHERE collection_id = ?1 ORDER BY name")
        } else {
            conn.prepare("SELECT id, name, method, url, headers, body, auth_type, auth_value, collection_id, created_at, updated_at FROM http_requests ORDER BY name")
        }.map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        let rows = if let Some(cid) = collection_id {
            stmt.query_map(params![cid], map_request)
        } else {
            stmt.query_map([], map_request)
        }
        .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))
    }

    pub fn http_delete_request(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM http_requests WHERE id = ?1", params![id])
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        Ok(())
    }

    pub fn http_add_history(&self, entry: &HttpHistoryEntry) -> OmniResult<()> {
        self.conn().execute(
            "INSERT INTO http_history (id, method, url, status_code, response_time_ms, request_size, response_size, created_at, request_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![entry.id, entry.method, entry.url, entry.status_code, entry.response_time_ms, entry.request_size, entry.response_size, entry.created_at, entry.request_id],
        ).map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        Ok(())
    }

    pub fn http_list_history(&self, limit: i64) -> OmniResult<Vec<HttpHistoryEntry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, method, url, status_code, response_time_ms, request_size, response_size, created_at, request_id FROM http_history ORDER BY created_at DESC LIMIT ?1"
        ).map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(HttpHistoryEntry {
                    id: row.get(0)?,
                    method: row.get(1)?,
                    url: row.get(2)?,
                    status_code: row.get(3)?,
                    response_time_ms: row.get(4)?,
                    request_size: row.get(5)?,
                    response_size: row.get(6)?,
                    created_at: row.get(7)?,
                    request_id: row.get(8)?,
                })
            })
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))
    }

    pub fn http_clear_history(&self) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM http_history", [])
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        Ok(())
    }

    pub fn http_save_collection(&self, col: &HttpCollection) -> OmniResult<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO http_collections (id, name, description, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![col.id, col.name, col.description, col.created_at, col.updated_at],
        ).map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        Ok(())
    }

    pub fn http_list_collections(&self) -> OmniResult<Vec<HttpCollection>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, description, created_at, updated_at FROM http_collections ORDER BY name"
        ).map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(HttpCollection {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))
    }

    pub fn http_delete_collection(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM http_collections WHERE id = ?1", params![id])
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        Ok(())
    }
}

fn map_request(row: &rusqlite::Row) -> rusqlite::Result<SavedHttpRequest> {
    Ok(SavedHttpRequest {
        id: row.get(0)?,
        name: row.get(1)?,
        method: row.get(2)?,
        url: row.get(3)?,
        headers: row.get(4)?,
        body: row.get(5)?,
        auth_type: row.get(6)?,
        auth_value: row.get(7)?,
        collection_id: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}
