//! Web 端文件传输引擎（薄封装 relay + 任务表）。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use omnipanel_error::{ErrorCode, OmniError};
use tokio::sync::{Mutex, Semaphore};

pub use crate::relay::{
    TransferStartRequest, TransferState, transfer_cancel as relay_transfer_cancel,
    transfer_start as relay_transfer_start,
};
pub use crate::types::{
    FileTransferConflictPolicy, FileTransferEndpoint, FileTransferEnqueueRequest,
    FileTransferItemSpec, FileTransferJob, FileTransferListResult, FileTransferOp,
    FileTransferPlanRequest, FileTransferPlanResult, FileTransferRoute, FileTransferState,
    TRANSFER_PROGRESS_EVENT,
};

use crate::event::TransferEventSink;
use crate::provider::TransferHost;
use crate::util::{decide_route, now_ms};

static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

fn new_id(prefix: &str) -> String {
    let seq = JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{seq}", now_ms())
}

pub struct WebFileTransferEngine {
    pub jobs: Mutex<HashMap<String, FileTransferJob>>,
    pub cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub semaphore: Mutex<Arc<Semaphore>>,
    pub relay_cancel_flags: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl WebFileTransferEngine {
    pub fn new() -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            cancel_flags: Mutex::new(HashMap::new()),
            semaphore: Mutex::new(Arc::new(Semaphore::new(2))),
            relay_cancel_flags: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn set_concurrency(&self, n: u32) {
        let n = n.clamp(1, 8) as usize;
        let mut sem = self.semaphore.lock().await;
        *sem = Arc::new(Semaphore::new(n));
    }

    pub async fn plan(
        &self,
        host: &dyn TransferHost,
        request: &FileTransferPlanRequest,
    ) -> FileTransferPlanResult {
        let (route, route_reason, needs_direct_confirm) = decide_route(
            host,
            &request.source_connection_id,
            &request.dest_connection_id,
            request.force_route.clone(),
            &request.remote_direct_policy,
        )
        .await;
        let _ = route;
        FileTransferPlanResult {
            route: FileTransferRoute::Relay,
            route_reason: if route_reason.is_empty() {
                "Web 端经服务端中继传输（不支持远端直连）".into()
            } else {
                route_reason
            },
            needs_direct_confirm,
        }
    }

    pub async fn list(&self) -> FileTransferListResult {
        let jobs = self.jobs.lock().await;
        let mut list: Vec<_> = jobs.values().cloned().collect();
        list.sort_by(|a, b| b.id.cmp(&a.id));
        FileTransferListResult { jobs: list }
    }

    pub async fn clear_finished(&self) {
        let mut jobs = self.jobs.lock().await;
        jobs.retain(|_, j| {
            matches!(
                j.state,
                FileTransferState::Queued | FileTransferState::Probing | FileTransferState::Running
            )
        });
    }

    pub async fn dismiss_finished(&self, job_id: &str) -> Result<(), OmniError> {
        let mut jobs = self.jobs.lock().await;
        if let Some(job) = jobs.get(job_id) {
            if matches!(
                job.state,
                FileTransferState::Queued | FileTransferState::Probing | FileTransferState::Running
            ) {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    "运行中的任务请先取消",
                ));
            }
        }
        jobs.remove(job_id);
        Ok(())
    }

    pub async fn cancel(&self, job_id: &str) -> Result<(), OmniError> {
        if let Some(flag) = self.cancel_flags.lock().await.get(job_id) {
            flag.store(true, Ordering::Relaxed);
        }
        let _ = relay_transfer_cancel(&self.relay_cancel_flags, job_id.to_string()).await;
        Ok(())
    }

    pub async fn enqueue(
        &self,
        host: Arc<dyn TransferHost>,
        sink: Arc<dyn TransferEventSink>,
        request: FileTransferEnqueueRequest,
    ) -> Result<String, OmniError> {
        let batch_id = new_id("batch");
        for item in &request.items {
            let job_id = new_id("xfer");
            let req = TransferStartRequest {
                source_connection_id: item.connection_id.clone(),
                source_path: item.path.clone(),
                dest_connection_id: request.dest_connection_id.clone(),
                dest_path: crate::util::join_dest(&request.dest_dir, &item.name),
                conflict_policy: Some(format!("{:?}", request.conflict_policy).to_lowercase()),
                resume: true,
            };
            let id = relay_transfer_start(
                host.clone(),
                sink.clone(),
                self.relay_cancel_flags.clone(),
                req,
            )
            .await
            .map_err(|e| {
                omnipanel_error::OmniError::new(omnipanel_error::ErrorCode::Internal, e)
            })?;
            let job = FileTransferJob {
                id: id.clone(),
                batch_id: batch_id.clone(),
                op: request.op.clone(),
                source: FileTransferEndpoint {
                    connection_id: item.connection_id.clone(),
                    path: item.path.clone(),
                    kind: item.kind.clone(),
                    name: item.name.clone(),
                },
                dest: FileTransferEndpoint {
                    connection_id: request.dest_connection_id.clone(),
                    path: crate::util::join_dest(&request.dest_dir, &item.name),
                    kind: "file".into(),
                    name: item.name.clone(),
                },
                route: FileTransferRoute::Relay,
                route_reason: "Web relay".into(),
                state: FileTransferState::Queued,
                bytes_done: 0.0,
                bytes_total: item.size,
                speed_bps: None,
                error: None,
                progress: 0.0,
                source_fingerprint: None,
                partial_path: None,
            };
            self.jobs.lock().await.insert(job_id, job);
        }
        Ok(batch_id)
    }
}

impl Default for WebFileTransferEngine {
    fn default() -> Self {
        Self::new()
    }
}
