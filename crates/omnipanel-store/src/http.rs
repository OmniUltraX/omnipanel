//! HTTP 请求历史与集合持久化。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::storage::Storage;

/// HTTP 调试环境（基地址）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HttpEnvironment {
    pub id: String,
    pub name: String,
    pub base_url: String,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

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
    pub environment_id: Option<String>,
    pub path_params: String,
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
    /// 用户自定义显示名称；为空时在 UI 中回退为不含基地址的请求路径。
    pub label: String,
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
    pub environment_id: Option<String>,
    pub response_status_text: String,
    pub response_content_type: String,
    pub response_headers: String,
    pub response_body: String,
    /// 发送时生成的 curl 命令，便于历史回放。
    pub request_curl: String,
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
            "INSERT OR REPLACE INTO http_requests (id, name, method, url, headers, body, auth_type, auth_value, collection_id, environment_id, path_params, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![req.id, req.name, req.method, req.url, req.headers, req.body, req.auth_type, req.auth_value, req.collection_id, req.environment_id, req.path_params, req.created_at, req.updated_at],
        ).map_err(|e| OmniError::new(ErrorCode::Database, "保存 HTTP 请求失败").with_cause(e.to_string()))?;
        Ok(())
    }

    pub fn http_list_requests(
        &self,
        collection_id: Option<&str>,
    ) -> OmniResult<Vec<SavedHttpRequest>> {
        let conn = self.conn();
        let mut stmt = if collection_id.is_some() {
            conn.prepare("SELECT id, name, method, url, headers, body, auth_type, auth_value, collection_id, environment_id, path_params, created_at, updated_at FROM http_requests WHERE collection_id = ?1 ORDER BY name")
        } else {
            conn.prepare("SELECT id, name, method, url, headers, body, auth_type, auth_value, collection_id, environment_id, path_params, created_at, updated_at FROM http_requests ORDER BY name")
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
            "INSERT INTO http_history (id, label, method, url, status_code, response_time_ms, request_size, response_size, created_at, request_id, environment_id, response_status_text, response_content_type, response_headers, response_body, request_curl) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                entry.id,
                entry.label,
                entry.method,
                entry.url,
                entry.status_code,
                entry.response_time_ms,
                entry.request_size,
                entry.response_size,
                entry.created_at,
                entry.request_id,
                entry.environment_id,
                entry.response_status_text,
                entry.response_content_type,
                entry.response_headers,
                entry.response_body,
                entry.request_curl,
            ],
        ).map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        Ok(())
    }

    pub fn http_list_history(&self, limit: i64) -> OmniResult<Vec<HttpHistoryEntry>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, label, method, url, status_code, response_time_ms, request_size, response_size, created_at, request_id, environment_id, response_status_text, response_content_type, response_headers, response_body, request_curl FROM http_history ORDER BY created_at DESC LIMIT ?1"
        ).map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        let rows = stmt
            .query_map(params![limit], |row| {
                Ok(HttpHistoryEntry {
                    id: row.get(0)?,
                    label: row.get(1)?,
                    method: row.get(2)?,
                    url: row.get(3)?,
                    status_code: row.get(4)?,
                    response_time_ms: row.get(5)?,
                    request_size: row.get(6)?,
                    response_size: row.get(7)?,
                    created_at: row.get(8)?,
                    request_id: row.get(9)?,
                    environment_id: row.get(10)?,
                    response_status_text: row.get(11)?,
                    response_content_type: row.get(12)?,
                    response_headers: row.get(13)?,
                    response_body: row.get(14)?,
                    request_curl: row.get(15).unwrap_or_default(),
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

    pub fn http_delete_history(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM http_history WHERE id = ?1", params![id])
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        Ok(())
    }

    pub fn http_rename_history(&self, id: &str, label: &str) -> OmniResult<()> {
        let updated = self
            .conn()
            .execute(
                "UPDATE http_history SET label = ?2 WHERE id = ?1",
                params![id, label],
            )
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        if updated == 0 {
            return Err(OmniError::new(ErrorCode::Database, "HTTP 历史记录不存在"));
        }
        Ok(())
    }

    pub fn http_clear_history_for_request(&self, request_id: &str) -> OmniResult<()> {
        self.conn()
            .execute(
                "DELETE FROM http_history WHERE request_id = ?1",
                params![request_id],
            )
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

    pub fn http_save_environment(&self, env: &HttpEnvironment) -> OmniResult<()> {
        self.conn().execute(
            "INSERT OR REPLACE INTO http_environments (id, name, base_url, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![env.id, env.name, env.base_url, env.created_at, env.updated_at],
        ).map_err(|e| OmniError::new(ErrorCode::Database, "保存 HTTP 环境失败").with_cause(e.to_string()))?;
        Ok(())
    }

    pub fn http_list_environments(&self) -> OmniResult<Vec<HttpEnvironment>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT id, name, base_url, created_at, updated_at FROM http_environments ORDER BY name",
        ).map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(HttpEnvironment {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    base_url: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            })
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))
    }

    pub fn http_delete_environment(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM http_environments WHERE id = ?1", params![id])
            .map_err(|e| OmniError::new(ErrorCode::Database, e.to_string()))?;
        self.conn()
            .execute(
                "UPDATE http_requests SET environment_id = NULL WHERE environment_id = ?1",
                params![id],
            )
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
        environment_id: row.get(9)?,
        path_params: row.get(10).unwrap_or_else(|_| "[]".to_string()),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
    })
}
