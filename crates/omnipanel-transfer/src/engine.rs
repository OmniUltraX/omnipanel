use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{FileTransferJobRecord, Storage};
use tokio::sync::{Mutex, Semaphore};

use crate::event::{emit_job, TransferEventSink};
use crate::expand::expand_transfer_items;
use crate::fastpath::run_fastpath;
use crate::provider::TransferHost;
use crate::remote_direct::run_remote_direct;
use crate::resume::{load_jobs, normalize_after_load};
use crate::stream_relay::run_relay_with_engine;
use crate::types::{
    FileTransferConflictPolicy, FileTransferEnqueueRequest, FileTransferEndpoint, FileTransferJob,
    FileTransferListResult, FileTransferOp, FileTransferPlanRequest, FileTransferPlanResult,
    FileTransferRoute, FileTransferState,
};
use crate::util::{
    decide_route, dest_path_exists, endpoint, join_dest, leaf_name, now_ms, open_sftp,
    unique_rename_name_for,
};

static JOB_SEQ: AtomicU64 = AtomicU64::new(1);

fn new_id(prefix: &str) -> String {
    let seq = JOB_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{seq}", now_ms())
}

const PROGRESS_PERSIST_INTERVAL_MS: u64 = 1000;

pub struct FileTransferEngine {
    jobs: Mutex<HashMap<String, FileTransferJob>>,
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    semaphore: Mutex<Arc<Semaphore>>,
    storage: Arc<Mutex<Storage>>,
    last_progress_persist: Mutex<u64>,
}

impl FileTransferEngine {
    pub async fn new(storage: Arc<Mutex<Storage>>) -> Self {
        let mut map = HashMap::new();
        let mut needs_json_migration = false;
        {
            let s = storage.lock().await;
            match s.list_active_file_transfer_jobs() {
                Ok(records) => {
                    if records.is_empty() {
                        needs_json_migration = true;
                    } else {
                        for rec in records {
                            if let Ok(job) = record_to_job(&rec) {
                                map.insert(job.id.clone(), job);
                            }
                        }
                    }
                }
                Err(e) => {
                    tracing::warn!("从 SQLite 加载传输任务失败，回退空列表：{e}");
                    needs_json_migration = true;
                }
            }
        }
        if needs_json_migration {
            let json_jobs = normalize_after_load(load_jobs());
            if !json_jobs.is_empty() {
                let s = storage.lock().await;
                for j in &json_jobs {
                    let rec = job_to_record(j);
                    if let Err(e) = s.upsert_file_transfer_job(&rec) {
                        tracing::warn!("迁移传输任务 {} 到 SQLite 失败：{e}", j.id);
                    }
                }
                tracing::info!("已从 jobs.json 迁移 {} 条传输任务到 SQLite", json_jobs.len());
            }
            for j in json_jobs {
                map.insert(j.id.clone(), j);
            }
        }
        Self {
            jobs: Mutex::new(map),
            cancel_flags: Mutex::new(HashMap::new()),
            semaphore: Mutex::new(Arc::new(Semaphore::new(2))),
            storage,
            last_progress_persist: Mutex::new(0),
        }
    }

    pub async fn set_concurrency(&self, n: u32) {
        let n = n.clamp(1, 8) as usize;
        let mut sem = self.semaphore.lock().await;
        *sem = Arc::new(Semaphore::new(n));
    }

    async fn persist(&self) {
        let jobs = self.jobs.lock().await;
        let s = self.storage.lock().await;
        for j in jobs.values() {
            let rec = job_to_record(j);
            if let Err(e) = s.upsert_file_transfer_job(&rec) {
                tracing::warn!("持久化传输任务 {} 失败：{e}", j.id);
            }
        }
    }

    pub async fn persist_progress_throttled(&self, job: &FileTransferJob) {
        let now = now_ms();
        {
            let mut last = self.last_progress_persist.lock().await;
            if now - *last < PROGRESS_PERSIST_INTERVAL_MS {
                return;
            }
            *last = now;
        }
        let s = self.storage.lock().await;
        let rec = job_to_record(job);
        if let Err(e) = s.upsert_file_transfer_job(&rec) {
            tracing::warn!("持久化传输进度 {} 失败：{e}", job.id);
        }
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
        FileTransferPlanResult {
            route,
            route_reason,
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
        drop(jobs);
        let s = self.storage.lock().await;
        if let Err(e) = s.clear_finished_file_transfer_jobs() {
            tracing::warn!("清理已完成传输任务失败：{e}");
        }
    }

    pub async fn cancel(&self, job_id: &str) -> Result<(), OmniError> {
        if let Some(flag) = self.cancel_flags.lock().await.get(job_id) {
            flag.store(true, Ordering::Relaxed);
        }
        let mut jobs = self.jobs.lock().await;
        if let Some(job) = jobs.get_mut(job_id) {
            if matches!(
                job.state,
                FileTransferState::Queued | FileTransferState::Running | FileTransferState::Probing
            ) {
                job.state = FileTransferState::Cancelled;
                job.error = Some("已取消".into());
            }
            drop(jobs);
            self.persist().await;
            Ok(())
        } else {
            Err(OmniError::new(ErrorCode::NotFound, "任务不存在"))
        }
    }

    pub async fn enqueue(
        self: &Arc<Self>,
        host: Arc<dyn TransferHost>,
        sink: Arc<dyn TransferEventSink>,
        request: FileTransferEnqueueRequest,
    ) -> Result<String, OmniError> {
        if request.items.is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "没有要传输的文件"));
        }

        let expanded = expand_transfer_items(host.as_ref(), &request.items).await?;

        let batch_id = new_id("batch");
        let dest_dir = if request.dest_connection_id == host.local_connection_id()
            && request.dest_dir.trim().is_empty()
        {
            host.local_home().unwrap_or_else(|_| request.dest_dir.clone())
        } else {
            request.dest_dir.clone()
        };

        let (route, route_reason, _) = decide_route(
            host.as_ref(),
            &expanded[0].connection_id,
            &request.dest_connection_id,
            request.force_route.clone(),
            &request.remote_direct_policy,
        )
        .await;

        let (route, route_reason) = if request.force_route.is_none()
            && request.remote_direct_policy == "ask"
            && matches!(route, FileTransferRoute::RemoteDirect)
        {
            (
                FileTransferRoute::Relay,
                "未确认直传，先经本机中继（可在设置中改为始终直传）".into(),
            )
        } else {
            (route, route_reason)
        };

        let mut created = Vec::new();
        for item in &expanded {
            let mut dest_rel = item.name.clone();
            let dest_path = join_dest(&dest_dir, &dest_rel);

            let exists = dest_path_exists(host.as_ref(), &request.dest_connection_id, &dest_path)
                .await
                .unwrap_or(false);
            if exists {
                match request.conflict_policy {
                    FileTransferConflictPolicy::Skip => continue,
                    FileTransferConflictPolicy::Overwrite => {}
                    FileTransferConflictPolicy::Rename => {
                        dest_rel = unique_rename_name_for(
                            host.as_ref(),
                            &request.dest_connection_id,
                            &dest_dir,
                            &item.name,
                        )
                        .await
                        .unwrap_or_else(|_| format!("{}-{}", item.name, now_ms()));
                    }
                }
            }

            let final_path = join_dest(&dest_dir, &dest_rel);
            let job_id = new_id("xfer");
            let job = FileTransferJob {
                id: job_id.clone(),
                batch_id: batch_id.clone(),
                op: request.op.clone(),
                source: endpoint(
                    &item.connection_id,
                    &item.path,
                    "file",
                    &leaf_name(&item.name),
                ),
                dest: endpoint(
                    &request.dest_connection_id,
                    &final_path,
                    "file",
                    &leaf_name(&dest_rel),
                ),
                route: route.clone(),
                route_reason: route_reason.clone(),
                state: FileTransferState::Queued,
                bytes_done: 0.0,
                bytes_total: item.size,
                speed_bps: None,
                error: None,
                progress: 0.0,
                source_fingerprint: None,
                partial_path: None,
            };
            created.push(job_id.clone());
            self.jobs.lock().await.insert(job_id.clone(), job.clone());
            emit_job(sink.as_ref(), &job).await;
            FileTransferEngine::spawn_job(Arc::clone(self), host.clone(), sink.clone(), job_id);
        }

        if created.is_empty() {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "全部目标已存在且策略为跳过",
            ));
        }
        self.persist().await;
        Ok(batch_id)
    }

    pub async fn retry(
        self: &Arc<Self>,
        host: Arc<dyn TransferHost>,
        sink: Arc<dyn TransferEventSink>,
        job_id: &str,
    ) -> Result<(), OmniError> {
        {
            let mut jobs = self.jobs.lock().await;
            let job = jobs
                .get_mut(job_id)
                .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "任务不存在"))?;
            if !matches!(
                job.state,
                FileTransferState::Error | FileTransferState::Cancelled
            ) {
                return Err(OmniError::new(ErrorCode::InvalidInput, "任务不可重试"));
            }
            job.state = FileTransferState::Queued;
            job.error = None;
            job.progress = 0.0;
            job.bytes_done = 0.0;
            emit_job(sink.as_ref(), job).await;
        }
        FileTransferEngine::spawn_job(Arc::clone(self), host, sink, job_id.to_string());
        Ok(())
    }

    fn spawn_job(
        engine: Arc<Self>,
        host: Arc<dyn TransferHost>,
        sink: Arc<dyn TransferEventSink>,
        job_id: String,
    ) {
        let cancel = Arc::new(AtomicBool::new(false));

        tokio::spawn(async move {
            {
                let mut flags = engine.cancel_flags.lock().await;
                flags.insert(job_id.clone(), cancel.clone());
            }

            let sem = engine.semaphore.lock().await.clone();
            let _permit = match sem.acquire_owned().await {
                Ok(p) => p,
                Err(_) => return,
            };

            if cancel.load(Ordering::Relaxed) {
                return;
            }

            let mut job = {
                let jobs = engine.jobs.lock().await;
                match jobs.get(&job_id) {
                    Some(j) => j.clone(),
                    None => return,
                }
            };

            if matches!(job.state, FileTransferState::Cancelled) {
                return;
            }

            let run_result = match job.route.clone() {
                FileTransferRoute::Fastpath => {
                    run_fastpath(sink.as_ref(), host.as_ref(), &mut job, cancel.clone()).await
                }
                FileTransferRoute::RemoteDirect => {
                    match run_remote_direct(sink.as_ref(), host.as_ref(), &mut job, cancel.clone())
                        .await
                    {
                        Ok(()) => Ok(()),
                        Err(e) if e.message.contains("已取消") => Err(e),
                        Err(e) => {
                            job.route = FileTransferRoute::Relay;
                            job.route_reason = format!("直传失败已回落中继：{}", e.message);
                            emit_job(sink.as_ref(), &job).await;
                            run_relay_with_engine(
                                sink.as_ref(),
                                host.as_ref(),
                                Some(&engine),
                                &mut job,
                                cancel.clone(),
                            )
                            .await
                        }
                    }
                }
                FileTransferRoute::Relay => {
                    run_relay_with_engine(
                        sink.as_ref(),
                        host.as_ref(),
                        Some(&engine),
                        &mut job,
                        cancel.clone(),
                    )
                    .await
                }
            };

            match run_result {
                Ok(()) => {
                    if cancel.load(Ordering::Relaxed) {
                        job.state = FileTransferState::Cancelled;
                        job.error = Some("已取消".into());
                    } else {
                        job.state = FileTransferState::Done;
                        job.progress = 100.0;
                        job.error = None;
                        if matches!(job.op, FileTransferOp::Move)
                            && !matches!(job.route, FileTransferRoute::Fastpath)
                        {
                            let _ = delete_source_after_move(host.as_ref(), &job).await;
                        }
                    }
                }
                Err(e) => {
                    if cancel.load(Ordering::Relaxed) || e.message.contains("已取消") {
                        job.state = FileTransferState::Cancelled;
                        job.error = Some("已取消".into());
                    } else {
                        job.state = FileTransferState::Error;
                        job.error = Some(e.user_message());
                    }
                }
            }

            {
                let mut jobs = engine.jobs.lock().await;
                jobs.insert(job_id.clone(), job.clone());
            }
            emit_job(sink.as_ref(), &job).await;
            engine.persist().await;
            engine.cancel_flags.lock().await.remove(&job_id);
        });
    }
}

async fn delete_source_after_move(
    host: &dyn TransferHost,
    job: &FileTransferJob,
) -> Result<(), OmniError> {
    if job.source.connection_id == host.local_connection_id() {
        let src = host.resolve_local_path(&job.source.path)?;
        tokio::fs::remove_file(src).await.map_err(|e| {
            OmniError::new(ErrorCode::Io, "剪切后删除源文件失败").with_cause(e.to_string())
        })?;
        return Ok(());
    }
    if let Ok(session) = open_sftp(host, &job.source.connection_id).await {
        let _ = session.sftp_remove(&job.source.path).await;
    }
    Ok(())
}

fn op_to_str(op: &FileTransferOp) -> &'static str {
    match op {
        FileTransferOp::Copy => "copy",
        FileTransferOp::Move => "move",
    }
}

fn route_to_str(route: &FileTransferRoute) -> &'static str {
    match route {
        FileTransferRoute::Fastpath => "fastpath",
        FileTransferRoute::RemoteDirect => "remoteDirect",
        FileTransferRoute::Relay => "relay",
    }
}

fn state_to_str(state: &FileTransferState) -> &'static str {
    match state {
        FileTransferState::Queued => "queued",
        FileTransferState::Probing => "probing",
        FileTransferState::Running => "running",
        FileTransferState::Done => "done",
        FileTransferState::Error => "error",
        FileTransferState::Cancelled => "cancelled",
    }
}

fn str_to_op(s: &str) -> FileTransferOp {
    match s {
        "move" => FileTransferOp::Move,
        _ => FileTransferOp::Copy,
    }
}

fn str_to_route(s: &str) -> FileTransferRoute {
    match s {
        "remoteDirect" => FileTransferRoute::RemoteDirect,
        "relay" => FileTransferRoute::Relay,
        _ => FileTransferRoute::Fastpath,
    }
}

fn str_to_state(s: &str) -> FileTransferState {
    match s {
        "probing" => FileTransferState::Probing,
        "running" => FileTransferState::Running,
        "done" => FileTransferState::Done,
        "error" => FileTransferState::Error,
        "cancelled" => FileTransferState::Cancelled,
        _ => FileTransferState::Queued,
    }
}

fn job_to_record(job: &FileTransferJob) -> FileTransferJobRecord {
    let now = now_ms();
    FileTransferJobRecord {
        id: job.id.clone(),
        batch_id: job.batch_id.clone(),
        op: op_to_str(&job.op).into(),
        src_connection_id: job.source.connection_id.clone(),
        src_path: job.source.path.clone(),
        src_kind: job.source.kind.clone(),
        src_name: job.source.name.clone(),
        dst_connection_id: job.dest.connection_id.clone(),
        dst_path: job.dest.path.clone(),
        dst_kind: job.dest.kind.clone(),
        dst_name: job.dest.name.clone(),
        route: route_to_str(&job.route).into(),
        route_reason: job.route_reason.clone(),
        state: state_to_str(&job.state).into(),
        bytes_done: job.bytes_done,
        bytes_total: job.bytes_total,
        speed_bps: job.speed_bps,
        progress: job.progress,
        error: job.error.clone(),
        source_fingerprint: job.source_fingerprint.clone(),
        partial_path: job.partial_path.clone(),
        created_at: now as i64,
        updated_at: now as i64,
    }
}

fn record_to_job(rec: &FileTransferJobRecord) -> Result<FileTransferJob, OmniError> {
    Ok(FileTransferJob {
        id: rec.id.clone(),
        batch_id: rec.batch_id.clone(),
        op: str_to_op(&rec.op),
        source: FileTransferEndpoint {
            connection_id: rec.src_connection_id.clone(),
            path: rec.src_path.clone(),
            kind: rec.src_kind.clone(),
            name: rec.src_name.clone(),
        },
        dest: FileTransferEndpoint {
            connection_id: rec.dst_connection_id.clone(),
            path: rec.dst_path.clone(),
            kind: rec.dst_kind.clone(),
            name: rec.dst_name.clone(),
        },
        route: str_to_route(&rec.route),
        route_reason: rec.route_reason.clone(),
        state: str_to_state(&rec.state),
        bytes_done: rec.bytes_done,
        bytes_total: rec.bytes_total,
        speed_bps: rec.speed_bps,
        error: rec.error.clone(),
        progress: rec.progress,
        source_fingerprint: rec.source_fingerprint.clone(),
        partial_path: rec.partial_path.clone(),
    })
}
