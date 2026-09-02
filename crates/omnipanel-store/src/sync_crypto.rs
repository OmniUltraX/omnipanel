//! 团队 / 个人快照端到端加密：密钥材料 → Argon2id → AES-256-GCM。
//!
//! - OSS 上只存信封（salt + nonce + ciphertext），不落明文 modules / conversations。
//! - 密钥材料由调用方提供（个人：openid；协作团队：team_id + teamOssKey + pepper）。
//! - 参数略轻于 secrets vault，兼顾自动同步频率与抗离线暴力。

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use hmac::{Hmac, Mac};
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::secrets_crypto::{generate_nonce, generate_salt};
use crate::sync_team_key::SYNC_TEAM_KEY_BYTES;

type HmacSha256 = Hmac<Sha256>;

const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const KEY_LEN: usize = 32;
/// 同步 blob 的 Argon2id：比 vault 略轻，适合较频繁的 push/pull。
const ARGON2_M_KIB: u32 = 32 * 1024;
const ARGON2_T: u32 = 2;
const ARGON2_P: u32 = 1;

pub const SYNC_BLOB_SCHEME: &str = "omnipanel-sync-e2e-v1";
pub const SYNC_BLOB_SCHEME_V2: &str = "omnipanel-sync-e2e-v2";
pub const SYNC_KIND_MODULES: &str = "modules";
pub const SYNC_KIND_CONVERSATIONS: &str = "ai-conversations";
pub const SYNC_KIND_ASSISTANT_SNAPSHOT: &str = "assistant-snapshot";

/// v2：HMAC-SHA256(sync_key, "omnipanel.sync.v2.blob:{team_id}:{kind}") → base64 作为 key_material。
pub fn derive_sync_blob_key_material_v2(
    team_key: &[u8; SYNC_TEAM_KEY_BYTES],
    team_id: i64,
    kind: &str,
) -> OmniResult<String> {
    let kind = kind.trim();
    if kind.is_empty() {
        return Err(OmniError::invalid_input("同步 kind 不能为空"));
    }
    let mut mac = <HmacSha256 as Mac>::new_from_slice(team_key).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "初始化 HMAC 失败").with_cause(e.to_string())
    })?;
    mac.update(format!("omnipanel.sync.v2.blob:{team_id}:{kind}").as_bytes());
    Ok(B64.encode(mac.finalize().into_bytes()))
}

fn envelope_scheme(body: &[u8]) -> Option<String> {
    let Ok(v) = serde_json::from_slice::<serde_json::Value>(body) else {
        return None;
    };
    v.get("scheme").and_then(|s| s.as_str()).map(str::to_string)
}

/// 上传到 OSS 的同步信封（无明文）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBlobEnvelope {
    pub version: u32,
    pub scheme: String,
    pub kdf: String,
    pub salt_b64: String,
    pub nonce_b64: String,
    pub ciphertext_b64: String,
    pub updated_at: i64,
    /// `modules` | `ai-conversations`
    pub kind: String,
}

fn argon2() -> OmniResult<Argon2<'static>> {
    let params = Params::new(ARGON2_M_KIB, ARGON2_T, ARGON2_P, Some(KEY_LEN)).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "同步 Argon2 参数无效").with_cause(e.to_string())
    })?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, params))
}

fn derive_sync_key(key_material: &str, salt: &[u8]) -> OmniResult<[u8; KEY_LEN]> {
    if key_material.trim().is_empty() {
        return Err(OmniError::invalid_input("同步密钥材料不能为空"));
    }
    if salt.len() < SALT_LEN {
        return Err(OmniError::invalid_input("同步 salt 过短"));
    }
    let hasher = argon2()?;
    let mut key = [0u8; KEY_LEN];
    hasher
        .hash_password_into(key_material.as_bytes(), salt, &mut key)
        .map_err(|e| {
            OmniError::new(ErrorCode::Auth, "派生同步密钥失败").with_cause(e.to_string())
        })?;
    Ok(key)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// 判断 body 是否为端到端加密信封（用于兼容历史明文快照）。
pub fn looks_like_sync_blob_envelope(body: &[u8]) -> bool {
    matches!(
        envelope_scheme(body).as_deref(),
        Some(SYNC_BLOB_SCHEME) | Some(SYNC_BLOB_SCHEME_V2)
    )
}

/// 加密同步明文 → JSON 信封字节（v1 legacy key_material）。
pub fn encrypt_sync_blob(key_material: &str, kind: &str, plaintext: &[u8]) -> OmniResult<Vec<u8>> {
    encrypt_sync_blob_with_scheme(key_material, kind, plaintext, SYNC_BLOB_SCHEME)
}

/// 使用团队同步密钥加密快照（v2）。
pub fn encrypt_sync_team_blob(
    team_key: &[u8; SYNC_TEAM_KEY_BYTES],
    team_id: i64,
    kind: &str,
    plaintext: &[u8],
) -> OmniResult<Vec<u8>> {
    let key_material = derive_sync_blob_key_material_v2(team_key, team_id, kind)?;
    encrypt_sync_blob_with_scheme(&key_material, kind, plaintext, SYNC_BLOB_SCHEME_V2)
}

fn encrypt_sync_blob_with_scheme(
    key_material: &str,
    kind: &str,
    plaintext: &[u8],
    scheme: &str,
) -> OmniResult<Vec<u8>> {
    let kind = kind.trim();
    if kind.is_empty() {
        return Err(OmniError::invalid_input("同步 kind 不能为空"));
    }
    let salt = generate_salt()?;
    let key = derive_sync_key(key_material, &salt)?;
    let nonce_bytes = generate_nonce()?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "初始化同步 AES-GCM 失败").with_cause(e.to_string())
    })?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher.encrypt(nonce, plaintext).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "加密同步快照失败").with_cause(e.to_string())
    })?;
    let envelope = SyncBlobEnvelope {
        version: 1,
        scheme: scheme.to_string(),
        kdf: "argon2id".into(),
        salt_b64: B64.encode(salt),
        nonce_b64: B64.encode(nonce_bytes),
        ciphertext_b64: B64.encode(ciphertext),
        updated_at: now_ms(),
        kind: kind.to_string(),
    };
    serde_json::to_vec(&envelope).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化同步信封失败").with_cause(e.to_string())
    })
}

/// 解密同步信封 → 明文。`expected_kind` 非空时校验信封 kind。
pub fn decrypt_sync_blob(
    key_material: &str,
    expected_kind: &str,
    body: &[u8],
) -> OmniResult<Vec<u8>> {
    let envelope: SyncBlobEnvelope = serde_json::from_slice(body).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "同步信封格式无效").with_cause(e.to_string())
    })?;
    if envelope.scheme != SYNC_BLOB_SCHEME && envelope.scheme != SYNC_BLOB_SCHEME_V2 {
        return Err(OmniError::invalid_input("不支持的同步加密 scheme"));
    }
    let expected = expected_kind.trim();
    if !expected.is_empty() && envelope.kind.trim() != expected {
        return Err(OmniError::invalid_input(format!(
            "同步信封 kind 不匹配：期望 {expected}，实际 {}",
            envelope.kind
        )));
    }
    let salt = B64.decode(envelope.salt_b64.trim()).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析同步 salt 失败").with_cause(e.to_string())
    })?;
    let nonce_bytes = B64.decode(envelope.nonce_b64.trim()).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析同步 nonce 失败").with_cause(e.to_string())
    })?;
    let ciphertext = B64.decode(envelope.ciphertext_b64.trim()).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析同步密文失败").with_cause(e.to_string())
    })?;
    if nonce_bytes.len() != NONCE_LEN {
        return Err(OmniError::invalid_input("同步 nonce 长度无效"));
    }
    let key = derive_sync_key(key_material, &salt)?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "初始化同步 AES-GCM 失败").with_cause(e.to_string())
    })?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(nonce, ciphertext.as_ref())
        .map_err(|_| OmniError::new(ErrorCode::Auth, "解密同步快照失败：密钥不匹配或数据已损坏"))
}

/// 若为信封则解密，否则按历史明文原样返回（便于迁移）。
pub fn decode_sync_blob_or_legacy(
    key_material: &str,
    expected_kind: &str,
    body: &[u8],
) -> OmniResult<Vec<u8>> {
    if looks_like_sync_blob_envelope(body) {
        decrypt_sync_blob(key_material, expected_kind, body)
    } else {
        Ok(body.to_vec())
    }
}

/// pull 解密：v2 信封优先团队密钥，v1 信封用 legacy key_material；明文直通。
pub fn decode_sync_blob_with_sources(
    team_key: Option<&[u8; SYNC_TEAM_KEY_BYTES]>,
    team_id: i64,
    legacy_key_material: Option<&str>,
    expected_kind: &str,
    body: &[u8],
) -> OmniResult<Vec<u8>> {
    if !looks_like_sync_blob_envelope(body) {
        return Ok(body.to_vec());
    }
    let scheme = envelope_scheme(body).unwrap_or_default();
    if scheme == SYNC_BLOB_SCHEME_V2 {
        let team_key = team_key.ok_or_else(|| {
            OmniError::new(
                ErrorCode::Auth,
                "本机缺少团队同步密钥，无法解密 v2 快照；请从其他设备获取或导入密钥文件",
            )
        })?;
        let material = derive_sync_blob_key_material_v2(team_key, team_id, expected_kind)?;
        return decrypt_sync_blob(&material, expected_kind, body);
    }
    let legacy = legacy_key_material.ok_or_else(|| {
        OmniError::new(
            ErrorCode::Auth,
            "无法解密历史同步快照：缺少 legacy 密钥材料",
        )
    })?;
    decrypt_sync_blob(legacy, expected_kind, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip_encrypt_decrypt() {
        let plain = br#"{"schemaVersion":1,"kind":"omnipanel.client-sync.modules"}"#;
        let body = encrypt_sync_blob(
            "omnipanel.sync.v1.personal:openid-1",
            SYNC_KIND_MODULES,
            plain,
        )
        .unwrap();
        assert!(looks_like_sync_blob_envelope(&body));
        let out = decrypt_sync_blob(
            "omnipanel.sync.v1.personal:openid-1",
            SYNC_KIND_MODULES,
            &body,
        )
        .unwrap();
        assert_eq!(out, plain);
    }

    #[test]
    fn wrong_key_fails() {
        let body = encrypt_sync_blob("right-key", SYNC_KIND_MODULES, b"{}").unwrap();
        assert!(decrypt_sync_blob("wrong-key", SYNC_KIND_MODULES, &body).is_err());
    }

    #[test]
    fn legacy_plaintext_passthrough() {
        let legacy = br#"{"schemaVersion":1,"kind":"x"}"#;
        let out = decode_sync_blob_or_legacy("any", SYNC_KIND_MODULES, legacy).unwrap();
        assert_eq!(out, legacy);
    }

    #[test]
    fn v2_team_key_roundtrip() {
        let team_key = [9u8; SYNC_TEAM_KEY_BYTES];
        let team_id = 1001_i64;
        let plain = br#"{"schemaVersion":1}"#;
        let body = encrypt_sync_team_blob(&team_key, team_id, SYNC_KIND_MODULES, plain).unwrap();
        let scheme = envelope_scheme(&body).unwrap();
        assert_eq!(scheme, SYNC_BLOB_SCHEME_V2);
        let material =
            derive_sync_blob_key_material_v2(&team_key, team_id, SYNC_KIND_MODULES).unwrap();
        let out = decrypt_sync_blob(&material, SYNC_KIND_MODULES, &body).unwrap();
        assert_eq!(out, plain);
    }

    #[test]
    fn decode_with_sources_v2_then_legacy() {
        let team_key = [3u8; SYNC_TEAM_KEY_BYTES];
        let team_id = 7_i64;
        let plain = b"v2-data";
        let v2_body = encrypt_sync_team_blob(&team_key, team_id, SYNC_KIND_MODULES, plain).unwrap();
        let out = decode_sync_blob_with_sources(
            Some(&team_key),
            team_id,
            None,
            SYNC_KIND_MODULES,
            &v2_body,
        )
        .unwrap();
        assert_eq!(out, plain);

        let legacy_mat = "omnipanel.sync.v1.personal:openid-x";
        let v1_body = encrypt_sync_blob(legacy_mat, SYNC_KIND_MODULES, b"legacy").unwrap();
        let out2 = decode_sync_blob_with_sources(
            None,
            team_id,
            Some(legacy_mat),
            SYNC_KIND_MODULES,
            &v1_body,
        )
        .unwrap();
        assert_eq!(out2, b"legacy");
    }
}
