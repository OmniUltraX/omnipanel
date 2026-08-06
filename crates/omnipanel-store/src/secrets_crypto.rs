//! 跨设备密文凭据库：主密码 → Argon2id → AES-256-GCM。
//!
//! - Master Key 仅存于内存，不落盘、不上传。
//! - OSS / 本地只存：salt + nonce + ciphertext（含 GCM tag）。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, ZeroizeOnDrop};

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// Argon2id 参数：偏桌面交互延迟，抗 GPU 暴力。
const ARGON2_M_KIB: u32 = 64 * 1024;
const ARGON2_T: u32 = 3;
const ARGON2_P: u32 = 1;

/// 内存中的 Master Key（进程结束/锁定即清零）。
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct MasterKey(pub [u8; KEY_LEN]);

/// 上传到 OSS 的信封（无明文）。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultEnvelope {
    pub version: u32,
    pub kdf: String,
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub updated_at: i64,
    pub device_code: String,
    pub secret_count: u32,
}

/// 加密前的明文库。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPlaintext {
    pub version: u32,
    pub exported_at: i64,
    pub entries: Vec<SecretsVaultEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultEntry {
    pub reference: String,
    pub value: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub label: String,
}

pub fn generate_salt() -> OmniResult<[u8; SALT_LEN]> {
    let mut salt = [0u8; SALT_LEN];
    getrandom::getrandom(&mut salt).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "生成 Master Salt 失败").with_cause(e.to_string())
    })?;
    Ok(salt)
}

pub fn generate_nonce() -> OmniResult<[u8; NONCE_LEN]> {
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::getrandom(&mut nonce).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "生成 AES nonce 失败").with_cause(e.to_string())
    })?;
    Ok(nonce)
}

fn argon2() -> OmniResult<Argon2<'static>> {
    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(KEY_LEN)).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "Argon2 参数无效").with_cause(e.to_string())
    })?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

/// 主密码 + salt → 256-bit Master Key。
pub fn derive_master_key(password: &str, salt: &[u8]) -> OmniResult<MasterKey> {
    if password.is_empty() {
        return Err(OmniError::invalid_input("主密码不能为空"));
    }
    if salt.len() < SALT_LEN {
        return Err(OmniError::invalid_input("Master Salt 过短"));
    }
    let hasher = argon2()?;
    let mut key = [0u8; KEY_LEN];
    hasher
        .hash_password_into(password.as_bytes(), salt, &mut key)
        .map_err(|e| {
            OmniError::new(ErrorCode::Auth, "派生 Master Key 失败").with_cause(e.to_string())
        })?;
    Ok(MasterKey(key))
}

pub fn encrypt_vault_with_salt(
    key: &MasterKey,
    plaintext: &SecretsVaultPlaintext,
    device_code: &str,
    salt: &[u8],
) -> OmniResult<SecretsVaultEnvelope> {
    let body = serde_json::to_vec(plaintext).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化凭据库失败").with_cause(e.to_string())
    })?;
    let nonce_bytes = generate_nonce()?;
    let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "初始化 AES-GCM 失败").with_cause(e.to_string())
    })?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, body.as_ref()).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "加密凭据库失败").with_cause(e.to_string())
    })?;
    Ok(SecretsVaultEnvelope {
        version: 1,
        kdf: "argon2id".into(),
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(ciphertext),
        updated_at: plaintext.exported_at,
        device_code: device_code.to_string(),
        secret_count: plaintext.entries.len() as u32,
    })
}

pub fn decrypt_vault(password: &str, envelope: &SecretsVaultEnvelope) -> OmniResult<SecretsVaultPlaintext> {
    let salt = B64.decode(envelope.salt_b64.trim()).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析 Master Salt 失败").with_cause(e.to_string())
    })?;
    let nonce_bytes = B64.decode(envelope.nonce_b64.trim()).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析 nonce 失败").with_cause(e.to_string())
    })?;
    let ciphertext = B64.decode(envelope.ciphertext_b64.trim()).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析密文失败").with_cause(e.to_string())
    })?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(OmniError::invalid_input("nonce 长度无效"));
    }
    let key = derive_master_key(password, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key.0).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "初始化 AES-GCM 失败").with_cause(e.to_string())
    })?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plain = cipher.decrypt(nonce, ciphertext.as_ref()).map_err(|_| {
        OmniError::new(ErrorCode::Auth, "解密失败：主密码不正确或数据已损坏")
    })?;
    serde_json::from_slice(&plain).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "凭据库明文解析失败").with_cause(e.to_string())
    })
}

pub fn decode_salt_b64(salt_b64: &str) -> OmniResult<Vec<u8>> {
    B64.decode(salt_b64.trim()).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析 Master Salt 失败").with_cause(e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let salt = generate_salt().unwrap();
        let key = derive_master_key("test-master-password", &salt).unwrap();
        let plain = SecretsVaultPlaintext {
            version: 1,
            exported_at: 1_700_000_000_000,
            entries: vec![SecretsVaultEntry {
                reference: "db-password-abc".into(),
                value: "s3cret!".into(),
                kind: "db".into(),
                label: "MySQL".into(),
            }],
        };
        let env = encrypt_vault_with_salt(&key, &plain, "Ab12Cd", &salt).unwrap();
        assert_eq!(env.kdf, "argon2id");
        assert_eq!(env.secret_count, 1);
        let out = decrypt_vault("test-master-password", &env).unwrap();
        assert_eq!(out.entries.len(), 1);
        assert_eq!(out.entries[0].value, "s3cret!");
    }

    #[test]
    fn wrong_password_fails() {
        let salt = generate_salt().unwrap();
        let key = derive_master_key("right-password", &salt).unwrap();
        let plain = SecretsVaultPlaintext {
            version: 1,
            exported_at: 1,
            entries: vec![],
        };
        let env = encrypt_vault_with_salt(&key, &plain, "XxYyZz", &salt).unwrap();
        assert!(decrypt_vault("wrong-password", &env).is_err());
    }
}
