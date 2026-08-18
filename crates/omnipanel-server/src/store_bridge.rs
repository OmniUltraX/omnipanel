//! 与桌面端共用 `omnipanel-store` 的元数据命令桥（Web 端）。
//!
//! 覆盖启动/侧栏热路径：连接表、模块开关、内置工具、HTTP 协议库、AI 模型配置、
//! SSH 隧道列表（进程内）等。复杂桌面专属能力仍走 ipc 软降级。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{
    ai_provider_key_ref, AppModule, AppModuleStatus, BuiltinToolCatalogEntry, BuiltinToolRecord,
    Connection, ConnectionKind, HttpCollection, HttpEnvironment, HttpHistoryEntry, SavedHttpRequest,
    Vault,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::state::ServerState;

/* -------------------- 连接（conn_*） -------------------- */

pub async fn conn_list(state: &ServerState) -> Result<Vec<Connection>, OmniError> {
    let storage = state.storage.lock().await;
    storage.list_connections()
}

pub async fn conn_save(
    state: &ServerState,
    mut connection: Connection,
) -> Result<Connection, OmniError> {
    let now = now_secs() as i64;
    if connection.id.trim().is_empty() {
        connection.id = format!("conn-{now}");
    }
    if connection.created_at == 0 {
        connection.created_at = now;
    }
    connection.updated_at = now;
    let storage = state.storage.lock().await;
    storage.save_connection(&connection)?;
    Ok(connection)
}

pub async fn conn_delete(state: &ServerState, id: String) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.delete_connection(&id)
}

/// Web 端连通性探测：SSH 解析配置即可；其它类型先返回成功（完整探测按模块命令）。
pub async fn conn_test(state: &ServerState, id: String) -> Result<String, OmniError> {
    let storage = state.storage.lock().await;
    let conn = storage
        .get_connection(&id)?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "连接不存在"))?;
    drop(storage);
    match conn.kind {
        ConnectionKind::Ssh => {
            let _ = crate::state::resolve_ssh_config(&conn)?;
            Ok("ok".to_string())
        }
        _ => Ok("ok".to_string()),
    }
}

/* -------------------- 模块 / 内置工具 -------------------- */

pub async fn app_module_list(state: &ServerState) -> Result<Vec<AppModule>, OmniError> {
    let storage = state.storage.lock().await;
    storage.app_module_list()
}

pub async fn app_module_set_status(
    state: &ServerState,
    key: String,
    status: String,
) -> Result<AppModule, OmniError> {
    let status = match status.as_str() {
        "open" => AppModuleStatus::Open,
        "closed" => AppModuleStatus::Closed,
        "disabled" => AppModuleStatus::Disabled,
        other => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                format!("未知模块状态: {other}"),
            ));
        }
    };
    let storage = state.storage.lock().await;
    storage.app_module_set_status(&key, status)
}

pub async fn builtin_tool_list(state: &ServerState) -> Result<Vec<BuiltinToolRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_list()
}

pub async fn builtin_tool_sync_catalog(
    state: &ServerState,
    entries: Vec<BuiltinToolCatalogEntry>,
) -> Result<(), OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_sync_catalog(&entries)
}

pub async fn builtin_tool_set_internal_enabled(
    state: &ServerState,
    tool_name: String,
    enabled: bool,
) -> Result<BuiltinToolRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_set_internal_enabled(&tool_name, enabled)
}

pub async fn builtin_tool_set_external_exposed(
    state: &ServerState,
    tool_name: String,
    exposed: bool,
) -> Result<BuiltinToolRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_set_external_exposed(&tool_name, exposed)
}

pub async fn builtin_tool_set_enabled(
    state: &ServerState,
    tool_name: String,
    enabled: bool,
) -> Result<BuiltinToolRecord, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_set_enabled(&tool_name, enabled)
}

pub async fn builtin_tool_audit_list(
    state: &ServerState,
    limit: Option<u32>,
) -> Result<Vec<omnipanel_store::BuiltinToolAuditRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.builtin_tool_audit_list(limit.unwrap_or(200))
}

/* -------------------- HTTP 协议实验室 -------------------- */

pub async fn http_list_requests(
    state: &ServerState,
    collection_id: Option<String>,
) -> Result<Vec<SavedHttpRequest>, String> {
    let storage = state.storage.lock().await;
    storage
        .http_list_requests(collection_id.as_deref())
        .map_err(|e| e.to_string())
}

pub async fn http_save_request(state: &ServerState, req: SavedHttpRequest) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_save_request(&req).map_err(|e| e.to_string())
}

pub async fn http_delete_request(state: &ServerState, id: String) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_delete_request(&id).map_err(|e| e.to_string())
}

pub async fn http_list_collections(state: &ServerState) -> Result<Vec<HttpCollection>, String> {
    let storage = state.storage.lock().await;
    storage.http_list_collections().map_err(|e| e.to_string())
}

pub async fn http_save_collection(state: &ServerState, col: HttpCollection) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_save_collection(&col).map_err(|e| e.to_string())
}

pub async fn http_delete_collection(state: &ServerState, id: String) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_delete_collection(&id).map_err(|e| e.to_string())
}

pub async fn http_list_environments(state: &ServerState) -> Result<Vec<HttpEnvironment>, String> {
    let storage = state.storage.lock().await;
    storage.http_list_environments().map_err(|e| e.to_string())
}

pub async fn http_save_environment(
    state: &ServerState,
    env: HttpEnvironment,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_save_environment(&env).map_err(|e| e.to_string())
}

pub async fn http_delete_environment(state: &ServerState, id: String) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_delete_environment(&id).map_err(|e| e.to_string())
}

pub async fn http_list_history(
    state: &ServerState,
    limit: i64,
) -> Result<Vec<HttpHistoryEntry>, String> {
    let storage = state.storage.lock().await;
    storage.http_list_history(limit).map_err(|e| e.to_string())
}

pub async fn http_add_history(state: &ServerState, entry: HttpHistoryEntry) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_add_history(&entry).map_err(|e| e.to_string())
}

pub async fn http_delete_history(state: &ServerState, id: String) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_delete_history(&id).map_err(|e| e.to_string())
}

pub async fn http_rename_history(
    state: &ServerState,
    id: String,
    label: String,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage
        .http_rename_history(&id, &label)
        .map_err(|e| e.to_string())
}

pub async fn http_clear_history(state: &ServerState) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage.http_clear_history().map_err(|e| e.to_string())
}

pub async fn http_clear_history_for_request(
    state: &ServerState,
    request_id: String,
) -> Result<(), String> {
    let storage = state.storage.lock().await;
    storage
        .http_clear_history_for_request(&request_id)
        .map_err(|e| e.to_string())
}

/* -------------------- AI 模型配置（~/.omnipd/ai/ai-models.json） -------------------- */

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiModelsFile {
    #[serde(default = "default_ai_models_version")]
    pub version: u32,
    #[serde(default)]
    pub providers: Vec<serde_json::Value>,
}

fn default_ai_models_version() -> u32 {
    1
}

fn ai_models_path() -> Result<PathBuf, String> {
    let dir = omnipanel_store::ai_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建 AI 配置目录失败: {e}"))?;
    Ok(dir.join("ai-models.json"))
}

pub async fn ai_models_load() -> Result<AiModelsFile, String> {
    let path = ai_models_path()?;
    if !path.exists() {
        return Ok(AiModelsFile::default());
    }
    let raw = fs::read_to_string(&path).map_err(|e| format!("读取 ai-models.json 失败: {e}"))?;
    if raw.trim().is_empty() {
        return Ok(AiModelsFile::default());
    }
    match serde_json::from_str::<AiModelsFile>(&raw) {
        Ok(mut file) => {
            for p in file.providers.iter_mut() {
                if let Some(obj) = p.as_object_mut() {
                    let id = obj
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    let key = obj
                        .get("apiKey")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string();
                    if !key.trim().is_empty() {
                        let _ = Vault::store(&ai_provider_key_ref(&id), key.trim());
                    }
                    obj.insert("apiKey".into(), serde_json::json!(""));
                    let has = Vault::get(&ai_provider_key_ref(&id))
                        .ok()
                        .is_some_and(|k| !k.is_empty());
                    obj.insert("hasApiKey".into(), serde_json::json!(has));
                }
            }
            Ok(file)
        }
        Err(e) => {
            tracing::warn!(error = %e, "解析 ai-models.json 失败，返回空配置");
            Ok(AiModelsFile::default())
        }
    }
}

pub async fn ai_models_save(file: AiModelsFile) -> Result<(), String> {
    let path = ai_models_path()?;
    let mut out = file;
    for p in out.providers.iter_mut() {
        if let Some(obj) = p.as_object_mut() {
            let id = obj
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string();
            if let Some(key) = obj.get("apiKey").and_then(|v| v.as_str()) {
                if !key.trim().is_empty() {
                    Vault::store(&ai_provider_key_ref(&id), key.trim())
                        .map_err(|e| format!("保存 API Key 到钥匙串失败: {}", e.message))?;
                    obj.insert("hasApiKey".into(), serde_json::json!(true));
                } else {
                    let has = Vault::get(&ai_provider_key_ref(&id))
                        .ok()
                        .is_some_and(|k| !k.is_empty())
                        || obj
                            .get("hasApiKey")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                    obj.insert("hasApiKey".into(), serde_json::json!(has));
                }
            }
            obj.insert("apiKey".into(), serde_json::json!(""));
        }
    }
    let raw = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| format!("写入 ai-models.json 失败: {e}"))
}

/// 前端按需从 Vault 取回提供商 API Key。
pub async fn ai_models_resolve_api_key(provider_id: String) -> Result<String, String> {
    let id = provider_id.trim();
    if id.is_empty() {
        return Err("provider_id 不能为空".into());
    }
    let key = Vault::get(&ai_provider_key_ref(id)).unwrap_or_default();
    if key.trim().is_empty() {
        return Err("未找到该提供商的 API Key，请重新填写并保存".into());
    }
    Ok(key)
}

/// 经服务端 HTTP 客户端拉取 `{baseUrl}/models`，避开浏览器 CORS。
pub async fn ai_models_fetch_list(
    base_url: String,
    api_key: String,
    api_standard: Option<String>,
) -> Result<Vec<omnipanel_ai::RemoteModelInfo>, String> {
    let root = base_url.trim().trim_end_matches('/');
    if root.is_empty() {
        return Err("Base URL 无效".into());
    }
    let proxy = crate::http_client::proxy_config();
    let client = crate::http_client::build_http_client_for_url(
        root,
        &proxy,
        std::time::Duration::from_secs(30),
    )
    .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    omnipanel_ai::fetch_provider_models(&client, root, &api_key, api_standard.as_deref())
        .await
        .map_err(|e| match e {
            omnipanel_ai::FetchModelsError::InvalidBaseUrl => "Base URL 无效".into(),
            omnipanel_ai::FetchModelsError::Http { status, body } => {
                if body.is_empty() {
                    format!("HTTP {status}")
                } else {
                    format!("HTTP {status}: {body}")
                }
            }
            omnipanel_ai::FetchModelsError::Network(message) => message,
            omnipanel_ai::FetchModelsError::Parse(cause) => format!("模型列表响应无法解析: {cause}"),
        })
}

/* -------------------- SSH 隧道（进程内） -------------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnelInfo {
    pub id: String,
    pub connection_id: String,
    pub tunnel_type: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    pub status: String,
    pub started_at: u64,
}

pub type SshTunnelMap = Arc<Mutex<HashMap<String, SshTunnelInfo>>>;

pub fn new_ssh_tunnel_map() -> SshTunnelMap {
    Arc::new(Mutex::new(HashMap::new()))
}

pub async fn ssh_list_tunnels(state: &ServerState) -> Result<Vec<SshTunnelInfo>, OmniError> {
    let tunnels = state.ssh_tunnels.lock().await;
    Ok(tunnels.values().cloned().collect())
}

pub async fn ssh_create_tunnel(
    state: &ServerState,
    connection_id: String,
    tunnel_type: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<SshTunnelInfo, OmniError> {
    // Web 端暂不真正拉起系统 ssh 端口转发进程，只登记元数据，避免面板报错。
    let id = format!("tun-{}-{}", now_secs(), local_port);
    let info = SshTunnelInfo {
        id: id.clone(),
        connection_id,
        tunnel_type,
        local_port,
        remote_host,
        remote_port,
        status: "recorded".to_string(),
        started_at: now_secs(),
    };
    state.ssh_tunnels.lock().await.insert(id, info.clone());
    Ok(info)
}

pub async fn ssh_close_tunnel(state: &ServerState, id: String) -> Result<(), OmniError> {
    state.ssh_tunnels.lock().await.remove(&id);
    Ok(())
}

/* -------------------- SSH 密钥（~/.ssh） -------------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInfo {
    pub name: String,
    pub key_type: String,
    pub path: String,
    pub fingerprint: String,
    pub comment: String,
}

pub async fn ssh_list_keys() -> Result<Vec<SshKeyInfo>, OmniError> {
    let Some(home) = dirs_next_home() else {
        return Ok(vec![]);
    };
    let ssh_dir = home.join(".ssh");
    if !ssh_dir.is_dir() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    let entries = fs::read_dir(&ssh_dir).map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取 ~/.ssh 失败").with_cause(e.to_string())
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.ends_with(".pub")
            || name == "config"
            || name == "known_hosts"
            || name == "authorized_keys"
            || name.starts_with('.')
        {
            continue;
        }
        let Ok(pem) = fs::read_to_string(&path) else {
            continue;
        };
        if !pem.contains("PRIVATE KEY") {
            continue;
        }
        let key_type = if name.contains("ed25519") {
            "ed25519"
        } else if name.contains("rsa") {
            "rsa"
        } else if name.contains("ecdsa") {
            "ecdsa"
        } else {
            "openssh"
        }
        .to_string();
        out.push(SshKeyInfo {
            name,
            key_type,
            path: path.to_string_lossy().to_string(),
            fingerprint: String::new(),
            comment: String::new(),
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 从 ~/.ssh/config 同步主机：Web 端先返回空列表（避免面板红字），后续可接解析。
pub async fn ssh_sync_config_hosts() -> Result<Vec<serde_json::Value>, OmniError> {
    Ok(vec![])
}

/* -------------------- 其它启动热路径 -------------------- */

pub async fn set_proxy_config(config: serde_json::Value) -> Result<(), String> {
    crate::http_client::set_proxy_config_value(config)
}

pub async fn resource_set_system_tag(
    state: &ServerState,
    kind: String,
    resource_id: String,
    key: String,
    value: String,
) -> Result<(), String> {
    use omnipanel_store::TaggableKind;
    let kind = TaggableKind::parse(&kind).map_err(|e| e.user_message())?;
    let storage = state.storage.lock().await;
    storage
        .resource_set_system_key(kind, &resource_id, &key, &value)
        .map_err(|e| e.user_message())
}

/// Docker 侧栏缓存：读 `~/.omnipd/docker/sidebar-cache.json`（无文件则空 map）。
pub async fn docker_load_sidebar_cache() -> Result<serde_json::Value, String> {
    let path = omnipanel_store::docker_sidebar_cache_path().map_err(|e| e.to_string())?;
    if !path.is_file() {
        return Ok(serde_json::json!({ "connections": {} }));
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    if content.trim().is_empty() {
        return Ok(serde_json::json!({ "connections": {} }));
    }
    let value: serde_json::Value =
        serde_json::from_str(&content).map_err(|e| e.to_string())?;
    if value.get("connections").is_some() {
        Ok(value)
    } else {
        Ok(serde_json::json!({ "connections": {} }))
    }
}

pub async fn docker_patch_sidebar_cache(
    _connection_id: String,
    _entry: serde_json::Value,
) -> Result<(), String> {
    Ok(())
}

pub async fn docker_remove_sidebar_cache(_connection_id: String) -> Result<(), String> {
    Ok(())
}

pub async fn docker_list_sidebar_cache_page(
    _connection_id: String,
    category: String,
    offset: u32,
    limit: u32,
) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "category": category,
        "total": 0,
        "offset": offset,
        "limit": limit,
        "images": [],
        "containers": [],
        "networks": [],
        "volumes": [],
        "refreshedAt": null,
        "error": null
    }))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn dirs_next_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}


/* ==================== db_sql_files_load / db_sql_files_save ==================== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSqlFileNode {
    pub id: String,
    #[serde(rename = "type")]
    pub r#type: String,
    pub name: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub conn_id: Option<String>,
    #[serde(default)]
    pub database: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbSqlFilesFile {
    #[serde(default = "default_db_files_version")]
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<DbSqlFileNode>,
}

fn default_db_files_version() -> u32 {
    1
}

fn db_sql_files_path() -> Result<PathBuf, OmniError> {
    Ok(omnipanel_store::module_dir("database")?.join("db-sql-files.json"))
}

pub async fn db_sql_files_load(_state: &ServerState) -> Result<DbSqlFilesFile, OmniError> {
    let path = db_sql_files_path()?;
    if !path.exists() {
        return Ok(DbSqlFilesFile::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|e| OmniError::internal(format!("failed to read db-sql-files.json: {e}")))?;
    if raw.trim().is_empty() {
        return Ok(DbSqlFilesFile::default());
    }
    match serde_json::from_str::<DbSqlFilesFile>(&raw) {
        Ok(file) => Ok(file),
        Err(e) => {
            tracing::warn!(
                "[db_sql_files_load] failed to parse db-sql-files.json, falling back to empty: {e}"
            );
            Ok(DbSqlFilesFile::default())
        }
    }
}

pub async fn db_sql_files_save(
    _state: &ServerState,
    file: DbSqlFilesFile,
) -> Result<(), OmniError> {
    let path = db_sql_files_path()?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&file)
        .map_err(|e| OmniError::internal(format!("failed to serialize db-sql-files.json: {e}")))?;
    fs::write(&tmp, json)
        .map_err(|e| OmniError::internal(format!("failed to write db-sql-files.json.tmp: {e}")))?;
    fs::rename(&tmp, &path)
        .map_err(|e| OmniError::internal(format!("failed to replace db-sql-files.json: {e}")))?;
    Ok(())
}

/* ==================== db_tree_chart_files_load / db_tree_chart_files_save ==================== */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbTreeChartFileNode {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub document: Option<String>,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbTreeChartFilesFile {
    #[serde(default = "default_db_files_version")]
    pub version: u32,
    #[serde(default)]
    pub nodes: Vec<DbTreeChartFileNode>,
}

fn tree_chart_files_index_path() -> Result<PathBuf, OmniError> {
    Ok(omnipanel_store::module_dir("database")?.join("db-tree-chart-files.json"))
}

fn tree_chart_files_content_dir() -> Result<PathBuf, OmniError> {
    let dir = omnipanel_store::module_dir("database")?.join("tree-chart-files");
    fs::create_dir_all(&dir)
        .map_err(|e| OmniError::internal(format!("failed to create tree-chart-files dir: {e}")))?;
    Ok(dir)
}

fn tree_chart_sanitize_file_stem(id: &str) -> String {
    id.chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect()
}

fn tree_chart_content_file_path(content_dir: &std::path::Path, id: &str) -> PathBuf {
    content_dir.join(format!("{}.ctr", tree_chart_sanitize_file_stem(id)))
}

fn tree_chart_read_document_from_disk(content_dir: &std::path::Path, id: &str) -> Option<String> {
    let path = tree_chart_content_file_path(content_dir, id);
    fs::read_to_string(&path)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
}

fn tree_chart_write_document_to_disk(
    content_dir: &std::path::Path,
    id: &str,
    document: &str,
) -> Result<(), OmniError> {
    let path = tree_chart_content_file_path(content_dir, id);
    let tmp = path.with_extension("ctr.tmp");
    fs::write(&tmp, document).map_err(|e| {
        OmniError::internal(format!("failed to write .ctr file ({}): {e}", path.display()))
    })?;
    fs::rename(&tmp, &path).map_err(|e| {
        OmniError::internal(format!("failed to replace .ctr file ({}): {e}", path.display()))
    })?;
    Ok(())
}

fn tree_chart_remove_document_from_disk(content_dir: &std::path::Path, id: &str) {
    let path = tree_chart_content_file_path(content_dir, id);
    let _ = fs::remove_file(path);
}

fn tree_chart_resolve_node_document(content_dir: &std::path::Path, node: &mut DbTreeChartFileNode) {
    if let Some(document) = node.document.as_ref().filter(|raw| !raw.trim().is_empty()) {
        let _ = tree_chart_write_document_to_disk(content_dir, &node.id, document);
        return;
    }
    if let Some(document) = tree_chart_read_document_from_disk(content_dir, &node.id) {
        node.document = Some(document);
    }
}

fn tree_chart_hydrate_nodes_from_content_dir(
    content_dir: &std::path::Path,
    nodes: &mut [DbTreeChartFileNode],
) {
    for node in nodes.iter_mut() {
        tree_chart_resolve_node_document(content_dir, node);
    }
}

fn tree_chart_prune_orphan_content_files(
    content_dir: &std::path::Path,
    nodes: &[DbTreeChartFileNode],
) {
    let entries = match fs::read_dir(content_dir) {
        Ok(entries) => entries,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("ctr") {
            continue;
        }
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or_default()
            .to_string();
        let still_exists = nodes
            .iter()
            .any(|node| tree_chart_sanitize_file_stem(&node.id) == stem);
        if !still_exists {
            tree_chart_remove_document_from_disk(content_dir, &stem);
        }
    }
}

fn tree_chart_recover_from_content_dir_only(
    content_dir: &std::path::Path,
) -> Result<DbTreeChartFilesFile, OmniError> {
    let entries = match fs::read_dir(content_dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(DbTreeChartFilesFile::default()),
    };

    let mut nodes = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("ctr") {
            continue;
        }
        let document = match fs::read_to_string(&path) {
            Ok(raw) if !raw.trim().is_empty() => raw,
            _ => continue,
        };
        let stem = path
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("untitled")
            .to_string();
        let metadata = fs::metadata(&path).ok();
        let updated_at = metadata
            .and_then(|meta| meta.modified().ok())
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_else(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|duration| duration.as_millis() as i64)
                    .unwrap_or(0)
            });
        nodes.push(DbTreeChartFileNode {
            id: stem.clone(),
            name: format!("{stem}.ctr"),
            document: Some(document),
            parent_id: None,
            updated_at,
        });
    }

    nodes.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(DbTreeChartFilesFile { version: 1, nodes })
}

pub async fn db_tree_chart_files_load(
    _state: &ServerState,
) -> Result<DbTreeChartFilesFile, OmniError> {
    let index_path = tree_chart_files_index_path()?;
    let content_dir = tree_chart_files_content_dir()?;

    if !index_path.exists() {
        return tree_chart_recover_from_content_dir_only(&content_dir);
    }

    let raw = fs::read_to_string(&index_path).map_err(|e| {
        OmniError::internal(format!("failed to read db-tree-chart-files.json: {e}"))
    })?;
    if raw.trim().is_empty() {
        return tree_chart_recover_from_content_dir_only(&content_dir);
    }

    let mut file = match serde_json::from_str::<DbTreeChartFilesFile>(&raw) {
        Ok(file) => file,
        Err(e) => {
            tracing::warn!(
                "[db_tree_chart_files_load] failed to parse db-tree-chart-files.json, recovering from content dir: {e}"
            );
            return tree_chart_recover_from_content_dir_only(&content_dir);
        }
    };

    tree_chart_hydrate_nodes_from_content_dir(&content_dir, &mut file.nodes);
    Ok(file)
}

pub async fn db_tree_chart_files_save(
    _state: &ServerState,
    file: DbTreeChartFilesFile,
) -> Result<(), OmniError> {
    let index_path = tree_chart_files_index_path()?;
    let content_dir = tree_chart_files_content_dir()?;

    for node in &file.nodes {
        if let Some(document) = node.document.as_ref().filter(|raw| !raw.trim().is_empty()) {
            tree_chart_write_document_to_disk(&content_dir, &node.id, document)?;
        }
    }

    tree_chart_prune_orphan_content_files(&content_dir, &file.nodes);

    let tmp = index_path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(&file).map_err(|e| {
        OmniError::internal(format!("failed to serialize db-tree-chart-files.json: {e}"))
    })?;
    fs::write(&tmp, json).map_err(|e| {
        OmniError::internal(format!("failed to write db-tree-chart-files.json.tmp: {e}"))
    })?;
    fs::rename(&tmp, &index_path).map_err(|e| {
        OmniError::internal(format!("failed to replace db-tree-chart-files.json: {e}"))
    })?;
    Ok(())
}

/* ==================== ai_list_sessions / ai_list_session_traces ==================== */

pub async fn ai_list_sessions(
    state: &ServerState,
    source: Option<String>,
) -> Result<Vec<omnipanel_store::AiSessionRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.ai_session_list(source.as_deref())
}

pub async fn ai_list_session_traces(
    state: &ServerState,
    session_id: String,
) -> Result<Vec<omnipanel_store::AiTraceRecord>, OmniError> {
    let storage = state.storage.lock().await;
    storage.ai_trace_list(&session_id)
}