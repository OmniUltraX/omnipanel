//! 配对传钥 IPC（B2 wrap / unwrap）。

use omnipanel_error::OmniError;
use omnipanel_store::{
    WRAP_ALG, generate_pairing_keypair, load_stored_sync_master_key, unwrap_sync_master_key,
    wrap_sync_master_key,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use std::sync::Mutex;

struct EphemeralPairingKey {
    secret: [u8; 32],
    pubkey_b64: String,
    pairing_id: String,
}

static EPH: Mutex<Option<EphemeralPairingKey>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PairingKeypairResult {
    pub pubkey_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WrapKeyRequest {
    pub pairing_id: String,
    pub requester_device_id: String,
    pub requester_pubkey_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct WrapKeyResult {
    pub wrapped_key: String,
    pub wrap_alg: String,
}

/// 新设备：生成临时密钥对并缓存私钥。pairing_id 可先空，redeem 前再调用一次写入 id。
#[tauri::command]
#[specta::specta]
pub fn sync_pairing_create_keypair(pairing_id: String) -> Result<PairingKeypairResult, OmniError> {
    let mut guard = EPH
        .lock()
        .map_err(|_| OmniError::internal("pairing eph lock"))?;
    if let Some(existing) = guard.as_mut() {
        if !pairing_id.is_empty() {
            existing.pairing_id = pairing_id;
        }
        return Ok(PairingKeypairResult {
            pubkey_b64: existing.pubkey_b64.clone(),
        });
    }
    let (secret, pubkey_b64) = generate_pairing_keypair()?;
    *guard = Some(EphemeralPairingKey {
        secret,
        pubkey_b64: pubkey_b64.clone(),
        pairing_id,
    });
    Ok(PairingKeypairResult { pubkey_b64 })
}

/// 主设备：用本机 SMK 封装给 requester。
#[tauri::command]
#[specta::specta]
pub fn sync_pairing_wrap_key(request: WrapKeyRequest) -> Result<WrapKeyResult, OmniError> {
    let smk = load_stored_sync_master_key()?.ok_or_else(|| {
        OmniError::new(
            omnipanel_error::ErrorCode::Auth,
            "本机尚未解锁 SyncMasterKey，无法传钥",
        )
    })?;
    let aad = format!("{}:{}", request.pairing_id, request.requester_device_id);
    let wrapped_key = wrap_sync_master_key(&smk, &request.requester_pubkey_b64, &aad)?;
    Ok(WrapKeyResult {
        wrapped_key,
        wrap_alg: WRAP_ALG.to_string(),
    })
}

/// 新设备：解包并写入本机 SMK。
#[tauri::command]
#[specta::specta]
pub fn sync_pairing_unwrap_and_store(
    pairing_id: String,
    requester_device_id: String,
    wrapped_key: String,
) -> Result<(), OmniError> {
    let eph = EPH
        .lock()
        .map_err(|_| OmniError::internal("pairing eph lock"))?
        .take()
        .ok_or_else(|| {
            OmniError::new(
                omnipanel_error::ErrorCode::InvalidInput,
                "无本地临时密钥，请重新发起配对",
            )
        })?;
    if eph.pairing_id != pairing_id {
        return Err(OmniError::new(
            omnipanel_error::ErrorCode::InvalidInput,
            "pairing_id 与本地临时密钥不匹配",
        ));
    }
    let aad = format!("{}:{}", pairing_id, requester_device_id);
    let smk = unwrap_sync_master_key(&wrapped_key, &eph.secret, &aad)?;
    omnipanel_store::store_sync_master_key(&smk)?;
    Ok(())
}
