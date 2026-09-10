//! 插件工程一键投稿（IDE P2）：组装 registry v2 片段 → GitHub issue。
//!
//! Token 只进钥匙串（`plugin:studio:github-token`），不入库、不进 audit、不回前端。
//! 每工程每 24h 最多 3 次成功投稿。

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_plugin::PluginManifest;
use omnipanel_plugin_pkg::devkey::dev_signing_key;
use omnipanel_plugin_pkg::{registry_plugin_from_dir, registry_plugin_from_packed};
use omnipanel_store::{AuditEntry, Storage, Vault, plugin_secret_ref};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::plugin_studio::project_dir;
use crate::state::AppState;

const STUDIO_SECRET_PLUGIN: &str = "studio";
const GITHUB_TOKEN_KEY: &str = "github-token";
const DEFAULT_REPO: &str = "OmniUltraX/omnipanel";
const SUBMIT_ACTION: &str = "plugin.submit";
const SUBMIT_LIMIT: usize = 3;
const SUBMIT_WINDOW_MS: i64 = 24 * 60 * 60 * 1000;
const DANGEROUS_PERMISSIONS: &[&str] = &["ssh:exec"];
const FRAGMENT_MARK: &str = "<!-- omnipanel-plugin-fragment -->";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmitPreview {
    pub title: String,
    pub body: String,
    pub repo: String,
    pub remaining: u32,
    #[specta(type = Option<f64>)]
    pub wait_ms: Option<i64>,
    pub has_token: bool,
    pub permissions: Vec<String>,
    pub needs_manual_review: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SubmitResult {
    pub url: String,
    #[specta(type = f64)]
    pub number: i64,
}

pub(crate) fn github_token_ref() -> Result<String, OmniError> {
    plugin_secret_ref(STUDIO_SECRET_PLUGIN, GITHUB_TOKEN_KEY)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn parse_repo(raw: Option<&str>) -> Result<String, OmniError> {
    let repo = raw
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_REPO);
    let mut parts = repo.split('/');
    let owner = parts.next().unwrap_or("");
    let name = parts.next().unwrap_or("");
    if parts.next().is_some()
        || owner.is_empty()
        || name.is_empty()
        || !owner
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
    {
        return Err(OmniError::invalid_input(
            "仓库须为 owner/repo（仅字母数字与 -_.）",
        ));
    }
    Ok(format!("{owner}/{name}"))
}

fn require_https_url(url: &str) -> Result<(), OmniError> {
    let url = url.trim();
    if !url.starts_with("https://") || url.len() < 12 || url.contains(char::is_whitespace) {
        return Err(OmniError::invalid_input("制品 URL 必须是 https://"));
    }
    Ok(())
}

/// 成功投稿时间戳 → 是否超限；超限返回需等待的毫秒。
pub(crate) fn submit_quota(
    now_ms: i64,
    success_ts: &[i64],
) -> Result<(u32, Option<i64>), OmniError> {
    let window_start = now_ms.saturating_sub(SUBMIT_WINDOW_MS);
    let mut recent: Vec<i64> = success_ts
        .iter()
        .copied()
        .filter(|ts| *ts > window_start)
        .collect();
    recent.sort_unstable();
    if recent.len() < SUBMIT_LIMIT {
        return Ok(((SUBMIT_LIMIT - recent.len()) as u32, None));
    }
    let oldest = recent[0];
    let wait = (oldest + SUBMIT_WINDOW_MS).saturating_sub(now_ms).max(1);
    Err(OmniError::new(
        ErrorCode::Permission,
        format!(
            "该工程 24 小时内已投稿 {SUBMIT_LIMIT} 次，请 {} 后再试",
            format_wait(wait)
        ),
    )
    .with_cause(format!("wait_ms={wait}")))
}

fn format_wait(ms: i64) -> String {
    let mins = (ms / 60_000).max(1);
    if mins >= 60 {
        let hours = (mins + 59) / 60;
        format!("{hours} 小时")
    } else {
        format!("{mins} 分钟")
    }
}

fn recent_submit_ts(store: &Storage, project: &str, now: i64) -> Result<Vec<i64>, OmniError> {
    let window = now.saturating_sub(SUBMIT_WINDOW_MS);
    Ok(store
        .recent_audit(500)?
        .into_iter()
        .filter(|e| {
            e.action == SUBMIT_ACTION
                && e.target == project
                && e.status == "success"
                && e.ts > window
        })
        .map(|e| e.ts)
        .collect())
}

fn has_token() -> bool {
    match Vault::get(&github_token_ref().unwrap_or_default()) {
        Ok(secret) => !secret.trim().is_empty(),
        Err(_) => false,
    }
}

fn read_token() -> Result<String, OmniError> {
    let reference = github_token_ref()?;
    match Vault::get(&reference) {
        Ok(secret) if !secret.trim().is_empty() => Ok(secret),
        Ok(_) => Err(OmniError::auth("未配置 GitHub token")),
        Err(err) if err.code == ErrorCode::NotFound => Err(OmniError::auth("未配置 GitHub token")),
        Err(err) => Err(err),
    }
}

fn audit(state: &AppState, project: &str, status: &str, detail: String) {
    let entry = AuditEntry {
        ts: now_ms(),
        action: SUBMIT_ACTION.to_string(),
        target: project.to_string(),
        env_tag: "-".into(),
        risk: "medium".into(),
        status: status.to_string(),
        detail: detail.chars().take(200).collect(),
    };
    if let Ok(store) = state.storage.try_lock() {
        let _ = store.append_audit(&entry);
    }
}

pub(crate) fn submit_audit_detail(url: &str) -> String {
    format!("issue {url}")
}

fn permissions_of(manifest: &PluginManifest) -> Vec<String> {
    manifest
        .permissions
        .iter()
        .map(|p| p.as_str().to_string())
        .collect()
}

fn needs_manual_review(permissions: &[String]) -> bool {
    permissions
        .iter()
        .any(|p| DANGEROUS_PERMISSIONS.contains(&p.as_str()))
}

pub(crate) fn assemble_issue(
    title_id: &str,
    version: &str,
    kind: &str,
    permissions: &[String],
    fragment_json: &str,
) -> (String, String) {
    let title = format!("[plugin-submission] {title_id} {version}");
    let perm_line = if permissions.is_empty() {
        "(none)".to_string()
    } else {
        permissions
            .iter()
            .map(|p| format!("`{p}`"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let review = if needs_manual_review(permissions) {
        "\n> 含危险权限 `ssh:exec`，须人工复核；Action 不会自动归档。\n"
    } else {
        ""
    };
    let perm_list = if permissions.is_empty() {
        "- （无）".to_string()
    } else {
        permissions
            .iter()
            .map(|p| format!("- `{p}`"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let body = format!(
        "## Plugin submission\n\n\
每工程每 24 小时最多投稿 3 次。维护者将 issue 标为 completed 后，Action 校验片段并提 registry PR。\n\n\
**id:** `{title_id}`  \n\
**version:** `{version}`  \n\
**kind:** `{kind}`  \n\
**permissions:** {perm_line}\n{review}\n\
{FRAGMENT_MARK}\n\
```json\n{fragment_json}\n```\n\n\
### Permissions\n\n{perm_list}\n"
    );
    (title, body)
}

fn load_manifest(project: &str) -> Result<PluginManifest, OmniError> {
    let dir = project_dir(project)?;
    let text = std::fs::read_to_string(dir.join("plugin.json"))
        .map_err(|_| OmniError::not_found(format!("工程缺少 plugin.json: {project}")))?;
    let manifest =
        PluginManifest::from_json(&text).map_err(|e| OmniError::invalid_input(e.to_string()))?;
    manifest
        .validate()
        .map_err(|e| OmniError::invalid_input(e.to_string()))?;
    Ok(manifest)
}

fn build_fragment(
    project: &str,
    artifact_url: &str,
    changelog: Option<&str>,
    packed_path: Option<&str>,
) -> Result<(PluginManifest, String), OmniError> {
    require_https_url(artifact_url)?;
    let dir = project_dir(project)?;
    if !dir.is_dir() {
        return Err(OmniError::not_found(format!("工程不存在: {project}")));
    }
    let changelog = changelog.map(str::trim).filter(|s| !s.is_empty());
    let manifest = load_manifest(project)?;
    let plugin = if let Some(packed) = packed_path.map(str::trim).filter(|s| !s.is_empty()) {
        let path = std::path::Path::new(packed);
        if !path.is_file() {
            return Err(OmniError::not_found("打包产物不存在，请先点「打包」"));
        }
        registry_plugin_from_packed(&manifest, artifact_url.trim(), changelog, path)
            .map_err(|e| OmniError::internal(e.to_string()))?
    } else {
        registry_plugin_from_dir(
            &dir,
            artifact_url.trim(),
            changelog,
            Some(&dev_signing_key()),
        )
        .map_err(|e| OmniError::internal(e.to_string()))?
    };
    let json =
        serde_json::to_string_pretty(&plugin).map_err(|e| OmniError::internal(e.to_string()))?;
    Ok((manifest, json))
}

fn quota_or_preview_wait(
    store: &Storage,
    project: &str,
    now: i64,
) -> Result<(u32, Option<i64>), OmniError> {
    let ts = recent_submit_ts(store, project, now)?;
    match submit_quota(now, &ts) {
        Ok(pair) => Ok(pair),
        Err(err) => {
            let wait = err
                .cause
                .as_deref()
                .and_then(|c| c.strip_prefix("wait_ms="))
                .and_then(|n| n.parse().ok());
            Ok((0, wait.or(Some(1))))
        }
    }
}

/// 保存投稿 token（只进钥匙串）。空字符串视为删除。
#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_github_token_put(
    state: State<'_, AppState>,
    token: String,
) -> Result<(), OmniError> {
    let reference = github_token_ref()?;
    if token.trim().is_empty() {
        Vault::delete(&reference)?;
        audit(&state, "studio", "success", "token deleted".into());
        return Ok(());
    }
    Vault::store(&reference, token.trim())?;
    audit(&state, "studio", "success", "token put".into());
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_github_token_has() -> Result<bool, OmniError> {
    Ok(has_token())
}

#[tauri::command]
#[specta::specta]
pub async fn plugin_studio_github_token_delete(
    state: State<'_, AppState>,
) -> Result<(), OmniError> {
    Vault::delete(&github_token_ref()?)?;
    audit(&state, "studio", "success", "token deleted".into());
    Ok(())
}

/// 组装投稿预览（不发 GitHub 请求）。超限时 `waitMs` 有值、`remaining=0`。
#[tauri::command]
#[specta::specta]
pub async fn plugin_submit_preview(
    state: State<'_, AppState>,
    project: String,
    artifact_url: String,
    changelog: Option<String>,
    repo: Option<String>,
    packed_path: Option<String>,
) -> Result<SubmitPreview, OmniError> {
    let repo = parse_repo(repo.as_deref())?;
    let project_name = project.clone();
    let packed = packed_path.clone();
    let changelog_owned = changelog.clone();
    let url_owned = artifact_url.clone();
    let (manifest, fragment) = tokio::task::spawn_blocking(move || {
        build_fragment(
            &project_name,
            &url_owned,
            changelog_owned.as_deref(),
            packed.as_deref(),
        )
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))??;
    let permissions = permissions_of(&manifest);
    let (title, body) = assemble_issue(
        &manifest.id,
        &manifest.version,
        manifest.kind.as_str(),
        &permissions,
        &fragment,
    );
    let now = now_ms();
    let store = state.storage.lock().await;
    let (remaining, wait_ms) = quota_or_preview_wait(&store, &project, now)?;
    let review = needs_manual_review(&permissions);
    Ok(SubmitPreview {
        title,
        body,
        repo,
        remaining,
        wait_ms,
        has_token: has_token(),
        permissions,
        needs_manual_review: review,
    })
}

/// 确认后建 GitHub issue。token 只在 Rust 侧从钥匙串读取。
#[tauri::command]
#[specta::specta]
pub async fn plugin_submit_issue(
    state: State<'_, AppState>,
    project: String,
    artifact_url: String,
    changelog: Option<String>,
    repo: Option<String>,
    packed_path: Option<String>,
) -> Result<SubmitResult, OmniError> {
    let repo = parse_repo(repo.as_deref())?;
    let now = now_ms();
    {
        let store = state.storage.lock().await;
        let ts = recent_submit_ts(&store, &project, now)?;
        if let Err(err) = submit_quota(now, &ts) {
            audit(&state, &project, "blocked", "rate limited".into());
            return Err(err);
        }
    }
    let token = match read_token() {
        Ok(t) => t,
        Err(err) => {
            audit(&state, &project, "failed", "missing token".into());
            return Err(err);
        }
    };
    let project_name = project.clone();
    let packed = packed_path.clone();
    let changelog_owned = changelog.clone();
    let url_owned = artifact_url.clone();
    let (manifest, fragment) = tokio::task::spawn_blocking(move || {
        build_fragment(
            &project_name,
            &url_owned,
            changelog_owned.as_deref(),
            packed.as_deref(),
        )
    })
    .await
    .map_err(|e| OmniError::internal(e.to_string()))??;
    let permissions = permissions_of(&manifest);
    let (title, body) = assemble_issue(
        &manifest.id,
        &manifest.version,
        manifest.kind.as_str(),
        &permissions,
        &fragment,
    );
    let api = format!("https://api.github.com/repos/{repo}/issues");
    let resp = state
        .plugin_http
        .post(&api)
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "OmniPanel-studio")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .json(&serde_json::json!({
            "title": title,
            "body": body,
            "labels": ["plugin-submission"],
        }))
        .send()
        .await
        .map_err(|e| OmniError::connection(e.to_string()))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.as_u16() == 401 || status.as_u16() == 403 {
        audit(&state, &project, "failed", format!("github {status}"));
        return Err(OmniError::auth("GitHub token 无效或权限不足"));
    }
    if !status.is_success() {
        audit(&state, &project, "failed", format!("github {status}"));
        let hint = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| text.chars().take(180).collect());
        return Err(OmniError::connection(format!(
            "GitHub 建 issue 失败 ({status}): {hint}"
        )));
    }
    #[derive(Deserialize)]
    struct GhIssue {
        html_url: String,
        number: i64,
    }
    let issue: GhIssue = serde_json::from_str(&text)
        .map_err(|e| OmniError::internal(format!("GitHub 响应无法解析: {e}")))?;
    audit(
        &state,
        &project,
        "success",
        submit_audit_detail(&issue.html_url),
    );
    Ok(SubmitResult {
        url: issue.html_url,
        number: issue.number,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_token_ref_is_keyring_namespace() {
        assert_eq!(github_token_ref().unwrap(), "plugin:studio:github-token");
    }

    #[test]
    fn repo_parse_default_and_reject() {
        assert_eq!(parse_repo(None).unwrap(), DEFAULT_REPO);
        assert_eq!(parse_repo(Some(" acme/plugins ")).unwrap(), "acme/plugins");
        assert!(parse_repo(Some("https://github.com/a/b")).is_err());
        assert!(parse_repo(Some("a/b/c")).is_err());
    }

    #[test]
    fn https_artifact_required() {
        assert!(require_https_url("https://example.com/a.omni-plugin").is_ok());
        assert!(require_https_url("http://example.com/a").is_err());
        assert!(require_https_url("ftp://x").is_err());
    }

    #[test]
    fn fourth_submit_within_24h_is_rejected() {
        let now = 1_700_000_000_000;
        let ts = [now - 3_600_000, now - 2_000_000, now - 1_000_000];
        let err = submit_quota(now, &ts).unwrap_err();
        assert_eq!(err.code, ErrorCode::Permission);
        assert!(err.message.contains("3 次"));
        assert!(submit_quota(now, &ts[..2]).is_ok());
    }

    #[test]
    fn quota_resets_after_window() {
        let now = 1_700_000_000_000;
        let ts = [now - SUBMIT_WINDOW_MS - 1; 5];
        let (remaining, wait) = submit_quota(now, &ts).unwrap();
        assert_eq!(remaining, SUBMIT_LIMIT as u32);
        assert!(wait.is_none());
    }

    #[test]
    fn token_never_appears_in_issue_or_audit() {
        let token = "ghp_this_must_not_leak";
        let (title, body) = assemble_issue(
            "omni.sample.demo",
            "0.1.0",
            "addon",
            &["ui:selection".into(), "ssh:exec".into()],
            r#"{"id":"omni.sample.demo"}"#,
        );
        assert!(title.starts_with("[plugin-submission]"));
        assert!(body.contains(FRAGMENT_MARK));
        assert!(body.contains("ssh:exec"));
        assert!(body.contains("须人工复核"));
        assert!(!title.contains(token));
        assert!(!body.contains(token));
        let detail = submit_audit_detail("https://github.com/o/r/issues/1");
        assert!(!detail.contains(token));
        assert!(detail.contains("issues/1"));
    }

    #[test]
    fn token_not_written_to_sqlite() {
        let store = Storage::open_in_memory().unwrap();
        let token = "ghp_this_must_not_appear_in_db";
        store
            .append_audit(&AuditEntry {
                ts: 1,
                action: SUBMIT_ACTION.into(),
                target: "demo".into(),
                env_tag: "-".into(),
                risk: "medium".into(),
                status: "success".into(),
                detail: submit_audit_detail("https://github.com/o/r/issues/9"),
            })
            .unwrap();
        let dump = format!("{:?}", store.recent_audit(10).unwrap());
        assert!(!dump.contains(token));
        assert!(!dump.contains("ghp_"));
    }
}
