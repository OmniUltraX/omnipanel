//! 后台任务池：并发受限的 tokio 任务调度 + 进度事件 + 终态持久化。
//!
//! 事件下发通过 [`TaskEventSink`] 抽象，桌面端用 Tauri `AppHandle`，Web 端用 `EventBus`。

mod pool;
mod types;

pub use pool::{BackgroundWorkerPool, TaskEventSink, default_worker_count};
pub use types::{BackgroundTaskInfo, BackgroundTaskStatus, WorkerPoolSummary};
