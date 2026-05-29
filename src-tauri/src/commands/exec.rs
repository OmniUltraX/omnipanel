use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use omnipanel_exec::{ActionProgress, ActionRequest, ProgressSink};
use omnipanel_store::AuditEntry;
use tauri::{Emitter, State};

use crate::state::AppState;

/// 执行一个动作：按 kind 分发到执行引擎，过程通过 `action-progress` 事件流式回流，
/// 完成后写入审计日志，返回退出码（0 成功）。
#[tauri::command]
#[specta::specta]
pub async fn execute_action(
    state: State<'_, AppState>,
    action: ActionRequest,
) -> Result<i32, OmniError> {
    let app = state.app_handle.clone();
    let sink: ProgressSink = Arc::new(move |p: ActionProgress| {
        let _ = app.emit("action-progress", p);
    });

    let engine = state.engine.clone();
    let result = engine.execute(&action, &sink).await;

    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let (status, detail) = match &result {
        Ok(code) => (
            if *code == 0 { "success" } else { "failed" }.to_string(),
            format!("exit={code}"),
        ),
        Err(e) => ("failed".to_string(), format!("error={}", e.message)),
    };
    let entry = AuditEntry {
        ts,
        action: format!("{}.exec", action.kind),
        target: action
            .command
            .clone()
            .or(action.resource_id.clone())
            .unwrap_or_default(),
        env_tag: action
            .env_tag
            .clone()
            .unwrap_or_else(|| "unknown".to_string()),
        risk: "low".to_string(),
        status,
        detail,
    };
    {
        let storage = state.storage.lock().await;
        let _ = storage.append_audit(&entry);
    }

    result
}
