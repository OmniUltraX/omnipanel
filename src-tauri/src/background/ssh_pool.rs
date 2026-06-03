use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use futures::future::join_all;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{
    SshAuth, SshConfig, SshProcessInfo, SshSession, find_ssh_config_entry, load_ssh_config_hosts,
    ssh_config_to_connect_config,
};
use omnipanel_store::{ConnectionKind, Storage};
use serde::Serialize;
use specta::Type;
use tauri::Emitter;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::log_store::LogStore;

/// 单次 TCP 探测超时（秒）
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);

const STATS_SCRIPT: &str = r#"
echo "load=$(cat /proc/loadavg | cut -d' ' -f1-3)";
echo "cores=$(nproc)";
echo "cpu=$(top -bn1 | grep 'Cpu(s)' | awk '{print $2+$4}')";
echo "mem=$(free -b | grep Mem | awk '{print $2,$3,$4}')";
echo "disk=$(df -B1 / | tail -1 | awk '{print $2,$3,$4}')";
echo "net=$(awk 'NR>2 {rx+=$2; tx+=$10} END{print rx, tx}' /proc/net/dev 2>/dev/null)";
echo "os=$(cat /etc/os-release | grep '^PRETTY_NAME=' | cut -d'"' -f2)"
"#;

// ── Status event ─────────────────────────────────────────────────────────

/// 发射到前端的单个主机连接状态
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatusEvent {
    pub resource_id: String,
    pub status: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    #[specta(type = f64)]
    pub total: u64,
    #[specta(type = f64)]
    pub used: u64,
    #[specta(type = f64)]
    pub available: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    #[specta(type = f64)]
    pub total: u64,
    #[specta(type = f64)]
    pub used: u64,
    #[specta(type = f64)]
    pub available: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStats {
    #[specta(type = f64)]
    pub rx_bytes: u64,
    #[specta(type = f64)]
    pub tx_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostSystemStats {
    pub host_id: String,
    pub host_name: String,
    pub load: String,
    pub cpu_cores: u32,
    pub cpu_usage: f64,
    pub memory: MemoryStats,
    pub disk: DiskStats,
    pub network: NetworkStats,
    pub os_info: String,
    #[specta(type = f64)]
    pub timestamp: u64,
}

/// 概览页一次加载的完整数据（系统指标 + 进程列表）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshHostOverview {
    pub stats: HostSystemStats,
    pub processes: Vec<SshProcessInfo>,
}

// ── Pool internals ───────────────────────────────────────────────────────

struct ConnSpec {
    resource_id: String,
    name: String,
    config: SshConfig,
}

struct PoolEntry {
    status: String,
    error: Option<String>,
    host_name: String,
    config: SshConfig,
}

/// SSH 连接池：后台 TCP 端口探测 + 按需建立会话（概览 / SFTP / 进程等）。
pub struct SshPool {
    entries: Arc<Mutex<HashMap<String, PoolEntry>>>,
    pool_sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
    log: LogStore,
}

#[allow(dead_code)]
impl SshPool {
    pub fn new(
        log: LogStore,
        pool_sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
    ) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            pool_sessions,
            log,
        }
    }

    const CONFIG_HOST_PREFIX: &str = "openssh:";

    /// 并发探测所有 SSH 主机的端口，先标记 connecting，完成后更新状态。
    pub async fn start(
        &self,
        storage: Arc<Mutex<Storage>>,
        app_handle: tauri::AppHandle,
    ) {
        self.log
            .log("ssh-pool", "info", "SSH 端口探测启动中…")
            .await;

        // ── 1. 已保存连接 ────────────────────────────────────────────────
        let connections = {
            let guard = storage.lock().await;
            match guard.list_connections_by_kind(ConnectionKind::Ssh) {
                Ok(list) => list,
                Err(e) => {
                    error!("SSH 池读取连接列表失败: {e}");
                    self.log
                        .log("ssh-pool", "error", &format!("读取连接列表失败: {e}"))
                        .await;
                    Vec::new()
                }
            }
        };

        self.log
            .log("ssh-pool", "info", &format!("已保存连接: {} 个", connections.len()))
            .await;

        // ── 2. ~/.ssh/config 主机 ─────────────────────────────────────────
        let config_hosts = match load_ssh_config_hosts() {
            Ok(hosts) => {
                self.log
                    .log(
                        "ssh-pool",
                        "info",
                        &format!("~/.ssh/config 主机: {} 个", hosts.len()),
                    )
                    .await;
                hosts
            }
            Err(e) => {
                warn!("SSH 池：加载 ~/.ssh/config 失败: {e}");
                self.log
                    .log("ssh-pool", "warn", &format!("加载 ~/.ssh/config 失败: {e}"))
                    .await;
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
                    self.log
                        .log("ssh-pool", "warn", &format!("{} 配置解析失败: {e}", conn.name))
                        .await;
                    self.entries.lock().await.insert(
                        conn.id.clone(),
                        PoolEntry {
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

        // ~/.ssh/config 主机（仅需 host/port 做端口探测，不要求 IdentityFile）
        for host in &config_hosts {
            let resource_id = format!("{}{}", Self::CONFIG_HOST_PREFIX, host.alias);
            if seen_ids.contains(&resource_id) {
                continue;
            }
            let config = match ssh_config_to_connect_config(host) {
                Ok(config) => config,
                Err(e) => {
                    self.log
                        .log(
                            "ssh-pool",
                            "warn",
                            &format!("{} SSH 登录配置不完整（仍探测端口）: {e}", host.alias),
                        )
                        .await;
                    SshConfig {
                        host: host.host_name.clone(),
                        port: host.port.unwrap_or(22),
                        user: host
                            .user
                            .clone()
                            .unwrap_or_else(|| std::env::var("USER").unwrap_or_else(|_| "root".into())),
                        auth: SshAuth::Password {
                            password: String::new(),
                        },
                    }
                }
            };
            specs.push(ConnSpec {
                resource_id: resource_id.clone(),
                name: host.alias.clone(),
                config,
            });
            seen_ids.insert(resource_id);
        }

        if specs.is_empty() {
            info!("SSH 池：无任何可探测的 SSH 主机");
            self.log
                .log("ssh-pool", "info", "无任何可探测的 SSH 主机")
                .await;
            self.emit_all_status(&app_handle).await;
            let entries = self.entries.clone();
            let handle = app_handle.clone();
            let log = self.log.clone();
            Self::spawn_background_loop(entries, handle, log);
            return;
        }

        self.log
            .log("ssh-pool", "info", &format!("共 {} 个主机，开始并发端口探测", specs.len()))
            .await;

        // ── 3. 先插入 connecting 状态，立即通知前端 ──────────────────────
        {
            let mut pool = self.entries.lock().await;
            for spec in &specs {
                pool.insert(
                    spec.resource_id.clone(),
                    PoolEntry {
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

        // ── 4. 并发探测：每个主机一个 task，完成即更新 ────────────────────
        let entries = self.entries.clone();
        for spec in specs {
            let entries = entries.clone();
            let app = app_handle.clone();
            let log = self.log.clone();
            tokio::spawn(async move {
                log.log("ssh-pool", "info", &format!("正在探测 {} 端口…", spec.name))
                    .await;
                Self::probe_and_update_entry(
                    &entries,
                    &app,
                    &spec.resource_id,
                    &spec.name,
                    &spec.config,
                    &log,
                )
                .await;
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
            health_interval.tick().await;
            log.log("ssh-pool", "info", "端口探测后台循环已启动")
                .await;
            loop {
                health_interval.tick().await;
                Self::health_check(&entries, &app_handle, &log).await;
            }
        });
    }

    /// 返回所有 connected（端口开放）状态的 resource_id 列表。
    pub async fn connected_ids(&self) -> Vec<String> {
        let pool = self.entries.lock().await;
        pool.iter()
            .filter(|(_, e)| e.status == "connected")
            .map(|(id, _)| id.clone())
            .collect()
    }

    // ── 端口探测 ────────────────────────────────────────────────────────

    /// 检测 `host:port` 的 TCP 是否可在超时内连通。
    async fn probe_ssh_port(host: &str, port: u16) -> bool {
        if host.trim().is_empty() {
            return false;
        }
        let addr = (host, port);
        matches!(
            tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect(addr)).await,
            Ok(Ok(_))
        )
    }

    async fn probe_and_update_entry(
        entries: &Arc<Mutex<HashMap<String, PoolEntry>>>,
        app_handle: &tauri::AppHandle,
        resource_id: &str,
        name: &str,
        config: &SshConfig,
        log: &LogStore,
    ) {
        let open = Self::probe_ssh_port(&config.host, config.port).await;
        let (status, error): (&str, Option<String>) = if open {
            info!("SSH 池：{} 端口 {} 开放", name, config.port);
            log.log(
                "ssh-pool",
                "info",
                &format!("{} 端口 {} 开放", name, config.port),
            )
            .await;
            ("connected", None)
        } else {
            let msg = format!("SSH 端口 {} 未开放或不可达", config.port);
            warn!("SSH 池：{} {msg}", name);
            log.log("ssh-pool", "warn", &format!("{} {msg}", name)).await;
            ("error", Some(msg))
        };

        let mut pool = entries.lock().await;
        pool.insert(
            resource_id.to_string(),
            PoolEntry {
                status: status.into(),
                error: error.clone(),
                host_name: name.to_string(),
                config: config.clone(),
            },
        );
        drop(pool);
        emit_status(app_handle, resource_id, status, error.as_deref());
    }

    async fn health_check(
        entries: &Arc<Mutex<HashMap<String, PoolEntry>>>,
        app_handle: &tauri::AppHandle,
        log: &LogStore,
    ) {
        let targets: Vec<(String, SshConfig)> = {
            let pool = entries.lock().await;
            let count = pool.len();
            log.log("ssh-pool", "info", &format!("端口健康检查开始 ({count} 个条目)"))
                .await;
            pool.iter()
                .filter(|(_, e)| {
                    !e.config.host.trim().is_empty()
                        && matches!(
                            e.status.as_str(),
                            "connected" | "error" | "disconnected"
                        )
                })
                .map(|(id, e)| (id.clone(), e.config.clone()))
                .collect()
        };

        if targets.is_empty() {
            return;
        }

        let probes = join_all(targets.into_iter().map(|(resource_id, config)| {
            let host = config.host.clone();
            let port = config.port;
            async move {
                let open = Self::probe_ssh_port(&host, port).await;
                (resource_id, open)
            }
        }))
        .await;

        let mut pool = entries.lock().await;
        for (resource_id, open) in probes {
            let Some(entry) = pool.get_mut(&resource_id) else {
                continue;
            };
            if open {
                entry.status = "connected".into();
                entry.error = None;
                emit_status(app_handle, &resource_id, "connected", None);
            } else {
                entry.status = "error".into();
                entry.error = Some(format!("SSH 端口 {} 未开放或不可达", entry.config.port));
                emit_status(
                    app_handle,
                    &resource_id,
                    "error",
                    entry.error.as_deref(),
                );
            }
        }
    }

    async fn emit_all_status(&self, app_handle: &tauri::AppHandle) {
        let pool = self.entries.lock().await;
        for (resource_id, entry) in pool.iter() {
            emit_status(app_handle, resource_id, &entry.status, entry.error.as_deref());
        }
    }

    async fn reconnect_entry(entry: &mut PoolEntry, log: &LogStore) -> bool {
        let name = &entry.host_name;
        log.log("ssh-pool", "info", &format!("重新探测 {name} 端口…"))
            .await;
        let open = Self::probe_ssh_port(&entry.config.host, entry.config.port).await;
        if open {
            entry.status = "connected".into();
            entry.error = None;
            info!("SSH 池：{name} 端口开放");
            log.log("ssh-pool", "info", &format!("{name} 端口开放"))
                .await;
        } else {
            let msg = format!("SSH 端口 {} 未开放或不可达", entry.config.port);
            entry.status = "error".into();
            entry.error = Some(msg);
            warn!("SSH 池：{name} 端口不可达");
            log.log("ssh-pool", "warn", &format!("{name} 端口不可达"))
                .await;
        }
        open
    }

    /// 重新探测所有 disconnected/error 的主机端口。
    pub async fn reconnect_all(&self, app_handle: &tauri::AppHandle) {
        let mut pool = self.entries.lock().await;
        for (resource_id, entry) in pool.iter_mut() {
            if matches!(entry.status.as_str(), "disconnected" | "error") {
                let open = Self::reconnect_entry(entry, &self.log).await;
                let status = if open { "connected" } else { "error" };
                emit_status(app_handle, resource_id, status, entry.error.as_deref());
            }
        }
    }

    // ── 按需 SSH 会话（概览 / SFTP / 进程）────────────────────────────────

    /// 获取或建立连接池中的 SSH 会话（`connect_no_shell`）。
    pub async fn ensure_session(&self, resource_id: &str) -> OmniResult<Arc<SshSession>> {
        {
            let pool = self.pool_sessions.lock().await;
            if let Some(session) = pool.get(resource_id) {
                return Ok(Arc::clone(session));
            }
        }

        let (name, config) = self.resolve_connect_config(resource_id).await?;
        self.log
            .log("ssh-pool", "info", &format!("正在建立 SSH 会话: {name}…"))
            .await;

        let session = Arc::new(SshSession::connect_no_shell(config).await?);

        let mut pool = self.pool_sessions.lock().await;
        if let Some(existing) = pool.get(resource_id) {
            return Ok(Arc::clone(existing));
        }
        pool.insert(resource_id.to_string(), Arc::clone(&session));
        self.log
            .log("ssh-pool", "info", &format!("SSH 会话已就绪: {name}"))
            .await;
        Ok(session)
    }

    /// 断开并移除连接池中的 SSH 会话。
    pub async fn release_session(&self, resource_id: &str) {
        let session = self.pool_sessions.lock().await.remove(resource_id);
        if let Some(session) = session {
            session.disconnect().await;
            self.log
                .log("ssh-pool", "info", &format!("已释放 SSH 会话: {resource_id}"))
                .await;
        }
    }

    /// 建立（或复用）池会话，拉取概览数据并推送到前端。
    pub async fn load_overview(
        &self,
        resource_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> OmniResult<SshHostOverview> {
        let host_name = {
            let entries = self.entries.lock().await;
            entries
                .get(resource_id)
                .map(|e| e.host_name.clone())
                .unwrap_or_else(|| resource_id.to_string())
        };

        let session = self.ensure_session(resource_id).await?;
        let stats = self
            .collect_stats(&session, resource_id, &host_name)
            .await?;
        let processes = session.process_list().await?;

        let _ = app_handle.emit("ssh-system-stats", &[stats.clone()]);

        Ok(SshHostOverview { stats, processes })
    }

    /// 建立（或复用）池会话并采集系统指标（供监控页轮询）。
    pub async fn fetch_stats(
        &self,
        resource_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> OmniResult<HostSystemStats> {
        let host_name = {
            let entries = self.entries.lock().await;
            entries
                .get(resource_id)
                .map(|e| e.host_name.clone())
                .unwrap_or_else(|| resource_id.to_string())
        };
        let session = self.ensure_session(resource_id).await?;
        let stats = self
            .collect_stats(&session, resource_id, &host_name)
            .await?;
        let _ = app_handle.emit("ssh-system-stats", &[stats.clone()]);
        Ok(stats)
    }

    async fn resolve_connect_config(&self, resource_id: &str) -> OmniResult<(String, SshConfig)> {
        if resource_id.starts_with(Self::CONFIG_HOST_PREFIX) {
            let alias = resource_id
                .strip_prefix(Self::CONFIG_HOST_PREFIX)
                .unwrap_or(resource_id);
            let entry = find_ssh_config_entry(alias)?.ok_or_else(|| {
                OmniError::new(
                    ErrorCode::NotFound,
                    format!("SSH 配置中未找到 Host `{alias}`"),
                )
            })?;
            let config = ssh_config_to_connect_config(&entry)?;
            return Ok((entry.alias, config));
        }

        let entries = self.entries.lock().await;
        let entry = entries.get(resource_id).ok_or_else(|| {
            OmniError::new(
                ErrorCode::NotFound,
                format!("未知 SSH 资源 `{resource_id}`"),
            )
        })?;
        if entry.config.host.trim().is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "主机地址未配置"));
        }
        Ok((entry.host_name.clone(), entry.config.clone()))
    }

    async fn collect_stats(
        &self,
        session: &SshSession,
        resource_id: &str,
        host_name: &str,
    ) -> OmniResult<HostSystemStats> {
        let output = session.exec_command(STATS_SCRIPT).await?;
        Self::parse_stats(resource_id, host_name, &output).ok_or_else(|| {
            OmniError::new(ErrorCode::Internal, "解析系统指标失败")
        })
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
        let network = Self::parse_net(map.get("net").map(String::as_str).unwrap_or(""));
        let os_info = map.get("os").cloned().unwrap_or_default();

        Some(HostSystemStats {
            host_id: session_id.to_string(),
            host_name: host_name.to_string(),
            load,
            cpu_cores,
            cpu_usage,
            memory,
            disk,
            network,
            os_info,
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

    fn parse_net(raw: &str) -> NetworkStats {
        let parts: Vec<&str> = raw.split_whitespace().collect();
        NetworkStats {
            rx_bytes: parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
            tx_bytes: parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
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
