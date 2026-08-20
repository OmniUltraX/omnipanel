//! SyncMasterKey: cross-device sync master key (`opsk1_` + Base32).
//!
//! - Entropy: 32 cryptographically random bytes
//! - Display: RFC 4648 Base32 (no padding), prefix `opsk1_`
//! - Never stored in plaintext on the server; local password material for vault / sensitive sync

use getrandom::getrandom;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};

/// Display prefix (versioned for future format rotation).
pub const SYNC_MASTER_KEY_PREFIX: &str = "opsk1_";
const KEY_BYTES: usize = 32;
const BASE32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// Generate a new SyncMasterKey display string.
pub fn generate_sync_master_key() -> OmniResult<String> {
    let mut raw = [0u8; KEY_BYTES];
    getrandom(&mut raw).map_err(|e| {
        OmniError::new(
            ErrorCode::Internal,
            format!("failed to generate SyncMasterKey: {e}"),
        )
    })?;
    Ok(format!(
        "{}{}",
        SYNC_MASTER_KEY_PREFIX,
        encode_base32_nopad(&raw)
    ))
}

/// Normalize user input: strip whitespace/grouping, uppercase Base32 body.
pub fn normalize_sync_master_key(raw: &str) -> OmniResult<String> {
    let trimmed = raw.trim();
    let with_prefix = if trimmed.to_ascii_lowercase().starts_with("opsk1_") {
        let rest: String = trimmed
            .chars()
            .skip(SYNC_MASTER_KEY_PREFIX.len())
            .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
            .map(|c| c.to_ascii_uppercase())
            .collect();
        format!("{}{}", SYNC_MASTER_KEY_PREFIX, rest)
    } else {
        let compact: String = trimmed
            .chars()
            .filter(|c| !c.is_whitespace() && *c != '-' && *c != '_')
            .collect();
        if compact.to_ascii_lowercase().starts_with("opsk1") && compact.len() > 5 {
            let rest = compact[5..].to_ascii_uppercase();
            format!("{}{}", SYNC_MASTER_KEY_PREFIX, rest)
        } else {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "SyncMasterKey must start with opsk1_",
            ));
        }
    };

    if !is_valid_sync_master_key(&with_prefix) {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "invalid SyncMasterKey format",
        ));
    }
    Ok(with_prefix)
}

/// Whether `s` is a valid SyncMasterKey display string.
pub fn is_valid_sync_master_key(s: &str) -> bool {
    let Some(rest) = s.strip_prefix(SYNC_MASTER_KEY_PREFIX) else {
        return false;
    };
    // 32 bytes -> 52 base32 chars (ceil(256/5)=52)
    if rest.len() != 52 {
        return false;
    }
    rest.bytes().all(is_base32_char)
}

/// Password material for vault / sync: the full normalized display string.
pub fn sync_master_key_to_password(normalized: &str) -> &str {
    normalized
}

fn is_base32_char(b: u8) -> bool {
    matches!(b, b'A'..=b'Z' | b'2'..=b'7')
}

fn encode_base32_nopad(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() * 8).div_ceil(5));
    let mut buffer: u64 = 0;
    let mut bits: u32 = 0;
    for &byte in data {
        buffer = (buffer << 8) | u64::from(byte);
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            let idx = ((buffer >> bits) & 0x1f) as usize;
            out.push(BASE32_ALPHABET[idx] as char);
        }
    }
    if bits > 0 {
        let idx = ((buffer << (5 - bits)) & 0x1f) as usize;
        out.push(BASE32_ALPHABET[idx] as char);
    }
    out
}

fn decode_base32_nopad(s: &str) -> OmniResult<Vec<u8>> {
    let mut buffer: u64 = 0;
    let mut bits: u32 = 0;
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    for c in s.bytes() {
        let val = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            b'a'..=b'z' => c - b'a',
            _ => {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    "SyncMasterKey contains invalid characters",
                ))
            }
        };
        buffer = (buffer << 5) | u64::from(val);
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

/// Decode to raw 32 bytes (for wrap / crypto helpers).
pub fn decode_sync_master_key_bytes(normalized: &str) -> OmniResult<[u8; KEY_BYTES]> {
    let rest = normalized
        .strip_prefix(SYNC_MASTER_KEY_PREFIX)
        .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "SyncMasterKey prefix error"))?;
    let bytes = decode_base32_nopad(rest)?;
    if bytes.len() != KEY_BYTES {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!(
                "SyncMasterKey length error: got {} bytes, want {KEY_BYTES}",
                bytes.len()
            ),
        ));
    }
    let mut arr = [0u8; KEY_BYTES];
    arr.copy_from_slice(&bytes);
    Ok(arr)
}

/// keyring / file-vault ????????? OSS??
const SYNC_MASTER_KEY_REF: &str = "__sync_master_key__";

/// ?????? SyncMasterKey?????? `Ok(None)`?
pub fn load_stored_sync_master_key() -> OmniResult<Option<String>> {
    match crate::Vault::get(SYNC_MASTER_KEY_REF) {
        Ok(raw) => {
            let norm = normalize_sync_master_key(&raw)?;
            Ok(Some(norm))
        }
        Err(e) if e.code == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// ??????? SyncMasterKey?
pub fn store_sync_master_key(raw: &str) -> OmniResult<String> {
    let norm = normalize_sync_master_key(raw)?;
    crate::Vault::store(SYNC_MASTER_KEY_REF, &norm)?;
    Ok(norm)
}

/// ???? SyncMasterKey???/?????
pub fn clear_stored_sync_master_key() -> OmniResult<()> {
    crate::Vault::delete(SYNC_MASTER_KEY_REF)
}

/// ??????????? `(key, created)`?
pub fn get_or_create_sync_master_key() -> OmniResult<(String, bool)> {
    if let Some(existing) = load_stored_sync_master_key()? {
        return Ok((existing, false));
    }
    let key = generate_sync_master_key()?;
    crate::Vault::store(SYNC_MASTER_KEY_REF, &key)?;
    Ok((key, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_is_valid_and_roundtrip_bytes() {
        let key = generate_sync_master_key().expect("generate");
        assert!(key.starts_with(SYNC_MASTER_KEY_PREFIX));
        assert!(is_valid_sync_master_key(&key));
        let bytes = decode_sync_master_key_bytes(&key).expect("decode");
        assert_eq!(bytes.len(), 32);
        let again = format!(
            "{}{}",
            SYNC_MASTER_KEY_PREFIX,
            encode_base32_nopad(&bytes)
        );
        assert_eq!(again, key);
    }

    #[test]
    fn normalize_accepts_grouped_and_lowercase() {
        let key = generate_sync_master_key().unwrap();
        let rest = key.strip_prefix(SYNC_MASTER_KEY_PREFIX).unwrap();
        let grouped = format!(
            "opsk1_{}-{} {}",
            &rest[0..8],
            &rest[8..16].to_ascii_lowercase(),
            &rest[16..]
        );
        let norm = normalize_sync_master_key(&grouped).unwrap();
        assert_eq!(norm, key);
    }

    #[test]
    fn reject_tampered() {
        let key = generate_sync_master_key().unwrap();
        let mut bad = key.clone();
        bad.push('A');
        assert!(!is_valid_sync_master_key(&bad));
        assert!(normalize_sync_master_key("not-a-key").is_err());
    }
}
