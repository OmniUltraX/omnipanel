mod config;
mod event;

pub use config::TerminalConfig;
pub use event::TerminalEvent;

use std::io::{Read, Write};

use anyhow::{Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

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

        let (shell, shell_kind) = detect_shell();
        let mut cmd = CommandBuilder::new(&shell);

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
#[derive(Debug, Clone, Copy)]
pub enum ShellKind {
    Bash,
    Zsh,
    PowerShell,
    PowerShell5,
    Fish,
    Cmd,
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
