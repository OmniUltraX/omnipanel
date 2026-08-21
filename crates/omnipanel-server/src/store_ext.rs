//! 任务 / 审计 / 第三方账号 / 密文库（本地 store 部分）。

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_assistant::{
    fetch_oss_sts, get_object_bytes_optional, upload_object_bytes,
};
use omnipanel_store::{
    decode_salt_b64, derive_master_key, encrypt_vault_with_salt, generate_salt, AuditEntry,
    ConnectionKind, decrypt_vault, MasterKey, SaveTaskRequest, SecretsVaultEnvelope,
    SecretsVaultEntry, SecretsVaultPlaintext, Task, TaskStatus, ThirdPartyAccount,
    UpsertThirdPartyAccountInput, Vault,
};

use crate::assistant_cmds::build_auth_context;
use crate::auth_cmds::auth_device_identity;
use serde::{Deserialize, Serialize};

use crate::state::ServerState;

pub async fn task_list(
    state: &ServerState,
    status_filter: Option<String>,
    limit: u32,
) -> Result<Vec<Task>, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_list(status_filter.as_deref(), limit)
}

pub async fn task_get(state: &ServerState, id: String) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_get(&id)
}

pub async fn task_save(state: &ServerState, req: SaveTaskRequest) -> Result<Task, OmniError> {
    let storage = state.storage.lock().await;
    storage.task_save(&req)
}

pub async fn task_update_status(
    state: &ServerState,
    id: String,
    status: TaskStatus,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.task_update_status(&id, &status)
}

pub async fn task_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.task_delete(&id)
}

pub async fn audit_log_recent(
    state: &ServerState,
    limit: Option<u32>,
) -> Result<Vec<AuditEntry>, String> {
    let storage = state.storage.lock().await;
    storage
        .recent_audit(limit.unwrap_or(200))
        .map_err(|e| e.to_string())
}

pub async fn audit_log_append(state: &ServerState, entry: AuditEntry) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.append_audit(&entry).map_err(|e| e.to_string())
}

pub async fn third_party_account_list(
    state: &ServerState,
) -> Result<Vec<ThirdPartyAccount>, String> {
    state
        .storage
        .lock()
        .await
        .list_third_party_accounts()
        .map_err(|e| e.to_string())
}

pub async fn third_party_account_upsert(
    state: &ServerState,
    input: UpsertThirdPartyAccountInput,
) -> Result<ThirdPartyAccount, String> {
    state
        .storage
        .lock()
        .await
        .upsert_third_party_account(input)
        .map_err(|e| e.to_string())
}

pub async fn third_party_account_delete(state: &ServerState, id: String) -> Result<(), String> {
    state
        .storage
        .lock()
        .await
        .delete_third_party_account(&id)
        .map_err(|e| e.to_string())
}

// ── Secrets Vault（本地解锁；push/pull 依赖 OSS 登录，Web 端跳过） ──

const META_FILE: &str = "meta.json";

struct UnlockedSession {
    key: MasterKey,
    salt: Vec<u8>,
}

static VAULT_SESSION: Mutex<Option<UnlockedSession>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultStatus {
    pub unlocked: bool,
    pub has_local_salt: bool,
    pub secret_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct LocalVaultMeta {
    salt_b64: String,
    updated_at: i64,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn normalize_device_code(raw: &str) -> Result<String, OmniError> {
    omnipanel_store::normalize_sync_master_key(raw).map_err(|_| {
        OmniError::invalid_input("请输入 SyncMasterKey（opsk1_…）".to_string())
    })
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
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取 secrets-vault meta 失败").with_cause(e.to_string())
    })?;
    serde_json::from_str(&raw).map_err(|e| {
        OmniError::invalid_input(format!("解析 secrets-vault meta 失败: {e}"))
    })
}

fn save_local_meta(salt: &[u8]) -> Result<(), OmniError> {
    use base64::Engine;
        let meta = LocalVaultMeta {
        salt_b64: base64::engine::general_purpose::STANDARD.encode(salt),
        updated_at: now_ms(),
    };
    let raw = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(meta_path()?, raw).map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 secrets-vault meta 失败").with_cause(e.to_string())
    })
}

async fn count_vault_secrets(state: &ServerState) -> Result<usize, OmniError> {
    use omnipanel_store::{
        db_password_ref, embedding_api_key_ref, http_proxy_password_ref, ssh_passphrase_ref,
        ssh_password_ref, ssh_pem_ref,
    };

    let mut count = 0usize;
    let mut seen = std::collections::HashSet::new();

    let mut push_if = |reference: &str| {
        if reference.is_empty() || !seen.insert(reference.to_string()) {
            return;
        }
        if Vault::get(reference).ok().is_some_and(|v| !v.trim().is_empty()) {
            count += 1;
        }
    };

    for conn in state.db_connections.list()? {
        push_if(&db_password_ref(&conn.id));
    }

    let connections = {
        let storage = state.storage.lock().await;
        storage.list_connections()?
    };

    for conn in connections {
        match conn.kind {
            ConnectionKind::Ssh => {
                push_if(&ssh_password_ref(&conn.id));
                push_if(&ssh_pem_ref(&conn.id));
                push_if(&ssh_passphrase_ref(&conn.id));
            }
            ConnectionKind::File => push_if(&format!("file-cred-{}", conn.id)),
            ConnectionKind::Panel => {
                push_if(&format!("panel-key-{}", conn.id));
                if let Some(r) = conn.credential_ref.as_deref() {
                    push_if(r);
                }
            }
            ConnectionKind::Cloud => {
                if let Some(r) = conn.credential_ref.as_deref() {
                    push_if(r);
                }
            }
            ConnectionKind::Docker => {
                push_if(&format!("docker-ssh-password-{}", conn.id));
                push_if(&format!("docker-ssh-pem-{}", conn.id));
                push_if(&format!("docker-onepanel-{}", conn.id));
            }
            _ => {}
        }
    }

    push_if(http_proxy_password_ref());
    push_if(embedding_api_key_ref());
    Ok(count)
}

pub async fn secrets_vault_status(state: &ServerState) -> Result<SecretsVaultStatus, OmniError> {
    let unlocked = VAULT_SESSION
        .lock()
        .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))?
        .is_some();
    let has_local_salt = load_local_meta()?.is_some();
    let secret_count = count_vault_secrets(state).await? as u32;
    Ok(SecretsVaultStatus {
        unlocked,
        has_local_salt,
        secret_count,
    })
}

pub async fn secrets_vault_unlock(device_code: String) -> Result<SecretsVaultStatus, OmniError> {
    let password = normalize_device_code(&device_code)?;
    let salt = if let Some(meta) = load_local_meta()? {
        decode_salt_b64(&meta.salt_b64)?
    } else {
        let salt = generate_salt()?.to_vec();
        save_local_meta(&salt)?;
        salt
    };
    let key = derive_master_key(&password, &salt)?;
    *VAULT_SESSION
        .lock()
        .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))? =
        Some(UnlockedSession { key, salt });
    Ok(SecretsVaultStatus {
        unlocked: true,
        has_local_salt: true,
        secret_count: 0,
    })
}

pub async fn secrets_vault_lock() -> Result<(), OmniError> {
    *VAULT_SESSION
        .lock()
        .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))? = None;
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPushRequest {
    pub token: String,
    pub device_code: String,
    pub oss_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPushResult {
    pub object_key: String,
    pub secret_count: u32,
    pub bytes: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPullRequest {
    pub token: String,
    pub device_code: String,
    pub oss_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretsVaultPullResult {
    pub imported: u32,
    pub skipped: u32,
    pub secret_count: u32,
}

fn object_key_for(oss_path: &str) -> String {
    let base = oss_path.trim().trim_matches('/');
    format!("{base}/secrets-vault/vault.v1.json")
}

async fn collect_secret_entries(state: &ServerState) -> Result<Vec<SecretsVaultEntry>, OmniError> {
    use omnipanel_store::{
        db_password_ref, embedding_api_key_ref, http_proxy_password_ref, ssh_passphrase_ref,
        ssh_password_ref, ssh_pem_ref,
    };
    let mut entries = Vec::new();
    let push_entry = |entries: &mut Vec<SecretsVaultEntry>, reference: String, kind: &str, label: &str| {
        if let Ok(value) = Vault::get(&reference) {
            if !value.is_empty() {
                entries.push(SecretsVaultEntry {
                    reference,
                    value,
                    kind: kind.to_string(),
                    label: label.to_string(),
                });
            }
        }
    };
    for conn in state.db_connections.list()? {
        push_entry(&mut entries, db_password_ref(&conn.id), "db", &conn.name);
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
                push_entry(&mut entries, ssh_passphrase_ref(&conn.id), "ssh-passphrase", &label);
            }
            ConnectionKind::File => push_entry(&mut entries, format!("file-cred-{}", conn.id), "file", &label),
            ConnectionKind::Panel => {
                push_entry(&mut entries, format!("panel-key-{}", conn.id), "panel", &label);
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
                push_entry(&mut entries, format!("docker-ssh-password-{}", conn.id), "docker-ssh", &label);
                push_entry(&mut entries, format!("docker-ssh-pem-{}", conn.id), "docker-ssh-pem", &label);
                push_entry(&mut entries, format!("docker-onepanel-{}", conn.id), "docker-panel", &label);
            }
            _ => {}
        }
    }
    push_entry(&mut entries, http_proxy_password_ref().to_string(), "http-proxy", "HTTP Proxy");
    push_entry(&mut entries, embedding_api_key_ref().to_string(), "embedding", "Embedding API");
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

pub async fn secrets_vault_push(
    state: &ServerState,
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
        let guard = VAULT_SESSION
            .lock()
            .map_err(|_| OmniError::internal("secrets vault session lock poisoned"))?;
        let session = guard
            .as_ref()
            .ok_or_else(|| OmniError::new(ErrorCode::Auth, "请先用 SyncMasterKey 解锁"))?;
        (session.key.clone(), session.salt.clone())
    };
    let entries = collect_secret_entries(state).await?;
    let secret_count = entries.len() as u32;
    let plain = SecretsVaultPlaintext {
        version: 1,
        exported_at: now_ms(),
        entries,
    };
    let envelope = encrypt_vault_with_salt(&key, &plain, "", &salt)?;
    let body = serde_json::to_vec_pretty(&envelope).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化密文信封失败").with_cause(e.to_string())
    })?;
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;
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

pub async fn secrets_vault_pull(
    _state: &ServerState,
    request: SecretsVaultPullRequest,
) -> Result<SecretsVaultPullResult, OmniError> {
    let password = normalize_device_code(&request.device_code)?;
    if request.token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录，无法下载密文库"));
    }
    if request.oss_path.trim().is_empty() {
        return Err(OmniError::invalid_input("缺少 OSS 路径"));
    }
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;
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
    let key = derive_master_key(&password, &salt)?;
    *VAULT_SESSION
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMasterKeyStatus {
    pub has_key: bool,
    pub key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMasterKeyGetOrCreateResult {
    pub key: String,
    pub created: bool,
}

pub async fn sync_master_key_status() -> Result<SyncMasterKeyStatus, OmniError> {
    match omnipanel_store::load_stored_sync_master_key()? {
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

pub async fn sync_master_key_get_or_create() -> Result<SyncMasterKeyGetOrCreateResult, OmniError> {
    let (key, created) = omnipanel_store::get_or_create_sync_master_key()?;
    Ok(SyncMasterKeyGetOrCreateResult { key, created })
}

pub async fn sync_master_key_clear() -> Result<(), OmniError> {
    omnipanel_store::clear_stored_sync_master_key()
}

pub async fn sync_master_key_validate(key: String) -> Result<bool, OmniError> {
    let Ok(norm) = omnipanel_store::normalize_sync_master_key(&key) else {
        return Ok(false);
    };
    Ok(omnipanel_store::is_valid_sync_master_key(&norm))
}

struct EphemeralPairingKey {
    secret: [u8; 32],
    pubkey_b64: String,
    pairing_id: String,
}

static EPH: std::sync::Mutex<Option<EphemeralPairingKey>> = std::sync::Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingKeypairResult {
    pub pubkey_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrapKeyRequest {
    pub pairing_id: String,
    pub requester_device_id: String,
    pub requester_pubkey_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrapKeyResult {
    pub wrapped_key: String,
    pub wrap_alg: String,
}

pub async fn sync_pairing_create_keypair(pairing_id: String) -> Result<PairingKeypairResult, OmniError> {
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
    let (secret, pubkey_b64) = omnipanel_store::generate_pairing_keypair()?;
    *guard = Some(EphemeralPairingKey {
        secret,
        pubkey_b64: pubkey_b64.clone(),
        pairing_id,
    });
    Ok(PairingKeypairResult { pubkey_b64 })
}

pub async fn sync_pairing_wrap_key(request: WrapKeyRequest) -> Result<WrapKeyResult, OmniError> {
    let smk = omnipanel_store::load_stored_sync_master_key()?.ok_or_else(|| {
        OmniError::new(
            ErrorCode::Auth,
            "本机尚未解锁 SyncMasterKey，无法传钥",
        )
    })?;
    let aad = format!("{}:{}", request.pairing_id, request.requester_device_id);
    let wrapped_key =
        omnipanel_store::wrap_sync_master_key(&smk, &request.requester_pubkey_b64, &aad)?;
    Ok(WrapKeyResult {
        wrapped_key,
        wrap_alg: omnipanel_store::WRAP_ALG.to_string(),
    })
}

pub async fn sync_pairing_unwrap_and_store(
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
                ErrorCode::InvalidInput,
                "无本地临时密钥，请重新发起配对",
            )
        })?;
    if eph.pairing_id != pairing_id {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "pairing_id 与本地临时密钥不匹配",
        ));
    }
    let aad = format!("{}:{}", pairing_id, requester_device_id);
    let smk = omnipanel_store::unwrap_sync_master_key(&wrapped_key, &eph.secret, &aad)?;
    omnipanel_store::store_sync_master_key(&smk)?;
    Ok(())
}

pub async fn write_text_file(path: String, contents: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("未指定文件路径".to_string());
    }
    let target = PathBuf::from(&path);
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
        }
    }
    std::fs::write(&target, contents.as_bytes()).map_err(|e| format!("写入文件失败: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}
