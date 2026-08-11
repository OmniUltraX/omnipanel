//! 连接池汇总（状态栏指示器）。

use omnipanel_error::OmniResult;
use serde::Serialize;

use crate::terminal::ServerState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolCategorySummary {
    pub kind: String,
    pub active: u32,
    pub idle: u32,
}

#[derive(Debug, Clone, Serialize)]
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

/// 汇总 Web 端持有的会话，供状态栏连接池指示器展示。
pub async fn pool_get_summary(state: &ServerState) -> OmniResult<PoolSummary> {
    let ssh_interactive = state.ssh_sessions.lock().await.len() as u32;
    let ssh_pool = state.docker_ssh_sessions.lock().await.len() as u32;
    let ssh_sftp = state.file_sftp_sessions.lock().await.len() as u32;
    let ssh_tunnels = state.ssh_tunnels.lock().await.len() as u32;

    let ssh_active = ssh_interactive + ssh_sftp + ssh_tunnels;
    let ssh_idle = ssh_pool;

    let docker_exec = state.docker_exec_sessions.lock().await.len() as u32;
    let docker_logs = state.docker_log_streams.lock().await.len() as u32;
    let docker_stats = state.docker_stats_streams.lock().await.len() as u32;
    let docker_ssh = state.docker_ssh_sessions.lock().await.len() as u32;
    let docker_active = docker_exec + docker_logs + docker_stats;
    let docker_idle = docker_ssh;

    let terminal_active = state.terminal_sessions.lock().await.len() as u32;

    let db_list = state.db_connections.list().unwrap_or_default();
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
        cat("protocol", 0, 0),
        cat("terminal", terminal_active, 0),
        cat("background", 0, 0),
    ];

    let active = categories.iter().map(|c| c.active).sum();
    let idle = categories.iter().map(|c| c.idle).sum();

    Ok(PoolSummary {
        active,
        idle,
        categories,
    })
}
