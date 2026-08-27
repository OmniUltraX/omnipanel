//! Web 端适配：将 `EventBus` / `ServerState` 桥接到 `omnipanel-db-sync`。

use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_db_sync::{
    BgTaskDbEvent, BgTaskMysqlExportEvent, DbSyncEventSink, MysqlExportEventSink,
    SshSessionProvider, SyncExecResultEvent,
};
use omnipanel_ssh::SshSession;

use crate::bus::EventBus;
use crate::monitoring::ensure_ssh_session;
use crate::terminal::ServerState;

pub struct ServerDbSyncSink(pub EventBus);

#[async_trait]
impl DbSyncEventSink for ServerDbSyncSink {
    async fn emit_db_event(&self, event: BgTaskDbEvent) {
        if let Ok(payload) = serde_json::to_value(&event) {
            self.0.emit("bg-task-db-event", payload);
        }
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

pub struct ServerMysqlExportSink(pub EventBus);

#[async_trait]
impl MysqlExportEventSink for ServerMysqlExportSink {
    async fn emit_export_event(&self, event: BgTaskMysqlExportEvent) {
        if let Ok(payload) = serde_json::to_value(&event) {
            self.0.emit("bg-task-mysql-export-event", payload);
        }
    }
}

pub struct ServerSshSessionProvider(pub Arc<ServerState>);

#[async_trait]
impl SshSessionProvider for ServerSshSessionProvider {
    async fn ensure_session(&self, id: &str) -> Result<Arc<SshSession>, String> {
        ensure_ssh_session(self.0.as_ref(), id)
            .await
            .map(|(session, _)| session)
            .map_err(|e| e.user_message())
    }
}

pub fn db_sync_sink(bus: EventBus) -> Arc<dyn DbSyncEventSink> {
    Arc::new(ServerDbSyncSink(bus))
}

pub fn mysql_export_sink(bus: EventBus) -> Arc<dyn MysqlExportEventSink> {
    Arc::new(ServerMysqlExportSink(bus))
}

pub fn ssh_session_provider(state: Arc<ServerState>) -> Arc<dyn SshSessionProvider> {
    Arc::new(ServerSshSessionProvider(state))
}
