//! 团队同步密钥（32 字节随机值）：加密 OSS modules / conversations 快照。
//!
//! 按 `team_id` 存于本机 Vault；可导出 `.omnipanel-sync.key` 备份。

use getrandom::getrandom;
use base64::Engine;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

pub const SYNC_TEAM_KEY_BYTES: usize = 32;
pub const SYNC_TEAM_KEY_EXPORT_VERSION: u32 = 1;
pub const SYNC_TEAM_KEY_FILE_EXT: &str = "omnipanel-sync.key";

fn vault_ref(team_id: i64) -> String {
    format!("__sync_team_key__:{team_id}")
}

/// 生成新的 32 字节团队同步密钥。
pub fn generate_sync_team_key() -> OmniResult<[u8; SYNC_TEAM_KEY_BYTES]> {
    let mut raw = [0u8; SYNC_TEAM_KEY_BYTES];
    getrandom(&mut raw).map_err(|e| {
        OmniError::new(
            ErrorCode::Internal,
            format!("生成团队同步密钥失败: {e}"),
        )
    })?;
    Ok(raw)
}

/// SHA-256 前 8 字节 hex，用于 UI 展示指纹。
pub fn sync_team_key_fingerprint(key: &[u8; SYNC_TEAM_KEY_BYTES]) -> String {
    let digest = Sha256::digest(key);
    digest[..4]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub fn load_sync_team_key(team_id: i64) -> OmniResult<Option<[u8; SYNC_TEAM_KEY_BYTES]>> {
    let ref_id = vault_ref(team_id);
    match crate::Vault::get(&ref_id) {
        Ok(raw) => {
            let bytes = decode_key_b64(&raw)?;
            Ok(Some(bytes))
        }
        Err(e) if e.code == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn store_sync_team_key(team_id: i64, key: &[u8; SYNC_TEAM_KEY_BYTES]) -> OmniResult<()> {
    let ref_id = vault_ref(team_id);
    let encoded = base64::engine::general_purpose::STANDARD.encode(key);
    crate::Vault::store(&ref_id, &encoded)
}

pub fn clear_sync_team_key(team_id: i64) -> OmniResult<()> {
    crate::Vault::delete(&vault_ref(team_id))
}

/// 若本机尚无密钥则生成并落盘，返回 `(key, created)`。
pub fn get_or_create_sync_team_key(team_id: i64) -> OmniResult<([u8; SYNC_TEAM_KEY_BYTES], bool)> {
    if let Some(existing) = load_sync_team_key(team_id)? {
        return Ok((existing, false));
    }
    let key = generate_sync_team_key()?;
    store_sync_team_key(team_id, &key)?;
    Ok((key, true))
}

fn decode_key_b64(raw: &str) -> OmniResult<[u8; SYNC_TEAM_KEY_BYTES]> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| OmniError::new(ErrorCode::InvalidInput, "同步密钥格式无效").with_cause(e.to_string()))?;
    if bytes.len() != SYNC_TEAM_KEY_BYTES {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!(
                "同步密钥长度错误：期望 {} 字节，实际 {}",
                SYNC_TEAM_KEY_BYTES,
                bytes.len()
            ),
        ));
    }
    let mut arr = [0u8; SYNC_TEAM_KEY_BYTES];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncTeamKeyExportFile {
    pub version: u32,
    pub team_id: i64,
    /// 明文导出时的密钥（base64）；与 `encrypted` 二选一。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_b64: Option<String>,
    pub fingerprint: String,
    pub exported_at: i64,
    #[serde(default)]
    pub encrypted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kdf: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub salt_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nonce_b64: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ciphertext_b64: Option<String>,
}

/// 导出团队同步密钥为 JSON 文件内容（可选口令二次加密）。
pub fn export_sync_team_key_json(
    team_id: i64,
    key: &[u8; SYNC_TEAM_KEY_BYTES],
    passphrase: Option<&str>,
) -> OmniResult<Vec<u8>> {
    let exported_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let fingerprint = sync_team_key_fingerprint(key);
    let file = if let Some(pass) = passphrase.filter(|p| !p.is_empty()) {
        let (salt, nonce, ciphertext) = crate::secrets_crypto::encrypt_with_passphrase(pass, key)?;
        SyncTeamKeyExportFile {
            version: SYNC_TEAM_KEY_EXPORT_VERSION,
            team_id,
            key_b64: None,
            fingerprint: fingerprint.clone(),
            exported_at,
            encrypted: true,
            kdf: Some("argon2id".into()),
            salt_b64: Some(base64::engine::general_purpose::STANDARD.encode(salt)),
            nonce_b64: Some(base64::engine::general_purpose::STANDARD.encode(nonce)),
            ciphertext_b64: Some(base64::engine::general_purpose::STANDARD.encode(ciphertext)),
        }
    } else {
        SyncTeamKeyExportFile {
            version: SYNC_TEAM_KEY_EXPORT_VERSION,
            team_id,
            key_b64: Some(base64::engine::general_purpose::STANDARD.encode(key)),
            fingerprint,
            exported_at,
            encrypted: false,
            kdf: None,
            salt_b64: None,
            nonce_b64: None,
            ciphertext_b64: None,
        }
    };
    serde_json::to_vec_pretty(&file).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化同步密钥导出文件失败").with_cause(e.to_string())
    })
}

/// 从导出文件 JSON 解析并写入本机 Vault；返回指纹。
pub fn import_sync_team_key_json(
    team_id: i64,
    bytes: &[u8],
    passphrase: Option<&str>,
) -> OmniResult<String> {
    let file: SyncTeamKeyExportFile = serde_json::from_slice(bytes).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "无效的同步密钥文件").with_cause(e.to_string())
    })?;
    if file.version != SYNC_TEAM_KEY_EXPORT_VERSION {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("不支持的同步密钥文件版本: {}", file.version),
        ));
    }
    if file.team_id != team_id {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!(
                "同步密钥文件团队不匹配：文件 team_id={}，当前 team_id={team_id}",
                file.team_id
            ),
        ));
    }
    let mut key = if file.encrypted {
        let pass = passphrase.filter(|p| !p.is_empty()).ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "该密钥文件需要口令才能导入")
        })?;
        let salt_b64 = file.salt_b64.as_deref().ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "密钥文件缺少 salt")
        })?;
        let nonce_b64 = file.nonce_b64.as_deref().ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "密钥文件缺少 nonce")
        })?;
        let ct_b64 = file.ciphertext_b64.as_deref().ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "密钥文件缺少密文")
        })?;
        let plain = crate::secrets_crypto::decrypt_with_passphrase(
            pass,
            salt_b64,
            nonce_b64,
            ct_b64,
        )?;
        if plain.len() != SYNC_TEAM_KEY_BYTES {
            return Err(OmniError::new(ErrorCode::InvalidInput, "解密后的密钥长度无效"));
        }
        let mut arr = [0u8; SYNC_TEAM_KEY_BYTES];
        arr.copy_from_slice(&plain);
        arr
    } else {
        let key_b64 = file.key_b64.as_deref().ok_or_else(|| {
            OmniError::new(ErrorCode::InvalidInput, "密钥文件缺少 keyB64")
        })?;
        decode_key_b64(key_b64)?
    };
    let fp = sync_team_key_fingerprint(&key);
    if fp != file.fingerprint {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "同步密钥文件指纹校验失败",
        ));
    }
    store_sync_team_key(team_id, &key)?;
    key.zeroize();
    Ok(fp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_stable() {
        let key = [7u8; SYNC_TEAM_KEY_BYTES];
        let fp = sync_team_key_fingerprint(&key);
        assert_eq!(fp.len(), 8);
        assert_eq!(fp, sync_team_key_fingerprint(&key));
    }

    #[test]
    fn export_json_plain_structure() {
        let team_id = 42;
        let key = generate_sync_team_key().unwrap();
        let json = export_sync_team_key_json(team_id, &key, None).unwrap();
        let file: SyncTeamKeyExportFile = serde_json::from_slice(&json).unwrap();
        assert_eq!(file.version, SYNC_TEAM_KEY_EXPORT_VERSION);
        assert_eq!(file.team_id, team_id);
        assert!(!file.encrypted);
        assert!(file.key_b64.is_some());
    }
}
