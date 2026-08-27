//! 跨连接文件传输共享引擎（无 Tauri 依赖）。

pub mod engine;
pub mod event;
pub mod expand;
pub mod fastpath;
pub mod provider;
pub mod rate_limit;
pub mod relay;
pub mod remote_direct;
pub mod resume;
pub mod stream_relay;
pub mod types;
pub mod util;
pub mod web_engine;

pub use engine::FileTransferEngine;
pub use event::{TransferEventSink, emit_job};
pub use provider::{
    LOCAL_CONNECTION_ID, SessionProvider, SftpEndpointInfo, TransferDirEntry, TransferHost,
    TransferProtocol,
};
pub use relay::{
    TransferJob as RelayTransferJob, TransferStartRequest, TransferState, dest_final_path,
    relay_local_dest, relay_sftp_dest, relay_sftp_sftp, transfer_cancel, transfer_start,
};
pub use types::{
    FileTransferConflictPolicy, FileTransferEndpoint, FileTransferEnqueueRequest,
    FileTransferItemSpec, FileTransferJob, FileTransferListResult, FileTransferOp,
    FileTransferPlanRequest, FileTransferPlanResult, FileTransferRoute, FileTransferState,
    TRANSFER_PROGRESS_EVENT,
};
pub use web_engine::WebFileTransferEngine;
