use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};

use crate::storage::{Storage, map_sqlite};
use crate::Vault;

/// 第三方平台。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ThirdPartyPlatform {
    Github,
    Gitlab,
    Gitee,
    DockerHub,
    Aws,
    Aliyun,
    Tencent,
    Custom,
}

impl ThirdPartyPlatform {
    fn as_str(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
            Self::Gitee => "gitee",
            Self::DockerHub => "docker_hub",
            Self::Aws => "aws",
            Self::Aliyun => "aliyun",
            Self::Tencent => "tencent",
            Self::Custom => "custom",
        }
    }

    fn parse(s: &str) -> OmniResult<Self> {
        match s {
            "github" => Ok(Self::Github),
            "gitlab" => Ok(Self::Gitlab),
            "gitee" => Ok(Self::Gitee),
            "docker_hub" => Ok(Self::DockerHub),
            "aws" => Ok(Self::Aws),
            "aliyun" => Ok(Self::Aliyun),
            "tencent" => Ok(Self::Tencent),
            "custom" => Ok(Self::Custom),
            other => Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知第三方平台: {other}"),
            )),
        }
    }
}

/// 验证方式：API 密钥或用户名密码。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "snake_case")]
pub enum ThirdPartyAuthMethod {
    ApiKey,
    Password,
}

impl ThirdPartyAuthMethod {
    fn as_str(self) -> &'static str {
        match self {
            Self::ApiKey => "api_key",
            Self::Password => "password",
        }
    }

    fn parse(s: &str) -> OmniResult<Self> {
        match s {
            "api_key" => Ok(Self::ApiKey),
            "password" => Ok(Self::Password),
            other => Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知验证方式: {other}"),
            )),
        }
    }
}

/// 第三方账户（列表展示，不含敏感凭据）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyAccount {
    pub id: String,
    pub name: String,
    pub platform: ThirdPartyPlatform,
    pub auth_method: ThirdPartyAuthMethod,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub notes: String,
    /// 是否已在钥匙串中保存密钥/密码。
    pub has_secret: bool,
    #[specta(type = f64)]
    pub created_at: i64,
    #[specta(type = f64)]
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct UpsertThirdPartyAccountInput {
    pub id: Option<String>,
    pub name: String,
    pub platform: ThirdPartyPlatform,
    pub auth_method: ThirdPartyAuthMethod,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub notes: String,
    /// 新建必填；编辑时留空表示保留原凭据。
    pub secret: Option<String>,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("tpa-{nanos:x}")
}

pub fn credential_ref_for(id: &str) -> String {
    format!("third-party-account-{id}")
}

impl Storage {
    pub fn list_third_party_accounts(&self) -> OmniResult<Vec<ThirdPartyAccount>> {
        let mut stmt = self
            .conn()
            .prepare(
                "SELECT id, name, platform, auth_method, username, notes, credential_ref, created_at, updated_at
             FROM third_party_accounts ORDER BY updated_at DESC",
            )
            .map_err(map_sqlite)?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            })
            .map_err(map_sqlite)?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, platform, auth_method, username, notes, credential_ref, created_at, updated_at) =
                row.map_err(map_sqlite)?;
            out.push(ThirdPartyAccount {
                id,
                name,
                platform: ThirdPartyPlatform::parse(&platform)?,
                auth_method: ThirdPartyAuthMethod::parse(&auth_method)?,
                username,
                notes,
                has_secret: credential_ref.is_some(),
                created_at,
                updated_at,
            });
        }
        Ok(out)
    }

    pub fn get_third_party_account(&self, id: &str) -> OmniResult<Option<ThirdPartyAccount>> {
        Ok(self
            .list_third_party_accounts()?
            .into_iter()
            .find(|a| a.id == id))
    }

    pub fn upsert_third_party_account(
        &self,
        input: UpsertThirdPartyAccountInput,
    ) -> OmniResult<ThirdPartyAccount> {
        let name = input.name.trim();
        if name.is_empty() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "账户名称不能为空"));
        }

        let now = now_secs();
        let id = input
            .id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(gen_id);
        let cred_ref = credential_ref_for(&id);

        let existing = self.get_third_party_account(&id)?;
        let created_at = existing.as_ref().map(|a| a.created_at).unwrap_or(now);

        let secret = input.secret.filter(|s| !s.trim().is_empty());
        if existing.is_none() && secret.is_none() {
            return Err(OmniError::new(ErrorCode::InvalidInput, "请填写密钥或密码"));
        }
        if input.auth_method == ThirdPartyAuthMethod::Password
            && input.username.trim().is_empty()
        {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "用户名密码方式需要填写用户名",
            ));
        }

        let mut credential_ref: Option<String> = self
            .conn()
            .query_row(
                "SELECT credential_ref FROM third_party_accounts WHERE id = ?1",
                [&id],
                |row| row.get(0),
            )
            .unwrap_or(None);

        if let Some(secret) = secret {
            Vault::store(&cred_ref, secret.trim())?;
            credential_ref = Some(cred_ref);
        }

        self.conn()
            .execute(
            "INSERT INTO third_party_accounts (id, name, platform, auth_method, username, notes, credential_ref, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                platform = excluded.platform,
                auth_method = excluded.auth_method,
                username = excluded.username,
                notes = excluded.notes,
                credential_ref = excluded.credential_ref,
                updated_at = excluded.updated_at",
            rusqlite::params![
                id,
                name,
                input.platform.as_str(),
                input.auth_method.as_str(),
                input.username.trim(),
                input.notes.trim(),
                credential_ref,
                created_at,
                now,
            ],
            )
            .map_err(map_sqlite)?;

        self.get_third_party_account(&id)?
            .ok_or_else(|| OmniError::new(ErrorCode::Storage, "保存第三方账户失败"))
    }

    pub fn delete_third_party_account(&self, id: &str) -> OmniResult<()> {
        let cred_ref: Option<String> = self
            .conn()
            .query_row(
                "SELECT credential_ref FROM third_party_accounts WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .ok()
            .flatten();

        self.conn()
            .execute("DELETE FROM third_party_accounts WHERE id = ?1", [id])
            .map_err(map_sqlite)?;

        if let Some(cred_ref) = cred_ref {
            let _ = Vault::delete(&cred_ref);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upsert_requires_secret_for_new_account() {
        let storage = Storage::open_in_memory().unwrap();
        let err = storage
            .upsert_third_party_account(UpsertThirdPartyAccountInput {
                id: None,
                name: "GitHub".into(),
                platform: ThirdPartyPlatform::Github,
                auth_method: ThirdPartyAuthMethod::ApiKey,
                username: String::new(),
                notes: String::new(),
                secret: None,
            })
            .unwrap_err();
        assert!(err.to_string().contains("密钥"));
    }

    #[test]
    fn password_auth_requires_username() {
        let storage = Storage::open_in_memory().unwrap();
        let err = storage
            .upsert_third_party_account(UpsertThirdPartyAccountInput {
                id: None,
                name: "Docker Hub".into(),
                platform: ThirdPartyPlatform::DockerHub,
                auth_method: ThirdPartyAuthMethod::Password,
                username: String::new(),
                notes: String::new(),
                secret: Some("secret".into()),
            })
            .unwrap_err();
        assert!(err.to_string().contains("用户名"));
    }
}
