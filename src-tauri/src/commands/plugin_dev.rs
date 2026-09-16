//! 本地目录导入 + 热重载（开发期工作流）。
//!
//! 概念：**目录导入**——把任意插件源码目录（如 `plugins-market/knowledge-siyuan`）
//! 注册为工作台工程（`location = "linked"`，原地编辑不拷贝），同时安装到本机并默认
//! 开启热重载。插件中心把这类安装标注为本地开发版，市场“更新全部”会自动跳过它们。
//!
//! - `plugin_dev_import`：校验 `plugin.json` → 写链接 → dev 签名 pack 到临时包 → 复用
//!   [`super::plugin::install_plugin_from_path`]（验签/原子 swap/回滚/重建/`plugin://changed`
//!   全走正式链路）→ 注册轮询监听。
//! - `plugin_dev_watch` / `plugin_dev_unwatch` / `plugin_dev_status`：会话级热重载。
//!   tokio 轮询（1s）比对源码目录指纹，变化静置 2s 后自动重装（防保存半截包）。
//!   零新依赖；监听不落盘（重启后在工作台点一下监听即恢复），链接落盘持久。
//! - `plugin_dev_unlink_project`：只删链接 + 关监听，不动源码目录，不卸载已装插件。
//!
//! 签名说明：dev 签名公钥在官方验签列表内（`official_list_contains_dev_pubkey` 单测兜底），
//! 因此目录导入在 debug/release 均可装载；release 下同样走正式验签，无放宽。

use std::collections::HashMap;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use omnipanel_plugin::{PluginListItem, PluginManifest};
use omnipanel_plugin_pkg::{devkey::dev_signing_key, pack_dir};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

/// 变化静置多久后触发重装（防编辑器保存半截/连续保存抖动）。
const DEV_SETTLE_SECS: u64 = 2;
/// 轮询间隔。
const DEV_POLL_SECS: u64 = 1;
/// 轮询跳过的目录名（构建产物/版本库不参与指纹）。
const DEV_SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".staging"];

/// 开发期监听条目（`plugin_dev_status` 出参）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevWatchInfo {
    /// 链接工程名（工作台工程列表用；纯会话条目为空）。
    pub project: String,
    pub plugin_id: String,
    pub version: String,
    pub dir: String,
    pub watching: bool,
    pub enabled: bool,
    pub activated: bool,
    pub last_reload_ms: i64,
    pub last_error: String,
}

/// 目录导入结果：链接工程名 + 安装信息（监听已默认开启）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DevProjectInfo {
    pub project: String,
    pub plugin_id: String,
    pub version: String,
    pub dir: String,
    pub watching: bool,
}

/// 链接文件条目：工程名 → 源码目录 + 插件 id（id 变了监听循环会迁移修正）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DevLink {
    pub(crate) dir: String,
    pub(crate) plugin_id: String,
}

struct DevEntry {
    project: String,
    dir: PathBuf,
    fingerprint: u64,
    changed_at: Option<Instant>,
    watching: bool,
    last_reload_ms: i64,
    last_error: String,
}

static DEV_ENTRIES: OnceLock<Mutex<HashMap<String, DevEntry>>> = OnceLock::new();
static DEV_LOOP_STARTED: AtomicBool = AtomicBool::new(false);

fn dev_entries() -> &'static Mutex<HashMap<String, DevEntry>> {
    DEV_ENTRIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 目录指纹：相对路径 + 长度 + mtime（排序后哈希，保证稳定）。
fn fingerprint_dir(dir: &Path) -> u64 {
    fn walk(dir: &Path, base: &Path, out: &mut Vec<(String, u64, u64)>) {
        let entries = match std::fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let mut sorted: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        sorted.sort_by_key(|e| e.file_name());
        for entry in sorted {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if DEV_SKIP_DIRS.contains(&name.as_str()) {
                    continue;
                }
                walk(&path, base, out);
                continue;
            }
            let rel = path
                .strip_prefix(base)
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or(name);
            let (len, mtime) = match entry.metadata() {
                Ok(m) => (
                    m.len(),
                    m.modified()
                        .ok()
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_nanos() as u64)
                        .unwrap_or(0),
                ),
                Err(_) => (0, 0),
            };
            out.push((rel, len, mtime));
        }
    }

    let mut items = Vec::new();
    walk(dir, dir, &mut items);
    let mut hasher = DefaultHasher::new();
    items.hash(&mut hasher);
    hasher.finish()
}

/// 读目录清单并校验（复用 Studio 同款规则）。
fn read_dev_manifest(dir: &Path) -> Result<PluginManifest, OmniError> {
    let text = std::fs::read_to_string(dir.join("plugin.json"))
        .map_err(|_| OmniError::not_found(format!("目录缺少 plugin.json: {}", dir.display())))?;
    let manifest = PluginManifest::from_json(&text)
        .map_err(|e| OmniError::invalid_input(format!("plugin.json 无效: {e}")))?;
    manifest
        .validate()
        .map_err(|e| OmniError::invalid_input(format!("清单校验失败: {e}")))?;
    if manifest.id.trim().is_empty() {
        return Err(OmniError::invalid_input("清单 id 为空"));
    }
    Ok(manifest)
}

/// dev 签名 pack 到临时包（调用方负责删除）。
async fn pack_dev_dir(dir: &Path) -> Result<PathBuf, OmniError> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || {
        let out = std::env::temp_dir().join(format!(
            "omni-devdir-{}-{}.omni-plugin",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        pack_dir(&dir, &out, Some(&dev_signing_key()))
            .map_err(|e| OmniError::internal(format!("打包失败: {e}")))?;
        Ok::<_, OmniError>(out)
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))?
}

/// 链接文件：`app_data/plugin-dev-links.json`，工程名 → 源码目录（重启持久）。
fn dev_links_path(app: &AppHandle) -> Result<PathBuf, OmniError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| OmniError::internal(format!("无法定位应用数据目录: {e}")))?
        .join("plugin-dev-links.json"))
}

/// 读链接表（文件缺失/损坏按空表处理，不阻断）。
pub(crate) fn load_dev_links(app: &AppHandle) -> HashMap<String, DevLink> {
    dev_links_path(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(crate) fn save_dev_links(app: &AppHandle, links: &HashMap<String, DevLink>) -> Result<(), OmniError> {
    let path = dev_links_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| OmniError::internal(e.to_string()))?;
    }
    let text = serde_json::to_string_pretty(links).map_err(|e| OmniError::internal(e.to_string()))?;
    std::fs::write(&path, text).map_err(|e| OmniError::internal(e.to_string()))?;
    Ok(())
}

/// 链接工程名对应的源码目录（工作台读写禁锢用）。
pub(crate) fn linked_project_dir(app: &AppHandle, name: &str) -> Option<PathBuf> {
    let link = load_dev_links(app).get(name)?.dir.clone();
    let dir = PathBuf::from(link);
    dir.is_dir().then_some(dir)
}

/// 供市场“更新全部”跳过本地开发版（读链接表，重启后依然有效）。
pub(crate) fn dev_linked_plugin_ids(app: &AppHandle) -> std::collections::HashSet<String> {
    load_dev_links(app)
        .into_values()
        .map(|link| link.plugin_id)
        .filter(|id| !id.trim().is_empty())
        .collect()
}

/// 目录安装内核：pack → 正式安装链路 → 清临时包。
pub(crate) async fn install_dir_inner(
    state: &State<'_, AppState>,
    dir: &Path,
) -> Result<PluginListItem, OmniError> {
    read_dev_manifest(dir)?;
    let pkg = pack_dev_dir(dir).await?;
    let ret = super::plugin::install_plugin_from_path(state, pkg.clone()).await;
    let _ = tokio::fs::remove_file(&pkg).await;
    ret
}

/// 由源码目录名派生链接工程名（与现有 user/repo/链接工程去重）。
fn unique_link_name(
    app: &AppHandle,
    dir: &Path,
    links: &HashMap<String, DevLink>,
) -> Result<String, OmniError> {
    let base = dir
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .ok_or_else(|| OmniError::invalid_input("目录名非法，无法建工程"))?;
    // 工程名禁锢与工作台一致：不含路径分隔与上级引用。
    if base.contains(['/', '\\']) || base.contains("..") || base.contains(':') {
        return Err(OmniError::invalid_input(format!("目录名不适合做工程名: {base}")));
    }
    let taken = |name: &str| -> bool {
        if links.contains_key(name) {
            return true;
        }
        let Ok(roots) = super::plugin_studio::studio_roots(app) else {
            return false;
        };
        roots.user.join(name).exists()
            || roots
                .repo
                .as_ref()
                .is_some_and(|repo| repo.join(name).exists())
    };
    if !taken(base) {
        return Ok(base.to_string());
    }
    for i in 2..100 {
        let candidate = format!("{base}-{i}");
        if !taken(&candidate) {
            return Ok(candidate);
        }
    }
    Err(OmniError::invalid_input(format!("工程名冲突过多: {base}")))
}

/// 目录导入：注册为工作台链接工程（原地编辑）+ 安装到本机 + 默认开启热重载。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dev_import(
    state: State<'_, AppState>,
    path: String,
) -> Result<DevProjectInfo, OmniError> {
    let dir = std::fs::canonicalize(Path::new(&path))
        .map_err(|e| OmniError::not_found(format!("目录不存在: {path} ({e})")))?;
    let manifest = read_dev_manifest(&dir)?;
    let mut links = load_dev_links(&state.app_handle);
    let project = unique_link_name(&state.app_handle, &dir, &links)?;
    links.insert(
        project.clone(),
        DevLink {
            dir: dir.to_string_lossy().into_owned(),
            plugin_id: manifest.id.clone(),
        },
    );
    save_dev_links(&state.app_handle, &links)?;
    let item = install_dir_inner(&state, &dir).await?;
    if let Ok(mut map) = dev_entries().lock() {
        map.insert(
            item.id.clone(),
            DevEntry {
                project: project.clone(),
                dir: dir.clone(),
                fingerprint: fingerprint_dir(&dir),
                changed_at: None,
                watching: true,
                last_reload_ms: now_ms(),
                last_error: String::new(),
            },
        );
    }
    ensure_dev_loop(&state.app_handle);
    Ok(DevProjectInfo {
        project,
        plugin_id: item.id,
        version: item.version,
        dir: dir.to_string_lossy().into_owned(),
        watching: true,
    })
}

/// 监听内核：链接（user/repo 工程也会建同名链接，驱动徽标与更新保护）
/// → 安装 → 注册轮询。
async fn watch_inner(
    state: &State<'_, AppState>,
    project: String,
    dir: &Path,
) -> Result<DevWatchInfo, OmniError> {
    let manifest = read_dev_manifest(dir)?;
    let mut links = load_dev_links(&state.app_handle);
    links.insert(
        project.clone(),
        DevLink {
            dir: dir.to_string_lossy().into_owned(),
            plugin_id: manifest.id.clone(),
        },
    );
    let _ = save_dev_links(&state.app_handle, &links);
    let item = install_dir_inner(state, dir).await?;
    if let Ok(mut map) = dev_entries().lock() {
        map.insert(
            item.id.clone(),
            DevEntry {
                project: project.clone(),
                dir: dir.to_path_buf(),
                fingerprint: fingerprint_dir(dir),
                changed_at: None,
                watching: true,
                last_reload_ms: now_ms(),
                last_error: String::new(),
            },
        );
    }
    ensure_dev_loop(&state.app_handle);
    dev_status_inner(state, &item.id)
        .await
        .ok_or_else(|| OmniError::not_found(format!("未知插件: {}", item.id)))
}

/// 开启热重载：先装一次当前内容，再注册轮询监听（未链接的目录顺手建链接）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dev_watch(
    state: State<'_, AppState>,
    path: String,
) -> Result<DevWatchInfo, OmniError> {
    let dir = std::fs::canonicalize(Path::new(&path))
        .map_err(|e| OmniError::not_found(format!("目录不存在: {path} ({e})")))?;
    let manifest = read_dev_manifest(&dir)?;
    let links = load_dev_links(&state.app_handle);
    // 已链接该目录的工程名优先复用，否则新建。
    let dir_str = dir.to_string_lossy().into_owned();
    let project = links
        .iter()
        .find(|(_, link)| link.dir == dir_str)
        .map(|(name, _)| name.clone())
        .unwrap_or_else(|| {
            unique_link_name(&state.app_handle, &dir, &links).unwrap_or_else(|_| manifest.id.clone())
        });
    watch_inner(&state, project, &dir).await
}

/// 按工作台工程名开启热重载（user/repo/linked 通吃，目录由工作台解析）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dev_watch_project(
    state: State<'_, AppState>,
    project: String,
) -> Result<DevWatchInfo, OmniError> {
    let name = project.trim().to_string();
    let roots = super::plugin_studio::studio_roots(&state.app_handle)?;
    let dir = super::plugin_studio::resolve_project_dir_linked(&state.app_handle, &roots, &name)?;
    if !dir.is_dir() {
        return Err(OmniError::not_found(format!("工程不存在: {name}")));
    }
    watch_inner(&state, name, &dir).await
}

/// 关闭指定插件的热重载（保留链接，可再次开启）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dev_unwatch(plugin_id: String) -> Result<bool, OmniError> {
    let removed = dev_entries()
        .lock()
        .map(|mut map| {
            if let Some(entry) = map.get_mut(&plugin_id) {
                let was = entry.watching;
                entry.watching = false;
                entry.changed_at = None;
                was
            } else {
                false
            }
        })
        .unwrap_or(false);
    Ok(removed)
}

/// 取消链接：删链接 + 关监听，不动源码目录，不卸载已装插件。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dev_unlink_project(
    state: State<'_, AppState>,
    project: String,
) -> Result<String, OmniError> {
    unlink_project(&state.app_handle, &project)
}

/// 取消链接内核（工作台删除链接工程时复用）。
pub(crate) fn unlink_project(app: &AppHandle, project: &str) -> Result<String, OmniError> {
    let mut links = load_dev_links(app);
    let Some(link) = links.remove(project.trim()) else {
        return Err(OmniError::not_found(format!("未链接的工程: {project}")));
    };
    let _ = save_dev_links(app, &links);
    if let Ok(mut map) = dev_entries().lock() {
        map.remove(&link.plugin_id);
        // 监听键可能已随改 id 迁移：按目录兜底清掉。
        map.retain(|_, entry| entry.dir.to_string_lossy() != link.dir);
    }
    Ok(link.plugin_id)
}

/// 开发期条目一览：会话监听 ∪ 已链接（重启后链接仍在，监听可一键恢复）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dev_status(
    state: State<'_, AppState>,
) -> Result<Vec<DevWatchInfo>, OmniError> {
    let registry = state.plugin_registry.lock().await;
    let states: HashMap<String, (bool, bool, String)> = registry
        .list()
        .into_iter()
        .map(|item| {
            (
                item.id.clone(),
                (
                    item.enabled,
                    item.activated,
                    registry
                        .get(&item.id)
                        .map(|e| e.manifest.version.clone())
                        .unwrap_or_default(),
                ),
            )
        })
        .collect();
    drop(registry);
    let map = dev_entries().lock().unwrap();
    let mut out: Vec<DevWatchInfo> = Vec::new();
    let mut covered_dirs: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (id, entry) in map.iter() {
        covered_dirs.insert(entry.dir.to_string_lossy().into_owned());
        let (enabled, activated, version) = states
            .get(id)
            .cloned()
            .unwrap_or((false, false, String::new()));
        out.push(DevWatchInfo {
            project: entry.project.clone(),
            plugin_id: id.clone(),
            version,
            dir: entry.dir.to_string_lossy().into_owned(),
            watching: entry.watching,
            enabled,
            activated,
            last_reload_ms: entry.last_reload_ms,
            last_error: entry.last_error.clone(),
        });
    }
    // 已链接但本会话未监听：补一行 watching=false，工作台可一键恢复。
    for (name, link) in load_dev_links(&state.app_handle) {
        if covered_dirs.contains(&link.dir) {
            continue;
        }
        let dir = PathBuf::from(&link.dir);
        if !dir.is_dir() {
            continue;
        }
        let (enabled, activated, version) = states
            .get(&link.plugin_id)
            .cloned()
            .unwrap_or((false, false, String::new()));
        out.push(DevWatchInfo {
            project: name,
            plugin_id: link.plugin_id,
            version,
            dir: link.dir,
            watching: false,
            enabled,
            activated,
            last_reload_ms: 0,
            last_error: String::new(),
        });
    }
    out.sort_by(|a, b| a.plugin_id.cmp(&b.plugin_id));
    Ok(out)
}

async fn dev_status_inner(state: &State<'_, AppState>, plugin_id: &str) -> Option<DevWatchInfo> {
    let registry = state.plugin_registry.lock().await;
    let map = dev_entries().lock().ok()?;
    let entry = map.get(plugin_id)?;
    let (enabled, activated, version) = registry
        .list()
        .into_iter()
        .find(|item| item.id == plugin_id)
        .map(|item| {
            (
                item.enabled,
                item.activated,
                registry
                    .get(&item.id)
                    .map(|e| e.manifest.version.clone())
                    .unwrap_or_default(),
            )
        })
        .unwrap_or((false, false, String::new()));
    Some(DevWatchInfo {
        project: entry.project.clone(),
        plugin_id: plugin_id.to_string(),
        version,
        dir: entry.dir.to_string_lossy().into_owned(),
        watching: entry.watching,
        enabled,
        activated,
        last_reload_ms: entry.last_reload_ms,
        last_error: entry.last_error.clone(),
    })
}

fn ensure_dev_loop(app: &AppHandle) {
    if DEV_LOOP_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval =
            tokio::time::interval(Duration::from_secs(DEV_POLL_SECS));
        loop {
            interval.tick().await;
            dev_tick(&app).await;
        }
    });
}

/// 单轮轮询：指纹变化且静置达标才重装；失败记错不摘除（下次保存再触发重试）。
async fn dev_tick(app: &AppHandle) {
    let snapshot: Vec<(String, PathBuf)> = match dev_entries().lock() {
        Ok(map) => map
            .iter()
            .filter(|(_, e)| e.watching)
            .map(|(id, e)| (id.clone(), e.dir.clone()))
            .collect(),
        Err(_) => return,
    };
    for (id, dir) in snapshot {
        let fingerprint = fingerprint_dir(&dir);
        let action = match dev_entries().lock() {
            Ok(mut map) => match map.get_mut(&id) {
                Some(entry) if !entry.watching => None,
                Some(entry) if entry.fingerprint == fingerprint => {
                    entry.changed_at = None;
                    None
                }
                Some(entry) => match entry.changed_at {
                    None => {
                        entry.changed_at = Some(Instant::now());
                        None
                    }
                    Some(t) if Instant::now().duration_since(t)
                        >= Duration::from_secs(DEV_SETTLE_SECS) =>
                    {
                        entry.changed_at = None;
                        entry.fingerprint = fingerprint;
                        Some(entry.dir.clone())
                    }
                    _ => None,
                },
                None => None,
            },
            Err(_) => None,
        };
        let Some(dir) = action else { continue };
        let state: State<'_, AppState> = app.state::<AppState>();
        match install_dir_inner(&state, &dir).await {
            Ok(item) => {
                if let Ok(mut map) = dev_entries().lock() {
                    // 极端情况：开发中改了 plugin.json 的 id，键与链接随之迁移。
                    if item.id != id {
                        if let Some(entry) = map.remove(&id) {
                            map.insert(item.id.clone(), entry);
                        }
                        let mut links = load_dev_links(app);
                        let dir_str = dir.to_string_lossy().into_owned();
                        let mut touched = false;
                        for link in links.values_mut() {
                            if link.dir == dir_str && link.plugin_id != item.id {
                                link.plugin_id = item.id.clone();
                                touched = true;
                            }
                        }
                        if touched {
                            let _ = save_dev_links(app, &links);
                        }
                    }
                    if let Some(entry) = map.get_mut(&item.id) {
                        entry.fingerprint = fingerprint_dir(&entry.dir.clone());
                        entry.last_reload_ms = now_ms();
                        entry.last_error.clear();
                    }
                }
            }
            Err(err) => {
                if let Ok(mut map) = dev_entries().lock() {
                    if let Some(entry) = map.get_mut(&id) {
                        entry.last_reload_ms = now_ms();
                        entry.last_error = err.to_string();
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "omni-dev-test-{name}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn fingerprint_stable_and_detects_change() {
        let dir = unique_temp("fp");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("plugin.json"), "{}").unwrap();
        let base = fingerprint_dir(&dir);
        assert_eq!(base, fingerprint_dir(&dir));
        // 版本库目录不参与指纹
        std::fs::create_dir_all(dir.join(".git")).unwrap();
        std::fs::write(dir.join(".git").join("x"), "y").unwrap();
        assert_eq!(base, fingerprint_dir(&dir));
        // 内容变化被感知（长度不同即不同，与 mtime 粒度无关）
        std::fs::write(dir.join("plugin.json"), "{\"a\":1}").unwrap();
        assert_ne!(base, fingerprint_dir(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn dev_manifest_rejects_bad_dir() {
        let dir = unique_temp("bad");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_dev_manifest(&dir).is_err());
        std::fs::write(dir.join("plugin.json"), "{not json").unwrap();
        assert!(read_dev_manifest(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
