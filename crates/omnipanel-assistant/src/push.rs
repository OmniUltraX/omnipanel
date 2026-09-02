use chrono::Utc;
use omnipanel_error::OmniResult;
use reqwest::Client;
use serde::Serialize;
use specta::Type;

use crate::collect::{CollectContext, assemble_modules, default_collectors};
use crate::error::{AssistantErrorKind, map_assistant_error_with_cause};
use crate::notify::{SnapshotNotifyRequest, normalize_snapshot_dir, notify_snapshot_uploaded};
use crate::oss::upload_snapshot_json;
use crate::sts::{AuthContext, fetch_oss_sts};
use crate::types::build_snapshot_bundle;

#[derive(Debug, Clone, Default)]
pub struct PushOptions {
    /// 仅组装快照，不申请凭证 / 不上传（本地验证用）
    pub dry_run: bool,
    /// 覆盖本次快照目录（不含文件名）；默认按约定生成 `.../snapshots/{ts}-{id}`
    pub object_key_override: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PushSnapshotResult {
    /// 概览文件 object key（对外主入口）
    pub object_key: String,
    pub etag: Option<String>,
    /// 全部文件字节数合计；用 f64 以兼容 specta/TS（禁止导出 u64）
    pub bytes: f64,
    /// 上传/组装的文件数（1 overview + N modules）
    pub file_count: f64,
    pub generated_at: String,
    pub dry_run: bool,
}

/// 组装多文件快照 →（可选）拉凭证 → 逐文件 PUT（模块先、概览后）。
pub async fn push_snapshot(
    ctx: CollectContext,
    auth: Option<&AuthContext>,
    options: PushOptions,
) -> OmniResult<PushSnapshotResult> {
    let generated_at = Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let collectors = default_collectors();
    let modules = assemble_modules(&collectors, &ctx);
    let short_id = unique_run_id();

    let default_dir = format!(
        "assistant/{}/{}/snapshots/{}-{}",
        sanitize_path_segment(
            ctx.user_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .unwrap_or("user")
        ),
        sanitize_path_segment(&ctx.client_device_id),
        generated_at.replace(':', "-").replace('.', "-"),
        short_id
    );

    if options.dry_run {
        let snapshot_dir =
            resolve_snapshot_dir(options.object_key_override.as_deref(), None, &default_dir);
        let bundle = build_snapshot_bundle(
            &ctx.client_device_id,
            ctx.bind_id.clone(),
            &generated_at,
            &snapshot_dir,
            &modules,
        )
        .map_err(|e| map_assistant_error_with_cause(AssistantErrorKind::Encode, e, ""))?;

        return Ok(PushSnapshotResult {
            object_key: bundle.overview_key.clone(),
            etag: None,
            bytes: bundle.total_bytes() as f64,
            file_count: bundle.file_count() as f64,
            generated_at,
            dry_run: true,
        });
    }

    let auth = auth.ok_or_else(|| {
        map_assistant_error_with_cause(
            AssistantErrorKind::Auth,
            "缺少登录凭证，无法申请 OSS 上传凭证",
            "auth context is None",
        )
    })?;

    let sts = fetch_oss_sts(auth).await?;
    let snapshot_dir = resolve_snapshot_dir(
        options.object_key_override.as_deref(),
        sts.object_key_prefix.as_deref(),
        &default_dir,
    );
    let bundle = build_snapshot_bundle(
        &ctx.client_device_id,
        ctx.bind_id.clone(),
        &generated_at,
        &snapshot_dir,
        &modules,
    )
    .map_err(|e| map_assistant_error_with_cause(AssistantErrorKind::Encode, e, ""))?;

    let http = Client::new();
    let mut total_bytes = 0u64;
    let mut overview_etag: Option<String> = None;
    let overview_key = bundle.overview_key.clone();

    for file in &bundle.files {
        let uploaded = upload_snapshot_json(&http, &sts, &file.object_key, &file.body).await?;
        total_bytes += uploaded.bytes;
        if file.object_key == overview_key {
            overview_etag = uploaded.etag;
        }
    }

    // 再写一份固定 latest/ 入口（同名覆盖），带 no-cache，避免助手端只盯 latest 时吃到 CDN 旧缓存
    if let Some(latest_prefix) = latest_prefix_from_snapshot_dir(&snapshot_dir) {
        for file in &bundle.files {
            let Some(rel) = file
                .object_key
                .strip_prefix(&format!("{}/", snapshot_dir.trim_matches('/')))
            else {
                continue;
            };
            let latest_rel = stabilize_latest_rel(rel);
            let latest_key = format!("{latest_prefix}/{latest_rel}");
            let uploaded = upload_snapshot_json(&http, &sts, &latest_key, &file.body).await?;
            total_bytes += uploaded.bytes;
        }
    }

    let object_keys: Vec<String> = bundle.files.iter().map(|f| f.object_key.clone()).collect();
    notify_snapshot_uploaded(
        auth,
        &SnapshotNotifyRequest {
            snapshot_dir: normalize_snapshot_dir(&snapshot_dir),
            overview_key: overview_key.clone(),
            object_keys,
            generated_at: generated_at.clone(),
        },
    )
    .await?;

    Ok(PushSnapshotResult {
        object_key: overview_key,
        etag: overview_etag,
        bytes: total_bytes as f64,
        file_count: bundle.file_count() as f64,
        generated_at,
        dry_run: false,
    })
}

/// 解析本次快照目录。`object_key_override` 优先；否则若有 STS prefix 则用
/// `{prefix}/snapshots/{ts}-{id}`；否则用 `default_dir`。
fn resolve_snapshot_dir(
    override_key: Option<&str>,
    sts_prefix: Option<&str>,
    default_dir: &str,
) -> String {
    if let Some(raw) = override_key.map(str::trim).filter(|s| !s.is_empty()) {
        let trimmed = raw.trim_matches('/');
        if trimmed.ends_with(".json") {
            return trimmed
                .rsplit_once('/')
                .map(|(dir, _)| dir.to_string())
                .unwrap_or_else(|| trimmed.to_string());
        }
        return trimmed.to_string();
    }

    let prefix = sts_prefix.unwrap_or("").trim_matches('/');
    if prefix.is_empty() {
        return default_dir.to_string();
    }

    // default_dir = assistant/{user}/{device}/snapshots/{ts}-{id}
    // 有服务端 prefix 时改为 {prefix}/snapshots/{ts}-{id}
    let leaf = default_dir
        .rsplit_once("/snapshots/")
        .map(|(_, leaf)| leaf)
        .unwrap_or(default_dir);
    format!("{prefix}/snapshots/{leaf}")
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

/// 毫秒时间戳 + 随机后缀，避免同秒并发推送撞目录名。
fn unique_run_id() -> String {
    let millis = Utc::now().timestamp_millis().unsigned_abs();
    let mut buf = [0u8; 4];
    let _ = getrandom::getrandom(&mut buf);
    let rand = u32::from_be_bytes(buf);
    format!("{millis:x}-{rand:08x}")
}

/// `…/snapshots/{run}` → `…/latest`
fn latest_prefix_from_snapshot_dir(snapshot_dir: &str) -> Option<String> {
    let dir = snapshot_dir.trim_matches('/');
    let (parent, _) = dir.rsplit_once("/snapshots/")?;
    if parent.is_empty() {
        return None;
    }
    Some(format!("{parent}/latest"))
}

/// 版本目录里可能是 `modules/assistant.json`；latest 保持稳定相对路径。
fn stabilize_latest_rel(rel: &str) -> String {
    if rel == "overview.json" || rel.starts_with("modules/") {
        rel.to_string()
    } else {
        rel.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn dry_run_assembles_multi_file_bundle() {
        let ctx = CollectContext {
            client_device_id: "dev-1".into(),
            bind_id: None,
            database_connections: vec![json!({"id":"db1","name":"demo","password":"nope"})],
            recent_tasks: vec![json!({"id":"t1","title":"job"})],
            ..Default::default()
        };
        let result = push_snapshot(
            ctx,
            None,
            PushOptions {
                dry_run: true,
                ..Default::default()
            },
        )
        .await
        .expect("dry_run");
        assert!(result.dry_run);
        assert!(result.bytes > 0.0);
        assert_eq!(result.file_count, 11.0);
        assert!(result.object_key.contains("dev-1"));
        assert!(result.object_key.ends_with("/overview.json"));
    }

    #[test]
    fn resolve_dir_prefers_override_and_strips_json() {
        let d = resolve_snapshot_dir(
            Some("assistant/u/d/snapshots/x/overview.json"),
            Some("pfx"),
            "assistant/u/d/snapshots/default",
        );
        assert_eq!(d, "assistant/u/d/snapshots/x");
    }

    #[test]
    fn resolve_dir_uses_sts_prefix_leaf() {
        let d = resolve_snapshot_dir(
            None,
            Some("assistant/42/dev"),
            "assistant/user/dev/snapshots/2026-t-abc",
        );
        assert_eq!(d, "assistant/42/dev/snapshots/2026-t-abc");
    }

    #[test]
    fn latest_prefix_from_versioned_dir() {
        assert_eq!(
            latest_prefix_from_snapshot_dir("assistant/1/dev/snapshots/2026-run"),
            Some("assistant/1/dev/latest".into())
        );
    }

    #[test]
    fn unique_run_ids_differ() {
        assert_ne!(unique_run_id(), unique_run_id());
    }
}
