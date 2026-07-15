use std::collections::HashMap;
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use omnipanel_ssh::{merge_ports, SshProcessPort};

#[cfg(windows)]
use omnipanel_ssh::parse_windows_netstat_ports;

#[cfg(unix)]
use omnipanel_ssh::{parse_netstat_ports, parse_ss_ports};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const PORTS_CACHE_TTL: Duration = Duration::from_secs(15);

static PORTS_CACHE: OnceLock<Mutex<Option<CachedPorts>>> = OnceLock::new();

struct CachedPorts {
    at: Instant,
    by_pid: HashMap<u32, Vec<SshProcessPort>>,
}

pub fn collect_local_listen_ports() -> HashMap<u32, Vec<SshProcessPort>> {
    let cache = PORTS_CACHE.get_or_init(|| Mutex::new(None));
    let mut guard = cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = guard.as_ref() {
        if cached.at.elapsed() < PORTS_CACHE_TTL {
            return cached.by_pid.clone();
        }
    }
    let by_pid = collect_local_listen_ports_uncached();
    *guard = Some(CachedPorts {
        at: Instant::now(),
        by_pid: by_pid.clone(),
    });
    by_pid
}

fn collect_local_listen_ports_uncached() -> HashMap<u32, Vec<SshProcessPort>> {
    let mut map = HashMap::new();

    #[cfg(windows)]
    {
        if let Some(out) = run_command(&system_exe("netstat.exe"), &["-ano"]) {
            merge_ports(&mut map, parse_windows_netstat_ports(&out));
        }
    }

    #[cfg(unix)]
    {
        for cmd in ["ss -H -lntipe 2>/dev/null", "ss -lntipe 2>/dev/null | tail -n +2"] {
            if let Some(out) = run_shell(cmd) {
                merge_ports(&mut map, parse_ss_ports(&out));
            }
        }
        if map.is_empty() {
            for cmd in [
                "netstat -tunlp 2>/dev/null",
                "netstat -anv -p tcp 2>/dev/null",
            ] {
                if let Some(out) = run_shell(cmd) {
                    merge_ports(&mut map, parse_netstat_ports(&out));
                }
            }
        }
    }

    map
}

#[cfg(unix)]
fn run_shell(script: &str) -> Option<String> {
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
fn system_exe(name: &str) -> String {
    let sys32 = std::path::Path::new(r"C:\Windows\System32").join(name);
    if sys32.is_file() {
        sys32.to_string_lossy().into_owned()
    } else {
        name.to_string()
    }
}
