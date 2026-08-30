//! 对接 DBX 官方 Agent 目录：拉取 native / JDBC sidecar 并装成 OmniPanel engine 插件。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{
    Mutex, OnceLock,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_plugin::{PluginKind, PluginListItem};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use specta::Type;
use tauri::State;

use crate::commands::plugin::rebuild_and_sync;
use crate::state::AppState;

const REGISTRY_URL: &str =
    "https://github.com/t8y2/dbx/releases/download/agents-latest/agent-registry.json";
const GITHUB_RELEASE_API: &str =
    "https://api.github.com/repos/t8y2/dbx/releases/tags/agents-latest";
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const GITHUB_STATS_TIMEOUT: Duration = Duration::from_secs(8);
const GITHUB_STATS_TTL: Duration = Duration::from_secs(6 * 60 * 60);

const WORKER_PROTOCOL: &[&str] = &["duckdb"];
const QUEUE_OR_KV: &[&str] = &["kafka", "etcd", "rabbitmq", "rocketmq", "zookeeper"];

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbxCatalogDriver {
    pub key: String,
    pub plugin_id: String,
    pub label: String,
    pub version: String,
    pub default_port: u16,
    pub size: u64,
    pub artifact_kind: String,
    pub installed: bool,
    pub installed_version: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub downloads: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryFile {
    #[serde(default)]
    drivers: HashMap<String, DriverEntry>,
    #[serde(default)]
    jres: HashMap<String, JreEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DriverEntry {
    version: String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    jre: String,
    #[serde(default)]
    external_driver_required: bool,
    #[serde(default)]
    native: HashMap<String, Artifact>,
    #[serde(default)]
    jar: Option<Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JreEntry {
    #[serde(default)]
    version: String,
    #[serde(default)]
    platforms: HashMap<String, Artifact>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Artifact {
    url: String,
    #[serde(default)]
    sha256: String,
    #[serde(default)]
    size: u64,
}

#[derive(Debug, Clone, Default)]
struct GithubReleaseStats {
    published_at: Option<String>,
    downloads_by_url: HashMap<String, u64>,
    downloads_by_name: HashMap<String, u64>,
}

#[derive(Debug, Deserialize)]
struct GithubReleaseDto {
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<GithubAssetDto>,
}

#[derive(Debug, Deserialize)]
struct GithubAssetDto {
    name: String,
    download_count: u64,
    #[serde(default)]
    browser_download_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct GithubStatsCache {
    fetched_at_ms: u64,
    published_at: Option<String>,
    downloads_by_url: HashMap<String, u64>,
    downloads_by_name: HashMap<String, u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArtifactKind {
    Native,
    Jar,
}

impl ArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Native => "native",
            Self::Jar => "jar",
        }
    }
}

fn current_platform() -> String {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "aarch64"
    } else {
        "x64"
    };
    format!("{os}-{arch}")
}

fn plugin_id_for(key: &str) -> String {
    format!("omni.engine.{key}")
}

fn default_port(key: &str) -> u16 {
    match key {
        "oracle" => 1521,
        "kingbase" | "vastbase" | "highgo" | "uxdb" => 54321,
        "gaussdb" | "opengauss" => 5432,
        "tidb" => 4000,
        "xugu" => 5138,
        "dameng" => 5236,
        "db2" => 50000,
        "neo4j" => 7687,
        "iotdb" => 6667,
        "cassandra" => 9042,
        "hive" | "spark" => 10000,
        "tdengine" => 6030,
        "gbase8a" | "gbase8s" | "goldendb" | "oscar" => 5258,
        "yashandb" => 1688,
        "informix" => 9088,
        "saphana" => 30015,
        "firebird" => 3050,
        "oceanbase" | "oceanbase-oracle" => 2881,
        "ignite" | "ignite3" => 10800,
        "spanner" => 443,
        _ => 0,
    }
}

fn aliases_for(key: &str) -> Vec<String> {
    match key {
        "oracle" => vec!["oracle".into(), "orcl".into()],
        "dameng" => vec!["dameng".into(), "dm".into()],
        "kingbase" => vec!["kingbase".into(), "kingbasees".into()],
        "gaussdb" => vec!["gaussdb".into(), "opengauss".into()],
        "oceanbase" | "oceanbase-oracle" => {
            vec!["oceanbase".into(), "oceanbase-oracle".into()]
        }
        other => vec![other.to_string()],
    }
}

fn icon_for(key: &str) -> String {
    key.chars().take(2).collect::<String>().to_ascii_uppercase()
}

fn reserved_engine_keys() -> HashSet<String> {
    let mut keys = HashSet::new();
    for engine in omnipanel_db::FirstPartyEngine::ALL {
        for alias in engine.keys() {
            keys.insert((*alias).to_string());
        }
    }
    for manifest in omnipanel_plugin::first_party_manifests() {
        if manifest.kind != PluginKind::Engine {
            continue;
        }
        for alias in omnipanel_plugin::connection_form_engine_keys(&manifest) {
            keys.insert(alias);
        }
    }
    keys
}

fn skip_reason(key: &str, reserved: &HashSet<String>) -> Option<&'static str> {
    if reserved.contains(key) || key.contains("sqlserver") || key == "mssql" {
        return Some("first_party");
    }
    if WORKER_PROTOCOL.contains(&key) {
        return Some("worker_protocol");
    }
    if QUEUE_OR_KV.contains(&key) {
        return Some("not_sql");
    }
    None
}

fn jar_usable(artifact: &Artifact) -> bool {
    let url = artifact.url.trim();
    !url.is_empty() && !url.contains("placeholder") && artifact.size > 0
}

fn pick_artifact<'a>(
    entry: &'a DriverEntry,
    platform: &str,
) -> Option<(ArtifactKind, &'a Artifact)> {
    if let Some(native) = entry.native.get(platform) {
        if !native.url.trim().is_empty() {
            return Some((ArtifactKind::Native, native));
        }
    }
    if entry.external_driver_required {
        return None;
    }
    let jar = entry.jar.as_ref()?;
    if jar_usable(jar) {
        Some((ArtifactKind::Jar, jar))
    } else {
        None
    }
}

fn artifact_file_name(url: &str) -> Option<&str> {
    let bare = url.split('?').next().unwrap_or(url);
    let name = bare.rsplit('/').next()?;
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

fn downloads_for(artifact: &Artifact, stats: &GithubReleaseStats) -> Option<u64> {
    let url = artifact.url.trim();
    if url.is_empty() {
        return None;
    }
    if let Some(count) = stats.downloads_by_url.get(url) {
        return Some(*count);
    }
    let bare = url.split('?').next().unwrap_or(url);
    if let Some(count) = stats.downloads_by_url.get(bare) {
        return Some(*count);
    }
    artifact_file_name(bare).and_then(|name| stats.downloads_by_name.get(name).copied())
}

fn parse_installable(
    registry: &RegistryFile,
    platform: &str,
    installed: &HashMap<String, String>,
    stats: &GithubReleaseStats,
) -> Vec<DbxCatalogDriver> {
    let reserved = reserved_engine_keys();
    let mut out = Vec::new();
    for (key, entry) in &registry.drivers {
        if skip_reason(key, &reserved).is_some() {
            continue;
        }
        let Some((kind, artifact)) = pick_artifact(entry, platform) else {
            continue;
        };
        let plugin_id = plugin_id_for(key);
        let installed_version = installed.get(&plugin_id).cloned();
        let label = if entry.label.trim().is_empty() {
            key.clone()
        } else {
            entry.label.clone()
        };
        out.push(DbxCatalogDriver {
            key: key.clone(),
            plugin_id,
            label,
            version: entry.version.clone(),
            default_port: default_port(key),
            size: artifact.size,
            artifact_kind: kind.as_str().to_string(),
            installed: installed_version.is_some(),
            installed_version,
            created_at: None,
            updated_at: stats.published_at.clone(),
            downloads: downloads_for(artifact, stats),
        });
    }
    out.sort_by(|a, b| a.label.cmp(&b.label).then(a.key.cmp(&b.key)));
    out
}

fn github_stats_memory() -> &'static Mutex<Option<(Instant, GithubReleaseStats)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, GithubReleaseStats)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn github_stats_cache_path(plugins_root: Option<&Path>) -> Option<PathBuf> {
    Some(plugins_root?.join(".dbx-github-stats.json"))
}

fn load_github_stats_disk(path: &Path) -> Option<GithubReleaseStats> {
    let text = fs::read_to_string(path).ok()?;
    let cache: GithubStatsCache = serde_json::from_str(&text).ok()?;
    Some(GithubReleaseStats {
        published_at: cache.published_at,
        downloads_by_url: cache.downloads_by_url,
        downloads_by_name: cache.downloads_by_name,
    })
}

fn store_github_stats_disk(path: &Path, stats: &GithubReleaseStats) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let cache = GithubStatsCache {
        fetched_at_ms: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
        published_at: stats.published_at.clone(),
        downloads_by_url: stats.downloads_by_url.clone(),
        downloads_by_name: stats.downloads_by_name.clone(),
    };
    if let Ok(text) = serde_json::to_string(&cache) {
        let _ = fs::write(path, text);
    }
}

fn store_github_stats_memory(stats: GithubReleaseStats) {
    if let Ok(mut guard) = github_stats_memory().lock() {
        *guard = Some((Instant::now(), stats));
    }
}

fn load_cached_github_stats(plugins_root: Option<&Path>) -> Option<GithubReleaseStats> {
    if let Ok(guard) = github_stats_memory().lock() {
        if let Some((at, stats)) = guard.as_ref() {
            if at.elapsed() < GITHUB_STATS_TTL {
                return Some(stats.clone());
            }
        }
    }
    let path = github_stats_cache_path(plugins_root)?;
    let disk = load_github_stats_disk(&path)?;
    store_github_stats_memory(disk.clone());
    Some(disk)
}

async fn fetch_github_release_stats(client: &reqwest::Client) -> Option<GithubReleaseStats> {
    let response = client
        .get(GITHUB_RELEASE_API)
        .header("User-Agent", "OmniPanel-dbx-catalog")
        .header("Accept", "application/vnd.github+json")
        .timeout(GITHUB_STATS_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let dto: GithubReleaseDto = response.json().await.ok()?;
    let mut stats = GithubReleaseStats {
        published_at: dto.published_at,
        downloads_by_url: HashMap::new(),
        downloads_by_name: HashMap::new(),
    };
    for asset in dto.assets {
        stats
            .downloads_by_name
            .insert(asset.name.clone(), asset.download_count);
        let url = asset.browser_download_url.trim();
        if !url.is_empty() {
            stats
                .downloads_by_url
                .insert(url.to_string(), asset.download_count);
        }
    }
    Some(stats)
}

fn spawn_silent_github_stats_refresh(client: reqwest::Client, plugins_root: Option<PathBuf>) {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        if let Some(stats) = fetch_github_release_stats(&client).await {
            store_github_stats_memory(stats.clone());
            if let Some(path) = github_stats_cache_path(plugins_root.as_deref()) {
                store_github_stats_disk(&path, &stats);
            }
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

async fn github_stats_for_catalog(
    client: &reqwest::Client,
    plugins_root: Option<&Path>,
) -> GithubReleaseStats {
    if let Some(cached) = load_cached_github_stats(plugins_root) {
        spawn_silent_github_stats_refresh(client.clone(), plugins_root.map(Path::to_path_buf));
        return cached;
    }
    match fetch_github_release_stats(client).await {
        Some(fetched) => {
            store_github_stats_memory(fetched.clone());
            if let Some(path) = github_stats_cache_path(plugins_root) {
                store_github_stats_disk(&path, &fetched);
            }
            fetched
        }
        None => GithubReleaseStats::default(),
    }
}

async fn fetch_registry(client: &reqwest::Client) -> Result<RegistryFile, OmniError> {
    let response = client
        .get(REGISTRY_URL)
        .header("User-Agent", "OmniPanel-dbx-catalog")
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("无法拉取 DBX 目录: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "DBX 目录 HTTP {}",
            response.status()
        )));
    }
    let value: Value = response
        .json()
        .await
        .map_err(|e| OmniError::connection(format!("DBX 目录 JSON 非法: {e}")))?;
    serde_json::from_value(value)
        .map_err(|e| OmniError::internal(format!("解析 DBX 目录失败: {e}")))
}

fn registry_memory() -> &'static Mutex<Option<RegistryFile>> {
    static CACHE: OnceLock<Mutex<Option<RegistryFile>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn registry_cache_path(plugins_root: Option<&Path>) -> Option<PathBuf> {
    Some(plugins_root?.join(".dbx-registry-cache.json"))
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

fn spawn_silent_registry_refresh(client: reqwest::Client, plugins_root: Option<PathBuf>) {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if BUSY.swap(true, Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        if let Ok(registry) = fetch_registry(&client).await {
            store_cached_registry(plugins_root.as_deref(), &registry);
        }
        BUSY.store(false, Ordering::SeqCst);
    });
}

async fn registry_for_catalog(
    client: &reqwest::Client,
    plugins_root: Option<&Path>,
) -> Result<RegistryFile, OmniError> {
    if let Some(cached) = load_cached_registry(plugins_root) {
        spawn_silent_registry_refresh(client.clone(), plugins_root.map(Path::to_path_buf));
        return Ok(cached);
    }
    let fetched = fetch_registry(client).await?;
    store_cached_registry(plugins_root, &fetched);
    Ok(fetched)
}

async fn registry_for_install(
    client: &reqwest::Client,
    plugins_root: Option<&Path>,
) -> Result<RegistryFile, OmniError> {
    match fetch_registry(client).await {
        Ok(fetched) => {
            store_cached_registry(plugins_root, &fetched);
            Ok(fetched)
        }
        Err(error) => load_cached_registry(plugins_root).ok_or(error),
    }
}

/// 列出当前平台可安装的 DBX SQL / CQL / Cypher agent（不含第一方引擎 / DuckDB worker / 队列）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dbx_catalog(
    state: State<'_, AppState>,
) -> Result<Vec<DbxCatalogDriver>, OmniError> {
    let plugins_root = state.plugin_packages_dir.clone();
    let registry_fut = registry_for_catalog(&state.plugin_http, plugins_root.as_deref());
    let stats_fut = github_stats_for_catalog(&state.plugin_http, plugins_root.as_deref());
    let (registry, stats) = tokio::join!(registry_fut, stats_fut);
    let registry = registry?;
    let installed = {
        let registry_guard = state.plugin_registry.lock().await;
        registry_guard
            .list()
            .into_iter()
            .filter(|item| item.kind == PluginKind::Engine)
            .map(|item| (item.id, item.version))
            .collect()
    };
    Ok(parse_installable(
        &registry,
        &current_platform(),
        &installed,
        &stats,
    ))
}

/// 从 DBX 官方目录下载 native 或 JDBC agent，写入 `app_data/plugins/omni.engine.<key>/`。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dbx_install(
    state: State<'_, AppState>,
    key: String,
) -> Result<PluginListItem, OmniError> {
    let key = key.trim().to_ascii_lowercase();
    if key.is_empty() {
        return Err(OmniError::invalid_input("缺少 driver key"));
    }
    if let Some(reason) = skip_reason(&key, &reserved_engine_keys()) {
        return Err(OmniError::invalid_input(format!(
            "该 DBX driver 本期不安装: {key} ({reason})"
        )));
    }
    let plugin_id = plugin_id_for(&key);
    {
        let registry = state.plugin_registry.lock().await;
        if !registry.is_installed(&plugin_id) && registry.get(&plugin_id).is_some() {
            return Err(OmniError::invalid_input(format!(
                "插件 id 与内置插件冲突: {plugin_id}"
            )));
        }
    }

    let dest_root = state
        .plugin_packages_dir
        .clone()
        .ok_or_else(|| OmniError::internal("无法定位插件安装目录"))?;
    let registry = registry_for_install(&state.plugin_http, Some(dest_root.as_path())).await?;
    let entry = registry
        .drivers
        .get(&key)
        .ok_or_else(|| OmniError::not_found(format!("DBX 目录没有 driver: {key}")))?;
    let platform = current_platform();
    let (kind, artifact) = pick_artifact(entry, &platform)
        .ok_or_else(|| OmniError::not_found(format!("DBX {key} 没有 {platform} native/JDBC 包")))?;
    if kind == ArtifactKind::Jar {
        ensure_jre(&state.plugin_http, &registry, &dest_root, &entry.jre).await?;
    }

    let bytes = download_bytes(&state.plugin_http, &artifact.url).await?;
    if let Err(reason) = verify_sha256(&bytes, &artifact.sha256) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("DBX {key} {reason}"),
        ));
    }

    let version = entry.version.clone();
    let dest = dest_root.join(&plugin_id);
    let work = std::env::temp_dir().join(format!("omni-dbx-{}-{}", key, std::process::id()));
    tokio::task::spawn_blocking({
        let dest = dest.clone();
        let work = work.clone();
        let key = key.clone();
        move || install_extracted(&bytes, &work, &dest, &key, &version)
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))??;

    rebuild_and_sync(&state).await?;
    omnipanel_db::sidecar::evict_all_external_launches().await;

    let registry = state.plugin_registry.lock().await;
    let entry = registry
        .get(&plugin_id)
        .ok_or_else(|| OmniError::not_found(format!("安装后未登记: {plugin_id}")))?;
    Ok(PluginListItem {
        id: entry.manifest.id.clone(),
        version: entry.manifest.version.clone(),
        kind: entry.manifest.kind,
        enabled: entry.enabled,
        activated: entry.activated,
        source: entry.source,
        unsupported_reason: entry.unsupported_reason.clone(),
    })
}

/// 每组按官方 registry 实有 key 解析；当前无 gaussdb / tidb，OceanBase 为 oceanbase-oracle。
const OPTIONAL_CATALOG_ENGINE_GROUPS: &[&[&str]] = &[
    &["kingbase"],
    &["vastbase"],
    &["uxdb"],
    &["gaussdb", "opengauss"],
    &["oceanbase", "oceanbase-oracle"],
    &["tidb"],
];

fn resolve_optional_catalog_key(registry: &RegistryFile, aliases: &[&str]) -> Option<String> {
    aliases
        .iter()
        .find(|key| registry.drivers.contains_key(**key))
        .map(|key| (*key).to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DbxInstallAttempt {
    pub key: String,
    pub ok: bool,
    pub message: String,
}

/// 安装金仓 / Vastbase / UXDB / OceanBase 等；目录无包则记原因，不阻断其余项。
#[tauri::command]
#[specta::specta]
pub async fn plugin_dbx_install_catalog_engines(
    state: State<'_, AppState>,
) -> Result<Vec<DbxInstallAttempt>, OmniError> {
    let plugins_root = state.plugin_packages_dir.clone();
    let catalog = registry_for_catalog(&state.plugin_http, plugins_root.as_deref()).await?;
    let mut out = Vec::new();
    for aliases in OPTIONAL_CATALOG_ENGINE_GROUPS {
        let Some(key) = resolve_optional_catalog_key(&catalog, aliases) else {
            out.push(DbxInstallAttempt {
                key: aliases[0].to_string(),
                ok: false,
                message: format!("DBX 目录没有 driver: {}", aliases.join("|")),
            });
            continue;
        };
        let plugin_id = plugin_id_for(&key);
        {
            let registry = state.plugin_registry.lock().await;
            if registry.is_installed(&plugin_id) {
                out.push(DbxInstallAttempt {
                    key,
                    ok: true,
                    message: "already installed".into(),
                });
                continue;
            }
        }
        match plugin_dbx_install(state.clone(), key.clone()).await {
            Ok(item) => out.push(DbxInstallAttempt {
                key,
                ok: true,
                message: format!("installed {}", item.version),
            }),
            Err(err) => {
                tracing::warn!("安装 DBX {key} 失败: {err}");
                out.push(DbxInstallAttempt {
                    key,
                    ok: false,
                    message: err.to_string(),
                });
            }
        }
    }
    Ok(out)
}

async fn download_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, OmniError> {
    let response = client
        .get(url)
        .header("User-Agent", "OmniPanel-dbx-catalog")
        .timeout(DOWNLOAD_TIMEOUT)
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("下载 DBX agent 失败: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "下载 DBX agent HTTP {}",
            response.status()
        )));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| OmniError::connection(format!("读取 DBX agent 失败: {e}")))?;
    Ok(bytes.to_vec())
}

async fn ensure_jre(
    client: &reqwest::Client,
    registry: &RegistryFile,
    plugins_root: &Path,
    requested: &str,
) -> Result<(), OmniError> {
    let key = if requested.trim().is_empty() {
        "21"
    } else {
        requested.trim()
    };
    let dest = plugins_root.join(".dbx-jre").join(key);
    if let Some(java) = omnipanel_db::sidecar::find_java_binary(&dest) {
        if omnipanel_db::sidecar::java_version_ok(&java) {
            return Ok(());
        }
        let _ = fs::remove_dir_all(&dest);
    }
    let jre = registry
        .jres
        .get(key)
        .ok_or_else(|| OmniError::not_found(format!("DBX 目录没有 JRE {key}")))?;
    let platform = current_platform();
    let artifact = jre
        .platforms
        .get(&platform)
        .ok_or_else(|| OmniError::not_found(format!("DBX JRE {key} 没有 {platform} 包")))?;
    if artifact.url.trim().is_empty() {
        return Err(OmniError::not_found(format!("DBX JRE {key} URL 为空")));
    }
    let bytes = download_bytes(client, &artifact.url).await?;
    if let Err(reason) = verify_sha256(&bytes, &artifact.sha256) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("DBX JRE {key} {reason}"),
        ));
    }
    let dest_owned = dest.clone();
    tokio::task::spawn_blocking(move || install_jre_extracted(&bytes, &dest_owned))
        .await
        .map_err(|e| OmniError::internal(e.to_string()))??;
    let Some(java) = omnipanel_db::sidecar::find_java_binary(&dest) else {
        return Err(OmniError::not_found("JRE 包内没有 java 可执行文件"));
    };
    if !omnipanel_db::sidecar::java_version_ok(&java) {
        let _ = fs::remove_dir_all(&dest);
        return Err(OmniError::internal(
            "捆绑 JRE 无法执行 java -version，请重新安装该引擎",
        ));
    }
    Ok(())
}

fn install_jre_extracted(archive_bytes: &[u8], dest: &Path) -> Result<(), OmniError> {
    let work = std::env::temp_dir().join(format!("omni-dbx-jre-{}", std::process::id()));
    let _ = fs::remove_dir_all(&work);
    fs::create_dir_all(&work).map_err(|e| OmniError::internal(e.to_string()))?;
    let archive = work.join("jre.tar.zst");
    fs::write(&archive, archive_bytes).map_err(|e| OmniError::internal(e.to_string()))?;
    let unpack = work.join("unpack");
    fs::create_dir_all(&unpack).map_err(|e| OmniError::internal(e.to_string()))?;
    extract_tar_zst(&archive, &unpack)?;
    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| OmniError::internal(e.to_string()))?;
    }
    fs::create_dir_all(dest).map_err(|e| OmniError::internal(e.to_string()))?;
    copy_dir_all(&unpack, dest)?;
    let _ = fs::remove_dir_all(&work);
    Ok(())
}

fn copy_dir_all(src: &Path, dest: &Path) -> Result<(), OmniError> {
    fs::create_dir_all(dest).map_err(|e| OmniError::internal(e.to_string()))?;
    for entry in fs::read_dir(src).map_err(|e| OmniError::internal(e.to_string()))? {
        let entry = entry.map_err(|e| OmniError::internal(e.to_string()))?;
        let path = entry.path();
        let target = dest.join(entry.file_name());
        if path.is_dir() {
            copy_dir_all(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(|e| OmniError::internal(e.to_string()))?;
        }
    }
    Ok(())
}

fn verify_sha256(bytes: &[u8], expected: &str) -> Result<(), String> {
    let expected = expected.trim();
    if expected.is_empty() {
        return Ok(());
    }
    let actual = sha256_hex(bytes);
    if actual.eq_ignore_ascii_case(expected) {
        Ok(())
    } else {
        Err("校验失败: sha256 不匹配".into())
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn install_extracted(
    archive_bytes: &[u8],
    work: &Path,
    dest: &Path,
    key: &str,
    version: &str,
) -> Result<(), OmniError> {
    let _ = fs::remove_dir_all(work);
    fs::create_dir_all(work).map_err(|e| OmniError::internal(e.to_string()))?;
    let archive = work.join("agent.tar.zst");
    fs::write(&archive, archive_bytes).map_err(|e| OmniError::internal(e.to_string()))?;
    let unpack = work.join("unpack");
    fs::create_dir_all(&unpack).map_err(|e| OmniError::internal(e.to_string()))?;
    extract_tar_zst(&archive, &unpack)?;
    let payload = find_agent_payload(&unpack)
        .ok_or_else(|| OmniError::not_found("DBX 包内没有 agent 可执行文件或 jar"))?;
    let file_name = payload
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| OmniError::internal("agent 文件名非法"))?
        .to_string();

    if dest.exists() {
        fs::remove_dir_all(dest).map_err(|e| OmniError::internal(e.to_string()))?;
    }
    let bin_dir = dest.join("bin");
    fs::create_dir_all(&bin_dir).map_err(|e| OmniError::internal(e.to_string()))?;
    let driver_dest = bin_dir.join(&file_name);
    fs::copy(&payload, &driver_dest).map_err(|e| OmniError::internal(e.to_string()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&driver_dest)
            .map_err(|e| OmniError::internal(e.to_string()))?
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&driver_dest, perms).map_err(|e| OmniError::internal(e.to_string()))?;
    }

    let driver_rel = format!("bin/{file_name}").replace('\\', "/");
    let manifest_value = plugin_manifest_json(key, version, &driver_rel);
    let parsed = omnipanel_plugin::PluginManifest::from_value(manifest_value.clone())
        .map_err(|e| OmniError::internal(format!("生成的 plugin.json 非法: {e}")))?;
    parsed
        .validate()
        .map_err(|e| OmniError::internal(format!("生成的 plugin.json 非法: {e}")))?;
    let text = serde_json::to_string_pretty(&manifest_value)
        .map_err(|e| OmniError::internal(e.to_string()))?;
    fs::write(dest.join("plugin.json"), text).map_err(|e| OmniError::internal(e.to_string()))?;
    let _ = fs::remove_dir_all(work);
    Ok(())
}

fn extract_tar_zst(archive: &Path, dest: &Path) -> Result<(), OmniError> {
    match extract_tar_zst_in_process(archive, dest) {
        Ok(()) => Ok(()),
        Err(in_process) => extract_tar_zst_via_tar(archive, dest).map_err(|via_tar| {
            OmniError::internal(format!("解压 DBX 包失败: {in_process}; tar: {via_tar}"))
        }),
    }
}

fn extract_tar_zst_in_process(archive: &Path, dest: &Path) -> Result<(), OmniError> {
    let file =
        fs::File::open(archive).map_err(|e| OmniError::internal(format!("打开压缩包失败: {e}")))?;
    let decoder =
        zstd::Decoder::new(file).map_err(|e| OmniError::internal(format!("zstd 解码失败: {e}")))?;
    let mut tar = tar::Archive::new(decoder);
    for entry in tar
        .entries()
        .map_err(|e| OmniError::internal(format!("读取 tar 失败: {e}")))?
    {
        let mut entry =
            entry.map_err(|e| OmniError::internal(format!("读取 tar 条目失败: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| OmniError::internal(e.to_string()))?;
        if path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            continue;
        }
        entry
            .unpack_in(dest)
            .map_err(|e| OmniError::internal(format!("解压条目失败: {e}")))?;
    }
    Ok(())
}

fn extract_tar_zst_via_tar(archive: &Path, dest: &Path) -> Result<(), OmniError> {
    let mut cmd = Command::new("tar");
    cmd.arg("-xf")
        .arg(archive)
        .arg("-C")
        .arg(dest)
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd
        .output()
        .map_err(|e| OmniError::internal(format!("无法启动 tar 解压: {e}")))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    Err(OmniError::internal(stderr.trim().to_string()))
}

fn find_agent_payload(root: &Path) -> Option<PathBuf> {
    find_agent_binary(root).or_else(|| find_agent_jar(root))
}

fn find_agent_jar(root: &Path) -> Option<PathBuf> {
    let mut found = Vec::new();
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            if lower.ends_with(".jar") && (lower.starts_with("dbx-agent") || lower == "agent.jar") {
                found.push(path);
            }
        }
    }
    walk(root, &mut found);
    found.into_iter().next()
}

fn find_agent_binary(root: &Path) -> Option<PathBuf> {
    let mut found = Vec::new();
    fn walk(dir: &Path, found: &mut Vec<PathBuf>) {
        let Ok(entries) = fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path, found);
                continue;
            }
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let lower = name.to_ascii_lowercase();
            if !lower.starts_with("dbx-agent") {
                continue;
            }
            if lower.ends_with(".json") || lower.contains(".tar") {
                continue;
            }
            #[cfg(windows)]
            if !lower.ends_with(".exe") {
                continue;
            }
            found.push(path);
        }
    }
    walk(root, &mut found);
    found.into_iter().next()
}

fn plugin_manifest_json(key: &str, version: &str, driver_rel: &str) -> Value {
    let editor = match key {
        "neo4j" => "cypher",
        "cassandra" => "cql",
        _ => "sql",
    };
    let tree = match key {
        "neo4j" => "graph",
        "cassandra" => "keyspace",
        _ => "schema",
    };
    let database_label = match key {
        "oracle" => "服务名",
        "dameng" => "模式",
        "cassandra" => "Keyspace",
        "neo4j" => "数据库",
        "hive" | "spark" => "库名",
        "firebird" => "数据库文件",
        "oceanbase" | "oceanbase-oracle" => "租户/库",
        "kingbase" => "数据库",
        "ignite" | "ignite3" => "Schema",
        "spanner" => "数据库",
        _ => "数据库",
    };
    let builtin_layout = !matches!(key, "oracle" | "dameng");
    let mut fields = vec![
        json!({ "key": "host", "type": "text" }),
        json!({ "key": "port", "type": "number" }),
        json!({
            "key": "database",
            "type": "text",
            "optional": true,
            "label": database_label
        }),
        json!({ "key": "username", "type": "text" }),
        json!({ "key": "password", "type": "password" }),
        json!({ "key": "ssl", "type": "checkbox", "optional": true }),
    ];
    if key == "oracle" {
        fields.insert(
            3,
            json!({
                "key": "sid",
                "type": "text",
                "optional": true,
                "label": "SID"
            }),
        );
        fields.push(json!({
            "key": "sysdba",
            "type": "checkbox",
            "optional": true,
            "label": "SYSDBA"
        }));
    }
    json!({
        "id": plugin_id_for(key),
        "version": version,
        "kind": "engine",
        "runtime": "sidecar",
        "permissions": ["net:connect"],
        "entry": { "driver": driver_rel },
        "contributes": {
            "ui": {
                "connectionForm": {
                    "engineKey": key,
                    "aliases": aliases_for(key),
                    "defaultPort": default_port(key),
                    "icon": icon_for(key),
                    "order": 80,
                    "builtinLayout": builtin_layout,
                    "fields": fields
                },
                "workbench": {
                    "tree": tree,
                    "editor": editor,
                    "preview": "grid",
                    "connectionInfo": "sql"
                }
            }
        }
    })
}

/// 启动时修补已装 DBX 引擎清单：旧包 `builtinLayout: true` 没有 SID / 模式字段。
pub(crate) fn migrate_installed_engine_manifests(plugins_root: &Path) {
    for key in ["oracle", "dameng", "neo4j", "cassandra"] {
        migrate_engine_manifest(plugins_root, key);
    }
}

fn migrate_engine_manifest(plugins_root: &Path, key: &str) {
    let path = plugins_root.join(plugin_id_for(key)).join("plugin.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let Some(form) = value.pointer("/contributes/ui/connectionForm") else {
        return;
    };
    let fields = form.get("fields").and_then(Value::as_array);
    let has_sid = fields.is_some_and(|items| {
        items
            .iter()
            .any(|field| field.get("key").and_then(Value::as_str) == Some("sid"))
    });
    let builtin = form.get("builtinLayout").and_then(Value::as_bool) == Some(true);
    let tree = value
        .pointer("/contributes/ui/workbench/tree")
        .and_then(Value::as_str);
    let needs = match key {
        "oracle" => builtin || !has_sid,
        "dameng" => builtin,
        "neo4j" => tree != Some("graph"),
        "cassandra" => tree != Some("keyspace"),
        _ => false,
    };
    if !needs {
        return;
    }
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");
    let driver = value
        .pointer("/entry/driver")
        .and_then(Value::as_str)
        .unwrap_or("bin/agent");
    let next = plugin_manifest_json(key, version, driver);
    let Ok(parsed) = omnipanel_plugin::PluginManifest::from_value(next.clone()) else {
        return;
    };
    if parsed.validate().is_err() {
        return;
    }
    let Ok(out) = serde_json::to_string_pretty(&next) else {
        return;
    };
    let _ = fs::write(&path, out);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_catalog_resolves_oceanbase_oracle_and_skips_missing() {
        let registry: RegistryFile = serde_json::from_value(json!({
            "drivers": {
                "kingbase": { "version": "1.0.0" },
                "oceanbase-oracle": { "version": "1.0.0" }
            }
        }))
        .unwrap();
        assert_eq!(
            resolve_optional_catalog_key(&registry, &["kingbase"]).as_deref(),
            Some("kingbase")
        );
        assert_eq!(
            resolve_optional_catalog_key(&registry, &["oceanbase", "oceanbase-oracle"]).as_deref(),
            Some("oceanbase-oracle")
        );
        assert_eq!(
            resolve_optional_catalog_key(&registry, &["gaussdb", "opengauss"]),
            None
        );
        assert_eq!(resolve_optional_catalog_key(&registry, &["tidb"]), None);
    }

    #[test]
    fn parse_skips_first_party_and_worker() {
        let registry: RegistryFile = serde_json::from_value(json!({
            "drivers": {
                "mysql": {
                    "version": "1.0.0",
                    "label": "MySQL",
                    "native": { "windows-x64": { "url": "https://example/mysql", "size": 1 } }
                },
                "duckdb": {
                    "version": "0.1.11",
                    "label": "DuckDB",
                    "native": { "windows-x64": { "url": "https://example/duckdb", "size": 2 } }
                },
                "kafka": {
                    "version": "0.1.0",
                    "label": "Kafka",
                    "native": { "windows-x64": { "url": "https://example/kafka", "size": 3 } }
                },
                "oracle": {
                    "version": "0.1.55",
                    "label": "oracle",
                    "native": {
                        "windows-x64": {
                            "url": "https://example/oracle",
                            "sha256": "abc",
                            "size": 2637771
                        }
                    }
                },
                "dameng": {
                    "version": "0.1.56",
                    "label": "达梦 DM8",
                    "jar": { "url": "https://example/dameng.jar", "size": 4000 }
                },
                "neo4j": {
                    "version": "0.1.56",
                    "label": "Neo4j",
                    "native": { "windows-x64": { "url": "https://example/neo4j", "size": 8 } }
                },
                "cassandra": {
                    "version": "0.1.56",
                    "label": "Cassandra",
                    "native": { "windows-x64": { "url": "https://example/cassandra", "size": 7 } }
                },
                "bigquery": {
                    "version": "1.0.0",
                    "label": "BigQuery",
                    "external_driver_required": true,
                    "jar": { "url": "https://example/bq.jar", "size": 9 }
                },
                "sqlserver-legacy": {
                    "version": "0.1.0",
                    "label": "SQL Server JDBC",
                    "jar": { "url": "https://example/mssql.jar", "size": 10 }
                }
            }
        }))
        .unwrap();
        let list = parse_installable(
            &registry,
            "windows-x64",
            &HashMap::new(),
            &GithubReleaseStats::default(),
        );
        let keys: Vec<_> = list.iter().map(|d| d.key.as_str()).collect();
        assert!(keys.contains(&"oracle"));
        assert!(keys.contains(&"dameng"));
        assert!(keys.contains(&"neo4j"));
        assert!(keys.contains(&"cassandra"));
        assert!(!keys.contains(&"mysql"));
        assert!(!keys.contains(&"duckdb"));
        assert!(!keys.contains(&"kafka"));
        assert!(!keys.contains(&"bigquery"));
        assert!(!keys.contains(&"sqlserver-legacy"));
        let dameng = list.iter().find(|d| d.key == "dameng").unwrap();
        assert_eq!(dameng.artifact_kind, "jar");
        assert_eq!(dameng.plugin_id, "omni.engine.dameng");
        assert!(dameng.downloads.is_none());
    }

    #[test]
    fn github_asset_download_count_matches_url_or_name() {
        let mut stats = GithubReleaseStats::default();
        stats.published_at = Some("2026-03-01T00:00:00Z".into());
        stats
            .downloads_by_url
            .insert("https://example/dameng.jar".into(), 42);
        stats.downloads_by_name.insert("neo4j".into(), 9);
        let registry: RegistryFile = serde_json::from_value(json!({
            "drivers": {
                "dameng": {
                    "version": "0.1.56",
                    "label": "达梦 DM8",
                    "jar": { "url": "https://example/dameng.jar", "size": 4000 }
                },
                "neo4j": {
                    "version": "0.1.56",
                    "label": "Neo4j",
                    "native": { "windows-x64": { "url": "https://cdn.example/neo4j", "size": 8 } }
                }
            }
        }))
        .unwrap();
        let list = parse_installable(&registry, "windows-x64", &HashMap::new(), &stats);
        let dameng = list.iter().find(|d| d.key == "dameng").unwrap();
        assert_eq!(dameng.downloads, Some(42));
        assert_eq!(dameng.updated_at.as_deref(), Some("2026-03-01T00:00:00Z"));
        let neo4j = list.iter().find(|d| d.key == "neo4j").unwrap();
        assert_eq!(neo4j.downloads, Some(9));
    }

    #[test]
    fn generated_cassandra_manifest_uses_cql_editor() {
        let value = plugin_manifest_json("cassandra", "0.1.0", "bin/agent.jar");
        let editor = value["contributes"]["ui"]["workbench"]["editor"]
            .as_str()
            .unwrap();
        assert_eq!(editor, "cql");
        assert_eq!(
            value["contributes"]["ui"]["workbench"]["tree"].as_str(),
            Some("keyspace")
        );
        let manifest = omnipanel_plugin::PluginManifest::from_value(value).unwrap();
        manifest.validate().unwrap();
    }

    #[test]
    fn generated_neo4j_manifest_uses_cypher_editor() {
        let value = plugin_manifest_json("neo4j", "0.1.0", "bin/agent.jar");
        let editor = value["contributes"]["ui"]["workbench"]["editor"]
            .as_str()
            .unwrap();
        assert_eq!(editor, "cypher");
        assert_eq!(
            value["contributes"]["ui"]["workbench"]["tree"].as_str(),
            Some("graph")
        );
        let manifest = omnipanel_plugin::PluginManifest::from_value(value).unwrap();
        manifest.validate().unwrap();
    }

    #[test]
    fn generated_manifest_validates() {
        let value =
            plugin_manifest_json("oracle", "0.1.55", "bin/dbx-agent-oracle-windows-x64.exe");
        let manifest = omnipanel_plugin::PluginManifest::from_value(value.clone()).unwrap();
        manifest.validate().unwrap();
        assert_eq!(manifest.id, "omni.engine.oracle");
        assert_eq!(
            manifest.driver_entry().unwrap(),
            "bin/dbx-agent-oracle-windows-x64.exe"
        );
        let form = &value["contributes"]["ui"]["connectionForm"];
        assert_eq!(form["builtinLayout"], false);
        let keys: Vec<_> = form["fields"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f["key"].as_str())
            .collect();
        assert!(keys.contains(&"sid"));
        assert!(keys.contains(&"sysdba"));
    }

    #[test]
    fn generated_dameng_manifest_uses_schema_label() {
        let value = plugin_manifest_json("dameng", "0.1.56", "bin/dbx-agent.jar");
        let form = &value["contributes"]["ui"]["connectionForm"];
        assert_eq!(form["builtinLayout"], false);
        assert_eq!(form["defaultPort"], 5236);
        let db = form["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "database")
            .unwrap();
        assert_eq!(db["label"], "模式");
        omnipanel_plugin::PluginManifest::from_value(value)
            .unwrap()
            .validate()
            .unwrap();
    }

    #[test]
    fn migrate_rewrites_oracle_builtin_layout() {
        let dir = std::env::temp_dir().join(format!("omni-oracle-migrate-{}", std::process::id()));
        let plugin_dir = dir.join("omni.engine.oracle");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&plugin_dir).unwrap();
        let stale = json!({
            "id": "omni.engine.oracle",
            "version": "0.1.55",
            "kind": "engine",
            "runtime": "sidecar",
            "permissions": ["net:connect"],
            "entry": { "driver": "bin/dbx-agent-oracle.exe" },
            "contributes": {
                "ui": {
                    "connectionForm": {
                        "engineKey": "oracle",
                        "aliases": ["oracle", "orcl"],
                        "defaultPort": 1521,
                        "icon": "OR",
                        "order": 80,
                        "builtinLayout": true,
                        "fields": [
                            { "key": "host", "type": "text" },
                            { "key": "port", "type": "number" }
                        ]
                    },
                    "workbench": {
                        "tree": "schema",
                        "editor": "sql",
                        "preview": "grid",
                        "connectionInfo": "sql"
                    }
                }
            }
        });
        fs::write(
            plugin_dir.join("plugin.json"),
            serde_json::to_string_pretty(&stale).unwrap(),
        )
        .unwrap();
        migrate_installed_engine_manifests(&dir);
        let text = fs::read_to_string(plugin_dir.join("plugin.json")).unwrap();
        let value: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            value["contributes"]["ui"]["connectionForm"]["builtinLayout"],
            false
        );
        let keys: Vec<_> = value["contributes"]["ui"]["connectionForm"]["fields"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|f| f["key"].as_str())
            .collect();
        assert!(keys.contains(&"sid"));
        assert_eq!(value["entry"]["driver"], "bin/dbx-agent-oracle.exe");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_tar_zst_in_process_without_shell() {
        let dir =
            std::env::temp_dir().join(format!("omni-dbx-extract-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src").join("bin")).unwrap();
        fs::write(dir.join("src").join("bin").join("hello.txt"), b"dbx").unwrap();
        let archive = dir.join("agent.tar.zst");
        {
            let file = fs::File::create(&archive).unwrap();
            let encoder = zstd::Encoder::new(file, 0).unwrap();
            let mut builder = tar::Builder::new(encoder);
            builder.append_dir_all(".", dir.join("src")).unwrap();
            builder.into_inner().unwrap().finish().unwrap();
        }
        let dest = dir.join("out");
        fs::create_dir_all(&dest).unwrap();
        extract_tar_zst_in_process(&archive, &dest).unwrap();
        assert_eq!(
            fs::read(dest.join("bin").join("hello.txt")).unwrap(),
            b"dbx"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn registry_disk_cache_roundtrip() {
        let dir = std::env::temp_dir().join(format!("omni-dbx-reg-cache-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let registry: RegistryFile = serde_json::from_value(json!({
            "drivers": {
                "oracle": {
                    "version": "0.1.0",
                    "label": "oracle",
                    "native": { "windows-x64": { "url": "https://example/oracle", "size": 1 } }
                }
            }
        }))
        .unwrap();
        store_cached_registry(Some(&dir), &registry);
        let loaded = read_registry_disk(&dir.join(".dbx-registry-cache.json")).unwrap();
        assert!(loaded.drivers.contains_key("oracle"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn generated_hive_oceanbase_manifest_ports_and_sql_editor() {
        let hive = plugin_manifest_json("hive", "0.1.0", "bin/agent.jar");
        let form = &hive["contributes"]["ui"]["connectionForm"];
        assert_eq!(form["defaultPort"], 10000);
        assert_eq!(form["builtinLayout"], true);
        assert_eq!(hive["contributes"]["ui"]["workbench"]["editor"], "sql");
        let db = form["fields"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["key"] == "database")
            .unwrap();
        assert_eq!(db["label"], "库名");
        omnipanel_plugin::PluginManifest::from_value(hive)
            .unwrap()
            .validate()
            .unwrap();

        let ob = plugin_manifest_json("oceanbase", "0.1.0", "bin/agent.jar");
        assert_eq!(
            ob["contributes"]["ui"]["connectionForm"]["defaultPort"],
            2881
        );
        assert_eq!(ob["contributes"]["ui"]["workbench"]["editor"], "sql");
        omnipanel_plugin::PluginManifest::from_value(ob)
            .unwrap()
            .validate()
            .unwrap();

        let fb = plugin_manifest_json("firebird", "0.1.0", "bin/agent");
        assert_eq!(
            fb["contributes"]["ui"]["connectionForm"]["defaultPort"],
            3050
        );
        omnipanel_plugin::PluginManifest::from_value(fb)
            .unwrap()
            .validate()
            .unwrap();

        let gauss = plugin_manifest_json("gaussdb", "0.1.0", "bin/agent.jar");
        let gauss_form = &gauss["contributes"]["ui"]["connectionForm"];
        assert_eq!(gauss_form["defaultPort"], 5432);
        let aliases: Vec<_> = gauss_form["aliases"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect();
        assert!(aliases.contains(&"opengauss"), "{aliases:?}");
        omnipanel_plugin::PluginManifest::from_value(gauss)
            .unwrap()
            .validate()
            .unwrap();

        let tidb = plugin_manifest_json("tidb", "0.1.0", "bin/agent.jar");
        assert_eq!(
            tidb["contributes"]["ui"]["connectionForm"]["defaultPort"],
            4000
        );
        omnipanel_plugin::PluginManifest::from_value(tidb)
            .unwrap()
            .validate()
            .unwrap();
    }

    #[test]
    fn sha256_mismatch_is_fail_closed() {
        assert!(verify_sha256(b"hello", "").is_ok());
        assert!(
            verify_sha256(
                b"hello",
                "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
            )
            .is_ok()
        );
        let err = verify_sha256(b"hello", "deadbeef").unwrap_err();
        assert!(err.contains("校验失败"), "{err}");
        assert!(err.contains("sha256 不匹配"), "{err}");
    }
}
