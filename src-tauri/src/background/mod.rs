pub mod local_system;
pub mod ssh_pool;

use std::sync::Arc;

use omnipanel_store::Storage;
pub use ssh_pool::{HostSystemStats, PoolStatusEvent, SshHostOverview, SshPool};

/// Background scheduler — SSH 连接池初始化。
pub struct BackgroundScheduler;

impl BackgroundScheduler {
    /// 启动 SSH 连接池（从存储加载配置，不做列表端口扫描）。
    pub fn start(
        pool: Arc<SshPool>,
        storage: Arc<tokio::sync::Mutex<Storage>>,
        app_handle: tauri::AppHandle,
    ) {
        tauri::async_runtime::spawn(async move {
            pool.start(storage, app_handle).await;
        });

        tracing::info!("Background scheduler started");
    }
}
