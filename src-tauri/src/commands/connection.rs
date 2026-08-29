use std::net::ToSocketAddrs;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    Connection, ConnectionKind, DbConnectionConfig, Vault, ensure_creator_tag,
    get_cached_addresses, inject_ssh_vault_into_config, load_host_resolve_cache,
    save_host_resolve_cache, ssh_passphrase_ref, ssh_password_ref, ssh_pem_ref,
    upsert_cache_entry,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::State;

use crate::state::AppState;
use omnipanel_ssh::{SshConfig, ssh_config_from_json};

#[derive(Debug, Deserialize)]
struct PanelConfig {
    address: String,
    key: String,
    #[serde(rename = "serviceType")]
    service_type: String,
}

fn panel_success_message(data: &Value) -> String {
    let hostname = data
        .get("data")
        .and_then(|d| d.get("hostname"))
        .or_else(|| data.get("hostname"))
        .and_then(|v| v.as_str())
        .unwrap_or("1Panel");
    format!("连接成功：{hostname}")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_default()
}

fn gen_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    format!("conn-{nanos:x}")
}

pub(crate) fn ssh_credential_ref(connection_id: &str) -> String {
    ssh_password_ref(connection_id)
}

/// 从 Vault 注入密钥后解析 SSH 配置（config 内明文为空时回退钥匙串）。
pub(crate) fn resolve_ssh_config(conn: &Connection) -> Result<SshConfig, OmniError> {
    let (patched, password) =
        inject_ssh_vault_into_config(&conn.config, &conn.id, conn.credential_ref.as_deref())?;
    ssh_config_from_json(&patched, password.as_deref())
}

fn auth_password_plaintext(auth: &Value) -> Option<String> {
    auth.get("password")
        .and_then(|p| {
            p.as_str().map(str::to_string).or_else(|| {
                p.get("password")
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            })
        })
        .filter(|p| !p.is_empty())
}

/// 保存 SSH 凭据到钥匙串，并从 config JSON 清除明文。
fn normalize_ssh_connection(mut connection: Connection) -> Result<Connection, OmniError> {
    let mut value: Value = serde_json::from_str(&connection.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(e.to_string())
    })?;
    let Some(auth) = value.get_mut("auth").and_then(|a| a.as_object_mut()) else {
        return Ok(connection);
    };
    let auth_type = auth
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();

    if auth_type == "password" || auth_type.is_empty() {
        if let Some(pw) = auth_password_plaintext(&Value::Object(auth.clone())) {
            let cred_ref = ssh_credential_ref(&connection.id);
            Vault::store(&cred_ref, &pw)?;
            connection.credential_ref = Some(cred_ref);
        }
        auth.insert("password".into(), Value::String(String::new()));
        if auth_type.is_empty() {
            auth.insert("type".into(), Value::String("password".into()));
        }
    } else if auth_type == "privateKey" || auth_type == "private_key" {
        if let Some(pem) = auth
            .get("pem")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
        {
            Vault::store(&ssh_pem_ref(&connection.id), &pem)?;
        }
        if let Some(pp) = auth
            .get("passphrase")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string)
        {
            Vault::store(&ssh_passphrase_ref(&connection.id), &pp)?;
        }
        auth.insert("pem".into(), Value::Null);
        auth.insert("passphrase".into(), Value::Null);
        // privateKey 仍可用 credential_ref 占位标记「已配置凭据」
        if connection.credential_ref.is_none() {
            connection.credential_ref = Some(ssh_pem_ref(&connection.id));
        }
    }

    connection.config = serde_json::to_string(&value).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "SSH 配置序列化失败").with_cause(e.to_string())
    })?;

    // 校验可解析
    let _ = resolve_ssh_config(&connection)?;
    Ok(connection)
}

/// 删除连接时清理钥匙串条目。
pub(crate) fn delete_connection_vault_secrets(conn: &Connection) {
    if let Some(r) = conn.credential_ref.as_deref() {
        let _ = Vault::delete(r);
    }
    let _ = Vault::delete(&ssh_credential_ref(&conn.id));
    let _ = Vault::delete(&ssh_pem_ref(&conn.id));
    let _ = Vault::delete(&ssh_passphrase_ref(&conn.id));
    // Docker / Panel 等其它 ref 命名在 normalize 时写入 credential_ref，上面已覆盖
}

/// 是否为面板 API Key 的 Vault 引用（勿把 docker-ssh-password / ssh-password 当 API Key）。
fn is_panel_api_credential_ref(reference: &str) -> bool {
    reference.starts_with("docker-btpanel-")
        || reference.starts_with("docker-onepanel-")
        || reference.starts_with("panel-key-")
}

/// Docker / Panel config 中的 apiKey / key / 内嵌 SSH 密码进 Vault。
fn normalize_docker_or_panel_connection(
    mut connection: Connection,
) -> Result<Connection, OmniError> {
    let mut value: Value = serde_json::from_str(&connection.config).unwrap_or(json!({}));
    let id = connection.id.clone();
    let source = value
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // Panel: { key }
    if connection.kind == ConnectionKind::Panel {
        if let Some(key) = value
            .get("key")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
        {
            let cred_ref = format!("panel-key-{id}");
            Vault::store(&cred_ref, &key)?;
            connection.credential_ref = Some(cred_ref);
            value["key"] = Value::String(String::new());
        } else {
            // 编辑留空：保留 Vault；纠正误指向 SSH 密码等非面板密钥的 credential_ref
            let expected = format!("panel-key-{id}");
            let ref_ok = connection
                .credential_ref
                .as_deref()
                .is_some_and(is_panel_api_credential_ref);
            if !ref_ok {
                connection.credential_ref = Some(expected);
            }
            value["key"] = Value::String(String::new());
        }
    }

    // Docker onepanel.apiKey
    if let Some(api_key) = value
        .pointer("/onepanel/apiKey")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    {
        let cred_ref = format!("docker-onepanel-{id}");
        Vault::store(&cred_ref, &api_key)?;
        // 必须覆盖旧的 docker-ssh-password 等引用，否则编辑回显/兜底会误用 SSH 密码当 API Key
        connection.credential_ref = Some(cred_ref);
        if let Some(op) = value.get_mut("onepanel").and_then(|v| v.as_object_mut()) {
            op.insert("apiKey".into(), Value::String(String::new()));
        }
    }

    // Docker btpanel.apiKey（兼容 panel.apiKey）
    let bt_api_key = value
        .pointer("/btpanel/apiKey")
        .or_else(|| value.pointer("/panel/apiKey"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    if let Some(api_key) = bt_api_key {
        let cred_ref = format!("docker-btpanel-{id}");
        Vault::store(&cred_ref, &api_key)?;
        // 同上：宝塔密钥写入后必须把 credential_ref 指到 docker-btpanel-*（历史 bug 仅在 is_none 时写入）
        connection.credential_ref = Some(cred_ref);
        if let Some(op) = value.get_mut("btpanel").and_then(|v| v.as_object_mut()) {
            op.insert("apiKey".into(), Value::String(String::new()));
        }
        if let Some(op) = value.get_mut("panel").and_then(|v| v.as_object_mut()) {
            op.insert("apiKey".into(), Value::String(String::new()));
        }
    }

    // 编辑时密钥留空（保留 Vault）：仍纠正误指向 SSH 密码的 credential_ref
    if matches!(source.as_str(), "btpanel" | "baota" | "panel-adapter") {
        let expected = format!("docker-btpanel-{id}");
        let ref_ok = connection
            .credential_ref
            .as_deref()
            .is_some_and(is_panel_api_credential_ref);
        if !ref_ok {
            connection.credential_ref = Some(expected);
        }
    } else if matches!(source.as_str(), "onepanel" | "one-panel") {
        let expected = format!("docker-onepanel-{id}");
        let ref_ok = connection
            .credential_ref
            .as_deref()
            .is_some_and(is_panel_api_credential_ref);
        if !ref_ok {
            connection.credential_ref = Some(expected);
        }
    }

    // Docker 内嵌 ssh.auth.password / pem
    if let Some(auth) = value
        .pointer_mut("/ssh/auth")
        .and_then(|a| a.as_object_mut())
    {
        let auth_type = auth
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("")
            .to_string();
        if auth_type == "password" {
            if let Some(pw) = auth_password_plaintext(&Value::Object(auth.clone())) {
                let cred_ref = format!("docker-ssh-password-{id}");
                Vault::store(&cred_ref, &pw)?;
                if connection.credential_ref.is_none() {
                    connection.credential_ref = Some(cred_ref);
                } else {
                    // 主 credential_ref 已占（如 onepanel），仍写入独立 key
                    let _ = Vault::store(&format!("docker-ssh-password-{id}"), &pw);
                }
                auth.insert("password".into(), Value::String(String::new()));
            }
        } else if auth_type == "privateKey" {
            if let Some(pem) = auth
                .get("pem")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
            {
                let _ = Vault::store(&format!("docker-ssh-pem-{id}"), &pem);
                auth.insert("pem".into(), Value::Null);
            }
            if let Some(pp) = auth
                .get("passphrase")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
            {
                let _ = Vault::store(&format!("docker-ssh-passphrase-{id}"), &pp);
                auth.insert("passphrase".into(), Value::Null);
            }
        }
    }

    connection.config = serde_json::to_string(&value).unwrap_or(connection.config);
    Ok(connection)
}

/// 列出全部已保存连接。
#[tauri::command]
#[specta::specta]
pub async fn conn_list(state: State<'_, AppState>) -> Result<Vec<Connection>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_connections()
}

/// 保存（新建或更新）连接。id 为空时后端生成。
#[tauri::command]
#[specta::specta]
pub async fn conn_save(
    state: State<'_, AppState>,
    mut connection: Connection,
) -> Result<Connection, OmniError> {
    let now = now_secs();
    if connection.id.is_empty() {
        connection.id = gen_id();
    }
    if connection.created_at == 0 {
        connection.created_at = now;
    }
    connection.updated_at = now;

    match connection.kind {
        ConnectionKind::Ssh => {
            connection = normalize_ssh_connection(connection)?;
        }
        ConnectionKind::Docker | ConnectionKind::Panel => {
            connection = normalize_docker_or_panel_connection(connection)?;
        }
        ConnectionKind::Cloud => {
            connection = crate::commands::cloud::normalize_cloud_connection(connection)?;
        }
        _ => {}
    }

    let storage = state.storage.lock().await;
    // 新建连接时打 creator 标签，标记创建设备（多设备同步时区分来源）
    if storage.get_connection(&connection.id)?.is_none() {
        ensure_creator_tag(&mut connection.tags, &crate::commands::auth::current_device_name());
    }
    storage.save_connection(&connection)?;
    drop(storage);

    if connection.kind == ConnectionKind::Ssh {
        state
            .ssh_pool
            .reload_hosts(state.storage.clone(), state.app_handle.clone(), false)
            .await;
    }

    Ok(connection)
}

/// 删除连接。
#[tauri::command]
#[specta::specta]
pub async fn conn_delete(state: State<'_, AppState>, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    let existing = storage.get_connection(&id)?;
    let is_ssh = existing
        .as_ref()
        .is_some_and(|conn| conn.kind == ConnectionKind::Ssh);
    storage.delete_connection(&id)?;
    drop(storage);
    if let Some(conn) = existing {
        delete_connection_vault_secrets(&conn);
        // Docker 专用钥匙串
        let _ = Vault::delete(&format!("docker-onepanel-{}", conn.id));
        let _ = Vault::delete(&format!("docker-btpanel-{}", conn.id));
        let _ = Vault::delete(&format!("docker-btpanel-session-{}", conn.id));
        let _ = Vault::delete(&format!("docker-ssh-password-{}", conn.id));
        let _ = Vault::delete(&format!("docker-ssh-pem-{}", conn.id));
        let _ = Vault::delete(&format!("docker-ssh-passphrase-{}", conn.id));
        let _ = Vault::delete(&format!("panel-key-{}", conn.id));
        let _ = Vault::delete(&crate::commands::cloud::cloud_secret_ref(&conn.id));
    }
    if is_ssh {
        state
            .ssh_pool
            .reload_hosts(state.storage.clone(), state.app_handle.clone(), false)
            .await;
    }
    Ok(())
}

/// 测试连接连通性。当前支持 database（MySQL）；其余类型将在对应里程碑接入。
///
/// `secret`：可选明文凭据（文件连接对话框「测试连接」用）。为空时回退到
/// `connection.credential_ref` 指向的 Vault；保存前测试必须传入表单中的密钥。
#[tauri::command]
#[specta::specta]
pub async fn conn_test(
    state: State<'_, AppState>,
    connection: Connection,
    secret: Option<String>,
) -> Result<String, OmniError> {
    match connection.kind {
        ConnectionKind::Database => {
            let mut db_config: DbConnectionConfig = serde_json::from_str(&connection.config)
                .map_err(|e| {
                    OmniError::new(ErrorCode::InvalidInput, "数据库连接配置解析失败")
                        .with_cause(e.to_string())
                })?;
            if db_config.password.trim().is_empty() {
                if let Ok(pw) = Vault::get(&format!("db-password-{}", db_config.id)) {
                    db_config.password = pw;
                } else if let Some(r) = connection.credential_ref.as_deref() {
                    if let Ok(pw) = Vault::get(r) {
                        db_config.password = pw;
                    }
                }
            }
            let version = crate::commands::database::db_test_connection(db_config)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Connection, "数据库连接测试失败").with_cause(e)
                })?;
            Ok(format!("连接成功：{version}"))
        }
        ConnectionKind::Panel => {
            let mut cfg: PanelConfig = serde_json::from_str(&connection.config).map_err(|e| {
                OmniError::new(ErrorCode::InvalidInput, "面板连接配置解析失败")
                    .with_cause(e.to_string())
            })?;
            if cfg.key.trim().is_empty() {
                let from_vault = connection
                    .credential_ref
                    .as_deref()
                    .filter(|r| {
                        r.starts_with("panel-key-")
                            || r.starts_with("docker-btpanel-")
                            || r.starts_with("docker-onepanel-")
                    })
                    .and_then(|r| Vault::get(r).ok())
                    .or_else(|| Vault::get(&format!("panel-key-{}", connection.id)).ok());
                if let Some(key) = from_vault {
                    cfg.key = key;
                }
            }
            if cfg.address.trim().is_empty() {
                return Err(OmniError::invalid_input("请填写服务器地址"));
            }
            if cfg.key.trim().is_empty() {
                return Err(OmniError::invalid_input("请填写 API 密钥"));
            }
            match cfg.service_type.as_str() {
                "1panel" => {
                    let data =
                        crate::panel::onepanel::test_connection(&cfg.address, &cfg.key).await?;
                    Ok(panel_success_message(&data))
                }
                "bt" => {
                    crate::panel::btpanel::test_connection(&cfg.address, &cfg.key).await?;
                    Ok("连接成功：宝塔面板".to_string())
                }
                other => Err(OmniError::invalid_input(format!(
                    "不支持的面板类型：{other}"
                ))),
            }
        }
        ConnectionKind::File => {
            let msg = crate::commands::file_manager::file_test_connection_config(
                &state,
                &connection,
                secret.as_deref(),
            )
            .await?;
            if !connection.id.is_empty() {
                crate::commands::file_manager::mark_file_connection_online(&state, &connection.id);
            }
            Ok(msg)
        }
        ConnectionKind::Cloud => {
            crate::commands::cloud::cloud_test(state, connection, secret).await
        }
        other => Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("暂不支持 {other:?} 类型的连接测试"),
        )),
    }
}

/// 解析域名为 IP 地址，结果持久化到缓存，避免重复解析。
/// 传入已存在的 IP 地址直接返回；域名则先查缓存，未命中再 DNS 解析。
#[tauri::command]
#[specta::specta]
pub async fn resolve_host(host: String) -> Result<Vec<String>, OmniError> {
    let trimmed = host.trim().to_lowercase();
    if trimmed.is_empty() {
        return Err(OmniError::invalid_input("host 为空"));
    }

    let is_ip = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == ':');
    if is_ip {
        return Ok(vec![trimmed]);
    }

    let mut cache = load_host_resolve_cache()
        .map_err(|e| OmniError::internal(format!("加载主机解析缓存失败: {e}")))?;
    if let Some(cached) = get_cached_addresses(&cache, &trimmed) {
        if !cached.is_empty() {
            return Ok(cached);
        }
    }

    let addrs: Vec<String> = tokio::task::spawn_blocking({
        let host = trimmed.clone();
        move || {
            (host.as_str(), 0)
                .to_socket_addrs()
                .ok()
                .into_iter()
                .flatten()
                .map(|sa| sa.ip().to_string())
                .collect::<Vec<_>>()
        }
    })
    .await
    .map_err(|e| OmniError::internal(format!("DNS 解析任务失败: {e}")))?
    .into_iter()
    .collect();

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    upsert_cache_entry(&mut cache, &trimmed, addrs.clone(), now);
    save_host_resolve_cache(&cache)
        .map_err(|e| OmniError::internal(format!("保存主机解析缓存失败: {e}")))?;

    Ok(addrs)
}
