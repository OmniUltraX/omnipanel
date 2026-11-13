//! 把空间仓库的块和索引写到团队 OSS。列出对象做不到时跳过远端清理。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_store::{SpaceRepoRemote, SpaceSyncReport, open_bytes, seal_bytes, sync_local_repo};
use serde::{Deserialize, Serialize};

use crate::oss::{get_object_bytes_optional, strip_bucket_prefix, upload_object_bytes};
use crate::sts::AuthContext;
use crate::team_sync::{fetch_team_oss_sts, resolve_object_key};

pub struct OssSpaceRemote {
    sts: crate::sts::OssStsCredentials,
}

impl OssSpaceRemote {
    pub async fn open(auth: &AuthContext, team_id: i64) -> OmniResult<Self> {
        let sts = fetch_team_oss_sts(auth, team_id).await?;
        Ok(Self { sts })
    }

    fn object_key(&self, leaf: &str) -> OmniResult<String> {
        let key = resolve_object_key(&self.sts, &format!("repo/{leaf}"));
        let key = strip_bucket_prefix(&key, &self.sts.bucket);
        if key.is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "空间对象键为空"));
        }
        Ok(key)
    }
}

#[async_trait::async_trait]
impl SpaceRepoRemote for OssSpaceRemote {
    async fn exists(&mut self, key: &str) -> OmniResult<bool> {
        let object = self.object_key(key)?;
        let sts = self.sts.clone();
        crate::oss::with_deadline(async move {
            let http = crate::oss::space_http_client();
            crate::oss::object_exists(&http, &sts, &object).await
        })
        .await
    }

    async fn get(&mut self, key: &str) -> OmniResult<Option<Vec<u8>>> {
        let object = self.object_key(key)?;
        let sts = self.sts.clone();
        crate::oss::with_deadline(async move {
            let http = crate::oss::space_http_client();
            get_object_bytes_optional(&http, &sts, &object).await
        })
        .await
    }

    async fn put(&mut self, key: &str, bytes: &[u8]) -> OmniResult<()> {
        let object = self.object_key(key)?;
        let sts = self.sts.clone();
        let bytes = bytes.to_vec();
        crate::oss::with_deadline(async move {
            let http = crate::oss::space_http_client();
            upload_object_bytes(&http, &sts, &object, &bytes, "application/octet-stream").await?;
            Ok(())
        })
        .await
    }

    async fn delete(&mut self, key: &str) -> OmniResult<()> {
        let object = self.object_key(key)?;
        let sts = self.sts.clone();
        crate::oss::with_deadline(async move {
            let http = crate::oss::space_http_client();
            crate::oss::delete_object_bytes(&http, &sts, &object).await
        })
        .await
    }

    async fn list(&mut self, _prefix: &str) -> OmniResult<Vec<String>> {
        Err(OmniError::new(
            ErrorCode::Internal,
            "当前 OSS 凭证不能列出空间块",
        ))
    }
}

pub async fn team_repo_has_index(auth: &AuthContext, team_id: i64) -> OmniResult<bool> {
    let mut remote = OssSpaceRemote::open(auth, team_id).await?;
    Ok(remote.get("refs/latest").await?.is_some())
}

pub async fn sync_oss_space(
    auth: &AuthContext,
    team_id: i64,
    root: &Path,
    key: &[u8; 32],
    device_id: &str,
    legacy: &BTreeMap<String, Vec<u8>>,
    managed: &BTreeSet<String>,
) -> OmniResult<SpaceSyncReport> {
    let mut remote = OssSpaceRemote::open(auth, team_id).await?;
    sync_local_repo(root, &mut remote, key, device_id, legacy, managed).await
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceLocation {
    pub kind: String,
    pub endpoint: String,
    pub bucket: String,
    pub region: String,
    pub ready: bool,
}

const LOCATION_LEAF: &str = "storage.json";
const SECRET_LEAF: &str = "storage-secret.bin";

fn sibling_key(sts: &crate::sts::OssStsCredentials, leaf: &str) -> OmniResult<String> {
    let key = resolve_object_key(sts, leaf);
    let key = strip_bucket_prefix(&key, &sts.bucket);
    if key.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "空间对象键为空"));
    }
    Ok(key)
}

/// 存储位置写在官方 OSS 上，和 `repo/` 平级。密钥单独封起来，不进仓库。
pub async fn publish_space_location(
    auth: &AuthContext,
    team_id: i64,
    location: &SpaceLocation,
    access_key_id: &str,
    secret: &str,
    sync_key: &[u8; 32],
) -> OmniResult<()> {
    let sts = fetch_team_oss_sts(auth, team_id).await?;
    let body = serde_json::to_vec(location)
        .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
    let location_key = sibling_key(&sts, LOCATION_LEAF)?;
    let sts_for_location = sts.clone();
    crate::oss::with_deadline(async move {
        let http = crate::oss::space_http_client();
        upload_object_bytes(
            &http,
            &sts_for_location,
            &location_key,
            &body,
            "application/json",
        )
        .await?;
        Ok(())
    })
    .await?;
    if location.kind == "s3" {
        let plain = serde_json::json!({
            "accessKeyId": access_key_id,
            "secretAccessKey": secret,
        });
        let bytes = serde_json::to_vec(&plain)
            .map_err(|err| OmniError::new(ErrorCode::Internal, err.to_string()))?;
        let sealed = seal_bytes(sync_key, &bytes)?;
        let secret_key = sibling_key(&sts, SECRET_LEAF)?;
        crate::oss::with_deadline(async move {
            let http = crate::oss::space_http_client();
            upload_object_bytes(
                &http,
                &sts,
                &secret_key,
                &sealed,
                "application/octet-stream",
            )
            .await?;
            Ok(())
        })
        .await?;
    }
    Ok(())
}

pub async fn fetch_space_location(
    auth: &AuthContext,
    team_id: i64,
    sync_key: &[u8; 32],
) -> OmniResult<Option<(SpaceLocation, Option<(String, String)>)>> {
    let sts = fetch_team_oss_sts(auth, team_id).await?;
    let location_key = sibling_key(&sts, LOCATION_LEAF)?;
    let sts_for_location = sts.clone();
    let Some(bytes) = crate::oss::with_deadline(async move {
        let http = crate::oss::space_http_client();
        get_object_bytes_optional(&http, &sts_for_location, &location_key).await
    })
    .await?
    else {
        return Ok(None);
    };
    let location: SpaceLocation = serde_json::from_slice(&bytes).map_err(|err| {
        OmniError::new(ErrorCode::Internal, "存储位置无法解析").with_cause(err.to_string())
    })?;
    if location.kind != "s3" || !location.ready {
        return Ok(Some((location, None)));
    }
    let secret_key = sibling_key(&sts, SECRET_LEAF)?;
    let Some(blob) = crate::oss::with_deadline(async move {
        let http = crate::oss::space_http_client();
        get_object_bytes_optional(&http, &sts, &secret_key).await
    })
    .await?
    else {
        return Ok(Some((location, None)));
    };
    let plain = open_bytes(sync_key, &blob)?;
    let value: serde_json::Value = serde_json::from_slice(&plain).map_err(|err| {
        OmniError::new(ErrorCode::Internal, "存储密钥无法解析").with_cause(err.to_string())
    })?;
    let id = value
        .get("accessKeyId")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    let secret = value
        .get("secretAccessKey")
        .and_then(|item| item.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Some((location, Some((id, secret)))))
}
