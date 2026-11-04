//! 官方 Agent sidecar：优先装正式包；开发态可本地编译覆盖并挂热重载。
//!
//! 顺序：已装二进制 → 官方目录下载 →（debug）cargo build 写入安装目录
//! →（debug）把仓库 `plugins/agent-*` 链进 plugin_dev 监听，改源码自动重编重装。

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use omnipanel_error::OmniError;
use omnipanel_plugin::PluginKind;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::official_catalog::plugin_official_install;
use crate::commands::plugin::rebuild_and_sync;
use crate::commands::plugin_dev::{
    install_dir_inner, load_dev_links, save_dev_links, DevLink,
};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDevEnsureItem {
    pub plugin_id: String,
    pub title: String,
    /// `ready` | `downloaded` | `built` | `watching` | `error`
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AgentDevEnsureResult {
    pub items: Vec<AgentDevEnsureItem>,
}

pub(crate) struct OfficialAgentSpec {
    pub plugin_id: &'static str,
    pub title: &'static str,
    /// cargo `-p` 包名（Trae 国际版与国内共用一个 crate）
    pub package_name: &'static str,
    /// 仓库 `plugins/<dir>`
    pub plugin_dir: &'static str,
    /// 可执行文件主名（不含 .exe）
    pub bin_name: &'static str,
}

pub(crate) const OFFICIAL_AGENTS: &[OfficialAgentSpec] = &[
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

pub(crate) fn find_agent_spec(plugin_id: &str) -> Option<&'static OfficialAgentSpec> {
    OFFICIAL_AGENTS
        .iter()
        .find(|spec| spec.plugin_id == plugin_id)
}

pub(crate) fn workspace_root() -> Option<PathBuf> {
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    dir.pop();
    if dir.join("Cargo.toml").is_file() && dir.join("plugins").is_dir() {
        return Some(dir);
    }
    None
}

/// 从插件源码目录向上找工作区根（热重载 pack 前编 sidecar 用）。
pub(crate) fn workspace_root_from(dir: &Path) -> Option<PathBuf> {
    let mut cur = dir.to_path_buf();
    for _ in 0..8 {
        if cur.join("Cargo.toml").is_file() && cur.join("plugins").is_dir() {
            return Some(cur);
        }
        if !cur.pop() {
            break;
        }
    }
    workspace_root()
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

pub(crate) fn cargo_build_agent(root: &Path, package_name: &str) -> Result<(), String> {
    let cargo = if cfg!(windows) { "cargo.exe" } else { "cargo" };
    let mut cmd = Command::new(cargo);
    cmd.args(["build", "-p", package_name])
        .current_dir(root)
        // GUI 宿主下 cargo/rustc 是控制台程序；不藏窗体会一闪一闪的黑框
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| format!("启动 cargo 失败: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = if !stderr.trim().is_empty() {
            stderr.trim().to_string()
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            output.status.to_string()
        };
        return Err(format!("cargo build -p {package_name} 失败: {detail}"));
    }
    Ok(())
}

fn copy_bin_into(dest_bin_dir: &Path, binary: &Path, bin_name: &str) -> Result<PathBuf, String> {
    fs::create_dir_all(dest_bin_dir).map_err(|e| format!("创建 bin 目录失败: {e}"))?;
    let dest = dest_bin_dir.join(bin_file_name(bin_name));
    fs::copy(binary, &dest).map_err(|e| format!("复制 sidecar 失败: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
    }
    Ok(dest)
}

fn stage_into_install_dir(
    root: &Path,
    plugins_root: &Path,
    spec: &OfficialAgentSpec,
    binary: &Path,
) -> Result<(), String> {
    let dest_dir = plugins_root.join(spec.plugin_id);
    let manifest_src = root
        .join("plugins")
        .join(spec.plugin_dir)
        .join("plugin.json");
    if !manifest_src.is_file() {
        return Err(format!("缺少清单: {}", manifest_src.display()));
    }
    fs::create_dir_all(&dest_dir).map_err(|e| format!("创建插件目录失败: {e}"))?;
    fs::copy(&manifest_src, dest_dir.join("plugin.json"))
        .map_err(|e| format!("复制 plugin.json 失败: {e}"))?;
    copy_bin_into(&dest_dir.join("bin"), binary, spec.bin_name)?;
    Ok(())
}

/// 热重载 / 目录导入前：若是官方 Rust Agent，先 cargo build 并把产物写入 `dir/bin/`。
pub(crate) fn prepare_agent_sidecar_for_dir(dir: &Path) -> Result<(), OmniError> {
    let manifest_path = dir.join("plugin.json");
    let text = fs::read_to_string(&manifest_path).map_err(|_| {
        OmniError::not_found(format!("目录缺少 plugin.json: {}", dir.display()))
    })?;
    let manifest = omnipanel_plugin::PluginManifest::from_json(&text)
        .map_err(|e| OmniError::invalid_input(format!("plugin.json 无效: {e}")))?;
    if manifest.kind != PluginKind::Agent {
        return Ok(());
    }
    let Some(spec) = find_agent_spec(&manifest.id) else {
        return Ok(());
    };

    let root = workspace_root_from(dir).ok_or_else(|| {
        OmniError::internal("无法定位仓库根目录，无法编译 Agent sidecar")
    })?;
    cargo_build_agent(&root, spec.package_name).map_err(OmniError::internal)?;
    let binary = find_built_binary(&root, spec.bin_name).ok_or_else(|| {
        OmniError::internal(format!(
            "cargo 完成但找不到 {}",
            bin_file_name(spec.bin_name)
        ))
    })?;
    copy_bin_into(&dir.join("bin"), &binary, spec.bin_name).map_err(OmniError::internal)?;
    Ok(())
}

fn driver_ready(plugins_root: &Path, spec: &OfficialAgentSpec) -> bool {
    installed_driver_path(plugins_root, spec.plugin_id, spec.bin_name).is_file()
}

/// 确保官方 Agent 可用：优先正式包下载；debug 可本地编并挂热重载。
#[tauri::command]
#[specta::specta]
pub async fn agent_dev_ensure_sidecars(
    state: State<'_, AppState>,
) -> Result<AgentDevEnsureResult, OmniError> {
    let plugins_root = state
        .plugin_packages_dir
        .clone()
        .ok_or_else(|| OmniError::internal("无法定位插件安装目录"))?;

    let mut items = Vec::new();
    let mut need_sync = false;
    let mut built_packages = HashSet::<String>::new();
    let root = workspace_root();

    for spec in OFFICIAL_AGENTS {
        if driver_ready(&plugins_root, spec) {
            items.push(AgentDevEnsureItem {
                plugin_id: spec.plugin_id.to_string(),
                title: spec.title.to_string(),
                status: "ready".into(),
                detail: Some(
                    installed_driver_path(&plugins_root, spec.plugin_id, spec.bin_name)
                        .display()
                        .to_string(),
                ),
            });
            continue;
        }

        // 1) 优先官方下载
        match plugin_official_install(state.clone(), spec.plugin_id.to_string()).await {
            Ok(_) if driver_ready(&plugins_root, spec) => {
                need_sync = true;
                items.push(AgentDevEnsureItem {
                    plugin_id: spec.plugin_id.to_string(),
                    title: spec.title.to_string(),
                    status: "downloaded".into(),
                    detail: Some("已从官方目录安装".into()),
                });
                continue;
            }
            Ok(_) => {
                // 装上了但没有本机平台二进制（或包尚未发布），继续本地兜底
            }
            Err(err) => {
                tracing::info!(
                    target: "agent_dev",
                    plugin_id = spec.plugin_id,
                    "官方下载未成功，尝试本地编译: {err}"
                );
            }
        }

        // 2) debug：本地 cargo 兜底
        if !cfg!(debug_assertions) {
            items.push(AgentDevEnsureItem {
                plugin_id: spec.plugin_id.to_string(),
                title: spec.title.to_string(),
                status: "error".into(),
                detail: Some("官方包不可用，请稍后在插件中心重试安装".into()),
            });
            continue;
        }

        let Some(ref root) = root else {
            items.push(AgentDevEnsureItem {
                plugin_id: spec.plugin_id.to_string(),
                title: spec.title.to_string(),
                status: "error".into(),
                detail: Some("无法定位仓库根目录".into()),
            });
            continue;
        };

        // 工作区 target 里已有产物就直接挂装，避免每次启动都再起一轮 cargo 黑框
        let mut binary = find_built_binary(root, spec.bin_name);
        if binary.is_none() {
            if !built_packages.contains(spec.package_name) {
                if let Err(err) = cargo_build_agent(root, spec.package_name) {
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
            binary = find_built_binary(root, spec.bin_name);
        }

        let Some(binary) = binary else {
            items.push(AgentDevEnsureItem {
                plugin_id: spec.plugin_id.to_string(),
                title: spec.title.to_string(),
                status: "error".into(),
                detail: Some(format!(
                    "找不到已编译的 {}",
                    bin_file_name(spec.bin_name)
                )),
            });
            continue;
        };

        match stage_into_install_dir(root, &plugins_root, spec, &binary) {
            Ok(()) => {
                need_sync = true;
                items.push(AgentDevEnsureItem {
                    plugin_id: spec.plugin_id.to_string(),
                    title: spec.title.to_string(),
                    status: "built".into(),
                    detail: Some(binary.display().to_string()),
                });
            }
            Err(err) => items.push(AgentDevEnsureItem {
                plugin_id: spec.plugin_id.to_string(),
                title: spec.title.to_string(),
                status: "error".into(),
                detail: Some(err),
            }),
        }
    }

    if need_sync
        || items
            .iter()
            .any(|item| item.status == "ready" || item.status == "downloaded" || item.status == "built")
    {
        rebuild_and_sync(&state).await?;
    }

    // 3) debug：仓库内 agent 目录挂热重载（本地改动覆盖正式包）
    if cfg!(debug_assertions) {
        if let Some(ref root) = root {
            for spec in OFFICIAL_AGENTS {
                let dir = root.join("plugins").join(spec.plugin_dir);
                if !dir.join("plugin.json").is_file() {
                    continue;
                }
                match ensure_agent_dev_watch(&state, spec, &dir).await {
                    Ok(detail) => {
                        if let Some(item) = items
                            .iter_mut()
                            .find(|item| item.plugin_id == spec.plugin_id)
                        {
                            if item.status != "error" {
                                item.status = "watching".into();
                                item.detail = Some(detail);
                            }
                        } else {
                            items.push(AgentDevEnsureItem {
                                plugin_id: spec.plugin_id.to_string(),
                                title: spec.title.to_string(),
                                status: "watching".into(),
                                detail: Some(detail),
                            });
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            target: "agent_dev",
                            plugin_id = spec.plugin_id,
                            "挂热重载失败: {err}"
                        );
                    }
                }
            }
        }
    }

    Ok(AgentDevEnsureResult { items })
}

/// 把仓库 agent 目录链进 plugin_dev 并开启监听（已链则只确保 watching）。
async fn ensure_agent_dev_watch(
    state: &State<'_, AppState>,
    spec: &OfficialAgentSpec,
    dir: &Path,
) -> Result<String, OmniError> {
    let dir = fs::canonicalize(dir)
        .map_err(|e| OmniError::not_found(format!("{} ({e})", dir.display())))?;
    let dir_str = dir.to_string_lossy().into_owned();
    let mut links = load_dev_links(&state.app_handle);
    let project = links
        .iter()
        .find(|(_, link)| link.dir == dir_str || link.plugin_id == spec.plugin_id)
        .map(|(name, _)| name.clone())
        .unwrap_or_else(|| spec.plugin_dir.to_string());

    links.insert(
        project.clone(),
        DevLink {
            dir: dir_str.clone(),
            plugin_id: spec.plugin_id.to_string(),
        },
    );
    save_dev_links(&state.app_handle, &links)?;

    // install_dir_inner 内会 prepare（cargo build）再 pack 覆盖官方包
    let _ = install_dir_inner(state, &dir).await?;

    crate::commands::plugin_dev::register_watch_entry(
        &state.app_handle,
        project.clone(),
        spec.plugin_id.to_string(),
        dir.clone(),
    );

    Ok(format!("本地热重载：{project}"))
}
