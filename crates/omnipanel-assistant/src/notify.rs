use omnipanel_error::OmniResult;
use serde::Serialize;
use serde_json::{Value, json};

use crate::error::{AssistantErrorKind, map_assistant_error, map_assistant_error_with_cause};
use crate::sts::AuthContext;

/// 上传完成后的业务字段（放入通用 notify 的 payload）。
#[derive(Debug, Clone, Serialize)]
pub struct SnapshotNotifyRequest {
    pub snapshot_dir: String,
    pub overview_key: String,
    pub object_keys: Vec<String>,
    pub generated_at: String,
}

/// `POST {api_base}/api/notify` — event=`client.snapshot.updated`
pub async fn notify_snapshot_uploaded(
    auth: &AuthContext,
    request: &SnapshotNotifyRequest,
) -> OmniResult<()> {
    let url = format!("{}/api/notify", auth.api_base.trim_end_matches('/'));
    let body = json!({
        "event": "client.snapshot.updated",
        "target": {
            "role": "assistant",
            "app_id": "omni-assistant",
        },
        "payload": {
            "snapshotDir": request.snapshot_dir,
            "overviewKey": request.overview_key,
            "objectKeys": request.object_keys,
            "generatedAt": request.generated_at,
            // 兼容旧字段名
            "snapshot_dir": request.snapshot_dir,
            "overview_key": request.overview_key,
            "object_keys": request.object_keys,
            "generated_at": request.generated_at,
        }
    });
    let resp = auth
        .http
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .header("X-Device-Public-Key", &auth.device_public_key)
        .json(&body)
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

/// 从通用 notify envelope 的 payload 取 overviewKey（兼容 snake/camel）。
/// 供调用方解析通用 notify；库内暂无直接引用，保留公开 API。
#[allow(dead_code)]
pub fn overview_key_from_notify_payload(payload: &Value) -> String {
    payload
        .get("overviewKey")
        .or_else(|| payload.get("overview_key"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
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
    fn overview_key_accepts_camel_and_snake() {
        let camel = serde_json::json!({ "overviewKey": " a/b.json " });
        assert_eq!(overview_key_from_notify_payload(&camel), "a/b.json");
        let snake = serde_json::json!({ "overview_key": "x/y.json" });
        assert_eq!(overview_key_from_notify_payload(&snake), "x/y.json");
        assert_eq!(overview_key_from_notify_payload(&serde_json::json!({})), "");
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
