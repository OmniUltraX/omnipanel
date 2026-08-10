//! 传输进度事件出口（由 Tauri / Web EventBus 实现）。

use async_trait::async_trait;

use crate::types::FileTransferJob;

/// 传输任务进度事件出口。
#[async_trait]
pub trait TransferEventSink: Send + Sync {
    async fn emit_transfer_job(&self, job: &FileTransferJob);
}

pub async fn emit_job(sink: &dyn TransferEventSink, job: &FileTransferJob) {
    sink.emit_transfer_job(job).await;
}
