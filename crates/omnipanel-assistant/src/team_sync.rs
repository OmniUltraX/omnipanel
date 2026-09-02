//! 团队 OSS 同步：`team_sync/{team_id}/…` 前缀下的读写。
//!
//! 凭证：`POST /api/teams/{team_id}/oss/sts`（长期 AK，objectKeyPrefix 通常为 `team_sync/{team_id}/`）。

use chrono::Utc;
use omnipanel_error::OmniResult;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::error::{AssistantErrorKind, map_assistant_error, map_assistant_error_with_cause};
use crate::oss::{
    OssUploadResult, get_object_bytes_optional, strip_bucket_prefix, upload_object_bytes,
};
use crate::sts::{AuthContext, OssStsCredentials};

pub const TEAM_SYNC_SCHEMA_VERSION: u32 = 1;
pub const TEAM_SHARE_INDEX_KEY: &str = "shares/custom-panels/index.json";
/// 团队模块快照（账号自动同步与手动团队同步共用）。
pub const TEAM_MODULES_LATEST_LEAF: &str = "modules/latest.json";
/// 团队 AI 会话快照。
pub const TEAM_CONVERSATIONS_LATEST_LEAF: &str = "ai-conversations/latest.json";

#[derive(Debug, Deserialize)]
struct StsApiEnvelope {
    #[serde(default)]
    data: Option<OssStsCredentials>,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

/// `POST {api_base}/api/teams/{team_id}/oss/sts`
pub async fn fetch_team_oss_sts(auth: &AuthContext, team_id: i64) -> OmniResult<OssStsCredentials> {
    if team_id <= 0 {
        return Err(map_assistant_error(AssistantErrorKind::Sts, "团队 ID 无效"));
    }
    let url = format!(
        "{}/api/teams/{team_id}/oss/sts",
        auth.api_base.trim_end_matches('/')
    );
    let resp = auth
        .http
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .send()
        .await
        .map_err(|e| {
            map_assistant_error_with_cause(
                AssistantErrorKind::Sts,
                "申请团队 OSS 凭证失败",
                e.to_string(),
            )
        })?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Sts,
            "读取团队 OSS 凭证响应失败",
            e.to_string(),
        )
    })?;

    if !status.is_success() {
        return Err(sts_http_error(status.as_u16(), &text));
    }

    let creds = if let Ok(env) = serde_json::from_str::<StsApiEnvelope>(&text) {
        if let Some(data) = env.data {
            data
        } else if let Some(err) = env.error.or(env.message) {
            return Err(map_assistant_error(AssistantErrorKind::Sts, err));
        } else {
            serde_json::from_str::<OssStsCredentials>(&text).map_err(|e| {
                map_assistant_error_with_cause(
                    AssistantErrorKind::Sts,
                    "解析团队 OSS 凭证响应失败",
                    format!("{e}; body={text}"),
                )
            })?
        }
    } else {
        serde_json::from_str::<OssStsCredentials>(&text).map_err(|e| {
            map_assistant_error_with_cause(
                AssistantErrorKind::Sts,
                "解析团队 OSS 凭证响应失败",
                format!("{e}; body={text}"),
            )
        })?
    };

    creds.validate()?;
    Ok(creds)
}

fn sts_http_error(status: u16, body: &str) -> omnipanel_error::OmniError {
    let lower = body.to_ascii_lowercase();
    let kind = if status == 401 || status == 403 || lower.contains("unauthorized") {
        AssistantErrorKind::Auth
    } else {
        AssistantErrorKind::Sts
    };
    map_assistant_error(
        kind,
        format!("申请团队 OSS 凭证失败 (HTTP {status}): {body}"),
    )
}

fn resolve_object_key(sts: &OssStsCredentials, leaf: &str) -> String {
    let leaf = leaf.trim().trim_matches('/');
    if leaf.is_empty() {
        return String::new();
    }
    if let Some(prefix) = sts
        .object_key_prefix
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let prefix = prefix.trim_end_matches('/');
        return format!("{prefix}/{leaf}");
    }
    leaf.to_string()
}

pub fn team_share_item_key(share_id: &str) -> String {
    format!("shares/custom-panels/items/{share_id}.json")
}

/// 上传团队 sync blob（覆盖指定 leaf）。
pub async fn push_team_sync_json(
    auth: &AuthContext,
    team_id: i64,
    leaf: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    if body.is_empty() {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "团队同步内容为空",
        ));
    }
    let sts = fetch_team_oss_sts(auth, team_id).await?;
    let object_key = resolve_object_key(&sts, leaf);
    if object_key.is_empty() {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "团队同步 object key 无效",
        ));
    }
    let key = strip_bucket_prefix(&object_key, &sts.bucket);
    let http = Client::new();
    upload_object_bytes(&http, &sts, &key, body, "application/json").await
}

/// 拉取团队 sync blob；对象不存在时返回 `None`。
pub async fn pull_team_sync_json(
    auth: &AuthContext,
    team_id: i64,
    leaf: &str,
) -> OmniResult<Option<(String, Vec<u8>)>> {
    let sts = fetch_team_oss_sts(auth, team_id).await?;
    let object_key = resolve_object_key(&sts, leaf);
    if object_key.is_empty() {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "团队同步 object key 无效",
        ));
    }
    let key = strip_bucket_prefix(&object_key, &sts.bucket);
    let http = Client::new();
    let bytes = get_object_bytes_optional(&http, &sts, &key).await?;
    Ok(bytes.map(|b| (key, b)))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamShareIndexItem {
    pub share_id: String,
    pub object_key: String,
    pub from_union_id: String,
    pub from_display_name: String,
    pub panel_label: String,
    pub created_at: String,
    #[serde(default)]
    pub recipient_union_ids: Vec<String>,
    /// 快照内资源类型（custom-panel / knowledge-entry / http-request / ssh-connection /
    /// database-connection）；旧索引缺省视为 custom-panel。
    #[serde(default = "default_share_resource_kind")]
    pub resource_kind: String,
}

fn default_share_resource_kind() -> String {
    "custom-panel".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamShareIndex {
    /// 旧索引可能缺省；缺省时由 parse_team_share_index 回填。
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub updated_at: String,
    #[serde(default)]
    pub items: Vec<TeamShareIndexItem>,
}

impl Default for TeamShareIndex {
    fn default() -> Self {
        Self {
            schema_version: TEAM_SYNC_SCHEMA_VERSION,
            kind: "team-custom-panel-share-index".to_string(),
            updated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            items: Vec::new(),
        }
    }
}

pub fn parse_team_share_index(body: &[u8]) -> OmniResult<TeamShareIndex> {
    if body.is_empty() {
        return Ok(TeamShareIndex::default());
    }
    let mut index: TeamShareIndex = serde_json::from_slice(body).map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Encode,
            "解析团队分享索引失败",
            e.to_string(),
        )
    })?;
    if index.schema_version == 0 {
        index.schema_version = TEAM_SYNC_SCHEMA_VERSION;
    }
    if index.kind.is_empty() {
        index.kind = "team-custom-panel-share-index".to_string();
    }
    Ok(index)
}

pub async fn load_team_share_index(auth: &AuthContext, team_id: i64) -> OmniResult<TeamShareIndex> {
    let pulled = pull_team_sync_json(auth, team_id, TEAM_SHARE_INDEX_KEY).await?;
    match pulled {
        Some((_, body)) => parse_team_share_index(&body),
        None => Ok(TeamShareIndex::default()),
    }
}

pub async fn save_team_share_index(
    auth: &AuthContext,
    team_id: i64,
    index: &TeamShareIndex,
) -> OmniResult<OssUploadResult> {
    let body = serde_json::to_vec(index).map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Encode,
            "序列化团队分享索引失败",
            e.to_string(),
        )
    })?;
    push_team_sync_json(auth, team_id, TEAM_SHARE_INDEX_KEY, &body).await
}

pub fn validate_team_share_bundle_json(body: &[u8]) -> OmniResult<()> {
    let value: Value = serde_json::from_slice(body).map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Encode,
            "团队分享 JSON 无效",
            e.to_string(),
        )
    })?;
    let schema = value
        .get("schemaVersion")
        .or_else(|| value.get("schema_version"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if schema == 0 || schema > u64::from(TEAM_SYNC_SCHEMA_VERSION) {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "不支持的团队分享 schemaVersion",
        ));
    }
    let kind = value.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    // team-custom-panel-share 为旧版自定义面板专用；team-resource-share 为通用资源分享
    if kind != "team-custom-panel-share" && kind != "team-resource-share" {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "团队分享 kind 无效",
        ));
    }
    if value.get("snapshot").is_none() {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "团队分享缺少 snapshot",
        ));
    }
    Ok(())
}

/// `POST /api/notify` — event=`team.share.created`
pub async fn notify_team_share_created(
    auth: &AuthContext,
    team_id: i64,
    share_id: &str,
    object_key: &str,
    recipient_union_ids: &[String],
) -> OmniResult<()> {
    let url = format!("{}/api/notify", auth.api_base.trim_end_matches('/'));
    let body = json!({
        "event": "team.share.created",
        "target": {
            "role": "client",
            "app_id": "omni-client",
        },
        "payload": {
            "teamId": team_id,
            "shareId": share_id,
            "objectKey": object_key,
            "recipientUnionIds": recipient_union_ids,
            "share_id": share_id,
            "object_key": object_key,
            "recipient_union_ids": recipient_union_ids,
        }
    });
    let resp = auth
        .http
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            map_assistant_error_with_cause(
                AssistantErrorKind::Upload,
                "通知团队分享失败",
                e.to_string(),
            )
        })?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        return Ok(());
    }
    let lower = text.to_ascii_lowercase();
    let kind = if status.as_u16() == 401 || status.as_u16() == 403 || lower.contains("unauthorized")
    {
        AssistantErrorKind::Auth
    } else {
        AssistantErrorKind::Upload
    };
    Err(map_assistant_error(
        kind,
        format!("通知团队分享失败 (HTTP {}): {text}", status.as_u16()),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn share_item_key() {
        assert_eq!(
            team_share_item_key("abc"),
            "shares/custom-panels/items/abc.json"
        );
    }

    #[test]
    fn parse_empty_index() {
        assert!(parse_team_share_index(b"{}").unwrap().items.is_empty());
    }
}
