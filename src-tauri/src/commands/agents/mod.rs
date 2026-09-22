mod detect_common;

#[cfg(windows)]
use detect_common::where_all;
use detect_common::{
    detect_from_candidates, home_dir, push_candidate, resolve_in_path,
};
use omnipanel_error::OmniError;
use serde::Serialize;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Debug, Clone, Copy, Serialize, specta::Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AgentKind {
    Cursor,
    Opencode,
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

/// npm / nvm 全局安装时常带无扩展名 shim；旁路真实二进制便于 CreateProcess。
fn push_opencode_package_bins(
    candidates: &mut Vec<PathBuf>,
    seen: &mut std::collections::HashSet<PathBuf>,
    node_prefix: &std::path::Path,
) {
    // 现行包名 @opencode/cli；历史包名 opencode-ai
    let package_bins = [
        node_prefix.join("node_modules/@opencode/cli/bin"),
        node_prefix.join("node_modules/opencode-ai/bin"),
    ];
    for bin_dir in package_bins {
        #[cfg(windows)]
        {
            push_candidate(candidates, seen, bin_dir.join("opencode.exe"));
        }
        #[cfg(not(windows))]
        {
            push_candidate(candidates, seen, bin_dir.join("opencode"));
        }
    }
}

fn push_opencode_prefix(
    candidates: &mut Vec<PathBuf>,
    seen: &mut std::collections::HashSet<PathBuf>,
    prefix: PathBuf,
) {
    #[cfg(windows)]
    {
        // 优先真实 .exe，避免 .cmd/.ps1 弹控制台
        push_candidate(candidates, seen, prefix.join("opencode.exe"));
        push_candidate(candidates, seen, prefix.join("opencode.cmd"));
    }
    push_candidate(candidates, seen, prefix.join("opencode"));
    push_opencode_package_bins(candidates, seen, &prefix);
}

fn collect_opencode_candidates() -> Vec<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let mut candidates = Vec::new();

    if let Some(path) = resolve_in_path("opencode") {
        push_candidate(&mut candidates, &mut seen, path.clone());
        if let Some(parent) = path.parent() {
            push_opencode_package_bins(&mut candidates, &mut seen, parent);
        }
    }

    #[cfg(windows)]
    for path in where_all("opencode") {
        push_candidate(&mut candidates, &mut seen, path.clone());
        if let Some(parent) = path.parent() {
            push_opencode_package_bins(&mut candidates, &mut seen, parent);
        }
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
        push_opencode_prefix(&mut candidates, &mut seen, npm);
    }

    for key in ["NVM_SYMLINK", "NVM_HOME"] {
        if let Some(dir) = std::env::var_os(key) {
            push_opencode_prefix(&mut candidates, &mut seen, PathBuf::from(dir));
        }
    }

    // nvm4w 默认前缀（GUI 启动时常无 NVM_* 环境变量）
    #[cfg(windows)]
    {
        push_opencode_prefix(&mut candidates, &mut seen, PathBuf::from(r"C:\nvm4w\nodejs"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            push_opencode_prefix(
                &mut candidates,
                &mut seen,
                PathBuf::from(local).join("nvm"),
            );
        }
    }

    if let Ok(program_files) = std::env::var("ProgramFiles") {
        let nodejs = PathBuf::from(program_files).join("nodejs");
        push_opencode_prefix(&mut candidates, &mut seen, nodejs);
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

fn detect_opencode_sync() -> AgentInstallStatus {
    let (installed, path, version) = detect_from_candidates(collect_opencode_candidates());
    AgentInstallStatus::from_detection(AgentKind::Opencode, vec!["acp"], installed, path, version)
}

fn detect_cursor_sync() -> AgentInstallStatus {
    let (installed, path, version) = detect_from_candidates(collect_cursor_candidates());
    AgentInstallStatus::from_detection(AgentKind::Cursor, vec!["acp"], installed, path, version)
}

pub fn agent_kind_key(kind: AgentKind) -> &'static str {
    match kind {
        AgentKind::Cursor => "cursor",
        AgentKind::Opencode => "opencode",
    }
}

pub fn detect_all_agents_sync(_bundled_resource_dir: Option<PathBuf>) -> Vec<AgentInstallStatus> {
    vec![detect_cursor_sync(), detect_opencode_sync()]
}

/// 检测 Cursor / OpenCode 的安装情况。
#[tauri::command]
#[specta::specta]
pub async fn detect_all_agents(
    app: tauri::AppHandle,
) -> Result<Vec<AgentInstallStatus>, OmniError> {
    let resource_dir = app.path().resource_dir().ok();
    tokio::task::spawn_blocking(move || detect_all_agents_sync(resource_dir))
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
