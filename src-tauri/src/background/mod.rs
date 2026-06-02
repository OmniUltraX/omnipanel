mod ssh_pool;

use std::sync::Arc;

use omnipanel_store::Storage;
use tokio::sync::Mutex;

use crate::log_store::LogStore;
use ssh_pool::SshPool;

/// Background scheduler — manages the SSH connection pool and periodic tasks.
pub struct BackgroundScheduler;

impl BackgroundScheduler {
    /// Start the SSH connection pool and background loops.
    /// Reads all SSH connections from storage, connects to each, and starts
    /// periodic health checks + stats collection.
    pub fn start(storage: Arc<Mutex<Storage>>, log_store: LogStore, app_handle: tauri::AppHandle) {
        let pool = SshPool::new(log_store);

        tauri::async_runtime::spawn(async move {
            pool.start(storage, app_handle).await;
        });

        tracing::info!("Background scheduler started");
    }
}
