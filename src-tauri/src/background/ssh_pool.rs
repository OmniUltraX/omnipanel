use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use omnipanel_ssh::{SshAuth, SshConfig, SshSession, load_ssh_config_hosts, ssh_config_to_connect_config};
use omnipanel_store::{ConnectionKind, Storage};
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::log_store::LogStore;

// ── Status event ─────────────────────────────────────────────────────────

/// 发射到前端的单个主机连接状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatusEvent {
    pub resource_id: String,
    pub status: String,
    pub error: Option<String>,
}

// ── Pool internals ───────────────────────────────────────────────────────

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

const STATS_SCRIPT: &str = r#"
echo "load=$(cat /proc/loadavg | cut -d' ' -f1-3)";
echo "cores=$(nproc)";
echo "cpu=$(top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}')";
echo "mem=$(free -b | grep Mem | awk '{print $2,$3,$4}')";
echo "disk=$(df -B1 / | tail -1 | awk '{print $2,$3,$4}')"
"#;

struct ConnSpec {
    resource_id: String,
    name: String,
    config: SshConfig,
}

struct PoolEntry {
    session: Option<SshSession>,
    status: String,
    error: Option<String>,
    host_name: String,
    #[allow(dead_code)]
    config: SshConfig,
}

/// SSH 连接池：管理所有已配置主机的长连接，提供状态监控与资源采集。
pub struct SshPool {
    entries: Arc<Mutex<HashMap<String, PoolEntry>>>,
    log: LogStore,
}

#[allow(dead_code)]
impl SshPool {
    pub fn new(log: LogStore) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            log,
        }
    }

    const CONFIG_HOST_PREFIX: &str = "openssh:";

    /// 并发连接所有 SSH 主机，先标记 connecting，完成后更新状态。
    pub async fn start(
        &self,
        storage: Arc<Mutex<Storage>>,
        app_handle: tauri::AppHandle,
    ) {
        self.log.log("ssh-pool", "info", "SSH 连接池启动中…").await;

        // ── 1. 已保存连接 ────────────────────────────────────────────────
        let connections = {
            let guard = storage.lock().await;
            match guard.list_connections_by_kind(ConnectionKind::Ssh) {
                Ok(list) => list,
                Err(e) => {
                    error!("SSH 池读取连接列表失败: {e}");
                    self.log.log("ssh-pool", "error", &format!("读取连接列表失败: {e}")).await;
                    Vec::new()
                }
            }
        };

        self.log.log("ssh-pool", "info", &format!("已保存连接: {} 个", connections.len())).await;

        // ── 2. ~/.ssh/config 主机 ─────────────────────────────────────────
        let config_hosts = match load_ssh_config_hosts() {
            Ok(hosts) => {
                self.log.log("ssh-pool", "info", &format!("~/.ssh/config 主机: {} 个", hosts.len())).await;
                hosts
            }
            Err(e) => {
                warn!("SSH 池：加载 ~/.ssh/config 失败: {e}");
                self.log.log("ssh-pool", "warn", &format!("加载 ~/.ssh/config 失败: {e}")).await;
                Vec::new()
            }
        };

        let mut specs: Vec<ConnSpec> = Vec::new();
        let mut seen_ids = std::collections::HashSet::new();

        // 已保存连接（解析配置，失败则直接标记 error）
        for conn in &connections {
            match serde_json::from_str::<SshConfig>(&conn.config) {
                Ok(config) => {
                    specs.push(ConnSpec {
                        resource_id: conn.id.clone(),
                        name: conn.name.clone(),
                        config,
                    });
                    seen_ids.insert(conn.id.clone());
                }
                Err(e) => {
                    warn!("SSH 池：连接 {} 配置解析失败: {e}", conn.name);
                    self.log.log("ssh-pool", "warn", &format!("{} 配置解析失败: {e}", conn.name)).await;
                    self.entries.lock().await.insert(
                        conn.id.clone(),
                        PoolEntry {
                            session: None,
                            status: "error".into(),
                            error: Some(format!("配置解析失败: {e}")),
                            host_name: conn.name.clone(),
                            config: SshConfig {
                                host: String::new(),
                                port: 22,
                                user: String::new(),
                                auth: SshAuth::Password {
                                    password: String::new(),
                                },
                            },
                        },
                    );
                    emit_status(&app_handle, &conn.id, "error", Some(&format!("配置解析失败: {e}")));
                }
            }
        }

        // ~/.ssh/config 主机
        for host in &config_hosts {
            let resource_id = format!("{}{}", Self::CONFIG_HOST_PREFIX, host.alias);
            if seen_ids.contains(&resource_id) {
                continue;
            }
            match ssh_config_to_connect_config(host) {
                Ok(config) => {
                    specs.push(ConnSpec {
                        resource_id: resource_id.clone(),
                        name: host.alias.clone(),
                        config,
                    });
                    seen_ids.insert(resource_id);
                }
                Err(e) => {
                    self.log.log("ssh-pool", "warn", &format!("{} 配置转换失败: {e}", host.alias)).await;
                    self.entries.lock().await.insert(
                        resource_id.clone(),
                        PoolEntry {
                            session: None,
                            status: "error".into(),
                            error: Some(e.to_string()),
                            host_name: host.alias.clone(),
                            config: SshConfig {
                                host: host.host_name.clone(),
                                port: host.port.unwrap_or(22),
                                user: host.user.clone().unwrap_or_else(|| "root".into()),
                                auth: SshAuth::Password {
                                    password: String::new(),
                                },
                            },
                        },
                    );
                    emit_status(&app_handle, &resource_id, "error", Some(&e.to_string()));
                }
            }
        }

        if specs.is_empty() {
            info!("SSH 池：无任何可连接的 SSH 主机");
            self.log.log("ssh-pool", "info", "无任何可连接的 SSH 主机").await;
            self.emit_all_status(&app_handle).await;
            // 即使没有可连接主机，仍启动后台循环（健康检查可能重连 error 条目）
            let entries = self.entries.clone();
            let handle = app_handle.clone();
            let log = self.log.clone();
            Self::spawn_background_loop(entries, handle, log);
            return;
        }

        self.log.log("ssh-pool", "info", &format!("共 {} 个主机，开始并发连接", specs.len())).await;

        // ── 3. 先插入 connecting 状态，立即通知前端 ──────────────────────
        {
            let mut pool = self.entries.lock().await;
            for spec in &specs {
                pool.insert(
                    spec.resource_id.clone(),
                    PoolEntry {
                        session: None,
                        status: "connecting".into(),
                        error: None,
                        host_name: spec.name.clone(),
                        config: spec.config.clone(),
                    },
                );
            }
        }
        for spec in &specs {
            emit_status(&app_handle, &spec.resource_id, "connecting", None);
        }

        // ── 4. 并发连接：每个主机一个 task，完成即更新 ────────────────────
        let entries = self.entries.clone();
        for spec in specs {
            let entries = entries.clone();
            let app = app_handle.clone();
            let log = self.log.clone();
            tokio::spawn(async move {
                log.log("ssh-pool", "info", &format!("正在连接 {}…", spec.name)).await;
                match SshSession::connect_no_shell(spec.config.clone()).await {
                    Ok(session) => {
                        info!("SSH 池：{} 已连接", spec.name);
                        log.log("ssh-pool", "info", &format!("{} 已连接", spec.name)).await;
                        // 立即采集首次 stats
                        let mut initial_stats: Option<HostSystemStats> = None;
                        match session.exec_command(STATS_SCRIPT).await {
                            Ok(output) => {
                                initial_stats = SshPool::parse_stats(&spec.resource_id, &spec.name, &output);
                            }
                            Err(e) => {
                                log.log("ssh-pool", "warn", &format!("{} 首次 stats 采集失败: {e}", spec.name)).await;
                            }
                        }
                        let mut pool = entries.lock().await;
                        pool.insert(
                            spec.resource_id.clone(),
                            PoolEntry {
                                session: Some(session),
                                status: "connected".into(),
                                error: None,
                                host_name: spec.name.clone(),
                                config: spec.config.clone(),
                            },
                        );
                        drop(pool);
                        emit_status(&app, &spec.resource_id, "connected", None);
                        if let Some(stats) = initial_stats {
                            let _ = app.emit("ssh-system-stats", &vec![stats]);
                        }
                    }
                    Err(e) => {
                        warn!("SSH 池：{} 连接失败: {e}", spec.name);
                        log.log("ssh-pool", "error", &format!("{} 连接失败: {e}", spec.name)).await;
                        let mut pool = entries.lock().await;
                        pool.insert(
                            spec.resource_id.clone(),
                            PoolEntry {
                                session: None,
                                status: "error".into(),
                                error: Some(e.to_string()),
                                host_name: spec.name.clone(),
                                config: spec.config,
                            },
                        );
                        drop(pool);
                        emit_status(&app, &spec.resource_id, "error", Some(&e.to_string()));
                    }
                }
            });
        }

        // ── 5. 启动后台循环 ──────────────────────────────────────────────
        Self::spawn_background_loop(self.entries.clone(), app_handle, self.log.clone());
    }

    fn spawn_background_loop(
        entries: Arc<Mutex<HashMap<String, PoolEntry>>>,
        app_handle: tauri::AppHandle,
        log: LogStore,
    ) {
        tauri::async_runtime::spawn(async move {
            let mut health_interval = tokio::time::interval(Duration::from_secs(30));
            let mut stats_interval = tokio::time::interval(Duration::from_secs(3));
            health_interval.tick().await;
            stats_interval.tick().await;
            log.log("ssh-pool", "info", "后台循环已启动").await;
            loop {
                tokio::select! {
                    _ = health_interval.tick() => {
                        Self::health_check(&entries, &app_handle, &log).await;
                    }
                    _ = stats_interval.tick() => {
                        Self::collect_all_stats(&entries, &app_handle, &log).await;
                    }
                }
            }
        });
    }

    // ── 连接管理 ────────────────────────────────────────────────────────

    // ── 状态查询 ────────────────────────────────────────────────────────

    /// 返回所有 connected 状态的 resource_id 列表（供外部模块判断在线状态）。
    pub async fn connected_ids(&self) -> Vec<String> {
        let pool = self.entries.lock().await;
        pool.iter()
            .filter(|(_, e)| e.status == "connected")
            .map(|(id, _)| id.clone())
            .collect()
    }

    // ── 健康检查 ────────────────────────────────────────────────────────

    async fn health_check(
        entries: &Arc<Mutex<HashMap<String, PoolEntry>>>,
        app_handle: &tauri::AppHandle,
        log: &LogStore,
    ) {
        let mut pool = entries.lock().await;
        let count = pool.len();
        log.log("ssh-pool", "info", &format!("健康检查开始 ({count} 个条目)")).await;
        for (resource_id, entry) in pool.iter_mut() {
            let should_check = matches!(entry.status.as_str(), "connected" | "error");
            if !should_check {
                // 仍发射当前状态，确保前端收到（初始化阶段可能错过首次 emit）
                if entry.status == "disconnected" || entry.status == "connecting" {
                    emit_status(
                        app_handle,
                        resource_id,
                        &entry.status,
                        entry.error.as_deref(),
                    );
                }
                continue;
            }

            let host = &entry.host_name;
            let alive = if let Some(session) = &entry.session {
                match session.exec_command("uptime").await {
                    Ok(_) => true,
                    Err(e) => {
                        log.log("ssh-pool", "warn", &format!("{host} uptime 检查失败: {e}")).await;
                        false
                    }
                }
            } else {
                false
            };

            if alive {
                entry.status = "connected".into();
                entry.error = None;
                emit_status(app_handle, resource_id, "connected", None);
            } else {
                log.log("ssh-pool", "warn", &format!("{host} 健康检查未通过，标记为断开")).await;
                entry.session = None;
                entry.status = "disconnected".into();
                entry.error = Some("健康检查失败".into());
                emit_status(app_handle, resource_id, "disconnected", Some("健康检查失败"));
            }
        }
    }

    // ── Stats 采集 ──────────────────────────────────────────────────────

    async fn collect_all_stats(
        entries: &Arc<Mutex<HashMap<String, PoolEntry>>>,
        app_handle: &tauri::AppHandle,
        log: &LogStore,
    ) {
        let pool = entries.lock().await;
        let mut results = Vec::new();
        let mut collected = 0u32;

        for (resource_id, entry) in pool.iter() {
            let Some(session) = &entry.session else { continue };
            if entry.status != "connected" {
                continue;
            }

            match session.exec_command(STATS_SCRIPT).await {
                Ok(output) => {
                    if let Some(stats) = Self::parse_stats(resource_id, &entry.host_name, &output)
                    {
                        results.push(stats);
                        collected += 1;
                    }
                }
                Err(e) => {
                    log.log("ssh-pool", "warn", &format!("[{}] stats 采集失败: {e}", entry.host_name)).await;
                    warn!("[{}] stats 采集失败: {e}", entry.host_name);
                }
            }
        }

        if collected > 0 {
            log.log("ssh-pool", "info", &format!("stats 采集完成: {collected} 台主机")).await;
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

        let memory = Self::parse_mem(map.get("mem").map(String::as_str).unwrap_or(""));
        let disk = Self::parse_disk(map.get("disk").map(String::as_str).unwrap_or(""));

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
        MemoryStats {
            total,
            used,
            available,
        }
    }

    fn parse_disk(raw: &str) -> DiskStats {
        let parts: Vec<&str> = raw.split_whitespace().collect();
        let total = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let used = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let available = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        DiskStats {
            total,
            used,
            available,
        }
    }

    // ── 内部辅助 ────────────────────────────────────────────────────────

    async fn emit_all_status(&self, app_handle: &tauri::AppHandle) {
        let pool = self.entries.lock().await;
        for (resource_id, entry) in pool.iter() {
            emit_status(app_handle, resource_id, &entry.status, entry.error.as_deref());
        }
    }

    async fn reconnect(_resource_id: &str, entry: &mut PoolEntry, log: &LogStore) {
        let name = &entry.host_name;
        warn!("SSH 池：正在重连 {name}");
        log.log("ssh-pool", "info", &format!("正在重连 {name}")).await;
        match SshSession::connect_no_shell(entry.config.clone()).await {
            Ok(session) => {
                entry.session = Some(session);
                entry.status = "connected".into();
                entry.error = None;
                info!("SSH 池：{name} 重连成功");
                log.log("ssh-pool", "info", &format!("{name} 重连成功")).await;
            }
            Err(e) => {
                entry.error = Some(e.to_string());
                warn!("SSH 池：{name} 重连失败: {e}");
                log.log("ssh-pool", "error", &format!("{name} 重连失败: {e}")).await;
            }
        }
    }

    /// 尝试重连所有 disconnected/error 的池连接。
    pub async fn reconnect_all(&self) {
        let mut pool = self.entries.lock().await;
        for (resource_id, entry) in pool.iter_mut() {
            if matches!(entry.status.as_str(), "disconnected" | "error") {
                Self::reconnect(resource_id, entry, &self.log).await;
            }
        }
    }
}

fn emit_status(
    app_handle: &tauri::AppHandle,
    resource_id: &str,
    status: &str,
    error: Option<&str>,
) {
    let _ = app_handle.emit(
        "ssh-pool-status",
        PoolStatusEvent {
            resource_id: resource_id.into(),
            status: status.into(),
            error: error.map(|s| s.into()),
        },
    );
}
