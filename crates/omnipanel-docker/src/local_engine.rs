//! 本地 Docker Engine / Docker Desktop 安装检测与一键启动。

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};

use crate::DockerAdapter;
use crate::local::LocalDockerAdapter;
use crate::model::{DockerConnectionStatus, DockerLocalEngineStatus};

fn path_exists(path: &Path) -> bool {
    path.exists()
}

fn command_exists(name: &str) -> bool {
    #[cfg(windows)]
    {
        Command::new("where")
            .arg(name)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        Command::new("sh")
            .arg("-c")
            .arg(format!("command -v {name}"))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

#[cfg(windows)]
fn docker_desktop_exe() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("ProgramFiles") {
        candidates.push(PathBuf::from(p).join("Docker/Docker/Docker Desktop.exe"));
    }
    if let Ok(p) = std::env::var("ProgramFiles(x86)") {
        candidates.push(PathBuf::from(p).join("Docker/Docker/Docker Desktop.exe"));
    }
    if let Ok(p) = std::env::var("LOCALAPPDATA") {
        candidates.push(PathBuf::from(p).join("Programs/Docker/Docker/Docker Desktop.exe"));
    }
    candidates.into_iter().find(|p| path_exists(p))
}

#[cfg(target_os = "macos")]
fn docker_desktop_app() -> Option<PathBuf> {
    let app = PathBuf::from("/Applications/Docker.app");
    path_exists(&app).then_some(app)
}

#[cfg(target_os = "linux")]
fn docker_desktop_linux() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from("/opt/docker-desktop/bin/docker-desktop"),
        PathBuf::from("/usr/bin/docker-desktop"),
        PathBuf::from("/usr/local/bin/docker-desktop"),
    ];
    candidates.into_iter().find(|p| path_exists(p))
}

/// 检测本机是否安装了 Docker Desktop / Engine，以及是否支持应用内一键启动。
fn detect_installation() -> (bool, String, bool) {
    #[cfg(windows)]
    {
        if docker_desktop_exe().is_some() {
            return (true, "docker-desktop".into(), true);
        }
        if command_exists("docker") {
            return (true, "docker-engine".into(), false);
        }
        return (false, "none".into(), false);
    }

    #[cfg(target_os = "macos")]
    {
        if docker_desktop_app().is_some() {
            return (true, "docker-desktop".into(), true);
        }
        if command_exists("docker") {
            return (true, "docker-engine".into(), false);
        }
        return (false, "none".into(), false);
    }

    #[cfg(target_os = "linux")]
    {
        if docker_desktop_linux().is_some() {
            return (true, "docker-desktop".into(), true);
        }
        if path_exists(Path::new("/var/run/docker.sock")) || command_exists("docker") {
            return (true, "docker-engine".into(), false);
        }
        return (false, "none".into(), false);
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        (false, "none".into(), false)
    }
}

/// 探测本地 Engine 是否在线。
pub async fn is_local_engine_running() -> bool {
    let Ok(adapter) = LocalDockerAdapter::connect() else {
        return false;
    };
    adapter
        .probe()
        .await
        .map(|p| p.status == DockerConnectionStatus::Online)
        .unwrap_or(false)
}

/// 本地 Engine 安装与运行状态。
pub async fn local_engine_status() -> DockerLocalEngineStatus {
    let (installed, install_kind, can_start) = detect_installation();
    let running = is_local_engine_running().await;
    DockerLocalEngineStatus {
        installed,
        running,
        can_start: can_start && installed && !running,
        install_kind,
    }
}

/// 尝试启动本地 Docker Desktop（或 Linux 上的 docker-desktop 服务）。
pub fn start_local_engine() -> OmniResult<()> {
    let (installed, _install_kind, can_start) = detect_installation();
    if !installed {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            "未检测到本机 Docker 安装",
        ));
    }
    if !can_start {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "当前环境不支持应用内一键启动 Docker，请手动启动 Docker 服务",
        ));
    }

    #[cfg(windows)]
    {
        let exe = docker_desktop_exe().ok_or_else(|| {
            OmniError::new(ErrorCode::NotFound, "未找到 Docker Desktop 可执行文件")
        })?;
        Command::new(exe)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "启动 Docker Desktop 失败")
                    .with_cause(e.to_string())
            })?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .args(["-a", "Docker"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| {
                OmniError::new(ErrorCode::Internal, "启动 Docker Desktop 失败")
                    .with_cause(e.to_string())
            })?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        if install_kind == "docker-desktop" {
            if let Some(bin) = docker_desktop_linux() {
                Command::new(bin)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()
                    .map_err(|e| {
                        OmniError::new(ErrorCode::Internal, "启动 Docker Desktop 失败")
                            .with_cause(e.to_string())
                    })?;
                return Ok(());
            }
            let status = Command::new("systemctl")
                .args(["--user", "start", "docker-desktop"])
                .status()
                .map_err(|e| {
                    OmniError::new(ErrorCode::Internal, "启动 docker-desktop 服务失败")
                        .with_cause(e.to_string())
                })?;
            if status.success() {
                return Ok(());
            }
        }
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "请手动启动 Docker 服务（需要管理员权限）",
        ))
    }

    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = install_kind;
        Err(OmniError::new(
            ErrorCode::InvalidInput,
            "当前平台不支持一键启动 Docker",
        ))
    }
}
