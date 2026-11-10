//! Browser authentication: opaque, expiring HttpOnly sessions, never public API keys.
use crate::server::AppCtx;
use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

const COOKIE: &str = "omnipanel_session";
const TTL: Duration = Duration::from_secs(8 * 60 * 60);

pub(crate) struct WebAuth {
    key: Option<String>,
    sessions: Mutex<HashMap<String, Instant>>,
}
impl WebAuth {
    pub(crate) fn new(key: Option<String>) -> Self {
        Self {
            key: key.filter(|k| !k.trim().is_empty()),
            sessions: Mutex::new(HashMap::new()),
        }
    }
    fn key_matches(&self, candidate: &str) -> bool {
        self.key.as_ref().is_some_and(|key| {
            key.len() == candidate.len()
                && key
                    .bytes()
                    .zip(candidate.bytes())
                    .fold(0u8, |diff, (a, b)| diff | (a ^ b))
                    == 0
        })
    }
    pub(crate) fn authorized(&self, headers: &HeaderMap) -> bool {
        if self.key.is_none() {
            return true;
        }
        if headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .is_some_and(|v| self.key_matches(v))
        {
            return true;
        }
        let Some(token) = session_cookie(headers) else {
            return false;
        };
        self.sessions
            .lock()
            .unwrap()
            .get(token)
            .is_some_and(|expires| *expires > Instant::now())
    }
    fn issue(&self) -> Result<String, getrandom::Error> {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes)?;
        let token = hex::encode(bytes);
        let mut sessions = self.sessions.lock().unwrap();
        sessions.retain(|_, expires| *expires > Instant::now());
        if sessions.len() >= 256 {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, t)| **t)
                .map(|(k, _)| k.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(token.clone(), Instant::now() + TTL);
        Ok(token)
    }
}
fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .find_map(|part| part.trim().strip_prefix("omnipanel_session="))
}

/// Same-origin only, including WebSocket upgrades. CLI requests without Origin use bearer auth.
/// Reverse proxies must preserve Host; no wildcard CORS or trusted forwarded-host headers.
pub(crate) fn origin_allowed(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    if std::env::var("OMNIPANEL_SECURE_COOKIE").as_deref() == Ok("1") && url.scheme() != "https" {
        return false;
    }
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return false;
    }
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Ok(target) = url::Url::parse(&format!("{}://{host}", url.scheme())) else {
        return false;
    };
    url.host_str() == target.host_str()
        && url.port_or_known_default() == target.port_or_known_default()
}
pub(crate) async fn origin_guard(request: Request, next: Next) -> Response {
    if request.uri().path().starts_with("/ipc/") && !origin_allowed(request.headers()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let ipc = request.uri().path().starts_with("/ipc/");
    let response = next.run(request).await;
    if ipc { no_store(response) } else { response }
}
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
pub(crate) async fn status(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    no_store(Json(serde_json::json!({"required":ctx.auth.key.is_some(), "authenticated":ctx.auth.authorized(&headers)})).into_response())
}
#[derive(Deserialize)]
pub(crate) struct Login {
    api_key: String,
}
pub(crate) async fn login(
    State(ctx): State<AppCtx>,
    headers: HeaderMap,
    Json(login): Json<Login>,
) -> Response {
    if ctx.auth.key.is_none() {
        return no_store(Json(serde_json::json!({"authenticated":true})).into_response());
    }
    if login.api_key.len() > 4096 || !ctx.auth.key_matches(&login.api_key) {
        tokio::time::sleep(Duration::from_millis(300)).await;
        return no_store(StatusCode::UNAUTHORIZED.into_response());
    }
    let Ok(token) = ctx.auth.issue() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let secure = std::env::var("OMNIPANEL_SECURE_COOKIE").as_deref() == Ok("1")
        || headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.starts_with("https://"));
    let cookie = format!(
        "{COOKIE}={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={}{}",
        TTL.as_secs(),
        if secure { "; Secure" } else { "" }
    );
    let mut response = no_store(Json(serde_json::json!({"authenticated":true})).into_response());
    response
        .headers_mut()
        .insert(header::SET_COOKIE, cookie.parse().unwrap());
    response
}
pub(crate) async fn logout(State(ctx): State<AppCtx>, headers: HeaderMap) -> Response {
    if let Some(token) = session_cookie(&headers) {
        ctx.auth.sessions.lock().unwrap().remove(token);
    }
    let mut response = no_store(StatusCode::NO_CONTENT.into_response());
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
            .parse()
            .unwrap(),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bearer_and_opaque_session_auth() {
        let auth = WebAuth::new(Some("synthetic-test-key".into()));
        let mut h = HeaderMap::new();
        assert!(!auth.authorized(&h));
        h.insert(header::AUTHORIZATION, "Bearer wrong".parse().unwrap());
        assert!(!auth.authorized(&h));
        h.insert(
            header::AUTHORIZATION,
            "Bearer synthetic-test-key".parse().unwrap(),
        );
        assert!(auth.authorized(&h));
        h.clear();
        let token = auth.issue().unwrap();
        assert_ne!(token, "synthetic-test-key");
        h.insert(header::COOKIE, format!("{COOKIE}={token}").parse().unwrap());
        assert!(auth.authorized(&h));
        auth.sessions
            .lock()
            .unwrap()
            .insert(token, Instant::now() - Duration::from_secs(1));
        assert!(!auth.authorized(&h));
    }
    #[test]
    fn browser_origins_are_exact_and_no_wildcard() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, "localhost:8899".parse().unwrap());
        assert!(origin_allowed(&h));
        for origin in ["http://localhost:8899", "https://localhost:8899"] {
            h.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(origin_allowed(&h));
        }
        for origin in [
            "null",
            "https://evil.example",
            "http://localhost:8898",
            "http://localhost:8899.evil.example",
            "http://user@localhost:8899",
        ] {
            h.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(!origin_allowed(&h), "{origin}");
        }
    }
}
