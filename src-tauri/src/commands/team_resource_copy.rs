//! 把当前团队里的一条资源复制进账号所属的另一支团队快照。
//! 只改目标团队的加密快照，不覆盖本机数据库。

use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_assistant::{
    TEAM_MODULES_LATEST_LEAF, pull_team_sync_json, push_team_sync_json,
    validate_modules_bundle_json,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    ConnectionKind, SYNC_KIND_MODULES, Vault, active_team_scope, db_password_ref,
    ensure_origin_for_creator, ssh_password_ref,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use specta::Type;
use tauri::State;

use crate::commands::assistant::build_auth_context;
use crate::commands::auth::{
    auth_device_identity, auth_get_me, decode_sync_team_payload, resolve_sync_team,
};
use crate::commands::client_sync_modules::{
    ClientSyncConnectionItem, ClientSyncDatabaseItem, ClientSyncModulesBundle,
    ClientSyncVaultSecret, collect_connection_vault_secrets,
};
use crate::state::AppState;

#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamCopyResourceRequest {
    pub token: String,
    #[specta(type = f64)]
    pub target_team_id: i64,
    pub kind: String,
    pub resource_id: String,
    /// 自定义面板快照。其他类型从本机库读取，含凭据。
    #[serde(default)]
    pub snapshot_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TeamCopyResourceResult {
    pub resource_id: String,
}

fn new_copy_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("copy-{nanos:x}")
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn retarget_ref(reference: &str, old_id: &str, new_id: &str) -> String {
    match reference.strip_suffix(old_id) {
        Some(prefix) if !old_id.is_empty() => format!("{prefix}{new_id}"),
        _ => reference.to_string(),
    }
}

fn stamp_tags(tags: &mut Vec<String>) {
    if let Ok(device_id) = crate::commands::auth::current_device_id() {
        ensure_origin_for_creator(
            tags,
            &device_id,
            &crate::commands::auth::current_device_name(),
        );
    }
}

/// 复制一条资源到另一支自己的团队。两边快照随后各自变化。
#[tauri::command]
#[specta::specta]
pub async fn team_copy_resource_to_team(
    state: State<'_, AppState>,
    request: TeamCopyResourceRequest,
) -> Result<TeamCopyResourceResult, OmniError> {
    let token = request.token.trim();
    if token.is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录，无法分享到团队"));
    }
    if request.target_team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    if active_team_scope().parse::<i64>().ok() == Some(request.target_team_id) {
        return Err(OmniError::invalid_input("请选择另一支团队"));
    }
    if request.resource_id.trim() == "docker-local" {
        return Err(OmniError::invalid_input(
            "本地 Docker 用连接上的分享开关，不会复制进团队快照",
        ));
    }

    let identity = auth_device_identity().await?;
    let me = auth_get_me(state.clone(), token.to_string()).await?;
    let team = resolve_sync_team(Some(request.target_team_id), &me)?;
    let team_key = omnipanel_store::load_sync_team_key(team.id)?.ok_or_else(|| {
        OmniError::new(
            ErrorCode::Auth,
            "还没有这支团队的同步密钥，请先打开该团队或导入密钥",
        )
    })?;
    let auth = build_auth_context(&state, token, &identity.device_id).await?;

    let mut bundle = match pull_team_sync_json(&auth, team.id, TEAM_MODULES_LATEST_LEAF).await? {
        Some((_, body)) => {
            let plaintext = decode_sync_team_payload(&me, &team, SYNC_KIND_MODULES, &body)?;
            validate_modules_bundle_json(&plaintext)?;
            serde_json::from_slice(&plaintext).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "团队快照无法解析").with_cause(e.to_string())
            })?
        }
        None => serde_json::from_value(json!({
            "schemaVersion": 1,
            "kind": "workspace-modules",
            "updatedAt": now_ms(),
        }))
        .map_err(|e| {
            OmniError::new(ErrorCode::Internal, "无法创建空团队快照").with_cause(e.to_string())
        })?,
    };

    let new_id = insert_resource(&state, &mut bundle, &request).await?;
    bundle.updated_at = now_ms();
    let plaintext = serde_json::to_vec(&bundle).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化团队快照失败").with_cause(e.to_string())
    })?;
    validate_modules_bundle_json(&plaintext)?;
    let body =
        omnipanel_store::encrypt_sync_team_blob(&team_key, team.id, SYNC_KIND_MODULES, &plaintext)?;
    push_team_sync_json(&auth, team.id, TEAM_MODULES_LATEST_LEAF, &body).await?;
    Ok(TeamCopyResourceResult {
        resource_id: new_id,
    })
}

async fn insert_resource(
    state: &AppState,
    bundle: &mut ClientSyncModulesBundle,
    request: &TeamCopyResourceRequest,
) -> Result<String, OmniError> {
    match request.kind.trim() {
        "ssh-connection" => insert_ssh(state, bundle, request.resource_id.trim()).await,
        "database-connection" => insert_database(state, bundle, request.resource_id.trim()),
        "knowledge-entry" => insert_knowledge(state, bundle, request.resource_id.trim()).await,
        "http-request" => insert_http(state, bundle, request.resource_id.trim()).await,
        "custom-panel" => insert_panel(bundle, request.snapshot_json.as_deref()),
        other => Err(OmniError::invalid_input(format!(
            "不支持分享这种资源: {other}"
        ))),
    }
}

async fn insert_ssh(
    state: &AppState,
    bundle: &mut ClientSyncModulesBundle,
    resource_id: &str,
) -> Result<String, OmniError> {
    let storage = state.storage.lock().await;
    let conn = storage
        .get_connection(resource_id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "SSH 连接不存在"))?;
    if conn.kind != ConnectionKind::Ssh {
        return Err(OmniError::invalid_input("连接不是 SSH"));
    }
    let new_id = new_copy_id();
    let mut secrets = Vec::new();
    collect_connection_vault_secrets(&conn, &mut secrets);
    let password = Vault::get(&ssh_password_ref(&conn.id)).ok();
    drop(storage);

    let mut connection = conn;
    connection.id = new_id.clone();
    connection.credential_ref = None;
    stamp_tags(&mut connection.tags);
    for secret in secrets {
        let reference = retarget_ref(&secret.reference, resource_id, &new_id);
        push_secret(bundle, reference, secret.value);
    }
    bundle.connections.push(ClientSyncConnectionItem {
        connection,
        secret: password.filter(|s| !s.is_empty()),
    });
    Ok(new_id)
}

fn insert_database(
    state: &AppState,
    bundle: &mut ClientSyncModulesBundle,
    resource_id: &str,
) -> Result<String, OmniError> {
    let conn = state
        .db_connections
        .get_with_secret(resource_id)
        .map_err(|e| {
            OmniError::new(ErrorCode::Storage, "读取数据库连接失败").with_cause(e.to_string())
        })?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "数据库连接不存在"))?;
    let new_id = new_copy_id();
    let secret = Vault::get(&db_password_ref(resource_id))
        .ok()
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let password = conn.password.trim();
            if password.is_empty() {
                None
            } else {
                Some(password.to_string())
            }
        });
    if let Some(value) = secret.clone() {
        push_secret(bundle, db_password_ref(&new_id), value);
    }
    let mut connection = conn;
    connection.id = new_id.clone();
    connection.password.clear();
    connection.has_password = secret.is_some();
    stamp_tags(&mut connection.tags);
    bundle
        .database_connections
        .push(ClientSyncDatabaseItem { connection, secret });
    Ok(new_id)
}

async fn insert_knowledge(
    state: &AppState,
    bundle: &mut ClientSyncModulesBundle,
    resource_id: &str,
) -> Result<String, OmniError> {
    let storage = state.storage.lock().await;
    let mut entry = storage
        .list_knowledge(None, None)?
        .into_iter()
        .find(|item| item.id == resource_id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "知识条目不存在"))?;
    drop(storage);
    let new_id = new_copy_id();
    entry.id = new_id.clone();
    stamp_tags(&mut entry.tags);
    bundle.knowledge.push(entry);
    Ok(new_id)
}

async fn insert_http(
    state: &AppState,
    bundle: &mut ClientSyncModulesBundle,
    resource_id: &str,
) -> Result<String, OmniError> {
    let storage = state.storage.lock().await;
    let mut request = storage
        .http_list_requests(None)?
        .into_iter()
        .find(|item| item.id == resource_id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "HTTP 请求不存在"))?;
    drop(storage);
    let new_id = new_copy_id();
    request.id = new_id.clone();
    bundle.http_requests.push(request);
    Ok(new_id)
}

fn insert_panel(
    bundle: &mut ClientSyncModulesBundle,
    snapshot_json: Option<&str>,
) -> Result<String, OmniError> {
    let raw = snapshot_json.unwrap_or("").trim();
    if raw.is_empty() {
        return Err(OmniError::invalid_input("缺少自定义面板内容"));
    }
    let snapshot: Value = serde_json::from_str(raw)
        .map_err(|e| OmniError::invalid_input("自定义面板内容无效").with_cause(e.to_string()))?;
    let label = snapshot
        .get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("自定义面板")
        .to_string();
    let widgets = snapshot
        .get("widgets")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let new_id = format!("custom:{}", new_copy_id());
    let mut root: Value = bundle
        .custom_panels_json
        .as_deref()
        .and_then(|text| serde_json::from_str(text).ok())
        .unwrap_or_else(|| json!({ "customPanels": {}, "deletedIds": [] }));
    let panels = root
        .as_object_mut()
        .and_then(|obj| obj.get_mut("customPanels"))
        .and_then(|v| v.as_object_mut())
        .ok_or_else(|| OmniError::new(ErrorCode::Internal, "团队面板数据无效"))?;
    panels.insert(
        new_id.clone(),
        json!({
            "id": new_id,
            "label": label,
            "createdAt": now_ms(),
            "widgets": widgets,
        }),
    );
    bundle.custom_panels_json = Some(root.to_string());
    Ok(new_id)
}

fn push_secret(bundle: &mut ClientSyncModulesBundle, reference: String, value: String) {
    if reference.is_empty() || value.is_empty() {
        return;
    }
    if bundle
        .vault_secrets
        .iter()
        .any(|item| item.reference == reference)
    {
        return;
    }
    bundle
        .vault_secrets
        .push(ClientSyncVaultSecret { reference, value });
}
