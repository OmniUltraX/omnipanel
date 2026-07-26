use std::time::{Duration, SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{
    aggregate_disk_stats, attach_ports, format_load, is_pseudo_filesystem, CpuStats, DiskDeviceStats,
    DiskStats, HostSystemStats, MemoryStats, NetworkStats, SshProcessDetail, SshProcessInfo,
};
use sysinfo::{Disks, Networks, Pid, ProcessesToUpdate, System, Users};

use super::gpu_local::{collect_local_gpu, enrich_local_process_gpu};
use super::local_ports::collect_local_listen_ports;

/// 与前端 `LOCAL_TERMINAL_RESOURCE_ID` 一致。
pub const LOCAL_HOST_ID: &str = "local-terminal";

const CPU_SAMPLE_MS: u64 = 250;

pub fn fetch_stats() -> OmniResult<HostSystemStats> {
    // 看板/概览只需 CPU + 内存；勿 System::new_all / refresh_all（会扫全进程，Windows 首屏极慢）
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
        frequency_mhz: system
            .cpus()
            .first()
            .map(|cpu| cpu.frequency() as f64),
        temperature: read_cpu_temperature(),
    };

    let (mem_cached, mem_buffers) = read_memory_detail();
    let total_mem = system.total_memory();
    let avail_mem = system.available_memory();
    let used_mem = total_mem.saturating_sub(avail_mem);
    let swap_total = system.total_swap();
    let swap_free = system.free_swap();
    let swap_used = swap_total.saturating_sub(swap_free);

    let disks_sys = Disks::new_with_refreshed_list();
    let disk_devices = collect_disk_devices(&disks_sys);
    let (disk_total, disk_used, disk_avail) = aggregate_disk_stats(&disk_devices);
    let (disk_read, disk_write) = read_disk_io_counters();

    let networks = Networks::new_with_refreshed_list();
    let (network, _) = collect_network_stats(&networks);

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
            cached: mem_cached,
            buffers: mem_buffers,
        },
        disk: DiskStats {
            total: disk_total,
            used: disk_used,
            available: disk_avail,
            disks: disk_devices,
            read_bytes: disk_read,
            write_bytes: disk_write,
        },
        gpu: collect_local_gpu(),
        network,
        os_info,
        uptime_secs: Some(System::uptime()),
        timestamp: now_ms(),
    })
}

pub fn list_processes() -> OmniResult<Vec<SshProcessInfo>> {
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

    enrich_local_process_gpu(&mut processes);
    let ports_by_pid = collect_local_listen_ports();
    attach_ports(&mut processes, &ports_by_pid);

    processes.sort_by(|a, b| {
        b.cpu
            .partial_cmp(&a.cpu)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.pid.cmp(&b.pid))
    });

    Ok(processes)
}

pub fn process_detail(pid: u32) -> OmniResult<SshProcessDetail> {
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

    Ok(SshProcessDetail {
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

pub fn kill_process(pid: u32) -> OmniResult<()> {
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

fn collect_network_stats(networks: &Networks) -> (NetworkStats, u64) {
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

    (
        NetworkStats {
            rx_bytes,
            tx_bytes,
            interface: primary_iface,
            connections: None,
        },
        max_traffic,
    )
}

#[cfg(unix)]
fn read_memory_detail() -> (Option<u64>, Option<u64>) {
    let raw = std::fs::read_to_string("/proc/meminfo").unwrap_or_default();
    let mut cached = None;
    let mut buffers = None;
    for line in raw.lines() {
        if line.starts_with("Cached:") {
            cached = line
                .split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<u64>().ok())
                .map(|kb| kb * 1024);
        } else if line.starts_with("Buffers:") {
            buffers = line
                .split_whitespace()
                .nth(1)
                .and_then(|v| v.parse::<u64>().ok())
                .map(|kb| kb * 1024);
        }
    }
    (cached, buffers)
}

#[cfg(not(unix))]
fn read_memory_detail() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(unix)]
fn read_disk_io_counters() -> (Option<u64>, Option<u64>) {
    let raw = std::fs::read_to_string("/proc/diskstats").unwrap_or_default();
    let mut read_sectors = 0u64;
    let mut write_sectors = 0u64;
    for line in raw.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 11 {
            continue;
        }
        read_sectors = read_sectors.saturating_add(parts[5].parse().unwrap_or(0));
        write_sectors = write_sectors.saturating_add(parts[9].parse().unwrap_or(0));
    }
    (
        Some(read_sectors.saturating_mul(512)),
        Some(write_sectors.saturating_mul(512)),
    )
}

#[cfg(windows)]
fn read_disk_io_counters() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(all(not(unix), not(windows)))]
fn read_disk_io_counters() -> (Option<u64>, Option<u64>) {
    (None, None)
}

#[cfg(unix)]
fn read_cpu_temperature() -> Option<f64> {
    std::fs::read_to_string("/sys/class/thermal/thermal_zone0/temp")
        .ok()
        .and_then(|raw| raw.trim().parse::<f64>().ok())
        .map(|millideg| millideg / 1000.0)
}

#[cfg(not(unix))]
fn read_cpu_temperature() -> Option<f64> {
    None
}

fn join_os_args(cmd: &[std::ffi::OsString]) -> String {
    cmd.iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_user_name(user_id: Option<&sysinfo::Uid>, users: &Users) -> String {
    let Some(uid) = user_id else {
        return "—".to_string();
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
        return "—".to_string();
    }
    let Ok(duration) = SystemTime::UNIX_EPOCH.duration_since(UNIX_EPOCH) else {
        return "—".to_string();
    };
    let now_secs = duration.as_secs();
    if start_time > now_secs {
        return "—".to_string();
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
        return "—".to_string();
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
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
