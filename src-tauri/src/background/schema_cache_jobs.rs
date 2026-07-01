use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use omnipanel_store::{
    load_schema_cache, save_schema_cache, DbConnectionConfig, SchemaCacheConnection,
    SchemaCacheSnapshot,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::database::{build_schema_cache_connection, is_db_connection_enabled};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgTaskSchemaCacheEvent {
    pub task_id: String,
    pub event_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connection_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub entry: Option<SchemaCacheConnection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<SchemaCacheSnapshot>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn emit_schema_cache_event(app: &AppHandle, event: BgTaskSchemaCacheEvent) {
    let _ = app.emit("bg-task-schema-cache-event", &event);
}

pub async fn run_db_schema_cache_refresh(
    app: AppHandle,
    connections: Vec<DbConnectionConfig>,
    connection_ids: Option<Vec<String>>,
    task_id: String,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let id_filter: Option<HashMap<String, ()>> = connection_ids.map(|ids| {
        ids.into_iter().map(|id| (id, ())).collect::<HashMap<_, _>>()
    });

    let targets: Vec<DbConnectionConfig> = connections
        .into_iter()
        .filter(|conn| is_db_connection_enabled(conn))
        .filter(|conn| id_filter.as_ref().is_none_or(|m| m.contains_key(&conn.id)))
        .collect();

    let total = targets.len().max(1) as u32;
    if targets.is_empty() {
        progress("无可用连接".to_string(), 0, 1, None, None);
        emit_schema_cache_event(
            &app,
            BgTaskSchemaCacheEvent {
                task_id: task_id.clone(),
                event_type: "complete".to_string(),
                connection_id: None,
                connection_name: None,
                entry: None,
                snapshot: Some(load_schema_cache().map_err(|e| e.to_string())?),
                error: None,
            },
        )
        .await;
        return Ok(());
    }

    let mut snapshot = load_schema_cache().unwrap_or_default();
    let mut index: u32 = 0;

    for connection in targets {
        if cancel.load(Ordering::Relaxed) {
            return Ok(());
        }

        index += 1;
        progress(
            format!("正在刷新连接：{}", connection.name),
            index,
            total,
            None,
            None,
        );

        let entry = build_schema_cache_connection(&connection).await;
        snapshot
            .connections
            .insert(connection.id.clone(), entry.clone());

        emit_schema_cache_event(
            &app,
            BgTaskSchemaCacheEvent {
                task_id: task_id.clone(),
                event_type: "connection_done".to_string(),
                connection_id: Some(connection.id.clone()),
                connection_name: Some(connection.name.clone()),
                entry: Some(entry),
                snapshot: None,
                error: None,
            },
        )
        .await;
    }

    if cancel.load(Ordering::Relaxed) {
        return Ok(());
    }

    save_schema_cache(&snapshot).map_err(|e| e.to_string())?;

    progress("Schema 缓存刷新完成".to_string(), total, total, None, None);
    emit_schema_cache_event(
        &app,
        BgTaskSchemaCacheEvent {
            task_id,
            event_type: "complete".to_string(),
            connection_id: None,
            connection_name: None,
            entry: None,
            snapshot: Some(snapshot),
            error: None,
        },
    )
    .await;

    Ok(())
}
