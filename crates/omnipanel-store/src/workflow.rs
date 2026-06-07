//! Workflow persistence — workflows / workflow_steps / workflow_executions tables.

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::storage::{map_sqlite, Storage};

/// Serialize enum to bare string without JSON quotes.
fn enum_str<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_value(v)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

/// Parse a bare enum string back by wrapping in quotes for serde_json.
fn parse_enum<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    let quoted = format!("\"{}\"", s);
    serde_json::from_str(&quoted).ok()
}

// ─── Data Models ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowType {
    Script,
    Template,
    Deploy,
    Patrol,
    DataFlow,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
    ReadOnly,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum StepStatus {
    Ready,
    Pending,
    Running,
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum StepType {
    Shell,
    Sql,
    Docker,
    Workflow,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub workflow_type: WorkflowType,
    pub risk_level: RiskLevel,
    pub target: String,
    pub env_tag: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowStep {
    pub id: String,
    pub workflow_id: String,
    pub name: String,
    pub description: String,
    pub step_type: StepType,
    pub command: String,
    pub step_order: i32,
    pub status: StepStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowDetail {
    pub workflow: Workflow,
    pub steps: Vec<WorkflowStep>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowExecution {
    pub id: String,
    pub workflow_id: String,
    pub status: ExecutionStatus,
    pub triggered_by: String,
    pub started_at: i64,
    pub finished_at: Option<i64>,
    pub duration_ms: Option<i64>,
    pub output: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SaveWorkflowRequest {
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub workflow_type: WorkflowType,
    pub risk_level: RiskLevel,
    pub target: String,
    pub env_tag: String,
    pub steps: Vec<SaveStepRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct SaveStepRequest {
    pub id: Option<String>,
    pub name: String,
    pub description: String,
    pub step_type: StepType,
    pub command: String,
    pub step_order: i32,
}

// ─── Execution Step Detail ──────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowExecutionStep {
    pub id: String,
    pub execution_id: String,
    pub step_id: String,
    pub step_order: i32,
    pub name: String,
    pub step_type: StepType,
    pub command: String,
    pub status: StepStatus,
    pub output: String,
    pub error: String,
    pub started_at: Option<i64>,
    pub finished_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct WorkflowExecutionDetail {
    pub execution: WorkflowExecution,
    pub steps: Vec<WorkflowExecutionStep>,
}

// ─── CRUD ────────────────────────────────────────────────────

impl Storage {
    /// List all workflows (without steps).
    pub fn workflow_list(&self) -> OmniResult<Vec<Workflow>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, description, workflow_type, risk_level, target, env_tag, created_at, updated_at
                 FROM workflows ORDER BY updated_at DESC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok(Workflow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    description: row.get(2)?,
                    workflow_type: parse_enum(&row.get::<_, String>(3)?)
                        .unwrap_or(WorkflowType::Script),
                    risk_level: parse_enum::<RiskLevel>(&row.get::<_, String>(4)?)
                        .unwrap_or(RiskLevel::Low),
                    target: row.get(5)?,
                    env_tag: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// Get workflow detail with steps.
    pub fn workflow_get(&self, id: &str) -> OmniResult<WorkflowDetail> {
        let workflow = self
            .conn()
            .query_row(
                "SELECT id, name, description, workflow_type, risk_level, target, env_tag, created_at, updated_at
                 FROM workflows WHERE id = ?1",
                [id],
                |row| {
                    Ok(Workflow {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        description: row.get(2)?,
                        workflow_type: parse_enum(&row.get::<_, String>(3)?)
                            .unwrap_or(WorkflowType::Script),
                        risk_level: parse_enum(&row.get::<_, String>(4)?)
                            .unwrap_or(RiskLevel::Low),
                        target: row.get(5)?,
                        env_tag: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    OmniError::new(ErrorCode::NotFound, format!("workflow '{}' not found", id))
                }
                other => map_sqlite(other),
            })?;

        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, workflow_id, name, description, step_type, command, step_order, status
                 FROM workflow_steps WHERE workflow_id = ?1 ORDER BY step_order",
            )
            .map_err(map_sqlite)?;
        let steps: Vec<WorkflowStep> = stmt
            .query_map([id], |row| {
                Ok(WorkflowStep {
                    id: row.get(0)?,
                    workflow_id: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    step_type: parse_enum(&row.get::<_, String>(4)?)
                        .unwrap_or(StepType::Shell),
                    command: row.get(5)?,
                    step_order: row.get(6)?,
                    status: parse_enum(&row.get::<_, String>(7)?)
                        .unwrap_or(StepStatus::Ready),
                })
            })
            .map_err(map_sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_sqlite)?;

        Ok(WorkflowDetail { workflow, steps })
    }

    /// Create or update a workflow with its steps.
    pub fn workflow_save(&self, req: &SaveWorkflowRequest) -> OmniResult<WorkflowDetail> {
        let now = now_ms();
        let wf_id = req.id.clone().unwrap_or_else(new_id);

        self.conn()
            .execute(
                "INSERT INTO workflows (id, name, description, workflow_type, risk_level, target, env_tag, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                     name=excluded.name, description=excluded.description,
                     workflow_type=excluded.workflow_type, risk_level=excluded.risk_level,
                     target=excluded.target, env_tag=excluded.env_tag, updated_at=excluded.updated_at",
                params![
                    wf_id,
                    req.name,
                    req.description,
                    enum_str(&req.workflow_type),
                    enum_str(&req.risk_level),
                    req.target,
                    req.env_tag,
                    now,
                ],
            )
            .map_err(map_sqlite)?;

        // Replace all steps
        self.conn()
            .execute(
                "DELETE FROM workflow_steps WHERE workflow_id = ?1",
                [&wf_id],
            )
            .map_err(map_sqlite)?;

        for step in &req.steps {
            let step_id = step.id.clone().unwrap_or_else(new_id);
            self.conn()
                .execute(
                    "INSERT INTO workflow_steps (id, workflow_id, name, description, step_type, command, step_order, status)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ready')",
                    params![
                        step_id,
                        wf_id,
                        step.name,
                        step.description,
                        enum_str(&step.step_type),
                        step.command,
                        step.step_order,
                    ],
                )
                .map_err(map_sqlite)?;
        }

        self.workflow_get(&wf_id)
    }

    /// Delete a workflow and cascade.
    pub fn workflow_delete(&self, id: &str) -> OmniResult<()> {
        self.conn()
            .execute("DELETE FROM workflow_steps WHERE workflow_id = ?1", [id])
            .map_err(map_sqlite)?;
        self.conn()
            .execute(
                "DELETE FROM workflow_executions WHERE workflow_id = ?1",
                [id],
            )
            .map_err(map_sqlite)?;
        self.conn()
            .execute("DELETE FROM workflows WHERE id = ?1", [id])
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// Record a workflow execution.
    pub fn workflow_record_execution(&self, exec: &WorkflowExecution) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO workflow_executions (id, workflow_id, status, triggered_by, started_at, finished_at, duration_ms, output)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    exec.id,
                    exec.workflow_id,
                    enum_str(&exec.status),
                    exec.triggered_by,
                    exec.started_at,
                    exec.finished_at,
                    exec.duration_ms,
                    exec.output,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// Get execution history for a workflow.
    pub fn workflow_executions(
        &self,
        workflow_id: &str,
        limit: u32,
    ) -> OmniResult<Vec<WorkflowExecution>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, workflow_id, status, triggered_by, started_at, finished_at, duration_ms, output
                 FROM workflow_executions WHERE workflow_id = ?1 ORDER BY started_at DESC LIMIT ?2",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map(params![workflow_id, limit], |row| {
                Ok(WorkflowExecution {
                    id: row.get(0)?,
                    workflow_id: row.get(1)?,
                    status: parse_enum(&row.get::<_, String>(2)?)
                        .unwrap_or(ExecutionStatus::Failed),
                    triggered_by: row.get(3)?,
                    started_at: row.get(4)?,
                    finished_at: row.get(5)?,
                    duration_ms: row.get(6)?,
                    output: row.get(7)?,
                })
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(map_sqlite)?);
        }
        Ok(out)
    }

    /// Insert a workflow_execution_steps record.
    pub fn workflow_insert_execution_step(
        &self,
        step: &WorkflowExecutionStep,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "INSERT INTO workflow_execution_steps (id, execution_id, step_id, step_order, name, step_type, command, status, output, error, started_at, finished_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    step.id,
                    step.execution_id,
                    step.step_id,
                    step.step_order,
                    step.name,
                    enum_str(&step.step_type),
                    step.command,
                    enum_str(&step.status),
                    step.output,
                    step.error,
                    step.started_at,
                    step.finished_at,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// Update a workflow_execution_steps record (status, output, error, timestamps).
    pub fn workflow_update_execution_step(
        &self,
        step: &WorkflowExecutionStep,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "UPDATE workflow_execution_steps
                 SET status = ?1, output = ?2, error = ?3, started_at = ?4, finished_at = ?5
                 WHERE id = ?6",
                params![
                    enum_str(&step.status),
                    step.output,
                    step.error,
                    step.started_at,
                    step.finished_at,
                    step.id,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }

    /// Get execution detail with step records.
    pub fn workflow_get_execution_detail(
        &self,
        execution_id: &str,
    ) -> OmniResult<WorkflowExecutionDetail> {
        let execution = self
            .conn()
            .query_row(
                "SELECT id, workflow_id, status, triggered_by, started_at, finished_at, duration_ms, output
                 FROM workflow_executions WHERE id = ?1",
                [execution_id],
                |row| {
                    Ok(WorkflowExecution {
                        id: row.get(0)?,
                        workflow_id: row.get(1)?,
                        status: parse_enum(&row.get::<_, String>(2)?)
                            .unwrap_or(ExecutionStatus::Failed),
                        triggered_by: row.get(3)?,
                        started_at: row.get(4)?,
                        finished_at: row.get(5)?,
                        duration_ms: row.get(6)?,
                        output: row.get(7)?,
                    })
                },
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => {
                    OmniError::new(ErrorCode::NotFound, format!("execution '{}' not found", execution_id))
                }
                other => map_sqlite(other),
            })?;

        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, execution_id, step_id, step_order, name, step_type, command, status, output, error, started_at, finished_at
                 FROM workflow_execution_steps WHERE execution_id = ?1 ORDER BY step_order",
            )
            .map_err(map_sqlite)?;
        let steps: Vec<WorkflowExecutionStep> = stmt
            .query_map([execution_id], |row| {
                Ok(WorkflowExecutionStep {
                    id: row.get(0)?,
                    execution_id: row.get(1)?,
                    step_id: row.get(2)?,
                    step_order: row.get(3)?,
                    name: row.get(4)?,
                    step_type: parse_enum(&row.get::<_, String>(5)?)
                        .unwrap_or(StepType::Shell),
                    command: row.get(6)?,
                    status: parse_enum(&row.get::<_, String>(7)?)
                        .unwrap_or(StepStatus::Pending),
                    output: row.get(8)?,
                    error: row.get(9)?,
                    started_at: row.get(10)?,
                    finished_at: row.get(11)?,
                })
            })
            .map_err(map_sqlite)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(map_sqlite)?;

        Ok(WorkflowExecutionDetail { execution, steps })
    }

    /// Update a workflow execution record (status, finished_at, duration_ms, output).
    pub fn workflow_update_execution(
        &self,
        exec: &WorkflowExecution,
    ) -> OmniResult<()> {
        self.conn()
            .execute(
                "UPDATE workflow_executions
                 SET status = ?1, finished_at = ?2, duration_ms = ?3, output = ?4
                 WHERE id = ?5",
                params![
                    enum_str(&exec.status),
                    exec.finished_at,
                    exec.duration_ms,
                    exec.output,
                    exec.id,
                ],
            )
            .map_err(map_sqlite)?;
        Ok(())
    }
}

// ─── Helpers ─────────────────────────────────────────────────

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn new_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
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

// ─── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_req() -> SaveWorkflowRequest {
        SaveWorkflowRequest {
            id: None,
            name: "Deploy Prod".into(),
            description: "Auto deploy flow".into(),
            workflow_type: WorkflowType::Deploy,
            risk_level: RiskLevel::High,
            target: "prod-server".into(),
            env_tag: "prod".into(),
            steps: vec![
                SaveStepRequest {
                    id: None,
                    name: "Git Pull".into(),
                    description: "Pull latest".into(),
                    step_type: StepType::Shell,
                    command: "git pull origin main".into(),
                    step_order: 0,
                },
                SaveStepRequest {
                    id: None,
                    name: "Build Image".into(),
                    description: "Docker build".into(),
                    step_type: StepType::Docker,
                    command: "docker build -t app:latest .".into(),
                    step_order: 1,
                },
            ],
        }
    }

    #[test]
    fn save_and_list() {
        let storage = Storage::open_in_memory().unwrap();
        let detail = storage.workflow_save(&sample_req()).unwrap();
        assert_eq!(detail.workflow.name, "Deploy Prod");
        assert_eq!(detail.steps.len(), 2);
        assert_eq!(detail.steps[0].name, "Git Pull");

        let list = storage.workflow_list().unwrap();
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn get_with_steps() {
        let storage = Storage::open_in_memory().unwrap();
        let detail = storage.workflow_save(&sample_req()).unwrap();
        let got = storage.workflow_get(&detail.workflow.id).unwrap();
        assert_eq!(got.steps.len(), 2);
    }

    #[test]
    fn update_replaces_steps() {
        let storage = Storage::open_in_memory().unwrap();
        let detail = storage.workflow_save(&sample_req()).unwrap();
        let mut req = sample_req();
        req.id = Some(detail.workflow.id.clone());
        req.name = "Updated".into();
        req.steps = vec![SaveStepRequest {
            id: None,
            name: "New Step".into(),
            description: "".into(),
            step_type: StepType::Shell,
            command: "echo hello".into(),
            step_order: 0,
        }];
        let updated = storage.workflow_save(&req).unwrap();
        assert_eq!(updated.workflow.name, "Updated");
        assert_eq!(updated.steps.len(), 1);
    }

    #[test]
    fn delete_cascade() {
        let storage = Storage::open_in_memory().unwrap();
        let detail = storage.workflow_save(&sample_req()).unwrap();
        storage.workflow_delete(&detail.workflow.id).unwrap();
        assert!(storage.workflow_get(&detail.workflow.id).is_err());
        assert!(storage.workflow_list().unwrap().is_empty());
    }

    #[test]
    fn execution_roundtrip() {
        let storage = Storage::open_in_memory().unwrap();
        let detail = storage.workflow_save(&sample_req()).unwrap();
        let exec = WorkflowExecution {
            id: new_id(),
            workflow_id: detail.workflow.id.clone(),
            status: ExecutionStatus::Completed,
            triggered_by: "user".into(),
            started_at: 1000,
            finished_at: Some(2000),
            duration_ms: Some(1000),
            output: "OK".into(),
        };
        storage.workflow_record_execution(&exec).unwrap();
        let execs = storage
            .workflow_executions(&detail.workflow.id, 10)
            .unwrap();
        assert_eq!(execs.len(), 1);
        assert_eq!(execs[0].triggered_by, "user");
    }

    #[test]
    fn not_found() {
        let storage = Storage::open_in_memory().unwrap();
        assert!(storage.workflow_get("nonexistent").is_err());
    }
}
