//! Tauri 适配：将 `AppHandle` / `SshPool` 桥接到 `omnipanel-db-sync`。

use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_db_sync::{
    BgTaskDbEvent, BgTaskMysqlExportEvent, DbSyncEventSink, MysqlExportEventSink,
    SyncExecResultEvent, SshSessionProvider,
};
use omnipanel_error::OmniResult;
use omnipanel_ssh::SshSession;
use tauri::{AppHandle, Emitter};

use crate::background::ssh_pool::SshPool;

pub struct TauriDbSyncSink(pub AppHandle);

#[async_trait]
impl DbSyncEventSink for TauriDbSyncSink {
    async fn emit_db_event(&self, event: BgTaskDbEvent) {
        let _ = self.0.emit("bg-task-db-event", &event);
    }

    async fn emit_exec_event(&self, task_id: &str, result: SyncExecResultEvent) {
        self.emit_db_event(BgTaskDbEvent {
            task_id: task_id.to_string(),
            event_type: "exec_result".to_string(),
            table: Some(result.table.clone()),
            count: None,
            row_result: None,
            schema_result: None,
            exec_result: Some(result),
        })
        .await;
    }
}

pub struct TauriMysqlExportSink(pub AppHandle);

#[async_trait]
impl MysqlExportEventSink for TauriMysqlExportSink {
    async fn emit_export_event(&self, event: BgTaskMysqlExportEvent) {
        let _ = self.0.emit("bg-task-mysql-export-event", &event);
    }
}

pub struct TauriSshSessionProvider(pub Arc<SshPool>);

#[async_trait]
impl SshSessionProvider for TauriSshSessionProvider {
    async fn ensure_session(&self, id: &str) -> Result<Arc<SshSession>, String> {
        self.0
            .ensure_session(id)
            .await
            .map_err(|e| e.user_message())
    }
}

pub fn db_sync_sink(app: AppHandle) -> Arc<dyn DbSyncEventSink> {
    Arc::new(TauriDbSyncSink(app))
}

pub fn mysql_export_sink(app: AppHandle) -> Arc<dyn MysqlExportEventSink> {
    Arc::new(TauriMysqlExportSink(app))
}

pub fn ssh_session_provider(pool: Arc<SshPool>) -> Arc<dyn SshSessionProvider> {
    Arc::new(TauriSshSessionProvider(pool))
}
