use std::time::{Duration, SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{SshProcessDetail, SshProcessInfo};
use sysinfo::{Disks, LoadAvg, Pid, ProcessesToUpdate, System, Users};

use super::ssh_pool::{DiskStats, HostSystemStats, MemoryStats, NetworkStats};

/// 与前端 `LOCAL_TERMINAL_RESOURCE_ID` 一致。
pub const LOCAL_HOST_ID: &str = "local-terminal";

const CPU_SAMPLE_MS: u64 = 250;

pub fn fetch_stats() -> OmniResult<HostSystemStats> {
    let mut system = System::new_all();
    system.refresh_all();
    std::thread::sleep(Duration::from_millis(CPU_SAMPLE_MS));
    system.refresh_cpu_all();

    let host_name = System::host_name().unwrap_or_else(|| "localhost".to_string());
    let cpu_cores = system.physical_core_count().unwrap_or(1) as u32;
    let cpu_usage = f64::from(system.global_cpu_usage());

    let total_mem = system.total_memory();
    let avail_mem = system.available_memory();
    let used_mem = total_mem.saturating_sub(avail_mem);

    let disks = Disks::new_with_refreshed_list();
    let (disk_total, disk_used, disk_avail) = primary_disk_stats(&disks);

    let load = format_load(System::load_average());
    let os_info = System::long_os_version()
        .or_else(System::name)
        .unwrap_or_default();

    Ok(HostSystemStats {
        host_id: LOCAL_HOST_ID.to_string(),
        host_name,
        load,
        cpu_cores,
        cpu_usage,
        memory: MemoryStats {
            total: total_mem,
            used: used_mem,
            available: avail_mem,
        },
        disk: DiskStats {
            total: disk_total,
            used: disk_used,
            available: disk_avail,
        },
        network: NetworkStats {
            rx_bytes: 0,
            tx_bytes: 0,
        },
        os_info,
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

fn join_os_args(cmd: &[std::ffi::OsString]) -> String {
    cmd.iter()
        .map(|part| part.to_string_lossy())
        .collect::<Vec<_>>()
        .join(" ")
}

fn primary_disk_stats(disks: &Disks) -> (u64, u64, u64) {
    let preferred = if cfg!(windows) {
        disks
            .iter()
            .find(|disk| {
                disk.mount_point()
                    .to_string_lossy()
                    .eq_ignore_ascii_case("C:\\")
            })
            .or_else(|| disks.iter().next())
    } else {
        disks
            .iter()
            .find(|disk| disk.mount_point().to_string_lossy() == "/")
            .or_else(|| disks.iter().next())
    };

    if let Some(disk) = preferred {
        let total = disk.total_space();
        let available = disk.available_space();
        let used = total.saturating_sub(available);
        (total, used, available)
    } else {
        (0, 0, 0)
    }
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

fn format_load(load: LoadAvg) -> String {
    format!("{:.2} {:.2} {:.2}", load.one, load.five, load.fifteen)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
