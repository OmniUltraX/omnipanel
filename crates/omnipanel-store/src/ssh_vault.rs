//! SSH / Docker / Panel / DB 凭据在钥匙串中的命名与注入。

use serde_json::Value;

use crate::vault::Vault;
use crate::ssh_keys::{ssh_key_passphrase_ref, ssh_key_private_ref};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};

pub fn ssh_password_ref(connection_id: &str) -> String {
    format!("ssh-password-{connection_id}")
}

pub fn ssh_pem_ref(connection_id: &str) -> String {
    format!("ssh-pem-{connection_id}")
}

pub fn ssh_passphrase_ref(connection_id: &str) -> String {
    format!("ssh-passphrase-{connection_id}")
}

pub fn db_password_ref(connection_id: &str) -> String {
    format!("db-password-{connection_id}")
}

pub fn ai_provider_key_ref(provider_id: &str) -> String {
    format!("ai-provider-{provider_id}")
}

pub fn http_proxy_password_ref() -> &'static str {
    "http-proxy-password"
}

pub fn embedding_api_key_ref() -> &'static str {
    "embedding-api-key"
}

/// 从 Vault 注入 SSH config 中的空密码 / PEM / passphrase。
/// 返回 (patched_config_json, password_for_vault_fallback)。
pub fn inject_ssh_vault_into_config(
    config_json: &str,
    connection_id: &str,
    credential_ref: Option<&str>,
) -> OmniResult<(String, Option<String>)> {
    let password = Vault::get(&ssh_password_ref(connection_id))
        .ok()
        .or_else(|| credential_ref.and_then(|r| Vault::get(r).ok()));

    let mut value: Value = serde_json::from_str(config_json).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(e.to_string())
    })?;

    if let Some(auth) = value.get_mut("auth").and_then(|a| a.as_object_mut()) {
        let auth_type = auth
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        if auth_type == "privateKey" || auth_type == "private_key" {
            let key_id = auth
                .get("keyId")
                .or_else(|| auth.get("key_id"))
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let pem_empty = auth
                .get("pem")
                .and_then(|v| v.as_str())
                .map(|s| s.is_empty())
                .unwrap_or(true);
            if pem_empty {
                if let Some(key_id) = key_id.as_deref() {
                    if let Ok(pem) = Vault::get(&ssh_key_private_ref(key_id)) {
                        auth.insert("pem".into(), Value::String(pem));
                    }
                } else if let Ok(pem) = Vault::get(&ssh_pem_ref(connection_id)) {
                    auth.insert("pem".into(), Value::String(pem));
                }
            }
            let pass_empty = auth
                .get("passphrase")
                .and_then(|v| v.as_str())
                .map(|s| s.is_empty())
                .unwrap_or(true);
            if pass_empty {
                if let Some(key_id) = key_id.as_deref() {
                    if let Ok(pp) = Vault::get(&ssh_key_passphrase_ref(key_id)) {
                        auth.insert("passphrase".into(), Value::String(pp));
                    }
                } else if let Ok(pp) = Vault::get(&ssh_passphrase_ref(connection_id)) {
                    auth.insert("passphrase".into(), Value::String(pp));
                }
            }
        }
    }

    let patched = serde_json::to_string(&value).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "SSH 配置序列化失败").with_cause(e.to_string())
    })?;
    Ok((patched, password))
}
