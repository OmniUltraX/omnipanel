//! 插件工程桥（IDE P1）：`plugins-custom/` 工程的列举/读写/跑脚本/环境检测。
//!
//! 安全边界（与开放 shell 有本质区别）：
//! - 读写禁锢在仓库 `plugins-custom/` 内（`..` / 绝对路径一律拒绝）；
//! - `run` 只允许白名单内的三类调用（validate / pack / 版本探测），
//!   参数仅为工程名；命令模板写死在代码里，不接受任意命令字符串；
//! - 单文件上限（读 512KB / 写 1MB），非 UTF-8 文本拒绝。

use std::path::{Path, PathBuf};
use std::time::Duration;

use omnipanel_error::OmniError;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

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
/// 打包产物内无源码树时返回 None（studio 仅源码运行可用）。
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

fn projects_dir() -> Result<PathBuf, OmniError> {
    let root = repo_root().ok_or_else(|| {
        OmniError::invalid_input("插件工程仅在源码运行可用（找不到仓库 plugins-custom）")
    })?;
    Ok(root.join("plugins-custom"))
}

pub(crate) fn project_dir(name: &str) -> Result<PathBuf, OmniError> {
    if name.trim().is_empty()
        || name.contains("..")
        || name.contains('/')
        || name.contains('\\')
        || name.contains(':')
    {
        return Err(OmniError::invalid_input("工程名非法"));
    }
    Ok(projects_dir()?.join(name.trim()))
}

fn jail_path(project: &str, rel: &str) -> Result<PathBuf, OmniError> {
    let trimmed = rel.trim().replace('\\', "/");
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.contains("://")
        || trimmed.split('/').any(|seg| seg == ".." || seg.is_empty())
    {
        return Err(OmniError::invalid_input(format!("路径越界: {rel}")));
    }
    let base = project_dir(project)?;
    let target = base.join(&trimmed);
    if !target.starts_with(&base) {
        return Err(OmniError::invalid_input("路径越界"));
    }
    Ok(target)
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

fn load_studio_project(dir: &Path, name: String) -> StudioProject {
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

/// 列出 `plugins-custom/` 下的工程（有无 plugin.json 都列，缺失标 has_manifest=false）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_list_projects(
    _state: State<'_, AppState>,
) -> Result<Vec<StudioProject>, OmniError> {
    let root = match projects_dir() {
        Ok(dir) => dir,
        Err(_) => return Ok(Vec::new()),
    };
    if !root.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Ok(Vec::new());
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
        out.push(load_studio_project(&entry.path(), name));
    }
    Ok(out)
}

/// 读工程文件（文本，≤512KB）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_read_file(
    _state: State<'_, AppState>,
    project: String,
    path: String,
) -> Result<String, OmniError> {
    let target = jail_path(&project, &path)?;
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
    _state: State<'_, AppState>,
    project: String,
    path: String,
    content: String,
) -> Result<(), OmniError> {
    if content.len() > MAX_WRITE_BYTES {
        return Err(OmniError::invalid_input("内容超过 1MB 上限"));
    }
    let target = jail_path(&project, &path)?;
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

fn run_blocking(program: &str, args: &[String], cwd: &Path) -> Result<String, OmniError> {
    let output = command_hidden(program)
        .args(args)
        .current_dir(cwd)
        .output()
        .map_err(|e| {
            OmniError::invalid_input(format!(
                "找不到 {program}（{e}），请先安装对应工具链，见工作台环境页"
            ))
        })?;
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        text.push_str("\n[stderr]\n");
        text.push_str(&stderr);
    }
    if !output.status.success() {
        return Err(OmniError::internal(format!(
            "{program} 退出码 {}:\n{text}",
            output.status.code().unwrap_or(-1)
        )));
    }
    Ok(text)
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

/// 脚手架：`node scripts/create-plugin.mjs <name> <template>`。
/// `kind` 仅七种身份；`starter` 把身份映射成可跑模板（引擎默认 sidecar，附加组件默认 JS 逻辑）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_scaffold(
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
    if project_dir(&name)?.exists() {
        return Err(OmniError::invalid_input(format!("工程已存在: {name}")));
    }
    let root = repo_root().ok_or_else(|| {
        OmniError::invalid_input("插件工程仅在源码运行可用（找不到仓库根）")
    })?;
    let name_for_task = name.clone();
    let output = tokio::task::spawn_blocking(move || {
        run_blocking(
            "node",
            &[
                "scripts/create-plugin.mjs".to_string(),
                name_for_task.clone(),
                template,
            ],
            &root,
        )
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))??;
    let _ = output;
    Ok(load_studio_project(&project_dir(&name)?, name))
}

/// 删除 `plugins-custom/<name>`（仅允许该目录本身，禁锢与读写相同）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_remove_project(
    _state: State<'_, AppState>,
    name: String,
) -> Result<(), OmniError> {
    let dir = project_dir(&name)?;
    if !dir.is_dir() {
        return Err(OmniError::not_found(format!("工程不存在: {name}")));
    }
    let parent = projects_dir()?;
    let canon = dir
        .canonicalize()
        .map_err(|e| OmniError::internal(e.to_string()))?;
    let parent_canon = parent
        .canonicalize()
        .map_err(|e| OmniError::internal(e.to_string()))?;
    if !canon.starts_with(&parent_canon) || canon == parent_canon {
        return Err(OmniError::invalid_input("路径越界"));
    }
    std::fs::remove_dir_all(&canon).map_err(|e| OmniError::internal(e.to_string()))?;
    Ok(())
}

/// 跑脚本：`validate`（node validate-plugin.mjs）或 `pack`
///（cargo run pack → temp 产物，返回 artifact 路径）。
/// 首次编译 pack 工具较慢，属预期内。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_run(
    _state: State<'_, AppState>,
    project: String,
    op: String,
) -> Result<StudioRunResult, OmniError> {
    let dir = project_dir(&project)?;
    if !dir.is_dir() {
        return Err(OmniError::not_found(format!("工程不存在: {project}")));
    }
    let root = repo_root().ok_or_else(|| {
        OmniError::invalid_input("插件工程仅在源码运行可用（找不到仓库根）")
    })?;
    let join = tokio::task::spawn_blocking(move || match op.as_str() {
        "validate" => run_blocking(
            "node",
            &[
                "scripts/validate-plugin.mjs".to_string(),
                format!("plugins-custom/{project}"),
            ],
            &root,
        ),
        "pack" => {
            let out = std::env::temp_dir().join(format!(
                "omni-studio-{project}-{}.omni-plugin",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ));
            let out_str = out.to_string_lossy().into_owned();
            run_blocking(
                "cargo",
                &[
                    "run".into(),
                    "-q".into(),
                    "-p".into(),
                    "omnipanel-plugin-pkg".into(),
                    "--bin".into(),
                    "pack".into(),
                    "--".into(),
                    format!("plugins-custom/{project}"),
                    out_str.clone(),
                ],
                &root,
            )
            .map(|text| format!("{text}\n[artifact] {out_str}"))
        }
        _ => Err(OmniError::invalid_input(format!("未知操作: {op}"))),
    });
    // 真超时：600s 未完成则 abort 后台任务并报错（首次编译 pack 工具较慢属预期）
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jail_rejects_traversal_and_absolute() {
        assert!(jail_path("demo", "../evil.txt").is_err());
        assert!(jail_path("demo", "/abs/path.js").is_err());
        assert!(jail_path("demo", "https://x/y.js").is_err());
        assert!(jail_path("demo", "ui/../../x.js").is_err());
        assert!(jail_path("../demo", "ui/main.js").is_err());
        assert!(jail_path("demo", "").is_err());
    }

    #[test]
    fn jail_allows_normal_rel_paths() {
        let base = project_dir("demo").unwrap();
        assert_eq!(
            jail_path("demo", "ui/main.js").unwrap(),
            base.join("ui/main.js")
        );
        assert_eq!(
            jail_path("demo", "plugin.json").unwrap(),
            base.join("plugin.json")
        );
    }

    #[test]
    fn project_name_rules() {
        // project_dir 只防穿越/空名（宽松，兼容已存在目录）；
        // 小写字母开头等严规则在 scaffold 入口执行。
        assert!(project_dir("Demo").is_ok());
        assert!(project_dir("").is_err());
        assert!(project_dir("a/b").is_err());
        assert!(project_dir("../x").is_err());
        assert!(project_dir("my-plugin-1").is_ok());
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
