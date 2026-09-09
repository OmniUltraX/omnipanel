//! 插件工程桥：用户目录 `plugin-projects/`（发行版）∪ 仓库 `plugins-custom/`（开发态）。
//!
//! 安全边界（与开放 shell 有本质区别）：
//! - 读写禁锢在对应工程目录内（`..` / 绝对路径一律拒绝）；
//! - `run` 只允许 validate / pack；校验与打包走应用内 Rust，不 `cargo run`；
//! - 单文件上限（读 512KB / 写 1MB），非 UTF-8 文本拒绝。

use std::path::{Path, PathBuf};
use std::time::Duration;

use omnipanel_error::OmniError;
use omnipanel_plugin::PluginManifest;
use omnipanel_plugin_pkg::{devkey::dev_signing_key, pack_dir};
use omnipanel_store::AuditEntry;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

const MAX_READ_BYTES: u64 = 512 * 1024;
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StudioProject {
    pub name: String,
    pub files: Vec<String>,
    pub has_manifest: bool,
    /// `user` = app_data/plugin-projects；`repo` = 仓库 plugins-custom。
    pub location: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StudioRunResult {
    pub success: bool,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StudioEnv {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cargo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wat2wasm: Option<String>,
    pub repo_root: Option<String>,
}

/// 仓库根目录（编译期 src-tauri 的父目录），运行时校验标记文件；
/// 打包产物内无源码树时返回 None。开发态用来并集扫描 `plugins-custom/`。
pub(crate) fn repo_root() -> Option<PathBuf> {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .to_path_buf();
    if root.join("package.json").is_file() && root.join("plugins").is_dir() {
        Some(root)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub(crate) struct StudioRoots {
    pub user: PathBuf,
    pub repo: Option<PathBuf>,
}

pub(crate) fn studio_roots(app: &AppHandle) -> Result<StudioRoots, OmniError> {
    let user = app
        .path()
        .app_data_dir()
        .map_err(|e| OmniError::internal(format!("无法定位应用数据目录: {e}")))?
        .join("plugin-projects");
    Ok(StudioRoots {
        user,
        repo: repo_root().map(|r| r.join("plugins-custom")),
    })
}

fn valid_project_name(name: &str) -> Result<&str, OmniError> {
    let name = name.trim();
    if name.is_empty()
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        return Err(OmniError::invalid_input("工程名非法"));
    }
    Ok(name)
}

/// 已存在则优先用户目录，否则仓库目录；都不存在时指向用户目录（供新建/写入）。
pub(crate) fn resolve_project_dir(roots: &StudioRoots, name: &str) -> Result<PathBuf, OmniError> {
    let name = valid_project_name(name)?;
    let user = roots.user.join(name);
    if user.is_dir() {
        return Ok(user);
    }
    if let Some(repo) = &roots.repo {
        let repo_dir = repo.join(name);
        if repo_dir.is_dir() {
            return Ok(repo_dir);
        }
    }
    Ok(user)
}

fn jail_rel(rel: &str) -> Result<String, OmniError> {
    let trimmed = rel.trim().replace('\\', "/");
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains("://")
        || trimmed.split('/').any(|seg| seg == ".." || seg.is_empty())
    {
        return Err(OmniError::invalid_input(format!("路径越界: {rel}")));
    }
    Ok(trimmed)
}

fn jail_path_in(base: &Path, rel: &str) -> Result<PathBuf, OmniError> {
    let trimmed = jail_rel(rel)?;
    let target = base.join(&trimmed);
    if !target.starts_with(base) {
        return Err(OmniError::invalid_input("路径越界"));
    }
    Ok(target)
}

fn jail_path(roots: &StudioRoots, project: &str, rel: &str) -> Result<PathBuf, OmniError> {
    let base = resolve_project_dir(roots, project)?;
    jail_path_in(&base, rel)
}

/// 提示词只记 sha256+len，禁止把原文写入 audit。
pub(crate) fn scaffold_prompt_digest(prompt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(prompt.as_bytes());
    format!("sha256:{:x} len={}", hasher.finalize(), prompt.len())
}

const SKIP_DIR_NAMES: &[&str] = &["node_modules", "target", ".git", "dist", ".idea"];

fn collect_files(dir: &Path, base: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    names.sort_by_key(|e| e.file_name());
    for entry in names {
        let path = entry.path();
        if path.is_dir() {
            let skip = entry
                .file_name()
                .to_str()
                .is_some_and(|n| SKIP_DIR_NAMES.iter().any(|s| n.eq_ignore_ascii_case(s)));
            if skip {
                continue;
            }
            collect_files(&path, base, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

fn json_string_field(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn load_studio_project(dir: &Path, name: String, location: &str) -> StudioProject {
    let mut files = Vec::new();
    collect_files(dir, dir, &mut files);
    files.retain(|rel| {
        dir.join(rel)
            .metadata()
            .map(|m| m.len() <= MAX_READ_BYTES && m.is_file())
            .unwrap_or(false)
    });
    let manifest_path = dir.join("plugin.json");
    let has_manifest = manifest_path.is_file();
    let (kind, version, display_name) = std::fs::read_to_string(&manifest_path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .map(|value| {
            (
                json_string_field(&value, "kind"),
                json_string_field(&value, "version"),
                json_string_field(&value, "displayName"),
            )
        })
        .unwrap_or((None, None, None));
    StudioProject {
        name,
        files,
        has_manifest,
        location: location.into(),
        kind,
        version,
        display_name,
    }
}

const PLUGIN_KINDS: &[&str] = &[
    "engine", "panel", "importer", "cloud", "module", "theme", "addon",
];

/// 把七种身份映射成 create-plugin.mjs 真正能干活的模板（默认给可跑样板，不要空壳）。
fn resolve_scaffold_template(kind: &str, starter: Option<&str>) -> Result<&'static str, OmniError> {
    let starter = starter.map(str::trim).filter(|s| !s.is_empty());
    match (kind, starter) {
        ("engine", None | Some("sidecar")) => Ok("engine-sidecar"),
        ("engine", Some("blank")) => Ok("engine"),
        ("addon", None | Some("js")) => Ok("js-logic"),
        ("addon", Some("overlay")) => Ok("l3-overlay"),
        ("addon", Some("wasm")) => Ok("wasm-stub"),
        ("addon", Some("blank")) => Ok("addon"),
        ("panel", None | Some("blank")) => Ok("panel"),
        ("importer", None | Some("blank")) => Ok("importer"),
        ("cloud", None | Some("blank")) => Ok("cloud"),
        ("module", None | Some("blank")) => Ok("module"),
        ("theme", None | Some("blank")) => Ok("theme"),
        (other, _) if PLUGIN_KINDS.contains(&other) => Err(OmniError::invalid_input(format!(
            "该类型不支持起步方式 {starter:?}"
        ))),
        (other, _) => Err(OmniError::invalid_input(format!("不支持的类型: {other}"))),
    }
}

fn scan_root(root: &Path, location: &str, seen: &mut std::collections::HashSet<String>, out: &mut Vec<StudioProject>) {
    if !root.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut dirs: Vec<_> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .collect();
    dirs.sort_by_key(|e| e.file_name());
    for entry in dirs {
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !seen.insert(name.clone()) {
            continue;
        }
        out.push(load_studio_project(&entry.path(), name, location));
    }
}

/// 列出用户目录 + 开发态仓库目录（同名以用户目录为准）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_list_projects(
    app: AppHandle,
    _state: State<'_, AppState>,
) -> Result<Vec<StudioProject>, OmniError> {
    let roots = studio_roots(&app)?;
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    scan_root(&roots.user, "user", &mut seen, &mut out);
    if let Some(repo) = &roots.repo {
        scan_root(repo, "repo", &mut seen, &mut out);
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读工程文件（文本，≤512KB）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_read_file(
    app: AppHandle,
    _state: State<'_, AppState>,
    project: String,
    path: String,
) -> Result<String, OmniError> {
    let roots = studio_roots(&app)?;
    let target = jail_path(&roots, &project, &path)?;
    let meta = std::fs::metadata(&target)
        .map_err(|_| OmniError::not_found(format!("文件不存在: {path}")))?;
    if meta.len() > MAX_READ_BYTES {
        return Err(OmniError::invalid_input("文件超过 512KB 上限"));
    }
    let bytes = std::fs::read(&target).map_err(|e| OmniError::internal(e.to_string()))?;
    String::from_utf8(bytes).map_err(|_| OmniError::invalid_input("非 UTF-8 文本文件"))
}

/// 写工程文件（文本，≤1MB；自动建父目录）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_write_file(
    app: AppHandle,
    _state: State<'_, AppState>,
    project: String,
    path: String,
    content: String,
) -> Result<(), OmniError> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(OmniError::invalid_input("内容超过 1MB 上限"));
    }
    let roots = studio_roots(&app)?;
    let target = jail_path(&roots, &project, &path)?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| OmniError::internal(e.to_string()))?;
    }
    // String 本身即合法 UTF-8，直接落盘
    std::fs::write(&target, content).map_err(|e| OmniError::internal(e.to_string()))?;
    Ok(())
}

fn command_hidden(program: &str) -> std::process::Command {
    let resolved = resolve_program(program);
    let mut cmd = std::process::Command::new(&resolved);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    if let Some(path) = toolchain_path() {
        cmd.env("PATH", path);
    }
    cmd
}

/// 环境检测：cargo / node / wat2wasm 版本（缺失为 None，前端给安装引导）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_env_check(
    _state: State<'_, AppState>,
) -> Result<StudioEnv, OmniError> {
    let cwd = repo_root().unwrap_or_else(|| PathBuf::from("."));
    Ok(StudioEnv {
        cargo: probe_version("cargo", &cwd),
        node: probe_version("node", &cwd),
        wat2wasm: probe_version("wat2wasm", &cwd),
        repo_root: repo_root().map(|p| p.to_string_lossy().into_owned()),
    })
}

const INSTALL_TIMEOUT: Duration = Duration::from_secs(900);
#[cfg(windows)]
const RUSTUP_INIT_URL: &str =
    "https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StudioEnvInstallResult {
    pub tool: String,
    pub ok: bool,
    pub output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

fn normalize_env_tool(tool: &str) -> Result<&'static str, OmniError> {
    match tool.trim().to_ascii_lowercase().as_str() {
        "node" => Ok("node"),
        "cargo" => Ok("cargo"),
        "wat2wasm" => Ok("wat2wasm"),
        other => Err(OmniError::invalid_input(format!(
            "不支持自动安装: {other}（仅 node / cargo / wat2wasm）"
        ))),
    }
}

fn extra_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    {
        dirs.push(home.join(".cargo").join("bin"));
        #[cfg(windows)]
        {
            dirs.push(home.join("AppData").join("Roaming").join("npm"));
            dirs.push(home.join("AppData").join("Local").join("fnm_multishells"));
        }
        #[cfg(not(windows))]
        {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(PathBuf::from("/opt/homebrew/bin"));
            dirs.push(PathBuf::from("/usr/local/bin"));
        }
    }
    #[cfg(windows)]
    {
        dirs.push(PathBuf::from(r"C:\Program Files\nodejs"));
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join("Programs").join("nodejs"));
        }
    }
    dirs
}

fn program_names(program: &str) -> Vec<String> {
    #[cfg(windows)]
    {
        if Path::new(program).extension().is_some() {
            vec![program.to_string()]
        } else {
            vec![
                format!("{program}.exe"),
                format!("{program}.cmd"),
                format!("{program}.bat"),
                program.to_string(),
            ]
        }
    }
    #[cfg(not(windows))]
    {
        vec![program.to_string()]
    }
}

/// Windows 上 `Command::new("node")` 只查当前进程 PATH，不看子进程 env。
/// 先在 cargo/node 常见目录里解析出绝对路径。
fn resolve_program(program: &str) -> PathBuf {
    let raw = Path::new(program);
    if raw.is_absolute() || program.contains('/') || program.contains('\\') {
        return raw.to_path_buf();
    }
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut dirs = extra_bin_dirs();
    if let Ok(path) = std::env::var("PATH") {
        for part in path.split(sep) {
            if !part.is_empty() {
                dirs.push(PathBuf::from(part));
            }
        }
    }
    let names = program_names(program);
    for dir in dirs {
        for name in &names {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    raw.to_path_buf()
}

/// 给子进程补 cargo / node / npm 常见安装路径，不改当前进程环境
///（Rust 2024 起 `env::set_var` 是 unsafe）。
fn toolchain_path() -> Option<String> {
    let extras = extra_bin_dirs();
    let old = std::env::var("PATH").unwrap_or_default();
    let old_lower = old.to_ascii_lowercase();
    let sep = if cfg!(windows) { ';' } else { ':' };
    let mut prefix: Vec<String> = Vec::new();
    for dir in extras {
        if !dir.is_dir() {
            continue;
        }
        let text = dir.to_string_lossy().into_owned();
        if old_lower.contains(&text.to_ascii_lowercase()) {
            continue;
        }
        if prefix
            .iter()
            .any(|item| item.eq_ignore_ascii_case(&text))
        {
            continue;
        }
        prefix.push(text);
    }
    if prefix.is_empty() {
        return None;
    }
    let mut next = prefix.join(&sep.to_string());
    next.push(sep);
    next.push_str(&old);
    Some(next)
}

fn probe_version(program: &str, cwd: &Path) -> Option<String> {
    command_hidden(program)
        .arg("--version")
        .current_dir(cwd)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
}

fn collect_output(output: &std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(stderr.trim());
    }
    text
}

fn run_hidden_args(program: &str, args: &[&str], cwd: &Path) -> Result<String, OmniError> {
    let output = command_hidden(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| OmniError::invalid_input(format!("无法启动 {program}: {e}")))?;
    let text = collect_output(&output);
    if !output.status.success() {
        return Err(OmniError::internal(format!(
            "{program} 退出码 {}:\n{text}",
            output.status.code().unwrap_or(-1)
        )));
    }
    Ok(text)
}

fn install_node(cwd: &Path) -> Result<String, OmniError> {
    #[cfg(windows)]
    {
        run_hidden_args(
            "winget",
            &[
                "install",
                "-e",
                "--id",
                "OpenJS.NodeJS.LTS",
                "--accept-package-agreements",
                "--accept-source-agreements",
            ],
            cwd,
        )
    }
    #[cfg(target_os = "macos")]
    {
        run_hidden_args("brew", &["install", "node"], cwd)
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = cwd;
        Err(OmniError::invalid_input(
            "Linux 请用发行版包管理器安装 Node.js 后点刷新",
        ))
    }
}

fn install_cargo(rustup_init: Option<PathBuf>, cwd: &Path) -> Result<String, OmniError> {
    if probe_version("rustup", cwd).is_some() {
        return run_hidden_args("rustup", &["toolchain", "install", "stable"], cwd);
    }
    if let Some(path) = rustup_init {
        let out = run_hidden_args(
            &path.to_string_lossy(),
            &["-y", "--default-toolchain", "stable"],
            cwd,
        )?;
        return Ok(out);
    }
    #[cfg(target_os = "macos")]
    {
        let _ = run_hidden_args("brew", &["install", "rustup-init"], cwd);
        return run_hidden_args("rustup-init", &["-y", "--default-toolchain", "stable"], cwd);
    }
    #[cfg(not(target_os = "macos"))]
    Err(OmniError::invalid_input(
        "未找到 rustup，请先安装 Rust 工具链后刷新",
    ))
}

fn install_wat2wasm(cwd: &Path) -> Result<String, OmniError> {
    if probe_version("node", cwd).is_none() {
        let node_out = install_node(cwd)?;
        let wabt = run_hidden_args("npm", &["install", "-g", "wabt"], cwd)?;
        return Ok(format!("{node_out}\n{wabt}"));
    }
    run_hidden_args("npm", &["install", "-g", "wabt"], cwd)
}

/// 按白名单安装本机工具链（Windows 优先 winget / rustup-init；安装后刷新 PATH 再探测）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_env_install(
    state: State<'_, AppState>,
    tool: String,
) -> Result<StudioEnvInstallResult, OmniError> {
    let tool = normalize_env_tool(&tool)?.to_string();
    let cwd = repo_root().unwrap_or_else(|| PathBuf::from("."));
    let rustup_init = if tool == "cargo" {
        download_rustup_init(&state.plugin_http).await?
    } else {
        None
    };
    let join = tokio::task::spawn_blocking(move || {
        let result = match tool.as_str() {
            "node" => install_node(&cwd),
            "cargo" => install_cargo(rustup_init, &cwd),
            "wat2wasm" => install_wat2wasm(&cwd),
            _ => Err(OmniError::invalid_input("未知工具")),
        };
        let version = probe_version(&tool, &cwd);
        match result {
            Ok(output) => StudioEnvInstallResult {
                ok: version.is_some(),
                output,
                version,
                tool,
            },
            Err(err) => StudioEnvInstallResult {
                ok: false,
                output: err.to_string(),
                version,
                tool,
            },
        }
    });
    match tokio::time::timeout(INSTALL_TIMEOUT, join).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(e)) => Err(OmniError::internal(e.to_string())),
        Err(_) => Err(OmniError::internal("安装超时（15 分钟）")),
    }
}

async fn download_rustup_init(client: &reqwest::Client) -> Result<Option<PathBuf>, OmniError> {
    let cwd = repo_root().unwrap_or_else(|| PathBuf::from("."));
    if probe_version("rustup", &cwd).is_some() {
        return Ok(None);
    }
    #[cfg(windows)]
    {
        let bytes = client
            .get(RUSTUP_INIT_URL)
            .send()
            .await
            .map_err(|e| OmniError::connection(format!("下载 rustup-init 失败: {e}")))?
            .bytes()
            .await
            .map_err(|e| OmniError::connection(format!("读取 rustup-init 失败: {e}")))?;
        let path = std::env::temp_dir().join("omni-rustup-init.exe");
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| OmniError::internal(e.to_string()))?;
        return Ok(Some(path));
    }
    #[cfg(not(windows))]
    {
        let _ = client;
        Ok(None)
    }
}

/// 脚手架：新建一律写用户目录。有仓库+node 时复用 create-plugin.mjs；否则写内置 JS/L1 骨架。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_scaffold(
    app: AppHandle,
    _state: State<'_, AppState>,
    name: String,
    kind: String,
    starter: Option<String>,
) -> Result<StudioProject, OmniError> {
    let name = name.trim().to_string();
    let kind = kind.trim().to_lowercase();
    let template = resolve_scaffold_template(&kind, starter.as_deref())?.to_string();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        || !name.starts_with(|c: char| c.is_ascii_lowercase())
    {
        return Err(OmniError::invalid_input(
            "工程名非法（小写字母开头，仅字母/数字/连字符）",
        ));
    }
    let roots = studio_roots(&app)?;
    let dest = roots.user.join(&name);
    if dest.exists() {
        return Err(OmniError::invalid_input(format!("工程已存在: {name}")));
    }
    if roots
        .repo
        .as_ref()
        .is_some_and(|repo| repo.join(&name).exists())
    {
        return Err(OmniError::invalid_input(format!("工程已存在: {name}")));
    }
    std::fs::create_dir_all(&roots.user).map_err(|e| OmniError::internal(e.to_string()))?;

    let used_script = if let Some(repo) = repo_root() {
        let name_for_task = name.clone();
        let template_for_task = template.clone();
        let dest_str = roots.user.to_string_lossy().into_owned();
        let result = tokio::task::spawn_blocking(move || {
            let mut cmd = command_hidden("node");
            cmd.args([
                "scripts/create-plugin.mjs".to_string(),
                name_for_task,
                template_for_task,
            ])
            .current_dir(&repo)
            .env("OMNIPANEL_PLUGIN_PROJECTS_DIR", &dest_str);
            if let Some(path) = toolchain_path() {
                cmd.env("PATH", path);
            }
            cmd.output()
        })
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?;
        match result {
            Ok(output) if output.status.success() && dest.is_dir() => true,
            _ => false,
        }
    } else {
        false
    };
    if !used_script {
        write_builtin_scaffold(&dest, &name, &template)?;
    }
    Ok(load_studio_project(&dest, name, "user"))
}

/// 记录 AI 脚手架意图（detail 仅为摘要）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_audit_scaffold(
    state: State<'_, AppState>,
    project: String,
    prompt: String,
) -> Result<(), OmniError> {
    let _ = valid_project_name(&project)?;
    let detail = scaffold_prompt_digest(&prompt);
    let entry = AuditEntry {
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        action: "plugin.ai_scaffold".into(),
        target: project.trim().to_string(),
        env_tag: "-".into(),
        risk: "medium".into(),
        status: "success".into(),
        detail,
    };
    if let Ok(store) = state.storage.try_lock() {
        let _ = store.append_audit(&entry);
    }
    Ok(())
}

/// 删除工程目录（用户目录或仓库 plugins-custom，禁锢与读写相同）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_remove_project(
    app: AppHandle,
    _state: State<'_, AppState>,
    name: String,
) -> Result<(), OmniError> {
    let roots = studio_roots(&app)?;
    let dir = resolve_project_dir(&roots, &name)?;
    if !dir.is_dir() {
        return Err(OmniError::not_found(format!("工程不存在: {name}")));
    }
    let parent = dir
        .parent()
        .ok_or_else(|| OmniError::invalid_input("路径越界"))?;
    let allowed = parent == roots.user
        || roots.repo.as_ref().is_some_and(|repo| parent == repo);
    let canon = dir
        .canonicalize()
        .map_err(|e| OmniError::internal(e.to_string()))?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| OmniError::internal(e.to_string()))?;
    if !allowed || !canon.starts_with(&parent_canon) || canon == parent_canon {
        return Err(OmniError::invalid_input("路径越界"));
    }
    std::fs::remove_dir_all(&canon).map_err(|e| OmniError::internal(e.to_string()))?;
    Ok(())
}

/// 校验走清单 Rust 解析；打包走 `omnipanel-plugin-pkg::pack_dir`（dev 签名，可本地安装）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_run(
    app: AppHandle,
    _state: State<'_, AppState>,
    project: String,
    op: String,
) -> Result<StudioRunResult, OmniError> {
    let roots = studio_roots(&app)?;
    let dir = resolve_project_dir(&roots, &project)?;
    if !dir.is_dir() {
        return Err(OmniError::not_found(format!("工程不存在: {project}")));
    }
    let join = tokio::task::spawn_blocking(move || match op.as_str() {
        "validate" => validate_project_dir(&dir),
        "pack" => pack_project_dir(&dir, &project),
        _ => Err(OmniError::invalid_input(format!("未知操作: {op}"))),
    });
    let output = match tokio::time::timeout(RUN_TIMEOUT, join).await {
        Ok(join_result) => join_result.map_err(|e| OmniError::internal(e.to_string()))?,
        Err(_) => return Err(OmniError::internal("执行超时（600s），已终止任务")),
    };
    match output {
        Ok(text) => {
            let artifact_path = text
                .lines()
                .find_map(|line| line.strip_prefix("[artifact] ").map(str::to_string));
            Ok(StudioRunResult {
                success: true,
                output: text,
                artifact_path,
            })
        }
        Err(err) => Ok(StudioRunResult {
            success: false,
            output: err.to_string(),
            artifact_path: None,
        }),
    }
}

fn validate_project_dir(dir: &Path) -> Result<String, OmniError> {
    let path = dir.join("plugin.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|_| OmniError::not_found("工程缺少 plugin.json"))?;
    let manifest =
        PluginManifest::from_json(&text).map_err(|e| OmniError::invalid_input(e.to_string()))?;
    manifest
        .validate()
        .map_err(|e| OmniError::invalid_input(e.to_string()))?;
    Ok(format!(
        "ok id={} version={} kind={kind}",
        manifest.id,
        manifest.version,
        kind = manifest.kind.as_str()
    ))
}

fn pack_project_dir(dir: &Path, project: &str) -> Result<String, OmniError> {
    let out = std::env::temp_dir().join(format!(
        "omni-studio-{project}-{}.omni-plugin",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let key = dev_signing_key();
    pack_dir(dir, &out, Some(&key)).map_err(|e| OmniError::internal(e.to_string()))?;
    let out_str = out.to_string_lossy().into_owned();
    Ok(format!("packed\n[artifact] {out_str}"))
}

fn write_file(path: &Path, content: &str) -> Result<(), OmniError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| OmniError::internal(e.to_string()))?;
    }
    std::fs::write(path, content).map_err(|e| OmniError::internal(e.to_string()))
}

fn write_builtin_scaffold(dir: &Path, name: &str, template: &str) -> Result<(), OmniError> {
    std::fs::create_dir_all(dir).map_err(|e| OmniError::internal(e.to_string()))?;
    let id = match template {
        "engine" | "engine-sidecar" => format!("omni.engine.{name}"),
        "js-logic" | "l3-overlay" | "wasm-stub" => format!("omni.sample.{name}"),
        other => format!("omni.{other}.{name}"),
    };
    let kind = match template {
        "engine" | "engine-sidecar" => "engine",
        "js-logic" | "l3-overlay" | "wasm-stub" | "addon" => "addon",
        other => other,
    };
    let mut manifest = serde_json::json!({
        "id": id,
        "version": "0.1.0",
        "displayName": name,
        "kind": kind,
        "permissions": [],
        "minHostApi": 1,
        "contributes": {}
    });
    match template {
        "js-logic" | "addon" => {
            manifest["methods"] = serde_json::json!([{ "name": "echo", "permissions": [] }]);
            manifest["entry"] = serde_json::json!({ "logic": "logic.js", "ui": "ui/main.js" });
            write_file(dir.join("logic.js").as_path(), JS_LOGIC)?;
            write_file(dir.join("ui/main.js").as_path(), UI_MAIN)?;
        }
        "l3-overlay" => {
            manifest["permissions"] = serde_json::json!(["ui:selection"]);
            manifest["entry"] = serde_json::json!({ "ui": "ui/main.js" });
            manifest["contributes"] = serde_json::json!({
                "overlays": [{ "id": "main", "entry": "ui/index.html" }]
            });
            write_file(dir.join("ui/main.js").as_path(), UI_MAIN)?;
            write_file(dir.join("ui/index.html").as_path(), "<html><body>overlay</body></html>")?;
        }
        "wasm-stub" => {
            manifest["methods"] = serde_json::json!([{ "name": "echo", "permissions": [] }]);
            manifest["entry"] = serde_json::json!({ "logic": "logic.wasm" });
            write_file(dir.join("logic.wat").as_path(), "(module)\n")?;
        }
        "theme" => {
            manifest["permissions"] = serde_json::json!([]);
            manifest["contributes"] = serde_json::json!({
                "themes": { "tokens": "tokens.json" }
            });
            write_file(dir.join("tokens.json").as_path(), THEME_STARTER_TOKENS)?;
        }
        _ => {
            manifest["methods"] = serde_json::json!([{ "name": "echo", "permissions": [] }]);
            manifest["entry"] = serde_json::json!({ "logic": "logic.js" });
            write_file(dir.join("logic.js").as_path(), JS_LOGIC)?;
        }
    }
    let json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| OmniError::internal(e.to_string()))?;
    write_file(&dir.join("plugin.json"), &json)?;
    Ok(())
}

const THEME_STARTER_TOKENS: &str = r##"{
  "js": false,
  "css": {
    "dark": {
      "--accent": "#ff6b00",
      "--accent-hover": "#cc5600",
      "--accent-active": "#993f00",
      "--accent-soft": "rgba(255, 107, 0, 0.12)",
      "--border-focus": "#ff6b00"
    },
    "light": {
      "--accent": "#e05a00",
      "--accent-hover": "#b34700",
      "--accent-active": "#803300",
      "--accent-soft": "rgba(224, 90, 0, 0.1)",
      "--border-focus": "#e05a00"
    }
  },
  "terminal": {
    "dark": {
      "background": "#1a1717",
      "foreground": "#f4f1ed",
      "cursor": "#ff6b00",
      "selectionBackground": "#5b504a",
      "black": "#1a1717",
      "red": "#ff6b6b",
      "green": "#51cf66",
      "yellow": "#ffd43b",
      "blue": "#ff922b",
      "magenta": "#da77f2",
      "cyan": "#66d9e8",
      "white": "#f4f1ed",
      "brightBlack": "#7c6f66",
      "brightRed": "#ff8787",
      "brightGreen": "#69db7c",
      "brightYellow": "#ffe066",
      "brightBlue": "#ffa94d",
      "brightMagenta": "#e599f7",
      "brightCyan": "#99e9f2",
      "brightWhite": "#fff9f0"
    },
    "light": {
      "background": "#ffffff",
      "foreground": "#1d1d1f",
      "cursor": "#e05a00",
      "selectionBackground": "rgba(224, 90, 0, 0.18)",
      "black": "#000000",
      "red": "#c91b00",
      "green": "#008400",
      "yellow": "#a8810c",
      "blue": "#b34700",
      "magenta": "#a800b0",
      "cyan": "#0a7a83",
      "white": "#5a5a5a",
      "brightBlack": "#3a3a3c",
      "brightRed": "#e60023",
      "brightGreen": "#00a300",
      "brightYellow": "#b58900",
      "brightBlue": "#e05a00",
      "brightMagenta": "#c400cc",
      "brightCyan": "#0099b0",
      "brightWhite": "#000000"
    }
  }
}
"##;

const JS_LOGIC: &str = r#"function asObj(v) {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(String(v || "{}")); } catch (e) { return {}; }
}
function echo(args) {
  var a = asObj(args);
  return { echo: a.text || a || "", at: Date.now() };
}
var HANDLERS = { echo: echo };
function call(method, argsJson) {
  var handler = HANDLERS[String(method || "")];
  if (!handler) throw new Error("UnknownMethod: " + method);
  var result = handler(asObj(argsJson));
  return typeof result === "string" ? result : JSON.stringify(result);
}
globalThis.call = call;
"#;

const UI_MAIN: &str = r#"module.exports = definePlugin({
  activate: async () => {},
  deactivate: () => {},
});
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jail_rejects_traversal_and_absolute() {
        let base = PathBuf::from("demo-root");
        assert!(jail_path_in(&base, "../evil.txt").is_err());
        assert!(jail_path_in(&base, "/abs/path.js").is_err());
        assert!(jail_path_in(&base, "https://x/y.js").is_err());
        assert!(jail_path_in(&base, "ui/../../x.js").is_err());
        assert!(valid_project_name("../demo").is_err());
        assert!(jail_path_in(&base, "").is_err());
    }

    #[test]
    fn jail_allows_normal_rel_paths() {
        let base = PathBuf::from("demo-root");
        assert_eq!(
            jail_path_in(&base, "ui/main.js").unwrap(),
            base.join("ui/main.js")
        );
        assert_eq!(
            jail_path_in(&base, "plugin.json").unwrap(),
            base.join("plugin.json")
        );
    }

    #[test]
    fn project_name_rules() {
        assert!(valid_project_name("Demo").is_ok());
        assert!(valid_project_name("").is_err());
        assert!(valid_project_name("a/b").is_err());
        assert!(valid_project_name("../x").is_err());
        assert!(valid_project_name("my-plugin-1").is_ok());
    }

    #[test]
    fn scaffold_digest_has_no_plaintext() {
        let secret = "做个选中翻译插件 super-secret";
        let digest = scaffold_prompt_digest(secret);
        assert!(digest.starts_with("sha256:"));
        assert!(digest.contains("len="));
        assert!(!digest.contains("翻译"));
        assert!(!digest.contains("super-secret"));
    }

    #[test]
    fn builtin_js_scaffold_validates_and_packs() {
        let dir = std::env::temp_dir().join(format!(
            "omni-studio-test-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        write_builtin_scaffold(&dir, "demo", "js-logic").unwrap();
        let msg = validate_project_dir(&dir).unwrap();
        assert!(msg.contains("omni.sample.demo"), "{msg}");
        let packed = pack_project_dir(&dir, "demo").unwrap();
        assert!(packed.contains("[artifact]"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn builtin_theme_scaffold_validates() {
        let dir = std::env::temp_dir().join(format!(
            "omni-studio-theme-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        write_builtin_scaffold(&dir, "skin", "theme").unwrap();
        let msg = validate_project_dir(&dir).unwrap();
        assert!(msg.contains("theme"), "{msg}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_install_tool_whitelist() {
        assert_eq!(normalize_env_tool("Node").unwrap(), "node");
        assert_eq!(normalize_env_tool("CARGO").unwrap(), "cargo");
        assert_eq!(normalize_env_tool("wat2wasm").unwrap(), "wat2wasm");
        assert!(normalize_env_tool("pnpm").is_err());
        assert!(normalize_env_tool("").is_err());
    }
}
