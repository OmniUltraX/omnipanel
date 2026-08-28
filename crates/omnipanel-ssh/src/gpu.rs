use std::collections::HashMap;

use crate::SshProcessInfo;
use crate::stats::GpuDeviceStats;

/// NVIDIA `nvidia-smi --query-gpu=...` CSV 行。
pub fn parse_nvidia_gpu_line(line: &str) -> Option<GpuDeviceStats> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if parts.len() < 2 {
        return None;
    }
    let index: u32 = parts[0].parse().ok()?;
    let name = parts[1].to_string();
    let utilization = parts.get(2).and_then(|s| parse_optional_f64(s));
    let memory_total = parts.get(3).and_then(|s| parse_mib_to_bytes(s));
    let memory_used = parts.get(4).and_then(|s| parse_mib_to_bytes(s));
    let temperature = parts.get(5).and_then(|s| parse_optional_f64(s));
    let power = parts.get(6).and_then(|s| parse_optional_f64(s));
    let power_limit = parts.get(7).and_then(|s| parse_optional_f64(s));
    let fan_speed = parts.get(8).and_then(|s| parse_optional_f64(s));

    Some(GpuDeviceStats {
        vendor: "NVIDIA".to_string(),
        name,
        index,
        utilization,
        memory_total,
        memory_used,
        temperature,
        power,
        power_limit,
        fan_speed,
        ..Default::default()
    })
}

pub fn parse_nvidia_gpu_output(output: &str) -> Vec<GpuDeviceStats> {
    output.lines().filter_map(parse_nvidia_gpu_line).collect()
}

/// `pid, util` CSV from nvidia-smi compute apps.
pub fn parse_nvidia_process_gpu(output: &str) -> HashMap<u32, f64> {
    let mut map = HashMap::new();
    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        if parts.len() < 2 {
            continue;
        }
        let pid: u32 = match parts[0].parse() {
            Ok(p) => p,
            Err(_) => continue,
        };
        let util = parse_optional_f64(parts[1]).unwrap_or(0.0);
        map.entry(pid)
            .and_modify(|v: &mut f64| *v = v.max(util))
            .or_insert(util);
    }
    map
}

/// AMD rocm-smi 文本行（产品名）。
pub fn parse_rocm_product_line(line: &str, index: u32) -> Option<GpuDeviceStats> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let name = line
        .split(':')
        .nth(1)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(line)
        .to_string();
    Some(GpuDeviceStats {
        vendor: "AMD".to_string(),
        name,
        index,
        utilization: None,
        memory_total: None,
        memory_used: None,
        temperature: None,
        power: None,
        ..Default::default()
    })
}

/// 简易 rocm-smi 多行输出解析（尽力提取卡名与利用率）。
pub fn parse_rocm_smi_output(output: &str) -> Vec<GpuDeviceStats> {
    let mut devices = Vec::new();
    let mut index = 0u32;

    for line in output.lines() {
        let lower = line.to_lowercase();
        if lower.contains("card series")
            || lower.contains("card model")
            || lower.contains("card product")
            || lower.contains("gpu[")
        {
            if let Some(dev) = parse_rocm_product_line(line, index) {
                devices.push(dev);
                index += 1;
            }
        } else if lower.contains("gpu use") || lower.contains("gpu utilization") {
            if let Some(last) = devices.last_mut() {
                if let Some(pct) = extract_trailing_percent(line) {
                    last.utilization = Some(pct);
                }
            }
        } else if lower.contains("temperature") {
            if let Some(last) = devices.last_mut() {
                last.temperature = extract_trailing_number(line);
            }
        } else if lower.contains("power") {
            if let Some(last) = devices.last_mut() {
                last.power = extract_trailing_number(line);
            }
        }
    }

    if devices.is_empty() {
        for line in output.lines() {
            let trimmed = line.trim();
            if !trimmed.is_empty() && !trimmed.starts_with('=') {
                devices.push(GpuDeviceStats {
                    vendor: "AMD".to_string(),
                    name: trimmed.to_string(),
                    index: devices.len() as u32,
                    utilization: None,
                    memory_total: None,
                    memory_used: None,
                    temperature: None,
                    power: None,
                    ..Default::default()
                });
                if devices.len() >= 8 {
                    break;
                }
            }
        }
    }

    devices
}

/// Intel lspci 行：`00:02.0 VGA compatible controller: Intel Corporation ...`
pub fn parse_intel_lspci_line(line: &str, index: u32) -> Option<GpuDeviceStats> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let name = line
        .split(':')
        .nth(2)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(line)
        .to_string();
    Some(GpuDeviceStats {
        vendor: "Intel".to_string(),
        name,
        index,
        utilization: None,
        memory_total: None,
        memory_used: None,
        temperature: None,
        power: None,
        ..Default::default()
    })
}

pub fn parse_intel_lspci_output(output: &str) -> Vec<GpuDeviceStats> {
    output
        .lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let lower = line.to_lowercase();
            if lower.contains("intel") {
                parse_intel_lspci_line(line, i as u32)
            } else {
                None
            }
        })
        .collect()
}

/// 从远程 stats 脚本的 GPU 分段合并设备列表。
pub fn parse_remote_gpu_sections(sections: &HashMap<String, String>) -> Vec<GpuDeviceStats> {
    let mut devices = Vec::new();

    if let Some(raw) = sections.get("gpu_nvidia") {
        devices.extend(parse_nvidia_gpu_output(raw));
    }
    if let Some(raw) = sections.get("gpu_amd") {
        let amd = parse_rocm_smi_output(raw);
        for mut dev in amd {
            dev.index = devices.len() as u32;
            devices.push(dev);
        }
    }
    if let Some(raw) = sections.get("gpu_intel") {
        let intel = parse_intel_lspci_output(raw);
        for mut dev in intel {
            dev.index = devices.len() as u32;
            devices.push(dev);
        }
    }

    devices
}

pub fn attach_process_gpu(processes: &mut [SshProcessInfo], gpu_by_pid: &HashMap<u32, f64>) {
    for proc in processes.iter_mut() {
        proc.gpu_usage = gpu_by_pid.get(&proc.pid).copied();
    }
}

pub const NVIDIA_GPU_QUERY: &str = "nvidia-smi --query-gpu=index,name,utilization.gpu,memory.total,memory.used,temperature.gpu,power.draw,power.limit,fan.speed --format=csv,noheader,nounits 2>/dev/null";

pub const NVIDIA_PROCESS_GPU_QUERY: &str =
    "nvidia-smi --query-compute-apps=pid,utilization.gpu --format=csv,noheader,nounits 2>/dev/null";

pub const ROCM_SMI_QUERY: &str =
    "rocm-smi --showuse --showtemp --showpower --showproductname 2>/dev/null";

pub const INTEL_GPU_QUERY: &str =
    "lspci 2>/dev/null | grep -iE 'VGA|3D|Display' | grep -i intel || true";

fn parse_optional_f64(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("N/A") || s == "[N/A]" {
        return None;
    }
    s.trim_end_matches('%').parse().ok()
}

fn parse_mib_to_bytes(s: &str) -> Option<u64> {
    let s = s.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("N/A") {
        return None;
    }
    let val: f64 = s.parse().ok()?;
    Some((val * 1024.0 * 1024.0) as u64)
}

fn extract_trailing_percent(line: &str) -> Option<f64> {
    line.split_whitespace()
        .filter_map(|tok| tok.trim_end_matches('%').parse().ok())
        .last()
}

fn extract_trailing_number(line: &str) -> Option<f64> {
    line.split_whitespace()
        .filter_map(|tok| tok.parse().ok())
        .last()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_nvidia_gpu_csv() {
        let line = "0, NVIDIA GeForce RTX 3080, 45, 10240, 2048, 65, 220.5";
        let dev = parse_nvidia_gpu_line(line).expect("gpu");
        assert_eq!(dev.vendor, "NVIDIA");
        assert_eq!(dev.utilization, Some(45.0));
        assert!(dev.memory_total.unwrap() > 0);
    }

    #[test]
    fn parse_nvidia_process_gpu_merges_max() {
        let out = "1234, 10\n1234, 25\n5678, 5";
        let map = parse_nvidia_process_gpu(out);
        assert_eq!(map.get(&1234), Some(&25.0));
        assert_eq!(map.get(&5678), Some(&5.0));
    }

    #[test]
    fn parse_intel_lspci() {
        let line = "00:02.0 VGA compatible controller: Intel Corporation UHD Graphics 630";
        let dev = parse_intel_lspci_line(line, 0).expect("intel");
        assert_eq!(dev.vendor, "Intel");
        assert!(dev.name.contains("Intel"));
    }

    #[test]
    fn attach_process_gpu_sets_field() {
        let mut procs = vec![SshProcessInfo {
            user: "u".into(),
            pid: 42,
            cpu: 0.0,
            mem: 0.0,
            vsz: 0,
            rss: 0,
            stat: "S".into(),
            start: "0".into(),
            time: "0".into(),
            command: "test".into(),
            ports: vec![],
            gpu_usage: None,
        }];
        let mut map = HashMap::new();
        map.insert(42, 33.0);
        attach_process_gpu(&mut procs, &map);
        assert_eq!(procs[0].gpu_usage, Some(33.0));
    }
}
