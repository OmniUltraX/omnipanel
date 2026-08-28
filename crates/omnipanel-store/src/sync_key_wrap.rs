//! SyncMasterKey 封装：X25519 ECDH + AES-256-GCM（供设备配对 B2 传钥）。
//!
//! wrap 包格式（base64 JSON）：
//! `{ "v":1, "epk":"<sender ephemeral pubkey b64>", "n":"<nonce b64>", "c":"<ciphertext b64>" }`
//! AAD = pairing_id || ":" || requester_device_id

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use getrandom::getrandom;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use x25519_dalek::{PublicKey, StaticSecret};

pub const WRAP_ALG: &str = "x25519-aes256gcm-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WrapBlob {
    v: u8,
    epk: String,
    n: String,
    c: String,
}

/// 生成临时 X25519 密钥对；返回 (secret_bytes_32, pubkey_b64)。
pub fn generate_pairing_keypair() -> OmniResult<([u8; 32], String)> {
    let mut seed = [0u8; 32];
    getrandom(&mut seed)
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("x25519 seed failed: {e}")))?;
    let secret = StaticSecret::from(seed);
    let public = PublicKey::from(&secret);
    Ok((*secret.as_bytes(), B64.encode(public.as_bytes())))
}

/// 用接收方公钥封装 32 字节团队同步密钥。
pub fn wrap_sync_team_key(
    team_key: &[u8; 32],
    recipient_pubkey_b64: &str,
    aad: &str,
) -> OmniResult<String> {
    wrap_secret_bytes(team_key, recipient_pubkey_b64, aad)
}

/// 用助手公钥加密任意 JSON 载荷（PC → 小程序摘要通道）。
pub fn encrypt_assistant_payload(
    payload: &[u8],
    assistant_pubkey_b64: &str,
    aad: &str,
) -> OmniResult<String> {
    wrap_secret_bytes(payload, assistant_pubkey_b64, aad)
}

/// 助手端用绑定私钥解密 PC 上传的摘要载荷。
pub fn decrypt_assistant_payload(
    wrapped_b64: &str,
    assistant_secret: &[u8; 32],
    aad: &str,
) -> OmniResult<Vec<u8>> {
    unwrap_secret_bytes(wrapped_b64, assistant_secret, aad)
}

/// 用接收方公钥封装 SyncMasterKey 展示串。
pub fn wrap_sync_master_key(
    sync_master_key: &str,
    recipient_pubkey_b64: &str,
    aad: &str,
) -> OmniResult<String> {
    wrap_secret_bytes(sync_master_key.as_bytes(), recipient_pubkey_b64, aad)
}

fn wrap_secret_bytes(secret: &[u8], recipient_pubkey_b64: &str, aad: &str) -> OmniResult<String> {
    let recipient = decode_pubkey(recipient_pubkey_b64)?;
    let mut seed = [0u8; 32];
    getrandom(&mut seed)
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("ephemeral seed failed: {e}")))?;
    let eph = StaticSecret::from(seed);
    let eph_pub = PublicKey::from(&eph);
    let shared = eph.diffie_hellman(&recipient);
    let key = derive_aead_key(shared.as_bytes())?;
    let mut nonce = [0u8; 12];
    getrandom(&mut nonce)
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("nonce failed: {e}")))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("aes init: {e}")))?;
    let ct = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: secret,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| OmniError::new(ErrorCode::Internal, "wrap encrypt failed"))?;
    let blob = WrapBlob {
        v: 1,
        epk: B64.encode(eph_pub.as_bytes()),
        n: B64.encode(nonce),
        c: B64.encode(ct),
    };
    let json = serde_json::to_vec(&blob)
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("wrap serialize: {e}")))?;
    Ok(B64.encode(json))
}

/// 用本机临时私钥解包 32 字节团队同步密钥。
pub fn unwrap_sync_team_key(
    wrapped_b64: &str,
    ephemeral_secret: &[u8; 32],
    aad: &str,
) -> OmniResult<[u8; 32]> {
    let bytes = unwrap_secret_bytes(wrapped_b64, ephemeral_secret, aad)?;
    if bytes.len() != 32 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "team key length"));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// 用本机临时私钥解包 SyncMasterKey。
pub fn unwrap_sync_master_key(
    wrapped_b64: &str,
    ephemeral_secret: &[u8; 32],
    aad: &str,
) -> OmniResult<String> {
    let plain = unwrap_secret_bytes(wrapped_b64, ephemeral_secret, aad)?;
    String::from_utf8(plain).map_err(|_| OmniError::new(ErrorCode::InvalidInput, "unwrap utf8"))
}

fn unwrap_secret_bytes(
    wrapped_b64: &str,
    ephemeral_secret: &[u8; 32],
    aad: &str,
) -> OmniResult<Vec<u8>> {
    let json = B64
        .decode(wrapped_b64.trim())
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, format!("wrap b64: {e}")))?;
    let blob: WrapBlob = serde_json::from_slice(&json)
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, format!("wrap json: {e}")))?;
    if blob.v != 1 {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "unsupported wrap version",
        ));
    }
    let eph_pub = decode_pubkey(&blob.epk)?;
    let secret = StaticSecret::from(*ephemeral_secret);
    let shared = secret.diffie_hellman(&eph_pub);
    let key = derive_aead_key(shared.as_bytes())?;
    let nonce = B64
        .decode(blob.n.trim())
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, format!("nonce: {e}")))?;
    if nonce.len() != 12 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "nonce length"));
    }
    let ct = B64
        .decode(blob.c.trim())
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, format!("ciphertext: {e}")))?;
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("aes init: {e}")))?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ct,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| OmniError::new(ErrorCode::Auth, "unwrap failed"))?;
    Ok(plain)
}

fn decode_pubkey(b64: &str) -> OmniResult<PublicKey> {
    let bytes = B64
        .decode(b64.trim())
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, format!("pubkey b64: {e}")))?;
    if bytes.len() != 32 {
        return Err(OmniError::new(ErrorCode::InvalidInput, "pubkey length"));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(PublicKey::from(arr))
}

fn derive_aead_key(shared: &[u8]) -> OmniResult<[u8; 32]> {
    let salt = b"omnipanel.sync.wrap.v1";
    let mut out = [0u8; 32];
    let params = argon2::Params::new(8 * 1024, 1, 1, Some(32))
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("argon2 params: {e}")))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    argon
        .hash_password_into(shared, salt, &mut out)
        .map_err(|e| OmniError::new(ErrorCode::Internal, format!("kdf: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrap_unwrap_roundtrip() {
        let (sk, pk) = generate_pairing_keypair().unwrap();
        let smk = crate::generate_sync_master_key().unwrap();
        let aad = "pair1:device-a";
        let wrapped = wrap_sync_master_key(&smk, &pk, aad).unwrap();
        let out = unwrap_sync_master_key(&wrapped, &sk, aad).unwrap();
        assert_eq!(out, smk);
        assert!(unwrap_sync_master_key(&wrapped, &sk, "bad").is_err());
    }

    #[test]
    fn wrap_unwrap_team_key_roundtrip() {
        let (sk, pk) = generate_pairing_keypair().unwrap();
        let team_key = [11u8; 32];
        let aad = "req1:team42:device-b";
        let wrapped = wrap_sync_team_key(&team_key, &pk, aad).unwrap();
        let out = unwrap_sync_team_key(&wrapped, &sk, aad).unwrap();
        assert_eq!(out, team_key);
    }

    #[test]
    fn assistant_payload_roundtrip() {
        let (sk, pk) = generate_pairing_keypair().unwrap();
        let payload = br#"{"hello":"world"}"#;
        let aad = "assistant-payload:bind1:dev1";
        let wrapped = encrypt_assistant_payload(payload, &pk, aad).unwrap();
        let out = decrypt_assistant_payload(&wrapped, &sk, aad).unwrap();
        assert_eq!(out, payload);
    }
}
