//! Web 插件中心合同：列表 / 清单 / 本地安装与卸载 / 官方目录。
//!
//! download-only 云厂商不打进镜像；安装后落在 `OMNIPANEL_DATA_DIR/plugins`。
//! 官方目录远程失败时回退仓库内 `plugins/registry.json` 种子，市场列表不空。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_plugin::{PluginKind, PluginListItem, PluginSource};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::state::ServerState;

const REGISTRY_URL: &str =
    "https://github.com/OmniUltraX/omnipanel/releases/download/plugins-latest/plugin-registry.json";
const DOWNLOAD_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const BUNDLED_REGISTRY: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../plugins/registry.json"
));

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifestDto {
    pub id: String,
    pub version: String,
    pub kind: PluginKind,
    pub enabled: bool,
    pub activated: bool,
    pub source: PluginSource,
    pub manifest_json: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PluginDistribution {
    Bundled,
    Download,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct MarketplaceItem {
    pub id: String,
    pub kind: PluginKind,
    pub name: String,
    pub description: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_host_api: Option<u32>,
    pub installed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
    pub update_available: bool,
    pub source_id: String,
    pub download_size: u64,
    pub distribution: PluginDistribution,
    pub permissions: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub external_npm: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginUpdateInfo {
    pub id: String,
    pub installed_version: String,
    pub latest_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DevWatchInfo {
    pub project: String,
    pub plugin_id: String,
    pub version: String,
    pub dir: String,
    pub watching: bool,
    pub enabled: bool,
    pub activated: bool,
    pub last_reload_ms: u64,
    pub last_error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistrySourceDto {
    pub id: String,
    pub url: String,
    pub enabled: bool,
    pub pinned_keys: Vec<String>,
    pub key_pending: Option<String>,
    pub has_token: bool,
    pub builtin: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryFile {
    #[serde(default)]
    plugins: Vec<RegistryPlugin>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryVersionEntry {
    #[serde(default)]
    version: String,
    #[serde(default)]
    artifact: Option<RegistryArtifact>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryPlugin {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: Option<PluginKind>,
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    versions: Vec<RegistryVersionEntry>,
    #[serde(default)]
    distribution: Option<PluginDistribution>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryArtifact {
    #[serde(default)]
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    size: u64,
}

pub fn pkg_err_to_omni(err: omnipanel_plugin_pkg::PkgError) -> OmniError {
    use omnipanel_plugin_pkg::PkgError as E;
    match err {
        E::BadSignature | E::UnsignedRejected => {
            OmniError::new(ErrorCode::Permission, err.to_string())
        }
        other => OmniError::invalid_input(other.to_string()),
    }
}

pub async fn plugin_list(state: &ServerState) -> Result<Vec<PluginListItem>, OmniError> {
    Ok(state.plugins.list().await)
}

pub async fn plugin_manifests(state: &ServerState) -> Result<Vec<PluginManifestDto>, OmniError> {
    Ok(state.plugins.manifests().await)
}

/// DBX 可选引擎目录。Web 尚未移植桌面端完整 registry 拉取时返回空数组（合法 `T[]`）。
/// 未注册时 soft-degrade 默认是 `{}`，前端 `buildEnginePickerItems` 对 catalog `for...of` 会白屏。
pub async fn plugin_dbx_catalog(_state: &ServerState) -> Result<Vec<serde_json::Value>, OmniError> {
    Ok(Vec::new())
}

pub async fn plugin_peek_manifest(path: String) -> Result<String, OmniError> {
    let verify_path = PathBuf::from(&path);
    let manifest =
        tokio::task::spawn_blocking(move || omnipanel_plugin_pkg::verify_file_dev(&verify_path))
            .await
            .map_err(|e| OmniError::internal(e.to_string()))?
            .map_err(pkg_err_to_omni)?;
    serde_json::to_string(&manifest).map_err(|e| OmniError::internal(e.to_string()))
}

pub async fn plugin_install_from_file(
    state: &ServerState,
    path: String,
) -> Result<PluginListItem, OmniError> {
    state.plugins.install_from_path(PathBuf::from(&path)).await
}

pub async fn plugin_uninstall(state: &ServerState, plugin_id: String) -> Result<(), OmniError> {
    state.plugins.uninstall(plugin_id).await
}

pub async fn plugin_set_enabled(
    state: &ServerState,
    plugin_id: String,
    enabled: bool,
) -> Result<PluginListItem, OmniError> {
    state.plugins.set_enabled(plugin_id, enabled).await
}

pub async fn plugin_official_catalog(
    state: &ServerState,
    force: bool,
) -> Result<Vec<OfficialCatalogPlugin>, OmniError> {
    let registry = load_registry(&state.plugins.http, force).await;
    let installed: HashMap<String, String> = state
        .plugins
        .list()
        .await
        .into_iter()
        .map(|item| (item.id, item.version))
        .collect();
    Ok(to_catalog_items(&registry, &installed))
}

fn official_update_available(installed: Option<&str>, latest: &str) -> bool {
    let Some(cur) = installed.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    let latest = latest.trim();
    !latest.is_empty() && cur != latest
}

fn official_to_marketplace(plugin: OfficialCatalogPlugin) -> MarketplaceItem {
    let update_available =
        official_update_available(plugin.installed_version.as_deref(), &plugin.version);
    MarketplaceItem {
        id: plugin.id,
        kind: plugin.kind,
        name: plugin.name,
        description: plugin.description,
        version: plugin.version,
        changelog: None,
        min_host_api: None,
        installed: plugin.installed,
        installed_version: plugin.installed_version,
        update_available,
        source_id: "official".into(),
        download_size: plugin.size,
        distribution: plugin.distribution,
        permissions: plugin.permissions,
        external_npm: None,
    }
}

/// Web 市场目录：由官方目录映射为前端 `plugin_market_catalog` 形状，避免未注册命令软降级成 `{}` 让插件中心崩溃。
pub async fn plugin_market_catalog(
    state: &ServerState,
    force: bool,
) -> Result<Vec<MarketplaceItem>, OmniError> {
    let official = plugin_official_catalog(state, force).await?;
    let mut out: Vec<MarketplaceItem> = official.into_iter().map(official_to_marketplace).collect();
    out.sort_by(|a, b| {
        b.update_available
            .cmp(&a.update_available)
            .then(a.id.cmp(&b.id))
    });
    Ok(out)
}

pub async fn plugin_check_updates(
    state: &ServerState,
    force: bool,
) -> Result<Vec<PluginUpdateInfo>, OmniError> {
    let mut out: Vec<PluginUpdateInfo> = plugin_market_catalog(state, force)
        .await?
        .into_iter()
        .filter(|item| item.update_available)
        .filter_map(|item| {
            let installed = item.installed_version.as_deref()?.trim().to_string();
            if installed.is_empty() {
                return None;
            }
            Some(PluginUpdateInfo {
                id: item.id,
                installed_version: installed,
                latest_version: item.version,
                changelog: item.changelog,
                source_id: item.source_id,
            })
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

pub async fn plugin_registry_sources_list(
    _state: &ServerState,
) -> Result<Vec<RegistrySourceDto>, OmniError> {
    Ok(vec![RegistrySourceDto {
        id: "official".into(),
        url: REGISTRY_URL.to_string(),
        enabled: true,
        pinned_keys: Vec::new(),
        key_pending: None,
        has_token: false,
        builtin: true,
    }])
}

pub async fn plugin_official_install(
    state: &ServerState,
    plugin_id: String,
) -> Result<PluginListItem, OmniError> {
    let plugin_id = plugin_id.trim().to_string();
    if plugin_id.is_empty() {
        return Err(OmniError::invalid_input("缺少插件 id"));
    }
    let registry = load_registry(&state.plugins.http, true).await;
    let entry = registry
        .plugins
        .iter()
        .find(|item| item.id == plugin_id)
        .cloned()
        .ok_or_else(|| OmniError::not_found(format!("官方目录没有该插件: {plugin_id}")))?;
    if entry.distribution != Some(PluginDistribution::Download) {
        return Err(OmniError::invalid_input(format!(
            "该插件已随客户端安装，无需下载: {plugin_id}"
        )));
    }
    let artifact = entry
        .artifact
        .ok_or_else(|| OmniError::invalid_input(format!("官方目录缺少下载地址: {plugin_id}")))?;
    if artifact.url.trim().is_empty() {
        return Err(OmniError::invalid_input(format!(
            "官方目录缺少下载地址: {plugin_id}"
        )));
    }
    let bytes = download_bytes(&state.plugins.http, &artifact.url).await?;
    if !artifact.sha256.trim().is_empty() && !plugin_id.starts_with("omni.agent.") {
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
    let result = state.plugins.install_from_path(tmp.clone()).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    result
}

fn bundled_registry() -> RegistryFile {
    let mut registry: RegistryFile =
        serde_json::from_str(BUNDLED_REGISTRY).unwrap_or(RegistryFile {
            plugins: Vec::new(),
        });
    normalize_registry(&mut registry);
    registry
}

/// v2 registry entries store version/artifact under `versions[0]` and omit `distribution`.
fn normalize_registry(registry: &mut RegistryFile) {
    for plugin in &mut registry.plugins {
        if plugin.version.trim().is_empty() {
            if let Some(first) = plugin.versions.first() {
                plugin.version = first.version.clone();
                if plugin.artifact.is_none() {
                    plugin.artifact = first.artifact.clone();
                }
            }
        } else if plugin.artifact.is_none() {
            if let Some(first) = plugin.versions.first() {
                if plugin.version.trim() == first.version.trim() {
                    plugin.artifact = first.artifact.clone();
                }
            }
        }
        plugin.versions.clear();
        if plugin.artifact.is_some()
            && plugin.distribution.unwrap_or(PluginDistribution::Bundled)
                == PluginDistribution::Bundled
        {
            plugin.distribution = Some(PluginDistribution::Download);
        }
    }
}

async fn load_registry(client: &reqwest::Client, force: bool) -> RegistryFile {
    if !force {
        // 启动热路径先给种子，避免市场空白；刷新/安装再等网络。
        return bundled_registry();
    }
    match fetch_registry(client).await {
        Ok(fetched) => fetched,
        Err(_) => bundled_registry(),
    }
}

async fn fetch_registry(client: &reqwest::Client) -> Result<RegistryFile, OmniError> {
    let response = client
        .get(REGISTRY_URL)
        .header("User-Agent", "OmniPanel-web-official-catalog")
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("拉取官方插件目录失败: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "拉取官方插件目录 HTTP {}",
            response.status()
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|e| OmniError::connection(format!("读取官方插件目录失败: {e}")))?;
    let mut registry: RegistryFile = serde_json::from_str(&text)
        .map_err(|e| OmniError::invalid_input(format!("官方插件目录无法解析: {e}")))?;
    normalize_registry(&mut registry);
    Ok(registry)
}

async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, OmniError> {
    let response = client
        .get(url)
        .header("User-Agent", "OmniPanel-web-official-catalog")
        .timeout(std::time::Duration::from_secs(180))
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

fn to_catalog_items(
    registry: &RegistryFile,
    installed: &HashMap<String, String>,
) -> Vec<OfficialCatalogPlugin> {
    let mut out: Vec<OfficialCatalogPlugin> = registry
        .plugins
        .iter()
        .filter(|item| !item.id.trim().is_empty())
        .filter_map(|item| {
            let kind = item.kind?;
            let distribution = item.distribution.unwrap_or(PluginDistribution::Download);
            let installed_version = installed.get(&item.id).cloned();
            let size = item.artifact.as_ref().map(|a| a.size).unwrap_or(0);
            Some(OfficialCatalogPlugin {
                id: item.id.clone(),
                kind,
                name: if item.name.trim().is_empty() {
                    item.id.clone()
                } else {
                    item.name.clone()
                },
                description: item.description.clone(),
                version: item.version.clone(),
                distribution,
                size,
                installed: installed_version.is_some(),
                installed_version,
                permissions: item.permissions.clone(),
                created_at: item.created_at.clone(),
                updated_at: item.updated_at.clone(),
                downloads: item.downloads,
            })
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

const PLUGIN_ASSET_MAX_BYTES: u64 = 512 * 1024;

fn plugin_asset_ext_allowed(rel_path: &str) -> bool {
    Path::new(rel_path)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| {
            matches!(
                ext.to_ascii_lowercase().as_str(),
                "html" | "htm" | "css" | "txt" | "json" | "svg" | "png" | "js"
            )
        })
        .unwrap_or(false)
}

fn plugin_rel_path_ok(rel_path: &str) -> bool {
    let trimmed = rel_path.trim();
    !trimmed.is_empty()
        && !trimmed.starts_with('/')
        && !trimmed.starts_with('\\')
        && !trimmed.contains("://")
        && !trimmed.split(['/', '\\']).any(|seg| seg == "..")
}

fn encode_plugin_asset(rel_path: &str, bytes: &[u8]) -> Result<String, OmniError> {
    if bytes.len() as u64 > PLUGIN_ASSET_MAX_BYTES {
        return Err(OmniError::invalid_input("资产超过 512KB 上限"));
    }
    let lower = rel_path.to_ascii_lowercase();
    if lower.ends_with(".png") {
        use base64::Engine;
        return Ok(format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    }
    let text = String::from_utf8(bytes.to_vec())
        .map_err(|_| OmniError::invalid_input(format!("资产不是合法文本: {rel_path}")))?;
    if lower.ends_with(".svg") && text.to_ascii_lowercase().contains("<script") {
        return Err(OmniError::invalid_input("图标不得包含脚本"));
    }
    Ok(text)
}

/// 读取插件包内资产（L3 沙箱 UI / 首页图标）。仅限第一方嵌入或已安装包目录、允许扩展、≤512KB。

/// Web 无桌面会话级热重载。返回空数组，避免未注册命令被 soft-degrade 成 `{}`，
/// 导致 StudioPanel 对 `devList.filter` 抛出 `TypeError: W.filter is not a function`。
pub async fn plugin_dev_status(_state: &ServerState) -> Result<Vec<DevWatchInfo>, OmniError> {
    Ok(Vec::new())
}

pub async fn plugin_read_asset(
    _state: &ServerState,
    plugin_id: String,
    rel_path: String,
) -> Result<String, OmniError> {
    if !plugin_rel_path_ok(&rel_path) {
        return Err(OmniError::invalid_input("路径越界"));
    }
    if !plugin_asset_ext_allowed(&rel_path) {
        return Err(OmniError::invalid_input(format!(
            "不支持的资产类型: {rel_path}"
        )));
    }
    if let Some(bytes) = omnipanel_plugin::first_party_asset_bytes(&plugin_id, &rel_path) {
        return encode_plugin_asset(&rel_path, &bytes);
    }
    let root = crate::plugin_runtime::user_plugins_dir()
        .ok_or_else(|| OmniError::internal("无法定位插件安装目录"))?;
    let base = root.join(&plugin_id);
    let target = base.join(&rel_path);
    if !target.starts_with(&base) {
        return Err(OmniError::invalid_input("路径越界"));
    }
    let meta = tokio::fs::metadata(&target)
        .await
        .map_err(|_| OmniError::not_found(format!("资产不存在: {rel_path}")))?;
    if meta.len() > PLUGIN_ASSET_MAX_BYTES {
        return Err(OmniError::invalid_input("资产超过 512KB 上限"));
    }
    let bytes = tokio::fs::read(&target)
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?;
    encode_plugin_asset(&rel_path, &bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_registry_lists_aliyun_as_download_only() {
        let registry = bundled_registry();
        let aliyun = registry
            .plugins
            .iter()
            .find(|p| p.id == "omni.cloud.aliyun")
            .expect("bundled registry must list official Aliyun plugin");
        assert_eq!(aliyun.distribution, Some(PluginDistribution::Download));
        let url = aliyun
            .artifact
            .as_ref()
            .map(|a| a.url.as_str())
            .unwrap_or("");
        assert!(url.contains("plugins-latest"));
        assert!(!url.is_empty());
        let items = to_catalog_items(&registry, &HashMap::new());
        assert!(items.iter().any(|p| p.id == "omni.cloud.aliyun"
            && p.distribution == PluginDistribution::Download
            && !p.installed));
    }

    #[tokio::test]
    async fn plugin_dbx_catalog_returns_a_json_array() {
        let (_home, state) = ServerState::new_for_test();
        let list = plugin_dbx_catalog(&state).await.expect("catalog");
        let value = serde_json::to_value(&list).unwrap();
        assert!(
            value.is_array(),
            "soft-degrade of this command was {{}}, which crashed the Web DB dialog"
        );
        assert!(list.is_empty());
    }

    #[tokio::test]
    async fn plugin_read_asset_returns_first_party_resource_dedupe_ui() {
        let (_home, state) = ServerState::new_for_test();
        let code = plugin_read_asset(
            &state,
            "omni.addon.resource-dedupe".into(),
            "ui/main.js".into(),
        )
        .await
        .expect("first-party ui/main.js");
        assert!(
            code.contains("definePlugin") && code.contains("activate"),
            "unexpected ui/main.js: {code}"
        );
    }

    #[tokio::test]
    async fn plugin_read_asset_rejects_path_escape() {
        let (_home, state) = ServerState::new_for_test();
        let err = plugin_read_asset(
            &state,
            "omni.addon.resource-dedupe".into(),
            "../secret.txt".into(),
        )
        .await
        .expect_err("path escape must fail");
        assert!(
            err.to_string().contains("路径越界") || err.to_string().contains("越界"),
            "{err}"
        );
    }

    #[tokio::test]
    async fn plugin_market_catalog_returns_a_json_array() {
        let (_home, state) = ServerState::new_for_test();
        let list = plugin_market_catalog(&state, false)
            .await
            .expect("market catalog");
        let value = serde_json::to_value(&list).unwrap();
        assert!(
            value.is_array(),
            "soft-degrade of plugin_market_catalog was {{}}, which crashed PluginsPanel"
        );
        assert!(
            list.iter()
                .any(|p| p.source_id == "official" && !p.id.is_empty()),
            "official plugins should appear in the web market catalog: {list:?}"
        );
    }

    #[tokio::test]
    async fn plugin_check_updates_returns_a_json_array() {
        let (_home, state) = ServerState::new_for_test();
        let list = plugin_check_updates(&state, false).await.expect("updates");
        let value = serde_json::to_value(&list).unwrap();
        assert!(
            value.is_array(),
            "soft-degrade of plugin_check_updates must not be null/object"
        );
    }

    #[tokio::test]
    async fn plugin_registry_sources_list_includes_official() {
        let (_home, state) = ServerState::new_for_test();
        let list = plugin_registry_sources_list(&state).await.expect("sources");
        let value = serde_json::to_value(&list).unwrap();
        assert!(value.is_array());
        assert!(
            list.iter()
                .any(|s| s.id == "official" && s.builtin && s.enabled),
            "{list:?}"
        );
    }

    #[tokio::test]
    async fn plugin_dev_status_returns_a_json_array() {
        let (_home, state) = ServerState::new_for_test();
        let list = plugin_dev_status(&state).await.expect("dev status");
        let value = serde_json::to_value(&list).unwrap();
        assert!(
            value.is_array(),
            "soft-degrade of plugin_dev_status was {{}}, which crashed StudioPanel via devList.filter"
        );
        assert!(
            list.is_empty(),
            "web has no session-level dev watches: {list:?}"
        );
    }
}
