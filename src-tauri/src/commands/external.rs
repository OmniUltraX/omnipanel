//! 外部插件（Rubick/uTools 系 npm 包）：判定与转换桥接。
//!
//! - `plugin_external_analyze_npm(npm, version)`：拉取 packument → 下载
//!   tarball → 验 integrity → 解包 → [`analyze_external_entries`]，返回 verdict。
//! - `plugin_external_convert_npm(npm, version)`：runnable 时转换打标准包
//!   并走 [`install_plugin_from_path`] 安装（dev 未签名放行，release 拒绝，
//!   与“第三方未审核”语义一致）。
//! - Rubick 源条目禁止走版本直装（tarball 非 `.omni-plugin`）：
//!   [`refuse_external_artifact`]，一律走 convert 流程。

use omnipanel_error::OmniError;
use omnipanel_plugin::PluginListItem;
use omnipanel_plugin_pkg::{
    ExternalCmd, analyze_external_entries, unpack_npm_tarball,
};
use omnipanel_store::AuditEntry;
use serde::{Deserialize, Serialize};
use specta::Type;
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use tauri::State;

use crate::commands::marketplace::verify_download_bytes;
use crate::commands::plugin::install_plugin_from_path;
use crate::state::AppState;

/// Rubick 第三方源 id（市场合并视图来源标记；直装拒绝）。
pub(crate) const RUBICK_SOURCE_ID: &str = "rubick";

const NPM_REGISTRY: &str = "https://registry.npmjs.org";
const FETCH_TIMEOUT_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCmdDto {
    pub kind: String,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalFeatureDto {
    pub code: String,
    pub explain: String,
    pub cmds: Vec<ExternalCmdDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalVerdictDto {
    pub npm: String,
    pub version: String,
    pub runnable: bool,
    pub reasons: Vec<String>,
    pub plugin_name: String,
    pub features: Vec<ExternalFeatureDto>,
    pub main_entry: Option<String>,
}

fn dto_from_verdict(
    npm: &str,
    version: &str,
    verdict: &omnipanel_plugin_pkg::ExternalVerdict,
) -> ExternalVerdictDto {
    ExternalVerdictDto {
        npm: npm.to_string(),
        version: version.to_string(),
        runnable: verdict.runnable,
        reasons: verdict.reasons.clone(),
        plugin_name: verdict.plugin_name.clone(),
        features: verdict
            .features
            .iter()
            .map(|f| ExternalFeatureDto {
                code: f.code.clone(),
                explain: f.explain.clone(),
                cmds: f
                    .cmds
                    .iter()
                    .map(|c| match c {
                        ExternalCmd::Keyword(k) => ExternalCmdDto {
                            kind: "keyword".into(),
                            label: k.clone(),
                        },
                        ExternalCmd::Match { kind, label } => ExternalCmdDto {
                            kind: kind.clone(),
                            label: label.clone(),
                        },
                    })
                    .collect(),
            })
            .collect(),
        main_entry: verdict.main_entry.clone(),
    }
}

/// npm 包名校验：`[@scope/]name`，拒绝 URL/路径穿越/空白。
fn validate_npm_name(npm: &str) -> Result<String, OmniError> {
    let name = npm.trim();
    if name.is_empty() || name.len() > 214 {
        return Err(OmniError::invalid_input("npm 包名非法"));
    }
    if name.contains("://") || name.contains("..") || name.chars().any(char::is_whitespace) {
        return Err(OmniError::invalid_input("npm 包名非法"));
    }
    let ok = name.chars().all(|c| {
        c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '/' | '@' | '~')
    });
    if !ok {
        return Err(OmniError::invalid_input("npm 包名非法"));
    }
    if name.starts_with('@') && name.matches('/').count() != 1 {
        return Err(OmniError::invalid_input("npm 包名非法"));
    }
    Ok(name.to_string())
}

fn validate_version(version: &str) -> Result<String, OmniError> {
    let version = version.trim();
    if version.is_empty() || version.len() > 64 {
        return Err(OmniError::invalid_input("版本号非法"));
    }
    semver::Version::parse(version)
        .map_err(|_| OmniError::invalid_input(format!("版本号非法: {version}")))?;
    Ok(version.to_string())
}

#[derive(Debug, Deserialize)]
struct NpmDist {
    #[serde(default)]
    tarball: String,
    #[serde(default)]
    integrity: String,
}

#[derive(Debug, Deserialize)]
struct NpmVersionDoc {
    #[serde(default)]
    dist: Option<NpmDist>,
}

fn packument_url(npm: &str, version: &str) -> String {
    // scope 的 `/` 必须编码（`@scope%2fname`），裸 `@` 保留。
    let encoded = npm.replace('/', "%2F");
    format!("{NPM_REGISTRY}/{encoded}/{version}")
}

async fn fetch_json(
    client: &reqwest::Client,
    url: &str,
    what: &str,
) -> Result<serde_json::Value, OmniError> {
    let response = client
        .get(url)
        .header("User-Agent", "OmniPanel-external")
        .header("Accept", "application/json")
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("拉取{what}失败: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "拉取{what} HTTP {}",
            response.status()
        )));
    }
    response
        .json()
        .await
        .map_err(|e| OmniError::connection(format!("拉取{what} JSON 非法: {e}")))
}

async fn download_tarball(
    client: &reqwest::Client,
    url: &str,
    npm: &str,
) -> Result<Vec<u8>, OmniError> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(OmniError::invalid_input(format!("tarball 地址非法: {npm}")));
    }
    let response = client
        .get(url)
        .header("User-Agent", "OmniPanel-external")
        .timeout(std::time::Duration::from_secs(FETCH_TIMEOUT_SECS))
        .send()
        .await
        .map_err(|e| OmniError::connection(format!("下载 {npm} 失败: {e}")))?;
    if !response.status().is_success() {
        return Err(OmniError::connection(format!(
            "下载 {npm} HTTP {}",
            response.status()
        )));
    }
    response
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| OmniError::connection(format!("读取 {npm} 失败: {e}")))
}

/// 已验 tarball 缓存（`npm@version → bytes`，上限 5 包轮转）：analyze→convert
/// 同一包免二次下载；存入前已验 integrity，内存不可变故复用不再重验。
fn tarball_cache() -> &'static Mutex<BTreeMap<String, Vec<u8>>> {
    static CACHE: OnceLock<Mutex<BTreeMap<String, Vec<u8>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(BTreeMap::new()))
}

const TARBALL_CACHE_MAX: usize = 5;

/// 拉取并校验 tarball（命中缓存则免下载）。返回（字节，`npm@version`）。
async fn fetch_verified_tarball(
    client: &reqwest::Client,
    npm: &str,
    version: &str,
) -> Result<(Vec<u8>, String), OmniError> {
    let target = format!("{npm}@{version}");
    if let Ok(guard) = tarball_cache().lock() {
        if let Some(bytes) = guard.get(&target) {
            return Ok((bytes.clone(), target));
        }
    }
    let doc: NpmVersionDoc = serde_json::from_value(
        fetch_json(client, &packument_url(npm, version), "npm 元数据").await?,
    )
    .map_err(|e| OmniError::connection(format!("npm 元数据非法: {e}")))?;
    let dist = doc
        .dist
        .filter(|d| !d.tarball.trim().is_empty())
        .ok_or_else(|| OmniError::not_found(format!("npm 无可用 tarball: {target}")))?;
    let bytes = download_tarball(client, dist.tarball.trim(), npm).await?;
    verify_download_bytes(&bytes, &target, "", dist.integrity.trim())?;
    if let Ok(mut guard) = tarball_cache().lock() {
        while guard.len() >= TARBALL_CACHE_MAX {
            let first = guard.keys().next().cloned();
            match first {
                Some(key) => {
                    guard.remove(&key);
                }
                None => break,
            }
        }
        guard.insert(target.clone(), bytes.clone());
    }
    Ok((bytes, target))
}

fn audit_external(state: &AppState, action: &str, target: &str, status: &str, detail: String) {
    let entry = AuditEntry {
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        action: action.to_string(),
        target: target.to_string(),
        env_tag: "-".into(),
        risk: "medium".into(),
        status: status.to_string(),
        detail: detail.chars().take(200).collect(),
    };
    if let Ok(store) = state.storage.try_lock() {
        let _ = store.append_audit(&entry);
    }
}

fn pkg_err_to_omni(err: omnipanel_plugin_pkg::PkgError) -> OmniError {
    OmniError::invalid_input(err.to_string())
}

/// 拉取并判定（纯静态，不执行包内代码）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_external_analyze_npm(
    state: State<'_, AppState>,
    npm: String,
    version: String,
) -> Result<ExternalVerdictDto, OmniError> {
    let npm = validate_npm_name(&npm)?;
    let version = validate_version(&version)?;
    let outcome: Result<ExternalVerdictDto, OmniError> = async {
        let (bytes, _target) = fetch_verified_tarball(&state.plugin_http, &npm, &version).await?;
        let entries = tokio::task::spawn_blocking(move || unpack_npm_tarball(&bytes))
            .await
            .map_err(|e| OmniError::internal(e.to_string()))?
            .map_err(pkg_err_to_omni)?;
        let verdict =
            analyze_external_entries(&entries).map_err(pkg_err_to_omni)?;
        Ok(dto_from_verdict(&npm, &version, &verdict))
    }
    .await;
    let target = format!("{npm}@{version}");
    let (status, detail) = match &outcome {
        Ok(dto) => (
            "success",
            format!("runnable={} reasons={}", dto.runnable, dto.reasons.len()),
        ),
        Err(err) => ("failed", err.to_string()),
    };
    audit_external(&state, "plugin.external.analyze", &target, status, detail);
    outcome
}

/// 判定可转时转换并安装（dev 未签名放行，release 拒绝——第三方未审核语义）。
#[tauri::command]
#[specta::specta]
pub async fn plugin_external_convert_npm(
    state: State<'_, AppState>,
    npm: String,
    version: String,
) -> Result<PluginListItem, OmniError> {
    let npm = validate_npm_name(&npm)?;
    let version = validate_version(&version)?;
    let outcome: Result<PluginListItem, OmniError> = async {
        let (bytes, _target) =
            fetch_verified_tarball(&state.plugin_http, &npm, &version).await?;
        let (verdict, entries) = tokio::task::spawn_blocking(move || {
            let entries = unpack_npm_tarball(&bytes)?;
            let verdict = analyze_external_entries(&entries)?;
            Ok::<_, omnipanel_plugin_pkg::PkgError>((verdict, entries))
        })
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?
        .map_err(pkg_err_to_omni)?;
        let out_entries = omnipanel_plugin_pkg::convert_external_to_entries(
            &verdict, &entries, &npm, &version,
        )
        .map_err(pkg_err_to_omni)?;
        let tmp = std::env::temp_dir().join(format!(
            "omni-external-{}-{}-{}.omni-plugin",
            npm.replace(['@', '/', '.'], "_"),
            version.replace('.', "_"),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0)
        ));
        let pack_path = tmp.clone();
        tokio::task::spawn_blocking(move || {
            omnipanel_plugin_pkg::pack_dir_with_entries(out_entries, &pack_path, None)
        })
        .await
        .map_err(|e| OmniError::internal(e.to_string()))?
        .map_err(pkg_err_to_omni)?;
        let result = install_plugin_from_path(&state, tmp.clone()).await;
        let _ = tokio::fs::remove_file(&tmp).await;
        result
    }
    .await;
    let target = format!("{npm}@{version}");
    let (status, detail) = match &outcome {
        Ok(item) => ("success", format!("installed {}", item.id)),
        Err(err) => ("failed", err.to_string()),
    };
    audit_external(&state, "plugin.external.convert", &target, status, detail);
    outcome
}

/// Rubick 源条目禁止走版本直装（tarball 非 `.omni-plugin`），一律走 convert。
pub(crate) fn refuse_external_artifact(plugin_id: &str) -> OmniError {
    OmniError::invalid_input(format!(
        "第三方外部插件请走转换安装（plugin_external_convert_npm）: {plugin_id}"
    ))
}

/// 说明：曾计划直拉 `rubick-database` 索引（gitcode），实测文件 API 需鉴权、
/// raw 页为 SPA 壳，不可靠；已下线该通道，统一走 npm search + curated 种子。

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSearchItem {
    pub npm: String,
    pub version: String,
    pub description: String,
    #[serde(default)]
    pub keywords: Vec<String>,
}

/// npm 市场搜索（仅元数据，不下载）。live 补齐 curated 种子之外的发现入口。
#[tauri::command]
#[specta::specta]
pub async fn plugin_external_search_npm(
    state: State<'_, AppState>,
    query: String,
    max: Option<u32>,
) -> Result<Vec<ExternalSearchItem>, OmniError> {
    let query = query.trim().to_string();
    if query.is_empty() || query.len() > 128 {
        return Err(OmniError::invalid_input("搜索关键词非法"));
    }
    let size = max.unwrap_or(10).clamp(1, 50);
    let url = format!(
        "{NPM_REGISTRY}/-/v1/search?text={}&size={size}",
        urlencoding_like(&query),
    );
    let value = fetch_json(&state.plugin_http, &url, "npm 搜索").await?;
    let mut out = Vec::new();
    if let Some(objects) = value.get("objects").and_then(|v| v.as_array()) {
        for obj in objects {
            let package = obj.get("package");
            let name = package
                .and_then(|p| p.get("name"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if name.is_empty() || validate_npm_name(name).is_err() {
                continue;
            }
            let keywords: Vec<String> = package
                .and_then(|p| p.get("keywords"))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .take(12)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            out.push(ExternalSearchItem {
                npm: name.to_string(),
                version: package
                    .and_then(|p| p.get("version"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                description: package
                    .and_then(|p| p.get("description"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                keywords,
            });
            if out.len() >= size as usize {
                break;
            }
        }
    }
    audit_external(
        &state,
        "plugin.external.search",
        &query,
        "success",
        format!("hits={}", out.len()),
    );
    Ok(out)
}

/// 最小 URL 编码（query 参数用；npm 名本身由调用方保证合法）。
fn urlencoding_like(raw: &str) -> String {
    let mut out = String::new();
    for b in raw.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b' ') {
            if b == b' ' {
                out.push('+');
            } else {
                out.push(b as char);
            }
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_name_validation() {
        assert!(validate_npm_name("ip-config-rubick-plugin").is_ok());
        assert!(validate_npm_name("@scope/name").is_ok());
        assert!(validate_npm_name("https://evil/x").is_err());
        assert!(validate_npm_name("../escape").is_err());
        assert!(validate_npm_name("@scope/a/b").is_err());
        assert!(validate_npm_name("has space").is_err());
        assert!(validate_version("1.2.3").is_ok());
        assert!(validate_version("not-a-version").is_err());
    }

    #[test]
    fn search_query_encoding() {
        assert_eq!(urlencoding_like("rubick plugin"), "rubick+plugin");
        assert_eq!(urlencoding_like("a/b"), "a%2Fb");
    }

    #[test]
    fn packument_url_encodes_scope() {
        assert_eq!(
            packument_url("@scope/name", "1.0.0"),
            "https://registry.npmjs.org/@scope%2Fname/1.0.0"
        );
        assert_eq!(
            packument_url("plain-name", "0.0.1"),
            "https://registry.npmjs.org/plain-name/0.0.1"
        );
    }
}
