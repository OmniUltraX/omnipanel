//! 按团队切换本机 SQLite / 连接 JSON / 文件索引（进程内换库）。

use omnipanel_error::OmniError;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::output_buffer;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StorageSwitchTeamResult {
    pub team_scope: String,
    /// 目标团队本机目录在打开前没有主库，可安全拉取云端快照。
    pub empty: bool,
}

async fn teardown_runtime_sessions(state: &AppState) {
    {
        let mut sessions = state.terminal_sessions.lock().await;
        let ids: Vec<String> = sessions.keys().cloned().collect();
        for id in ids {
            if let Some(mut session) = sessions.remove(&id) {
                let _ = session.kill();
            }
            output_buffer::remove(&state.output_buffers, &id);
        }
    }

    {
        let mut ssh = state.ssh_sessions.lock().await;
        for (_, session) in ssh.drain() {
            session.disconnect().await;
        }
    }

    for id in state.ssh_pool.connected_ids().await {
        state.ssh_pool.release_session(&id).await;
    }

    {
        let mut docker_ssh = state.docker_ssh_sessions.lock().await;
        for (_, session) in docker_ssh.drain() {
            session.disconnect().await;
        }
    }

    {
        let mut execs = state.docker_exec_sessions.lock().await;
        execs.clear();
    }

    for flag in state.docker_log_streams.lock().await.values() {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    state.docker_log_streams.lock().await.clear();
    for flag in state.docker_stats_streams.lock().await.values() {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    state.docker_stats_streams.lock().await.clear();

    {
        let mut queries = state.running_db_queries.lock().await;
        for handle in queries.drain().map(|(_, h)| h) {
            handle.abort();
        }
    }
    state.db_query_sessions.lock().await.clear();

    {
        let mut sftp = state.file_sftp_sessions.lock().await;
        for (_, session) in sftp.drain() {
            session.disconnect().await;
        }
    }

    state.serial_sessions.lock().await.clear();
    state.ws_sessions.lock().await.clear();
    state.sse_sessions.lock().await.clear();
    state.mqtt_sessions.lock().await.clear();
    state.redis_pubsub_sessions.lock().await.clear();
    state.grpc_sessions.lock().await.clear();
    state.sniffer_sessions.lock().await.clear();
    state.modbus_sessions.lock().await.clear();

    omnipanel_db::sidecar::evict_all_launches().await;
}

/// 切换本机业务数据目录到指定团队（`local` 或数字 id）。
#[tauri::command]
#[specta::specta]
pub async fn storage_switch_team(
    state: State<'_, AppState>,
    team_scope: String,
) -> Result<StorageSwitchTeamResult, OmniError> {
    let team_scope = omnipanel_store::normalize_team_scope(&team_scope);
    let current = omnipanel_store::active_team_scope();
    if current == team_scope {
        return Ok(StorageSwitchTeamResult {
            team_scope,
            empty: false,
        });
    }

    teardown_runtime_sessions(&state).await;

    {
        let mut storage = state.storage.lock().await;
        *storage = omnipanel_store::Storage::open_in_memory()?;
    }
    {
        let mut index = state.file_index_storage.lock().await;
        *index = omnipanel_store::FileIndexStorage::open_in_memory()?;
    }

    if current == omnipanel_store::LOCAL_TEAM_SCOPE
        && team_scope != omnipanel_store::LOCAL_TEAM_SCOPE
    {
        let _ = omnipanel_store::promote_local_dir_to_team(&team_scope);
    }

    omnipanel_store::set_active_team_scope(&team_scope);
    omnipanel_store::persist_active_team_scope(&team_scope)?;

    let empty = !omnipanel_store::meta_db_exists_on_disk()
        && !omnipanel_store::database_connections_path()
            .map(|p| p.is_file())
            .unwrap_or(false);

    let db_path = omnipanel_store::meta_db_path()?;
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    {
        let mut storage = state.storage.lock().await;
        *storage = omnipanel_store::Storage::open(&db_path, None)?;
    }
    state.db_connections.reload_from_disk()?;

    let configured = state.file_index_storage_dir.lock().await.clone();
    {
        let mut index = state.file_index_storage.lock().await;
        *index = omnipanel_store::FileIndexStorage::open_at_dir(&configured)?;
    }

    state
        .ssh_pool
        .reload_hosts(state.storage.clone(), state.app_handle.clone(), false)
        .await;

    tracing::info!(scope = %team_scope, empty, "已切换本机团队数据目录");
    Ok(StorageSwitchTeamResult { team_scope, empty })
}
