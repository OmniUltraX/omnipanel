use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use omnipanel_ssh::{
    attach_process_gpu, parse_nvidia_gpu_output, parse_nvidia_process_gpu, parse_rocm_smi_output,
    GpuDeviceStats, GpuStats, SshProcessInfo, NVIDIA_GPU_QUERY, ROCM_SMI_QUERY,
};
#[cfg(all(not(windows), not(target_os = "macos")))]
use omnipanel_ssh::parse_intel_lspci_output;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows：子进程不弹出控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const GPU_DEVICE_CACHE_TTL: Duration = Duration::from_secs(30);
const GPU_PROCESS_CACHE_TTL: Duration = Duration::from_secs(10);

static GPU_DEVICE_CACHE: OnceLock<Mutex<Option<CachedGpu>>> = OnceLock::new();
static GPU_PROCESS_CACHE: OnceLock<Mutex<Option<CachedProcessGpu>>> = OnceLock::new();

struct CachedGpu {
    at: Instant,
    stats: GpuStats,
}

struct CachedProcessGpu {
    at: Instant,
    by_pid: HashMap<u32, f64>,
}

pub fn collect_local_gpu() -> GpuStats {
    let cache = GPU_DEVICE_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = guard.as_ref() {
        if cached.at.elapsed() < GPU_DEVICE_CACHE_TTL {
            return cached.stats.clone();
        }
    }
    let stats = collect_local_gpu_uncached();
    *guard = Some(CachedGpu {
        at: Instant::now(),
        stats: stats.clone(),
    });
    stats
}

fn collect_local_gpu_uncached() -> GpuStats {
    let mut devices = Vec::new();

    if let Some(nv) = run_gpu_query(NVIDIA_GPU_QUERY) {
        devices.extend(parse_nvidia_gpu_output(&nv));
    }

    if devices.is_empty() {
        if let Some(amd) = run_gpu_query(ROCM_SMI_QUERY) {
            devices.extend(parse_rocm_smi_output(&amd));
        }
    }

    if devices.is_empty() {
        #[cfg(target_os = "macos")]
        {
            if let Some(out) = run_command("system_profiler", &["SPDisplaysDataType"]) {
                devices.extend(parse_macos_displays(&out));
            }
        }
        #[cfg(windows)]
        {
            devices.extend(collect_windows_gpu());
            enrich_windows_gpu_perf(&mut devices);
        }
        #[cfg(all(not(windows), not(target_os = "macos")))]
        if let Some(out) = run_shell_pipeline(
            "lspci 2>/dev/null | grep -iE 'VGA|3D|Display' | grep -i intel || true",
        ) {
            devices.extend(parse_intel_lspci_output(&out));
        }
    } else {
        #[cfg(windows)]
        enrich_windows_gpu_perf(&mut devices);
    }

    GpuStats { devices }
}

pub fn enrich_local_process_gpu(processes: &mut [SshProcessInfo]) {
    let cache = GPU_PROCESS_CACHE.get_or_init(|| Mutex::new(None));
    let map = {
        let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.as_ref() {
            if cached.at.elapsed() < GPU_PROCESS_CACHE_TTL {
                cached.by_pid.clone()
            } else {
                let by_pid = fetch_process_gpu_map();
                *guard = Some(CachedProcessGpu {
                    at: Instant::now(),
                    by_pid: by_pid.clone(),
                });
                by_pid
            }
        } else {
            let by_pid = fetch_process_gpu_map();
            *guard = Some(CachedProcessGpu {
                at: Instant::now(),
                by_pid: by_pid.clone(),
            });
            by_pid
        }
    };

    if !map.is_empty() {
        attach_process_gpu(processes, &map);
    }
}

fn fetch_process_gpu_map() -> HashMap<u32, f64> {
    run_nvidia_smi(&["--query-compute-apps=pid,utilization.gpu", "--format=csv,noheader,nounits"])
        .map(|out| parse_nvidia_process_gpu(&out))
        .unwrap_or_default()
}

/// Windows 上 nvidia-smi 常不在 PATH，需解析标准安装路径。
fn resolve_nvidia_smi_program() -> Option<String> {
    #[cfg(windows)]
    {
        if let Some(out) = run_command(&system_exe("where.exe"), &["nvidia-smi"]) {
            if let Some(first) = out.lines().map(str::trim).find(|line| !line.is_empty()) {
                if std::path::Path::new(first).is_file() {
                    return Some(first.to_string());
                }
            }
        }
        const CANDIDATES: &[&str] = &[
            r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi.exe",
            r"C:\Windows\System32\nvidia-smi.exe",
            r"C:\Program Files\NVIDIA Corporation\NVSMI\nvidia-smi",
        ];
        for candidate in CANDIDATES {
            if std::path::Path::new(candidate).is_file() {
                return Some(candidate.to_string());
            }
        }
    }
    Some("nvidia-smi".to_string())
}

fn run_nvidia_smi(args: &[&str]) -> Option<String> {
    let program = resolve_nvidia_smi_program()?;
    run_command(&program, args)
}

/// 尽量直接执行可执行文件，避免在 Windows 上额外启动 cmd 窗口。
fn run_gpu_query(query: &str) -> Option<String> {
    let trimmed = query.trim();
    #[cfg(windows)]
    {
        let stripped = trimmed
            .trim_end_matches("2>/dev/null")
            .trim_end_matches("2>nul")
            .trim();
        if !stripped.contains('|') && !stripped.contains("&&") && !stripped.contains("||") {
            let mut parts = stripped.split_whitespace();
            let program = parts.next()?;
            let args: Vec<&str> = parts.collect();
            if program.eq_ignore_ascii_case("nvidia-smi") {
                return run_nvidia_smi(&args);
            }
            return run_command(program, &args);
        }
    }
    #[cfg(not(windows))]
    {
        if !trimmed.contains('|') && !trimmed.contains("&&") {
            let mut parts = trimmed.split_whitespace();
            let program = parts.next()?;
            let args: Vec<&str> = parts.collect();
            if program.eq_ignore_ascii_case("nvidia-smi") {
                if let Some(out) = run_nvidia_smi(&args) {
                    return Some(out);
                }
            }
            if let Some(out) = run_command(program, &args) {
                return Some(out);
            }
        }
    }
    run_shell_pipeline(trimmed)
}

fn run_shell_pipeline(script: &str) -> Option<String> {
    if cfg!(windows) {
        run_command("cmd", &["/C", script])
    } else {
        run_command("sh", &["-lc", script])
    }
}

fn run_command(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let output = cmd.output().ok()?;
    if !output.status.success() && output.stdout.is_empty() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(windows)]
fn collect_windows_gpu() -> Vec<GpuDeviceStats> {
    let ps = r"Get-CimInstance Win32_VideoController | ForEach-Object { $n = $_.Name -replace ',',' '; Write-Output ($_.DeviceID.ToString() + '|' + $n) }";
    let out = run_command(
        &system_exe("WindowsPowerShell\\v1.0\\powershell.exe"),
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            ps,
        ],
    )
    .unwrap_or_default();

    parse_windows_gpu_lines(&out)
}

#[cfg(windows)]
fn parse_windows_gpu_lines(out: &str) -> Vec<GpuDeviceStats> {
    out.lines()
        .enumerate()
        .filter_map(|(i, line)| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            let (_device_id, name) = line.split_once('|')?;
            let name = name.trim();
            if is_virtual_gpu_name(name) {
                return None;
            }
            let lower = name.to_lowercase();
            let vendor = if lower.contains("nvidia") {
                "NVIDIA"
            } else if lower.contains("amd") || lower.contains("radeon") {
                "AMD"
            } else if lower.contains("intel") {
                "Intel"
            } else {
                "Unknown"
            };
            Some(GpuDeviceStats {
                vendor: vendor.to_string(),
                name: name.to_string(),
                index: i as u32,
                utilization: None,
                memory_total: None,
                memory_used: None,
                temperature: None,
                power: None,
                ..Default::default()
            })
        })
        .enumerate()
        .map(|(index, mut dev)| {
            dev.index = index as u32;
            dev
        })
        .collect()
}

#[cfg(windows)]
fn is_virtual_gpu_name(name: &str) -> bool {
    let lower = name.to_lowercase();
    [
        "virtual",
        "idd driver",
        "oray",
        "todesk",
        "parsec",
        "meta virtual",
        "microsoft basic",
        "remote desktop",
        "indirect display",
        "mirror",
    ]
    .iter()
    .any(|token| lower.contains(token))
}

#[cfg(windows)]
fn enrich_windows_gpu_perf(devices: &mut [GpuDeviceStats]) {
    if devices.is_empty() {
        return;
    }
    let ps = r#"
$adapters = @{}
(Get-Counter '\GPU Adapter Memory(*phys_0*)\Dedicated Usage','\GPU Adapter Memory(*phys_0*)\Total Committed' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object {
  if ($_.Path -match 'luid_(0x[0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)_phys_0') {
    $id = ($matches[1] + $matches[2]).ToLower()
    if (-not $adapters.ContainsKey($id)) { $adapters[$id] = @{ Used = [uint64]0; Total = [uint64]0; Util = 0.0 } }
    if ($_.Path -like '*Dedicated Usage*') { $adapters[$id].Used = [uint64]$_.CookedValue }
    else { $adapters[$id].Total = [uint64]$_.CookedValue }
  }
}
(Get-Counter '\GPU Engine(*)\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | ForEach-Object {
  if ($_.InstanceName -match 'luid_(0x[0-9A-Fa-f]+)_0x([0-9A-Fa-f]+)_') {
    $id = ($matches[1] + $matches[2]).ToLower()
    if ($adapters.ContainsKey($id) -and $_.CookedValue -gt $adapters[$id].Util) {
      $adapters[$id].Util = $_.CookedValue
    }
  }
}
$adapters.GetEnumerator() | Sort-Object { $_.Value.Total } -Descending | ForEach-Object {
  if ($_.Value.Total -ge 67108864) {
    Write-Output ("ADP|{0}|{1}|{2}" -f [int][math]::Round($_.Value.Util), $_.Value.Used, $_.Value.Total)
  }
}
"#;
    let out = run_command(
        &system_exe("WindowsPowerShell\\v1.0\\powershell.exe"),
        &[
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-Command",
            ps,
        ],
    )
    .unwrap_or_default();

    let perf_rows: Vec<(f64, u64, u64)> = out
        .lines()
        .filter_map(parse_windows_gpu_perf_line)
        .collect();

    for (i, dev) in devices.iter_mut().enumerate() {
        let Some((util, mem_used, mem_total)) = perf_rows.get(i) else {
            continue;
        };
        dev.utilization = Some(*util);
        dev.memory_used = Some(*mem_used);
        dev.memory_total = Some(*mem_total);
    }
}

#[cfg(windows)]
fn parse_windows_gpu_perf_line(line: &str) -> Option<(f64, u64, u64)> {
    let line = line.trim();
    let rest = line.strip_prefix("ADP|")?;
    let mut parts = rest.split('|');
    let util: f64 = parts.next()?.parse().ok()?;
    let mem_used: u64 = parts.next()?.parse().ok()?;
    let mem_total: u64 = parts.next()?.parse().ok()?;
    Some((util, mem_used, mem_total))
}

#[cfg(windows)]
fn system_exe(name: &str) -> String {
    let sys32 = std::path::Path::new(r"C:\Windows\System32").join(name);
    if sys32.is_file() {
        sys32.to_string_lossy().into_owned()
    } else {
        name.rsplit(['\\', '/']).next().unwrap_or(name).to_string()
    }
}

#[cfg(target_os = "macos")]
fn parse_macos_displays(output: &str) -> Vec<GpuDeviceStats> {
    let mut devices = Vec::new();
    let mut name = String::new();
    let mut index = 0u32;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Chipset Model:") {
            name = trimmed
                .strip_prefix("Chipset Model:")
                .map(str::trim)
                .unwrap_or("")
                .to_string();
        } else if trimmed.starts_with("Vendor:") && !name.is_empty() {
            let vendor_raw = trimmed
                .strip_prefix("Vendor:")
                .map(str::trim)
                .unwrap_or("")
                .to_lowercase();
            let vendor = if vendor_raw.contains("nvidia") {
                "NVIDIA"
            } else if vendor_raw.contains("amd") {
                "AMD"
            } else if vendor_raw.contains("intel") {
                "Intel"
            } else {
                "Apple"
            };
            devices.push(GpuDeviceStats {
                vendor: vendor.to_string(),
                name: name.clone(),
                index,
                utilization: None,
                memory_total: None,
                memory_used: None,
                temperature: None,
                power: None,
                ..Default::default()
            });
            index += 1;
            name.clear();
        }
    }

    devices
}
