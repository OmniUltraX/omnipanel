use keyring::Entry;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};

/// keyring 服务名。
const SERVICE: &str = "omnipanel";
/// SQLCipher 主密钥在 keyring 中的账户名。
const MASTER_KEY_ACCOUNT: &str = "__sqlcipher_master_key__";

/// 文件式凭据 fallback 目录（`~/.omnipd/secrets/`），仅在系统钥匙串不可用时启用。
/// 桌面端默认走系统钥匙串；Web 无头服务器（容器/无桌面环境）钥匙串后端不可用时，
/// 自动降级为本地文件（权限 0600），保证连接凭据可持久化。
const FILE_SECRETS_DIR: &str = "omnipd/secrets";

/// 系统钥匙串凭据保管。敏感数据（密码/私钥/Token、SQLCipher 主密钥）只存这里，
/// 本地库仅保存 `credential_ref` 关联。
///
/// ## 降级策略
/// - 优先系统钥匙串（桌面端）。
/// - keyring 后端初始化失败（无 D-Bus / 无桌面会话）或操作报
///   `PlatformFailure` / `NoStorageAccess` 等后端不可用错误时，自动降级为
///   `~/.omnipd/secrets/<reference>.secret` 文件（0600 权限）。
/// - `NoEntry` 不算后端不可用：它表示后端正常只是没有这条凭据，读操作返回 NotFound。
pub struct Vault;

impl Vault {
    /// 写入/更新一条凭据。
    pub fn store(reference: &str, secret: &str) -> OmniResult<()> {
        match entry(reference).and_then(|e| e.set_password(secret).map_err(map_keyring)) {
            Ok(()) => Ok(()),
            Err(e) if keyring_backend_unavailable(&e) => file_store(reference, secret),
            Err(e) => Err(e),
        }
    }

    /// 读取一条凭据。
    pub fn get(reference: &str) -> OmniResult<String> {
        match entry(reference).and_then(|e| e.get_password().map_err(map_keyring)) {
            Ok(secret) => Ok(secret),
            Err(e) if keyring_backend_unavailable(&e) => file_get(reference),
            Err(e) => Err(e),
        }
    }

    /// 删除一条凭据；不存在时视为成功（幂等）。
    pub fn delete(reference: &str) -> OmniResult<()> {
        match entry(reference) {
            Ok(e) => match e.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(err) => {
                    let mapped = map_keyring(err);
                    if keyring_backend_unavailable(&mapped) {
                        file_delete(reference)
                    } else {
                        Err(mapped)
                    }
                }
            },
            Err(_) => file_delete(reference),
        }
    }

    /// 读取 SQLCipher 主密钥；首次运行生成 32 字节随机密钥写入 keyring（或 fallback 文件）。
    pub fn master_key() -> OmniResult<String> {
        match Self::get(MASTER_KEY_ACCOUNT) {
            Ok(key) => Ok(key),
            Err(e) if e.code == ErrorCode::NotFound => {
                let key = generate_key()?;
                Self::store(MASTER_KEY_ACCOUNT, &key)?;
                Ok(key)
            }
            Err(e) if keyring_backend_unavailable(&e) => {
                // 与 get 的降级一致：文件也不存在时生成并写入
                let key = file_get(MASTER_KEY_ACCOUNT)
                    .or_else(|_| generate_key().and_then(|k| file_store(MASTER_KEY_ACCOUNT, &k).map(|_| k)))?;
                Ok(key)
            }
            Err(e) => Err(e),
        }
    }
}

fn entry(account: &str) -> OmniResult<Entry> {
    Entry::new(SERVICE, account).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "系统钥匙串不可用").with_cause(e.to_string())
    })
}

/// keyring 后端是否不可用（区别于「后端正常但没这条凭据」）。
/// 不可用时降级到文件存储；`NoEntry` 属于正常语义不降级。
fn keyring_backend_unavailable(err: &OmniError) -> bool {
    // store/get 已把 keyring::Error 映射为 OmniError；
    // 后端不可用的典型错误：PlatformFailure / NoStorageAccess / Ambiguous 等，
    // 映射后 code=Storage。NoEntry 映射为 NotFound（正常语义）。
    err.code == ErrorCode::Storage
}

fn file_secrets_dir() -> OmniResult<std::path::PathBuf> {
    let home = std::env::var(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map_err(|_| OmniError::new(ErrorCode::Internal, "无法获取用户主目录"))?;
    Ok(std::path::PathBuf::from(home).join(FILE_SECRETS_DIR))
}

fn file_path(reference: &str) -> OmniResult<std::path::PathBuf> {
    // reference 可能含特殊字符（`ai-provider-openai` 等），保险起见清洗。
    let safe: String = reference
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Ok(file_secrets_dir()?.join(format!("{safe}.secret")))
}

fn file_store(reference: &str, secret: &str) -> OmniResult<()> {
    let dir = file_secrets_dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "创建凭据目录失败").with_cause(e.to_string())
    })?;
    let path = file_path(reference)?;
    std::fs::write(&path, secret).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "写入凭据文件失败").with_cause(e.to_string())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn file_get(reference: &str) -> OmniResult<String> {
    let path = file_path(reference)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            Err(OmniError::new(ErrorCode::NotFound, "凭据不存在").with_cause(e.to_string()))
        }
        Err(e) => Err(OmniError::new(ErrorCode::Storage, "读取凭据失败").with_cause(e.to_string())),
    }
}

fn file_delete(reference: &str) -> OmniResult<()> {
    let path = file_path(reference)?;
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| {
            OmniError::new(ErrorCode::Storage, "删除凭据文件失败").with_cause(e.to_string())
        })?;
    }
    Ok(())
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

    #[test]
    fn file_secrets_dir_is_under_home() {
        let dir = file_secrets_dir().unwrap();
        assert!(dir.ends_with("omnipd/secrets"));
    }

    #[test]
    fn reference_is_sanitized() {
        let path = file_path("a/b:bad?ref").unwrap();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(!name.contains('/'));
        assert!(name.ends_with(".secret"));
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
