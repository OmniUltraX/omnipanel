mod ddg;
mod exa;
mod jina;
mod zhihu;

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use omnipanel_store::{load_web_search_config, WebSearchBackend};
use serde_json::Value;
use tokio::sync::Mutex;
use tracing::info;

use super::common::{
    aggregate_errors, effective_proxy, BackendError, RequestCtx, SearchHit, SearchRequest,
    SearchScope, WebSecrets,
};
use omnipanel_store::{HttpProxyConfig, Storage};

pub use exa::search_exa;

#[async_trait]
pub trait SearchProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn is_available(&self, secrets: &WebSecrets) -> bool;
    async fn search(
        &self,
        req: &SearchRequest,
        ctx: &RequestCtx<'_>,
        secrets: &WebSecrets,
    ) -> Result<Vec<SearchHit>, BackendError>;
}

fn registry_entries() -> Vec<(&'static str, Box<dyn SearchProvider>)> {
    vec![
        ("zhihu", Box::new(zhihu::ZhihuSearch)),
        ("exa", Box::new(exa::ExaSearch)),
        ("ddg", Box::new(ddg::DdgSearch)),
        ("jina", Box::new(jina::JinaSearch)),
    ]
}

fn provider_by_id(id: &str) -> Option<Box<dyn SearchProvider>> {
    registry_entries()
        .into_iter()
        .find(|(name, _)| *name == id)
        .map(|(_, p)| p)
}

fn parse_search_args(args: &Value) -> Result<SearchRequest, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "query 不能为空".to_string())?
        .to_string();

    let max_from_args = args
        .get("max_results")
        .and_then(|v| v.as_u64())
        .unwrap_or(10)
        .clamp(1, 20) as usize;

    let scope = SearchScope::parse(args.get("scope").and_then(|v| v.as_str()));

    let max_results = if scope == SearchScope::Zhihu {
        max_from_args.clamp(1, 10)
    } else {
        max_from_args
    };

    Ok(SearchRequest {
        query,
        max_results,
        scope,
    })
}

async fn run_search(
    req: SearchRequest,
    proxy: Option<HttpProxyConfig>,
    force_zhihu: bool,
) -> Result<Vec<SearchHit>, String> {
    let config = load_web_search_config().map_err(|e| e.to_string())?;
    if !config.enabled {
        return Err("Web 搜索已在设置中禁用".to_string());
    }

    let proxy_cfg = effective_proxy(proxy.as_ref());
    let ctx = RequestCtx {
        proxy: &proxy_cfg,
        timeout: Duration::from_secs(30),
    };
    let secrets = WebSecrets::load();

    let backend = if force_zhihu {
        WebSearchBackend::Zhihu
    } else if req.scope == SearchScope::Zhihu {
        WebSearchBackend::Zhihu
    } else {
        WebSearchBackend::parse(&config.search.backend)
    };

    let mut req = req;
    if force_zhihu || req.scope == SearchScope::Zhihu {
        req.scope = SearchScope::Zhihu;
        req.max_results = req.max_results.clamp(1, 10);
    }

    match backend {
        WebSearchBackend::Auto => search_auto(&req, &ctx, &secrets, &config.search.auto_order).await,
        other => {
            let id = other.as_str();
            let Some(provider) = provider_by_id(id) else {
                return Err(format!("未知搜索后端: {id}"));
            };
            if !provider.is_available(&secrets) {
                return Err(format!("搜索后端 {id} 不可用（未配置凭据或网络受限）"));
            }
            provider
                .search(&req, &ctx, &secrets)
                .await
                .map_err(|e| e.to_string())
        }
    }
}

async fn search_auto(
    req: &SearchRequest,
    ctx: &RequestCtx<'_>,
    secrets: &WebSecrets,
    auto_order: &[String],
) -> Result<Vec<SearchHit>, String> {
    let mut errors: Vec<(String, BackendError)> = Vec::new();
    let started = std::time::Instant::now();

    for id in auto_order {
        let id = id.trim();
        if id.is_empty() {
            continue;
        }
        let Some(provider) = provider_by_id(id) else {
            errors.push((id.to_string(), BackendError::Config("未知后端".into())));
            continue;
        };
        if !provider.is_available(secrets) {
            info!(backend = id, "search auto: skip (unavailable)");
            errors.push((
                id.to_string(),
                BackendError::Config("未配置凭据".into()),
            ));
            continue;
        }
        match provider.search(req, ctx, secrets).await {
            Ok(hits) if !hits.is_empty() => {
                info!(
                    backend = id,
                    scope = ?req.scope,
                    count = hits.len(),
                    elapsed_ms = started.elapsed().as_millis(),
                    "search auto: ok"
                );
                return Ok(hits);
            }
            Ok(_) => {
                info!(backend = id, "search auto: empty results");
                errors.push((id.to_string(), BackendError::Parse("未返回结果".into())));
            }
            Err(err) => {
                info!(backend = id, error = %err, "search auto: fail");
                errors.push((id.to_string(), err));
            }
        }
    }

    Err(aggregate_errors("所有搜索后端均失败", &errors))
}

pub async fn dispatch(
    args: Value,
    _storage: Arc<Mutex<Storage>>,
    proxy: Option<HttpProxyConfig>,
) -> Result<(String, bool), String> {
    let req = parse_search_args(&args)?;
    let hits = run_search(req, proxy, false).await?;
    Ok((
        serde_json::to_string(&hits).unwrap_or_else(|_| "[]".to_string()),
        true,
    ))
}

pub async fn dispatch_zhihu_only(
    args: Value,
    storage: Arc<Mutex<Storage>>,
    proxy: Option<HttpProxyConfig>,
) -> Result<(String, bool), String> {
    let mut parsed = parse_search_args(&args)?;
    parsed.scope = SearchScope::Zhihu;
    parsed.max_results = parsed.max_results.clamp(1, 10);
    dispatch(
        serde_json::json!({
            "query": parsed.query,
            "max_results": parsed.max_results,
            "scope": "zhihu",
        }),
        storage,
        proxy,
    )
    .await
}

/// 供 IPC 测试：按后端 ID 执行单次搜索。
pub async fn test_provider(
    backend_id: &str,
    query: &str,
    max_results: usize,
    proxy: &HttpProxyConfig,
) -> Result<Vec<SearchHit>, BackendError> {
    let provider = provider_by_id(backend_id)
        .ok_or_else(|| BackendError::Config(format!("未知后端: {backend_id}")))?;
    let secrets = WebSecrets::load();
    if !provider.is_available(&secrets) {
        return Err(BackendError::Config("未配置凭据".into()));
    }
    let ctx = RequestCtx {
        proxy,
        timeout: Duration::from_secs(30),
    };
    let req = SearchRequest {
        query: query.to_string(),
        max_results,
        scope: SearchScope::Web,
    };
    provider.search(&req, &ctx, &secrets).await
}

/// 供 IPC auto 测试。
pub async fn search_auto_for_test(
    query: &str,
    max_results: usize,
    proxy: &HttpProxyConfig,
) -> Result<Vec<SearchHit>, String> {
    let config = load_web_search_config().map_err(|e| e.to_string())?;
    let ctx = RequestCtx {
        proxy,
        timeout: Duration::from_secs(30),
    };
    let secrets = WebSecrets::load();
    let req = SearchRequest {
        query: query.to_string(),
        max_results,
        scope: SearchScope::Web,
    };
    search_auto(&req, &ctx, &secrets, &config.search.auto_order).await
}
