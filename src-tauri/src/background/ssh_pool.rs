use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures::future::join_all;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::attach_ports;
use omnipanel_ssh::{
    attach_process_gpu, parse_nvidia_process_gpu, parse_remote_stats_output, CpuStats, DiskStats,
    GpuStats, HostSystemStats, MemoryStats, NetworkStats, SshAuth, SshConfig, SshProcessInfo,
    SshSession, NVIDIA_PROCESS_GPU_QUERY,
};
use omnipanel_store::Connection;
use omnipanel_store::{ConnectionKind, Storage};
use serde::Serialize;
use specta::Type;
use tauri::Emitter;
use tokio::sync::Mutex;
use tracing::{error, info, warn};

use crate::log_store::LogStore;

/// 单次 TCP 探测超时（秒）
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const STATS_CACHE_TTL: Duration = Duration::from_secs(5);
const PROCESSES_CACHE_TTL: Duration = Duration::from_secs(30);
const PORTS_CACHE_TTL: Duration = Duration::from_secs(60);
const MONITOR_POLL_INTERVAL: Duration = Duration::from_secs(5);

const STATS_SCRIPT: &str = r#"/bin/bash -lc '
sec() { echo "@SECTION $1"; }

sec load
awk "{print \$1,\$2,\$3}" /proc/loadavg 2>/dev/null || echo "0 0 0"

sec cores
nproc 2>/dev/null || echo 1

sec cpu_stat1
grep -E "^cpu" /proc/stat 2>/dev/null || true
sleep 0.25
sec cpu_stat2
grep -E "^cpu" /proc/stat 2>/dev/null || true

sec mem
awk "/^MemTotal:/ {t=\$2*1024} /^MemAvailable:/ {a=\$2*1024} END {u=t-a; if(u<0)u=0; print t,u,a}" /proc/meminfo 2>/dev/null || echo "0 0 0"

sec swap
awk "/^SwapTotal:/ {t=\$2*1024} /^SwapFree:/ {f=\$2*1024} END {u=t-f; if(u<0)u=0; print t,u,f}" /proc/meminfo 2>/dev/null || echo "0 0 0"

sec disks
df -B1 -P -T 2>/dev/null | awk "NR>1 {
  dev=\$1; fs=\$2; total=\$3; used=\$4; avail=\$5;
  mount=\$7; for(i=8;i<=NF;i++) mount=mount\" \"\$i;
  print dev \"\\t\" mount \"\\t\" fs \"\\t\" total \"\\t\" used \"\\t\" avail
}" || true

sec net
awk "NR>2 {rx+=\$2; tx+=\$10} END{print rx, tx}" /proc/net/dev 2>/dev/null || echo "0 0"

sec net_if
awk "NR>2 && (\$2+\$10)>max {max=\$2+\$10; iface=\$1} END {gsub(/:/,\"\",iface); print iface}" /proc/net/dev 2>/dev/null || true

sec conn_count
(ss -Htan state established 2>/dev/null || netstat -tan 2>/dev/null | grep ESTABLISHED) | wc -l | tr -d " " || echo 0

sec uptime
awk "{print int(\$1)}" /proc/uptime 2>/dev/null || echo 0

sec mem_detail
awk "/^Cached:/ {c=\$2*1024} /^Buffers:/ {b=\$2*1024} END {print c+0,b+0}" /proc/meminfo 2>/dev/null || echo "0 0"

sec diskio
awk "NR>2 {r+=\$6; w+=\$10} END {print r*512, w*512}" /proc/diskstats 2>/dev/null || echo "0 0"

sec cpu_freq
awk -F: "/cpu MHz/ {gsub(/ /,\"\",\$2); print \$2; exit}" /proc/cpuinfo 2>/dev/null || true

sec cpu_temp
if [ -r /sys/class/thermal/thermal_zone0/temp ]; then awk "{printf \"%.0f\\n\", \$1/1000}" /sys/class/thermal/thermal_zone0/temp; fi

sec os
grep "^PRETTY_NAME=" /etc/os-release 2>/dev/null | cut -d\" -f2 || uname -sr

sec gpu_nvidia
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits 2>/dev/null || true
fi

sec gpu_amd
if command -v rocm-smi >/dev/null 2>&1; then
  rocm-smi --showuse --showtemp --showpower --showproductname 2>/dev/null || true
fi

sec gpu_intel
if command -v lspci >/dev/null 2>&1; then
  lspci 2>/dev/null | grep -iE "VGA|3D|Display" | grep -i intel || true
fi
'"#;

// ── Status event ─────────────────────────────────────────────────────────

/// 发射到前端的单个主机连接状态
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolStatusEvent {
    pub resource_id: String,
    pub status: String,
    pub error: Option<String>,
}

/// 连接池 SSH 会话已建立/已释放（与 TCP 端口探测无关）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PoolSessionEvent {
    pub resource_id: String,
    pub active: bool,
}

/// 概览页一次加载的完整数据（系统指标 + 进程列表）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshHostOverview {
    pub stats: HostSystemStats,
    pub processes: Vec<SshProcessInfo>,
}

/// 后台端口补全完成后推送到前端（进程列表已合并端口）。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SshProcessPortsEvent {
    pub resource_id: String,
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

struct CachedOverview {
    stats: HostSystemStats,
    processes: Vec<SshProcessInfo>,
    ports_by_pid: std::collections::HashMap<u32, Vec<omnipanel_ssh::SshProcessPort>>,
    stats_at: Instant,
    processes_at: Instant,
    ports_at: Instant,
}

/// SSH 连接池：后台 TCP 端口探测 + 按需建立会话（概览 / SFTP / 进程等）。
pub struct SshPool {
    entries: Arc<Mutex<HashMap<String, PoolEntry>>>,
    pool_sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
    overview_cache: Arc<Mutex<HashMap<String, CachedOverview>>>,
    ports_fill_inflight: Arc<Mutex<HashSet<String>>>,
    monitoring_subs: Arc<Mutex<HashMap<String, u32>>>,
    app_handle: Arc<Mutex<Option<tauri::AppHandle>>>,
    log: LogStore,
    background_started: AtomicBool,
}

#[allow(dead_code)]
impl SshPool {
    pub fn new(log: LogStore, pool_sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            pool_sessions,
            overview_cache: Arc::new(Mutex::new(HashMap::new())),
            ports_fill_inflight: Arc::new(Mutex::new(HashSet::new())),
            monitoring_subs: Arc::new(Mutex::new(HashMap::new())),
            app_handle: Arc::new(Mutex::new(None)),
            log,
            background_started: AtomicBool::new(false),
        }
    }

    /// 应用启动：从持久化存储加载 SSH 连接配置并启动后台健康检查。
    pub async fn start(&self, storage: Arc<Mutex<Storage>>, app_handle: tauri::AppHandle) {
        *self.app_handle.lock().await = Some(app_handle.clone());
        self.log
            .log("ssh-pool", "info", "SSH 连接池初始化中…")
            .await;
        self.reload_hosts(storage, app_handle.clone(), true).await;
        if self
            .background_started
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            Self::spawn_background_loop(
                self.entries.clone(),
                self.monitoring_subs.clone(),
                self.overview_cache.clone(),
                self.pool_sessions.clone(),
                app_handle.clone(),
                self.log.clone(),
            );
        }
    }

    /// 从持久化存储重新加载主机列表。
    /// `probe=true` 时会顺序探测每个主机的 SSH 端口（启动时使用）；
    /// 同步 ~/.ssh/config 时应传 `false` 避免阻塞。
    pub async fn reload_hosts(&self, storage: Arc<Mutex<Storage>>, app_handle: tauri::AppHandle, probe: bool) {
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
            .log(
                "ssh-pool",
                "info",
                &format!("已保存 SSH 连接: {} 个", connections.len()),
            )
            .await;

        let (specs, parse_errors) = Self::specs_from_connections(&connections);
        for (resource_id, name, err) in parse_errors {
            warn!("SSH 池：连接 {name} 配置解析失败: {err}");
            self.log
                .log("ssh-pool", "warn", &format!("{name} 配置解析失败: {err}"))
                .await;
            self.entries.lock().await.insert(
                resource_id.clone(),
                PoolEntry {
                    status: "error".into(),
                    error: Some(format!("配置解析失败: {err}")),
                    host_name: name,
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
        }

        {
            let mut pool = self.entries.lock().await;
            let ids: Vec<String> = pool.keys().cloned().collect();
            for id in ids {
                if !specs.iter().any(|s| s.resource_id == id) {
                    pool.remove(&id);
                }
            }
        }

        if specs.is_empty() {
            info!("SSH 池：无已保存的 SSH 主机");
            self.log
                .log("ssh-pool", "info", "无已保存的 SSH 主机")
                .await;
            return;
        }

        self.log
            .log(
                "ssh-pool",
                "info",
                &format!("已加载 {} 个 SSH 主机配置", specs.len()),
            )
            .await;

        {
            let mut pool = self.entries.lock().await;
            for spec in &specs {
                pool.insert(
                    spec.resource_id.clone(),
                    PoolEntry {
                        status: "idle".into(),
                        error: None,
                        host_name: spec.name.clone(),
                        config: spec.config.clone(),
                    },
                );
            }
        }

        if probe {
            self.probe_all_hosts(&app_handle).await;
        }
        self.emit_all_status(&app_handle).await;
    }

    fn specs_from_connections(
        connections: &[Connection],
    ) -> (Vec<ConnSpec>, Vec<(String, String, String)>) {
        let mut specs = Vec::new();
        let mut errors = Vec::new();
        for conn in connections {
            match serde_json::from_str::<SshConfig>(&conn.config) {
                Ok(config) => {
                    specs.push(ConnSpec {
                        resource_id: conn.id.clone(),
                        name: conn.name.clone(),
                        config,
                    });
                }
                Err(e) => {
                    errors.push((conn.id.clone(), conn.name.clone(), e.to_string()));
                }
            }
        }
        (specs, errors)
    }

    fn spawn_background_loop(
        entries: Arc<Mutex<HashMap<String, PoolEntry>>>,
        monitoring_subs: Arc<Mutex<HashMap<String, u32>>>,
        overview_cache: Arc<Mutex<HashMap<String, CachedOverview>>>,
        pool_sessions: Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
        app_handle: tauri::AppHandle,
        log: LogStore,
    ) {
        tauri::async_runtime::spawn(async move {
            let mut health_interval = tokio::time::interval(Duration::from_secs(30));
            let mut monitor_interval = tokio::time::interval(MONITOR_POLL_INTERVAL);
            health_interval.tick().await;
            monitor_interval.tick().await;
            log.log(
                "ssh-pool",
                "info",
                "SSH 池后台循环已启动（健康检查 + 监控采集）",
            )
            .await;
            loop {
                tokio::select! {
                    _ = health_interval.tick() => {
                        Self::health_check(&entries, &app_handle, &log).await;
                    }
                    _ = monitor_interval.tick() => {
                        Self::poll_monitoring_subscribers(
                            &entries,
                            &monitoring_subs,
                            &overview_cache,
                            &pool_sessions,
                            &app_handle,
                            &log,
                        )
                        .await;
                    }
                }
            }
        });
    }

    /// 一次性返回所有主机的连接状态快照。
    pub async fn get_statuses(&self) -> Vec<PoolStatusEvent> {
        let pool = self.entries.lock().await;
        pool.iter()
            .map(|(resource_id, entry)| PoolStatusEvent {
                resource_id: resource_id.clone(),
                status: entry.status.clone(),
                error: entry.error.clone(),
            })
            .collect()
    }

    /// 返回当前已建立 SSH 会话的主机 ID 列表。
    pub async fn active_session_ids(&self) -> Vec<String> {
        let pool = self.pool_sessions.lock().await;
        pool.keys().cloned().collect()
    }

    /// 当前订阅持续监控的主机数量（连接池活跃占用）。
    pub async fn monitoring_host_count(&self) -> usize {
        let subs = self.monitoring_subs.lock().await;
        subs.values().filter(|count| **count > 0).count()
    }

    /// 订阅持续监控采集（引用计数）。
    pub async fn subscribe_monitoring(&self, resource_id: &str) {
        let mut subs = self.monitoring_subs.lock().await;
        *subs.entry(resource_id.to_string()).or_insert(0) += 1;
    }

    /// 取消监控订阅。
    pub async fn unsubscribe_monitoring(&self, resource_id: &str) {
        let mut subs = self.monitoring_subs.lock().await;
        if let Some(count) = subs.get_mut(resource_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                subs.remove(resource_id);
            }
        }
    }

    /// 启动时探测所有已配置主机的 SSH 端口。
    async fn probe_all_hosts(&self, app_handle: &tauri::AppHandle) {
        let targets: Vec<(String, String, SshConfig)> = {
            let pool = self.entries.lock().await;
            pool.iter()
                .filter(|(_, e)| !e.config.host.trim().is_empty())
                .map(|(id, e)| (id.clone(), e.host_name.clone(), e.config.clone()))
                .collect()
        };

        for (resource_id, name, config) in targets {
            Self::probe_and_update_entry(
                &self.entries,
                app_handle,
                &resource_id,
                &name,
                &config,
                &self.log,
            )
            .await;
        }
    }

    async fn poll_monitoring_subscribers(
        entries: &Arc<Mutex<HashMap<String, PoolEntry>>>,
        monitoring_subs: &Arc<Mutex<HashMap<String, u32>>>,
        overview_cache: &Arc<Mutex<HashMap<String, CachedOverview>>>,
        pool_sessions: &Arc<Mutex<HashMap<String, Arc<SshSession>>>>,
        app_handle: &tauri::AppHandle,
        log: &LogStore,
    ) {
        let targets: Vec<String> = {
            let subs = monitoring_subs.lock().await;
            subs.keys().cloned().collect()
        };
        if targets.is_empty() {
            return;
        }

        for resource_id in targets {
            let host_name = {
                let pool = entries.lock().await;
                pool.get(&resource_id)
                    .map(|e| e.host_name.clone())
                    .unwrap_or_else(|| resource_id.clone())
            };

            let session = {
                let pool = pool_sessions.lock().await;
                pool.get(&resource_id).cloned()
            };

            let Some(session) = session else {
                continue;
            };

            match Self::collect_stats_static(&session, &resource_id, &host_name).await {
                Ok(stats) => {
                    let now = Instant::now();
                    {
                        let mut cache = overview_cache.lock().await;
                        let entry = cache.entry(resource_id.clone()).or_insert(CachedOverview {
                            stats: stats.clone(),
                            processes: Vec::new(),
                            ports_by_pid: std::collections::HashMap::new(),
                            stats_at: now,
                            processes_at: now,
                            ports_at: now - PORTS_CACHE_TTL - Duration::from_secs(1),
                        });
                        entry.stats = stats.clone();
                        entry.stats_at = now;
                    }
                    let _ = app_handle.emit("ssh-system-stats", std::slice::from_ref(&stats));
                }
                Err(e) => {
                    warn!("SSH 监控采集失败 {resource_id}: {e}");
                    log.log(
                        "ssh-pool",
                        "warn",
                        &format!("监控采集失败 {resource_id}: {e}"),
                    )
                    .await;
                }
            }
        }
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
            log.log("ssh-pool", "warn", &format!("{} {msg}", name))
                .await;
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
            log.log(
                "ssh-pool",
                "info",
                &format!("端口健康检查开始 ({count} 个条目)"),
            )
            .await;
            pool.iter()
                .filter(|(_, e)| {
                    !e.config.host.trim().is_empty()
                        && matches!(e.status.as_str(), "connected" | "error" | "disconnected")
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
                emit_status(app_handle, &resource_id, "error", entry.error.as_deref());
            }
        }
    }

    async fn emit_all_status(&self, app_handle: &tauri::AppHandle) {
        let pool = self.entries.lock().await;
        for (resource_id, entry) in pool.iter() {
            emit_status(
                app_handle,
                resource_id,
                &entry.status,
                entry.error.as_deref(),
            );
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
        self.emit_session(resource_id, true).await;
        Ok(session)
    }

    /// 断开并移除连接池中的 SSH 会话。
    pub async fn release_session(&self, resource_id: &str) {
        let session = self.pool_sessions.lock().await.remove(resource_id);
        if let Some(session) = session {
            session.disconnect().await;
            self.log
                .log(
                    "ssh-pool",
                    "info",
                    &format!("已释放 SSH 会话: {resource_id}"),
                )
                .await;
            self.emit_session(resource_id, false).await;
        }
    }

    async fn emit_session(&self, resource_id: &str, active: bool) {
        if let Some(handle) = self.app_handle.lock().await.clone() {
            let _ = handle.emit(
                "ssh-pool-session",
                PoolSessionEvent {
                    resource_id: resource_id.to_string(),
                    active,
                },
            );
        }
    }

    /// 获取已有会话的引用（不创建新连接），用于 Docker 复用。
    pub async fn get_session_ref(&self, resource_id: &str) -> Option<Arc<SshSession>> {
        let pool = self.pool_sessions.lock().await;
        pool.get(resource_id).cloned()
    }

    /// 获取已保存的 SSH 配置（用于 Docker 连接复用）。
    pub async fn get_ssh_config(&self, resource_id: &str) -> Option<SshConfig> {
        let entries = self.entries.lock().await;
        entries.get(resource_id).map(|e| e.config.clone())
    }

    async fn apply_cached_ports(
        &self,
        resource_id: &str,
        processes: &mut [SshProcessInfo],
    ) -> bool {
        let now = Instant::now();
        let cached_ports = {
            let cache = self.overview_cache.lock().await;
            cache.get(resource_id).and_then(|entry| {
                if !entry.ports_by_pid.is_empty()
                    && now.duration_since(entry.ports_at) < PORTS_CACHE_TTL
                {
                    Some(entry.ports_by_pid.clone())
                } else {
                    None
                }
            })
        };

        if let Some(ports) = cached_ports {
            attach_ports(processes, &ports);
            true
        } else {
            false
        }
    }

    async fn ports_cache_fresh(&self, resource_id: &str) -> bool {
        let now = Instant::now();
        let cache = self.overview_cache.lock().await;
        cache
            .get(resource_id)
            .map(|entry| {
                !entry.ports_by_pid.is_empty()
                    && now.duration_since(entry.ports_at) < PORTS_CACHE_TTL
            })
            .unwrap_or(false)
    }

    /// 端口缓存未命中时在后台采集，完成后通过 `ssh-process-ports` 事件推送。
    async fn schedule_port_fill(&self, resource_id: &str) {
        if self.ports_cache_fresh(resource_id).await {
            return;
        }

        {
            let mut inflight = self.ports_fill_inflight.lock().await;
            if !inflight.insert(resource_id.to_string()) {
                return;
            }
        }

        let overview_cache = self.overview_cache.clone();
        let ports_fill_inflight = self.ports_fill_inflight.clone();
        let app_handle = self.app_handle.clone();
        let config = self.get_ssh_config(resource_id).await;
        let resource_id = resource_id.to_string();

        tokio::spawn(async move {
            let ports_by_pid = match config {
                Some(config) => match SshSession::connect_no_shell(config).await {
                    Ok(session) => session.collect_listen_ports().await.unwrap_or_default(),
                    Err(_) => std::collections::HashMap::new(),
                },
                None => std::collections::HashMap::new(),
            };
            let now = Instant::now();

            let processes = {
                let mut cache = overview_cache.lock().await;
                if let Some(entry) = cache.get_mut(&resource_id) {
                    entry.ports_by_pid = ports_by_pid.clone();
                    entry.ports_at = now;
                    let mut procs = entry.processes.clone();
                    if procs.is_empty() {
                        None
                    } else {
                        attach_ports(&mut procs, &ports_by_pid);
                        entry.processes = procs.clone();
                        Some(procs)
                    }
                } else {
                    None
                }
            };

            if let Some(processes) = processes {
                if let Some(handle) = app_handle.lock().await.as_ref() {
                    let _ = handle.emit(
                        "ssh-process-ports",
                        &SshProcessPortsEvent {
                            resource_id: resource_id.clone(),
                            processes,
                        },
                    );
                }
            }

            ports_fill_inflight.lock().await.remove(&resource_id);
        });
    }

    /// 建立（或复用）池会话，拉取概览数据并推送到前端（带短 TTL 缓存）。
    pub async fn load_overview(
        &self,
        resource_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> OmniResult<SshHostOverview> {
        let now = Instant::now();
        {
            let cache = self.overview_cache.lock().await;
            if let Some(entry) = cache.get(resource_id) {
                let stats_fresh = now.duration_since(entry.stats_at) < STATS_CACHE_TTL;
                let processes_fresh = now.duration_since(entry.processes_at) < PROCESSES_CACHE_TTL;
                if stats_fresh && processes_fresh {
                    let stats = entry.stats.clone();
                    let processes = entry.processes.clone();
                    drop(cache);
                    self.schedule_port_fill(resource_id).await;
                    let _ = app_handle.emit("ssh-system-stats", std::slice::from_ref(&stats));
                    return Ok(SshHostOverview { stats, processes });
                }
            }
        }

        let host_name = {
            let entries = self.entries.lock().await;
            entries
                .get(resource_id)
                .map(|e| e.host_name.clone())
                .unwrap_or_else(|| resource_id.to_string())
        };

        let session = self.ensure_session(resource_id).await?;

        let (stats_fresh, processes_fresh, cached_stats, cached_processes) = {
            let cache = self.overview_cache.lock().await;
            let cached = cache.get(resource_id);
            (
                cached
                    .map(|c| now.duration_since(c.stats_at) < STATS_CACHE_TTL)
                    .unwrap_or(false),
                cached
                    .map(|c| now.duration_since(c.processes_at) < PROCESSES_CACHE_TTL)
                    .unwrap_or(false),
                cached.map(|c| c.stats.clone()),
                cached.map(|c| c.processes.clone()),
            )
        };

        let (stats, processes) = match (stats_fresh, processes_fresh) {
            (true, true) => (
                cached_stats.expect("stats cache"),
                cached_processes.expect("process cache"),
            ),
            (true, false) => {
                let mut processes = session.process_list_fast().await?;
                Self::enrich_process_gpu(&session, &mut processes).await;
                self.apply_cached_ports(resource_id, &mut processes).await;
                (cached_stats.expect("stats cache"), processes)
            }
            (false, true) => {
                let stats = self
                    .collect_stats(&session, resource_id, &host_name)
                    .await?;
                (stats, cached_processes.expect("process cache"))
            }
            (false, false) => {
                let (stats, processes) = tokio::join!(
                    self.collect_stats(&session, resource_id, &host_name),
                    session.process_list_fast(),
                );
                let stats = stats?;
                let mut processes = processes?;
                Self::enrich_process_gpu(&session, &mut processes).await;
                self.apply_cached_ports(resource_id, &mut processes).await;
                (stats, processes)
            }
        };

        {
            let mut cache = self.overview_cache.lock().await;
            let entry = cache
                .entry(resource_id.to_string())
                .or_insert(CachedOverview {
                    stats: stats.clone(),
                    processes: processes.clone(),
                    ports_by_pid: std::collections::HashMap::new(),
                    stats_at: now,
                    processes_at: now,
                    ports_at: now - PORTS_CACHE_TTL - Duration::from_secs(1),
                });
            entry.stats = stats.clone();
            entry.stats_at = now;
            entry.processes = processes.clone();
            entry.processes_at = now;
        }

        self.schedule_port_fill(resource_id).await;

        let _ = app_handle.emit("ssh-system-stats", std::slice::from_ref(&stats));

        Ok(SshHostOverview { stats, processes })
    }

    /// 独立刷新进程列表（概览页局部刷新）。
    pub async fn load_processes(&self, resource_id: &str) -> OmniResult<Vec<SshProcessInfo>> {
        let session = self.ensure_session(resource_id).await?;
        let mut processes = session.process_list_fast().await?;
        Self::enrich_process_gpu(&session, &mut processes).await;
        self.apply_cached_ports(resource_id, &mut processes).await;
        let now = Instant::now();
        {
            let mut cache = self.overview_cache.lock().await;
            let entry = cache.entry(resource_id.to_string()).or_insert_with(|| {
                let stale = now - STATS_CACHE_TTL - Duration::from_secs(1);
                CachedOverview {
                    stats: HostSystemStats {
                        host_id: resource_id.to_string(),
                        host_name: resource_id.to_string(),
                        load: String::new(),
                        cpu: CpuStats::default(),
                        cpu_cores: 0,
                        cpu_usage: 0.0,
                        memory: MemoryStats::default(),
                        disk: DiskStats::default(),
                        gpu: GpuStats::default(),
                        network: NetworkStats::default(),
                        os_info: String::new(),
                        uptime_secs: None,
                        timestamp: 0,
                    },
                    processes: Vec::new(),
                    ports_by_pid: std::collections::HashMap::new(),
                    stats_at: stale,
                    processes_at: stale,
                    ports_at: now - PORTS_CACHE_TTL - Duration::from_secs(1),
                }
            });
            entry.processes = processes.clone();
            entry.processes_at = now;
        }
        self.schedule_port_fill(resource_id).await;
        Ok(processes)
    }

    /// 建立（或复用）池会话并采集系统指标（供监控页轮询，带缓存）。
    pub async fn fetch_stats(
        &self,
        resource_id: &str,
        app_handle: &tauri::AppHandle,
    ) -> OmniResult<HostSystemStats> {
        let now = Instant::now();
        {
            let cache = self.overview_cache.lock().await;
            if let Some(entry) = cache.get(resource_id) {
                if now.duration_since(entry.stats_at) < STATS_CACHE_TTL {
                    let _ = app_handle.emit("ssh-system-stats", std::slice::from_ref(&entry.stats));
                    return Ok(entry.stats.clone());
                }
            }
        }

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

        {
            let mut cache = self.overview_cache.lock().await;
            let entry = cache
                .entry(resource_id.to_string())
                .or_insert(CachedOverview {
                    stats: stats.clone(),
                    processes: Vec::new(),
                    ports_by_pid: std::collections::HashMap::new(),
                    stats_at: now,
                    processes_at: now,
                    ports_at: now - PORTS_CACHE_TTL - Duration::from_secs(1),
                });
            entry.stats = stats.clone();
            entry.stats_at = now;
        }

        let _ = app_handle.emit("ssh-system-stats", std::slice::from_ref(&stats));
        Ok(stats)
    }

    async fn resolve_connect_config(&self, resource_id: &str) -> OmniResult<(String, SshConfig)> {
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
        Self::collect_stats_static(session, resource_id, host_name).await
    }

    async fn collect_stats_static(
        session: &SshSession,
        resource_id: &str,
        host_name: &str,
    ) -> OmniResult<HostSystemStats> {
        let output = session.exec_command(STATS_SCRIPT).await?;
        parse_remote_stats_output(resource_id, host_name, &output, &[])
            .ok_or_else(|| OmniError::new(ErrorCode::Internal, "解析系统指标失败"))
    }

    async fn enrich_process_gpu(session: &SshSession, processes: &mut [SshProcessInfo]) {
        if let Ok(output) = session.exec_command(NVIDIA_PROCESS_GPU_QUERY).await {
            let map = parse_nvidia_process_gpu(&output);
            if !map.is_empty() {
                attach_process_gpu(processes, &map);
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

#[cfg(test)]
mod stats_tests {
    use omnipanel_ssh::parse_memory_triplet;

    #[test]
    fn parse_mem_three_column_line() {
        let (total, used, available) = parse_memory_triplet("17179869184 8589934592 8589934592");
        assert_eq!(total, 17179869184);
        assert_eq!(used, 8589934592);
        assert_eq!(available, 8589934592);
    }

    #[test]
    fn parse_mem_derives_used_from_total_and_available() {
        let (total, used, available) = parse_memory_triplet("1000 0 400");
        assert_eq!(total, 1000);
        assert_eq!(used, 600);
        assert_eq!(available, 400);
    }

    #[test]
    fn parse_mem_empty_returns_zero() {
        let (total, used, available) = parse_memory_triplet("");
        assert_eq!(total, 0);
        assert_eq!(used, 0);
        assert_eq!(available, 0);
    }
}
