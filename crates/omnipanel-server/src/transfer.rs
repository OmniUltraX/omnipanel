//! Web 端跨连接文件传输 relay（薄适配 `omnipanel-transfer`）。

use std::sync::Arc;

pub use omnipanel_transfer::{
    TRANSFER_PROGRESS_EVENT,
    relay::{
        TransferJob, TransferStartRequest, TransferState, transfer_cancel as relay_cancel,
        transfer_start as relay_start,
    },
};

use crate::terminal::ServerState;
use crate::transfer_host::{transfer_host, transfer_sink};

pub async fn transfer_start(
    state: Arc<ServerState>,
    req: TransferStartRequest,
) -> Result<String, String> {
    relay_start(
        transfer_host(state.clone()),
        transfer_sink(state.bus.clone()),
        state.transfer_cancel_flags.clone(),
        req,
    )
    .await
}

pub async fn transfer_cancel(state: &ServerState, id: String) -> Result<(), String> {
    relay_cancel(&state.transfer_cancel_flags, id).await
}

pub async fn transfer_list() -> Result<Vec<TransferJob>, String> {
    Ok(Vec::new())
}
