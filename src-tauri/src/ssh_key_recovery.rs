//! 选定的钥匙在这台电脑没有私钥时：先试保险库里已有的私钥，再试 `~/.ssh`。
//! 服务器接受哪一把，就把连接绑到那一把；本机文件还要先导入保险库。

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{
    SshAuth, SshConfig, SshKeyAttempt, is_private_key_pem_content, list_ssh_private_key_paths,
    ssh_private_key_public_meta,
};
use omnipanel_store::{Storage, Vault, ssh_key_passphrase_ref, ssh_key_private_ref};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter};

pub const SSH_KEY_REBOUND_EVENT: &str = "ssh-key-rebound";

pub struct RecoveredKeyBind {
    pub key_id: String,
    pub auth: SshAuth,
}

struct RankedAttempt {
    order: (u8, u8, String),
    attempt: SshKeyAttempt,
}

/// 已有私钥时返回 `None`，调用方只使用那一把。
/// 选定了钥匙但保险库里没有私钥时，返回按优先级排好的候选。
pub fn plan_private_key_recovery(
    storage: &Storage,
    config: &SshConfig,
) -> OmniResult<Option<Vec<SshKeyAttempt>>> {
    let SshAuth::PrivateKey {
        pem,
        key_path,
        key_id,
        ..
    } = &config.auth
    else {
        return Ok(None);
    };
    if pem.as_deref().is_some_and(|value| !value.trim().is_empty()) {
        return Ok(None);
    }
    let Some(selected_id) = key_id.as_deref().map(str::trim).filter(|id| !id.is_empty()) else {
        return Ok(None);
    };

    let selected_fp = storage
        .get_ssh_key(selected_id)?
        .map(|record| record.fingerprint)
        .unwrap_or_default();
    let mut vault_ranked: Vec<RankedAttempt> = Vec::new();
    let mut file_ranked: Vec<RankedAttempt> = Vec::new();
    let mut seen_fingerprints = Vec::new();

    for record in storage.list_ssh_keys()? {
        let Ok(private_pem) = Vault::get(&ssh_key_private_ref(&record.id)) else {
            continue;
        };
        if private_pem.trim().is_empty() {
            continue;
        }
        let fingerprint = record.fingerprint.trim().to_string();
        if !fingerprint.is_empty() {
            seen_fingerprints.push(fingerprint.clone());
        }
        let passphrase = Vault::get(&ssh_key_passphrase_ref(&record.id))
            .ok()
            .filter(|value| !value.trim().is_empty());
        let file_name = Path::new(&record.source_path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .unwrap_or(record.name.as_str());
        vault_ranked.push(RankedAttempt {
            order: recovery_order_key(
                fingerprint_matches(&selected_fp, &fingerprint),
                file_name,
                &record.key_type,
                &record.name,
            ),
            attempt: SshKeyAttempt {
                id: format!("vault:{}", record.id),
                pem: private_pem,
                passphrase,
            },
        });
    }

    let mut files = list_ssh_private_key_paths();
    if let Some(path) = key_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        if path != "auto" {
            let path = PathBuf::from(path);
            if path.is_file() && !files.iter().any(|existing| existing == &path) {
                files.push(path);
            }
        }
    }
    for path in files {
        let Ok(private_pem) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !is_private_key_pem_content(&private_pem) {
            continue;
        }
        let Some((public_key, fingerprint, key_type, _)) =
            ssh_private_key_public_meta(&private_pem)
        else {
            continue;
        };
        if public_key.trim().is_empty() {
            continue;
        }
        let fingerprint = fingerprint.trim().to_string();
        if !fingerprint.is_empty()
            && seen_fingerprints
                .iter()
                .any(|known| fingerprint_matches(known, &fingerprint))
        {
            continue;
        }
        if !fingerprint.is_empty() {
            seen_fingerprints.push(fingerprint.clone());
        }
        let file_name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("imported-key");
        file_ranked.push(RankedAttempt {
            order: recovery_order_key(
                fingerprint_matches(&selected_fp, &fingerprint),
                file_name,
                &key_type,
                file_name,
            ),
            attempt: SshKeyAttempt {
                id: format!("file:{}", path.display()),
                pem: private_pem,
                passphrase: None,
            },
        });
    }

    vault_ranked.sort_by(|left, right| left.order.cmp(&right.order));
    file_ranked.sort_by(|left, right| left.order.cmp(&right.order));
    let mut attempts = Vec::with_capacity(vault_ranked.len() + file_ranked.len());
    attempts.extend(vault_ranked.into_iter().map(|item| item.attempt));
    attempts.extend(file_ranked.into_iter().map(|item| item.attempt));
    Ok(Some(attempts))
}

/// 把服务器接受的那一把写回连接。本机文件先导入保险库。
pub fn apply_recovered_private_key(
    storage: &Storage,
    connection_id: &str,
    winner_id: &str,
) -> OmniResult<RecoveredKeyBind> {
    let key_id = if let Some(id) = winner_id.strip_prefix("vault:") {
        id.to_string()
    } else if let Some(path) = winner_id.strip_prefix("file:") {
        import_private_key_file(storage, Path::new(path))?.id
    } else {
        return Err(OmniError::new(ErrorCode::Internal, "无法识别匹配到的私钥"));
    };

    let mut conn = storage
        .get_connection(connection_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "SSH 连接不存在"))?;
    let mut value: Value = serde_json::from_str(&conn.config).map_err(|err| {
        OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(err.to_string())
    })?;
    let auth = value
        .get_mut("auth")
        .and_then(|item| item.as_object_mut())
        .ok_or_else(|| OmniError::new(ErrorCode::InvalidInput, "SSH 认证配置缺失"))?;
    auth.insert("type".into(), json!("privateKey"));
    auth.insert("keyId".into(), json!(key_id.clone()));
    auth.remove("key_id");
    auth.insert("pem".into(), Value::Null);
    auth.insert("keyPath".into(), Value::Null);
    auth.remove("key_path");
    auth.insert("passphrase".into(), Value::Null);
    conn.config = serde_json::to_string(&value).map_err(|err| {
        OmniError::new(ErrorCode::Internal, "SSH 配置序列化失败").with_cause(err.to_string())
    })?;
    conn.updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    storage.save_connection(&conn)?;

    let pem = Vault::get(&ssh_key_private_ref(&key_id)).ok();
    let passphrase = Vault::get(&ssh_key_passphrase_ref(&key_id))
        .ok()
        .filter(|value| !value.trim().is_empty());
    Ok(RecoveredKeyBind {
        key_id: key_id.clone(),
        auth: SshAuth::PrivateKey {
            pem,
            key_path: None,
            key_id: Some(key_id),
            passphrase,
        },
    })
}

pub fn emit_ssh_key_rebound(app: &AppHandle, connection_id: &str, key_id: &str) {
    let _ = app.emit(
        SSH_KEY_REBOUND_EVENT,
        json!({
            "connectionId": connection_id,
            "keyId": key_id,
        }),
    );
}

fn import_private_key_file(
    storage: &Storage,
    path: &Path,
) -> OmniResult<omnipanel_store::SshKeyRecord> {
    let private_pem = std::fs::read_to_string(path).map_err(|err| {
        OmniError::new(ErrorCode::Io, "读取 SSH 私钥失败")
            .with_cause(format!("{}: {err}", path.display()))
    })?;
    let (public_key, fingerprint, key_type, comment) = ssh_private_key_public_meta(&private_pem)
        .ok_or_else(|| {
            OmniError::new(
                ErrorCode::InvalidInput,
                format!("SSH 私钥内容无效: {}", path.display()),
            )
        })?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("imported-key");
    storage.upsert_ssh_key_from_private_pem(
        name,
        &private_pem,
        &key_type,
        &fingerprint,
        &comment,
        &public_key,
        &path.to_string_lossy(),
        None,
    )
}

fn fingerprint_matches(left: &str, right: &str) -> bool {
    let left = left.trim();
    let right = right.trim();
    !left.is_empty() && left == right
}

/// 同指纹优先，其次 `id_ed25519`，再是 `id_rsa`。
fn recovery_order_key(
    same_fingerprint: bool,
    file_name: &str,
    key_type: &str,
    name: &str,
) -> (u8, u8, String) {
    let rank = match file_name.to_ascii_lowercase().as_str() {
        "id_ed25519" => 0,
        "id_ecdsa" => 1,
        "id_rsa" => 3,
        "id_dsa" => 4,
        _ if key_type.eq_ignore_ascii_case("ed25519") => 2,
        _ => 5,
    };
    let group = if same_fingerprint { 0 } else { 1 };
    (group, rank, name.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::recovery_order_key;

    #[test]
    fn same_fingerprint_then_ed25519_then_rsa() {
        let same = recovery_order_key(true, "id_rsa", "rsa", "id_rsa");
        let ed25519 = recovery_order_key(false, "id_ed25519", "ed25519", "id_ed25519");
        let rsa = recovery_order_key(false, "id_rsa", "rsa", "id_rsa");
        assert!(same < ed25519);
        assert!(ed25519 < rsa);
    }
}
