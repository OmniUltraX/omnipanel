//! 云厂商 Host 薄桥：解连接、Vault、prod 闸、audit；业务在 `omnipanel-cloud-aliyun`。

use omnipanel_cloud_aliyun::{
    driver_for, is_write_action, AliyunCloudDriver, AliyunCredentials, CloudAccountSnapshot,
    CloudAction, CloudActionResult, CloudCertificateItem, CloudDomainItem, CloudEcsInstance,
    CloudOssBucket, CloudProviderDriver, CloudRegion, CloudResourceDetail, CloudResourceFilter,
    CloudResourceRow, CloudSwasInstance, PLUGIN_ID_ALIYUN,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{AuditEntry, Connection, ConnectionKind, Vault};
use serde::Deserialize;
use tauri::State;

use crate::commands::proxy::build_http_client_for_url;
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudConfig {
    #[serde(default = "default_provider")]
    provider: String,
    #[serde(default)]
    plugin_id: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    regions: Vec<String>,
    #[serde(default, alias = "access_key_id")]
    access_key_id: String,
    #[serde(default, alias = "access_key_secret")]
    access_key_secret: String,
}

fn default_provider() -> String {
    "aliyun".into()
}

fn empty_cloud_config() -> CloudConfig {
    CloudConfig {
        provider: default_provider(),
        plugin_id: String::new(),
        region: String::new(),
        regions: Vec::new(),
        access_key_id: String::new(),
        access_key_secret: String::new(),
    }
}

fn parse_cloud_config(connection: &Connection) -> CloudConfig {
    serde_json::from_str(&connection.config).unwrap_or_else(|_| empty_cloud_config())
}

fn normalize_regions(regions: &[String], legacy: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for r in regions {
        let id = r.trim();
        if id.is_empty() || !seen.insert(id.to_string()) {
            continue;
        }
        out.push(id.to_string());
    }
    let legacy = legacy.trim();
    if !legacy.is_empty() && seen.insert(legacy.to_string()) {
        out.push(legacy.to_string());
    }
    out
}

fn effective_region(cfg: &CloudConfig, override_region: Option<&str>) -> String {
    if let Some(r) = override_region.map(str::trim).filter(|s| !s.is_empty()) {
        return r.to_string();
    }
    let regions = normalize_regions(&cfg.regions, &cfg.region);
    regions
        .into_iter()
        .next()
        .unwrap_or_else(|| "cn-hangzhou".into())
}

fn plugin_id_of(cfg: &CloudConfig) -> Result<String, OmniError> {
    let raw = if !cfg.plugin_id.trim().is_empty() {
        cfg.plugin_id.as_str()
    } else {
        cfg.provider.as_str()
    };
    omnipanel_cloud_aliyun::resolve_plugin_id(raw)
}

pub(crate) fn cloud_secret_ref(connection_id: &str) -> String {
    format!("cloud-secret-{connection_id}")
}

/// 将 AccessKeySecret 写入 Vault，并从 config 清除明文。
pub(crate) fn normalize_cloud_connection(
    mut connection: Connection,
) -> Result<Connection, OmniError> {
    if connection.kind != ConnectionKind::Cloud {
        return Ok(connection);
    }
    let mut cfg = parse_cloud_config(&connection);
    let id = connection.id.clone();
    if !cfg.access_key_secret.trim().is_empty() {
        let cred_ref = cloud_secret_ref(&id);
        Vault::store(&cred_ref, cfg.access_key_secret.trim())?;
        connection.credential_ref = Some(cred_ref);
        cfg.access_key_secret.clear();
    } else if connection.credential_ref.is_none() {
        if Vault::get(&cloud_secret_ref(&id))
            .ok()
            .is_some_and(|s| !s.is_empty())
        {
            connection.credential_ref = Some(cloud_secret_ref(&id));
        }
    }
    let regions = normalize_regions(&cfg.regions, &cfg.region);
    let plugin_id = plugin_id_of(&cfg).unwrap_or_else(|_| PLUGIN_ID_ALIYUN.to_string());
    connection.config = serde_json::to_string(&serde_json::json!({
        "pluginId": plugin_id,
        "provider": cfg.provider.trim().to_ascii_lowercase(),
        "regions": regions,
        "region": regions.first().map(String::as_str).unwrap_or(""),
        "accessKeyId": cfg.access_key_id.trim(),
    }))
    .unwrap_or(connection.config);
    Ok(connection)
}

fn resolve_credentials(
    connection: &Connection,
    secret_override: Option<&str>,
) -> Result<(String, AliyunCredentials, CloudConfig), OmniError> {
    if connection.kind != ConnectionKind::Cloud {
        return Err(OmniError::invalid_input("不是云厂商连接"));
    }
    let cfg: CloudConfig = serde_json::from_str(&connection.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "云厂商配置解析失败").with_cause(e.to_string())
    })?;
    let plugin_id = plugin_id_of(&cfg)?;
    let _ = driver_for(&plugin_id)?;
    let access_key_id = cfg.access_key_id.trim().to_string();
    if access_key_id.is_empty() {
        return Err(OmniError::invalid_input("请填写 AccessKey ID"));
    }
    let secret = secret_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .or_else(|| {
            let from_cfg = cfg.access_key_secret.trim();
            if from_cfg.is_empty() {
                None
            } else {
                Some(from_cfg.to_string())
            }
        })
        .or_else(|| {
            connection
                .credential_ref
                .as_deref()
                .and_then(|r| Vault::get(r).ok())
                .filter(|s| !s.is_empty())
        })
        .or_else(|| Vault::get(&cloud_secret_ref(&connection.id)).ok())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| OmniError::invalid_input("请填写 AccessKey Secret"))?;

    Ok((
        plugin_id,
        AliyunCredentials {
            access_key_id,
            access_key_secret: secret,
            region: effective_region(&cfg, None),
            regions: normalize_regions(&cfg.regions, &cfg.region),
        },
        cfg,
    ))
}

async fn load_connection(state: &AppState, connection_id: &str) -> Result<Connection, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .get_connection(connection_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "云账户不存在"))
}

async fn http_for_aliyun(state: &AppState, endpoint: &str) -> Result<reqwest::Client, OmniError> {
    let proxy = state.proxy_config.lock().await.clone();
    build_http_client_for_url(endpoint, &proxy, std::time::Duration::from_secs(30))
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn audit_cloud_action(
    state: &AppState,
    conn: &Connection,
    plugin_id: &str,
    action: &str,
    resource_id: &str,
    status: &str,
) {
    let entry = AuditEntry {
        ts: now_ms(),
        action: "cloud.invoke".into(),
        target: conn.id.clone(),
        env_tag: conn.env_tag.clone(),
        risk: if is_write_action(action) {
            "high".into()
        } else {
            "medium".into()
        },
        status: status.into(),
        detail: format!("pluginId={plugin_id} action={action} resource={resource_id}"),
    };
    if let Ok(store) = state.storage.try_lock() {
        let _ = store.append_audit(&entry);
    }
}

fn require_prod_confirm(conn: &Connection, action: &CloudAction) -> Result<(), OmniError> {
    if !is_write_action(&action.name) {
        return Ok(());
    }
    if conn.env_tag.trim().eq_ignore_ascii_case("prod") && !action.confirmed {
        return Err(OmniError::invalid_input("生产环境写操作需要确认"));
    }
    Ok(())
}

/// 测试云账户连通性。`secret` 可传表单明文；为空时读 Vault。
#[tauri::command]
#[specta::specta]
pub async fn cloud_test(
    state: State<'_, AppState>,
    connection: Connection,
    secret: Option<String>,
) -> Result<String, OmniError> {
    let (_plugin_id, creds, _) = resolve_credentials(&connection, secret.as_deref())?;
    let http = http_for_aliyun(&state, "https://sts.aliyuncs.com/").await?;
    AliyunCloudDriver.test_account(&creds, &http).await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_list_regions(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<CloudRegion>, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, creds, cfg) = resolve_credentials(&conn, None)?;
    let configured = normalize_regions(&cfg.regions, &cfg.region);
    let http = http_for_aliyun(&state, "https://ecs.aliyuncs.com/").await?;
    AliyunCloudDriver
        .list_regions(&creds, &http, &configured)
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_account(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<CloudAccountSnapshot, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, creds, _) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(&state, "https://sts.aliyuncs.com/").await?;
    AliyunCloudDriver.get_account(&creds, &http).await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_list_resources(
    state: State<'_, AppState>,
    connection_id: String,
    capability: String,
    filter: Option<CloudResourceFilter>,
) -> Result<Vec<CloudResourceRow>, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, creds, _) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(&state, "https://ecs.aliyuncs.com/").await?;
    AliyunCloudDriver
        .list_resources(
            &creds,
            &http,
            &capability,
            &filter.unwrap_or_default(),
        )
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_get_resource(
    state: State<'_, AppState>,
    connection_id: String,
    capability: String,
    resource_id: String,
    region_id: Option<String>,
) -> Result<CloudResourceDetail, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, creds, _) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(&state, "https://ecs.aliyuncs.com/").await?;
    AliyunCloudDriver
        .get_resource(
            &creds,
            &http,
            &capability,
            &resource_id,
            region_id.as_deref().unwrap_or(""),
        )
        .await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_invoke_action(
    state: State<'_, AppState>,
    connection_id: String,
    action: CloudAction,
) -> Result<CloudActionResult, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (plugin_id, creds, _) = resolve_credentials(&conn, None)?;
    if let Err(err) = require_prod_confirm(&conn, &action) {
        audit_cloud_action(
            &state,
            &conn,
            &plugin_id,
            &action.name,
            &action.resource_id,
            "blocked",
        );
        return Err(err);
    }
    let http = http_for_aliyun(&state, "https://ecs.aliyuncs.com/").await?;
    match AliyunCloudDriver
        .invoke_action(&creds, &http, &action)
        .await
    {
        Ok(result) => {
            audit_cloud_action(
                &state,
                &conn,
                &plugin_id,
                &action.name,
                &action.resource_id,
                "success",
            );
            Ok(result)
        }
        Err(err) => {
            audit_cloud_action(
                &state,
                &conn,
                &plugin_id,
                &action.name,
                &action.resource_id,
                "failed",
            );
            Err(err)
        }
    }
}

/// 过渡：产品级列表，内部仍走同一客户端。前端主路径请用 `cloud_list_resources`。
#[tauri::command]
#[specta::specta]
pub async fn cloud_list_oss(
    state: State<'_, AppState>,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudOssBucket>, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, mut creds, _) = resolve_credentials(&conn, None)?;
    if let Some(r) = region.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        creds.region = r.to_string();
    }
    let http = http_for_aliyun(&state, "https://oss.aliyuncs.com/").await?;
    creds.list_oss_buckets(&http).await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_list_swas(
    state: State<'_, AppState>,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudSwasInstance>, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, mut creds, _) = resolve_credentials(&conn, None)?;
    if let Some(r) = region.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        creds.region = r.to_string();
    }
    let http = http_for_aliyun(&state, "https://swas.aliyuncs.com/").await?;
    creds.list_swas_instances(&http).await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_list_domains(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<CloudDomainItem>, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, creds, _) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(&state, "https://domain.aliyuncs.com/").await?;
    creds.list_domains(&http).await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_list_ecs(
    state: State<'_, AppState>,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudEcsInstance>, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, mut creds, _) = resolve_credentials(&conn, None)?;
    if let Some(r) = region.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        creds.region = r.to_string();
    }
    let http = http_for_aliyun(&state, "https://ecs.aliyuncs.com/").await?;
    creds.list_ecs_instances(&http).await
}

#[tauri::command]
#[specta::specta]
pub async fn cloud_list_certs(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<CloudCertificateItem>, OmniError> {
    let conn = load_connection(&state, &connection_id).await?;
    let (_plugin_id, creds, _) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(&state, "https://cas.aliyuncs.com/").await?;
    creds.list_certificates(&http).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prod_write_requires_confirm() {
        let conn = Connection {
            id: "c1".into(),
            kind: ConnectionKind::Cloud,
            name: "prod".into(),
            group: String::new(),
            env_tag: "prod".into(),
            tags: vec![],
            config: "{}".into(),
            credential_ref: None,
            created_at: 0,
            updated_at: 0,
        };
        let mut action = CloudAction {
            name: "stop".into(),
            resource_id: "i-1".into(),
            capability: "compute".into(),
            region_id: "cn-hangzhou".into(),
            confirmed: false,
        };
        assert!(require_prod_confirm(&conn, &action).is_err());
        action.confirmed = true;
        assert!(require_prod_confirm(&conn, &action).is_ok());
    }

    #[test]
    fn non_prod_write_skips_confirm() {
        let conn = Connection {
            id: "c1".into(),
            kind: ConnectionKind::Cloud,
            name: "dev".into(),
            group: String::new(),
            env_tag: "dev".into(),
            tags: vec![],
            config: "{}".into(),
            credential_ref: None,
            created_at: 0,
            updated_at: 0,
        };
        let action = CloudAction {
            name: "stop".into(),
            resource_id: "i-1".into(),
            ..Default::default()
        };
        assert!(require_prod_confirm(&conn, &action).is_ok());
    }
}
