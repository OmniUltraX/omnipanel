use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_exec::{ActionProgress, ActionRequest, ProgressSink, ProgressStream};
use omnipanel_store::{AuditEntry, SaveTaskRequest, Task, TaskStatus, TaskType};
use tauri::{Emitter, State};

use crate::state::AppState;

// ─── CRUD (existing) ──────────────────────────────────────────

/// 列出任务，可选按状态过滤。
#[tauri::command]
#[specta::specta]
pub async fn task_list(
    state: State<'_, AppState>,
    status_filter: Option<String>,
    limit: u32,
) -> Result<Vec<Task>, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_list(status_filter.as_deref(), limit)
}

/// 获取单个任务。
#[tauri::command]
#[specta::specta]
pub async fn task_get(state: State<'_, AppState>, id: String) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_get(&id)
}

/// 创建或更新任务。
#[tauri::command]
#[specta::specta]
pub async fn task_save(
    state: State<'_, AppState>,
    req: SaveTaskRequest,
) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_save(&req)
}

/// 更新任务状态。
#[tauri::command]
#[specta::specta]
pub async fn task_update_status(
    state: State<'_, AppState>,
    id: String,
    status: TaskStatus,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.task_update_status(&id, &status)
}

/// 删除任务。
#[tauri::command]
#[specta::specta]
pub async fn task_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.task_delete(&id)
}

// ─── Execution ────────────────────────────────────────────────

/// 将 [`TaskType`] 映射到执行引擎的 kind 字符串。
fn task_type_to_kind(tt: &TaskType) -> &'static str {
    match tt {
        TaskType::Terminal => "terminal",
        TaskType::Docker => "docker",
        TaskType::Server => "server",
        TaskType::Ssh => "terminal", // SSH 任务暂走 shell 执行器
        TaskType::Sql => "terminal", // SQL 任务暂走 shell 执行器
        TaskType::Ai => "terminal",  // AI 任务暂走 shell 执行器
        TaskType::Workflow => "terminal", // 工作流任务暂走 shell 执行器
    }
}

/// 执行一个任务：从存储加载 → 分发到执行引擎 → 流式回流输出 → 更新状态。
///
/// 任务在后台异步执行，函数立即返回。执行过程中通过以下事件通知前端：
/// - `task-output`   — 流式 stdout/stderr 输出（payload: `{ taskId, stream, chunk }`）
/// - `task-status`   — 状态变更（payload: `{ taskId, status }`）
#[tauri::command]
#[specta::specta]
pub async fn task_run(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    // 1. 加载任务
    let task = {
        let storage = state.storage.lock().await;
        storage.task_get(&id)?
    };

    // 2. 校验：仅 draft / confirmed / failed 可重新执行
    match &task.status {
        TaskStatus::Draft | TaskStatus::Confirmed | TaskStatus::Failed | TaskStatus::Cancelled => {
            // ok
        }
        TaskStatus::Running => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "任务正在运行中",
            ));
        }
        TaskStatus::Blocked => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "任务处于阻塞状态，无法执行",
            ));
        }
        TaskStatus::Completed => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "任务已完成，如需重新执行请先重置状态",
            ));
        }
    }

    // 3. 标记为 running
    {
        let storage = state.storage.lock().await;
        storage.task_update_status(&id, &TaskStatus::Running)?;
    }

    // 4. 构造 ActionRequest
    let kind = task_type_to_kind(&task.task_type).to_string();
    let action = ActionRequest {
        id: id.clone(),
        kind,
        command: Some(task.command.clone()),
        resource_id: Some(task.resource_id.clone()),
        env_tag: Some(task.env_tag.clone()),
        cwd: None,
    };

    // 5. 准备共享资源
    let app_handle = state.app_handle.clone();
    let storage = state.storage.clone();
    let engine = state.engine.clone();
    let running_tasks = state.running_tasks.clone();
    let task_id = id.clone();

    // 6. 后台执行
    let handle = tokio::spawn(async move {
        let tid = task_id.clone();

        // 构建 progress sink: emit 事件 + 写入 storage
        let app = app_handle.clone();
        let stor = storage.clone();
        let sink: ProgressSink = Arc::new(move |p: ActionProgress| {
            // 发射前端事件
            let payload = serde_json::json!({
                "taskId": p.action_id,
                "stream": format!("{:?}", p.stream).to_lowercase(),
                "chunk": p.chunk,
                "status": p.status.as_ref().map(|s| format!("{:?}", s).to_lowercase()),
                "exitCode": p.exit_code,
            });
            let _ = app.emit("task-output", &payload);

            // 将输出追加到存储（仅 stdout/stderr 内容）
            if p.stream == ProgressStream::Stdout || p.stream == ProgressStream::Stderr {
                let stor_guard = stor.blocking_lock();
                let _ = stor_guard.task_append_output(&p.action_id, &p.chunk);
                let _ = stor_guard.task_append_output(&p.action_id, "\n");
            }
        });

        // 执行
        let result = engine.execute(&action, &sink).await;

        // 更新最终状态
        let final_status = match &result {
            Ok(code) => {
                if *code == 0 {
                    TaskStatus::Completed
                } else {
                    TaskStatus::Failed
                }
            }
            Err(_) => TaskStatus::Failed,
        };

        {
            let stor_guard = storage.lock().await;
            let _ = stor_guard.task_update_status(&tid, &final_status);
        }

        // 发射状态事件
        let status_payload = serde_json::json!({
            "taskId": tid,
            "status": format!("{:?}", final_status).to_lowercase(),
        });
        let _ = app_handle.emit("task-status", &status_payload);

        // 审计
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or_default();
        let (audit_status, detail) = match &result {
            Ok(code) => (
                if *code == 0 { "success" } else { "failed" }.to_string(),
                format!("exit={code}"),
            ),
            Err(e) => ("failed".to_string(), format!("error={}", e.message)),
        };
        let entry = AuditEntry {
            ts,
            action: format!("task.run"),
            target: tid.clone(),
            env_tag: action.env_tag.unwrap_or_default(),
            risk: "low".to_string(),
            status: audit_status,
            detail,
        };
        {
            let stor_guard = storage.lock().await;
            let _ = stor_guard.append_audit(&entry);
        }

        // 从运行列表移除
        running_tasks.lock().await.remove(&tid);
    });

    // 7. 保存句柄
    state.running_tasks.lock().await.insert(id, handle);

    Ok(())
}

/// 停止一个正在运行的任务。异步任务将被中止，任务状态标记为 cancelled。
#[tauri::command]
#[specta::specta]
pub async fn task_stop(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let handle = state.running_tasks.lock().await.remove(&id);
    match handle {
        Some(h) => {
            h.abort();
            let storage = state.storage.lock().await;
            storage.task_update_status(&id, &TaskStatus::Cancelled)?;

            // 发射状态事件
            let _ = state.app_handle.emit(
                "task-status",
                serde_json::json!({
                    "taskId": id,
                    "status": "cancelled",
                }),
            );
            Ok(())
        }
        None => Err(OmniError::new(
            ErrorCode::NotFound,
            format!("任务 '{}' 不在运行中", id),
        )),
    }
}

/// 获取任务执行输出。
#[tauri::command]
#[specta::specta]
pub async fn task_get_output(state: State<'_, AppState>, id: String) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_get(&id)
}

// ─── Tests ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_type_to_kind_mapping() {
        assert_eq!(task_type_to_kind(&TaskType::Terminal), "terminal");
        assert_eq!(task_type_to_kind(&TaskType::Docker), "docker");
        assert_eq!(task_type_to_kind(&TaskType::Server), "server");
        assert_eq!(task_type_to_kind(&TaskType::Ssh), "terminal");
        assert_eq!(task_type_to_kind(&TaskType::Sql), "terminal");
        assert_eq!(task_type_to_kind(&TaskType::Ai), "terminal");
        assert_eq!(task_type_to_kind(&TaskType::Workflow), "terminal");
    }
}
