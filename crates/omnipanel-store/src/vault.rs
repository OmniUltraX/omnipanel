use keyring::Entry;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};

/// keyring 服务名。
const SERVICE: &str = "omnipanel";
/// SQLCipher 主密钥在 keyring 中的账户名。
const MASTER_KEY_ACCOUNT: &str = "__sqlcipher_master_key__";

/// 系统钥匙串凭据保管。敏感数据（密码/私钥/Token、SQLCipher 主密钥）只存这里，
/// 本地库仅保存 `credential_ref` 关联。
pub struct Vault;

impl Vault {
    /// 写入/更新一条凭据。
    pub fn store(reference: &str, secret: &str) -> OmniResult<()> {
        entry(reference)?.set_password(secret).map_err(map_keyring)
    }

    /// 读取一条凭据。
    pub fn get(reference: &str) -> OmniResult<String> {
        entry(reference)?.get_password().map_err(map_keyring)
    }

    /// 删除一条凭据；不存在时视为成功（幂等）。
    pub fn delete(reference: &str) -> OmniResult<()> {
        match entry(reference)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(map_keyring(err)),
        }
    }

    /// 读取 SQLCipher 主密钥；首次运行生成 32 字节随机密钥写入 keyring。
    pub fn master_key() -> OmniResult<String> {
        let e = entry(MASTER_KEY_ACCOUNT)?;
        match e.get_password() {
            Ok(key) => Ok(key),
            Err(keyring::Error::NoEntry) => {
                let key = generate_key()?;
                e.set_password(&key).map_err(map_keyring)?;
                Ok(key)
            }
            Err(err) => Err(map_keyring(err)),
        }
    }
}

fn entry(account: &str) -> OmniResult<Entry> {
    Entry::new(SERVICE, account).map_err(map_keyring)
}

fn generate_key() -> OmniResult<String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "生成主密钥失败").with_cause(e.to_string())
    })?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn map_keyring(err: keyring::Error) -> OmniError {
    let code = match err {
        keyring::Error::NoEntry => ErrorCode::NotFound,
        _ => ErrorCode::Storage,
    };
    OmniError::new(code, "系统钥匙串操作失败").with_cause(err.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_key_is_64_hex_chars() {
        let key = generate_key().unwrap();
        assert_eq!(key.len(), 64);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn two_generated_keys_differ() {
        assert_ne!(generate_key().unwrap(), generate_key().unwrap());
    }

    // 以下测试需要真实系统钥匙串后端，CI（headless）默认跳过；本地用 `cargo test -- --ignored` 运行。
    #[test]
    #[ignore = "需要真实系统钥匙串后端"]
    fn store_get_delete_roundtrip() {
        let reference = "__omnipanel_test_cred__";
        Vault::store(reference, "s3cret").unwrap();
        assert_eq!(Vault::get(reference).unwrap(), "s3cret");
        Vault::delete(reference).unwrap();
        // 删除后再删仍成功（幂等）
        Vault::delete(reference).unwrap();
    }
}
