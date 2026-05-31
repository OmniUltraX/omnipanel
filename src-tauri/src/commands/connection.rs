use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{Connection, ConnectionKind};
use tauri::State;

use omnipanel_store::DbConnectionConfig;
use crate::state::AppState;

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("conn-{nanos:x}")
}

/// 列出全部已保存连接。
#[tauri::command]
#[specta::specta]
pub async fn conn_list(state: State<'_, AppState>) -> Result<Vec<Connection>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_connections()
}

/// 保存（新建或更新）连接。id 为空时后端生成。
#[tauri::command]
#[specta::specta]
pub async fn conn_save(
    state: State<'_, AppState>,
    mut connection: Connection,
) -> Result<Connection, OmniError> {
    let now = now_secs();
    if connection.id.is_empty() {
        connection.id = gen_id();
    }
    if connection.created_at == 0 {
        connection.created_at = now;
    }
    connection.updated_at = now;

    let storage = state.storage.lock().await;
    storage.save_connection(&connection)?;
    Ok(connection)
}

/// 删除连接。
#[tauri::command]
#[specta::specta]
pub async fn conn_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_connection(&id)
}

/// 测试连接连通性。当前支持 database（MySQL）；其余类型将在对应里程碑接入。
#[tauri::command]
#[specta::specta]
pub async fn conn_test(connection: Connection) -> Result<String, OmniError> {
    match connection.kind {
        ConnectionKind::Database => {
            let db_config: DbConnectionConfig =
                serde_json::from_str(&connection.config).map_err(|e| {
                    OmniError::new(ErrorCode::InvalidInput, "数据库连接配置解析失败")
                        .with_cause(e.to_string())
                })?;
            let version = crate::commands::database::db_test_connection(db_config)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Connection, "数据库连接测试失败").with_cause(e)
                })?;
            Ok(format!("连接成功：{version}"))
        }
        other => Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("暂不支持 {other:?} 类型的连接测试"),
        )),
    }
}
