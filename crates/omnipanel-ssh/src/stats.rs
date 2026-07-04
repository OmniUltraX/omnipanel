use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use specta::Type;

/// CPU 指标：总使用率、核心数、每核使用率、负载。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CpuStats {
    pub usage: f64,
    pub cores: u32,
    pub per_core_usage: Vec<f64>,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frequency_mhz: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
}

/// 物理内存与 swap / 虚拟内存。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStats {
    #[specta(type = f64)]
    pub total: u64,
    #[specta(type = f64)]
    pub used: u64,
    #[specta(type = f64)]
    pub available: u64,
    #[specta(type = f64)]
    pub swap_total: u64,
    #[specta(type = f64)]
    pub swap_used: u64,
    #[specta(type = f64)]
    pub swap_available: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub cached: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub buffers: Option<u64>,
}

/// 单个磁盘 / 挂载点。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskDeviceStats {
    pub name: String,
    pub mount_point: String,
    pub file_system: String,
    #[specta(type = f64)]
    pub total: u64,
    #[specta(type = f64)]
    pub used: u64,
    #[specta(type = f64)]
    pub available: u64,
}

/// 磁盘汇总与明细列表。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DiskStats {
    #[specta(type = f64)]
    pub total: u64,
    #[specta(type = f64)]
    pub used: u64,
    #[specta(type = f64)]
    pub available: u64,
    pub disks: Vec<DiskDeviceStats>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub read_bytes: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub write_bytes: Option<u64>,
}

/// 单块 GPU 设备。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GpuDeviceStats {
    pub vendor: String,
    pub name: String,
    pub index: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub memory_total: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub memory_used: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub power_limit: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fan_speed: Option<f64>,
}

/// GPU 总览（多卡列表，空列表表示未检测到）。
#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub devices: Vec<GpuDeviceStats>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStats {
    #[specta(type = f64)]
    pub rx_bytes: u64,
    #[specta(type = f64)]
    pub tx_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interface: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connections: Option<u32>,
}

/// 主机系统监控快照（本机与远程 SSH 共用）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HostSystemStats {
    pub host_id: String,
    pub host_name: String,
    /// 格式化的负载字符串，如 `0.52 0.48 0.45`。
    pub load: String,
    pub cpu: CpuStats,
    pub cpu_cores: u32,
    pub cpu_usage: f64,
    pub memory: MemoryStats,
    pub disk: DiskStats,
    pub gpu: GpuStats,
    pub network: NetworkStats,
    pub os_info: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[specta(type = Option<f64>)]
    pub uptime_secs: Option<u64>,
    #[specta(type = f64)]
    pub timestamp: u64,
}

const PSEUDO_FS: &[&str] = &[
    "tmpfs",
    "devtmpfs",
    "overlay",
    "squashfs",
    "efivarfs",
    "cgroup",
    "cgroup2",
    "devfs",
    "proc",
    "sysfs",
    "autofs",
    "mqueue",
    "debugfs",
    "tracefs",
    "securityfs",
    "pstore",
    "configfs",
    "fusectl",
    "binfmt_misc",
];

pub fn is_pseudo_filesystem(fs: &str) -> bool {
    PSEUDO_FS.iter().any(|p| fs.eq_ignore_ascii_case(p))
}

pub fn format_load(load1: f64, load5: f64, load15: f64) -> String {
    format!("{load1:.2} {load5:.2} {load15:.2}")
}

pub fn aggregate_disk_stats(disks: &[DiskDeviceStats]) -> (u64, u64, u64) {
    let mut total = 0u64;
    let mut used = 0u64;
    let mut available = 0u64;
    for d in disks {
        total = total.saturating_add(d.total);
        used = used.saturating_add(d.used);
        available = available.saturating_add(d.available);
    }
    (total, used, available)
}

pub fn parse_memory_triplet(raw: &str) -> (u64, u64, u64) {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    let total: u64 = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut used: u64 = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut available: u64 = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
    if total > 0 {
        if used == 0 && available > 0 && available <= total {
            used = total.saturating_sub(available);
        } else if available == 0 && used > 0 && used <= total {
            available = total.saturating_sub(used);
        }
    }
    (total, used, available)
}

pub fn build_memory_stats(phys: &str, swap: &str) -> MemoryStats {
    let (total, used, available) = parse_memory_triplet(phys);
    let (swap_total, swap_used, swap_available) = parse_memory_triplet(swap);
    MemoryStats {
        total,
        used,
        available,
        swap_total,
        swap_used,
        swap_available,
        ..Default::default()
    }
}

/// 解析 `df -B1 -P -T` 的 tab 分隔行：`dev\tmount\tfs\ttotal\tused\tavail`。
pub fn parse_disk_line(line: &str) -> Option<DiskDeviceStats> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.split('\t').collect();
    if parts.len() < 6 {
        return None;
    }
    let file_system = parts[2].trim();
    if is_pseudo_filesystem(file_system) {
        return None;
    }
    let total: u64 = parts[3].trim().parse().ok()?;
    if total == 0 {
        return None;
    }
    let used: u64 = parts[4].trim().parse().ok()?;
    let available: u64 = parts[5].trim().parse().ok()?;
    Some(DiskDeviceStats {
        name: parts[0].trim().to_string(),
        mount_point: parts[1].trim().to_string(),
        file_system: file_system.to_string(),
        total,
        used,
        available,
    })
}

pub fn parse_disk_lines(raw: &str) -> DiskStats {
    let mut disks: Vec<DiskDeviceStats> = raw
        .lines()
        .filter_map(parse_disk_line)
        .collect();
    disks.sort_by(|a, b| {
        b.total
            .cmp(&a.total)
            .then_with(|| a.mount_point.cmp(&b.mount_point))
    });
    let (total, used, available) = aggregate_disk_stats(&disks);
    DiskStats {
        total,
        used,
        available,
        disks,
        ..Default::default()
    }
}

/// 解析 `/proc/stat` 片段，返回 `(global_total, global_idle, per_core: Vec<(name, total, idle)>)`。
pub fn parse_proc_stat_sample(raw: &str) -> (u64, u64, Vec<(String, u64, u64)>) {
    let mut global_total = 0u64;
    let mut global_idle = 0u64;
    let mut per_core = Vec::new();

    for line in raw.lines() {
        let line = line.trim();
        if !line.starts_with("cpu") {
            continue;
        }
        let mut parts = line.split_whitespace();
        let name = parts.next().unwrap_or("cpu").to_string();
        let values: Vec<u64> = parts.filter_map(|v| v.parse().ok()).collect();
        if values.len() < 4 {
            continue;
        }
        let total: u64 = values.iter().take(10).sum();
        let idle = values[3].saturating_add(values.get(4).copied().unwrap_or(0));
        if name == "cpu" {
            global_total = total;
            global_idle = idle;
        } else {
            per_core.push((name, total, idle));
        }
    }

    per_core.sort_by(|a, b| a.0.cmp(&b.0));
    (global_total, global_idle, per_core)
}

fn cpu_usage_from_delta(total1: u64, idle1: u64, total2: u64, idle2: u64) -> f64 {
    let dt = total2.saturating_sub(total1);
    let di = idle2.saturating_sub(idle1);
    if dt == 0 {
        return 0.0;
    }
    let busy = dt.saturating_sub(di);
    (busy as f64 / dt as f64 * 100.0).clamp(0.0, 100.0)
}

pub fn compute_cpu_stats(sample1: &str, sample2: &str, load1: f64, load5: f64, load15: f64) -> CpuStats {
    let (gt1, gi1, cores1) = parse_proc_stat_sample(sample1);
    let (gt2, gi2, cores2) = parse_proc_stat_sample(sample2);
    let usage = cpu_usage_from_delta(gt1, gi1, gt2, gi2);

    let core_map1: HashMap<String, (u64, u64)> =
        cores1.into_iter().map(|(n, t, i)| (n, (t, i))).collect();
    let mut per_core_usage = Vec::new();
    for (name, t2, i2) in cores2 {
        if let Some((t1, i1)) = core_map1.get(&name) {
            per_core_usage.push(cpu_usage_from_delta(*t1, *i1, t2, i2));
        }
    }

    let cores = per_core_usage.len().max(1) as u32;
    CpuStats {
        usage,
        cores,
        per_core_usage,
        load1,
        load5,
        load15,
        ..Default::default()
    }
}

pub fn parse_network(raw: &str) -> NetworkStats {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    NetworkStats {
        rx_bytes: parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
        tx_bytes: parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
        ..Default::default()
    }
}

fn split_sections(output: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut current = String::new();
    let mut key = String::new();

    for line in output.lines() {
        if let Some(section) = line.strip_prefix("@SECTION ") {
            if !key.is_empty() {
                map.insert(key.clone(), current.trim_end().to_string());
            }
            key = section.trim().to_string();
            current.clear();
        } else if !key.is_empty() {
            if !current.is_empty() {
                current.push('\n');
            }
            current.push_str(line);
        } else if let Some((k, v)) = line.split_once('=') {
            // 兼容旧版 key=value 单行格式
            map.insert(k.trim().to_string(), v.trim().to_string());
        }
    }
    if !key.is_empty() {
        map.insert(key, current.trim_end().to_string());
    }
    map
}

fn parse_load_triplet(raw: &str) -> (f64, f64, f64) {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    (
        parts.first().and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0.0),
        parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0.0),
    )
}

/// 解析远程 SSH stats 脚本输出。
pub fn parse_remote_stats_output(
    session_id: &str,
    host_name: &str,
    output: &str,
    gpu_devices: &[GpuDeviceStats],
) -> Option<HostSystemStats> {
    let sections = split_sections(output);

    // 新版分段格式
    if sections.contains_key("load") || sections.contains_key("cpu_stat1") {
        let (load1, load5, load15) = parse_load_triplet(sections.get("load").map(String::as_str).unwrap_or(""));
        let cpu = compute_cpu_stats(
            sections.get("cpu_stat1").map(String::as_str).unwrap_or(""),
            sections.get("cpu_stat2").map(String::as_str).unwrap_or(""),
            load1,
            load5,
            load15,
        );
        let cores_override: Option<u32> = sections
            .get("cores")
            .and_then(|s| s.trim().parse().ok());
        let cpu_cores = cores_override.unwrap_or(cpu.cores);
        let mut cpu = cpu;
        cpu.cores = cpu_cores;
        cpu.frequency_mhz = sections.get("cpu_freq").and_then(|s| {
            let t = s.trim();
            if t.is_empty() { None } else { t.parse().ok() }
        });
        cpu.temperature = sections
            .get("cpu_temp")
            .and_then(|s| s.trim().parse().ok());

        let memory = build_memory_stats(
            sections.get("mem").map(String::as_str).unwrap_or(""),
            sections.get("swap").map(String::as_str).unwrap_or(""),
        );
        let mut memory = memory;
        if let Some(raw) = sections.get("mem_detail") {
            let parts: Vec<&str> = raw.split_whitespace().collect();
            memory.cached = parts.first().and_then(|s| s.parse().ok());
            memory.buffers = parts.get(1).and_then(|s| s.parse().ok());
        }
        let mut disk = parse_disk_lines(sections.get("disks").map(String::as_str).unwrap_or(""));
        if let Some(raw) = sections.get("diskio") {
            let parts: Vec<&str> = raw.split_whitespace().collect();
            disk.read_bytes = parts.first().and_then(|s| s.parse().ok());
            disk.write_bytes = parts.get(1).and_then(|s| s.parse().ok());
        }
        let mut network = parse_network(sections.get("net").map(String::as_str).unwrap_or(""));
        if let Some(iface) = sections.get("net_if").filter(|s| !s.trim().is_empty()) {
            network.interface = Some(iface.trim().to_string());
        }
        network.connections = sections
            .get("conn_count")
            .and_then(|s| s.trim().parse().ok());
        let os_info = sections.get("os").cloned().unwrap_or_default();
        let load = format_load(load1, load5, load15);
        let uptime_secs = sections
            .get("uptime")
            .and_then(|s| s.trim().parse().ok());

        let mut gpu = GpuStats {
            devices: gpu_devices.to_vec(),
        };
        if gpu.devices.is_empty() {
            gpu.devices = super::gpu::parse_remote_gpu_sections(&sections);
        }

        return Some(HostSystemStats {
            host_id: session_id.to_string(),
            host_name: host_name.to_string(),
            load,
            cpu_usage: cpu.usage,
            cpu_cores,
            cpu,
            memory,
            disk,
            gpu,
            network,
            os_info,
            uptime_secs,
            timestamp: now_secs(),
        });
    }

    // 旧版 key=value 单行格式（向后兼容）
    let load = sections.get("load").cloned().unwrap_or_default();
    let (load1, load5, load15) = parse_load_triplet(&load);
    let cpu_cores: u32 = sections
        .get("cores")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);
    let cpu_usage: f64 = sections
        .get("cpu")
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0.0);
    let memory = build_memory_stats(
        sections.get("mem").map(String::as_str).unwrap_or(""),
        "0 0 0",
    );
    let disk_raw = sections.get("disk").map(String::as_str).unwrap_or("");
    let disk_parts: Vec<&str> = disk_raw.split_whitespace().collect();
    let disk = DiskStats {
        total: disk_parts.first().and_then(|s| s.parse().ok()).unwrap_or(0),
        used: disk_parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0),
        available: disk_parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
        disks: Vec::new(),
        ..Default::default()
    };
    let network = parse_network(sections.get("net").map(String::as_str).unwrap_or(""));
    let os_info = sections.get("os").cloned().unwrap_or_default();

    Some(HostSystemStats {
        host_id: session_id.to_string(),
        host_name: host_name.to_string(),
        load,
        cpu: CpuStats {
            usage: cpu_usage,
            cores: cpu_cores,
            per_core_usage: Vec::new(),
            load1,
            load5,
            load15,
            ..Default::default()
        },
        cpu_cores,
        cpu_usage,
        memory,
        disk,
        gpu: GpuStats {
            devices: gpu_devices.to_vec(),
        },
        network,
        os_info,
        uptime_secs: None,
        timestamp: now_secs(),
    })
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_memory_derives_used() {
        let (t, u, a) = parse_memory_triplet("1000 0 400");
        assert_eq!(t, 1000);
        assert_eq!(u, 600);
        assert_eq!(a, 400);
    }

    #[test]
    fn parse_disk_line_tab_separated() {
        let d = parse_disk_line("/dev/sda1\t/\text4\t1000\t400\t600").expect("disk");
        assert_eq!(d.mount_point, "/");
        assert_eq!(d.total, 1000);
        assert_eq!(d.available, 600);
    }

    #[test]
    fn parse_disk_skips_tmpfs() {
        assert!(parse_disk_line("tmpfs\t/run\ttmpfs\t100\t0\t100").is_none());
    }

    #[test]
    fn compute_cpu_from_proc_stat() {
        let s1 = "cpu 100 20 30 40 0 0 0 0 0 0\ncpu0 50 10 15 20 0 0 0 0 0 0";
        let s2 = "cpu 200 20 30 80 0 0 0 0 0 0\ncpu0 100 10 15 40 0 0 0 0 0 0";
        let cpu = compute_cpu_stats(s1, s2, 1.0, 2.0, 3.0);
        assert!(cpu.usage > 0.0);
        assert_eq!(cpu.cores, 1);
        assert!(!cpu.per_core_usage.is_empty());
    }

    #[test]
    fn parse_remote_sectioned_output() {
        let output = r#"
@SECTION load
0.50 0.40 0.30
@SECTION cores
4
@SECTION cpu_stat1
cpu 100 20 30 40 0 0 0 0 0 0
@SECTION cpu_stat2
cpu 200 20 30 80 0 0 0 0 0 0
@SECTION mem
8000 4000 4000
@SECTION swap
2000 500 1500
@SECTION disks
/dev/sda1	/	ext4	1000000	400000	600000
@SECTION net
1000 2000
@SECTION os
Ubuntu 22.04
"#;
        let stats = parse_remote_stats_output("ssh-1", "host", output, &[]).expect("stats");
        assert_eq!(stats.cpu_cores, 4);
        assert_eq!(stats.memory.swap_total, 2000);
        assert_eq!(stats.disk.disks.len(), 1);
        assert_eq!(stats.network.rx_bytes, 1000);
        assert_eq!(stats.os_info, "Ubuntu 22.04");
    }

    #[test]
    fn parse_remote_macos_os_section() {
        let output = r#"
@SECTION load
1.20 1.10 1.00
@SECTION cores
8
@SECTION cpu_stat1

@SECTION cpu_stat2

@SECTION mem
17179869184 8589934592 8589934592
@SECTION swap
0 0 0
@SECTION os
macOS 15.2
"#;
        let stats = parse_remote_stats_output("ssh-1", "host", output, &[]).expect("stats");
        assert_eq!(stats.os_info, "macOS 15.2");
        assert_eq!(stats.cpu_cores, 8);
    }
}
