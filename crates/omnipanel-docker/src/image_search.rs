//! 通过 daemon.json `registry-mirrors` 搜索镜像。
//!
//! Docker 的 `docker search` / Engine `/images/search` 固定访问 Docker Hub，
//! **不会**走 registry-mirrors。国内环境常见超时，因此优先用镜像站的
//! Hub 兼容搜索接口（`/v1/search`）。

use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::Deserialize;

use crate::model::DockerImageSearchResult;

const SEARCH_TIMEOUT: Duration = Duration::from_secs(12);

/// 从 daemon.json 文本解析 `registry-mirrors`。
pub fn parse_registry_mirrors(daemon_json: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(daemon_json) else {
        return Vec::new();
    };
    let Some(arr) = value.get("registry-mirrors").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(raw) = item.as_str() else {
            continue;
        };
        let normalized = normalize_mirror_base(raw);
        if normalized.is_empty() {
            continue;
        }
        if !out.iter().any(|existing| existing == &normalized) {
            out.push(normalized);
        }
    }
    out
}

fn normalize_mirror_base(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    }
}

#[derive(Debug, Deserialize)]
struct HubV1SearchResponse {
    #[serde(default)]
    results: Vec<HubV1SearchItem>,
}

#[derive(Debug, Deserialize)]
struct HubV1SearchItem {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    star_count: i64,
    #[serde(default)]
    pull_count: i64,
    #[serde(default)]
    is_official: bool,
    #[serde(default)]
    is_automated: bool,
}

#[derive(Debug, Deserialize)]
struct HubV2SearchResponse {
    #[serde(default)]
    results: Vec<HubV2SearchItem>,
}

#[derive(Debug, Deserialize)]
struct HubV2SearchItem {
    #[serde(default)]
    repo_name: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    short_description: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    star_count: i64,
    #[serde(default)]
    pull_count: i64,
    #[serde(default)]
    is_official: bool,
    #[serde(default)]
    is_automated: bool,
}

/// 按 registry-mirrors 顺序尝试 Hub 兼容搜索；全部失败则返回错误。
pub async fn search_via_registry_mirrors(
    mirrors: &[String],
    term: &str,
    limit: u32,
) -> OmniResult<Vec<DockerImageSearchResult>> {
    let term = term.trim();
    if term.is_empty() {
        return Ok(Vec::new());
    }
    if mirrors.is_empty() {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            "未配置 registry-mirrors，无法通过镜像站搜索",
        ));
    }

    let limit = limit.max(1).min(100);
    let client = reqwest::Client::builder()
        .timeout(SEARCH_TIMEOUT)
        .user_agent("OmniPanel/1.0 (docker-image-search)")
        .build()
        .map_err(|e| {
            OmniError::new(ErrorCode::Internal, "创建 HTTP 客户端失败").with_cause(e.to_string())
        })?;

    let mut errors: Vec<String> = Vec::new();
    for mirror in mirrors {
        match search_one_mirror(&client, mirror, term, limit).await {
            Ok(mut rows) => {
                // v1 通常无 pull_count：短超时尝试 Hub v2 补全（失败则忽略）
                enrich_pull_counts_from_hub_v2(&client, term, limit, &mut rows).await;
                return Ok(rows);
            }
            Err(err) => errors.push(format!("{mirror}: {err}")),
        }
    }

    Err(OmniError::new(
        ErrorCode::Connection,
        "通过 registry-mirrors 搜索镜像失败",
    )
    .with_cause(errors.join(" | ")))
}

async fn search_one_mirror(
    client: &reqwest::Client,
    mirror: &str,
    term: &str,
    limit: u32,
) -> OmniResult<Vec<DockerImageSearchResult>> {
    let base = mirror.trim_end_matches('/');
    // 1) Hub Index v1（多数公共加速器会代理）
    let v1_url = format!(
        "{base}/v1/search?q={}&n={limit}",
        urlencoding_encode(term)
    );
    match fetch_text(client, &v1_url).await {
        Ok(body) => {
            if let Ok(rows) = parse_hub_v1_search_body(&body, limit) {
                if !rows.is_empty() {
                    return Ok(rows);
                }
            }
        }
        Err(err) => {
            // 继续尝试 v2
            let _ = err;
        }
    }

    // 2) 部分镜像站 / Hub 兼容的 v2 search
    let v2_url = format!(
        "{base}/v2/search/repositories/?query={}&page_size={limit}",
        urlencoding_encode(term)
    );
    let body = fetch_text(client, &v2_url).await?;
    parse_hub_v2_search_body(&body, limit)
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> OmniResult<String> {
    let resp = client.get(url).send().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "请求镜像站失败").with_cause(e.to_string())
    })?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "读取镜像站响应失败").with_cause(e.to_string())
    })?;
    if !status.is_success() {
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("镜像站返回 HTTP {}", status.as_u16()),
        )
        .with_cause(body.chars().take(200).collect::<String>()));
    }
    Ok(body)
}

async fn enrich_pull_counts_from_hub_v2(
    client: &reqwest::Client,
    term: &str,
    limit: u32,
    rows: &mut [DockerImageSearchResult],
) {
    if rows.iter().all(|r| r.pull_count > 0) {
        return;
    }
    let url = format!(
        "https://hub.docker.com/v2/search/repositories/?query={}&page_size={limit}",
        urlencoding_encode(term)
    );
    let Ok(Ok(body)) =
        tokio::time::timeout(Duration::from_secs(6), fetch_text(client, &url)).await
    else {
        return;
    };
    let Ok(hub_rows) = parse_hub_v2_search_body(&body, limit) else {
        return;
    };
    for row in rows.iter_mut() {
        if row.pull_count > 0 {
            continue;
        }
        let key = normalize_repo_key(&row.name);
        if let Some(hit) = hub_rows.iter().find(|h| normalize_repo_key(&h.name) == key) {
            row.pull_count = hit.pull_count;
            if row.star_count <= 0 && hit.star_count > 0 {
                row.star_count = hit.star_count;
            }
        }
    }
}

fn normalize_repo_key(name: &str) -> String {
    let n = name.trim().to_ascii_lowercase();
    n.strip_prefix("library/").unwrap_or(&n).to_string()
}

fn parse_hub_v1_search_body(body: &str, limit: u32) -> OmniResult<Vec<DockerImageSearchResult>> {
    let parsed: HubV1SearchResponse = serde_json::from_str(body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析镜像站搜索结果失败").with_cause(e.to_string())
    })?;
    let limit = limit.max(1) as usize;
    let mut out = Vec::new();
    for item in parsed.results {
        let name = item.name.trim().to_string();
        if name.is_empty() {
            continue;
        }
        out.push(DockerImageSearchResult {
            name,
            description: item.description,
            star_count: item.star_count,
            pull_count: item.pull_count,
            is_official: item.is_official,
            is_automated: item.is_automated,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

fn parse_hub_v2_search_body(body: &str, limit: u32) -> OmniResult<Vec<DockerImageSearchResult>> {
    let parsed: HubV2SearchResponse = serde_json::from_str(body).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析 Hub v2 搜索结果失败").with_cause(e.to_string())
    })?;
    let limit = limit.max(1) as usize;
    let mut out = Vec::new();
    for item in parsed.results {
        let raw_name = {
            let repo = item.repo_name.trim();
            if !repo.is_empty() {
                repo
            } else {
                item.name.trim()
            }
        };
        // Hub 官方镜像常带 library/ 前缀，拉取时用短名更友好
        let name = raw_name
            .strip_prefix("library/")
            .unwrap_or(raw_name)
            .to_string();
        if name.is_empty() {
            continue;
        }
        let description = if !item.short_description.trim().is_empty() {
            item.short_description
        } else {
            item.description
        };
        out.push(DockerImageSearchResult {
            name,
            description,
            star_count: item.star_count,
            pull_count: item.pull_count,
            is_official: item.is_official,
            is_automated: item.is_automated,
        });
        if out.len() >= limit {
            break;
        }
    }
    Ok(out)
}

/// 极简 URL query 编码（仅编码搜索词必要字符）。
fn urlencoding_encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            ' ' => out.push('+'),
            _ => {
                for byte in ch.to_string().as_bytes() {
                    out.push_str(&format!("%{byte:02X}"));
                }
            }
        }
    }
    out
}

/// 有 mirrors 则走镜像站；否则执行 fallback。
pub async fn search_images_prefer_mirrors<F, Fut>(
    daemon_json: &str,
    term: &str,
    limit: u32,
    fallback: F,
) -> OmniResult<Vec<DockerImageSearchResult>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = OmniResult<Vec<DockerImageSearchResult>>>,
{
    let mirrors = parse_registry_mirrors(daemon_json);
    if mirrors.is_empty() {
        return fallback().await;
    }
    match search_via_registry_mirrors(&mirrors, term, limit).await {
        Ok(rows) => Ok(rows),
        Err(mirror_err) => {
            // 镜像站全失败时再降级 Hub（可能仍然超时，但给出完整 cause）
            match fallback().await {
                Ok(rows) if !rows.is_empty() => Ok(rows),
                Ok(_) => Err(mirror_err),
                Err(hub_err) => Err(OmniError::new(
                    ErrorCode::Connection,
                    "镜像站与 Docker Hub 搜索均失败",
                )
                .with_cause(format!("mirrors: {mirror_err}; hub: {hub_err}"))),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_mirrors_from_daemon_json() {
        let json = r#"{
            "registry-mirrors": [
                "https://docker.m.daocloud.io/",
                "docker.mirrors.ustc.edu.cn",
                "https://docker.m.daocloud.io"
            ]
        }"#;
        let mirrors = parse_registry_mirrors(json);
        assert_eq!(
            mirrors,
            vec![
                "https://docker.m.daocloud.io".to_string(),
                "https://docker.mirrors.ustc.edu.cn".to_string(),
            ]
        );
    }

    #[test]
    fn parse_hub_v1_body() {
        let body = r#"{
            "num_results": 1,
            "results": [
                {
                    "name": "nginx",
                    "description": "Official build",
                    "star_count": 100,
                    "is_official": true,
                    "is_automated": false
                }
            ]
        }"#;
        let rows = parse_hub_v1_search_body(body, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "nginx");
        assert!(rows[0].is_official);
        assert_eq!(rows[0].star_count, 100);
        assert_eq!(rows[0].pull_count, 0);
    }

    #[test]
    fn parse_hub_v2_body_with_pulls() {
        let body = r#"{
            "results": [
                {
                    "repo_name": "library/nginx",
                    "short_description": "Official build",
                    "star_count": 100,
                    "pull_count": 1000000000,
                    "is_official": true,
                    "is_automated": false
                }
            ]
        }"#;
        let rows = parse_hub_v2_search_body(body, 10).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].name, "nginx");
        assert_eq!(rows[0].pull_count, 1_000_000_000);
    }
}
