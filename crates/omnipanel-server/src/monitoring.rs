//! P1 系统监控采集：本机 sysinfo 采集 + SSH 远程 stats 脚本采集。
//!
//! Web 端没有桌面端 `SshPool` 那样的常驻后台连接池 / 缓存，这里按需建立
//! （或复用 `ServerState::ssh_sessions` / `ServerState::docker_ssh_sessions`
//! 中已有的会话）SSH 会话。采集逻辑与桌面端
//! `src-tauri/src/background/local_system.rs` / `ssh_pool.rs` 对齐
//! （简化版：不采集 GPU 明细、进程列表不挂载监听端口）。

use std::sync::Arc;
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{
    CpuStats, DiskDeviceStats, DiskStats, GpuStats, HostSystemStats, MemoryStats, NetworkStats,
    SshProcessInfo, SshSession, aggregate_disk_stats, format_load, is_pseudo_filesystem,
    parse_remote_stats_output,
};
use sysinfo::{Disks, Networks, ProcessesToUpdate, System, Users};

use crate::state::{ServerState, resolve_ssh_config};

/// 与前端 `LOCAL_TERMINAL_RESOURCE_ID` 一致。
pub const LOCAL_HOST_ID: &str = "local-terminal";

/// CPU 采样窗口（两次 refresh 之间的休眠时长）。
const CPU_SAMPLE_MS: u64 = 250;

/// 远端系统指标采集脚本，与桌面端 `src-tauri/src/background/ssh_pool.rs`
/// 的 `STATS_SCRIPT` 常量完全一致（保证 `parse_remote_stats_output` 解析口径统一）。
const STATS_SCRIPT: &str = r#"/bin/bash -c '
set +e
sec() { echo "@SECTION $1"; }
is_darwin() { [ "$(uname -s)" = "Darwin" ]; }

sec load
if is_darwin; then
  sysctl -n vm.loadavg 2>/dev/null | tr -d "{}" || echo "0 0 0"
else
  awk "{print \$1,\$2,\$3}" /proc/loadavg 2>/dev/null || echo "0 0 0"
fi

sec cores
if is_darwin; then
  sysctl -n hw.ncpu 2>/dev/null || echo 1
else
  nproc 2>/dev/null || echo 1
fi

sec cpu_stat1
if ! is_darwin; then
  grep -E "^cpu" /proc/stat 2>/dev/null || true
fi
sleep 0.25
sec cpu_stat2
if ! is_darwin; then
  grep -E "^cpu" /proc/stat 2>/dev/null || true
fi

sec mem
if is_darwin; then
  pages=$(sysctl -n hw.pagesize 2>/dev/null || echo 4096)
  total=$(sysctl -n hw.memsize 2>/dev/null || echo 0)
  vm=$(vm_stat 2>/dev/null)
  free=$(echo "$vm" | awk "/Pages free/ {gsub(/\\./,\"\", \$3); print \$3+0}")
  inactive=$(echo "$vm" | awk "/Pages inactive/ {gsub(/\\./,\"\", \$3); print \$3+0}")
  speculative=$(echo "$vm" | awk "/Pages speculative/ {gsub(/\\./,\"\", \$3); print \$3+0}")
  avail=$(( (free + inactive + speculative) * pages ))
  used=$(( total - avail ))
  if [ "$used" -lt 0 ]; then used=0; fi
  echo "$total $used $avail"
else
  awk "/^MemTotal:/ {t=\$2*1024} /^MemAvailable:/ {a=\$2*1024} END {u=t-a; if(u<0)u=0; print t,u,a}" /proc/meminfo 2>/dev/null || echo "0 0 0"
fi

sec swap
if is_darwin; then
  sysctl -n vm.swapusage 2>/dev/null | awk "{
    t=0; u=0; f=0
    for(i=1;i<=NF;i++) {
      if(\$i==\"total\") { gsub(/M/,\"\", \$(i+2)); t=\$(i+2)*1048576 }
      if(\$i==\"used\") { gsub(/M/,\"\", \$(i+2)); u=\$(i+2)*1048576 }
      if(\$i==\"free\") { gsub(/M/,\"\", \$(i+2)); f=\$(i+2)*1048576 }
    }
    print int(t), int(u), int(f)
  }" || echo "0 0 0"
else
  awk "/^SwapTotal:/ {t=\$2*1024} /^SwapFree:/ {f=\$2*1024} END {u=t-f; if(u<0)u=0; print t,u,f}" /proc/meminfo 2>/dev/null || echo "0 0 0"
fi

sec disks
if is_darwin; then
  df -k 2>/dev/null | awk "NR>1 && \$1 ~ /^\// {
    total=\$2*1024; used=\$3*1024; avail=\$4*1024;
    if(total>0) print \$1 \"\\t\" \$NF \"\\tapfs\\t\" total \"\\t\" used \"\\t\" avail
  }" || true
else
  df -B1 -P -T 2>/dev/null | awk "NR>1 {
    dev=\$1; fs=\$2; total=\$3; used=\$4; avail=\$5;
    mount=\$7; for(i=8;i<=NF;i++) mount=mount\" \"\$i;
    print dev \"\\t\" mount \"\\t\" fs \"\\t\" total \"\\t\" used \"\\t\" avail
  }" || true
fi

sec net
if is_darwin; then
  netstat -ib 2>/dev/null | awk "NR>1 && \$1 != \"Name\" && \$1 !~ /^lo/ { rx+=\$7; tx+=\$10 } END { print rx+0, tx+0 }" || echo "0 0"
else
  awk "NR>2 {rx+=\$2; tx+=\$10} END{print rx, tx}" /proc/net/dev 2>/dev/null || echo "0 0"
fi

sec net_if
if is_darwin; then
  route -n get default 2>/dev/null | awk "/interface: / {print \$2; exit}" || true
else
  awk "NR>2 && (\$2+\$10)>max {max=\$2+\$10; iface=\$1} END {gsub(/:/,\"\",iface); print iface}" /proc/net/dev 2>/dev/null || true
fi

sec conn_count
(ss -Htan state established 2>/dev/null || netstat -an 2>/dev/null | grep ESTABLISHED) | wc -l | tr -d " " || echo 0

sec uptime
if is_darwin; then
  boot=$(sysctl -n kern.boottime 2>/dev/null | awk "{print \$4}")
  now=$(date +%s 2>/dev/null)
  if [ -n "$boot" ] && [ -n "$now" ]; then echo $((now - boot)); else echo 0; fi
else
  awk "{print int(\$1)}" /proc/uptime 2>/dev/null || echo 0
fi

sec mem_detail
if is_darwin; then
  echo "0 0"
else
  awk "/^Cached:/ {c=\$2*1024} /^Buffers:/ {b=\$2*1024} END {print c+0,b+0}" /proc/meminfo 2>/dev/null || echo "0 0"
fi

sec diskio
if is_darwin; then
  echo "0 0"
else
  awk "NR>2 {r+=\$6; w+=\$10} END {print r*512, w*512}" /proc/diskstats 2>/dev/null || echo "0 0"
fi

sec cpu_freq
if ! is_darwin; then
  awk -F: "/cpu MHz/ {gsub(/ /,\"\",\$2); print \$2; exit}" /proc/cpuinfo 2>/dev/null || true
fi

sec cpu_temp
if ! is_darwin && [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  awk "{printf \"%.0f\\n\", \$1/1000}" /sys/class/thermal/thermal_zone0/temp
fi

sec os
if is_darwin; then
  pn=$(sw_vers -productName 2>/dev/null)
  pv=$(sw_vers -productVersion 2>/dev/null)
  if [ -n "$pn" ] && [ -n "$pv" ]; then
    echo "$pn $pv"
  else
    uname -sr
  fi
else
  grep "^PRETTY_NAME=" /etc/os-release 2>/dev/null | cut -d\" -f2 || uname -sr
fi

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

exit 0
'"#;

// ── 本机采集（sysinfo） ─────────────────────────────────────────────────

/// 本机系统指标采集（简化版：无 GPU 明细）。放到 `spawn_blocking` 中执行，
/// 避免 sysinfo 的阻塞刷新占用 tokio 工作线程。
pub async fn local_fetch_stats() -> OmniResult<HostSystemStats> {
    tokio::task::spawn_blocking(fetch_local_stats_sync)
        .await
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("本机指标采集失败: {e}")))?
}

fn fetch_local_stats_sync() -> OmniResult<HostSystemStats> {
    // 看板只需 CPU + 内存；勿 System::new_all / refresh_all（会扫全进程，首屏很慢）。
    let mut system = System::new();
    system.refresh_cpu_all();
    system.refresh_memory();
    std::thread::sleep(Duration::from_millis(CPU_SAMPLE_MS));
    system.refresh_cpu_all();

    let host_name = System::host_name().unwrap_or_else(|| "localhost".to_string());
    let load_avg = System::load_average();
    let (load1, load5, load15) = (load_avg.one, load_avg.five, load_avg.fifteen);
    let load = format_load(load1, load5, load15);

    let per_core_usage: Vec<f64> = system
        .cpus()
        .iter()
        .map(|cpu| f64::from(cpu.cpu_usage()))
        .collect();
    let cpu_cores = per_core_usage.len().max(1) as u32;
    let cpu_usage = f64::from(system.global_cpu_usage());
    let cpu = CpuStats {
        usage: cpu_usage,
        cores: cpu_cores,
        per_core_usage,
        load1,
        load5,
        load15,
        frequency_mhz: system.cpus().first().map(|cpu| cpu.frequency() as f64),
        temperature: None,
    };

    let total_mem = system.total_memory();
    let avail_mem = system.available_memory();
    let used_mem = total_mem.saturating_sub(avail_mem);
    let swap_total = system.total_swap();
    let swap_free = system.free_swap();
    let swap_used = swap_total.saturating_sub(swap_free);

    let disks_sys = Disks::new_with_refreshed_list();
    let disk_devices = collect_disk_devices(&disks_sys);
    let (disk_total, disk_used, disk_avail) = aggregate_disk_stats(&disk_devices);

    let networks = Networks::new_with_refreshed_list();
    let network = collect_network_stats(&networks);

    let os_info = System::long_os_version()
        .or_else(System::name)
        .unwrap_or_default();

    Ok(HostSystemStats {
        host_id: LOCAL_HOST_ID.to_string(),
        host_name,
        load,
        cpu,
        cpu_cores,
        cpu_usage,
        memory: MemoryStats {
            total: total_mem,
            used: used_mem,
            available: avail_mem,
            swap_total,
            swap_used,
            swap_available: swap_free,
            cached: None,
            buffers: None,
        },
        disk: DiskStats {
            total: disk_total,
            used: disk_used,
            available: disk_avail,
            disks: disk_devices,
            read_bytes: None,
            write_bytes: None,
        },
        gpu: GpuStats::default(),
        network,
        os_info,
        uptime_secs: Some(System::uptime()),
        timestamp: now_ms(),
    })
}

/// 列出本机进程（简化版：无 GPU 使用率、不挂载监听端口）。
pub async fn local_list_processes() -> OmniResult<Vec<SshProcessInfo>> {
    tokio::task::spawn_blocking(list_local_processes_sync)
        .await
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("本机进程列表采集失败: {e}")))?
}

fn list_local_processes_sync() -> OmniResult<Vec<SshProcessInfo>> {
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    std::thread::sleep(Duration::from_millis(CPU_SAMPLE_MS));
    system.refresh_processes(ProcessesToUpdate::All, true);

    let users = Users::new_with_refreshed_list();
    let total_mem = system.total_memory().max(1);

    let mut processes: Vec<SshProcessInfo> = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            let mem_bytes = process.memory();
            let mem_pct = (mem_bytes as f64 / total_mem as f64) * 100.0;
            let cmd = process.cmd();
            let command = if cmd.is_empty() {
                process.name().to_string_lossy().into_owned()
            } else {
                join_os_args(cmd)
            };

            SshProcessInfo {
                user: resolve_user_name(process.user_id(), &users),
                pid: pid.as_u32(),
                cpu: f64::from(process.cpu_usage()),
                mem: mem_pct,
                vsz: process.virtual_memory() / 1024,
                rss: mem_bytes / 1024,
                stat: format_process_status(process.status()),
                start: format_process_start(process.start_time()),
                time: format_cpu_time(process.run_time()),
                command,
                ports: Vec::new(),
                gpu_usage: None,
            }
        })
        .collect();

    processes.sort_by(|a, b| {
        b.cpu
            .partial_cmp(&a.cpu)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.pid.cmp(&b.pid))
    });

    Ok(processes)
}

/// 查询本机进程详情。
pub async fn local_process_detail(pid: u32) -> OmniResult<omnipanel_ssh::SshProcessDetail> {
    tokio::task::spawn_blocking(move || local_process_detail_sync(pid))
        .await
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("本机进程详情采集失败: {e}")))?
}

fn local_process_detail_sync(pid: u32) -> OmniResult<omnipanel_ssh::SshProcessDetail> {
    use sysinfo::Pid;
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let pid = Pid::from_u32(pid);
    let process = system
        .process(pid)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("进程 {pid} 不存在")))?;

    let cmd = process.cmd();
    let command_line = if cmd.is_empty() {
        process.name().to_string_lossy().into_owned()
    } else {
        join_os_args(cmd)
    };

    Ok(omnipanel_ssh::SshProcessDetail {
        pid: pid.as_u32(),
        command_line: Some(command_line),
        args: cmd
            .iter()
            .skip(1)
            .map(|part| part.to_string_lossy().into_owned())
            .collect(),
        cwd: process
            .cwd()
            .map(|path| path.to_string_lossy().into_owned()),
        exe: process
            .exe()
            .map(|path| path.to_string_lossy().into_owned()),
        root: None,
        open_files: Vec::new(),
    })
}

/// 强制终止本机进程。
pub async fn local_kill_process(pid: u32) -> OmniResult<()> {
    tokio::task::spawn_blocking(move || local_kill_process_sync(pid))
        .await
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("终止本机进程失败: {e}")))?
}

fn local_kill_process_sync(pid: u32) -> OmniResult<()> {
    use sysinfo::Pid;
    let mut system = System::new_all();
    system.refresh_processes(ProcessesToUpdate::All, true);
    let pid = Pid::from_u32(pid);
    let process = system
        .process(pid)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("进程 {pid} 不存在")))?;

    if process.kill() {
        Ok(())
    } else {
        Err(OmniError::new(
            ErrorCode::Internal,
            format!("无法终止进程 {pid}"),
        ))
    }
}

// ── SSH 远程采集 ──────────────────────────────────────────────────────

/// 建立（或复用）SSH 会话并采集远端系统指标。
pub async fn ssh_pool_fetch_stats(
    state: &ServerState,
    resource_id: &str,
) -> OmniResult<HostSystemStats> {
    let (session, host_name) = ensure_ssh_session(state, resource_id).await?;
    let output = session.exec_command(STATS_SCRIPT).await?;
    parse_remote_stats_output(resource_id, &host_name, &output, &[])
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "解析远端系统指标失败"))
}

/// 建立（或复用）SSH 会话并列出远端进程。
pub async fn ssh_pool_load_processes(
    state: &ServerState,
    resource_id: &str,
) -> OmniResult<Vec<SshProcessInfo>> {
    let (session, _host_name) = ensure_ssh_session(state, resource_id).await?;
    match session.process_list_fast().await {
        Ok(list) => Ok(list),
        Err(_) => session.process_list().await,
    }
}

/// 监控订阅占位：Web 端前端只靠轮询 `fetch_stats`，无需服务端主动推送事件。
pub async fn ssh_pool_subscribe_monitoring(_resource_id: &str) -> OmniResult<()> {
    Ok(())
}

/// 监控取消订阅占位（同上）。
pub async fn ssh_pool_unsubscribe_monitoring(_resource_id: &str) -> OmniResult<()> {
    Ok(())
}

/// 复用已有 SSH 会话（交互式 shell 会话池 / Docker SSH 会话池），
/// 不存在则新建并缓存到 `docker_ssh_sessions`（与 `docker.rs::ensure_docker_ssh` 同构）。
pub async fn ensure_ssh_session(
    state: &ServerState,
    resource_id: &str,
) -> OmniResult<(Arc<SshSession>, String)> {
    if let Some(session) = find_cached_session(state, resource_id).await {
        let host_name = connection_name(state, resource_id).await;
        return Ok((session, host_name));
    }

    let conn = {
        let storage = state.storage.lock().await;
        storage.get_connection(resource_id)?.ok_or_else(|| {
            OmniError::new(
                ErrorCode::NotFound,
                format!("SSH 连接 {resource_id} 不存在"),
            )
        })?
    };
    let host_name = conn.name.clone();
    let config = resolve_ssh_config(&conn)?;
    let session = Arc::new(SshSession::connect_no_shell(config).await?);

    let mut pool = state.docker_ssh_sessions.lock().await;
    if let Some(existing) = pool.get(resource_id) {
        if !existing.is_closed() {
            let existing = existing.clone();
            drop(pool);
            session.disconnect().await;
            return Ok((existing, host_name));
        }
        pool.remove(resource_id);
    }
    pool.insert(resource_id.to_string(), session.clone());
    Ok((session, host_name))
}

/// 优先复用交互式 shell 会话池，其次复用 Docker SSH 会话池。
async fn find_cached_session(state: &ServerState, resource_id: &str) -> Option<Arc<SshSession>> {
    {
        let sessions = state.ssh_sessions.lock().await;
        if let Some(session) = sessions.get(resource_id) {
            if !session.is_closed() {
                return Some(session.clone());
            }
        }
    }
    let sessions = state.docker_ssh_sessions.lock().await;
    if let Some(session) = sessions.get(resource_id) {
        if !session.is_closed() {
            return Some(session.clone());
        }
    }
    None
}

async fn connection_name(state: &ServerState, resource_id: &str) -> String {
    let storage = state.storage.lock().await;
    storage
        .get_connection(resource_id)
        .ok()
        .flatten()
        .map(|c| c.name)
        .unwrap_or_else(|| resource_id.to_string())
}

// ── 辅助函数（与桌面端 `local_system.rs` 对齐） ─────────────────────────

fn collect_disk_devices(disks: &Disks) -> Vec<DiskDeviceStats> {
    let mut devices: Vec<DiskDeviceStats> = disks
        .iter()
        .filter_map(|disk| {
            let mount = disk.mount_point().to_string_lossy().into_owned();
            let file_system = disk.file_system().to_string_lossy().into_owned();
            if is_pseudo_filesystem(&file_system) {
                return None;
            }
            let total = disk.total_space();
            if total == 0 {
                return None;
            }
            let available = disk.available_space();
            let used = total.saturating_sub(available);
            Some(DiskDeviceStats {
                name: disk.name().to_string_lossy().into_owned(),
                mount_point: mount,
                file_system,
                total,
                used,
                available,
            })
        })
        .collect();

    devices.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then_with(|| a.mount_point.cmp(&b.mount_point))
    });
    devices
}

fn collect_network_stats(networks: &Networks) -> NetworkStats {
    let mut rx_bytes = 0u64;
    let mut tx_bytes = 0u64;
    let mut primary_iface: Option<String> = None;
    let mut max_traffic = 0u64;

    for (name, data) in networks.iter() {
        let received = data.received();
        let transmitted = data.transmitted();
        rx_bytes = rx_bytes.saturating_add(received);
        tx_bytes = tx_bytes.saturating_add(transmitted);
        let total = received.saturating_add(transmitted);
        if total > max_traffic {
            max_traffic = total;
            primary_iface = Some(name.clone());
        }
    }

    NetworkStats {
        rx_bytes,
        tx_bytes,
        interface: primary_iface,
        connections: None,
    }
}

fn join_os_args(cmd: &[std::ffi::OsString]) -> String {
    cmd.iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_user_name(user_id: Option<&sysinfo::Uid>, users: &Users) -> String {
    let Some(uid) = user_id else {
        return "-".to_string();
    };
    users
        .iter()
        .find(|user| user.id() == uid)
        .map(|user| user.name().to_string())
        .unwrap_or_else(|| uid.to_string())
}

fn format_process_status(status: sysinfo::ProcessStatus) -> String {
    use sysinfo::ProcessStatus as S;
    match status {
        S::Run => "R",
        S::Sleep => "S",
        S::Stop => "T",
        S::Zombie => "Z",
        S::Tracing => "t",
        S::Dead => "D",
        S::Idle => "I",
        S::LockBlocked => "L",
        S::Parked => "P",
        S::UninterruptibleDiskSleep => "U",
        S::Wakekill | S::Waking => "W",
        S::Unknown(_) => "?",
    }
    .to_string()
}

fn format_process_start(start_time: u64) -> String {
    if start_time == 0 {
        return "-".to_string();
    }
    let Ok(duration) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return "-".to_string();
    };
    let now_secs = duration.as_secs();
    if start_time > now_secs {
        return "-".to_string();
    }
    let elapsed = now_secs - start_time;
    if elapsed < 86_400 {
        let hours = (elapsed / 3600) % 24;
        let mins = (elapsed / 60) % 60;
        format!("{hours:02}:{mins:02}")
    } else {
        let days = elapsed / 86_400;
        format!("{days}d")
    }
}

fn format_cpu_time(run_time: u64) -> String {
    if run_time == 0 {
        return "-".to_string();
    }
    let mins = run_time / 60;
    let secs = run_time % 60;
    if mins >= 60 {
        let hours = mins / 60;
        let mins = mins % 60;
        format!("{hours}:{mins:02}:{secs:02}")
    } else {
        format!("{mins}:{secs:02}")
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
