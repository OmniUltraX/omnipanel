use omnipanel_error::OmniResult;
use serde::Serialize;

use crate::error::{map_assistant_error, map_assistant_error_with_cause, AssistantErrorKind};
use crate::sts::AuthContext;

/// 上传完成后通知账号服务（服务端约定 snake_case 字段）。
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotNotifyRequest {
    pub snapshot_dir: String,
    pub overview_key: String,
    pub object_keys: Vec<String>,
    pub generated_at: String,
}

/// `POST {api_base}/api/assistant/snapshots/notify`
pub async fn notify_snapshot_uploaded(
    auth: &AuthContext,
    request: &SnapshotNotifyRequest,
) -> OmniResult<()> {
    let url = format!(
        "{}/api/assistant/snapshots/notify",
        auth.api_base.trim_end_matches('/')
    );
    let resp = auth
        .http
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .header("X-Device-Public-Key", &auth.device_public_key)
        .json(request)
        .send()
        .await
        .map_err(|e| {
            map_assistant_error_with_cause(
                AssistantErrorKind::Upload,
                "通知快照上传失败",
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
        format!("通知快照上传失败 (HTTP {}): {text}", status.as_u16()),
    ))
}

/// 规范化 snapshot_dir：去多余斜杠并保证以 `/` 结尾。
pub fn normalize_snapshot_dir(dir: &str) -> String {
    let trimmed = dir.trim().trim_matches('/');
    if trimmed.is_empty() {
        "/".into()
    } else {
        format!("{trimmed}/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_adds_trailing_slash() {
        assert_eq!(
            normalize_snapshot_dir("assistant/1/dev/snapshots/run"),
            "assistant/1/dev/snapshots/run/"
        );
        assert_eq!(
            normalize_snapshot_dir("/assistant/1/dev/snapshots/run/"),
            "assistant/1/dev/snapshots/run/"
        );
    }

    #[test]
    fn notify_body_is_snake_case() {
        let req = SnapshotNotifyRequest {
            snapshot_dir: "assistant/1/d/snapshots/r/".into(),
            overview_key: "assistant/1/d/snapshots/r/overview.json".into(),
            object_keys: vec!["assistant/1/d/snapshots/r/overview.json".into()],
            generated_at: "2026-07-23T10:00:00Z".into(),
        };
        let v = serde_json::to_value(&req).unwrap();
        assert!(v.get("snapshot_dir").is_some());
        assert!(v.get("overview_key").is_some());
        assert!(v.get("object_keys").is_some());
        assert!(v.get("generated_at").is_some());
        assert!(v.get("snapshotDir").is_none());
    }
}
