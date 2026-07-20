pub mod db_sync_jobs;
pub mod gpu_local;
pub mod knowledge_vector_jobs;
pub mod local_ports;
pub mod local_runtime_jobs;
pub mod local_system;
pub mod mysql_export_jobs;
pub mod schema_cache_jobs;
pub mod ssh_pool;
pub mod worker_pool;

use std::sync::Arc;

use omnipanel_store::Storage;
pub use ssh_pool::{PoolStatusEvent, SshHostOverview, SshPool};
pub use worker_pool::{BackgroundWorkerPool, default_worker_count};
pub use omnipanel_ssh::HostSystemStats;

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
