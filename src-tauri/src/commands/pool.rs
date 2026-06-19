use omnipanel_error::OmniError;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::state::AppState;

/// 单类连接的活跃 / 空闲统计。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolCategorySummary {
    pub kind: String,
    pub active: u32,
    pub idle: u32,
}

/// 全局连接池汇总。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolSummary {
    pub active: u32,
    pub idle: u32,
    pub categories: Vec<PoolCategorySummary>,
}

fn cat(kind: &str, active: u32, idle: u32) -> PoolCategorySummary {
    PoolCategorySummary {
        kind: kind.to_string(),
        active,
        idle,
    }
}

/// 汇总各模块在后端持有的会话与可复用连接，供状态栏连接池指示器展示。
#[tauri::command]
#[specta::specta]
pub async fn pool_get_summary(state: State<'_, AppState>) -> Result<PoolSummary, OmniError> {
    let ssh_interactive = state.ssh_sessions.lock().await.len() as u32;
    let ssh_pool = state.ssh_pool.active_session_ids().await.len() as u32;
    let ssh_sftp = state.file_sftp_sessions.lock().await.len() as u32;
    let ssh_tunnels = state.ssh_tunnels.lock().await.len() as u32;
    let ssh_monitoring = state.ssh_pool.monitoring_host_count().await as u32;

    // 交互终端 / SFTP / 隧道 / 监控轮询视为活跃；SSH 池内保活会话视为空闲。
    let ssh_active = ssh_interactive + ssh_sftp + ssh_tunnels + ssh_monitoring;
    let ssh_idle = ssh_pool.saturating_sub(ssh_monitoring.min(ssh_pool));

    let docker_exec = state.docker_exec_sessions.lock().await.len() as u32;
    let docker_logs = state.docker_log_streams.lock().await.len() as u32;
    let docker_stats = state.docker_stats_streams.lock().await.len() as u32;
    let docker_ssh = state.docker_ssh_sessions.lock().await.len() as u32;
    let docker_active = docker_exec + docker_logs + docker_stats;
    let docker_idle = docker_ssh;

    let protocol_active = state.serial_sessions.lock().await.len() as u32
        + state.ws_sessions.lock().await.len() as u32
        + state.mqtt_sessions.lock().await.len() as u32
        + state.grpc_sessions.lock().await.len() as u32
        + state.sniffer_sessions.lock().await.len() as u32
        + state.modbus_sessions.lock().await.len() as u32;

    let terminal_active = state.terminal_sessions.lock().await.len() as u32;

    let db_list = state.db_connections.list()?;
    let mut db_idle = 0u32;
    let mut redis_idle = 0u32;
    for conn in &db_list {
        if !conn.enabled {
            continue;
        }
        if conn.db_type.eq_ignore_ascii_case("redis") {
            redis_idle += 1;
        } else {
            db_idle += 1;
        }
    }

    let categories = vec![
        cat("ssh", ssh_active, ssh_idle),
        cat("docker", docker_active, docker_idle),
        cat("database", 0, db_idle),
        cat("redis", 0, redis_idle),
        cat("protocol", protocol_active, 0),
        cat("terminal", terminal_active, 0),
    ];

    let active = categories.iter().map(|c| c.active).sum();
    let idle = categories.iter().map(|c| c.idle).sum();

    Ok(PoolSummary {
        active,
        idle,
        categories,
    })
}
