//! 云厂商 Host 命令：经 `omnipanel-cloud` 分发到各厂商 Driver。

use omnipanel_cloud::{
    default_region, get_account, get_metrics, get_resource, http_probe_url, invoke_action,
    is_write_action, list_regions, list_resources, query_logs, test_account, CloudAccountSnapshot,
    CloudAction, CloudActionResult, CloudLogPage, CloudLogQuery, CloudMetricQuery, CloudMetricSeries,
    CloudRegion, CloudResourceDetail, CloudResourceFilter, CloudResourceRow, PLUGIN_ID_ALIYUN,
    PLUGIN_ID_TENCENT,
};
use omnipanel_cloud_aliyun::{
    AliyunCredentials, CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket,
    CloudSwasInstance,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{AuditEntry, Connection, ConnectionKind, Vault};
use serde::Deserialize;

use crate::http_client::{build_http_client_for_url, proxy_config};
use crate::state::ServerState;

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

fn effective_region(cfg: &CloudConfig, plugin_id: &str, override_region: Option<&str>) -> String {
    if let Some(r) = override_region.map(str::trim).filter(|s| !s.is_empty()) {
        return r.to_string();
    }
    normalize_regions(&cfg.regions, &cfg.region)
        .into_iter()
        .next()
        .unwrap_or_else(|| default_region(plugin_id).to_string())
}

pub(crate) fn cloud_secret_ref(connection_id: &str) -> String {
    format!("cloud-secret-{connection_id}")
}

#[allow(dead_code)]
/// 桌面端保存已内联同类逻辑；保留供服务端统一规范化云连接（Secret 入 Vault、config 脱敏）复用。
pub(crate) fn normalize_cloud_connection(
    mut connection: Connection,
) -> Result<Connection, OmniError> {
    if connection.kind != ConnectionKind::Cloud {
        return Ok(connection);
    }
    let mut cfg: CloudConfig = serde_json::from_str(&connection.config).unwrap_or(CloudConfig {
        provider: default_provider(),
        plugin_id: String::new(),
        region: String::new(),
        regions: Vec::new(),
        access_key_id: String::new(),
        access_key_secret: String::new(),
    });
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
    let plugin_id = omnipanel_cloud::resolve_plugin_id(if cfg.plugin_id.trim().is_empty() {
        cfg.provider.as_str()
    } else {
        cfg.plugin_id.as_str()
    })
    .unwrap_or_else(|_| PLUGIN_ID_ALIYUN.to_string());
    let provider = if plugin_id == PLUGIN_ID_TENCENT {
        "tencent"
    } else if plugin_id == PLUGIN_ID_ALIYUN {
        "aliyun"
    } else {
        plugin_id.as_str()
    };
    connection.config = serde_json::to_string(&serde_json::json!({
        "pluginId": plugin_id,
        "provider": provider,
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
) -> Result<(String, AliyunCredentials), OmniError> {
    if connection.kind != ConnectionKind::Cloud {
        return Err(OmniError::invalid_input("不是云厂商连接"));
    }
    let cfg: CloudConfig = serde_json::from_str(&connection.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "云厂商配置解析失败").with_cause(e.to_string())
    })?;
    let plugin_raw = if cfg.plugin_id.trim().is_empty() {
        cfg.provider.as_str()
    } else {
        cfg.plugin_id.as_str()
    };
    let plugin_id = omnipanel_cloud::resolve_plugin_id(plugin_raw)?;
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
        plugin_id.clone(),
        AliyunCredentials {
            access_key_id,
            access_key_secret: secret,
            region: effective_region(&cfg, &plugin_id, None),
            regions: normalize_regions(&cfg.regions, &cfg.region),
        },
    ))
}

async fn load_connection(
    state: &ServerState,
    connection_id: &str,
) -> Result<Connection, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .get_connection(connection_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "云账户不存在"))
}

async fn http_for_aliyun(endpoint: &str) -> Result<reqwest::Client, OmniError> {
    let proxy = proxy_config();
    build_http_client_for_url(endpoint, &proxy, std::time::Duration::from_secs(30))
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))
}

pub async fn cloud_test(
    _state: &ServerState,
    connection: Connection,
    secret: Option<String>,
) -> Result<String, OmniError> {
    let (plugin_id, creds) = resolve_credentials(&connection, secret.as_deref())?;
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    test_account(&plugin_id, &creds, &http).await
}

pub async fn cloud_list_oss(
    state: &ServerState,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudOssBucket>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (_, mut creds) = resolve_credentials(&conn, None)?;
    if let Some(r) = region.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        creds.region = r.to_string();
    }
    let http = http_for_aliyun("https://oss.aliyuncs.com/").await?;
    creds.list_oss_buckets(&http).await
}

pub async fn cloud_list_swas(
    state: &ServerState,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudSwasInstance>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (_, mut creds) = resolve_credentials(&conn, None)?;
    if let Some(r) = region.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        creds.region = r.to_string();
    }
    let region = if creds.region.is_empty() {
        "cn-hangzhou"
    } else {
        creds.region.as_str()
    };
    let endpoint = format!("https://swas.{region}.aliyuncs.com/");
    let http = http_for_aliyun(&endpoint).await?;
    creds.list_swas_instances(&http).await
}

pub async fn cloud_list_domains(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<CloudDomainItem>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (_plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun("https://domain.aliyuncs.com/").await?;
    creds.list_domains(&http).await
}

pub async fn cloud_list_ecs(
    state: &ServerState,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudEcsInstance>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (_, mut creds) = resolve_credentials(&conn, None)?;
    if let Some(r) = region.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        creds.region = r.to_string();
    }
    let region = if creds.region.is_empty() {
        "cn-hangzhou"
    } else {
        creds.region.as_str()
    };
    let endpoint = format!("https://ecs.{region}.aliyuncs.com/");
    let http = http_for_aliyun(&endpoint).await?;
    creds.list_ecs_instances(&http).await
}

pub async fn cloud_list_regions(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<CloudRegion>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (plugin_id, creds) = resolve_credentials(&conn, None)?;
    let cfg: CloudConfig = serde_json::from_str(&conn.config).unwrap_or(CloudConfig {
        provider: default_provider(),
        plugin_id: String::new(),
        region: String::new(),
        regions: Vec::new(),
        access_key_id: String::new(),
        access_key_secret: String::new(),
    });
    let configured = normalize_regions(&cfg.regions, &cfg.region);
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    list_regions(&plugin_id, &creds, &http, &configured).await
}

pub async fn cloud_get_account(
    state: &ServerState,
    connection_id: String,
) -> Result<CloudAccountSnapshot, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    get_account(&plugin_id, &creds, &http).await
}

pub async fn cloud_list_certs(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<CloudCertificateItem>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (_plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun("https://cas.aliyuncs.com/").await?;
    creds.list_certificates(&http).await
}

fn plugin_id_of(cfg: &CloudConfig) -> Result<String, OmniError> {
    let raw = if !cfg.plugin_id.trim().is_empty() {
        cfg.plugin_id.as_str()
    } else {
        cfg.provider.as_str()
    };
    omnipanel_cloud::resolve_plugin_id(raw)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn require_write_presence(
    state: &ServerState,
    connection_id: &str,
    action: &CloudAction,
) -> Result<(), OmniError> {
    if !is_write_action(&action.name) {
        return Ok(());
    }
    let target = omnipanel_presence::pipe_target(&[
        connection_id,
        &action.resource_id,
        &action.name,
    ]);
    omnipanel_presence::require_grant(
        &state.presence_tokens,
        action.presence_token.as_deref(),
        omnipanel_presence::ACTION_CLOUD_LIFECYCLE,
        &target,
    )
}

fn audit_cloud_action(
    state: &ServerState,
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

pub async fn cloud_list_resources(
    state: &ServerState,
    connection_id: String,
    capability: String,
    filter: Option<CloudResourceFilter>,
) -> Result<Vec<CloudResourceRow>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    list_resources(&plugin_id, &creds, &http, &capability, &filter.unwrap_or_default()).await
}

pub async fn cloud_get_resource(
    state: &ServerState,
    connection_id: String,
    capability: String,
    resource_id: String,
    region_id: Option<String>,
) -> Result<CloudResourceDetail, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    get_resource(
        &plugin_id,
        &creds,
        &http,
        &capability,
        &resource_id,
        region_id.as_deref().unwrap_or(""),
    )
    .await
}

pub async fn cloud_invoke_action(
    state: &ServerState,
    connection_id: String,
    action: CloudAction,
) -> Result<CloudActionResult, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let cfg = serde_json::from_str(&conn.config).unwrap_or(CloudConfig {
        provider: default_provider(),
        plugin_id: String::new(),
        region: String::new(),
        regions: Vec::new(),
        access_key_id: String::new(),
        access_key_secret: String::new(),
    });
    let plugin_id = plugin_id_of(&cfg).unwrap_or_else(|_| PLUGIN_ID_ALIYUN.to_string());
    if let Err(err) = require_write_presence(state, &connection_id, &action) {
        audit_cloud_action(state, &conn, &plugin_id, &action.name, &action.resource_id, "blocked");
        return Err(err);
    }
    let (plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    match invoke_action(&plugin_id, &creds, &http, &action).await
    {
        Ok(result) => {
            audit_cloud_action(state, &conn, &plugin_id, &action.name, &action.resource_id, "success");
            Ok(result)
        }
        Err(err) => {
            audit_cloud_action(state, &conn, &plugin_id, &action.name, &action.resource_id, "failed");
            Err(err)
        }
    }
}

pub async fn cloud_get_metrics(
    state: &ServerState,
    connection_id: String,
    capability: String,
    resource_id: String,
    region_id: Option<String>,
    query: Option<CloudMetricQuery>,
) -> Result<Vec<CloudMetricSeries>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    get_metrics(
        &plugin_id,
        &creds,
        &http,
        &capability,
        &resource_id,
        region_id.as_deref().unwrap_or(""),
        &query.unwrap_or_default(),
    )
    .await
}

pub async fn cloud_query_logs(
    state: &ServerState,
    connection_id: String,
    capability: String,
    resource_id: String,
    region_id: Option<String>,
    query: Option<CloudLogQuery>,
) -> Result<CloudLogPage, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let (plugin_id, creds) = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun(http_probe_url(&plugin_id)).await?;
    query_logs(
        &plugin_id,
        &creds,
        &http,
        &capability,
        &resource_id,
        region_id.as_deref().unwrap_or(""),
        &query.unwrap_or_default(),
    )
    .await
}
