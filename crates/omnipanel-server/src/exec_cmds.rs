//! 动作执行引擎：execute_action、task_run/stop。

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_exec::{
    ActionProgress, ActionRequest, ExecutionEngine, ProgressSink, ProgressStream, ShellExecutor,
};
use omnipanel_store::{AuditEntry, Task, TaskStatus, TaskType};

use crate::state::ServerState;

fn task_type_to_kind(tt: &TaskType) -> &'static str {
    match tt {
        TaskType::Terminal => "terminal",
        TaskType::Docker => "docker",
        TaskType::Server => "server",
        TaskType::Ssh | TaskType::Sql | TaskType::Ai | TaskType::Workflow => "terminal",
    }
}

pub async fn execute_action(state: &ServerState, action: ActionRequest) -> Result<i32, OmniError> {
    let bus = state.bus.clone();
    let sink: ProgressSink = Arc::new(move |p: ActionProgress| {
        let _ = bus.emit(
            "action-progress",
            serde_json::to_value(&p).unwrap_or(serde_json::json!({})),
        );
    });

    let result = state.engine.execute(&action, &sink).await;

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

pub async fn task_run(state: &ServerState, id: String) -> Result<(), OmniError> {
    let task = {
        let storage = state.storage.lock().await;
        storage.task_get(&id)?
    };

    match &task.status {
        TaskStatus::Draft | TaskStatus::Confirmed | TaskStatus::Failed | TaskStatus::Cancelled => {}
        TaskStatus::Running => {
            return Err(OmniError::new(ErrorCode::InvalidInput, "任务正在运行中"));
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

    {
        let storage = state.storage.lock().await;
        storage.task_update_status(&id, &TaskStatus::Running)?;
    }

    let kind = task_type_to_kind(&task.task_type).to_string();
    let action = ActionRequest {
        id: id.clone(),
        kind,
        command: Some(task.command.clone()),
        resource_id: Some(task.resource_id.clone()),
        env_tag: Some(task.env_tag.clone()),
        cwd: None,
    };

    let bus = state.bus.clone();
    let storage = state.storage.clone();
    let engine = state.engine.clone();
    let running_tasks = state.running_tasks.clone();
    let task_id = id.clone();

    let handle = tokio::spawn(async move {
        let tid = task_id.clone();
        let bus2 = bus.clone();
        let stor = storage.clone();
        let sink: ProgressSink = Arc::new(move |p: ActionProgress| {
            let payload = serde_json::json!({
                "taskId": p.action_id,
                "stream": format!("{:?}", p.stream).to_lowercase(),
                "chunk": p.chunk,
                "status": p.status.as_ref().map(|s| format!("{:?}", s).to_lowercase()),
                "exitCode": p.exit_code,
            });
            bus2.emit("task-output", payload);

            if p.stream == ProgressStream::Stdout || p.stream == ProgressStream::Stderr {
                let stor_guard = stor.blocking_lock();
                let _ = stor_guard.task_append_output(&p.action_id, &p.chunk);
                let _ = stor_guard.task_append_output(&p.action_id, "\n");
            }
        });

        let result = engine.execute(&action, &sink).await;

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

        bus.emit(
            "task-status",
            serde_json::json!({
                "taskId": tid,
                "status": format!("{:?}", final_status).to_lowercase(),
            }),
        );

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
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
            action: "task.run".into(),
            target: tid.clone(),
            env_tag: action.env_tag.unwrap_or_default(),
            risk: "low".into(),
            status: audit_status,
            detail,
        };
        {
            let stor_guard = storage.lock().await;
            let _ = stor_guard.append_audit(&entry);
        }

        running_tasks.lock().await.remove(&tid);
    });

    state.running_tasks.lock().await.insert(id, handle);
    Ok(())
}

pub async fn task_stop(state: &ServerState, id: String) -> Result<(), OmniError> {
    let handle = state.running_tasks.lock().await.remove(&id);
    match handle {
        Some(h) => {
            h.abort();
            let storage = state.storage.lock().await;
            storage.task_update_status(&id, &TaskStatus::Cancelled)?;
            state.bus.emit(
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

pub async fn task_get_output(state: &ServerState, id: String) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_get(&id)
}

pub fn new_execution_engine() -> Arc<ExecutionEngine> {
    let mut engine = ExecutionEngine::new();
    let shell = Arc::new(ShellExecutor);
    engine.register("terminal", shell.clone());
    engine.register("docker", shell.clone());
    engine.register("server", shell);
    Arc::new(engine)
}
