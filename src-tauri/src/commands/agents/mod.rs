mod detect_common;

use detect_common::{
    detect_from_candidates, home_dir, push_candidate, resolve_in_path, where_all,
};
use omnipanel_error::OmniError;
use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, Copy, Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    Omniagent,
    Cursor,
    Opencode,
    Qwen,
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstallStatus {
    pub kind: AgentKind,
    pub installed: bool,
    pub executable_path: Option<String>,
    pub version: Option<String>,
    pub launch_args: Vec<String>,
}

impl AgentInstallStatus {
    fn missing(kind: AgentKind, launch_args: Vec<&str>) -> Self {
        Self {
            kind,
            installed: false,
            executable_path: None,
            version: None,
            launch_args: launch_args.into_iter().map(String::from).collect(),
        }
    }

    fn from_detection(kind: AgentKind, launch_args: Vec<&str>, installed: bool, path: Option<String>, version: Option<String>) -> Self {
        Self {
            kind,
            installed,
            executable_path: path,
            version,
            launch_args: launch_args.into_iter().map(String::from).collect(),
        }
    }
}

fn collect_opencode_candidates() -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
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

fn collect_cursor_candidates() -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
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
        push_candidate(&mut candidates, &mut seen, home.join(".local/bin/agent.exe"));
    }

    #[cfg(windows)]
    if let Some(local_app_data) = std::env::var_os("LOCALAPPDATA") {
        let cursor_bin = PathBuf::from(local_app_data)
            .join("Programs/cursor/resources/app/bin");
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
        if let Some(home) = home_dir() {
            push_candidate(
                &mut candidates,
                &mut seen,
                home.join("Applications/Cursor.app/Contents/Resources/app/bin/agent"),
            );
        }
    }

    candidates
}

fn collect_qwen_candidates() -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
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

    if let Some(appdata) = std::env::var_os("APPDATA") {
        let npm = PathBuf::from(appdata).join("npm");
        push_candidate(&mut candidates, &mut seen, npm.join("qwen.cmd"));
        push_candidate(&mut candidates, &mut seen, npm.join("qwen"));
    }

    for key in ["NVM_SYMLINK", "NVM_HOME"] {
        if let Some(dir) = std::env::var_os(key) {
            let base = PathBuf::from(dir);
            push_candidate(&mut candidates, &mut seen, base.join("qwen.cmd"));
            push_candidate(&mut candidates, &mut seen, base.join("qwen.exe"));
            push_candidate(&mut candidates, &mut seen, base.join("qwen"));
        }
    }

    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let nodejs = PathBuf::from(program_files).join("nodejs");
        push_candidate(&mut candidates, &mut seen, nodejs.join("qwen.cmd"));
        push_candidate(&mut candidates, &mut seen, nodejs.join("qwen.exe"));
    }

    candidates
}

fn resolve_repo_agent_dir() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let agent_dir = manifest.join("../agent");
    if agent_dir.join("index.ts").exists() {
        return agent_dir.canonicalize().ok();
    }
    None
}

fn detect_node_version() -> Option<String> {
    let node = resolve_in_path("node")?;
    std::process::Command::new(node)
        .arg("--version")
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
}

fn detect_omniagent_sync() -> AgentInstallStatus {
    let node = resolve_in_path("node");
    let agent_dir = resolve_repo_agent_dir();
    let installed = node.is_some() && agent_dir.is_some();
    let version = if installed {
        detect_node_version()
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

fn detect_opencode_sync() -> AgentInstallStatus {
    let (installed, path, version) = detect_from_candidates(collect_opencode_candidates());
    AgentInstallStatus::from_detection(AgentKind::Opencode, vec!["acp"], installed, path, version)
}

fn detect_cursor_sync() -> AgentInstallStatus {
    let (installed, path, version) = detect_from_candidates(collect_cursor_candidates());
    AgentInstallStatus::from_detection(AgentKind::Cursor, vec!["acp"], installed, path, version)
}

fn detect_qwen_sync() -> AgentInstallStatus {
    let (installed, path, version) = detect_from_candidates(collect_qwen_candidates());
    AgentInstallStatus::from_detection(AgentKind::Qwen, vec!["--acp"], installed, path, version)
}

fn detect_all_agents_sync() -> Vec<AgentInstallStatus> {
    vec![
        detect_omniagent_sync(),
        detect_cursor_sync(),
        detect_opencode_sync(),
        detect_qwen_sync(),
    ]
}

/// 检测 OmniAgent / Cursor / OpenCode / Qwen 的安装情况。
#[tauri::command]
#[specta::specta]
pub async fn detect_all_agents() -> Result<Vec<AgentInstallStatus>, OmniError> {
    tokio::task::spawn_blocking(detect_all_agents_sync)
        .await
        .map_err(|e| OmniError::internal(format!("Agent 检测失败: {e}")))
}

pub fn detect_opencode_for_legacy() -> crate::commands::opencode::OpenCodeInstallStatus {
    let status = detect_opencode_sync();
    crate::commands::opencode::OpenCodeInstallStatus {
        installed: status.installed,
        executable_path: status.executable_path,
        version: status.version,
    }
}
