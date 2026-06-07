use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    ExecutionStatus, SaveWorkflowRequest, StepStatus, StepType, Workflow, WorkflowDetail,
    WorkflowExecution, WorkflowExecutionDetail, WorkflowExecutionStep,
};
use tauri::{Emitter, State};

use crate::state::AppState;

/// 列出所有工作流。
#[tauri::command]
#[specta::specta]
pub async fn workflow_list(state: State<'_, AppState>) -> Result<Vec<Workflow>, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_list()
}

/// 按 id 获取工作流详情（含步骤）。
#[tauri::command]
#[specta::specta]
pub async fn workflow_get(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_get(&id)
}

/// 创建或更新工作流。
#[tauri::command]
#[specta::specta]
pub async fn workflow_save(
    state: State<'_, AppState>,
    req: SaveWorkflowRequest,
) -> Result<WorkflowDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_save(&req)
}

/// 删除工作流（级联删除步骤和执行记录）。
#[tauri::command]
#[specta::specta]
pub async fn workflow_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_delete(&id)
}

/// 获取工作流执行历史。
#[tauri::command]
#[specta::specta]
pub async fn workflow_executions(
    state: State<'_, AppState>,
    workflow_id: String,
    limit: u32,
) -> Result<Vec<WorkflowExecution>, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_executions(&workflow_id, limit)
}

// ─── Workflow Execution Engine ────────────────────────────────

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

/// Start executing a workflow. Returns the execution ID immediately.
/// Steps execute sequentially in a background task.
#[tauri::command]
#[specta::specta]
pub async fn workflow_run(
    state: State<'_, AppState>,
    id: String,
) -> Result<WorkflowExecution, OmniError> {
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

        // Create execution step records (all pending initially)
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

    // Register cancellation flag
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut running = state.running_workflows.lock().await;
        running.insert(exec_id.clone(), cancel_flag.clone());
    }

    // Spawn background execution task
    let storage = state.storage.clone();
    let app_handle = state.app_handle.clone();
    let running_workflows = state.running_workflows.clone();
    let bg_exec_id = exec_id.clone();

    tokio::spawn(async move {
        let result = execute_workflow_steps(
            &storage,
            &app_handle,
            &detail,
            &bg_exec_id,
            started_at,
            &cancel_flag,
        )
        .await;

        // Clean up running workflows entry
        {
            let mut running = running_workflows.lock().await;
            running.remove(&bg_exec_id);
        }

        // Update final execution status
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

        // Emit completion event
        let _ = app_handle.emit("workflow-execution-complete", &bg_exec_id);
    });

    // Return the execution record immediately
    let storage_guard = state.storage.lock().await;
    let exec_detail = storage_guard.workflow_get_execution_detail(&exec_id)?;
    Ok(exec_detail.execution)
}

/// Cancel a running workflow execution.
#[tauri::command]
#[specta::specta]
pub async fn workflow_stop(
    state: State<'_, AppState>,
    execution_id: String,
) -> Result<(), OmniError> {
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

/// Get execution detail with step results.
#[tauri::command]
#[specta::specta]
pub async fn workflow_get_execution(
    state: State<'_, AppState>,
    execution_id: String,
) -> Result<WorkflowExecutionDetail, OmniError> {
    let storage = state.storage.lock().await;
    storage.workflow_get_execution_detail(&execution_id)
}

// ─── Internal Execution Logic ─────────────────────────────────

/// Execute all workflow steps sequentially.
/// Each step receives the previous step's output as context.
async fn execute_workflow_steps(
    storage: &Arc<tokio::sync::Mutex<omnipanel_store::Storage>>,
    app_handle: &tauri::AppHandle,
    detail: &WorkflowDetail,
    execution_id: &str,
    started_at: i64,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<String, OmniError> {
    let mut previous_output = String::new();
    let mut all_outputs: Vec<String> = Vec::new();

    for step in &detail.steps {
        // Check cancellation
        if cancel_flag.load(Ordering::SeqCst) {
            // Mark remaining steps as skipped
            mark_remaining_steps_skipped(storage, execution_id, step.step_order).await;
            return Err(OmniError::internal("Workflow execution cancelled"));
        }

        // Update step to running
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

        // Emit step-started event
        let _ = app_handle.emit(
            "workflow-step-update",
            serde_json::json!({
                "execution_id": execution_id,
                "step_id": step.id,
                "status": "running",
            }),
        );

        // Execute step based on type
        let step_result =
            execute_single_step(&step.step_type, &step.command, &previous_output, cancel_flag)
                .await;

        let step_finished = now_ms();

        // Update step with result
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

        // Emit step-completed event
        let _ = app_handle.emit(
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
                // Mark remaining steps as skipped
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

/// Execute a single step based on its type.
async fn execute_single_step(
    step_type: &StepType,
    command: &str,
    previous_output: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<String, OmniError> {
    match step_type {
        StepType::Shell => execute_shell_step(command, previous_output, cancel_flag).await,
        StepType::Docker => execute_docker_step(command, previous_output, cancel_flag).await,
        StepType::Sql => execute_sql_step(command, previous_output).await,
        StepType::Workflow => {
            // Workflow-in-workflow: treat as a shell command for now
            // (could be extended to invoke sub-workflows)
            execute_shell_step(command, previous_output, cancel_flag).await
        }
    }
}

/// Execute a shell/terminal command via tokio::process::Command.
async fn execute_shell_step(
    command: &str,
    previous_output: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<String, OmniError> {
    // Substitute {{previous_output}} placeholder if present
    let resolved_command = command.replace("{{previous_output}}", previous_output);

    // Parse command: if it contains spaces, use shell; otherwise try direct execution
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

    // Poll for cancellation while waiting
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

    let combined = if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{}\n{}", stdout, stderr)
    };

    Ok(combined)
}

/// Execute a Docker command via shell (docker CLI).
/// The command field should contain a docker CLI command like "docker ps" or "docker build ...".
async fn execute_docker_step(
    command: &str,
    previous_output: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<String, OmniError> {
    // Docker steps are executed as shell commands (docker CLI)
    // This is consistent with how the existing Docker module works
    execute_shell_step(command, previous_output, cancel_flag).await
}

/// Execute a SQL query.
/// The command field should contain the SQL query.
async fn execute_sql_step(
    command: &str,
    previous_output: &str,
) -> Result<String, OmniError> {
    // Substitute {{previous_output}} placeholder if present
    let resolved_query = command.replace("{{previous_output}}", previous_output);

    // SQL execution via shell using sqlite3 CLI (for SQLite queries)
    // For more complex DB types, this would need the omnipanel-db crate
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = tokio::process::Command::new("cmd");
        c.args(["/C", "sqlite3", ":memory:", &resolved_query]);
        c
    };

    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = tokio::process::Command::new("sh");
        c.args(["-c", &format!("sqlite3 ':memory:' '{}'", resolved_query.replace('\'', "'\\''"))]);
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

/// Helper: wait until cancel flag is set (polling interval).
async fn wait_for_cancel(flag: &Arc<AtomicBool>) {
    loop {
        if flag.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

/// Mark all steps after the given order as skipped.
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

// ─── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use omnipanel_store::Storage;

    #[tokio::test]
    async fn test_execute_shell_step_simple() {
        let cancel = Arc::new(AtomicBool::new(false));
        let result = execute_shell_step("echo hello", "", &cancel).await;
        assert!(result.is_ok());
        assert!(result.unwrap().trim() == "hello");
    }

    #[tokio::test]
    async fn test_execute_shell_step_with_previous_output() {
        let cancel = Arc::new(AtomicBool::new(false));
        // First step produces output
        let result1 = execute_shell_step("echo world", "", &cancel).await;
        assert!(result1.is_ok());
        // Second step uses previous output
        let result2 =
            execute_shell_step("echo {{previous_output}}", &result1.unwrap(), &cancel).await;
        assert!(result2.is_ok());
        assert!(result2.unwrap().trim() == "world");
    }

    #[tokio::test]
    async fn test_execute_shell_step_failure() {
        let cancel = Arc::new(AtomicBool::new(false));
        let result = execute_shell_step("exit 1", "", &cancel).await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_cancellation_flag() {
        let cancel = Arc::new(AtomicBool::new(false));
        cancel.store(true, Ordering::SeqCst);
        let result = execute_shell_step("echo should_not_run", "", &cancel).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().message.contains("cancelled"));
    }

    #[test]
    fn test_workflow_execution_step_crud() {
        let storage = Storage::open_in_memory().unwrap();

        // Create a workflow first
        let req = omnipanel_store::SaveWorkflowRequest {
            id: Some("test-wf".into()),
            name: "Test WF".into(),
            description: String::new(),
            workflow_type: omnipanel_store::WorkflowType::Script,
            risk_level: omnipanel_store::RiskLevel::Low,
            target: String::new(),
            env_tag: "dev".into(),
            steps: vec![omnipanel_store::SaveStepRequest {
                id: Some("step-1".into()),
                name: "Step 1".into(),
                description: String::new(),
                step_type: StepType::Shell,
                command: "echo hello".into(),
                step_order: 0,
            }],
        };
        storage.workflow_save(&req).unwrap();

        // Create execution
        let exec = WorkflowExecution {
            id: "exec-1".into(),
            workflow_id: "test-wf".into(),
            status: ExecutionStatus::Running,
            triggered_by: "user".into(),
            started_at: 1000,
            finished_at: None,
            duration_ms: None,
            output: String::new(),
        };
        storage.workflow_record_execution(&exec).unwrap();

        // Insert execution step
        let exec_step = WorkflowExecutionStep {
            id: "es-1".into(),
            execution_id: "exec-1".into(),
            step_id: "step-1".into(),
            step_order: 0,
            name: "Step 1".into(),
            step_type: StepType::Shell,
            command: "echo hello".into(),
            status: StepStatus::Running,
            output: String::new(),
            error: String::new(),
            started_at: Some(1000),
            finished_at: None,
        };
        storage.workflow_insert_execution_step(&exec_step).unwrap();

        // Update execution step
        let mut updated = exec_step.clone();
        updated.status = StepStatus::Passed;
        updated.output = "hello\n".into();
        updated.finished_at = Some(2000);
        storage.workflow_update_execution_step(&updated).unwrap();

        // Get execution detail
        let detail = storage.workflow_get_execution_detail("exec-1").unwrap();
        assert_eq!(detail.execution.id, "exec-1");
        assert_eq!(detail.steps.len(), 1);
        assert_eq!(detail.steps[0].status, StepStatus::Passed);
        assert_eq!(detail.steps[0].output, "hello\n");
    }

    #[test]
    fn test_workflow_update_execution() {
        let storage = Storage::open_in_memory().unwrap();

        let req = omnipanel_store::SaveWorkflowRequest {
            id: Some("test-wf-2".into()),
            name: "Test WF 2".into(),
            description: String::new(),
            workflow_type: omnipanel_store::WorkflowType::Script,
            risk_level: omnipanel_store::RiskLevel::Low,
            target: String::new(),
            env_tag: "dev".into(),
            steps: vec![],
        };
        storage.workflow_save(&req).unwrap();

        let exec = WorkflowExecution {
            id: "exec-2".into(),
            workflow_id: "test-wf-2".into(),
            status: ExecutionStatus::Running,
            triggered_by: "user".into(),
            started_at: 1000,
            finished_at: None,
            duration_ms: None,
            output: String::new(),
        };
        storage.workflow_record_execution(&exec).unwrap();

        // Update execution
        let mut updated_exec = exec;
        updated_exec.status = ExecutionStatus::Completed;
        updated_exec.finished_at = Some(3000);
        updated_exec.duration_ms = Some(2000);
        updated_exec.output = "All done".into();
        storage.workflow_update_execution(&updated_exec).unwrap();

        let detail = storage.workflow_get_execution_detail("exec-2").unwrap();
        assert_eq!(detail.execution.status, ExecutionStatus::Completed);
        assert_eq!(detail.execution.output, "All done");
        assert_eq!(detail.execution.duration_ms, Some(2000));
    }
}
