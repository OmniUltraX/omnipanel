use omnipanel_store::{BgTaskHistoryRecord, TaskEventRecord};
use serde::{Deserialize, Serialize};
use specta::Type;

fn status_str(status: BackgroundTaskStatus) -> &'static str {
    match status {
        BackgroundTaskStatus::Pending => "pending",
        BackgroundTaskStatus::Running => "running",
        BackgroundTaskStatus::Completed => "completed",
        BackgroundTaskStatus::Failed => "failed",
        BackgroundTaskStatus::Cancelled => "cancelled",
    }
}

pub(crate) fn is_terminal(status: BackgroundTaskStatus) -> bool {
    matches!(
        status,
        BackgroundTaskStatus::Completed
            | BackgroundTaskStatus::Failed
            | BackgroundTaskStatus::Cancelled
    )
}

/// 默认后台工作线程数：当前机器 CPU 逻辑核数，至少为 1。
pub fn default_worker_count() -> u32 {
    std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(1)
        .max(1)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum BackgroundTaskStatus {
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BackgroundTaskInfo {
    pub id: String,
    pub module: String,
    pub kind: String,
    pub title: String,
    pub progress: String,
    pub status: BackgroundTaskStatus,
    pub index: u32,
    pub total: u32,
    /// 当前阶段已完成行数（数据对比时更新）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_completed: Option<u32>,
    /// 当前阶段总行数（数据对比时更新）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_total: Option<u32>,
    #[specta(type = f64)]
    pub started_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub finished_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl BackgroundTaskInfo {
    pub fn to_history_record(&self) -> BgTaskHistoryRecord {
        BgTaskHistoryRecord {
            id: self.id.clone(),
            module: self.module.clone(),
            kind: self.kind.clone(),
            title: self.title.clone(),
            progress: self.progress.clone(),
            status: status_str(self.status).to_string(),
            index: self.index,
            total: self.total,
            row_completed: self.row_completed,
            row_total: self.row_total,
            started_at: self.started_at,
            finished_at: self.finished_at,
            error: self.error.clone(),
        }
    }

    pub(crate) fn to_task_event(&self) -> TaskEventRecord {
        TaskEventRecord {
            id: format!("bg:{}", self.id),
            source: "bg_task".into(),
            ref_id: self.id.clone(),
            module: self.module.clone(),
            workspace_id: None,
            resource_id: None,
            title: self.title.clone(),
            status: status_str(self.status).to_string(),
            env_tag: String::new(),
            risk: String::new(),
            ts: self.finished_at.unwrap_or(self.started_at),
            detail: serde_json::json!({
                "kind": self.kind,
                "progress": self.progress,
                "error": self.error,
            })
            .to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkerPoolSummary {
    pub worker_count: u32,
    pub active: u32,
    pub idle: u32,
}
