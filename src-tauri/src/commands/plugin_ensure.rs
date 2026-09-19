//! 按本机资源反查缺件插件并分级安装（同步收尾）。

use std::collections::{BTreeSet, HashSet};

use omnipanel_error::OmniError;
use omnipanel_plugin::PluginKind;
use omnipanel_store::{ConnectionKind, Storage};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::dbx_catalog::plugin_dbx_install;
use crate::commands::marketplace::{
    OFFICIAL_SOURCE_ID, lookup_market_plugin, plugin_install_version,
};
use crate::commands::official_catalog::{lookup_official_download, plugin_official_install};
use crate::state::AppState;

const PANEL_ID_BT: &str = "omni.panel.bt";
const PANEL_ID_1PANEL: &str = "omni.panel.1panel";
const PANEL_ID_HESTIA: &str = "omni.panel.hestia";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnsureRequest {
    #[serde(default)]
    pub approve_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnsureItem {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnsurePendingItem {
    pub id: String,
    pub name: String,
    pub kind: PluginKind,
    pub source_id: String,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnsureFailItem {
    pub id: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PluginEnsureResult {
    pub skipped: Vec<PluginEnsureItem>,
    pub installed: Vec<PluginEnsureItem>,
    pub pending_confirm: Vec<PluginEnsurePendingItem>,
    pub failed: Vec<PluginEnsureFailItem>,
    pub not_found: Vec<PluginEnsureItem>,
}

/// 模块快照落地后：收集本机资源所需插件并按信任分级安装。
#[tauri::command]
#[specta::specta]
pub async fn plugin_ensure_from_resources(
    state: State<'_, AppState>,
    request: PluginEnsureRequest,
) -> Result<PluginEnsureResult, OmniError> {
    let approve: HashSet<String> = request
        .approve_ids
        .into_iter()
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty())
        .collect();
    let ids = collect_required_plugin_ids(&state).await?;
    let mut result = PluginEnsureResult {
        skipped: Vec::new(),
        installed: Vec::new(),
        pending_confirm: Vec::new(),
        failed: Vec::new(),
        not_found: Vec::new(),
    };
    let plugins_root = state.plugin_packages_dir.clone();

    for id in ids {
        if plugin_present(&state, &id).await {
            result.skipped.push(PluginEnsureItem {
                name: id.clone(),
                id,
            });
            continue;
        }

        let official = lookup_official_download(plugins_root.as_deref(), &id);
        if official.is_some() || looks_official_download(&id) {
            match plugin_official_install(state.clone(), id.clone()).await {
                Ok(item) => {
                    let catalog_name = official
                        .as_ref()
                        .map(|(name, _)| name.as_str())
                        .unwrap_or("");
                    result.installed.push(PluginEnsureItem {
                        id: item.id,
                        name: display_name(&id, catalog_name),
                    });
                    continue;
                }
                Err(err) => {
                    let msg = err.to_string();
                    if official.is_none() && is_official_miss(&msg) {
                        // 种子/缓存未命中时再试 DBX / 市场。
                    } else {
                        result
                            .failed
                            .push(PluginEnsureFailItem { id, message: msg });
                        continue;
                    }
                }
            }
        }

        if let Some(key) = dbx_key_from_plugin_id(&id) {
            match plugin_dbx_install(state.clone(), key).await {
                Ok(item) => {
                    result.installed.push(PluginEnsureItem {
                        id: item.id,
                        name: display_name(&id, ""),
                    });
                    continue;
                }
                Err(err) => {
                    let msg = err.to_string();
                    if !is_catalog_miss(&msg) {
                        result
                            .failed
                            .push(PluginEnsureFailItem { id, message: msg });
                        continue;
                    }
                }
            }
        }

        if let Some(market) = lookup_market_plugin(&state, &id).await {
            let silent = market.source_id == OFFICIAL_SOURCE_ID || approve.contains(&id);
            if silent {
                match plugin_install_version(state.clone(), id.clone(), None, true).await {
                    Ok(item) => result.installed.push(PluginEnsureItem {
                        id: item.id,
                        name: display_name(&id, &market.name),
                    }),
                    Err(err) => result.failed.push(PluginEnsureFailItem {
                        id,
                        message: err.to_string(),
                    }),
                }
            } else {
                result.pending_confirm.push(PluginEnsurePendingItem {
                    id: id.clone(),
                    name: display_name(&id, &market.name),
                    kind: market.kind,
                    source_id: market.source_id,
                    permissions: market.permissions,
                });
            }
            continue;
        }

        result.not_found.push(PluginEnsureItem {
            name: id.clone(),
            id,
        });
    }

    Ok(result)
}

async fn plugin_present(state: &State<'_, AppState>, id: &str) -> bool {
    let registry = state.plugin_registry.lock().await;
    registry.get(id).is_some()
}

async fn collect_required_plugin_ids(state: &AppState) -> Result<Vec<String>, OmniError> {
    let mut ids = BTreeSet::new();
    {
        let storage = state.storage.lock().await;
        collect_from_storage(&storage, &mut ids)?;
    }
    for db in state.db_connections.list()? {
        if let Some(id) = plugin_id_from_db_type(&db.db_type) {
            ids.insert(id);
        }
    }
    Ok(ids.into_iter().collect())
}

fn collect_from_storage(storage: &Storage, ids: &mut BTreeSet<String>) -> Result<(), OmniError> {
    for conn in storage.list_connections()? {
        if let Some(id) = plugin_id_from_connection(conn.kind, &conn.config) {
            ids.insert(id);
        }
    }
    for key in storage.ks_config_list_source_keys()? {
        if let Some(id) = plugin_id_from_ks_source_key(&key) {
            ids.insert(id);
        }
    }
    Ok(())
}

pub(crate) fn plugin_id_from_connection(kind: ConnectionKind, config: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(config).ok()?;
    match kind {
        ConnectionKind::Service | ConnectionKind::Cloud => {
            let raw = value
                .get("pluginId")
                .and_then(|v| v.as_str())
                .or_else(|| value.get("provider").and_then(|v| v.as_str()))?;
            normalize_plugin_id(raw)
        }
        ConnectionKind::Panel => {
            let raw = value.get("serviceType")?.as_str()?.trim();
            if raw.is_empty() {
                return None;
            }
            Some(canonical_panel_plugin_id(raw))
        }
        _ => None,
    }
}

pub(crate) fn plugin_id_from_db_type(db_type: &str) -> Option<String> {
    let key = db_type.trim().to_ascii_lowercase();
    if key.is_empty() {
        return None;
    }
    if omnipanel_db::FirstPartyEngine::from_db_type(&key).is_some() {
        return None;
    }
    Some(format!("omni.engine.{}", canonicalize_engine_key(&key)))
}

pub(crate) fn plugin_id_from_ks_source_key(source_key: &str) -> Option<String> {
    let rest = source_key.strip_prefix("plugin:")?;
    let plugin_id = rest
        .split_once(':')
        .map(|(head, _)| head)
        .unwrap_or(rest)
        .trim();
    if plugin_id.is_empty() {
        None
    } else {
        Some(plugin_id.to_string())
    }
}

fn normalize_plugin_id(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if let Some(aliased) = cloud_alias(&lower) {
        return Some(aliased.to_string());
    }
    if lower.starts_with("omni.") {
        return Some(lower);
    }
    None
}

fn cloud_alias(raw: &str) -> Option<&'static str> {
    match raw {
        "aliyun" => Some("omni.cloud.aliyun"),
        "tencent" | "qcloud" => Some("omni.cloud.tencent"),
        "huawei" | "hwc" | "hwcloud" => Some("omni.cloud.huawei"),
        "aws" => Some("omni.cloud.aws"),
        "azure" => Some("omni.cloud.azure"),
        "digitalocean" | "do" => Some("omni.cloud.digitalocean"),
        "gcp" | "google" | "googlecloud" => Some("omni.cloud.gcp"),
        "bandwagon" | "bwh" | "banwagong" => Some("omni.cloud.bandwagon"),
        _ => None,
    }
}

fn canonical_panel_plugin_id(service_type: &str) -> String {
    match service_type.trim().to_ascii_lowercase().as_str() {
        "bt" | "baota" | PANEL_ID_BT => PANEL_ID_BT.to_string(),
        "1panel" | "onepanel" | PANEL_ID_1PANEL => PANEL_ID_1PANEL.to_string(),
        "hestia" | "hestiacp" | PANEL_ID_HESTIA => PANEL_ID_HESTIA.to_string(),
        other => other.to_string(),
    }
}

fn canonicalize_engine_key(key: &str) -> &str {
    match key {
        "dm" => "dameng",
        "orcl" => "oracle",
        "opengauss" => "gaussdb",
        other => other,
    }
}

fn dbx_key_from_plugin_id(plugin_id: &str) -> Option<String> {
    let rest = plugin_id.strip_prefix("omni.engine.")?;
    if rest.is_empty() {
        return None;
    }
    if omnipanel_db::FirstPartyEngine::from_plugin_id(plugin_id).is_some() {
        return None;
    }
    Some(rest.to_string())
}

fn display_name(id: &str, catalog_name: &str) -> String {
    let name = catalog_name.trim();
    if name.is_empty() {
        id.to_string()
    } else {
        name.to_string()
    }
}

fn looks_official_download(id: &str) -> bool {
    id.starts_with("omni.cloud.")
        || id.starts_with("omni.module.")
        || id.starts_with("omni.panel.")
        || id.starts_with("omni.knowledge.")
}

fn is_catalog_miss(message: &str) -> bool {
    message.contains("目录没有")
        || message.contains("not in catalog")
        || message.contains("没有 driver")
}

fn is_official_miss(message: &str) -> bool {
    is_catalog_miss(message)
        || message.contains("官方目录没有")
        || message.contains("官方目录缺少下载地址")
        || message.contains("无需下载")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_and_cloud_plugin_ids() {
        assert_eq!(
            plugin_id_from_connection(
                ConnectionKind::Service,
                r#"{"pluginId":"omni.module.nacos","host":"127.0.0.1"}"#
            )
            .as_deref(),
            Some("omni.module.nacos")
        );
        assert_eq!(
            plugin_id_from_connection(ConnectionKind::Cloud, r#"{"pluginId":"aliyun"}"#).as_deref(),
            Some("omni.cloud.aliyun")
        );
        assert_eq!(
            plugin_id_from_connection(ConnectionKind::Cloud, r#"{"provider":"aliyun"}"#).as_deref(),
            Some("omni.cloud.aliyun")
        );
        assert_eq!(
            plugin_id_from_connection(ConnectionKind::Cloud, r#"{"provider":"tencent"}"#)
                .as_deref(),
            Some("omni.cloud.tencent")
        );
        assert_eq!(
            plugin_id_from_connection(ConnectionKind::Ssh, r#"{"pluginId":"omni.module.nacos"}"#),
            None
        );
    }

    #[test]
    fn panel_aliases() {
        assert_eq!(
            plugin_id_from_connection(ConnectionKind::Panel, r#"{"serviceType":"bt"}"#).as_deref(),
            Some(PANEL_ID_BT)
        );
        assert_eq!(
            plugin_id_from_connection(ConnectionKind::Panel, r#"{"serviceType":"1panel"}"#)
                .as_deref(),
            Some(PANEL_ID_1PANEL)
        );
        assert_eq!(
            plugin_id_from_connection(ConnectionKind::Panel, r#"{"serviceType":""}"#),
            None
        );
    }

    #[test]
    fn db_type_skips_first_party_and_canonicalizes() {
        assert_eq!(plugin_id_from_db_type("mysql"), None);
        assert_eq!(plugin_id_from_db_type("postgres"), None);
        assert_eq!(
            plugin_id_from_db_type("oracle").as_deref(),
            Some("omni.engine.oracle")
        );
        assert_eq!(
            plugin_id_from_db_type("dm").as_deref(),
            Some("omni.engine.dameng")
        );
    }

    #[test]
    fn ks_source_key() {
        assert_eq!(
            plugin_id_from_ks_source_key("plugin:omni.knowledge.siyuan:vault").as_deref(),
            Some("omni.knowledge.siyuan")
        );
        assert_eq!(plugin_id_from_ks_source_key("siyuan"), None);
        assert_eq!(plugin_id_from_ks_source_key("plugin:"), None);
    }

    #[test]
    fn official_seed_marks_nacos_downloadable() {
        let found =
            crate::commands::official_catalog::lookup_official_download(None, "omni.module.nacos");
        assert!(
            found.is_some(),
            "bundled registry should list nacos as download"
        );
        assert!(
            crate::commands::official_catalog::lookup_official_download(None, "omni.engine.mysql")
                .is_none()
        );
        assert!(
            crate::commands::official_catalog::lookup_official_download(None, "omni.cloud.aliyun")
                .is_some(),
            "bundled registry should list cloud vendors as download"
        );
    }
}
