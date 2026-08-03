mod config;
mod event;

pub use config::{ShellSpec, TerminalConfig};
pub use event::TerminalEvent;

use std::io::{Read, Write};

use anyhow::{Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use specta::Type;

// Embedded shell integration scripts
const BASH_INTEGRATION: &str = include_str!("../../resources/shell-integration/bash.sh");
const POWERSHELL_INTEGRATION: &str =
    include_str!("../../resources/shell-integration/powershell.ps1");
const FISH_INTEGRATION: &str = include_str!("../../resources/shell-integration/fish.fish");

/// A PTY-backed terminal instance wrapping a shell process.
pub struct Terminal {
    config: TerminalConfig,
    child: Box<dyn Child + Send>,
    writer: Box<dyn Write + Send>,
    reader: Option<Box<dyn Read + Send>>,
    master: Box<dyn MasterPty + Send>,
}

impl Terminal {
    /// Spawn a new terminal PTY session with the system shell.
    /// Shell integration scripts are automatically injected for Blocks support.
    pub fn new(config: TerminalConfig) -> Result<Self> {
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows: config.rows,
                cols: config.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        // 解析要启动的 shell：config.shell 优先，否则自动检测
        let (shell, shell_kind) = resolve_shell(config.shell.as_ref());
        let mut cmd = build_shell_command(shell_kind, &shell, config.shell.as_ref());

        if let Some(dir) = &config.working_dir {
            cmd.cwd(dir);
        }

        for (key, value) in &config.env_vars {
            cmd.env(key, value);
        }

        // Inject shell integration script
        match shell_kind {
            ShellKind::Bash => {
                let script_path = write_temp_script("bash", BASH_INTEGRATION)
                    .unwrap_or_else(|_| "/dev/null".to_string());
                cmd.arg("--init-file");
                cmd.arg(&script_path);
            }
            ShellKind::Zsh => {
                let zdotdir = write_zsh_init(BASH_INTEGRATION)
                    .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
                cmd.env("ZDOTDIR", &zdotdir);
            }
            ShellKind::PowerShell | ShellKind::PowerShell5 => {
                let script_path = write_temp_script("ps1", POWERSHELL_INTEGRATION)
                    .unwrap_or_else(|_| "NUL".to_string());
                // -Command 保持交互式主机；-File 会以非交互方式执行脚本导致首屏无提示符
                cmd.arg("-NoExit");
                cmd.arg("-NoLogo");
                cmd.arg("-ExecutionPolicy");
                cmd.arg("Bypass");
                cmd.arg("-Command");
                cmd.arg(format!(". '{}'", script_path));
            }
            ShellKind::Fish => {
                let script_path = write_temp_script("fish", FISH_INTEGRATION)
                    .unwrap_or_else(|_| "/dev/null".to_string());
                cmd.arg("-C");
                cmd.arg(format!("source '{}'", script_path));
            }
            ShellKind::Wsl => {
                // WSL 默认 shell 是 bash。把集成脚本写到 Windows 临时目录，
                // 转成 WSL 可访问的 /mnt/<drive>/... 路径后用 --init-file 注入。
                let script_path = write_temp_script("bash", BASH_INTEGRATION)
                    .unwrap_or_else(|_| "/dev/null".to_string());
                if let Some(wsl_path) = windows_to_wsl_path(&script_path) {
                    cmd.arg("--cd");
                    cmd.arg("~");
                    cmd.arg("--");
                    cmd.arg("bash");
                    cmd.arg("--init-file");
                    cmd.arg(&wsl_path);
                }
            }
            ShellKind::Cmd => {
                // cmd.exe has no script injection mechanism
            }
        }

        let child = pty_pair
            .slave
            .spawn_command(cmd)
            .context("failed to spawn shell process")?;

        let reader = pty_pair
            .master
            .try_clone_reader()
            .context("failed to clone PTY reader")?;
        let writer = pty_pair
            .master
            .take_writer()
            .context("failed to take PTY writer")?;

        Ok(Self {
            config,
            child,
            writer,
            reader: Some(reader),
            master: pty_pair.master,
        })
    }

    /// Take the reader out of this terminal (can only be called once).
    /// After calling this, the terminal can no longer read output directly.
    /// The caller is responsible for reading from the returned reader.
    pub fn take_reader(&mut self) -> Option<Box<dyn Read + Send>> {
        self.reader.take()
    }

    /// Write input data to the PTY stdin.
    pub fn write(&mut self, data: &[u8]) -> Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    /// Resize the PTY.
    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Check if the terminal process is still alive.
    pub fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    /// Kill the child process.
    pub fn kill(&mut self) -> Result<()> {
        self.child.kill()?;
        Ok(())
    }

    /// Get the terminal config.
    pub fn config(&self) -> &TerminalConfig {
        &self.config
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// Shell type detected on the current platform.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum ShellKind {
    Bash,
    Zsh,
    PowerShell,
    PowerShell5,
    Fish,
    Cmd,
    /// Windows Subsystem for Linux（通过 wsl.exe 启动）。
    Wsl,
}

/// Detect the best available shell on this platform.
pub fn detect_shell() -> (String, ShellKind) {
    if cfg!(windows) {
        for (shell, kind) in &[
            ("pwsh", ShellKind::PowerShell),
            ("powershell", ShellKind::PowerShell5),
            ("cmd.exe", ShellKind::Cmd),
        ] {
            if which(shell).is_some() {
                return (shell.to_string(), *kind);
            }
        }
        (
            std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
            ShellKind::Cmd,
        )
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let kind = if shell.contains("zsh") {
            ShellKind::Zsh
        } else if shell.contains("fish") {
            ShellKind::Fish
        } else {
            ShellKind::Bash
        };
        (shell, kind)
    }
}

/// 解析最终要启动的 shell：显式指定优先，否则自动检测。
/// path 为 None 时，若默认 prog 不在 PATH 中，尝试回退到同族可用 shell
/// （例如 PowerShell 7 未装时回退到 Windows PowerShell 5.1）。
fn resolve_shell(spec: Option<&ShellSpec>) -> (String, ShellKind) {
    if let Some(s) = spec {
        let (default_prog, kind) = match s.kind {
            ShellKind::PowerShell => ("pwsh", ShellKind::PowerShell),
            ShellKind::PowerShell5 => ("powershell", ShellKind::PowerShell5),
            ShellKind::Cmd => ("cmd.exe", ShellKind::Cmd),
            ShellKind::Wsl => ("wsl.exe", ShellKind::Wsl),
            ShellKind::Bash => ("bash", ShellKind::Bash),
            ShellKind::Zsh => ("zsh", ShellKind::Zsh),
            ShellKind::Fish => ("fish", ShellKind::Fish),
        };
        // 用户显式指定了 path，直接用
        if let Some(p) = &s.path {
            return (p.clone(), kind);
        }
        // path 为 None：prog 在 PATH 中即可用，否则尝试同族回退
        if which(default_prog).is_some() {
            return (default_prog.to_string(), kind);
        }
        // PowerShell 7 (pwsh) 未装 → 回退到 Windows PowerShell 5.1
        if kind == ShellKind::PowerShell && which("powershell").is_some() {
            return ("powershell".to_string(), ShellKind::PowerShell5);
        }
        // 无可用回退，仍返回原 prog（spawn 会失败并给出明确错误）
        return (default_prog.to_string(), kind);
    }
    detect_shell()
}

/// 按 shell 种类构造启动命令。WSL 需要附加发行版参数。
fn build_shell_command(
    kind: ShellKind,
    shell: &str,
    spec: Option<&ShellSpec>,
) -> CommandBuilder {
    let mut cmd = CommandBuilder::new(shell);
    if kind == ShellKind::Wsl {
        // wsl.exe -d <distro> ...
        if let Some(distro) = spec.and_then(|s| s.wsl_distro.as_deref()) {
            cmd.arg("-d");
            cmd.arg(distro);
        }
    }
    cmd
}

/// 把 Windows 路径（C:\Users\...）转成 WSL 路径（/mnt/c/Users/...）。
/// 非 Windows 路径或无法解析时返回 None。
#[cfg(windows)]
fn windows_to_wsl_path(path: &str) -> Option<String> {
    let p = std::path::Path::new(path);
    let canonical = p.canonicalize().ok()?;
    let s = canonical.to_string_lossy();
    // 形如 \\?\C:\Users\... 或 C:\Users\...
    let trimmed = s.strip_prefix(r"\\?\").unwrap_or(&s);
    let bytes = trimmed.as_bytes();
    if bytes.len() < 3 || bytes[1] != b':' || bytes[2] != b'\\' {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest = &trimmed[3..];
    Some(format!("/mnt/{drive}/{}", rest.replace('\\', "/")))
}

#[cfg(not(windows))]
fn windows_to_wsl_path(_path: &str) -> Option<String> {
    None
}

/// 可在 UI 中供用户选择的 shell 描述。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub kind: ShellKind,
    /// 展示名，如 "PowerShell 7" / "CMD" / "Ubuntu-22.04 (WSL)"。
    pub label: String,
    /// 可执行文件路径（WSL 为 wsl.exe）。
    pub path: String,
    /// WSL 发行版名称（仅 Wsl kind）。
    pub wsl_distro: Option<String>,
}

/// 枚举当前系统可用的本地 shell，供前端新建终端菜单展示。
///
/// Windows：pwsh / powershell / cmd / 已安装的 WSL 发行版。
/// Unix：$SHELL（以及 bash/zsh/fish 中存在的）。
pub fn list_available_shells() -> Vec<ShellInfo> {
    let mut list = Vec::new();
    if cfg!(windows) {
        if let Some(path) = which("pwsh") {
            list.push(ShellInfo {
                kind: ShellKind::PowerShell,
                label: "PowerShell 7".to_string(),
                path,
                wsl_distro: None,
            });
        }
        if let Some(path) = which("powershell") {
            list.push(ShellInfo {
                kind: ShellKind::PowerShell5,
                label: "Windows PowerShell 5".to_string(),
                path,
                wsl_distro: None,
            });
        }
        // 不暴露 CMD：cmd.exe 没有脚本注入机制（无 shell integration），
        // OmniPanel 的命令块/退出码/cwd 追踪/AI 命令解析等核心功能全失效。
        // Windows PowerShell 5 在所有 Windows 上可用且功能完整，足以替代。
        // ShellKind::Cmd 仍保留在 enum 里供 inferShellSpecFromLabel 等回退路径使用。
        // 枚举 WSL 发行版：wsl.exe -l -q
        // 注意：Tauri 以 windows 子系统编译（无控制台），wsl.exe 是控制台程序，
        // 直接 spawn 会弹出可见的 cmd 窗口一闪而过。必须设置 CREATE_NO_WINDOW。
        if let Some(wsl_exe) = which("wsl.exe") {
            let mut wsl_cmd = std::process::Command::new(&wsl_exe);
            wsl_cmd.arg("-l").arg("-q");
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                wsl_cmd.creation_flags(CREATE_NO_WINDOW);
            }
            if let Ok(output) = wsl_cmd.output() {
                // wsl.exe 输出是 UTF-16LE（带 BOM）
                let bom_stripped = strip_utf16_bom(&output.stdout);
                let u16s: Vec<u16> = bom_stripped
                    .chunks_exact(2)
                    .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
                    .collect();
                let text = String::from_utf16_lossy(&u16s);
                for line in text.lines() {
                    let distro = line.trim();
                    if distro.is_empty() || distro.contains("WSL") {
                        continue;
                    }
                    // 过滤 Docker Desktop 内部 distro：docker-desktop 是 Alpine-based
                    // busybox 系统（Docker 引擎的 VM 工具），没有完整用户环境
                    // （无 bash/apt/常用命令），用户进去后体验极差。
                    // docker-desktop-data 是旧版数据 distro，同样不该暴露。
                    if distro == "docker-desktop" || distro == "docker-desktop-data" {
                        continue;
                    }
                    list.push(ShellInfo {
                        kind: ShellKind::Wsl,
                        label: format!("{distro} (WSL)"),
                        path: wsl_exe.clone(),
                        wsl_distro: Some(distro.to_string()),
                    });
                }
            }
        }
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        let kind = if shell.contains("zsh") {
            ShellKind::Zsh
        } else if shell.contains("fish") {
            ShellKind::Fish
        } else {
            ShellKind::Bash
        };
        list.push(ShellInfo {
            kind,
            label: shell.clone(),
            path: shell.clone(),
            wsl_distro: None,
        });
        for (name, k) in &[
            ("bash", ShellKind::Bash),
            ("zsh", ShellKind::Zsh),
            ("fish", ShellKind::Fish),
        ] {
            if let Some(path) = which(name) {
                if path != shell {
                    list.push(ShellInfo {
                        kind: *k,
                        label: name.to_string(),
                        path,
                        wsl_distro: None,
                    });
                }
            }
        }
    }
    list
}

/// 去掉 UTF-16 BOM（FF FE 或 FE FF）。
fn strip_utf16_bom(bytes: &[u8]) -> Vec<u8> {
    if bytes.len() >= 2 {
        let bom = &bytes[..2];
        if bom == [0xFF, 0xFE] || bom == [0xFE, 0xFF] {
            return bytes[2..].to_vec();
        }
    }
    bytes.to_vec()
}

/// Write a shell integration script to a temp file.
fn write_temp_script(extension: &str, content: &str) -> Result<String> {
    let temp_dir = std::env::temp_dir();
    let filename = format!("omnipanel-si-{}.{}", std::process::id(), extension);
    let path = temp_dir.join(&filename);
    std::fs::write(&path, content)?;
    Ok(path.to_string_lossy().to_string())
}

/// Write a Zsh init directory with .zshrc that sources the integration script.
fn write_zsh_init(integration: &str) -> Result<String> {
    let temp_dir = std::env::temp_dir().join(format!("omnipanel-zsh-{}", std::process::id()));
    std::fs::create_dir_all(&temp_dir)?;

    let zshrc = format!(
        "# OmniPanel shell integration\n{}\n# Source original .zshrc if it exists\n[[ -f \"$HOME/.zshrc\" ]] && source \"$HOME/.zshrc\"\n",
        integration
    );
    std::fs::write(temp_dir.join(".zshrc"), zshrc)?;
    Ok(temp_dir.to_string_lossy().to_string())
}

/// Check if a program exists in PATH.
#[cfg(windows)]
fn which(name: &str) -> Option<String> {
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};

    fn candidate_paths(dir: &Path, name: &str, pathext: &[OsString]) -> Vec<PathBuf> {
        let base = dir.join(name);
        if base.extension().is_some() {
            return vec![base];
        }

        let mut candidates = Vec::with_capacity(pathext.len() + 1);
        candidates.push(base.clone());
        for ext in pathext {
            let ext = ext.to_string_lossy();
            let suffix = ext.strip_prefix('.').unwrap_or(&ext);
            candidates.push(dir.join(format!("{name}.{suffix}")));
        }
        candidates
    }

    let direct = Path::new(name);
    if direct.components().count() > 1 || direct.is_absolute() {
        return direct
            .exists()
            .then(|| direct.to_string_lossy().to_string());
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
            vec![".COM", ".EXE", ".BAT", ".CMD"]
                .into_iter()
                .map(OsString::from)
                .collect()
        });

    let path_dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();

    for dir in path_dirs {
        for candidate in candidate_paths(&dir, name, &pathext) {
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    None
}

#[cfg(not(windows))]
fn which(name: &str) -> Option<String> {
    let output = std::process::Command::new("which")
        .arg(name)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
}
