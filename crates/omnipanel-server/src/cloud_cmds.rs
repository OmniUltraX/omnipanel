//! 云厂商（阿里云）只读资源命令。

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{Connection, ConnectionKind, Vault};
use serde::Deserialize;

use crate::cloud::aliyun::{
    AliyunCredentials, CloudCertificateItem, CloudDomainItem, CloudEcsInstance, CloudOssBucket,
    CloudSwasInstance,
};
use crate::http_client::{build_http_client_for_url, proxy_config};
use crate::state::ServerState;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudConfig {
    #[serde(default = "default_provider")]
    provider: String,
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

fn effective_region(cfg: &CloudConfig, override_region: Option<&str>) -> String {
    if let Some(r) = override_region.map(str::trim).filter(|s| !s.is_empty()) {
        return r.to_string();
    }
    normalize_regions(&cfg.regions, &cfg.region)
        .into_iter()
        .next()
        .unwrap_or_else(|| "cn-hangzhou".into())
}

pub(crate) fn cloud_secret_ref(connection_id: &str) -> String {
    format!("cloud-secret-{connection_id}")
}

pub(crate) fn normalize_cloud_connection(mut connection: Connection) -> Result<Connection, OmniError> {
    if connection.kind != ConnectionKind::Cloud {
        return Ok(connection);
    }
    let mut cfg: CloudConfig = serde_json::from_str(&connection.config).unwrap_or(CloudConfig {
        provider: default_provider(),
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
    connection.config = serde_json::to_string(&serde_json::json!({
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
) -> Result<AliyunCredentials, OmniError> {
    if connection.kind != ConnectionKind::Cloud {
        return Err(OmniError::invalid_input("不是云厂商连接"));
    }
    let cfg: CloudConfig = serde_json::from_str(&connection.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "云厂商配置解析失败").with_cause(e.to_string())
    })?;
    if !cfg.provider.eq_ignore_ascii_case("aliyun") && !cfg.provider.is_empty() {
        return Err(OmniError::invalid_input(format!(
            "暂不支持云厂商: {}",
            cfg.provider
        )));
    }
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

    Ok(AliyunCredentials {
        access_key_id,
        access_key_secret: secret,
        region: effective_region(&cfg, None),
    })
}

async fn load_connection(state: &ServerState, connection_id: &str) -> Result<Connection, OmniError> {
    let storage = state.storage.lock().await;
    storage
        .get_connection(connection_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "云账户不存在"))
}

async fn http_for_aliyun(endpoint: &str) -> Result<reqwest::Client, OmniError> {
    let proxy = proxy_config();
    build_http_client_for_url(endpoint, &proxy, std::time::Duration::from_secs(30)).map_err(|e| {
        OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e)
    })
}

pub async fn cloud_test(
    state: &ServerState,
    connection: Connection,
    secret: Option<String>,
) -> Result<String, OmniError> {
    let creds = resolve_credentials(&connection, secret.as_deref())?;
    let http = http_for_aliyun("https://sts.aliyuncs.com/").await?;
    creds.test_credentials(&http).await
}

pub async fn cloud_list_oss(
    state: &ServerState,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudOssBucket>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let mut creds = resolve_credentials(&conn, None)?;
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
    let mut creds = resolve_credentials(&conn, None)?;
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
    let creds = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun("https://domain.aliyuncs.com/").await?;
    creds.list_domains(&http).await
}

pub async fn cloud_list_ecs(
    state: &ServerState,
    connection_id: String,
    region: Option<String>,
) -> Result<Vec<CloudEcsInstance>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let mut creds = resolve_credentials(&conn, None)?;
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

pub async fn cloud_list_certs(
    state: &ServerState,
    connection_id: String,
) -> Result<Vec<CloudCertificateItem>, OmniError> {
    let conn = load_connection(state, &connection_id).await?;
    let creds = resolve_credentials(&conn, None)?;
    let http = http_for_aliyun("https://cas.aliyuncs.com/").await?;
    creds.list_certificates(&http).await
}
