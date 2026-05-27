use std::collections::HashMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// HTTP request configuration from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequestConfig {
    pub method: String,
    pub url: String,
    pub headers: HashMap<String, String>,
    pub query_params: HashMap<String, String>,
    pub body: Option<String>,
    pub body_type: Option<String>,
    pub auth_type: Option<String>,
    pub auth_value: Option<String>,
    pub timeout_ms: Option<u64>,
}

/// HTTP response returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub time_ms: u64,
    pub size_bytes: usize,
    pub content_type: String,
}

/// Execute an HTTP request and return the response.
pub async fn execute_request(config: HttpRequestConfig) -> Result<HttpResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(config.timeout_ms.unwrap_or(30_000)))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| format!("Failed to create HTTP client: {e}"))?;

    let method = config.method.to_uppercase();
    let mut req = match method.as_str() {
        "GET" => client.get(&config.url),
        "POST" => client.post(&config.url),
        "PUT" => client.put(&config.url),
        "PATCH" => client.patch(&config.url),
        "DELETE" => client.delete(&config.url),
        "HEAD" => client.head(&config.url),
        "OPTIONS" => client.request(reqwest::Method::OPTIONS, &config.url),
        _ => return Err(format!("Unsupported HTTP method: {method}")),
    };

    // Add query params
    if !config.query_params.is_empty() {
        req = req.query(
            &config
                .query_params
                .iter()
                .collect::<Vec<(&String, &String)>>(),
        );
    }

    // Add headers
    for (key, value) in &config.headers {
        req = req.header(key.as_str(), value.as_str());
    }

    // Add auth
    if let (Some(auth_type), Some(auth_value)) = (&config.auth_type, &config.auth_value) {
        match auth_type.as_str() {
            "Bearer Token" => {
                req = req.header("Authorization", format!("Bearer {auth_value}"));
            }
            "Basic Auth" => {
                req = req.header("Authorization", format!("Basic {auth_value}"));
            }
            "API Key" => {
                req = req.header("X-API-Key", auth_value.as_str());
            }
            _ => {}
        }
    }

    // Add body
    if let Some(body) = &config.body {
        let content_type = config.body_type.as_deref().unwrap_or("application/json");
        req = req.header("Content-Type", content_type);
        req = req.body(body.clone());
    }

    let start = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| format!("HTTP request failed: {e}"))?;
    let elapsed = start.elapsed().as_millis() as u64;

    let status = resp.status().as_u16();
    let status_text = resp
        .status()
        .canonical_reason()
        .unwrap_or("Unknown")
        .to_string();

    let mut headers = HashMap::new();
    for (key, value) in resp.headers() {
        if let Ok(v) = value.to_str() {
            headers.insert(key.to_string(), v.to_string());
        }
    }

    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/plain")
        .to_string();

    let body = resp
        .text()
        .await
        .map_err(|e| format!("Failed to read response body: {e}"))?;

    let size_bytes = body.len();

    Ok(HttpResponse {
        status,
        status_text,
        headers,
        body,
        time_ms: elapsed,
        size_bytes,
        content_type,
    })
}
