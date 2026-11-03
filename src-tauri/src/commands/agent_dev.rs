//! 开发态：官方 Agent sidecar 缺二进制时本地 `cargo build` 并装进插件目录。
//! 正式版走插件中心下载，不走这条路径。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use omnipanel_error::OmniError;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::plugin::rebuild_and_sync;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDevEnsureItem {
    pub plugin_id: String,
    pub title: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDevEnsureResult {
    pub items: Vec<AgentDevEnsureItem>,
}

struct OfficialAgentSpec {
    plugin_id: &'static str,
    title: &'static str,
    /// cargo `-p` 包名（Trae 国际版与国内共用一个 crate）
    package_name: &'static str,
    /// 仓库 `plugins/<dir>`
    plugin_dir: &'static str,
    /// 可执行文件主名（不含 .exe）
    bin_name: &'static str,
}

const OFFICIAL_AGENTS: &[OfficialAgentSpec] = &[
    OfficialAgentSpec {
        plugin_id: omnipanel_plugin::PLUGIN_ID_AGENT_WORKBUDDY,
        title: "WorkBuddy",
        package_name: "omnipanel-agent-workbuddy",
        plugin_dir: "agent-workbuddy",
        bin_name: "omnipanel-agent-workbuddy",
    },
    OfficialAgentSpec {
        plugin_id: omnipanel_plugin::PLUGIN_ID_AGENT_CURSOR,
        title: "Cursor",
        package_name: "omnipanel-agent-cursor",
        plugin_dir: "agent-cursor",
        bin_name: "omnipanel-agent-cursor",
    },
    OfficialAgentSpec {
        plugin_id: omnipanel_plugin::PLUGIN_ID_AGENT_TRAE,
        title: "Trae",
        package_name: "omnipanel-agent-trae",
        plugin_dir: "agent-trae",
        bin_name: "omnipanel-agent-trae",
    },
    OfficialAgentSpec {
        plugin_id: omnipanel_plugin::PLUGIN_ID_AGENT_TRAE_GLOBAL,
        title: "Trae 国际版",
        package_name: "omnipanel-agent-trae",
        plugin_dir: "agent-trae-global",
        bin_name: "omnipanel-agent-trae-global",
    },
    OfficialAgentSpec {
        plugin_id: omnipanel_plugin::PLUGIN_ID_AGENT_OPENCODE_GO,
        title: "OpenCode Go",
        package_name: "omnipanel-agent-opencode-go",
        plugin_dir: "agent-opencode-go",
        bin_name: "omnipanel-agent-opencode-go",
    },
];

fn workspace_root() -> Option<PathBuf> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // src-tauri → 仓库根
    dir.pop();
    if dir.join("Cargo.toml").is_file() && dir.join("plugins").is_dir() {
        return Some(dir);
    }
    None
}

fn bin_file_name(stem: &str) -> String {
    if cfg!(windows) {
        format!("{stem}.exe")
    } else {
        stem.to_string()
    }
}

fn installed_driver_path(plugins_root: &Path, plugin_id: &str, bin_name: &str) -> PathBuf {
    let mut path = plugins_root.join(plugin_id).join("bin").join(bin_name);
    if cfg!(windows) && path.extension().is_none() {
        path.set_extension("exe");
    }
    path
}

fn find_built_binary(root: &Path, bin_name: &str) -> Option<PathBuf> {
    let file = bin_file_name(bin_name);
    let candidates = [
        root.join("target").join("debug").join(&file),
        root.join("target").join("release").join(&file),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn cargo_build(root: &Path, package_name: &str) -> Result<(), String> {
    let cargo = if cfg!(windows) { "cargo.exe" } else { "cargo" };
    let status = Command::new(cargo)
        .args(["build", "-p", package_name])
        .current_dir(root)
        .status()
        .map_err(|e| format!("启动 cargo 失败: {e}"))?;
    if !status.success() {
        return Err(format!("cargo build -p {package_name} 失败 ({status})"));
    }
    Ok(())
}

fn stage_plugin_install(
    root: &Path,
    plugins_root: &Path,
    spec: &OfficialAgentSpec,
    binary: &Path,
) -> Result<(), String> {
    let dest_dir = plugins_root.join(spec.plugin_id);
    let bin_dir = dest_dir.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| format!("创建插件目录失败: {e}"))?;

    let manifest_src = root
        .join("plugins")
        .join(spec.plugin_dir)
        .join("plugin.json");
    if !manifest_src.is_file() {
        return Err(format!("缺少清单: {}", manifest_src.display()));
    }
    fs::copy(&manifest_src, dest_dir.join("plugin.json"))
        .map_err(|e| format!("复制 plugin.json 失败: {e}"))?;

    let dest_bin = bin_dir.join(bin_file_name(spec.bin_name));
    fs::copy(binary, &dest_bin).map_err(|e| format!("复制 sidecar 失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest_bin, fs::Permissions::from_mode(0o755));
    }
    Ok(())
}

/// 开发态：为官方 Agent 编译 sidecar 并写入本地插件安装目录，再同步模型桥。
/// 非 debug 构建直接返回空结果（正式版请走插件中心下载）。
#[tauri::command]
#[specta::specta]
pub async fn agent_dev_ensure_sidecars(
    state: State<'_, AppState>,
) -> Result<AgentDevEnsureResult, OmniError> {
    if !cfg!(debug_assertions) {
        return Ok(AgentDevEnsureResult { items: Vec::new() });
    }

    let Some(root) = workspace_root() else {
        return Err(OmniError::internal(
            "无法定位仓库根目录，开发态无法自动编译 Agent sidecar",
        ));
    };
    let plugins_root = state
        .plugin_packages_dir
        .clone()
        .ok_or_else(|| OmniError::internal("无法定位插件安装目录"))?;

    let root_for_build = root.clone();
    let plugins_root_for_build = plugins_root.clone();
    let items = tokio::task::spawn_blocking(move || {
        let mut items = Vec::new();
        let mut built_packages = HashSet::<String>::new();
        for spec in OFFICIAL_AGENTS {
            let dest = installed_driver_path(&plugins_root_for_build, spec.plugin_id, spec.bin_name);
            if dest.is_file() {
                items.push(AgentDevEnsureItem {
                    plugin_id: spec.plugin_id.to_string(),
                    title: spec.title.to_string(),
                    status: "ready".into(),
                    detail: Some(dest.display().to_string()),
                });
                continue;
            }

            if !built_packages.contains(spec.package_name) {
                if let Err(err) = cargo_build(&root_for_build, spec.package_name) {
                    items.push(AgentDevEnsureItem {
                        plugin_id: spec.plugin_id.to_string(),
                        title: spec.title.to_string(),
                        status: "error".into(),
                        detail: Some(err),
                    });
                    continue;
                }
                built_packages.insert(spec.package_name.to_string());
            }

            let Some(binary) = find_built_binary(&root_for_build, spec.bin_name) else {
                items.push(AgentDevEnsureItem {
                    plugin_id: spec.plugin_id.to_string(),
                    title: spec.title.to_string(),
                    status: "error".into(),
                    detail: Some(format!(
                        "cargo 已完成但找不到 {}",
                        bin_file_name(spec.bin_name)
                    )),
                });
                continue;
            };

            match stage_plugin_install(&root_for_build, &plugins_root_for_build, spec, &binary) {
                Ok(()) => items.push(AgentDevEnsureItem {
                    plugin_id: spec.plugin_id.to_string(),
                    title: spec.title.to_string(),
                    status: "installed".into(),
                    detail: Some(binary.display().to_string()),
                }),
                Err(err) => items.push(AgentDevEnsureItem {
                    plugin_id: spec.plugin_id.to_string(),
                    title: spec.title.to_string(),
                    status: "error".into(),
                    detail: Some(err),
                }),
            }
        }
        items
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))?;

    if items
        .iter()
        .any(|item| item.status == "installed" || item.status == "ready")
    {
        rebuild_and_sync(&state).await?;
    }

    Ok(AgentDevEnsureResult { items })
}
