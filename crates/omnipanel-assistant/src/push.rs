use chrono::Utc;
use omnipanel_error::OmniResult;
use reqwest::Client;
use serde::Serialize;
use specta::Type;

use crate::collect::{assemble_modules, default_collectors, CollectContext};
use crate::error::{map_assistant_error_with_cause, AssistantErrorKind};
use crate::oss::{upload_snapshot_json, OssUploadResult};
use crate::sts::{fetch_oss_sts, AuthContext};
use crate::types::{AssistantSnapshot, SNAPSHOT_SCHEMA_VERSION};

#[derive(Debug, Clone, Default)]
pub struct PushOptions {
    /// 仅组装快照，不申请 STS / 不上传（本地验证用）
    pub dry_run: bool,
    /// 覆盖默认 object key；默认按约定生成
    pub object_key_override: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushSnapshotResult {
    pub object_key: String,
    pub etag: Option<String>,
    /// 快照字节数；用 f64 以兼容 specta/TS（禁止导出 u64）
    pub bytes: f64,
    pub generated_at: String,
    pub dry_run: bool,
}

/// 组装快照 →（可选）STS → OSS PUT。
pub async fn push_snapshot(
    ctx: CollectContext,
    auth: Option<&AuthContext>,
    options: PushOptions,
) -> OmniResult<PushSnapshotResult> {
    let generated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
    let collectors = default_collectors();
    let modules = assemble_modules(&collectors, &ctx);
    let snapshot = AssistantSnapshot {
        schema_version: SNAPSHOT_SCHEMA_VERSION,
        generated_at: generated_at.clone(),
        client_device_id: ctx.client_device_id.clone(),
        bind_id: ctx.bind_id.clone(),
        modules,
    };

    let body = serde_json::to_vec_pretty(&snapshot).map_err(|e| {
        map_assistant_error_with_cause(AssistantErrorKind::Encode, "序列化快照失败", e.to_string())
    })?;

    let short_id = short_id_from_time();
    let default_key = format!(
        "assistant/{}/{}/snapshots/{}-{}.json",
        sanitize_path_segment(
            ctx.user_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("user")
        ),
        sanitize_path_segment(&ctx.client_device_id),
        generated_at.replace(':', "-"),
        short_id
    );

    if options.dry_run {
        let object_key = options.object_key_override.unwrap_or(default_key);
        return Ok(PushSnapshotResult {
            object_key,
            etag: None,
            bytes: body.len() as f64,
            generated_at,
            dry_run: true,
        });
    }

    let auth = auth.ok_or_else(|| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Auth,
            "缺少登录凭证，无法申请 STS",
            "auth context is None",
        )
    })?;

    let sts = fetch_oss_sts(auth).await?;
    let object_key = options.object_key_override.unwrap_or_else(|| {
        let prefix = sts
            .object_key_prefix
            .as_deref()
            .unwrap_or("")
            .trim_matches('/');
        if prefix.is_empty() {
            default_key
        } else {
            format!(
                "{prefix}/snapshots/{}-{}.json",
                generated_at.replace(':', "-"),
                short_id
            )
        }
    });

    let http = Client::new();
    let uploaded: OssUploadResult =
        upload_snapshot_json(&http, &sts, &object_key, &body).await?;

    Ok(PushSnapshotResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
        generated_at,
        dry_run: false,
    })
}

fn sanitize_path_segment(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "unknown".into()
    } else {
        cleaned
    }
}

fn short_id_from_time() -> String {
    let nanos = Utc::now().timestamp_subsec_nanos();
    format!("{nanos:08x}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn dry_run_assembles_without_upload() {
        let ctx = CollectContext {
            client_device_id: "dev-1".into(),
            bind_id: None,
            database_connections: vec![json!({"id":"db1","name":"demo","password":"nope"})],
            recent_tasks: vec![json!({"id":"t1","title":"job"})],
            ..Default::default()
        };
        let result = push_snapshot(ctx, None, PushOptions { dry_run: true, ..Default::default() })
            .await
            .expect("dry_run");
        assert!(result.dry_run);
        assert!(result.bytes > 0.0);
        assert!(result.object_key.contains("dev-1"));
    }
}
