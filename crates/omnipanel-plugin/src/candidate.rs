use serde::{Deserialize, Serialize};
use specta::Type;

/// 导入/发现候选。去重键为 `(plugin_id, account_id, remote_id)`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImportCandidate {
    pub plugin_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    pub remote_id: String,
    pub remote_kind: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub config: serde_json::Value,
}

impl ImportCandidate {
    pub fn dedupe_key(&self) -> (String, String, String) {
        (
            self.plugin_id.clone(),
            self.account_id.clone().unwrap_or_default(),
            self.remote_id.clone(),
        )
    }
}

/// 按三元组去重，后出现的覆盖先前（用于 upsert 预览）。
pub fn upsert_candidates(
    existing: &[ImportCandidate],
    incoming: &[ImportCandidate],
) -> Vec<ImportCandidate> {
    let mut out: Vec<ImportCandidate> = existing.to_vec();
    for item in incoming {
        let key = item.dedupe_key();
        if let Some(slot) = out.iter_mut().find(|c| c.dedupe_key() == key) {
            *slot = item.clone();
        } else {
            out.push(item.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_matches_triple() {
        let a = ImportCandidate {
            plugin_id: "omni.cloud.aliyun".into(),
            account_id: Some("acc-1".into()),
            remote_id: "i-123".into(),
            remote_kind: "ecs".into(),
            name: "old".into(),
            config: serde_json::json!({}),
        };
        let b = ImportCandidate {
            name: "new".into(),
            ..a.clone()
        };
        let merged = upsert_candidates(&[a.clone()], &[b]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].name, "new");

        let other = ImportCandidate {
            remote_id: "i-456".into(),
            name: "other".into(),
            ..a
        };
        let merged = upsert_candidates(&merged, &[other]);
        assert_eq!(merged.len(), 2);
    }
}
