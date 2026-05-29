use std::collections::HashMap;

use omnipanel_db::{DbParams, QueryResult};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct DbConnectionConfig {
    pub id: String,
    pub name: String,
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,
    pub group: String,
    pub status: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TableInfo {
    pub name: String,
    pub rows: Vec<HashMap<String, serde_json::Value>>,
    pub columns: Vec<String>,
}

/// 将 IPC 连接配置转换为 omnipanel-db 的领域连接参数。
fn to_params(c: &DbConnectionConfig) -> DbParams {
    DbParams {
        db_type: c.db_type.clone(),
        host: c.host.clone(),
        port: c.port,
        user: c.user.clone(),
        password: c.password.clone(),
        database: c.database.clone(),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<DbConnectionConfig>, String> {
    let store = state.db_connections.lock().await;
    let mut list: Vec<_> = store.values().cloned().collect();
    list.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(list)
}

#[tauri::command]
#[specta::specta]
pub async fn db_save_connection(
    state: State<'_, AppState>,
    connection: DbConnectionConfig,
) -> Result<DbConnectionConfig, String> {
    let mut store = state.db_connections.lock().await;
    let id = if connection.id.is_empty() {
        uuid_v4()
    } else {
        connection.id.clone()
    };
    let conn = DbConnectionConfig { id, ..connection };
    store.insert(conn.id.clone(), conn.clone());
    Ok(conn)
}

#[tauri::command]
#[specta::specta]
pub async fn db_delete_connection(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let mut store = state.db_connections.lock().await;
    store.remove(&id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn db_test_connection(connection: DbConnectionConfig) -> Result<String, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(|e| e.to_string())?;
    driver.version().await.map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn db_list_tables(connection: DbConnectionConfig) -> Result<Vec<String>, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(|e| e.to_string())?;
    driver.list_tables().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_preview_table(
    connection: DbConnectionConfig,
    table: String,
    limit: u32,
) -> Result<TableInfo, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(|e| e.to_string())?;
    let result = driver
        .preview(&table, limit as i64)
        .await
        .map_err(|e| e.to_string())?;
    Ok(to_table_info(table, result))
}

/// 执行任意 SQL（SELECT 返回行集，DML 返回影响行数）。高风险写操作由前端经执行引擎确认后调用。
#[tauri::command]
pub async fn db_execute_query(
    connection: DbConnectionConfig,
    sql: String,
) -> Result<QueryResult, String> {
    let driver = omnipanel_db::connect(&to_params(&connection))
        .await
        .map_err(|e| e.to_string())?;
    driver.execute(&sql).await.map_err(|e| e.to_string())
}

/// 将列式 QueryResult 转换为前端预览用的 TableInfo（行为 列名→值 的 map）。
fn to_table_info(name: String, result: QueryResult) -> TableInfo {
    let rows = result
        .rows
        .into_iter()
        .map(|record| {
            result
                .columns
                .iter()
                .cloned()
                .zip(record)
                .collect::<HashMap<String, serde_json::Value>>()
        })
        .collect();
    TableInfo {
        name,
        rows,
        columns: result.columns,
    }
}

fn uuid_v4() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        now.as_secs(),
        (now.as_nanos() & 0xffff) as u16,
        ((now.as_nanos() >> 16) as u16 & 0xfff),
        ((now.as_nanos() >> 28) as u16 & 0x3fff) | 0x8000,
        (now.as_nanos() >> 44) & 0xffff_ffff_ffff
    )
}
