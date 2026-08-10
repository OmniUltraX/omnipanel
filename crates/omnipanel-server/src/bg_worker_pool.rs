//! 后台任务池（Web 端：事件经 EventBus 广播，替代 Tauri emit）。

use std::future::Future;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use omnipanel_bg::{BackgroundWorkerPool as InnerPool, TaskEventSink};
use omnipanel_error::OmniError;
use omnipanel_store::Storage;
use tokio::sync::Mutex;

use crate::bus::EventBus;

pub use omnipanel_bg::{BackgroundTaskInfo, default_worker_count};

pub struct EventBusTaskEventSink(pub EventBus);

impl TaskEventSink for EventBusTaskEventSink {
    fn emit_bg_task_update(&self, task: &BackgroundTaskInfo) {
        let _ = self.0.emit(
            "bg-task-update",
            serde_json::to_value(task).unwrap_or(serde_json::json!({})),
        );
    }
}

pub struct BackgroundWorkerPool {
    inner: InnerPool,
    sink: Arc<dyn TaskEventSink>,
}

impl BackgroundWorkerPool {
    pub fn new(worker_count: u32, storage: Arc<Mutex<Storage>>, bus: EventBus) -> Self {
        let sink: Arc<dyn TaskEventSink> = Arc::new(EventBusTaskEventSink(bus));
        Self {
            inner: InnerPool::new(worker_count, storage),
            sink,
        }
    }

    pub async fn list_running(&self) -> Vec<BackgroundTaskInfo> {
        self.inner.list_running().await
    }

    pub async fn spawn<F, Fut>(
        &self,
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
        self.inner
            .spawn(
                self.sink.clone(),
                module,
                kind,
                title,
                total,
                work,
            )
            .await
    }

    pub async fn cancel(&self, id: &str) -> Result<(), OmniError> {
        self.inner.cancel(id, Some(self.sink.clone())).await
    }
}
