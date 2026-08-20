//! 跨设备密文密钥库：设备识别码（即主密码）解锁 + OSS 上下传。
//!
//! 识别码经 Argon2id 派生 Master Key（仅内存）；OSS 对象路径按账号固定，不写入识别码。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use omnipanel_assistant::{
    fetch_oss_sts, get_object_bytes_optional, upload_object_bytes, AuthContext,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    db_password_ref, decode_salt_b64, decrypt_vault, derive_master_key, embedding_api_key_ref,
    encrypt_vault_with_salt, generate_salt, http_proxy_password_ref, ssh_passphrase_ref,
    ssh_password_ref, ssh_pem_ref, ConnectionKind, MasterKey, SecretsVaultEnvelope,
    SecretsVaultEntry, SecretsVaultPlaintext, Vault,
};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use crate::commands::assistant::build_auth_context;
use crate::commands::auth::auth_device_identity;
use crate::state::AppState;

const DEVICE_CODE_LEN: usize = 6;
const META_FILE: &str = "meta.json";

struct UnlockedSession {
    key: MasterKey,
    salt: Vec<u8>,
}

static SESSION: Mutex<Option<UnlockedSession>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalVaultMeta {
    salt_b64: String,
    updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultStatus {
    pub unlocked: bool,
    pub has_local_salt: bool,
    pub secret_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPushRequest {
    pub token: String,
    pub device_code: String,
    pub oss_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPushResult {
    pub object_key: String,
    pub secret_count: u32,
    pub bytes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPullRequest {
    pub token: String,
    /// 设备识别码（即主密码）：用于定位语义 + Argon2id 解密。
    pub device_code: String,
    pub oss_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPullResult {
    pub imported: u32,
    pub skipped: u32,
    pub secret_count: u32,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_device_code(raw: &str) -> Result<String, OmniError> {
    // 新格式：SyncMasterKey（opsk1_…）
    if raw.trim().to_ascii_lowercase().contains("opsk1") {
        return omnipanel_store::normalize_sync_master_key(raw);
    }
    // 兼容旧 6 位设备识别码
    let code: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    if code.len() != DEVICE_CODE_LEN {
        return Err(OmniError::invalid_input(format!(
            "请输入 SyncMasterKey（opsk1_…）或旧版 {DEVICE_CODE_LEN} 位设备识别码"
        )));
    }
    Ok(code)
}

fn vault_meta_dir() -> Result<PathBuf, OmniError> {
    let root = omnipanel_store::omnipd_root()?;
    let dir = root.join("secrets-vault");
    std::fs::create_dir_all(&dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "创建 secrets-vault 目录失败").with_cause(e.to_string())
    })?;
    Ok(dir)
}

fn meta_path() -> Result<PathBuf, OmniError> {
    Ok(vault_meta_dir()?.join(META_FILE))
}

fn load_local_meta() -> Result<Option<LocalVaultMeta>, OmniError> {
    let path = meta_path()?;
    if !path.exists() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取本地 vault meta 失败").with_cause(e.to_string())
    })?;
    let meta: LocalVaultMeta = serde_json::from_str(&text).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "解析本地 vault meta 失败").with_cause(e.to_string())
    })?;
    Ok(Some(meta))
}

fn save_local_meta(salt: &[u8]) -> Result<(), OmniError> {
    let meta = LocalVaultMeta {
        salt_b64: B64.encode(salt),
        updated_at: now_ms(),
    };
    let path = meta_path()?;
    let text = serde_json::to_string_pretty(&meta).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化 vault meta 失败").with_cause(e.to_string())
    })?;
    std::fs::write(&path, text).map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 vault meta 失败").with_cause(e.to_string())
    })?;
    Ok(())
}

fn object_key_for(oss_path: &str) -> String {
    let base = oss_path.trim().trim_matches('/');
    // 识别码即主密码：不得写入 object key，避免路径泄露。
    format!("{base}/secrets-vault/vault.v1.json")
}

fn push_entry(entries: &mut Vec<SecretsVaultEntry>, reference: String, kind: &str, label: &str) {
    if let Ok(value) = Vault::get(&reference) {
        if value.is_empty() {
            return;
        }
        entries.push(SecretsVaultEntry {
            reference,
            value,
            kind: kind.to_string(),
            label: label.to_string(),
        });
    }
}

async fn collect_secret_entries_async(state: &AppState) -> Result<Vec<SecretsVaultEntry>, OmniError> {
    let mut entries = Vec::new();

    for conn in state.db_connections.list()? {
        push_entry(
            &mut entries,
            db_password_ref(&conn.id),
            "db",
            &conn.name,
        );
    }

    let connections = {
        let storage = state.storage.lock().await;
        storage.list_connections()?
    };

    for conn in connections {
        let label = conn.name.clone();
        match conn.kind {
            ConnectionKind::Ssh => {
                push_entry(&mut entries, ssh_password_ref(&conn.id), "ssh-password", &label);
                push_entry(&mut entries, ssh_pem_ref(&conn.id), "ssh-pem", &label);
                push_entry(
                    &mut entries,
                    ssh_passphrase_ref(&conn.id),
                    "ssh-passphrase",
                    &label,
                );
            }
            ConnectionKind::File => {
                push_entry(
                    &mut entries,
                    format!("file-cred-{}", conn.id),
                    "file",
                    &label,
                );
            }
            ConnectionKind::Panel => {
                push_entry(
                    &mut entries,
                    format!("panel-key-{}", conn.id),
                    "panel",
                    &label,
                );
                if let Some(r) = conn.credential_ref.as_deref() {
                    if !r.is_empty() {
                        push_entry(&mut entries, r.to_string(), "panel", &label);
                    }
                }
            }
            ConnectionKind::Cloud => {
                if let Some(r) = conn.credential_ref.as_deref() {
                    push_entry(&mut entries, r.to_string(), "cloud", &label);
                }
            }
            ConnectionKind::Docker => {
                push_entry(
                    &mut entries,
                    format!("docker-ssh-password-{}", conn.id),
                    "docker-ssh",
                    &label,
                );
                push_entry(
                    &mut entries,
                    format!("docker-ssh-pem-{}", conn.id),
                    "docker-ssh-pem",
                    &label,
                );
                push_entry(
                    &mut entries,
                    format!("docker-onepanel-{}", conn.id),
                    "docker-panel",
                    &label,
                );
                push_entry(
                    &mut entries,
                    format!("docker-btpanel-{}", conn.id),
                    "docker-btpanel",
                    &label,
                );
                push_entry(
                    &mut entries,
                    format!("docker-btpanel-session-{}", conn.id),
                    "docker-btpanel-session",
                    &label,
                );
            }
            _ => {}
        }
    }

    push_entry(
        &mut entries,
        http_proxy_password_ref().to_string(),
        "http-proxy",
        "HTTP Proxy",
    );
    push_entry(
        &mut entries,
        embedding_api_key_ref().to_string(),
        "embedding",
        "Embedding API",
    );

    Ok(entries)
}

fn import_entries(entries: &[SecretsVaultEntry]) -> (u32, u32) {
    let mut imported = 0u32;
    let mut skipped = 0u32;
    for entry in entries {
        let reference = entry.reference.trim();
        let value = entry.value.trim();
        if reference.is_empty() || value.is_empty() {
            skipped += 1;
            continue;
        }
        match Vault::store(reference, value) {
            Ok(()) => imported += 1,
            Err(_) => skipped += 1,
        }
    }
    (imported, skipped)
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_vault_status(state: State<'_, AppState>) -> Result<SecretsVaultStatus, OmniError> {
    let unlocked = SESSION
        .lock()
        .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))?
        .is_some();
    let has_local_salt = load_local_meta()?.is_some();
    let secret_count = collect_secret_entries_async(&state).await?.len() as u32;
    Ok(SecretsVaultStatus {
        unlocked,
        has_local_salt,
        secret_count,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_vault_unlock(device_code: String) -> Result<SecretsVaultStatus, OmniError> {
    // 设备识别码即主密码
    let password = normalize_device_code(&device_code)?;

    let salt = if let Some(meta) = load_local_meta()? {
        decode_salt_b64(&meta.salt_b64)?
    } else {
        let salt = generate_salt()?.to_vec();
        save_local_meta(&salt)?;
        salt
    };

    let key = derive_master_key(&password, &salt)?;
    *SESSION
        .lock()
        .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))? =
        Some(UnlockedSession { key, salt });

    Ok(SecretsVaultStatus {
        unlocked: true,
        has_local_salt: true,
        secret_count: 0,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_vault_lock() -> Result<(), OmniError> {
    *SESSION
        .lock()
        .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))? = None;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_vault_push(
    state: State<'_, AppState>,
    request: SecretsVaultPushRequest,
) -> Result<SecretsVaultPushResult, OmniError> {
    let _ = normalize_device_code(&request.device_code)?;
    if request.token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录，无法上传密文库"));
    }
    if request.oss_path.trim().is_empty() {
        return Err(OmniError::invalid_input("缺少 OSS 路径，请先完成登录资料同步"));
    }

    let (key, salt) = {
        let guard = SESSION
            .lock()
            .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))?;
        let session = guard
            .as_ref()
            .ok_or_else(|| OmniError::new(ErrorCode::Auth, "请先用设备识别码解锁"))?;
        (session.key.clone(), session.salt.clone())
    };

    let entries = collect_secret_entries_async(&state).await?;
    let secret_count = entries.len() as u32;
    let plain = SecretsVaultPlaintext {
        version: 1,
        exported_at: now_ms(),
        entries,
    };
    // envelope.device_code 仅作元数据标记，不参与路径；留空避免泄露。
    let envelope = encrypt_vault_with_salt(&key, &plain, "", &salt)?;
    let body = serde_json::to_vec_pretty(&envelope).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化密文信封失败").with_cause(e.to_string())
    })?;

    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&state, &request.token, &identity.device_id).await?;
    let sts = fetch_oss_sts(&auth).await?;
    let object_key = object_key_for(&request.oss_path);
    let uploaded = upload_object_bytes(
        &auth.http,
        &sts,
        &object_key,
        &body,
        "application/json",
    )
    .await?;

    Ok(SecretsVaultPushResult {
        object_key: uploaded.object_key,
        secret_count,
        bytes: uploaded.bytes as f64,
    })
}

#[tauri::command]
#[specta::specta]
pub async fn secrets_vault_pull(
    state: State<'_, AppState>,
    request: SecretsVaultPullRequest,
) -> Result<SecretsVaultPullResult, OmniError> {
    // 设备识别码即主密码
    let password = normalize_device_code(&request.device_code)?;
    if request.token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录，无法下载密文库"));
    }
    if request.oss_path.trim().is_empty() {
        return Err(OmniError::invalid_input("缺少 OSS 路径"));
    }

    let identity = auth_device_identity().await?;
    let auth: AuthContext = build_auth_context(&state, &request.token, &identity.device_id).await?;
    let sts = fetch_oss_sts(&auth).await?;
    let object_key = object_key_for(&request.oss_path);
    let bytes = get_object_bytes_optional(&auth.http, &sts, &object_key)
        .await?
        .ok_or_else(|| OmniError::not_found("云端尚无密文库"))?;

    let envelope: SecretsVaultEnvelope = serde_json::from_slice(&bytes).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "云端密文库格式无效").with_cause(e.to_string())
    })?;

    let plain = decrypt_vault(&password, &envelope)?;
    let salt = decode_salt_b64(&envelope.salt_b64)?;
    save_local_meta(&salt)?;

    // 同步解锁会话，便于紧接着 push
    let key = derive_master_key(&password, &salt)?;
    *SESSION
        .lock()
        .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))? =
        Some(UnlockedSession { key, salt });

    let (imported, skipped) = import_entries(&plain.entries);
    Ok(SecretsVaultPullResult {
        imported,
        skipped,
        secret_count: plain.entries.len() as u32,
    })
}
