//! 工作流 store CRUD + 执行引擎（shell/docker/sql 步骤）。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    ExecutionStatus, SaveWorkflowRequest, StepStatus, StepType, Workflow, WorkflowDetail,
    WorkflowExecution, WorkflowExecutionDetail, WorkflowExecutionStep,
};

use crate::state::ServerState;
pub async fn workflow_list(state: &ServerState) -> Result<Vec<Workflow>, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_list()
}

pub async fn workflow_get(state: &ServerState, id: String) -> Result<WorkflowDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_get(&id)
}

pub async fn workflow_save(
    state: &ServerState,
    req: SaveWorkflowRequest,
) -> Result<WorkflowDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_save(&req)
}

pub async fn workflow_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_delete(&id)
}

pub async fn workflow_executions(
    state: &ServerState,
    workflow_id: String,
    limit: u32,
) -> Result<Vec<WorkflowExecution>, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_executions(&workflow_id, limit)
}

pub async fn workflow_get_execution(
    state: &ServerState,
    execution_id: String,
) -> Result<WorkflowExecutionDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_get_execution_detail(&execution_id)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id() -> String {
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let nanos = t.as_nanos();
    format!(
        "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
        (nanos >> 96) as u32,
        ((nanos >> 80) & 0xFFFF) as u16,
        ((nanos >> 64) & 0xFFF) as u16,
        ((nanos >> 48) & 0xFFFF) as u16,
        nanos & 0xFFFFFFFFFFFF_u128
    )
}

pub async fn workflow_run(state: &ServerState, id: String) -> Result<WorkflowExecution, OmniError> {
    let (detail, exec_id, started_at) = {
        let storage = state.storage.lock().await;
        let detail = storage.workflow_get(&id)?;
        let exec_id = new_id();
        let started_at = now_ms();
        let exec = WorkflowExecution {
            id: exec_id.clone(),
            workflow_id: id.clone(),
            status: ExecutionStatus::Running,
            triggered_by: "user".into(),
            started_at,
            finished_at: None,
            duration_ms: None,
            output: String::new(),
        };
        storage.workflow_record_execution(&exec)?;
        for step in &detail.steps {
            let exec_step = WorkflowExecutionStep {
                id: new_id(),
                execution_id: exec_id.clone(),
                step_id: step.id.clone(),
                step_order: step.step_order,
                name: step.name.clone(),
                step_type: step.step_type.clone(),
                command: step.command.clone(),
                status: StepStatus::Pending,
                output: String::new(),
                error: String::new(),
                started_at: None,
                finished_at: None,
            };
            storage.workflow_insert_execution_step(&exec_step)?;
        }
        (detail, exec_id, started_at)
    };

    let cancel_flag = Arc::new(AtomicBool::new(false));
    state
        .running_workflows
        .lock()
        .await
        .insert(exec_id.clone(), cancel_flag.clone());

    let storage = state.storage.clone();
    let bus = state.bus.clone();
    let running_workflows = state.running_workflows.clone();
    let bg_exec_id = exec_id.clone();

    tokio::spawn(async move {
        let result =
            execute_workflow_steps(&storage, &bus, &detail, &bg_exec_id, &cancel_flag).await;
        {
            let mut running = running_workflows.lock().await;
            running.remove(&bg_exec_id);
        }
        let (final_status, output, finished_at) = match result {
            Ok(output) => (ExecutionStatus::Completed, output, now_ms()),
            Err(e) => (ExecutionStatus::Failed, e.message.clone(), now_ms()),
        };
        let storage_guard = storage.lock().await;
        if let Ok(mut exec_detail) = storage_guard.workflow_get_execution_detail(&bg_exec_id) {
            exec_detail.execution.status = final_status;
            exec_detail.execution.finished_at = Some(finished_at);
            exec_detail.execution.duration_ms = Some(finished_at - started_at);
            exec_detail.execution.output = output;
            let _ = storage_guard.workflow_update_execution(&exec_detail.execution);
        }
        bus.emit("workflow-execution-complete", serde_json::json!(bg_exec_id));
    });

    let storage_guard = state.storage.lock().await;
    let exec_detail = storage_guard.workflow_get_execution_detail(&exec_id)?;
    Ok(exec_detail.execution)
}

pub async fn workflow_stop(state: &ServerState, execution_id: String) -> Result<(), OmniError> {
    let running = state.running_workflows.lock().await;
    if let Some(flag) = running.get(&execution_id) {
        flag.store(true, Ordering::SeqCst);
        Ok(())
    } else {
        Err(OmniError::new(
            ErrorCode::NotFound,
            format!("execution '{}' is not running", execution_id),
        ))
    }
}

async fn execute_workflow_steps(
    storage: &Arc<tokio::sync::Mutex<omnipanel_store::Storage>>,
    bus: &crate::bus::EventBus,
    detail: &WorkflowDetail,
    execution_id: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<String, OmniError> {
    let mut previous_output = String::new();
    let mut all_outputs: Vec<String> = Vec::new();

    for step in &detail.steps {
        if cancel_flag.load(Ordering::SeqCst) {
            mark_remaining_steps_skipped(storage, execution_id, step.step_order).await;
            return Err(OmniError::internal("Workflow execution cancelled"));
        }

        let step_started = now_ms();
        {
            let storage_guard = storage.lock().await;
            let exec_detail = storage_guard.workflow_get_execution_detail(execution_id)?;
            if let Some(exec_step) = exec_detail.steps.iter().find(|s| s.step_id == step.id) {
                let mut updated = exec_step.clone();
                updated.status = StepStatus::Running;
                updated.started_at = Some(step_started);
                storage_guard.workflow_update_execution_step(&updated)?;
            }
        }

        bus.emit(
            "workflow-step-update",
            serde_json::json!({
                "execution_id": execution_id,
                "step_id": step.id,
                "status": "running",
            }),
        );

        let step_result = execute_single_step(
            &step.step_type,
            &step.command,
            &previous_output,
            cancel_flag,
        )
        .await;
        let step_finished = now_ms();

        {
            let storage_guard = storage.lock().await;
            let exec_detail = storage_guard.workflow_get_execution_detail(execution_id)?;
            if let Some(exec_step) = exec_detail.steps.iter().find(|s| s.step_id == step.id) {
                let mut updated = exec_step.clone();
                updated.started_at = Some(step_started);
                updated.finished_at = Some(step_finished);
                match &step_result {
                    Ok(output) => {
                        updated.status = StepStatus::Passed;
                        updated.output = output.clone();
                    }
                    Err(e) => {
                        updated.status = StepStatus::Failed;
                        updated.error = e.user_message();
                    }
                }
                storage_guard.workflow_update_execution_step(&updated)?;
            }
        }

        bus.emit(
            "workflow-step-update",
            serde_json::json!({
                "execution_id": execution_id,
                "step_id": step.id,
                "status": match &step_result {
                    Ok(_) => "passed",
                    Err(_) => "failed",
                },
            }),
        );

        match step_result {
            Ok(output) => {
                all_outputs.push(format!("[{}] {}", step.name, output));
                previous_output = output;
            }
            Err(e) => {
                all_outputs.push(format!("[{}] ERROR: {}", step.name, e.user_message()));
                mark_remaining_steps_skipped(storage, execution_id, step.step_order).await;
                return Err(OmniError::internal(format!(
                    "Step '{}' failed: {}",
                    step.name,
                    e.user_message()
                )));
            }
        }
    }

    Ok(all_outputs.join("\n"))
}

async fn execute_single_step(
    step_type: &StepType,
    command: &str,
    previous_output: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<String, OmniError> {
    match step_type {
        StepType::Shell | StepType::Docker | StepType::Workflow => {
            execute_shell_step(command, previous_output, cancel_flag).await
        }
        StepType::Sql => execute_sql_step(command, previous_output).await,
    }
}

async fn execute_shell_step(
    command: &str,
    previous_output: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<String, OmniError> {
    let resolved_command = command.replace("{{previous_output}}", previous_output);
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", &resolved_command]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", &resolved_command]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let child = cmd
        .spawn()
        .map_err(|e| OmniError::terminal(format!("Failed to spawn command: {}", e)))?;
    let output = tokio::select! {
        result = child.wait_with_output() => {
            result.map_err(|e| OmniError::terminal(format!("Command execution failed: {}", e)))?
        }
        _ = wait_for_cancel(cancel_flag) => {
            return Err(OmniError::internal("Step cancelled"));
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        let exit_code = output.status.code().unwrap_or(-1);
        let combined = if stderr.is_empty() {
            stdout
        } else if stdout.is_empty() {
            stderr
        } else {
            format!("{}\n{}", stdout, stderr)
        };
        return Err(OmniError::internal(format!(
            "Command exited with code {}: {}",
            exit_code, combined
        )));
    }
    Ok(if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{}\n{}", stdout, stderr)
    })
}

async fn execute_sql_step(command: &str, previous_output: &str) -> Result<String, OmniError> {
    let resolved_query = command.replace("{{previous_output}}", previous_output);
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", "sqlite3", ":memory:", &resolved_query]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args([
            "-c",
            &format!(
                "sqlite3 ':memory:' '{}'",
                resolved_query.replace('\'', "'\\''")
            ),
        ]);
        c
    };
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    let output = cmd
        .output()
        .await
        .map_err(|e| OmniError::database(format!("SQL execution failed: {}", e)))?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        return Err(OmniError::database(format!(
            "SQL query failed: {}",
            if stderr.is_empty() { &stdout } else { &stderr }
        )));
    }
    Ok(stdout)
}

async fn wait_for_cancel(flag: &Arc<AtomicBool>) {
    loop {
        if flag.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

async fn mark_remaining_steps_skipped(
    storage: &Arc<tokio::sync::Mutex<omnipanel_store::Storage>>,
    execution_id: &str,
    after_order: i32,
) {
    let storage_guard = storage.lock().await;
    if let Ok(exec_detail) = storage_guard.workflow_get_execution_detail(execution_id) {
        for exec_step in &exec_detail.steps {
            if exec_step.step_order > after_order {
                let mut updated = exec_step.clone();
                updated.status = StepStatus::Skipped;
                updated.finished_at = Some(now_ms());
                let _ = storage_guard.workflow_update_execution_step(&updated);
            }
        }
    }
}
