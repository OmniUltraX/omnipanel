//! Tauri 后台任务池适配：事件经 `AppHandle::emit` 下发。

use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use omnipanel_bg::{BackgroundWorkerPool as InnerPool, TaskEventSink};
use omnipanel_error::OmniError;
use omnipanel_store::Storage;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

pub use omnipanel_bg::{BackgroundTaskInfo, WorkerPoolSummary, default_worker_count};

pub struct TauriTaskEventSink(pub AppHandle);

impl TaskEventSink for TauriTaskEventSink {
    fn emit_bg_task_update(&self, task: &BackgroundTaskInfo) {
        let _ = self.0.emit("bg-task-update", task);
    }
}

pub struct BackgroundWorkerPool {
    inner: InnerPool,
}

impl BackgroundWorkerPool {
    pub fn new(worker_count: u32, storage: Arc<Mutex<Storage>>) -> Self {
        Self {
            inner: InnerPool::new(worker_count, storage),
        }
    }

    pub async fn summary(&self) -> WorkerPoolSummary {
        self.inner.summary().await
    }

    pub async fn list_running(&self) -> Vec<BackgroundTaskInfo> {
        self.inner.list_running().await
    }

    pub async fn spawn<F, Fut>(
        &self,
        app: AppHandle,
        module: impl Into<String>,
        kind: impl Into<String>,
        title: impl Into<String>,
        total: u32,
        work: F,
    ) -> Result<String, OmniError>
    where
        F: FnOnce(
                String,
                Arc<AtomicBool>,
                Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync>,
            ) -> Fut
            + Send
            + 'static,
        Fut: Future<Output = Result<(), String>> + Send + 'static,
    {
        let sink: Arc<dyn TaskEventSink> = Arc::new(TauriTaskEventSink(app));
        self.inner
            .spawn(sink, module, kind, title, total, work)
            .await
    }

    pub async fn cancel_and_emit(&self, app: &AppHandle, id: &str) -> Result<(), OmniError> {
        let sink: Arc<dyn TaskEventSink> = Arc::new(TauriTaskEventSink(app.clone()));
        self.inner.cancel(id, Some(sink)).await
    }
}
