//! SQL 编辑器执行记录。列表不带结果页；结果按需读取。

use crate::storage::{Storage, map_sqlite};
use omnipanel_error::OmniResult;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const AUTO_RESULT_BYTES: usize = 256 * 1024;
const PINNED_RESULT_BYTES: usize = 2 * 1024 * 1024;
const PREVIEW_ROWS: usize = 20;
const FILE_UNPINNED_CAP: i64 = 200;
const FILE_PINNED_CAP: i64 = 50;
const GLOBAL_CAP: i64 = 2000;

/// 追加一条语句执行。结果行由存储按体积截断。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecAppend {
    pub id: String,
    pub executed_at: i64,
    pub connection_id: String,
    pub connection_name: String,
    pub database_name: String,
    pub env_tag: String,
    pub sql_file_id: Option<String>,
    pub tab_id: String,
    pub sql: String,
    pub display_name: String,
    pub status: String,
    pub elapsed_ms: Option<i64>,
    pub rows_affected: i64,
    pub error: String,
    pub pinned: bool,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
}

/// 列表行，不含结果页。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecRecord {
    pub id: String,
    pub executed_at: i64,
    pub connection_id: String,
    pub connection_name: String,
    pub database_name: String,
    pub env_tag: String,
    pub sql_file_id: Option<String>,
    pub tab_id: String,
    pub sql: String,
    pub display_name: String,
    pub status: String,
    pub elapsed_ms: Option<i64>,
    pub rows_affected: i64,
    pub row_count: i64,
    pub error: String,
    pub pinned: bool,
    pub result_truncated: bool,
    pub has_result: bool,
}

/// 留下的第 0 页（或前 20 行）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SqlExecResultPage {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub rows_affected: i64,
    pub truncated: bool,
}

/// 列表过滤。组合条件取交集。
#[derive(Debug, Clone, Default, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase", default)]
pub struct SqlExecListFilter {
    pub connection_id: Option<String>,
    pub sql_file_id: Option<String>,
    pub tab_id: Option<String>,
    pub database_name: Option<String>,
    pub status: Option<String>,
    pub kind: Option<String>,
    pub keyword: Option<String>,
    pub table_name: Option<String>,
    pub from_ms: Option<i64>,
    pub to_ms: Option<i64>,
    pub limit: Option<u32>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPage {
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
    rows_affected: i64,
}

pub fn append_sql_execution(storage: &Storage, input: &SqlExecAppend) -> OmniResult<SqlExecRecord> {
    let status = normalize_status(&input.status);
    let normalized = normalize_sql(&input.sql);
    let (payload, truncated, stored_rows) = pack_result(input, status);
    let row_count = stored_rows as i64;
    let has_result = payload.is_some();
    storage
        .conn()
        .execute(
            "INSERT INTO sql_executions (
                id, executed_at, connection_id, connection_name, database_name, env_tag,
                sql_file_id, tab_id, sql, display_name, status, elapsed_ms, rows_affected,
                row_count, error, pinned, result_truncated, normalized_sql
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)",
            rusqlite::params![
                input.id,
                input.executed_at,
                input.connection_id,
                input.connection_name,
                input.database_name,
                input.env_tag,
                input.sql_file_id,
                input.tab_id,
                input.sql,
                input.display_name,
                status,
                input.elapsed_ms,
                input.rows_affected,
                row_count,
                input.error,
                if input.pinned { 1 } else { 0 },
                if truncated { 1 } else { 0 },
                normalized,
            ],
        )
        .map_err(map_sqlite)?;
    if let Some(json) = payload {
        let bytes = json.len() as i64;
        storage
            .conn()
            .execute(
                "INSERT INTO sql_execution_results (execution_id, payload_json, byte_size)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![input.id, json, bytes],
            )
            .map_err(map_sqlite)?;
    }
    prune_caps(storage, input.sql_file_id.as_deref(), &input.tab_id)?;
    Ok(SqlExecRecord {
        id: input.id.clone(),
        executed_at: input.executed_at,
        connection_id: input.connection_id.clone(),
        connection_name: input.connection_name.clone(),
        database_name: input.database_name.clone(),
        env_tag: input.env_tag.clone(),
        sql_file_id: input.sql_file_id.clone(),
        tab_id: input.tab_id.clone(),
        sql: input.sql.clone(),
        display_name: input.display_name.clone(),
        status: status.to_string(),
        elapsed_ms: input.elapsed_ms,
        rows_affected: input.rows_affected,
        row_count,
        error: input.error.clone(),
        pinned: input.pinned,
        result_truncated: truncated,
        has_result,
    })
}

pub fn list_sql_executions(
    storage: &Storage,
    filter: &SqlExecListFilter,
) -> OmniResult<Vec<SqlExecRecord>> {
    let limit = filter.limit.unwrap_or(200).clamp(1, 500) as i64;
    let mut sql = String::from(
        "SELECT id, executed_at, connection_id, connection_name, database_name, env_tag,
                sql_file_id, tab_id, sql, display_name, status, elapsed_ms, rows_affected,
                row_count, error, pinned, result_truncated,
                EXISTS(SELECT 1 FROM sql_execution_results r WHERE r.execution_id = e.id)
         FROM sql_executions e WHERE 1=1",
    );
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    push_eq(&mut sql, &mut params, "connection_id", filter.connection_id.as_deref());
    if let Some(file_id) = filter.sql_file_id.as_deref() {
        if let Some(tab_id) = filter.tab_id.as_deref().filter(|s| !s.is_empty()) {
            sql.push_str(" AND (sql_file_id = ? OR (sql_file_id IS NULL AND tab_id = ?))");
            params.push(Box::new(file_id.to_string()));
            params.push(Box::new(tab_id.to_string()));
        } else {
            sql.push_str(" AND sql_file_id = ?");
            params.push(Box::new(file_id.to_string()));
        }
    } else if let Some(tab_id) = filter.tab_id.as_deref().filter(|s| !s.is_empty()) {
        sql.push_str(" AND sql_file_id IS NULL AND tab_id = ?");
        params.push(Box::new(tab_id.to_string()));
    }
    push_eq(&mut sql, &mut params, "database_name", filter.database_name.as_deref());
    push_eq(&mut sql, &mut params, "status", filter.status.as_deref());
    if let Some(kind) = filter.kind.as_deref().filter(|s| !s.is_empty()) {
        match kind {
            "select" => sql.push_str(" AND (normalized_sql LIKE 'select %' OR normalized_sql LIKE 'with %' OR normalized_sql = 'select' OR normalized_sql = 'with')"),
            "update" => sql.push_str(" AND (normalized_sql LIKE 'update %' OR normalized_sql = 'update')"),
            "delete" => sql.push_str(" AND (normalized_sql LIKE 'delete %' OR normalized_sql = 'delete')"),
            "ddl" => sql.push_str(" AND (normalized_sql LIKE 'create %' OR normalized_sql LIKE 'alter %' OR normalized_sql LIKE 'drop %' OR normalized_sql LIKE 'truncate %')"),
            _ => {}
        }
    }
    if let Some(keyword) = filter.keyword.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        sql.push_str(" AND (sql LIKE ? OR display_name LIKE ?)");
        let like = format!("%{keyword}%");
        params.push(Box::new(like.clone()));
        params.push(Box::new(like));
    }
    if let Some(table) = filter.table_name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        sql.push_str(" AND normalized_sql LIKE ?");
        params.push(Box::new(format!("%{table}%")));
    }
    if let Some(from) = filter.from_ms {
        sql.push_str(" AND executed_at >= ?");
        params.push(Box::new(from));
    }
    if let Some(to) = filter.to_ms {
        sql.push_str(" AND executed_at <= ?");
        params.push(Box::new(to));
    }
    sql.push_str(" ORDER BY executed_at DESC, id DESC LIMIT ?");
    params.push(Box::new(limit));
    let mut stmt = storage.conn().prepare(&sql).map_err(map_sqlite)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt
        .query_map(param_refs.as_slice(), map_record)
        .map_err(map_sqlite)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(map_sqlite)
}

pub fn get_sql_execution_result(
    storage: &Storage,
    id: &str,
) -> OmniResult<Option<SqlExecResultPage>> {
    let mut stmt = storage
        .conn()
        .prepare(
            "SELECT r.payload_json, e.result_truncated
             FROM sql_execution_results r
             JOIN sql_executions e ON e.id = r.execution_id
             WHERE r.execution_id = ?1",
        )
        .map_err(map_sqlite)?;
    let mut rows = stmt.query([id]).map_err(map_sqlite)?;
    let Some(row) = rows.next().map_err(map_sqlite)? else {
        return Ok(None);
    };
    let json: String = row.get(0).map_err(map_sqlite)?;
    let truncated: i64 = row.get(1).map_err(map_sqlite)?;
    let page: StoredPage = serde_json::from_str(&json).unwrap_or(StoredPage {
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected: 0,
    });
    Ok(Some(SqlExecResultPage {
        columns: page.columns,
        rows: page.rows,
        rows_affected: page.rows_affected,
        truncated: truncated != 0,
    }))
}

pub fn set_sql_execution_pinned(storage: &Storage, id: &str, pinned: bool) -> OmniResult<()> {
    storage
        .conn()
        .execute(
            "UPDATE sql_executions SET pinned = ?1 WHERE id = ?2",
            rusqlite::params![if pinned { 1 } else { 0 }, id],
        )
        .map_err(map_sqlite)?;
    Ok(())
}

pub fn delete_sql_execution(storage: &Storage, id: &str) -> OmniResult<()> {
    storage
        .conn()
        .execute("DELETE FROM sql_executions WHERE id = ?1", [id])
        .map_err(map_sqlite)?;
    Ok(())
}

pub fn clear_sql_executions(storage: &Storage, connection_id: &str) -> OmniResult<u32> {
    let n = storage
        .conn()
        .execute(
            "DELETE FROM sql_executions WHERE connection_id = ?1",
            [connection_id],
        )
        .map_err(map_sqlite)?;
    Ok(n as u32)
}

/// 草稿保存成文件后，把还挂在 tab 上的记录改挂到文件。
pub fn rebind_sql_execution_file(
    storage: &Storage,
    tab_id: &str,
    sql_file_id: &str,
) -> OmniResult<u32> {
    let n = storage
        .conn()
        .execute(
            "UPDATE sql_executions SET sql_file_id = ?1
             WHERE tab_id = ?2 AND sql_file_id IS NULL",
            rusqlite::params![sql_file_id, tab_id],
        )
        .map_err(map_sqlite)?;
    Ok(n as u32)
}

fn pack_result(input: &SqlExecAppend, status: &str) -> (Option<String>, bool, usize) {
    if status != "ok" || (input.columns.is_empty() && input.rows.is_empty()) {
        return (None, false, 0);
    }
    let full = StoredPage {
        columns: input.columns.clone(),
        rows: input.rows.clone(),
        rows_affected: input.rows_affected,
    };
    let full_json = serde_json::to_string(&full).unwrap_or_default();
    let cap = if input.pinned {
        PINNED_RESULT_BYTES
    } else {
        AUTO_RESULT_BYTES
    };
    if full_json.len() <= cap {
        return (Some(full_json), false, input.rows.len());
    }
    let kept = input.rows.iter().take(PREVIEW_ROWS).cloned().collect::<Vec<_>>();
    let preview = StoredPage {
        columns: input.columns.clone(),
        rows: kept,
        rows_affected: input.rows_affected,
    };
    let json = serde_json::to_string(&preview).unwrap_or_default();
    let n = preview.rows.len();
    (Some(json), true, n)
}

fn prune_caps(storage: &Storage, sql_file_id: Option<&str>, tab_id: &str) -> OmniResult<()> {
    let (file_clause, file_param): (String, String) = if let Some(id) = sql_file_id.filter(|s| !s.is_empty()) {
        ("sql_file_id = ?1".to_string(), id.to_string())
    } else {
        ("sql_file_id IS NULL AND tab_id = ?1".to_string(), tab_id.to_string())
    };
    delete_overflow(
        storage,
        &format!("DELETE FROM sql_executions WHERE id IN (
            SELECT id FROM sql_executions WHERE {file_clause} AND pinned = 0
            ORDER BY executed_at DESC, id DESC LIMIT -1 OFFSET {FILE_UNPINNED_CAP}
        )"),
        &file_param,
    )?;
    delete_overflow(
        storage,
        &format!("DELETE FROM sql_executions WHERE id IN (
            SELECT id FROM sql_executions WHERE {file_clause} AND pinned = 1
            ORDER BY executed_at DESC, id DESC LIMIT -1 OFFSET {FILE_PINNED_CAP}
        )"),
        &file_param,
    )?;
    storage
        .conn()
        .execute(
            "DELETE FROM sql_executions WHERE id IN (
                SELECT id FROM sql_executions WHERE pinned = 0
                ORDER BY executed_at ASC, id ASC
                LIMIT MAX(0, (SELECT COUNT(*) FROM sql_executions) - ?1)
            )",
            [GLOBAL_CAP],
        )
        .map_err(map_sqlite)?;
    storage
        .conn()
        .execute(
            "DELETE FROM sql_executions WHERE id IN (
                SELECT id FROM sql_executions
                ORDER BY pinned ASC, executed_at ASC, id ASC
                LIMIT MAX(0, (SELECT COUNT(*) FROM sql_executions) - ?1)
            )",
            [GLOBAL_CAP],
        )
        .map_err(map_sqlite)?;
    Ok(())
}

fn delete_overflow(storage: &Storage, sql: &str, param: &str) -> OmniResult<()> {
    storage
        .conn()
        .execute(sql, [param])
        .map_err(map_sqlite)?;
    Ok(())
}

fn push_eq(
    sql: &mut String,
    params: &mut Vec<Box<dyn rusqlite::types::ToSql>>,
    column: &str,
    value: Option<&str>,
) {
    let Some(value) = value.map(str::trim).filter(|s| !s.is_empty()) else {
        return;
    };
    sql.push_str(" AND ");
    sql.push_str(column);
    sql.push_str(" = ?");
    params.push(Box::new(value.to_string()));
}

fn map_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<SqlExecRecord> {
    let pinned: i64 = row.get(15)?;
    let truncated: i64 = row.get(16)?;
    let has_result: i64 = row.get(17)?;
    Ok(SqlExecRecord {
        id: row.get(0)?,
        executed_at: row.get(1)?,
        connection_id: row.get(2)?,
        connection_name: row.get(3)?,
        database_name: row.get(4)?,
        env_tag: row.get(5)?,
        sql_file_id: row.get(6)?,
        tab_id: row.get(7)?,
        sql: row.get(8)?,
        display_name: row.get(9)?,
        status: row.get(10)?,
        elapsed_ms: row.get(11)?,
        rows_affected: row.get(12)?,
        row_count: row.get(13)?,
        error: row.get(14)?,
        pinned: pinned != 0,
        result_truncated: truncated != 0,
        has_result: has_result != 0,
    })
}

fn normalize_status(status: &str) -> &'static str {
    match status {
        "ok" | "error" | "cancelled" => match status {
            "ok" => "ok",
            "error" => "error",
            "cancelled" => "cancelled",
            _ => "error",
        },
        _ => "error",
    }
}

fn normalize_sql(sql: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in sql.chars() {
        if ch.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        if space {
            out.push(' ');
            space = false;
        }
        out.push(ch.to_ascii_lowercase());
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, rows: Vec<Vec<Value>>, pinned: bool) -> SqlExecAppend {
        SqlExecAppend {
            id: id.to_string(),
            executed_at: 1,
            connection_id: "c1".into(),
            connection_name: "local".into(),
            database_name: "app".into(),
            env_tag: "dev".into(),
            sql_file_id: Some("file".into()),
            tab_id: "tab".into(),
            sql: "SELECT 1".into(),
            display_name: "SELECT 1".into(),
            status: "ok".into(),
            elapsed_ms: Some(3),
            rows_affected: 0,
            error: String::new(),
            pinned,
            columns: vec!["n".into()],
            rows,
        }
    }

    #[test]
    fn keeps_full_page_under_cap_and_preview_over_cap() {
        let storage = Storage::open_in_memory().unwrap();
        let small = sample("a", vec![vec![Value::from(1)]], false);
        let saved = append_sql_execution(&storage, &small).unwrap();
        assert!(!saved.result_truncated);
        let page = get_sql_execution_result(&storage, "a").unwrap().unwrap();
        assert_eq!(page.rows.len(), 1);

        let fat = "x".repeat(20_000);
        let rows = (0..30)
            .map(|_| vec![Value::String(fat.clone())])
            .collect::<Vec<_>>();
        let big = sample("b", rows, false);
        let saved = append_sql_execution(&storage, &big).unwrap();
        assert!(saved.result_truncated);
        let page = get_sql_execution_result(&storage, "b").unwrap().unwrap();
        assert_eq!(page.rows.len(), PREVIEW_ROWS);
        assert!(page.truncated);
    }

    #[test]
    fn drops_oldest_unpinned_past_file_cap() {
        let storage = Storage::open_in_memory().unwrap();
        for i in 0..(FILE_UNPINNED_CAP + 2) {
            let mut row = sample(&format!("id-{i}"), vec![], false);
            row.executed_at = i;
            row.status = "error".into();
            row.columns.clear();
            append_sql_execution(&storage, &row).unwrap();
        }
        let list = list_sql_executions(
            &storage,
            &SqlExecListFilter {
                sql_file_id: Some("file".into()),
                limit: Some(500),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(list.len() as i64, FILE_UNPINNED_CAP);
        assert!(list.iter().all(|row| row.id != "id-0"));
    }
}
