use std::collections::HashMap;

use serde::Serialize;
use tauri::Emitter;
use tracing::warn;

use omnipanel_ssh::SshSession;

/// Parsed system stats for a single host
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSystemStats {
    pub host_id: String,
    pub host_name: String,
    pub load: String,
    pub cpu_cores: u32,
    pub cpu_usage: f64,
    pub memory: MemoryStats,
    pub disk: DiskStats,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

/// Single remote script that gathers all system stats in one SSH call
const STATS_SCRIPT: &str = r#"
echo "load=$(cat /proc/loadavg | cut -d' ' -f1-3)";
echo "cores=$(nproc)";
echo "cpu=$(top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}')";
echo "mem=$(free -b | grep Mem | awk '{print $2,$3,$4}')";
echo "disk=$(df -B1 / | tail -1 | awk '{print $2,$3,$4}')"
"#;

/// Collect system stats for all connected SSH sessions and emit to frontend.
pub async fn collect_all(
    sessions: &HashMap<String, SshSession>,
    app_handle: &tauri::AppHandle,
) {
    if sessions.is_empty() {
        return;
    }

    let mut results = Vec::with_capacity(sessions.len());

    for (session_id, session) in sessions.iter() {
        let host_name = session_id.clone();
        match session.exec_command(STATS_SCRIPT).await {
            Ok(output) => {
                if let Some(stats) = parse_stats(session_id, &host_name, &output) {
                    results.push(stats);
                }
            }
            Err(e) => {
                warn!("[{host_name}] stats collection failed: {e}");
            }
        }
    }

    if !results.is_empty() {
        let _ = app_handle.emit("ssh-system-stats", &results);
    }
}

fn parse_stats(session_id: &str, host_name: &str, output: &str) -> Option<HostSystemStats> {
    let mut map = HashMap::new();
    for line in output.lines() {
        if let Some((key, value)) = line.split_once('=') {
            map.insert(key.trim().to_string(), value.trim().to_string());
        }
    }

    let load = map.get("load").cloned().unwrap_or_default();
    let cpu_cores: u32 = map
        .get("cores")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let cpu_usage: f64 = map
        .get("cpu")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0.0);

    let memory = parse_mem(map.get("mem").map(String::as_str).unwrap_or(""));
    let disk = parse_disk(map.get("disk").map(String::as_str).unwrap_or(""));

    Some(HostSystemStats {
        host_id: session_id.to_string(),
        host_name: host_name.to_string(),
        load,
        cpu_cores,
        cpu_usage,
        memory,
        disk,
        timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    })
}

fn parse_mem(raw: &str) -> MemoryStats {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    let total = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let used = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let available = parts.get(3).or(parts.get(2)).and_then(|s| s.parse().ok()).unwrap_or(0);
    MemoryStats { total, used, available }
}

fn parse_disk(raw: &str) -> DiskStats {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    let total = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let used = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let available = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    DiskStats { total, used, available }
}
