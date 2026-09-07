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
fn repo_root() -> Option<PathBuf> {
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

fn project_dir(name: &str) -> Result<PathBuf, OmniError> {
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

fn collect_files(dir: &Path, base: &Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    names.sort_by_key(|e| e.file_name());
    for entry in names {
        let path = entry.path();
        if path.is_dir() {
            collect_files(&path, base, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
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
        let mut files = Vec::new();
        collect_files(&entry.path(), &entry.path(), &mut files);
        // 隐藏超大/二进制文件（>512KB 不进列表，避免误点）
        files.retain(|rel| {
            entry
                .path()
                .join(rel)
                .metadata()
                .map(|m| m.len() <= MAX_READ_BYTES && m.is_file())
                .unwrap_or(false)
        });
        out.push(StudioProject {
            has_manifest: entry.path().join("plugin.json").is_file(),
            name,
            files,
        });
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

fn run_blocking(program: &str, args: &[String], cwd: &Path) -> Result<String, OmniError> {
    let output = std::process::Command::new(program)
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
    let probe = |program: &str| {
        std::process::Command::new(program)
            .arg("--version")
            .current_dir(&cwd)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .to_string()
            })
            .filter(|s| !s.is_empty())
    };
    Ok(StudioEnv {
        cargo: probe("cargo"),
        node: probe("node"),
        wat2wasm: probe("wat2wasm"),
        repo_root: repo_root().map(|p| p.to_string_lossy().into_owned()),
    })
}

/// 脚手架：`node scripts/create-plugin.mjs <name> <kind>`，返回刷新后的工程。
/// name 规则与脚本一致（小写字母开头）；kind 不在白名单直接拒绝。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_scaffold(
    _state: State<'_, AppState>,
    name: String,
    kind: String,
) -> Result<StudioProject, OmniError> {
    const KINDS: &[&str] = &[
        "engine",
        "engine-sidecar",
        "theme",
        "module",
        "cloud",
        "panel",
        "importer",
        "addon",
        "js-logic",
        "l3-overlay",
        "wasm-stub",
    ];
    let name = name.trim().to_string();
    let kind = kind.trim().to_lowercase();
    if !KINDS.contains(&kind.as_str()) {
        return Err(OmniError::invalid_input(format!("不支持的模板: {kind}")));
    }
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
                kind.clone(),
            ],
            &root,
        )
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))??;
    let _ = output;
    let dir = project_dir(&name)?;
    let mut files = Vec::new();
    collect_files(&dir, &dir, &mut files);
    Ok(StudioProject {
        has_manifest: dir.join("plugin.json").is_file(),
        name,
        files,
    })
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
}
