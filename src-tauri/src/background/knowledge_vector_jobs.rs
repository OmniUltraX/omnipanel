use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use omnipanel_store::Storage;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use crate::commands::knowledge_vector::{
    KnowledgeVectorizeArgs, KnowledgeVectorizeResult, execute_knowledge_vectorize,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BgTaskKnowledgeEvent {
    pub task_id: String,
    pub event_type: String,
    pub entry_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chunk_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

async fn emit_knowledge_event(app: &AppHandle, event: BgTaskKnowledgeEvent) {
    let _ = app.emit("bg-task-knowledge-event", &event);
}

pub async fn run_knowledge_vectorize_background(
    app: AppHandle,
    storage: Arc<Mutex<Storage>>,
    task_id: String,
    args: KnowledgeVectorizeArgs,
    cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
) -> Result<(), String> {
    let entry_id = args.entry_id.clone();

    let result = execute_knowledge_vectorize(storage, args, cancel.clone(), progress).await;

    match result {
        Ok(KnowledgeVectorizeResult {
            entry_id,
            chunk_count,
            ..
        }) => {
            emit_knowledge_event(
                &app,
                BgTaskKnowledgeEvent {
                    task_id: task_id.clone(),
                    event_type: "vectorize_done".to_string(),
                    entry_id,
                    chunk_count: Some(chunk_count),
                    error: None,
                },
            )
            .await;
            Ok(())
        }
        Err(message) => {
            if cancel.load(Ordering::Relaxed) {
                return Ok(());
            }
            emit_knowledge_event(
                &app,
                BgTaskKnowledgeEvent {
                    task_id,
                    event_type: "vectorize_failed".to_string(),
                    entry_id,
                    chunk_count: None,
                    error: Some(message.clone()),
                },
            )
            .await;
            Err(message)
        }
    }
}
