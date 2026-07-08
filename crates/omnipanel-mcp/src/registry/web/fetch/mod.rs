mod extract;
mod jina;
mod local;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use omnipanel_store::{load_web_search_config, FetchConfig, WebFetchBackend};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::info;

use super::common::{
    aggregate_errors, effective_proxy, BackendError, FetchRequest, FetchResult, RequestCtx,
    WebSecrets,
};
use omnipanel_store::{HttpProxyConfig, Storage};

pub use local::fetch_local;

#[async_trait]
pub trait FetchProvider: Send + Sync {
    fn id(&self) -> &'static str;
    async fn fetch(
        &self,
        req: &FetchRequest,
        ctx: &RequestCtx<'_>,
        secrets: &WebSecrets,
        fetch_cfg: &FetchConfig,
    ) -> Result<FetchResult, BackendError>;
}

fn provider_by_id(id: &str) -> Option<Box<dyn FetchProvider>> {
    match id {
        "local" => Some(Box::new(local::LocalFetch)),
        "jina" => Some(Box::new(jina::JinaFetch)),
        _ => None,
    }
}

fn parse_fetch_args(args: &Value) -> Result<FetchRequest, String> {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "url 不能为空".to_string())?
        .to_string();
    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("markdown")
        .to_string();
    Ok(FetchRequest { url, format })
}

async fn run_fetch_auto(
    req: &FetchRequest,
    ctx: &RequestCtx<'_>,
    secrets: &WebSecrets,
    fetch_cfg: &FetchConfig,
) -> Result<FetchResult, BackendError> {
    let order = ["local", "jina"];
    let mut errors: Vec<(String, BackendError)> = Vec::new();

    for id in order {
        let Some(provider) = provider_by_id(id) else {
            errors.push((id.to_string(), BackendError::Config("未知后端".into())));
            continue;
        };
        match provider.fetch(req, ctx, secrets, fetch_cfg).await {
            Ok(result) if !result.content.trim().is_empty() => {
                info!(backend = id, url = %req.url, "fetch auto: ok");
                return Ok(result);
            }
            Ok(_) => {
                info!(backend = id, "fetch auto: empty content");
                errors.push((id.to_string(), BackendError::Parse("内容为空".into())));
            }
            Err(err) => {
                info!(backend = id, error = %err, "fetch auto: fail");
                errors.push((id.to_string(), err));
            }
        }
    }

    Err(BackendError::Config(aggregate_errors("网页抓取失败", &errors)))
}

pub async fn dispatch(
    args: Value,
    _storage: Arc<Mutex<Storage>>,
    proxy: Option<HttpProxyConfig>,
) -> Result<(String, bool), String> {
    let config = load_web_search_config().map_err(|e| e.to_string())?;
    let req = parse_fetch_args(&args)?;
    let proxy_cfg = effective_proxy(proxy.as_ref());
    let ctx = RequestCtx {
        proxy: &proxy_cfg,
        timeout: Duration::from_secs(45),
    };
    let secrets = WebSecrets::load();
    let backend = WebFetchBackend::parse(&config.fetch.backend);

    let result = match backend {
        WebFetchBackend::Auto => run_fetch_auto(&req, &ctx, &secrets, &config.fetch).await,
        WebFetchBackend::Local => local::LocalFetch
            .fetch(&req, &ctx, &secrets, &config.fetch)
            .await,
        WebFetchBackend::Jina => match provider_by_id("jina") {
            Some(provider) => provider.fetch(&req, &ctx, &secrets, &config.fetch).await,
            None => Err(BackendError::Config("未知抓取后端".into())),
        },
    }
    .map_err(|e| e.to_string())?;

    Ok((
        serde_json::json!({ "url": result.url, "content": result.content, "backend": result.backend })
            .to_string(),
        true,
    ))
}

pub async fn test_fetch(
    url: &str,
    proxy: &HttpProxyConfig,
) -> Result<FetchResult, BackendError> {
    let config = load_web_search_config().map_err(|e| BackendError::Config(e.to_string()))?;
    let ctx = RequestCtx {
        proxy,
        timeout: Duration::from_secs(45),
    };
    let secrets = WebSecrets::load();
    let req = FetchRequest {
        url: url.to_string(),
        format: "markdown".into(),
    };
    run_fetch_auto(&req, &ctx, &secrets, &config.fetch).await
}
