use omnipanel_error::OmniError;
use omnipanel_ssh::{SshProcessDetail, SshProcessInfo};

use crate::background::{HostSystemStats, local_system};

/// 拉取本机 CPU / 内存 / 磁盘指标。
#[tauri::command]
#[specta::specta]
pub async fn local_fetch_stats() -> Result<HostSystemStats, OmniError> {
    tokio::task::spawn_blocking(local_system::fetch_stats)
        .await
        .map_err(|e| OmniError::internal(format!("本机指标采集失败: {e}")))?
}

/// 列出本机进程。
#[tauri::command]
#[specta::specta]
pub async fn local_list_processes() -> Result<Vec<SshProcessInfo>, OmniError> {
    tokio::task::spawn_blocking(local_system::list_processes)
        .await
        .map_err(|e| OmniError::internal(format!("本机进程列表采集失败: {e}")))?
}

/// 查询本机进程详情。
#[tauri::command]
#[specta::specta]
pub async fn local_process_detail(pid: u32) -> Result<SshProcessDetail, OmniError> {
    tokio::task::spawn_blocking(move || local_system::process_detail(pid))
        .await
        .map_err(|e| OmniError::internal(format!("本机进程详情采集失败: {e}")))?
}

/// 强制终止本机进程。
#[tauri::command]
#[specta::specta]
pub async fn local_kill_process(pid: u32) -> Result<(), OmniError> {
    tokio::task::spawn_blocking(move || local_system::kill_process(pid))
        .await
        .map_err(|e| OmniError::internal(format!("终止本机进程失败: {e}")))?
}
