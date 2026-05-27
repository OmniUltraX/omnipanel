use std::io::{Read, Write};
use std::time::Instant;

use anyhow::{Context, Result};
use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

// Embedded shell integration scripts
const BASH_INTEGRATION: &str = include_str!("../../resources/shell-integration/bash.sh");
const POWERSHELL_INTEGRATION: &str = include_str!("../../resources/shell-integration/powershell.ps1");
const FISH_INTEGRATION: &str = include_str!("../../resources/shell-integration/fish.fish");

pub struct LocalSession {
    pub id: String,
    child: Box<dyn Child + Send>,
    writer: Box<dyn Write + Send>,
    reader: Option<Box<dyn Read + Send>>,
    master: Box<dyn MasterPty + Send>,
    pub created_at: Instant,
}

impl LocalSession {
    /// Spawn a new local PTY session with the system shell.
    /// Shell integration scripts are automatically injected for Blocks support.
    pub fn spawn(id: String, cols: u16, rows: u16, working_dir: Option<&str>) -> Result<Self> {
        let pty_system = native_pty_system();
        let pty_pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("failed to open PTY")?;

        let (shell, shell_kind) = detect_shell();
        let mut cmd = CommandBuilder::new(&shell);

        if let Some(dir) = working_dir {
            cmd.cwd(dir);
        }

        // Inject shell integration script
        match shell_kind {
            ShellKind::Bash => {
                // Write integration script to temp file and source it
                let script_path = write_temp_script("bash", BASH_INTEGRATION)
                    .unwrap_or_else(|_| "/dev/null".to_string());
                cmd.arg("--init-file");
                cmd.arg(&script_path);
            }
            ShellKind::Zsh => {
                // Zsh: set ZDOTDIR to a temp dir containing our .zshrc
                let zdotdir = write_zsh_init(BASH_INTEGRATION)
                    .unwrap_or_else(|_| std::env::temp_dir().to_string_lossy().to_string());
                cmd.env("ZDOTDIR", &zdotdir);
            }
            ShellKind::PowerShell | ShellKind::PowerShell5 => {
                let script_path = write_temp_script("ps1", POWERSHELL_INTEGRATION)
                    .unwrap_or_else(|_| "NUL".to_string());
                cmd.arg("-NoExit");
                cmd.arg("-ExecutionPolicy");
                cmd.arg("Bypass");
                cmd.arg("-File");
                cmd.arg(&script_path);
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
            id,
            child,
            writer,
            reader: Some(reader),
            master: pty_pair.master,
            created_at: Instant::now(),
        })
    }

    /// Take the reader out of this session (can only be called once).
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

    /// Kill the child process.
    pub fn kill(&mut self) -> Result<()> {
        self.child.kill()?;
        Ok(())
    }
}

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
    let output = std::process::Command::new("where")
        .arg(name)
        .output()
        .ok()?;
    if output.status.success() {
        Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        None
    }
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
