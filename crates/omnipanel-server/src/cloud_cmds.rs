//! 云厂商 Host 命令（Web）：连接规范化 / Secret 回显仍可用。
//! 业务调用（测连、列表、动作）依赖桌面端插件 L2；Web 暂无 QuickJS 运行时。

use omnipanel_cloud::{
    CloudAccountSnapshot, CloudAction, CloudActionResult, CloudLogPage, CloudLogQuery,
    CloudMetricQuery, CloudMetricSeries, CloudRegion, CloudResourceDetail, CloudResourceFilter,
    CloudResourceRow, PLUGIN_ID_ALIYUN, PLUGIN_ID_TENCENT, default_region,
    AliyunCredentials, CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket,
    CloudSwasInstance,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{Connection, ConnectionKind, Vault};
use serde::Deserialize;

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

fn web_cloud_unsupported() -> OmniError {
    OmniError::new(
        ErrorCode::Internal,
        "Web 版暂不支持云厂商插件（需桌面端 L2 QuickJS 运行时）",
    )
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

#[allow(dead_code)]
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

/// 编辑云账户表单：从 Vault 回显 AccessKey Secret（config 永不存明文）。
pub async fn cloud_resolve_secret(
    state: &ServerState,
    connection_id: String,
) -> Result<String, OmniError> {
    let connection_id = connection_id.trim();
    if connection_id.is_empty() {
        return Err(OmniError::invalid_input("连接 ID 不能为空"));
    }

    let conn = load_connection(state, connection_id).await?;
    if conn.kind != ConnectionKind::Cloud {
        return Err(OmniError::invalid_input("目标连接不是云厂商类型"));
    }

    let secret = conn
        .credential_ref
        .as_deref()
        .filter(|r| r.starts_with("cloud-secret-"))
        .and_then(|r| Vault::get(r).ok())
        .filter(|s| !s.trim().is_empty())
        .or_else(|| Vault::get(&cloud_secret_ref(connection_id)).ok())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            OmniError::invalid_input("未找到 AccessKey Secret，请重新填写并保存连接")
        })?;

    Ok(secret.trim().to_string())
}

pub async fn cloud_test(
    _state: &ServerState,
    _connection: Connection,
    _secret: Option<String>,
) -> Result<String, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_list_oss(
    _state: &ServerState,
    _connection_id: String,
    _region: Option<String>,
) -> Result<Vec<CloudOssBucket>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_list_swas(
    _state: &ServerState,
    _connection_id: String,
    _region: Option<String>,
) -> Result<Vec<CloudSwasInstance>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_list_domains(
    _state: &ServerState,
    _connection_id: String,
) -> Result<Vec<CloudDomainItem>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_list_ecs(
    _state: &ServerState,
    _connection_id: String,
    _region: Option<String>,
) -> Result<Vec<CloudEcsInstance>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_list_regions(
    _state: &ServerState,
    _connection_id: String,
) -> Result<Vec<CloudRegion>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_get_account(
    _state: &ServerState,
    _connection_id: String,
) -> Result<CloudAccountSnapshot, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_list_certs(
    _state: &ServerState,
    _connection_id: String,
) -> Result<Vec<CloudCertificateItem>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_list_resources(
    _state: &ServerState,
    _connection_id: String,
    _capability: String,
    _filter: Option<CloudResourceFilter>,
) -> Result<Vec<CloudResourceRow>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_get_resource(
    _state: &ServerState,
    _connection_id: String,
    _capability: String,
    _resource_id: String,
    _region_id: Option<String>,
) -> Result<CloudResourceDetail, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_invoke_action(
    _state: &ServerState,
    _connection_id: String,
    _action: CloudAction,
) -> Result<CloudActionResult, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_get_metrics(
    _state: &ServerState,
    _connection_id: String,
    _capability: String,
    _resource_id: String,
    _region_id: Option<String>,
    _query: Option<CloudMetricQuery>,
) -> Result<Vec<CloudMetricSeries>, OmniError> {
    Err(web_cloud_unsupported())
}

pub async fn cloud_query_logs(
    _state: &ServerState,
    _connection_id: String,
    _capability: String,
    _resource_id: String,
    _region_id: Option<String>,
    _query: Option<CloudLogQuery>,
) -> Result<CloudLogPage, OmniError> {
    Err(web_cloud_unsupported())
}
