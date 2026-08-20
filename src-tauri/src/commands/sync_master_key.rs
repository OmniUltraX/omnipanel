//! SyncMasterKey IPC：本机生成 / 导入 / 状态。

use omnipanel_error::OmniError;
use omnipanel_store::{
    clear_stored_sync_master_key, get_or_create_sync_master_key, is_valid_sync_master_key,
    load_stored_sync_master_key, normalize_sync_master_key, store_sync_master_key,
};
use serde::{Deserialize, Serialize};
use specta::Type;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncMasterKeyStatus {
    /// 本机是否已有 SyncMasterKey
    pub has_key: bool,
    /// 若有 key，返回展示串（设置页查看/备份用）
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SyncMasterKeyGetOrCreateResult {
    pub key: String,
    /// true = 本次新生成，应弹出备份引导
    pub created: bool,
}

#[tauri::command]
#[specta::specta]
pub fn sync_master_key_status() -> Result<SyncMasterKeyStatus, OmniError> {
    match load_stored_sync_master_key()? {
        Some(key) => Ok(SyncMasterKeyStatus {
            has_key: true,
            key: Some(key),
        }),
        None => Ok(SyncMasterKeyStatus {
            has_key: false,
            key: None,
        }),
    }
}

#[tauri::command]
#[specta::specta]
pub fn sync_master_key_get_or_create() -> Result<SyncMasterKeyGetOrCreateResult, OmniError> {
    let (key, created) = get_or_create_sync_master_key()?;
    Ok(SyncMasterKeyGetOrCreateResult { key, created })
}

#[tauri::command]
#[specta::specta]
pub fn sync_master_key_import(key: String) -> Result<SyncMasterKeyStatus, OmniError> {
    let stored = store_sync_master_key(&key)?;
    Ok(SyncMasterKeyStatus {
        has_key: true,
        key: Some(stored),
    })
}

#[tauri::command]
#[specta::specta]
pub fn sync_master_key_clear() -> Result<(), OmniError> {
    clear_stored_sync_master_key()
}

#[tauri::command]
#[specta::specta]
pub fn sync_master_key_validate(key: String) -> Result<bool, OmniError> {
    let Ok(norm) = normalize_sync_master_key(&key) else {
        return Ok(false);
    };
    Ok(is_valid_sync_master_key(&norm))
}
