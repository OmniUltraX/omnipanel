use std::collections::BTreeMap;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
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

/// 系统钥匙串凭据保管。敏感数据（密码/私钥/Token）放进主密钥加密的本地包，
/// 钥匙串里只留 SQLCipher 主密钥这一条。macOS 更新后登录钥匙串会按程序指纹逐条要求
/// Touch ID；合成一把之后，更新或重新打开只问这一次。本地库仅保存 `credential_ref`。
///
/// ## 降级策略
/// - 优先系统钥匙串里的主密钥，业务秘密放加密包。
/// - 旧的逐条钥匙串项在第一次读到时迁入包内并删除。
/// - keyring 后端初始化失败（无 D-Bus / 无桌面会话）或操作报
///   `PlatformFailure` / `NoStorageAccess` 等后端不可用错误时，自动降级为
///   `~/.omnipd/secrets/<reference>.secret` 文件（0600 权限）。
/// - `NoEntry` 不算后端不可用：它表示后端正常只是没有这条凭据，读操作返回 NotFound。
pub struct Vault;

/// 插件私密凭据引用：`plugin:{plugin_id}:{key}`，禁止跨插件读写。
pub fn plugin_secret_ref(plugin_id: &str, key: &str) -> OmniResult<String> {
    let plugin_id = plugin_id.trim();
    let key = key.trim();
    if plugin_id.is_empty() {
        return Err(OmniError::invalid_input("插件 id 不能为空"));
    }
    if key.is_empty()
        || key.len() > 64
        || key.contains("..")
        || !key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
    {
        return Err(OmniError::invalid_input("非法凭据键"));
    }
    Ok(format!("plugin:{plugin_id}:{key}"))
}

impl Vault {
    /// 写入/更新一条凭据。
    pub fn store(reference: &str, secret: &str) -> OmniResult<()> {
        if reference == MASTER_KEY_ACCOUNT {
            let stored = raw_store(reference, secret);
            if stored.is_ok() {
                cache_master(secret);
            }
            return stored;
        }
        bundle_insert(reference, secret)
    }

    /// 读取一条凭据。
    pub fn get(reference: &str) -> OmniResult<String> {
        if reference == MASTER_KEY_ACCOUNT {
            return Self::master_key();
        }
        bundle_get(reference)
    }

    /// 删除一条凭据；不存在时视为成功（幂等）。
    pub fn delete(reference: &str) -> OmniResult<()> {
        if reference == MASTER_KEY_ACCOUNT {
            clear_master_cache();
            return raw_delete(reference);
        }
        bundle_remove(reference)
    }

    /// 读取 SQLCipher 主密钥；首次运行生成 32 字节随机密钥写入 keyring（或 fallback 文件）。
    /// 进程内只问一次钥匙串，后面的业务秘密用这把密钥解开本地包。
    pub fn master_key() -> OmniResult<String> {
        if let Some(key) = lock(&MASTER_CACHE).clone() {
            return Ok(key);
        }
        let key = match raw_get(MASTER_KEY_ACCOUNT) {
            Ok(key) => key,
            Err(e) if e.code == ErrorCode::NotFound => {
                let key = generate_key()?;
                raw_store(MASTER_KEY_ACCOUNT, &key)?;
                key
            }
            Err(e) if keyring_backend_unavailable(&e) => {
                file_get(MASTER_KEY_ACCOUNT).or_else(|_| {
                    generate_key().and_then(|k| file_store(MASTER_KEY_ACCOUNT, &k).map(|_| k))
                })?
            }
            Err(e) => return Err(e),
        };
        cache_master(&key);
        Ok(key)
    }
}

fn cache_master(key: &str) {
    *lock(&MASTER_CACHE) = Some(key.to_string());
}

fn clear_master_cache() {
    *lock(&MASTER_CACHE) = None;
    *lock(&BUNDLE_CACHE) = None;
}

fn raw_store(reference: &str, secret: &str) -> OmniResult<()> {
    match entry(reference).and_then(|e| e.set_password(secret).map_err(map_keyring)) {
        Ok(()) => Ok(()),
        Err(e) if keyring_backend_unavailable(&e) => file_store(reference, secret),
        Err(e) => Err(e),
    }
}

fn raw_get(reference: &str) -> OmniResult<String> {
    match entry(reference).and_then(|e| e.get_password().map_err(map_keyring)) {
        Ok(secret) => Ok(secret),
        Err(e) if keyring_backend_unavailable(&e) => file_get(reference),
        Err(e) => Err(e),
    }
}

fn raw_delete(reference: &str) -> OmniResult<()> {
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

static MASTER_CACHE: Mutex<Option<String>> = Mutex::new(None);
static BUNDLE_CACHE: Mutex<Option<BTreeMap<String, String>>> = Mutex::new(None);
static BUNDLE_IO: Mutex<()> = Mutex::new(());

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

fn bundle_get(reference: &str) -> OmniResult<String> {
    let _io = lock(&BUNDLE_IO);
    let mut cache = lock(&BUNDLE_CACHE);
    if cache.is_none() {
        *cache = Some(read_bundle()?);
    }
    if let Some(value) = cache.as_ref().and_then(|map| map.get(reference)).cloned() {
        return Ok(value);
    }
    let migrated = match raw_get(reference) {
        Ok(value) => value,
        Err(err) if err.code == ErrorCode::NotFound || keyring_backend_unavailable(&err) => {
            match file_get(reference) {
                Ok(value) => value,
                Err(_) if err.code == ErrorCode::NotFound => return Err(err),
                Err(file_err) => return Err(file_err),
            }
        }
        Err(err) => return Err(err),
    };
    if let Some(map) = cache.as_mut() {
        map.insert(reference.to_string(), migrated.clone());
        if let Err(err) = write_bundle(map) {
            map.remove(reference);
            return Err(err);
        }
    }
    drop(cache);
    let _ = raw_delete(reference);
    let _ = file_delete(reference);
    Ok(migrated)
}

fn bundle_insert(reference: &str, secret: &str) -> OmniResult<()> {
    let _io = lock(&BUNDLE_IO);
    let mut cache = lock(&BUNDLE_CACHE);
    if cache.is_none() {
        *cache = Some(read_bundle()?);
    }
    let Some(map) = cache.as_mut() else {
        return Err(OmniError::new(ErrorCode::Storage, "凭据包未就绪"));
    };
    let previous = map.insert(reference.to_string(), secret.to_string());
    if let Err(err) = write_bundle(map) {
        match previous {
            Some(old) => {
                map.insert(reference.to_string(), old);
            }
            None => {
                map.remove(reference);
            }
        }
        return Err(err);
    }
    drop(cache);
    let _ = raw_delete(reference);
    let _ = file_delete(reference);
    Ok(())
}

fn bundle_remove(reference: &str) -> OmniResult<()> {
    let _io = lock(&BUNDLE_IO);
    let mut cache = lock(&BUNDLE_CACHE);
    if cache.is_none() {
        *cache = Some(read_bundle()?);
    }
    if let Some(map) = cache.as_mut() {
        if let Some(old) = map.remove(reference) {
            if let Err(err) = write_bundle(map) {
                map.insert(reference.to_string(), old);
                return Err(err);
            }
        }
    }
    drop(cache);
    raw_delete(reference)?;
    file_delete(reference)
}

fn bundle_path() -> OmniResult<std::path::PathBuf> {
    Ok(file_secrets_dir()?.join("vault.bundle"))
}

fn read_bundle() -> OmniResult<BTreeMap<String, String>> {
    let path = bundle_path()?;
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(err) => {
            return Err(
                OmniError::new(ErrorCode::Storage, "读取凭据包失败").with_cause(err.to_string())
            );
        }
    };
    if bytes.is_empty() {
        return Ok(BTreeMap::new());
    }
    open_bundle(&Vault::master_key()?, &bytes)
}

fn write_bundle(map: &BTreeMap<String, String>) -> OmniResult<()> {
    let dir = file_secrets_dir()?;
    std::fs::create_dir_all(&dir).map_err(|err| {
        OmniError::new(ErrorCode::Storage, "创建凭据目录失败").with_cause(err.to_string())
    })?;
    let bytes = seal_bundle(&Vault::master_key()?, map)?;
    let path = bundle_path()?;
    std::fs::write(&path, bytes).map_err(|err| {
        OmniError::new(ErrorCode::Storage, "写入凭据包失败").with_cause(err.to_string())
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn bundle_key_bytes(master_hex: &str) -> OmniResult<[u8; 32]> {
    if master_hex.len() != 64 {
        return Err(OmniError::new(ErrorCode::Storage, "主密钥长度无效"));
    }
    let mut key = [0u8; 32];
    for (index, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&master_hex[index * 2..index * 2 + 2], 16)
            .map_err(|_| OmniError::new(ErrorCode::Storage, "主密钥不是十六进制"))?;
    }
    Ok(key)
}

fn seal_bundle(master_hex: &str, map: &BTreeMap<String, String>) -> OmniResult<Vec<u8>> {
    let plain = serde_json::to_vec(map).map_err(|err| {
        OmniError::new(ErrorCode::Internal, "序列化凭据包失败").with_cause(err.to_string())
    })?;
    let mut nonce_bytes = [0u8; 12];
    getrandom::getrandom(&mut nonce_bytes).map_err(|err| {
        OmniError::new(ErrorCode::Storage, "生成凭据包随机数失败").with_cause(err.to_string())
    })?;
    let cipher = Aes256Gcm::new_from_slice(&bundle_key_bytes(master_hex)?).map_err(|err| {
        OmniError::new(ErrorCode::Internal, "初始化凭据包加密失败").with_cause(err.to_string())
    })?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plain.as_ref())
        .map_err(|err| {
            OmniError::new(ErrorCode::Internal, "加密凭据包失败").with_cause(err.to_string())
        })?;
    let mut out = b"OVB1".to_vec();
    out.extend(nonce_bytes);
    out.extend(ciphertext);
    Ok(out)
}

fn open_bundle(master_hex: &str, bytes: &[u8]) -> OmniResult<BTreeMap<String, String>> {
    if bytes.len() < 16 || &bytes[..4] != b"OVB1" {
        return Err(OmniError::new(ErrorCode::Storage, "凭据包格式无效"));
    }
    let nonce = Nonce::from_slice(&bytes[4..16]);
    let cipher = Aes256Gcm::new_from_slice(&bundle_key_bytes(master_hex)?).map_err(|err| {
        OmniError::new(ErrorCode::Internal, "初始化凭据包加密失败").with_cause(err.to_string())
    })?;
    let plain = cipher
        .decrypt(nonce, &bytes[16..])
        .map_err(|_| OmniError::new(ErrorCode::Storage, "解开凭据包失败"))?;
    serde_json::from_slice(&plain).map_err(|err| {
        OmniError::new(ErrorCode::Storage, "凭据包内容无效").with_cause(err.to_string())
    })
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
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
    fn plugin_secret_ref_rejects_traversal() {
        assert!(plugin_secret_ref("omni.importer.warpgate", "src-1").is_ok());
        assert!(plugin_secret_ref("omni.importer.warpgate", "../etc").is_err());
        assert!(plugin_secret_ref("", "src-1").is_err());
    }

    #[test]
    fn file_secrets_dir_is_under_home() {
        let dir = file_secrets_dir().unwrap();
        assert!(dir.ends_with("omnipd/secrets"));
    }

    #[test]
    fn bundle_roundtrip_keeps_entries() {
        let key = generate_key().unwrap();
        let mut map = BTreeMap::new();
        map.insert(
            "ssh-key-priv-a".into(),
            "-----BEGIN OPENSSH PRIVATE KEY-----\n".into(),
        );
        map.insert("db-password-b".into(), "s3cret".into());
        let sealed = seal_bundle(&key, &map).unwrap();
        let opened = open_bundle(&key, &sealed).unwrap();
        assert_eq!(opened, map);
        assert!(open_bundle(&generate_key().unwrap(), &sealed).is_err());
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
