use std::collections::HashMap;
use std::net::ToSocketAddrs;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    Connection, ConnectionKind, DbConnectionConfig, HostResolveEntry, Vault,
    get_cached_addresses, load_host_resolve_cache, save_host_resolve_cache, upsert_cache_entry,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::State;

use crate::state::AppState;
use omnipanel_ssh::ssh_config_from_json;

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

fn ssh_credential_ref(connection_id: &str) -> String {
    format!("ssh-password-{connection_id}")
}

/// 保存 SSH 密码到钥匙串，并规范化 config 中的 `auth` 字段。
fn normalize_ssh_connection(mut connection: Connection) -> Result<Connection, OmniError> {
    let value: Value = serde_json::from_str(&connection.config).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "SSH 配置解析失败").with_cause(e.to_string())
    })?;
    let Some(auth) = value.get("auth").and_then(|a| a.as_object()) else {
        return Ok(connection);
    };
    let auth_type = auth
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("");
    if auth_type != "password" {
        return Ok(connection);
    }

    let password = auth
        .get("password")
        .and_then(|p| {
            p.as_str()
                .map(str::to_string)
                .or_else(|| p.get("password").and_then(|v| v.as_str()).map(str::to_string))
        })
        .filter(|p| !p.is_empty());

    if let Some(pw) = password {
        let cred_ref = ssh_credential_ref(&connection.id);
        Vault::store(&cred_ref, &pw)?;
        connection.credential_ref = Some(cred_ref);
    }

    // 校验配置可被 ssh_config_from_json 解析
    let secret = connection
        .credential_ref
        .as_deref()
        .and_then(|r| Vault::get(r).ok());
    ssh_config_from_json(&connection.config, secret.as_deref())?;
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

    if connection.kind == ConnectionKind::Ssh {
        connection = normalize_ssh_connection(connection)?;
    }

    let storage = state.storage.lock().await;
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
    storage.delete_connection(&id)
}

/// 测试连接连通性。当前支持 database（MySQL）；其余类型将在对应里程碑接入。
#[tauri::command]
#[specta::specta]
pub async fn conn_test(
    state: State<'_, AppState>,
    connection: Connection,
) -> Result<String, OmniError> {
    match connection.kind {
        ConnectionKind::Database => {
            let db_config: DbConnectionConfig =
                serde_json::from_str(&connection.config).map_err(|e| {
                    OmniError::new(ErrorCode::InvalidInput, "数据库连接配置解析失败")
                        .with_cause(e.to_string())
                })?;
            let version = crate::commands::database::db_test_connection(db_config)
                .await
                .map_err(|e| {
                    OmniError::new(ErrorCode::Connection, "数据库连接测试失败").with_cause(e)
                })?;
            Ok(format!("连接成功：{version}"))
        }
        ConnectionKind::Panel => {
            let cfg: PanelConfig = serde_json::from_str(&connection.config).map_err(|e| {
                OmniError::new(ErrorCode::InvalidInput, "面板连接配置解析失败")
                    .with_cause(e.to_string())
            })?;
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
                "bt" => Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    "宝塔面板连接测试尚未实现",
                )),
                other => Err(OmniError::invalid_input(format!(
                    "不支持的面板类型：{other}"
                ))),
            }
        }
        ConnectionKind::File => {
            let msg =
                crate::commands::file_manager::file_test_connection_config(&state, &connection)
                    .await?;
            if !connection.id.is_empty() {
                crate::commands::file_manager::mark_file_connection_online(
                    &state,
                    &connection.id,
                );
            }
            Ok(msg)
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

    // 已经是 IP 地址 → 直接返回
    let is_ip = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == ':');
    if is_ip {
        return Ok(vec![trimmed]);
    }

    // 查缓存
    let mut cache = load_host_resolve_cache().map_err(|e| {
        OmniError::internal(format!("加载主机解析缓存失败: {e}"))
    })?;
    if let Some(cached) = get_cached_addresses(&cache, &trimmed) {
        if !cached.is_empty() {
            return Ok(cached);
        }
    }

    // DNS 解析
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

    // 持久化缓存
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    upsert_cache_entry(&mut cache, &trimmed, addrs.clone(), now);
    save_host_resolve_cache(&cache).map_err(|e| {
        OmniError::internal(format!("保存主机解析缓存失败: {e}"))
    })?;

    Ok(addrs)
}
