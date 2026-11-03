//! 用户自己的 S3 桶。对象键与官方 OSS 一样落在 `repo/` 下面。

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use omnipanel_error::OmniResult;
use omnipanel_s3::{S3Client, S3Config};
use omnipanel_store::{SpaceRepoRemote, SpaceSyncReport, sync_local_repo};

pub struct S3SpaceRemote {
    client: S3Client,
}

impl S3SpaceRemote {
    pub fn open(
        endpoint: &str,
        bucket: &str,
        region: &str,
        access_key_id: &str,
        secret: &str,
    ) -> OmniResult<Self> {
        let cfg = S3Config {
            bucket: bucket.to_string(),
            provider: provider_of(endpoint),
            region: if region.trim().is_empty() {
                "auto".into()
            } else {
                region.to_string()
            },
            endpoint: endpoint.to_string(),
            access_key: access_key_id.to_string(),
            prefix: String::new(),
        };
        Ok(Self {
            client: S3Client::new(cfg, secret.to_string())?,
        })
    }

    fn full(leaf: &str) -> String {
        format!("repo/{leaf}")
    }
}

fn provider_of(endpoint: &str) -> String {
    let host = endpoint.to_ascii_lowercase();
    if host.contains("aliyuncs.com") {
        "aliyun".into()
    } else if host.contains("myqcloud.com") {
        "tencent".into()
    } else if host.contains("qiniu") {
        "qiniu".into()
    } else {
        "aws".into()
    }
}

#[async_trait::async_trait]
impl SpaceRepoRemote for S3SpaceRemote {
    async fn get(&mut self, key: &str) -> OmniResult<Option<Vec<u8>>> {
        self.client.get_object_optional(&Self::full(key)).await
    }

    async fn put(&mut self, key: &str, bytes: &[u8]) -> OmniResult<()> {
        self.client.put_object(&Self::full(key), bytes).await
    }

    async fn delete(&mut self, key: &str) -> OmniResult<()> {
        self.client.delete_object(&Self::full(key)).await
    }

    async fn list(&mut self, prefix: &str) -> OmniResult<Vec<String>> {
        let mut out = Vec::new();
        let mut token = None;
        loop {
            let page = self
                .client
                .list_objects_v2(Self::full(prefix), None, token.clone(), Some(1000))
                .await?;
            for item in page.contents {
                if let Some(leaf) = item.key.strip_prefix("repo/") {
                    out.push(leaf.to_string());
                }
            }
            if !page.is_truncated {
                break;
            }
            token = page.next_continuation_token;
            if token.is_none() {
                break;
            }
        }
        Ok(out)
    }
}

pub async fn sync_s3_space(
    endpoint: &str,
    bucket: &str,
    region: &str,
    access_key_id: &str,
    secret: &str,
    root: &Path,
    key: &[u8; 32],
    device_id: &str,
    legacy: &BTreeMap<String, Vec<u8>>,
    managed: &BTreeSet<String>,
) -> OmniResult<SpaceSyncReport> {
    let mut remote = S3SpaceRemote::open(endpoint, bucket, region, access_key_id, secret)?;
    sync_local_repo(root, &mut remote, key, device_id, legacy, managed).await
}

/// 放弃这个桶时删掉里面的空间对象。官方 OSS 没有删除接口，不走这里。
pub async fn purge_s3_repo(
    endpoint: &str,
    bucket: &str,
    region: &str,
    access_key_id: &str,
    secret: &str,
) -> OmniResult<u32> {
    let mut remote = S3SpaceRemote::open(endpoint, bucket, region, access_key_id, secret)?;
    let keys = remote.list("").await?;
    let count = u32::try_from(keys.len()).unwrap_or(u32::MAX);
    for key in keys {
        remote.delete(&key).await?;
    }
    Ok(count)
}
