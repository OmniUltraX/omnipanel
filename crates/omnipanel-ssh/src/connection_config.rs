use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde_json::Value;

use crate::{SshAuth, SshConfig};

fn auth_type_str(auth: &Value) -> Option<&str> {
    auth.get("type")
        .and_then(|t| t.as_str())
        .map(str::trim)
        .filter(|t| !t.is_empty())
}

fn password_from_auth_value(auth: &Value) -> Option<String> {
    if let Some(p) = auth.get("password") {
        if let Some(s) = p.as_str().filter(|s| !s.is_empty()) {
            return Some(s.to_string());
        }
        // specta 反序列化形态：{ "password": { "type": "password", "password": "..." } }
        if let Some(nested) = p
            .get("password")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
        {
            return Some(nested.to_string());
        }
    }
    None
}

fn is_password_auth_intent(auth: &Value) -> bool {
    match auth_type_str(auth) {
        Some("password") => true,
        Some("privateKey") | Some("private_key") => false,
        _ => {
            if auth
                .get("authMethod")
                .or_else(|| auth.get("auth_method"))
                .and_then(|v| v.as_str())
                == Some("password")
            {
                return true;
            }
            password_from_auth_value(auth).is_some()
        }
    }
}

/// 从持久化的连接 `config` JSON 解析 SSH 配置，按 `auth.type` 选择认证方式。
///
/// `vault_secret` 为钥匙串中的密码（`credential_ref`），在配置内密码为空时作为回退。
pub fn ssh_config_from_json(
    config_json: &str,
    vault_secret: Option<&str>,
) -> OmniResult<SshConfig> {
    let value: Value = serde_json::from_str(config_json).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(e.to_string())
    })?;

    let host = value
        .get("host")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "SSH 主机地址未配置"))?
        .to_string();
    let port = value
        .get("port")
        .and_then(|v| v.as_u64())
        .unwrap_or(22)
        .clamp(1, u16::MAX as u64) as u16;
    let user = value
        .get("user")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|u| !u.is_empty())
        .unwrap_or("root")
        .to_string();

    let public_ip = value
        .get("publicIp")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(str::to_string);

    if let Some(auth) = value.get("auth").filter(|a| a.is_object()) {
        if is_password_auth_intent(auth) {
            let password = password_from_auth_value(auth)
                .or_else(|| vault_secret.map(str::to_string))
                .ok_or_else(|| OmniError::new(ErrorCode::Auth, "SSH 密码未配置"))?;
            return Ok(SshConfig {
                host,
                port,
                user,
                auth: SshAuth::Password { password },
                public_ip,
            });
        }
    }

    serde_json::from_value(value).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn password_auth_from_json() {
        let json = r#"{"host":"10.0.0.1","port":22,"user":"root","auth":{"type":"password","password":"secret"}}"#;
        let cfg = ssh_config_from_json(json, None).unwrap();
        assert!(matches!(cfg.auth, SshAuth::Password { .. }));
        assert_eq!(cfg.host, "10.0.0.1");
    }

    #[test]
    fn password_auth_not_replaced_by_private_key_fields() {
        let json = r#"{"host":"h","port":22,"user":"u","auth":{"type":"password","password":"pw","keyPath":"auto"}}"#;
        let cfg = ssh_config_from_json(json, None).unwrap();
        assert!(matches!(cfg.auth, SshAuth::Password { password } if password == "pw"));
    }

    #[test]
    fn private_key_auth_still_works() {
        let json = r#"{"host":"h","port":22,"user":"u","auth":{"type":"privateKey","keyPath":"auto","pem":null,"passphrase":null}}"#;
        let cfg = ssh_config_from_json(json, None).unwrap();
        assert!(matches!(cfg.auth, SshAuth::PrivateKey { .. }));
    }

    #[test]
    fn legacy_password_without_type() {
        let json = r#"{"host":"h","port":22,"user":"u","auth":{"password":"legacy"}}"#;
        let cfg = ssh_config_from_json(json, None).unwrap();
        assert!(matches!(cfg.auth, SshAuth::Password { password } if password == "legacy"));
    }

    #[test]
    fn password_from_vault_when_config_empty() {
        let json = r#"{"host":"h","port":22,"user":"u","auth":{"type":"password","password":""}}"#;
        let cfg = ssh_config_from_json(json, Some("vault-pw")).unwrap();
        assert!(matches!(cfg.auth, SshAuth::Password { password } if password == "vault-pw"));
    }

    #[test]
    fn specta_nested_password_shape() {
        let json = r#"{"host":"h","port":22,"user":"u","auth":{"password":{"type":"password","password":"nested"}}}"#;
        let cfg = ssh_config_from_json(json, None).unwrap();
        assert!(matches!(cfg.auth, SshAuth::Password { password } if password == "nested"));
    }
}
