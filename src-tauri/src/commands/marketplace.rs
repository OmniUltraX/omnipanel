//! marketplace part 1/3: DTOs, internal model, fetch/merge/install helpers.
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;

use omnipanel_error::OmniError;
use omnipanel_plugin::{
    HOST_API_VERSION, PluginDependencyDecl, PluginKind, PluginListItem, VersionEntry,
    DependencyReq, resolve_install, update_available,
};
use omnipanel_plugin_pkg::{
    OFFICIAL_VERIFY_PUBKEYS_HEX, RegistryFile, hex_to_verifying_key, parse_registry,
    verify_registry,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::State;

use crate::commands::plugin::{install_plugin_from_path, pkg_err_to_omni};
use crate::state::AppState;

pub(crate) const OFFICIAL_SOURCE_ID: &str = "official";
pub(crate) const OFFICIAL_REGISTRY_URL: &str =
    "https://github.com/OmniUltraX/omnipanel/releases/download/plugins-latest/plugin-registry.json";
const FETCH_TIMEOUT_SECS: u64 = 30;
const DOWNLOAD_TIMEOUT_SECS: u64 = 180;

fn token_ref(source_id: &str) -> String {
    format!("registry:{source_id}:token")
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePlanItem {
    pub id: String,
    pub version: String,
    pub action: String,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ResolvePlan {
    pub items: Vec<ResolvePlanItem>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub id: String,
    pub installed_version: String,
    pub latest_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changelog: Option<String>,
    pub source_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateResultItem {
    pub id: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SourceTestResult {
    pub ok: bool,
    pub plugin_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct SourceCfg {
    id: String,
    url: String,
    enabled: bool,
    pinned: Vec<String>,
    token: Option<String>,
    builtin: bool,
}

#[derive(Debug, Clone)]
struct MergedVersion {
    version: semver::Version,
    changelog: Option<String>,
    min_host_api: u32,
    url: String,
    sha256: String,
    size: u64,
    dependencies: Vec<PluginDependencyDecl>,
}

#[derive(Debug, Clone)]
struct MergedPlugin {
    id: String,
    kind: PluginKind,
    name: String,
    description: String,
    source_id: String,
    permissions: Vec<String>,
    versions: Vec<MergedVersion>,
}

fn sanitize_cache_id(id: &str) -> Option<String> {
    if id.trim().is_empty() {
        return None;
    }
    let clean: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if clean.trim().is_empty() {
        None
    } else {
        Some(clean)
    }
}

fn cache_path(plugins_root: Option<&std::path::Path>, source_id: &str) -> Option<PathBuf> {
    let root = plugins_root?;
    let safe = sanitize_cache_id(source_id)?;
    Some(root.join(format!(".market-registry-{safe}.json")))
}

fn official_keys() -> Vec<ed25519_dalek::VerifyingKey> {
    OFFICIAL_VERIFY_PUBKEYS_HEX
        .iter()
        .filter_map(|hex| hex_to_verifying_key(hex))
        .collect()
}

fn load_source_cfgs(
    storage: &tokio::sync::MutexGuard<omnipanel_store::Storage>,
    ensure_official: bool,
) -> Result<Vec<SourceCfg>, OmniError> {
    if ensure_official {
        storage.registry_source_ensure_builtin(OFFICIAL_SOURCE_ID, OFFICIAL_REGISTRY_URL)?;
    }
    let mut out = Vec::new();
    for row in storage.registry_sources_list()? {
        let token = if row.auth_ref.trim().is_empty() {
            None
        } else {
            omnipanel_store::Vault::get(&token_ref(&row.id)).ok()
        };
        out.push(SourceCfg {
            id: row.id,
            url: row.url,
            enabled: row.enabled,
            pinned: row.pinned_keys,
            token,
            builtin: row.builtin,
        });
    }
    out.sort_by(|a, b| (!a.builtin).cmp(&(!b.builtin)).then(a.id.cmp(&b.id)));
    Ok(out)
}

async fn fetch_source(
    client: &reqwest::Client,
    cfg: &SourceCfg,
    plugins_root: Option<&std::path::Path>,
) -> Result<(RegistryFile, Option<String>), OmniError> {
    let mut req = client
        .get(cfg.url.clone())
        .header("User-Agent", "OmniPanel-marketplace")
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS));
    if let Some(token) = cfg.token.as_deref().filter(|t| !t.trim().is_empty()) {
        req = req.bearer_auth(token.trim());
    }
    let response = req
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("fetch source {} failed: {e}", cfg.id)))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(OmniError::connection(format!(
            "source auth failed {} (HTTP {}), check token",
            cfg.id,
            response.status()
        )));
    }
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "source HTTP {} {}",
            response.status(),
            cfg.id
        )));
    }
    let text = response
        .text()
        .await
        .map_err(|e| OmniError::connection(format!("read source {} failed: {e}", cfg.id)))?;
    let file =
        parse_registry(&text).map_err(|e| OmniError::invalid_input(format!("parse source: {e}")))?;

    let pin_keys: Vec<ed25519_dalek::VerifyingKey> = if cfg.builtin {
        official_keys()
    } else {
        cfg.pinned
            .iter()
            .filter_map(|hex| hex_to_verifying_key(hex))
            .collect()
    };
    if !pin_keys.is_empty() {
        verify_registry(&file, &pin_keys).map_err(|e| {
            OmniError::invalid_input(format!(
                "verify source {} failed: {e}; rotation suspected, use confirm flow",
                cfg.id
            ))
        })?;
        write_source_cache(plugins_root, &cfg.id, &text);
        return Ok((file, None));
    }
    match file.publisher_key.clone().unwrap_or_default() {
        pubkey if !pubkey.trim().is_empty() => {
            let pubkey = pubkey.trim().to_string();
            let key = hex_to_verifying_key(&pubkey).ok_or_else(|| {
                OmniError::invalid_input(format!("source publisher key invalid {}", cfg.id))
            })?;
            verify_registry(&file, &[key])
                .map_err(|e| OmniError::invalid_input(format!("verify source {} failed: {e}", cfg.id)))?;
            write_source_cache(plugins_root, &cfg.id, &text);
            Ok((file, Some(pubkey)))
        }
        _ => Err(OmniError::invalid_input(format!(
            "source {} has no pinned key: provide public key or ensure registry carries publisherKey (TOFU)",
            cfg.id
        ))),
    }
}

fn write_source_cache(
    plugins_root: Option<&std::path::Path>,
    source_id: &str,
    text: &str,
) {
    if let Some(path) = cache_path(plugins_root, source_id) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, text);
    }
}

fn read_source_cache(
    plugins_root: Option<&std::path::Path>,
    source_id: &str,
) -> Option<RegistryFile> {
    let path = cache_path(plugins_root, source_id)?;
    let text = std::fs::read_to_string(path).ok()?;
    parse_registry(&text).ok()
}

fn merge_registries(files: Vec<(String, RegistryFile)>) -> BTreeMap<String, MergedPlugin> {
    let mut out: BTreeMap<String, MergedPlugin> = BTreeMap::new();
    for (source_id, file) in files {
        for plugin in file.plugins {
            if plugin.id.trim().is_empty() || out.contains_key(&plugin.id) {
                continue;
            }
            let mut versions = Vec::new();
            for ver in plugin.versions {
                let Ok(version) = ver.version.trim().parse::<semver::Version>() else {
                    continue;
                };
                versions.push(MergedVersion {
                    version,
                    changelog: ver.changelog,
                    min_host_api: ver.min_host_api.unwrap_or(1),
                    url: ver.artifact.as_ref().map(|a| a.url.clone()).unwrap_or_default(),
                    sha256: ver.artifact.as_ref().map(|a| a.sha256.clone()).unwrap_or_default(),
                    size: ver.artifact.as_ref().map(|a| a.size).unwrap_or(0),
                    dependencies: ver.dependencies,
                });
            }
            if versions.is_empty() {
                continue;
            }
            versions.sort_by(|a, b| a.version.cmp(&b.version));
            let kind = PluginKind::parse(&plugin.kind).unwrap_or(PluginKind::Addon);
            let name = if plugin.name.trim().is_empty() {
                plugin.id.clone()
            } else {
                plugin.name.clone()
            };
            out.insert(
                plugin.id.clone(),
                MergedPlugin {
                    id: plugin.id,
                    kind,
                    name,
                    description: plugin.description,
                    source_id: source_id.clone(),
                    permissions: Vec::new(),
                    versions,
                },
            );
        }
    }
    out
}

fn to_resolver_entries(
    versions: &[MergedVersion],
) -> Vec<VersionEntry> {
    versions
        .iter()
        .map(|v| VersionEntry {
            version: v.version.clone(),
            min_host_api: v.min_host_api,
            dependencies: v
                .dependencies
                .iter()
                .map(|d| DependencyReq {
                    id: d.id.clone(),
                    req: d.version_req.clone(),
                })
                .collect(),
        })
        .collect()
}

fn to_resolver_index(
    merged: &BTreeMap<String, MergedPlugin>,
) -> HashMap<String, Vec<VersionEntry>> {
    merged
        .iter()
        .map(|(id, plugin)| {
            (
                id.clone(),
                plugin
                    .versions
                    .iter()
                    .map(|v| VersionEntry {
                        version: v.version.clone(),
                        min_host_api: v.min_host_api,
                        dependencies: v
                            .dependencies
                            .iter()
                            .map(|d| DependencyReq {
                                id: d.id.clone(),
                                req: d.version_req.clone(),
                            })
                            .collect(),
                    })
                    .collect(),
            )
        })
        .collect()
}

fn installed_map(
    registry: &omnipanel_plugin::PluginRegistry,
) -> (HashMap<String, String>, HashMap<String, semver::Version>) {
    let mut raw = HashMap::new();
    let mut parsed = HashMap::new();
    for item in registry.list() {
        raw.insert(item.id.clone(), item.version.clone());
        if let Ok(v) = item.version.trim().parse::<semver::Version>() {
            parsed.insert(item.id, v);
        }
    }
    (raw, parsed)
}

async fn download_bytes(client: &reqwest::Client, url: &str, plugin_id: &str) -> Result<Vec<u8>, OmniError> {
    let response = client
        .get(url)
        .header("User-Agent", "OmniPanel-marketplace")
        .timeout(std::time::Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("download {plugin_id} failed: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "download HTTP {} {plugin_id}",
            response.status()
        )));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| OmniError::connection(format!("read download {plugin_id} failed: {e}")))
}

async fn install_merged_version(
    state: &State<'_, AppState>,
    plugin: &MergedPlugin,
    version: &semver::Version,
) -> Result<PluginListItem, OmniError> {
    let entry = plugin
        .versions
        .iter()
        .find(|v| &v.version == version)
        .ok_or_else(|| OmniError::not_found(format!("version not in source: {} {version}", plugin.id)))?;
    if entry.url.trim().is_empty() {
        return Err(OmniError::invalid_input(format!(
            "version has no downloadable artifact (bundled): {}",
            plugin.id
        )));
    }
    if entry.min_host_api > HOST_API_VERSION {
        return Err(OmniError::invalid_input(format!(
            "{} {version} needs newer host (minHostApi {})",
            plugin.id, entry.min_host_api
        )));
    }
    let bytes = download_bytes(&state.plugin_http, entry.url.trim(), &plugin.id).await?;
    if !entry.sha256.trim().is_empty() {
        let actual = hex::encode(Sha256::digest(&bytes));
        if !actual.eq_ignore_ascii_case(entry.sha256.trim()) {
            return Err(OmniError::invalid_input(format!(
                "download checksum mismatch: {}",
                plugin.id
            )));
        }
    }
    let tmp = std::env::temp_dir().join(format!(
        "omni-market-{}-{}-{}.omni-plugin",
        plugin.id.replace('.', "_"),
        version,
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    tokio::fs::write(&tmp, &bytes)
        .await
        .map_err(|e| OmniError::internal(format!("write temp file failed: {e}")))?;
    let result = install_plugin_from_path(state, tmp.clone()).await;
    let _ = tokio::fs::remove_file(&tmp).await;
    result
}
async fn merged_view(
    state: &State<'_, AppState>,
    refresh: bool,
) -> Result<(BTreeMap<String, MergedPlugin>, Vec<String>), OmniError> {
    let plugins_root = state.plugin_packages_dir.clone();
    let cfgs = {
        let storage = state.storage.lock().await;
        load_source_cfgs(&storage, true)?
    };
    let mut files: Vec<(String, RegistryFile)> = Vec::new();
    let mut errors = Vec::new();
    for cfg in cfgs.iter().filter(|c| c.enabled) {
        let cached = read_source_cache(plugins_root.as_deref(), &cfg.id);
        if !refresh {
            if let Some(file) = cached {
                files.push((cfg.id.clone(), file));
                continue;
            }
        }
        match fetch_source(&state.plugin_http, cfg, plugins_root.as_deref()).await {
            Ok((file, tofued)) => {
                if let Some(key) = tofued {
                    let storage = state.storage.lock().await;
                    let _ = storage.registry_source_set_pinned(&cfg.id, &[key]);
                }
                files.push((cfg.id.clone(), file));
            }
            Err(err) => {
                if let Some(file) = read_source_cache(plugins_root.as_deref(), &cfg.id) {
                    files.push((cfg.id.clone(), file));
                }
                errors.push(format!("{}: {err}", cfg.id));
            }
        }
    }
    if files.is_empty() {
        return Err(OmniError::connection(format!(
            "all sources unavailable{}",
            if errors.is_empty() {
                String::new()
            } else {
                format!(": {}", errors.join("; "))
            }
        )));
    }
    Ok((merge_registries(files), errors))
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_registry_sources_list(
    state: State<'_, AppState>,
) -> Result<Vec<RegistrySourceDto>, OmniError> {
    let storage = state.storage.lock().await;
    storage.registry_source_ensure_builtin(OFFICIAL_SOURCE_ID, OFFICIAL_REGISTRY_URL)?;
    Ok(storage
        .registry_sources_list()?
        .into_iter()
        .map(|row| RegistrySourceDto {
            id: row.id,
            url: row.url,
            enabled: row.enabled,
            pinned_keys: row.pinned_keys,
            key_pending: if row.key_pending.trim().is_empty() {
                None
            } else {
                Some(row.key_pending)
            },
            has_token: !row.auth_ref.trim().is_empty(),
            builtin: row.builtin,
        })
        .collect())
}

fn validate_source_id(id: &str) -> Result<(), OmniError> {
    let id = id.trim();
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(OmniError::invalid_input(
            "bad source id (letters/digits/-/_ only)",
        ));
    }
    if id == OFFICIAL_SOURCE_ID {
        return Err(OmniError::invalid_input("official source id is reserved"));
    }
    Ok(())
}

fn validate_url(url: &str) -> Result<(), OmniError> {
    let url = url.trim();
    if !(url.starts_with("https://") || url.starts_with("http://localhost")) {
        return Err(OmniError::invalid_input(
            "bad source url (https only, http://localhost for dev)",
        ));
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_registry_source_add(
    state: State<'_, AppState>,
    id: String,
    url: String,
    public_keys: Vec<String>,
    token: Option<String>,
) -> Result<RegistrySourceDto, OmniError> {
    validate_source_id(&id)?;
    validate_url(&url)?;
    let mut keys = Vec::new();
    for key in &public_keys {
        hex_to_verifying_key(key).ok_or_else(|| {
            OmniError::invalid_input(format!(
                "bad public key: {}",
                key.chars().take(16).collect::<String>()
            ))
        })?;
        keys.push(key.trim().to_string());
    }
    let auth_ref = match token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(secret) => {
            let reference = token_ref(id.trim());
            omnipanel_store::Vault::store(&reference, secret)?;
            reference
        }
        None => String::new(),
    };
    {
        let storage = state.storage.lock().await;
        storage.registry_source_upsert(id.trim(), url.trim(), &keys, &auth_ref)?;
        let row = storage
            .registry_sources_list()?
            .into_iter()
            .find(|r| r.id == id.trim())
            .ok_or_else(|| OmniError::internal("source lost after write"))?;
        Ok(RegistrySourceDto {
            id: row.id,
            url: row.url,
            enabled: row.enabled,
            pinned_keys: row.pinned_keys,
            key_pending: None,
            has_token: !row.auth_ref.trim().is_empty(),
            builtin: row.builtin,
        })
    }
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_registry_source_remove(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), OmniError> {
    {
        let storage = state.storage.lock().await;
        storage.registry_source_delete(id.trim())?;
    }
    let _ = omnipanel_store::Vault::delete(&token_ref(id.trim()));
    if let Some(root) = state.plugin_packages_dir.clone() {
        if let Some(path) = cache_path(Some(&root), id.trim()) {
            let _ = std::fs::remove_file(path);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_registry_source_set_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.registry_source_set_enabled(id.trim(), enabled)
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_registry_source_set_token(
    state: State<'_, AppState>,
    id: String,
    token: String,
) -> Result<(), OmniError> {
    let id = id.trim().to_string();
    let storage = state.storage.lock().await;
    let row = storage
        .registry_sources_list()?
        .into_iter()
        .find(|r| r.id == id)
        .ok_or_else(|| OmniError::not_found(format!("unknown source: {id}")))?;
    if token.trim().is_empty() {
        let _ = omnipanel_store::Vault::delete(&token_ref(&id));
        storage.registry_source_upsert(&row.id, &row.url, &row.pinned_keys, "")?;
    } else {
        omnipanel_store::Vault::store(&token_ref(&id), token.trim())?;
        storage.registry_source_upsert(&row.id, &row.url, &row.pinned_keys, &token_ref(&id))?;
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_registry_source_test(
    state: State<'_, AppState>,
    id: String,
) -> Result<SourceTestResult, OmniError> {
    let (cfg, plugins_root) = {
        let storage = state.storage.lock().await;
        let rows = storage.registry_sources_list()?;
        let row = rows
            .iter()
            .find(|r| r.id == id.trim())
            .ok_or_else(|| OmniError::not_found(format!("unknown source: {id}")))?
            .clone();
        let token = if row.auth_ref.trim().is_empty() {
            None
        } else {
            omnipanel_store::Vault::get(&token_ref(&row.id)).ok()
        };
        (
            SourceCfg {
                id: row.id,
                url: row.url,
                enabled: row.enabled,
                pinned: row.pinned_keys,
                token,
                builtin: row.builtin,
            },
            state.plugin_packages_dir.clone(),
        )
    };
    match fetch_source(&state.plugin_http, &cfg, plugins_root.as_deref()).await {
        Ok((file, tofued)) => {
            if let Some(key) = tofued {
                let storage = state.storage.lock().await;
                let _ = storage.registry_source_set_pinned(&cfg.id, &[key]);
            }
            Ok(SourceTestResult {
                ok: true,
                plugin_count: file.plugins.len() as u32,
                error: None,
            })
        }
        Err(err) => Ok(SourceTestResult {
            ok: false,
            plugin_count: 0,
            error: Some(err.to_string()),
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_registry_confirm_key(
    state: State<'_, AppState>,
    id: String,
    new_key_hex: String,
) -> Result<Vec<String>, OmniError> {
    let key = hex_to_verifying_key(&new_key_hex)
        .ok_or_else(|| OmniError::invalid_input("bad new public key"))?;
    let raw = {
        let root = state.plugin_packages_dir.clone();
        let path = cache_path(root.as_deref(), id.trim())
            .ok_or_else(|| OmniError::invalid_input("bad source id"))?;
        std::fs::read_to_string(path).map_err(|_| {
            OmniError::not_found(format!("no cached registry, fetch first: {id}"))
        })?
    };
    let file =
        parse_registry(&raw).map_err(|e| OmniError::invalid_input(format!("parse cache: {e}")))?;
    verify_registry(&file, &[key])
        .map_err(|_| OmniError::invalid_input("new key does not verify, rejected"))?;
    let storage = state.storage.lock().await;
    storage.registry_source_stage_key(id.trim(), new_key_hex.trim())?;
    storage.registry_source_confirm_key(id.trim())
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_market_catalog(
    state: State<'_, AppState>,
    force: bool,
) -> Result<Vec<MarketplaceItem>, OmniError> {
    let (merged, _errors) = merged_view(&state, force).await?;
    let registry = state.plugin_registry.lock().await;
    let (installed_raw, _installed) = installed_map(&registry);
    let mut out = Vec::new();
    for plugin in merged.values() {
        let installed_version = installed_raw.get(&plugin.id).cloned();
        let latest = plugin.versions.iter().max_by(|a, b| a.version.cmp(&b.version));
        let Some(top) = latest else { continue };
        let update_available = match installed_version.as_deref() {
            Some(cur) => match cur.trim().parse::<semver::Version>() {
                Ok(have) => {
                    update_available(&have, &to_resolver_entries(&plugin.versions), HOST_API_VERSION)
                        .is_some()
                }
                Err(_) => true,
            },
            None => false,
        };
        out.push(MarketplaceItem {
            id: plugin.id.clone(),
            kind: plugin.kind,
            name: plugin.name.clone(),
            description: plugin.description.clone(),
            version: top.version.to_string(),
            changelog: top.changelog.clone(),
            min_host_api: Some(top.min_host_api),
            installed: installed_version.is_some(),
            installed_version,
            update_available,
            source_id: plugin.source_id.clone(),
            download_size: top.size,
            permissions: plugin.permissions.clone(),
        });
    }
    out.sort_by(|a, b| {
        b.update_available
            .cmp(&a.update_available)
            .then(a.id.cmp(&b.id))
    });
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_resolve_plan(
    state: State<'_, AppState>,
    id: String,
    version_req: Option<String>,
) -> Result<ResolvePlan, OmniError> {
    let (merged, _errors) = merged_view(&state, false).await?;
    let registry = state.plugin_registry.lock().await;
    let (_raw, installed) = installed_map(&registry);
    let index = to_resolver_index(&merged);
    let req = version_req.unwrap_or_else(|| "*".into());
    let plan = resolve_install(&[(id.trim().to_string(), req)], &index, HOST_API_VERSION, &installed)
        .map_err(|e| OmniError::invalid_input(format!("resolve failed: {e}")))?;
    let mut items = Vec::new();
    let mut warnings = Vec::new();
    for entry in plan {
        let plugin = merged.get(&entry.id).ok_or_else(|| {
            OmniError::not_found(format!("resolved plugin not in catalog: {}", entry.id))
        })?;
        let have = installed.get(&entry.id);
        let action = match have {
            None => "install",
            Some(cur) if cur < &entry.version => "upgrade",
            Some(_) => "keep",
        };
        if action == "keep" {
            continue;
        }
        let downloadable = plugin
            .versions
            .iter()
            .any(|v| v.version == entry.version && !v.url.trim().is_empty());
        if !downloadable {
            warnings.push(format!("{} {} not downloadable (bundled)", entry.id, entry.version));
            continue;
        }
        items.push(ResolvePlanItem {
            id: entry.id.clone(),
            version: entry.version.to_string(),
            action: action.into(),
            source_id: plugin.source_id.clone(),
        });
    }
    Ok(ResolvePlan { items, warnings })
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_install_version(
    state: State<'_, AppState>,
    id: String,
    version: Option<String>,
    approve_deps: bool,
) -> Result<PluginListItem, OmniError> {
    let (merged, _errors) = merged_view(&state, false).await?;
    let plugin = merged
        .get(id.trim())
        .ok_or_else(|| OmniError::not_found(format!("not in catalog: {id}")))?
        .clone();
    let target: semver::Version = match version {
        Some(v) => v.trim().parse().map_err(|_| {
            OmniError::invalid_input(format!("bad version: {v}"))
        })?,
        None => plugin
            .versions
            .iter()
            .filter(|v| v.min_host_api <= HOST_API_VERSION && !v.url.trim().is_empty())
            .map(|v| &v.version)
            .max()
            .cloned()
            .ok_or_else(|| {
                OmniError::invalid_input(format!("no compatible downloadable version: {id}"))
            })?,
    };
    if !approve_deps {
        let registry = state.plugin_registry.lock().await;
        let (_raw, installed) = installed_map(&registry);
        let index = to_resolver_index(&merged);
        let plan = resolve_install(
            &[(id.trim().to_string(), format!("={target}"))],
            &index,
            HOST_API_VERSION,
            &installed,
        )
        .map_err(|e| OmniError::invalid_input(format!("resolve failed: {e}")))?;
        let missing: Vec<String> = plan
            .iter()
            .filter(|p| p.id != id.trim() && installed.get(&p.id) != Some(&p.version))
            .map(|p| format!("{} {}", p.id, p.version))
            .collect();
        if !missing.is_empty() {
            return Err(OmniError::invalid_input(format!(
                "missing deps, retry with approve_deps=true: {}",
                missing.join(", ")
            )));
        }
    }
    install_merged_version(&state, &plugin, &target).await
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_check_updates(
    state: State<'_, AppState>,
) -> Result<Vec<UpdateInfo>, OmniError> {
    plugin_check_updates_inner(&state).await
}

async fn plugin_check_updates_inner(
    state: &State<'_, AppState>,
) -> Result<Vec<UpdateInfo>, OmniError> {
    let (merged, _errors) = merged_view(state, false).await?;
    let registry = state.plugin_registry.lock().await;
    let (_raw, installed) = installed_map(&registry);
    let mut out = Vec::new();
    for plugin in merged.values() {
        let Some(have) = installed.get(&plugin.id) else {
            continue;
        };
        if let Some(latest) =
            update_available(have, &to_resolver_entries(&plugin.versions), HOST_API_VERSION)
        {
            let entry = plugin.versions.iter().find(|v| v.version == latest);
            out.push(UpdateInfo {
                id: plugin.id.clone(),
                installed_version: have.to_string(),
                latest_version: latest.to_string(),
                changelog: entry.and_then(|e| e.changelog.clone()),
                source_id: plugin.source_id.clone(),
            });
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_update_all(
    state: State<'_, AppState>,
    ids: Option<Vec<String>>,
) -> Result<Vec<UpdateResultItem>, OmniError> {
    let updates = plugin_check_updates_inner(&state).await?;
    let wanted: Vec<UpdateInfo> = match ids {
        Some(list) => {
            let set: std::collections::HashSet<String> = list.into_iter().collect();
            updates.into_iter().filter(|u| set.contains(&u.id)).collect()
        }
        None => updates,
    };
    let mut out = Vec::new();
    for item in wanted {
        let result = plugin_install_version_inner(&state, &item.id, Some(item.latest_version.clone()), true).await;
        match result {
            Ok(_) => out.push(UpdateResultItem {
                id: item.id,
                ok: true,
                error: None,
            }),
            Err(err) => out.push(UpdateResultItem {
                id: item.id,
                ok: false,
                error: Some(err.to_string()),
            }),
        }
    }
    Ok(out)
}

async fn plugin_install_version_inner(
    state: &State<'_, AppState>,
    id: &str,
    version: Option<String>,
    approve_deps: bool,
) -> Result<PluginListItem, OmniError> {
    let (merged, _errors) = merged_view(state, false).await?;
    let plugin = merged
        .get(id.trim())
        .ok_or_else(|| OmniError::not_found(format!("not in catalog: {id}")))?
        .clone();
    let target: semver::Version = match version {
        Some(v) => v.trim().parse().map_err(|_| {
            OmniError::invalid_input(format!("bad version: {v}"))
        })?,
        None => plugin
            .versions
            .iter()
            .filter(|v| v.min_host_api <= HOST_API_VERSION && !v.url.trim().is_empty())
            .map(|v| &v.version)
            .max()
            .cloned()
            .ok_or_else(|| {
                OmniError::invalid_input(format!("no compatible downloadable version: {id}"))
            })?,
    };
    let _ = approve_deps;
    install_merged_version(state, &plugin, &target).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnipanel_plugin_pkg::{RegistryArtifact, RegistryPlugin, RegistryVersion};

    fn mk_file(source: &str) -> RegistryFile {
        RegistryFile {
            schema_version: 2,
            plugins: vec![RegistryPlugin {
                id: "omni.sample.demo".into(),
                kind: "addon".into(),
                name: "Demo".into(),
                description: String::new(),
                versions: vec![RegistryVersion {
                    version: "1.0.0".into(),
                    changelog: None,
                    min_host_api: None,
                    artifact: Some(RegistryArtifact {
                        url: format!("https://{source}/a.omni-plugin"),
                        sha256: String::new(),
                        size: 1,
                    }),
                    dependencies: vec![],
                }],
            }],
            signature: None,
            publisher_key: None,
        }
    }

    #[test]
    fn merge_prefers_first_source() {
        let merged = merge_registries(vec![
            ("official".into(), mk_file("official")),
            ("other".into(), mk_file("other")),
        ]);
        assert_eq!(merged["omni.sample.demo"].source_id, "official");
        assert_eq!(
            merged["omni.sample.demo"].versions[0].url,
            "https://official/a.omni-plugin"
        );
    }

    #[test]
    fn update_available_respects_host_api() {
        let merged = merge_registries(vec![("s".into(), RegistryFile {
            schema_version: 2,
            plugins: vec![RegistryPlugin {
                id: "omni.sample.demo".into(),
                kind: "addon".into(),
                name: String::new(),
                description: String::new(),
                versions: vec![
                    RegistryVersion {
                        version: "1.0.0".into(),
                        changelog: None,
                        min_host_api: None,
                        artifact: None,
                        dependencies: vec![],
                    },
                    RegistryVersion {
                        version: "2.0.0".into(),
                        changelog: Some("big".into()),
                        min_host_api: Some(99),
                        artifact: None,
                        dependencies: vec![],
                    },
                ],
            }],
            signature: None,
            publisher_key: None,
        })]);
        let have: semver::Version = "1.0.0".parse().unwrap();
        let plugin = &merged["omni.sample.demo"];
        assert_eq!(
            update_available(&have, &to_resolver_entries(&plugin.versions), 1),
            None
        );
        assert_eq!(
            update_available(&have, &to_resolver_entries(&plugin.versions), 99)
                .map(|v| v.to_string()),
            Some("2.0.0".into())
        );
    }

    #[test]
    fn sanitize_cache_id_rejects_junk() {
        assert_eq!(sanitize_cache_id("../../x"), Some("______x".into()));
        assert_eq!(sanitize_cache_id("  "), None);
        assert_eq!(sanitize_cache_id("community-1"), Some("community-1".into()));
    }
}
