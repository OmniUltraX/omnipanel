//! 官方插件目录：GitHub `plugins-latest` 上的 plugin-registry.json。
//! 远程失败时回退仓库内第一方清单，市场列表不空。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use omnipanel_error::OmniError;
use omnipanel_plugin::{PluginKind, PluginListItem};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::{AppHandle, Emitter, State};

use crate::commands::plugin::install_plugin_from_path;
use crate::state::AppState;

const REGISTRY_URL: &str =
    "https://github.com/OmniUltraX/omnipanel/releases/download/plugins-latest/plugin-registry.json";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const SILENT_REFRESH_COOLDOWN: Duration = Duration::from_secs(15);
pub const OFFICIAL_CATALOG_UPDATED_EVENT: &str = "plugin://official-catalog-updated";
const BUNDLED_REGISTRY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../plugins/registry.json"
));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum PluginDistribution {
    Bundled,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OfficialCatalogPlugin {
    pub id: String,
    pub kind: PluginKind,
    pub name: String,
    pub description: String,
    pub version: String,
    pub distribution: PluginDistribution,
    pub size: u64,
    pub installed: bool,
    pub installed_version: Option<String>,
    pub permissions: Vec<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub downloads: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    #[serde(default)]
    schema_version: u32,
    #[serde(default)]
    plugins: Vec<RegistryPlugin>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryPlugin {
    id: String,
    kind: PluginKind,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    version: String,
    #[serde(default)]
    distribution: PluginDistribution,
    #[serde(default)]
    artifact: Option<RegistryArtifact>,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    created_at: Option<String>,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default)]
    downloads: Option<u64>,
}

impl Default for PluginDistribution {
    fn default() -> Self {
        Self::Bundled
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryArtifact {
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    size: u64,
}

fn bundled_registry() -> RegistryFile {
    serde_json::from_str(BUNDLED_REGISTRY).unwrap_or_else(|_| RegistryFile {
        schema_version: 1,
        plugins: Vec::new(),
    })
}

fn fill_first_party_gaps(registry: &mut RegistryFile) {
    let seed = bundled_registry();
    let seed_by_id: HashMap<&str, &RegistryPlugin> =
        seed.plugins.iter().map(|item| (item.id.as_str(), item)).collect();
    for plugin in &mut registry.plugins {
        if let Some(seed_item) = seed_by_id.get(plugin.id.as_str()) {
            if plugin.created_at.is_none() {
                plugin.created_at = seed_item.created_at.clone();
            }
            if plugin.updated_at.is_none() {
                plugin.updated_at = seed_item.updated_at.clone();
            }
            if plugin.downloads.is_none() {
                plugin.downloads = seed_item.downloads;
            }
        }
    }
    for manifest in omnipanel_plugin::first_party_manifests() {
        if registry.plugins.iter().any(|item| item.id == manifest.id) {
            continue;
        }
        if let Some(seed_item) = seed_by_id.get(manifest.id.as_str()) {
            registry.plugins.push((*seed_item).clone());
            continue;
        }
        registry.plugins.push(RegistryPlugin {
            id: manifest.id.clone(),
            kind: manifest.kind,
            name: manifest.id.clone(),
            description: String::new(),
            version: manifest.version.clone(),
            distribution: PluginDistribution::Bundled,
            artifact: None,
            permissions: manifest
                .permissions
                .iter()
                .map(|p| p.as_str().to_string())
                .collect(),
            created_at: None,
            updated_at: None,
            downloads: None,
        });
    }
}

fn seed_registry() -> RegistryFile {
    let mut registry = bundled_registry();
    fill_first_party_gaps(&mut registry);
    registry
}

fn to_catalog_items(
    registry: &RegistryFile,
    installed: &HashMap<String, String>,
) -> Vec<OfficialCatalogPlugin> {
    let mut out: Vec<OfficialCatalogPlugin> = registry
        .plugins
        .iter()
        .filter(|item| !item.id.trim().is_empty())
        .map(|item| {
            let installed_version = installed.get(&item.id).cloned();
            let size = item.artifact.as_ref().map(|a| a.size).unwrap_or(0);
            OfficialCatalogPlugin {
                id: item.id.clone(),
                kind: item.kind,
                name: if item.name.trim().is_empty() {
                    item.id.clone()
                } else {
                    item.name.clone()
                },
                description: item.description.clone(),
                version: item.version.clone(),
                distribution: item.distribution,
                size,
                installed: installed_version.is_some(),
                installed_version,
                permissions: item.permissions.clone(),
                created_at: item.created_at.clone(),
                updated_at: item.updated_at.clone(),
                downloads: item.downloads,
            }
        })
        .collect();
    out.sort_by(|a, b| {
        a.kind
            .as_str()
            .cmp(b.kind.as_str())
            .then(a.name.cmp(&b.name))
            .then(a.id.cmp(&b.id))
    });
    out
}

fn registry_memory() -> &'static Mutex<Option<RegistryFile>> {
    static CACHE: OnceLock<Mutex<Option<RegistryFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn registry_cache_path(plugins_root: Option<&Path>) -> Option<PathBuf> {
    Some(plugins_root?.join(".official-registry-cache.json"))
}

fn read_registry_disk(path: &Path) -> Option<RegistryFile> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_registry_disk(path: &Path, registry: &RegistryFile) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(registry) {
        let _ = fs::write(path, text);
    }
}

fn load_cached_registry(plugins_root: Option<&Path>) -> Option<RegistryFile> {
    if let Ok(guard) = registry_memory().lock() {
        if let Some(cached) = guard.as_ref() {
            return Some(cached.clone());
        }
    }
    let path = registry_cache_path(plugins_root)?;
    let disk = read_registry_disk(&path)?;
    if let Ok(mut guard) = registry_memory().lock() {
        *guard = Some(disk.clone());
    }
    Some(disk)
}

fn store_cached_registry(plugins_root: Option<&Path>, registry: &RegistryFile) {
    if let Ok(mut guard) = registry_memory().lock() {
        *guard = Some(registry.clone());
    }
    if let Some(path) = registry_cache_path(plugins_root) {
        write_registry_disk(&path, registry);
    }
}

async fn fetch_registry(client: &reqwest::Client) -> Result<RegistryFile, OmniError> {
    let response = client
        .get(REGISTRY_URL)
        .header("User-Agent", "OmniPanel-official-catalog")
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("无法拉取官方插件目录: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "官方插件目录 HTTP {}",
            response.status()
        )));
    }
    let mut registry: RegistryFile = response
        .json()
        .await
        .map_err(|e| OmniError::connection(format!("官方插件目录 JSON 非法: {e}")))?;
    fill_first_party_gaps(&mut registry);
    Ok(registry)
}

fn registry_fingerprint(registry: &RegistryFile) -> String {
    let mut keys: Vec<String> = registry
        .plugins
        .iter()
        .map(|item| format!("{}:{}", item.id, item.version))
        .collect();
    keys.sort();
    keys.join("|")
}

fn last_network_fetch() -> &'static Mutex<Option<Instant>> {
    static LAST: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

fn mark_network_fetched() {
    if let Ok(mut guard) = last_network_fetch().lock() {
        *guard = Some(Instant::now());
    }
}

fn silent_refresh_allowed() -> bool {
    match last_network_fetch().lock() {
        Ok(guard) => match *guard {
            Some(at) if at.elapsed() < SILENT_REFRESH_COOLDOWN => false,
            _ => true,
        },
        Err(_) => true,
    }
}

fn spawn_silent_registry_refresh(
    client: reqwest::Client,
    plugins_root: Option<PathBuf>,
    app: AppHandle,
) {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if !silent_refresh_allowed() {
        return;
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        if let Ok(registry) = fetch_registry(&client).await {
            mark_network_fetched();
            let before = load_cached_registry(plugins_root.as_deref())
                .as_ref()
                .map(registry_fingerprint);
            let after = registry_fingerprint(&registry);
            store_cached_registry(plugins_root.as_deref(), &registry);
            if before.as_deref() != Some(after.as_str()) {
                let _ = app.emit(OFFICIAL_CATALOG_UPDATED_EVENT, ());
            }
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

async fn registry_for_catalog(
    client: &reqwest::Client,
    plugins_root: Option<&Path>,
    force: bool,
    app: &AppHandle,
) -> RegistryFile {
    if !force {
        if let Some(mut cached) = load_cached_registry(plugins_root) {
            let before = registry_fingerprint(&cached);
            fill_first_party_gaps(&mut cached);
            if registry_fingerprint(&cached) != before {
                store_cached_registry(plugins_root, &cached);
            }
            spawn_silent_registry_refresh(
                client.clone(),
                plugins_root.map(Path::to_path_buf),
                app.clone(),
            );
            return cached;
        }
    }
    match fetch_registry(client).await {
        Ok(fetched) => {
            mark_network_fetched();
            store_cached_registry(plugins_root, &fetched);
            fetched
        }
        Err(_) => {
            if let Some(mut cached) = load_cached_registry(plugins_root) {
                fill_first_party_gaps(&mut cached);
                return cached;
            }
            seed_registry()
        }
    }
}

async fn registry_for_install(
    client: &reqwest::Client,
    plugins_root: Option<&Path>,
) -> Result<RegistryFile, OmniError> {
    match fetch_registry(client).await {
        Ok(fetched) => {
            store_cached_registry(plugins_root, &fetched);
            mark_network_fetched();
            Ok(fetched)
        }
        Err(error) => load_cached_registry(plugins_root)
            .or_else(|| Some(seed_registry()))
            .ok_or(error),
    }
}

/// 列出官方插件（内置 bundled + 可下载包）。远程失败回退仓库种子。
/// `force` 为 true 时等网络（市场「刷新」）；否则先返回缓存，后台静默拉新。
#[tauri::command]
#[specta::specta]
pub async fn plugin_official_catalog(
    app: AppHandle,
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<OfficialCatalogPlugin>, OmniError> {
    let plugins_root = state.plugin_packages_dir.clone();
    let registry =
        registry_for_catalog(&state.plugin_http, plugins_root.as_deref(), force, &app).await;
    let installed = {
        let guard = state.plugin_registry.lock().await;
        guard
            .list()
            .into_iter()
            .map(|item| (item.id, item.version))
            .collect()
    };
    Ok(to_catalog_items(&registry, &installed))
}

/// 从官方目录下载 `.omni-plugin` 并安装。bundled 条目拒绝下载。
#[tauri::command]
#[specta::specta]
pub async fn plugin_official_install(
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<PluginListItem, OmniError> {
    let plugin_id = plugin_id.trim().to_string();
    if plugin_id.is_empty() {
        return Err(OmniError::invalid_input("缺少插件 id"));
    }
    let plugins_root = state.plugin_packages_dir.clone();
    let registry = registry_for_install(&state.plugin_http, plugins_root.as_deref()).await?;
    let entry = registry
        .plugins
        .iter()
        .find(|item| item.id == plugin_id)
        .cloned()
        .ok_or_else(|| OmniError::not_found(format!("官方目录没有该插件: {plugin_id}")))?;
    if entry.distribution != PluginDistribution::Download {
        return Err(OmniError::invalid_input(format!(
            "该插件已随客户端安装，无需下载: {plugin_id}"
        )));
    }
    let artifact = entry.artifact.ok_or_else(|| {
        OmniError::invalid_input(format!("官方目录缺少下载地址: {plugin_id}"))
    })?;
    if artifact.url.trim().is_empty() {
        return Err(OmniError::invalid_input(format!(
            "官方目录缺少下载地址: {plugin_id}"
        )));
    }
    let bytes = download_bytes(&state.plugin_http, &artifact.url).await?;
    if !artifact.sha256.trim().is_empty() {
        let actual = hex::encode(Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(artifact.sha256.trim()) {
            return Err(OmniError::invalid_input(format!(
                "官方插件校验失败: {plugin_id}"
            )));
        }
    }
    let tmp = std::env::temp_dir().join(format!(
        "omni-official-{}-{}.omni-plugin",
        plugin_id.replace('.', "_"),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| OmniError::internal(format!("写入官方插件临时文件失败: {e}")))?;
    let result = install_plugin_from_path(&state, tmp.clone()).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    result
}

async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, OmniError> {
    let response = client
        .get(url)
        .header("User-Agent", "OmniPanel-official-catalog")
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("下载官方插件失败: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "下载官方插件 HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| OmniError::connection(format!("读取官方插件失败: {e}")))?;
    Ok(bytes.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_seed_covers_first_party() {
        let registry = seed_registry();
        let ids: Vec<_> = omnipanel_plugin::first_party_manifests()
            .into_iter()
            .map(|m| m.id)
            .collect();
        for id in ids {
            assert!(
                registry.plugins.iter().any(|p| p.id == id),
                "missing first-party {id}"
            );
        }
        assert!(registry.plugins.iter().all(|p| {
            p.distribution == PluginDistribution::Bundled || p.artifact.is_some()
        }));
    }

    #[test]
    fn catalog_marks_installed() {
        let registry = seed_registry();
        let mut installed = HashMap::new();
        installed.insert("omni.importer.warpgate".into(), "0.2.1".into());
        let items = to_catalog_items(&registry, &installed);
        let warpgate = items
            .iter()
            .find(|p| p.id == "omni.importer.warpgate")
            .expect("warpgate");
        assert!(warpgate.installed);
        assert_eq!(warpgate.installed_version.as_deref(), Some("0.2.1"));
        assert_eq!(warpgate.distribution, PluginDistribution::Bundled);
    }
}
