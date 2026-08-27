use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::Storage;
use tokio::sync::{Mutex, Semaphore};
use tokio::task::JoinHandle;

use crate::types::{BackgroundTaskInfo, BackgroundTaskStatus, WorkerPoolSummary, is_terminal};

pub use crate::types::default_worker_count;

static TASK_SEQ: AtomicU64 = AtomicU64::new(0);

fn new_task_id() -> String {
    let seq = TASK_SEQ.fetch_add(1, Ordering::Relaxed);
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    format!("bg-{ms:x}-{seq:x}")
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 后台任务进度事件下发（桌面 Tauri emit / Web EventBus）。
pub trait TaskEventSink: Send + Sync {
    fn emit_bg_task_update(&self, task: &BackgroundTaskInfo);
}

pub struct BackgroundWorkerPool {
    worker_count: u32,
    semaphore: Arc<Semaphore>,
    tasks: Arc<Mutex<HashMap<String, BackgroundTaskInfo>>>,
    cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    handles: Arc<Mutex<HashMap<String, JoinHandle<()>>>>,
    storage: Arc<Mutex<Storage>>,
}

impl BackgroundWorkerPool {
    pub fn new(worker_count: u32, storage: Arc<Mutex<Storage>>) -> Self {
        let n = worker_count.max(1) as usize;
        Self {
            worker_count: n as u32,
            semaphore: Arc::new(Semaphore::new(n)),
            tasks: Arc::new(Mutex::new(HashMap::new())),
            cancel_flags: Arc::new(Mutex::new(HashMap::new())),
            handles: Arc::new(Mutex::new(HashMap::new())),
            storage,
        }
    }

    pub async fn summary(&self) -> WorkerPoolSummary {
        let tasks = self.tasks.lock().await;
        let active = tasks
            .values()
            .filter(|t| {
                matches!(
                    t.status,
                    BackgroundTaskStatus::Pending | BackgroundTaskStatus::Running
                )
            })
            .count() as u32;
        WorkerPoolSummary {
            worker_count: self.worker_count,
            active,
            idle: self.worker_count.saturating_sub(active),
        }
    }

    pub async fn list_running(&self) -> Vec<BackgroundTaskInfo> {
        let tasks = self.tasks.lock().await;
        let mut list: Vec<_> = tasks
            .values()
            .filter(|t| {
                matches!(
                    t.status,
                    BackgroundTaskStatus::Pending | BackgroundTaskStatus::Running
                )
            })
            .cloned()
            .collect();
        list.sort_by_key(|t| t.started_at);
        list
    }

    async fn persist_terminal(storage: &Arc<Mutex<Storage>>, task: &BackgroundTaskInfo) {
        if !is_terminal(task.status) {
            return;
        }
        let history = task.to_history_record();
        let event = task.to_task_event();
        let guard = storage.lock().await;
        if let Err(err) = guard.upsert_bg_task_history(&history) {
            tracing::warn!(error = %err, id = %task.id, "写入 bg_task_history 失败");
        }
        if let Err(err) = guard.upsert_task_event(&event) {
            tracing::warn!(error = %err, id = %task.id, "写入 task_events 失败");
        }
    }

    fn emit_and_persist(
        sink: &Arc<dyn TaskEventSink>,
        storage: &Arc<Mutex<Storage>>,
        task: &BackgroundTaskInfo,
    ) {
        sink.emit_bg_task_update(task);
        let storage = storage.clone();
        let task = task.clone();
        tokio::spawn(async move {
            Self::persist_terminal(&storage, &task).await;
        });
    }

    async fn patch_task<F>(
        tasks: &Arc<Mutex<HashMap<String, BackgroundTaskInfo>>>,
        id: &str,
        patch: F,
    ) -> Option<BackgroundTaskInfo>
    where
        F: FnOnce(&mut BackgroundTaskInfo),
    {
        let mut guard = tasks.lock().await;
        let entry = guard.get_mut(id)?;
        patch(entry);
        Some(entry.clone())
    }

    /// 提交后台任务；`work` 在独立 tokio 任务中执行，受线程池信号量限制并发。
    pub async fn spawn<F, Fut>(
        &self,
        sink: Arc<dyn TaskEventSink>,
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
        let id = new_task_id();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let task_info = BackgroundTaskInfo {
            id: id.clone(),
            module: module.into(),
            kind: kind.into(),
            title: title.into(),
            progress: String::new(),
            status: BackgroundTaskStatus::Pending,
            index: 0,
            total,
            row_completed: None,
            row_total: None,
            started_at: now_ms(),
            finished_at: None,
            error: None,
        };

        {
            let mut tasks = self.tasks.lock().await;
            tasks.insert(id.clone(), task_info.clone());
        }
        sink.emit_bg_task_update(&task_info);

        {
            let mut flags = self.cancel_flags.lock().await;
            flags.insert(id.clone(), cancel_flag.clone());
        }

        let tasks_arc = self.tasks.clone();
        let flags_arc = self.cancel_flags.clone();
        let handles_arc = self.handles.clone();
        let storage_arc = self.storage.clone();
        let semaphore = self.semaphore.clone();
        let task_id = id.clone();
        let sink_for_progress = sink.clone();

        let progress_cb: Arc<dyn Fn(String, u32, u32, Option<u32>, Option<u32>) + Send + Sync> = {
            let tasks = tasks_arc.clone();
            let sink = sink_for_progress.clone();
            let tid = task_id.clone();
            Arc::new(move |progress, index, total, row_completed, row_total| {
                let tasks = tasks.clone();
                let sink = sink.clone();
                let tid = tid.clone();
                tokio::spawn(async move {
                    if let Some(updated) = BackgroundWorkerPool::patch_task(&tasks, &tid, |t| {
                        t.progress = progress;
                        t.index = index;
                        t.total = total;
                        match row_completed {
                            Some(v) => t.row_completed = Some(v),
                            None => t.row_completed = None,
                        }
                        match row_total {
                            Some(v) => t.row_total = Some(v),
                            None => t.row_total = None,
                        }
                        if t.status == BackgroundTaskStatus::Pending {
                            t.status = BackgroundTaskStatus::Running;
                        }
                    })
                    .await
                    {
                        sink.emit_bg_task_update(&updated);
                    }
                });
            })
        };

        let sink_for_task = sink.clone();
        let handle = tokio::spawn(async move {
            let _permit = match semaphore.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };

            if let Some(updated) = BackgroundWorkerPool::patch_task(&tasks_arc, &task_id, |t| {
                t.status = BackgroundTaskStatus::Running;
            })
            .await
            {
                sink_for_task.emit_bg_task_update(&updated);
            }

            let result = work(task_id.clone(), cancel_flag.clone(), progress_cb).await;

            let cancelled = cancel_flag.load(Ordering::Relaxed);
            let final_status = if cancelled {
                BackgroundTaskStatus::Cancelled
            } else {
                match &result {
                    Ok(()) => BackgroundTaskStatus::Completed,
                    Err(_) => BackgroundTaskStatus::Failed,
                }
            };

            if let Some(updated) = BackgroundWorkerPool::patch_task(&tasks_arc, &task_id, |t| {
                if is_terminal(t.status) {
                    return;
                }
                t.status = final_status;
                t.finished_at = Some(now_ms());
                if let Err(msg) = &result {
                    t.error = Some(msg.clone());
                }
            })
            .await
            {
                BackgroundWorkerPool::emit_and_persist(&sink_for_task, &storage_arc, &updated);
            }

            flags_arc.lock().await.remove(&task_id);
            handles_arc.lock().await.remove(&task_id);
        });

        self.handles.lock().await.insert(id.clone(), handle);
        Ok(id)
    }

    /// 取消任务；`emit` 为 true 时通过 sink 广播终态并持久化。
    pub async fn cancel(
        &self,
        id: &str,
        sink: Option<Arc<dyn TaskEventSink>>,
    ) -> Result<(), OmniError> {
        if let Some(flag) = self.cancel_flags.lock().await.get(id).cloned() {
            flag.store(true, Ordering::Relaxed);
        }
        if let Some(handle) = self.handles.lock().await.remove(id) {
            handle.abort();
        }
        if let Some(updated) = Self::patch_task(&self.tasks, id, |t| {
            if matches!(
                t.status,
                BackgroundTaskStatus::Pending | BackgroundTaskStatus::Running
            ) {
                t.status = BackgroundTaskStatus::Cancelled;
                t.finished_at = Some(now_ms());
            }
        })
        .await
        {
            if let Some(sink) = sink {
                Self::emit_and_persist(&sink, &self.storage, &updated);
            }
            Ok(())
        } else {
            Err(OmniError::new(
                ErrorCode::NotFound,
                format!("后台任务 '{id}' 不存在或已结束"),
            ))
        }
    }
}
