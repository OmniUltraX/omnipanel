//! 文件连接 CRUD / 测连 / 临时目录。

use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{Connection, ConnectionKind, Vault, ensure_creator_tag};

use crate::files::{
    LOCAL_CONNECTION_ID, ftp_connect_sync, load_file_connection, local_home, parse_file_config,
    protocol_of, sftp_session_for,
};
use crate::state::ServerState;

fn unix_secs(t: SystemTime) -> i64 {
    t.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn now_unix_nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

fn ensure_file_connection_id(connection: &mut Connection) {
    if !connection.id.trim().is_empty() {
        return;
    }
    let nanos = now_unix_nanos();
    connection.id = format!("file-{nanos:x}");
    if connection.created_at == 0 {
        connection.created_at = (nanos / 1_000_000_000) as i64;
    }
}

fn file_credential_ref_for(connection_id: &str) -> String {
    format!("file-cred-{connection_id}")
}

fn bind_file_connection_secret(
    connection: &mut Connection,
    secret: Option<String>,
) -> Result<(), OmniError> {
    if connection.id.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Internal,
            "保存文件凭据前必须先分配 connection.id",
        ));
    }
    let desired = file_credential_ref_for(&connection.id);
    if let Some(sec) = secret.filter(|s| !s.is_empty()) {
        Vault::store(&desired, &sec)?;
        connection.credential_ref = Some(desired);
    }
    Ok(())
}

fn resolve_secret(connection: &Connection) -> Option<String> {
    connection
        .credential_ref
        .as_deref()
        .and_then(|r| Vault::get(r).ok())
}

async fn file_test_connection_config(
    state: &ServerState,
    connection: &Connection,
    secret_override: Option<&str>,
) -> Result<String, OmniError> {
    let cfg = parse_file_config(connection)?;
    let secret = secret_override
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| resolve_secret(connection))
        .unwrap_or_default();
    match protocol_of(&cfg) {
        "local" => {
            let home = local_home()?;
            Ok(format!("本机可用：{}", home.display()))
        }
        "sftp" => {
            let _ = sftp_session_for(state, &connection.id, connection, &cfg).await?;
            Ok("SFTP 连接成功".into())
        }
        "ftp" => {
            let cfg_clone = cfg.clone();
            let secret_clone = secret.clone();
            let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
                let mut ftp = ftp_connect_sync(&cfg_clone, &secret_clone)?;
                let _ = ftp.quit();
                Ok(())
            })
            .await
            .map_err(|e| OmniError::internal(format!("FTP 测试失败: {e}")))?;
            result.map_err(|e| OmniError::new(ErrorCode::Connection, e))?;
            Ok("FTP 连接成功".into())
        }
        other => Err(OmniError::invalid_input(format!(
            "Web 端暂不支持协议 {other} 的连接测试"
        ))),
    }
}

pub async fn file_save_connection(
    state: &ServerState,
    mut connection: Connection,
    secret: Option<String>,
) -> Result<Connection, OmniError> {
    connection.kind = ConnectionKind::File;
    ensure_file_connection_id(&mut connection);
    bind_file_connection_secret(&mut connection, secret)?;
    connection.updated_at = unix_secs(SystemTime::now());
    let storage = state.storage.lock().await;
    // 新建连接时打 creator 标签，标记创建设备
    if storage.get_connection(&connection.id)?.is_none() {
        ensure_creator_tag(&mut connection.tags, &crate::auth_cmds::current_device_name());
    }
    storage.save_connection(&connection)?;
    Ok(connection)
}

pub async fn file_test_connection(
    state: &ServerState,
    connection_id: String,
) -> Result<String, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        let home = local_home()?;
        return Ok(format!("本机可用：{}", home.display()));
    }
    let conn = load_file_connection(state, &connection_id)
        .await?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    file_test_connection_config(state, &conn, None).await
}

pub async fn file_local_temp_dir() -> Result<String, OmniError> {
    Ok(std::env::temp_dir().to_string_lossy().into_owned())
}
