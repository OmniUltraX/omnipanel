use std::collections::HashSet;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

use omnipanel_error::OmniError;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeInstallStatus {
    /// 是否检测到 OpenCode CLI。
    pub installed: bool,
    /// 解析到的可执行文件路径。
    pub executable_path: Option<String>,
    /// `opencode --version` 输出（若可用）。
    pub version: Option<String>,
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
        return direct
            .is_file()
            .then(|| direct.to_path_buf());
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
        return direct
            .is_file()
            .then(|| direct.to_path_buf());
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

fn collect_candidates() -> Vec<PathBuf> {
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
        {
            push_candidate(
                &mut candidates,
                &mut seen,
                home.join(".opencode/bin/opencode.exe"),
            );
        }
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

    for key in ["NVM_SYMLINK", "NVM_HOME"] {
        if let Some(dir) = std::env::var_os(key) {
            let base = PathBuf::from(dir);
            push_candidate(&mut candidates, &mut seen, base.join("opencode.cmd"));
            push_candidate(&mut candidates, &mut seen, base.join("opencode.exe"));
            push_candidate(&mut candidates, &mut seen, base.join("opencode"));
        }
    }

    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let nodejs = PathBuf::from(program_files).join("nodejs");
        push_candidate(&mut candidates, &mut seen, nodejs.join("opencode.cmd"));
        push_candidate(&mut candidates, &mut seen, nodejs.join("opencode.exe"));
    }

    candidates
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

fn detect_opencode_install_sync() -> OpenCodeInstallStatus {
    let candidates = collect_candidates();
    let mut fallback: Option<PathBuf> = None;

    for candidate in candidates {
        if fallback.is_none() {
            fallback = Some(candidate.clone());
        }
        if let Some(version) = read_version(&candidate) {
            return OpenCodeInstallStatus {
                installed: true,
                executable_path: Some(candidate.to_string_lossy().to_string()),
                version: Some(version),
            };
        }
    }

    if let Some(path) = fallback {
        return OpenCodeInstallStatus {
            installed: true,
            executable_path: Some(path.to_string_lossy().to_string()),
            version: None,
        };
    }

    OpenCodeInstallStatus {
        installed: false,
        executable_path: None,
        version: None,
    }
}

/// 检测本机是否已安装 OpenCode CLI。
#[tauri::command]
#[specta::specta]
pub async fn detect_opencode_install() -> Result<OpenCodeInstallStatus, OmniError> {
    tokio::task::spawn_blocking(detect_opencode_install_sync)
        .await
        .map_err(|e| OmniError::internal(format!("OpenCode 检测失败: {e}")))
}
