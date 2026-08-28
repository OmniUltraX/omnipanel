//! 团队同步密钥 IPC：状态 / 生成 / 导出导入 `.omnipanel-sync.key`。

use std::path::Path;

use base64::Engine;
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    SYNC_TEAM_KEY_BYTES, clear_sync_team_key, export_sync_team_key_json,
    get_or_create_sync_team_key, import_sync_team_key_json, load_sync_team_key,
    sync_team_key_fingerprint,
};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTeamKeyStatus {
    pub has_key: bool,
    pub fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTeamKeyGetOrCreateResult {
    pub fingerprint: String,
    /// true = 本次新生成，应提示备份
    pub created: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTeamKeyImportResult {
    pub fingerprint: String,
}

#[tauri::command]
#[specta::specta]
pub fn sync_team_key_status(team_id: i64) -> Result<SyncTeamKeyStatus, OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    match load_sync_team_key(team_id)? {
        Some(key) => Ok(SyncTeamKeyStatus {
            has_key: true,
            fingerprint: Some(sync_team_key_fingerprint(&key)),
        }),
        None => Ok(SyncTeamKeyStatus {
            has_key: false,
            fingerprint: None,
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub fn sync_team_key_get_or_create(
    team_id: i64,
) -> Result<SyncTeamKeyGetOrCreateResult, OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let (key, created) = get_or_create_sync_team_key(team_id)?;
    Ok(SyncTeamKeyGetOrCreateResult {
        fingerprint: sync_team_key_fingerprint(&key),
        created,
    })
}

#[tauri::command]
#[specta::specta]
pub fn sync_team_key_clear(team_id: i64) -> Result<(), OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    clear_sync_team_key(team_id)
}

#[tauri::command]
#[specta::specta]
pub fn sync_team_key_export_file(
    team_id: i64,
    path: String,
    passphrase: Option<String>,
) -> Result<(), OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let key = load_sync_team_key(team_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "本机尚无团队同步密钥，无法导出"))?;
    let pass = passphrase.as_deref();
    let json = export_sync_team_key_json(team_id, &key, pass)?;
    std::fs::write(Path::new(path.trim()), json).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "写入同步密钥文件失败").with_cause(e.to_string())
    })
}

#[tauri::command]
#[specta::specta]
pub fn sync_team_key_import_file(
    team_id: i64,
    path: String,
    passphrase: Option<String>,
) -> Result<SyncTeamKeyImportResult, OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let bytes = std::fs::read(Path::new(path.trim())).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "读取同步密钥文件失败").with_cause(e.to_string())
    })?;
    let fp = import_sync_team_key_json(team_id, &bytes, passphrase.as_deref())?;
    Ok(SyncTeamKeyImportResult { fingerprint: fp })
}

/// 中继传钥：生成临时密钥对（供后续 omniserver `/api/sync/key/*` 使用）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncTeamKeyEphemeralKeypair {
    pub secret_key_b64: String,
    pub public_key_b64: String,
    pub wrap_alg: String,
}

#[tauri::command]
#[specta::specta]
pub fn sync_team_key_generate_ephemeral_keypair() -> Result<SyncTeamKeyEphemeralKeypair, OmniError>
{
    let (sk, pk) = omnipanel_store::generate_pairing_keypair()?;
    Ok(SyncTeamKeyEphemeralKeypair {
        secret_key_b64: base64::engine::general_purpose::STANDARD.encode(sk),
        public_key_b64: pk,
        wrap_alg: omnipanel_store::WRAP_ALG.to_string(),
    })
}

/// 用本机团队密钥 + 对方临时公钥封装 wrapped key（在线设备中继响应）。
#[tauri::command]
#[specta::specta]
pub fn sync_team_key_wrap_for_relay(
    team_id: i64,
    recipient_pubkey_b64: String,
    request_id: String,
    requester_device_id: String,
) -> Result<String, OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let key = load_sync_team_key(team_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "本机尚无团队同步密钥"))?;
    let aad = format!(
        "{}:{}:{}",
        request_id.trim(),
        team_id,
        requester_device_id.trim()
    );
    omnipanel_store::wrap_sync_team_key(&key, recipient_pubkey_b64.trim(), &aad)
}

/// 新设备解包中继返回的 wrapped key 并写入本机。
#[tauri::command]
#[specta::specta]
pub fn sync_team_key_unwrap_from_relay(
    team_id: i64,
    wrapped_b64: String,
    ephemeral_secret_b64: String,
    request_id: String,
    requester_device_id: String,
) -> Result<SyncTeamKeyImportResult, OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let sk_bytes = base64::engine::general_purpose::STANDARD
        .decode(ephemeral_secret_b64.trim())
        .map_err(|e| OmniError::invalid_input("临时私钥格式无效").with_cause(e.to_string()))?;
    if sk_bytes.len() != SYNC_TEAM_KEY_BYTES {
        return Err(OmniError::invalid_input("临时私钥长度无效"));
    }
    let mut sk = [0u8; SYNC_TEAM_KEY_BYTES];
    sk.copy_from_slice(&sk_bytes);
    let aad = format!(
        "{}:{}:{}",
        request_id.trim(),
        team_id,
        requester_device_id.trim()
    );
    let team_key = omnipanel_store::unwrap_sync_team_key(wrapped_b64.trim(), &sk, &aad)?;
    omnipanel_store::store_sync_team_key(team_id, &team_key)?;
    Ok(SyncTeamKeyImportResult {
        fingerprint: sync_team_key_fingerprint(&team_key),
    })
}
