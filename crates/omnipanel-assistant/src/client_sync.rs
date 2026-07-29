//! 客户端 ↔ 客户端（同账号）数据同步。
//!
//! 与助手端快照（`assistant/{userId}/{deviceId}/…`）完全独立：
//! 账号级路径 `sync/{userId}/v1/…`，供多设备互相 pull / push。

use omnipanel_error::OmniResult;
use reqwest::Client;

use crate::error::{map_assistant_error, map_assistant_error_with_cause, AssistantErrorKind};
use crate::oss::{
    get_object_bytes_optional, strip_bucket_prefix, upload_object_bytes, OssUploadResult,
};
use crate::sts::{fetch_oss_sts, AuthContext};

/// AI 会话 / 模块 bundle 共用 schema 上限。
pub const CLIENT_SYNC_SCHEMA_VERSION: u32 = 1;
/// 兼容旧名。
pub const CLIENT_SYNC_CONVERSATIONS_SCHEMA_VERSION: u32 = CLIENT_SYNC_SCHEMA_VERSION;

fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' | '.' => c,
            _ => '_',
        })
        .collect();
    if cleaned.is_empty() {
        "user".to_string()
    } else {
        cleaned
    }
}

/// `sync/{userId}/v1/{leaf}/latest.json`
pub fn sync_latest_object_key(user_id: &str, leaf: &str) -> String {
    format!(
        "sync/{}/v1/{}/latest.json",
        sanitize_path_segment(user_id),
        sanitize_path_segment(leaf)
    )
}

/// 账号级 AI 会话同步对象 key。
pub fn conversations_latest_object_key(user_id: &str) -> String {
    sync_latest_object_key(user_id, "ai-conversations")
}

/// 账号级各业务模块同步对象 key。
pub fn modules_latest_object_key(user_id: &str) -> String {
    sync_latest_object_key(user_id, "modules")
}

/// 拉取任意账号级 sync blob；对象不存在时返回 `None`。
pub async fn pull_sync_json(
    auth: &AuthContext,
    user_id: &str,
    leaf: &str,
) -> OmniResult<Option<(String, Vec<u8>)>> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Err(map_assistant_error(
            AssistantErrorKind::Auth,
            "缺少 userId，无法拉取客户端同步数据",
        ));
    }
    if leaf.trim().is_empty() {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "sync leaf 为空",
        ));
    }

    let sts = fetch_oss_sts(auth).await?;
    let object_key = sync_latest_object_key(user_id, leaf);
    let key = strip_bucket_prefix(&object_key, &sts.bucket);
    let http = Client::new();
    let bytes = get_object_bytes_optional(&http, &sts, &key).await?;
    Ok(bytes.map(|b| (key, b)))
}

/// 上传任意账号级 sync blob（覆盖 latest）。
pub async fn push_sync_json(
    auth: &AuthContext,
    user_id: &str,
    leaf: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    let user_id = user_id.trim();
    if user_id.is_empty() {
        return Err(map_assistant_error(
            AssistantErrorKind::Auth,
            "缺少 userId，无法推送客户端同步数据",
        ));
    }
    if body.is_empty() {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            "客户端同步内容为空",
        ));
    }

    let sts = fetch_oss_sts(auth).await?;
    let object_key = sync_latest_object_key(user_id, leaf);
    let key = strip_bucket_prefix(&object_key, &sts.bucket);
    let http = Client::new();
    upload_object_bytes(&http, &sts, &key, body, "application/json").await
}

pub async fn pull_conversations_json(
    auth: &AuthContext,
    user_id: &str,
) -> OmniResult<Option<(String, Vec<u8>)>> {
    pull_sync_json(auth, user_id, "ai-conversations").await
}

pub async fn push_conversations_json(
    auth: &AuthContext,
    user_id: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    push_sync_json(auth, user_id, "ai-conversations", body).await
}

pub async fn pull_modules_json(
    auth: &AuthContext,
    user_id: &str,
) -> OmniResult<Option<(String, Vec<u8>)>> {
    pull_sync_json(auth, user_id, "modules").await
}

pub async fn push_modules_json(
    auth: &AuthContext,
    user_id: &str,
    body: &[u8],
) -> OmniResult<OssUploadResult> {
    push_sync_json(auth, user_id, "modules", body).await
}

/// 轻量校验：JSON 可解析且含 `schemaVersion`。
pub fn validate_sync_bundle_json(body: &[u8], label: &str) -> OmniResult<()> {
    let value: serde_json::Value = serde_json::from_slice(body).map_err(|e| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Encode,
            format!("客户端同步 JSON 无效 ({label})"),
            e.to_string(),
        )
    })?;
    let ver = value
        .get("schemaVersion")
        .or_else(|| value.get("schema_version"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    if ver == 0 {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            format!("客户端同步 JSON 缺少 schemaVersion ({label})"),
        ));
    }
    if ver > u64::from(CLIENT_SYNC_SCHEMA_VERSION) {
        return Err(map_assistant_error(
            AssistantErrorKind::Encode,
            format!("不支持的客户端同步 schemaVersion={ver} ({label})"),
        ));
    }
    Ok(())
}

pub fn validate_conversations_bundle_json(body: &[u8]) -> OmniResult<()> {
    validate_sync_bundle_json(body, "ai-conversations")
}

pub fn validate_modules_bundle_json(body: &[u8]) -> OmniResult<()> {
    validate_sync_bundle_json(body, "modules")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_key_sanitizes_user_id() {
        assert_eq!(
            conversations_latest_object_key("42"),
            "sync/42/v1/ai-conversations/latest.json"
        );
        assert_eq!(
            modules_latest_object_key("a/b"),
            "sync/a_b/v1/modules/latest.json"
        );
    }

    #[test]
    fn validate_accepts_v1() {
        let body = br#"{"schemaVersion":1,"kind":"ai-conversations","conversations":[]}"#;
        validate_conversations_bundle_json(body).unwrap();
        let modules = br#"{"schemaVersion":1,"kind":"workspace-modules"}"#;
        validate_modules_bundle_json(modules).unwrap();
    }
}
