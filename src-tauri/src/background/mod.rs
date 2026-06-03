pub mod ssh_pool;

use std::sync::Arc;

use omnipanel_store::Storage;
pub use ssh_pool::{HostSystemStats, SshHostOverview, SshPool};

/// Background scheduler — SSH 端口可达性探测与周期复检。
pub struct BackgroundScheduler;

impl BackgroundScheduler {
    /// 启动 SSH 端口探测与后台复检循环。
    pub fn start(pool: Arc<SshPool>, storage: Arc<tokio::sync::Mutex<Storage>>, app_handle: tauri::AppHandle) {
        tauri::async_runtime::spawn(async move {
            pool.start(storage, app_handle).await;
        });

        tracing::info!("Background scheduler started");
    }
}
