//! 本地 CLI Agent 探测（与桌面端 `commands::agents` 同逻辑，无 Tauri 依赖）。

use std::collections::HashSet;
#[cfg(windows)]
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
pub enum AgentKind {
    Omniagent,
    Cursor,
    Opencode,
    Qwen,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AgentInstallStatus {
    pub kind: AgentKind,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub launch_args: Vec<String>,
}

impl AgentInstallStatus {
    fn from_detection(
        kind: AgentKind,
        launch_args: Vec<&str>,
        installed: bool,
        path: Option<String>,
        version: Option<String>,
    ) -> Self {
        Self {
            kind,
            installed,
            executable_path: path,
            version,
            launch_args: launch_args.into_iter().map(String::from).collect(),
        }
    }
}

pub fn agent_kind_key(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Omniagent => "omniagent",
        AgentKind::Cursor => "cursor",
        AgentKind::Opencode => "opencode",
        AgentKind::Qwen => "qwen",
    }
}

fn path_is_executable(path: &Path) -> bool {
    path.is_file()
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(windows)]
fn command_output(program: &str, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        Some(String::from_utf8_lossy(&output.stderr).trim().to_string())
    } else {
        Some(text)
    }
}

#[cfg(not(windows))]
fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        Some(String::from_utf8_lossy(&output.stderr).trim().to_string())
    } else {
        Some(text)
    }
}

#[cfg(windows)]
fn resolve_in_path(name: &str) -> Option<PathBuf> {
    let direct = Path::new(name);
    if direct.components().count() > 1 || direct.is_absolute() {
        return direct.is_file().then(|| direct.to_path_buf());
    }
    let pathext = std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter(|item| !item.is_empty())
                .map(OsString::from)
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty())
        .unwrap_or_else(|| {
            [".COM", ".EXE", ".BAT", ".CMD"]
                .into_iter()
                .map(OsString::from)
                .collect()
        });
    let path_dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    for dir in path_dirs {
        let base = dir.join(name);
        if base.extension().is_some() && path_is_executable(&base) {
            return Some(base);
        }
        for ext in &pathext {
            let ext = ext.to_string_lossy();
            let suffix = ext.strip_prefix('.').unwrap_or(&ext);
            let candidate = dir.join(format!("{name}.{suffix}"));
            if path_is_executable(&candidate) {
                return Some(candidate);
            }
        }
        if path_is_executable(&base) {
            return Some(base);
        }
    }
    None
}

#[cfg(not(windows))]
fn resolve_in_path(name: &str) -> Option<PathBuf> {
    let direct = Path::new(name);
    if direct.components().count() > 1 || direct.is_absolute() {
        return direct.is_file().then(|| direct.to_path_buf());
    }
    let output = Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {name}"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if path.is_empty() {
        return None;
    }
    let candidate = PathBuf::from(path);
    candidate.is_file().then_some(candidate)
}

#[cfg(windows)]
fn where_all(name: &str) -> Vec<PathBuf> {
    let Some(text) = command_output("where.exe", &[name]) else {
        return Vec::new();
    };
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|path| path_is_executable(path))
        .collect()
}

fn push_candidate(candidates: &mut Vec<PathBuf>, seen: &mut HashSet<PathBuf>, path: PathBuf) {
    if path_is_executable(&path) && seen.insert(path.clone()) {
        candidates.push(path);
    }
}

fn read_version(exe: &Path) -> Option<String> {
    command_output(exe.to_str()?, &["--version"]).and_then(|text| {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn detect_from_candidates(candidates: Vec<PathBuf>) -> (bool, Option<String>, Option<String>) {
    let mut fallback: Option<PathBuf> = None;
    for candidate in candidates {
        if fallback.is_none() {
            fallback = Some(candidate.clone());
        }
        if let Some(version) = read_version(&candidate) {
            return (
                true,
                Some(candidate.to_string_lossy().to_string()),
                Some(version),
            );
        }
    }
    if let Some(path) = fallback {
        return (true, Some(path.to_string_lossy().to_string()), None);
    }
    (false, None, None)
}

fn collect_opencode_candidates() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    if let Some(path) = resolve_in_path("opencode") {
        push_candidate(&mut candidates, &mut seen, path);
    }
    #[cfg(windows)]
    for path in where_all("opencode") {
        push_candidate(&mut candidates, &mut seen, path);
    }
    if let Some(home) = home_dir() {
        #[cfg(windows)]
        push_candidate(
            &mut candidates,
            &mut seen,
            home.join(".opencode/bin/opencode.exe"),
        );
        #[cfg(not(windows))]
        {
            push_candidate(
                &mut candidates,
                &mut seen,
                home.join(".opencode/bin/opencode"),
            );
            push_candidate(&mut candidates, &mut seen, home.join("bin/opencode"));
        }
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let npm = PathBuf::from(appdata).join("npm");
        push_candidate(&mut candidates, &mut seen, npm.join("opencode.cmd"));
        push_candidate(&mut candidates, &mut seen, npm.join("opencode"));
    }
    candidates
}

fn collect_cursor_candidates() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    if let Some(path) = resolve_in_path("agent") {
        push_candidate(&mut candidates, &mut seen, path);
    }
    #[cfg(windows)]
    for path in where_all("agent") {
        push_candidate(&mut candidates, &mut seen, path);
    }
    if let Some(home) = home_dir() {
        push_candidate(&mut candidates, &mut seen, home.join(".local/bin/agent"));
        push_candidate(
            &mut candidates,
            &mut seen,
            home.join(".local/bin/agent.exe"),
        );
    }
    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let cursor_bin = PathBuf::from(local_app_data).join("Programs/cursor/resources/app/bin");
        push_candidate(&mut candidates, &mut seen, cursor_bin.join("agent.cmd"));
        push_candidate(&mut candidates, &mut seen, cursor_bin.join("agent.exe"));
    }
    #[cfg(target_os = "macos")]
    {
        push_candidate(
            &mut candidates,
            &mut seen,
            PathBuf::from("/Applications/Cursor.app/Contents/Resources/app/bin/agent"),
        );
    }
    candidates
}

fn collect_qwen_candidates() -> Vec<PathBuf> {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    if let Some(path) = resolve_in_path("qwen") {
        push_candidate(&mut candidates, &mut seen, path);
    }
    #[cfg(windows)]
    for path in where_all("qwen") {
        push_candidate(&mut candidates, &mut seen, path);
    }
    if let Some(home) = home_dir() {
        push_candidate(&mut candidates, &mut seen, home.join(".local/bin/qwen"));
        push_candidate(&mut candidates, &mut seen, home.join(".local/bin/qwen.exe"));
    }
    candidates
}

fn detect_omniagent_sync() -> AgentInstallStatus {
    let node = resolve_in_path("node");
    let installed = node.is_some();
    let version = if installed {
        node.as_ref()
            .and_then(|p| command_output(p.to_str()?, &["--version"]))
    } else {
        None
    };
    AgentInstallStatus::from_detection(
        AgentKind::Omniagent,
        vec!["--import", "tsx", "index.ts"],
        installed,
        node.map(|p| p.to_string_lossy().into_owned()),
        version,
    )
}

pub fn detect_all_agents_sync() -> Vec<AgentInstallStatus> {
    vec![
        detect_omniagent_sync(),
        {
            let (installed, path, version) = detect_from_candidates(collect_cursor_candidates());
            AgentInstallStatus::from_detection(
                AgentKind::Cursor,
                vec!["acp"],
                installed,
                path,
                version,
            )
        },
        {
            let (installed, path, version) = detect_from_candidates(collect_opencode_candidates());
            AgentInstallStatus::from_detection(
                AgentKind::Opencode,
                vec!["acp"],
                installed,
                path,
                version,
            )
        },
        {
            let (installed, path, version) = detect_from_candidates(collect_qwen_candidates());
            AgentInstallStatus::from_detection(
                AgentKind::Qwen,
                vec!["--acp"],
                installed,
                path,
                version,
            )
        },
    ]
}
