//! Web 工具共享类型、HTTP 客户端与错误分类。

use std::fmt;
use std::time::Duration;

use omnipanel_store::{
    exa_api_key_configured, jina_api_key_configured, load_exa_api_key, load_jina_api_key,
    load_zhihu_secret, zhihu_secret_configured, HttpProxyConfig, JinaDomainMode,
};
use reqwest::Client;
use serde::Serialize;

const LOOPBACK_NO_PROXY: &str = "127.0.0.1,localhost,[::1],::1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetKind {
    Dns,
    Tls,
    Timeout,
    Connect,
    Proxy,
    Other,
}

#[derive(Debug, Clone)]
pub enum BackendError {
    Network {
        kind: NetKind,
        source: String,
    },
    Http {
        status: u16,
        body: String,
    },
    Auth(String),
    RateLimit {
        retry_after: Option<u64>,
    },
    Parse(String),
    Config(String),
}

impl BackendError {
    pub fn kind_label(&self) -> &'static str {
        match self {
            Self::Network { kind, .. } => match kind {
                NetKind::Dns => "dns",
                NetKind::Tls => "tls",
                NetKind::Timeout => "timeout",
                NetKind::Connect => "connect",
                NetKind::Proxy => "proxy",
                NetKind::Other => "network",
            },
            Self::Http { .. } => "http",
            Self::Auth(_) => "auth",
            Self::RateLimit { .. } => "rate_limit",
            Self::Parse(_) => "parse",
            Self::Config(_) => "config",
        }
    }

    pub fn is_retryable_network(&self) -> bool {
        matches!(
            self,
            Self::Network {
                kind: NetKind::Dns | NetKind::Tls | NetKind::Timeout | NetKind::Connect,
                ..
            }
        )
    }
}

impl fmt::Display for BackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Network { kind, source } => write!(f, "Network({kind:?}): {source}"),
            Self::Http { status, body } => {
                let snippet: String = body.chars().take(200).collect();
                write!(f, "HTTP {status}: {snippet}")
            }
            Self::Auth(msg) => write!(f, "Auth: {msg}"),
            Self::RateLimit { retry_after } => {
                write!(f, "RateLimit: retry_after={retry_after:?}")
            }
            Self::Parse(msg) => write!(f, "Parse: {msg}"),
            Self::Config(msg) => write!(f, "Config: {msg}"),
        }
    }
}

pub struct RequestCtx<'a> {
    pub proxy: &'a HttpProxyConfig,
    pub timeout: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct WebSecrets {
    pub zhihu: Option<String>,
    pub exa: Option<String>,
    pub jina: Option<String>,
}

impl WebSecrets {
    pub fn load() -> Self {
        Self {
            zhihu: load_zhihu_secret().ok().flatten(),
            exa: load_exa_api_key().ok().flatten(),
            jina: load_jina_api_key().ok().flatten(),
        }
    }

    pub fn zhihu_configured(&self) -> bool {
        self.zhihu
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
            || zhihu_secret_configured()
    }

    pub fn exa_configured(&self) -> bool {
        self.exa
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
            || exa_api_key_configured()
    }

    pub fn jina_configured(&self) -> bool {
        self.jina
            .as_ref()
            .is_some_and(|s| !s.trim().is_empty())
            || jina_api_key_configured()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchScope {
    Web,
    Zhihu,
}

impl SearchScope {
    pub fn parse(s: Option<&str>) -> Self {
        match s.map(str::trim).unwrap_or("web").to_ascii_lowercase().as_str() {
            "zhihu" => Self::Zhihu,
            _ => Self::Web,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SearchRequest {
    pub query: String,
    pub max_results: usize,
    pub scope: SearchScope,
}

#[derive(Debug, Clone)]
pub struct FetchRequest {
    pub url: String,
    pub format: String,
}

#[derive(Debug, Clone)]
pub struct FetchResult {
    pub url: String,
    pub content: String,
    pub backend: String,
}

pub fn jina_host(mode: JinaDomainMode, prefer_cn: bool) -> &'static str {
    match mode {
        JinaDomainMode::Cn => "jinaai.cn",
        JinaDomainMode::Ai => "jina.ai",
        JinaDomainMode::Auto => {
            if prefer_cn {
                "jinaai.cn"
            } else {
                "jina.ai"
            }
        }
    }
}

pub fn classify_reqwest_error(err: reqwest::Error) -> BackendError {
    if err.is_timeout() {
        return BackendError::Network {
            kind: NetKind::Timeout,
            source: err.to_string(),
        };
    }
    let msg = err.to_string().to_ascii_lowercase();
    let kind = if msg.contains("dns") || msg.contains("resolve") || msg.contains("name") {
        NetKind::Dns
    } else if msg.contains("tls") || msg.contains("ssl") || msg.contains("handshake") {
        NetKind::Tls
    } else if msg.contains("proxy") {
        NetKind::Proxy
    } else if msg.contains("connect") || msg.contains("connection") {
        NetKind::Connect
    } else {
        NetKind::Other
    };
    BackendError::Network {
        kind,
        source: err.to_string(),
    }
}

pub fn map_http_status(status: reqwest::StatusCode, body: &str) -> BackendError {
    let code = status.as_u16();
    if code == 401 || code == 403 {
        BackendError::Auth(format!("HTTP {code}: {body}"))
    } else if code == 429 {
        BackendError::RateLimit { retry_after: None }
    } else {
        BackendError::Http {
            status: code,
            body: body.chars().take(500).collect(),
        }
    }
}

fn loopback_no_proxy() -> Option<reqwest::NoProxy> {
    reqwest::NoProxy::from_string(LOOPBACK_NO_PROXY)
}

fn is_loopback_http_url(url: &str) -> bool {
    url::Url::parse(url)
        .ok()
        .and_then(|parsed| {
            parsed.host_str().map(|host| {
                let host = host.trim().trim_start_matches('[').trim_end_matches(']');
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<std::net::IpAddr>()
                        .map(|ip| ip.is_loopback())
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

pub fn build_http_client(
    url: &str,
    proxy: &HttpProxyConfig,
    timeout: Duration,
) -> Result<Client, BackendError> {
    let mut builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::limited(10))
        .user_agent("OmniPanel/1.0 (web-tools)");

    if is_loopback_http_url(url) {
        builder = builder.no_proxy();
    } else if proxy.enabled && !proxy.host.is_empty() {
        let proxy_url = format!("{}://{}:{}", proxy.protocol, proxy.host, proxy.port);
        let mut p = reqwest::Proxy::all(&proxy_url).map_err(|e| BackendError::Config(e.to_string()))?;
        if !proxy.username.is_empty() {
            p = p.basic_auth(&proxy.username, &proxy.password);
        }
        p = p.no_proxy(loopback_no_proxy());
        builder = builder.proxy(p);
    }

    builder
        .build()
        .map_err(|e| BackendError::Config(e.to_string()))
}

pub fn effective_proxy(override_proxy: Option<&HttpProxyConfig>) -> HttpProxyConfig {
    override_proxy
        .cloned()
        .or_else(|| omnipanel_store::load_http_proxy_config().ok())
        .unwrap_or_default()
}

pub fn aggregate_errors(prefix: &str, errors: &[(String, BackendError)]) -> String {
    if errors.is_empty() {
        return prefix.to_string();
    }
    let detail = errors
        .iter()
        .map(|(id, err)| format!("{id}({err})"))
        .collect::<Vec<_>>()
        .join(" | ");
    format!("{prefix}：{detail}")
}
