//! Cursor 桌面版：读 `state.vscdb` 登录，拉模型目录和套餐用量，把一次补全交回编排。
//!
//! 目录和用量走 `api2` 的 Connect JSON。对话走同一台主机上 IDE 仍在用的
//! `ChatService/StreamUnifiedChatWithToolsIdempotent`：OmniPanel 工具放进
//! `mcp_tools`，服务端用 `call_mcp_tool` 把调用交回来，编排器执行后再把结果放进下一轮。
//! `get_mcp_tools` 只回工具定义，不交给用户审批。Cursor 自带的改文件不执行。
//! token 只留在进程内存，不写回 Cursor 的数据库。

use std::io::Read;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::{Stream, StreamExt};
use reqwest::Client;
use rusqlite::OpenFlags;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::ir::{StopReason, StreamEvent};
use crate::provider::AiProvider;
use crate::types::{ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, Usage};

use super::{
    AgentSource, AgentSourceCard, AgentSourceCreditPackage, AgentSourceCredits, AgentSourceModel,
};

pub const SOURCE_ID: &str = "cursor";
const TITLE: &str = "Cursor";
const API_BASE: &str = "https://api2.cursor.sh";
const AGENT_BASE: &str = "https://agentn.global.api5.cursor.sh";
const AGENT_PATH: &str = "/agent.v1.AgentService/Run";
const CHAT_PATH: &str = "/aiserver.v1.ChatService/StreamUnifiedChatWithToolsIdempotentSSE";
const BIDI_APPEND_PATH: &str = "/aiserver.v1.BidiService/BidiAppend";
/// `ClientSideToolV2.CALL_MCP_TOOL`。参数里带着 OmniPanel 工具名和 JSON 参数。
const TOOL_CALL_MCP: u64 = 49;
/// `ClientSideToolV2.GET_MCP_TOOLS`。模型先要定义时，当场把已广告的工具回回去。
const TOOL_GET_MCP: u64 = 63;
/// `ClientSideToolV2.RUN_TERMINAL_COMMAND_V2`。映射成 `omni_terminal_exec`。
const TOOL_TERMINAL: u64 = 15;
/// `cursor-agent` CLI 版本。AgentService 不认 IDE 的 `3.x` 版本号。
/// 这是当前仍被接受的 CLI 串；可用 `CURSOR_AGENT_CLIENT_VERSION` 覆盖。
#[allow(dead_code)]
const CLI_CLIENT_VERSION: &str = "cli-2026.07.08-0c04a8a";
/// `UserMessage.mode`：Ask。没有 OmniPanel 工具时用，避免 Cursor 去跑自己的 shell。
const ASK_MODE: u64 = 2;
/// `UserMessage.mode`：Agent。有工具时用，服务端才会发出 MCP 调用。
#[allow(dead_code)]
const AGENT_MODE: u64 = 1;
const MCP_PROVIDER: &str = "omnipanel";
const AUTH_CLIENT_ID: &str = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";
const FALLBACK_VERSION: &str = "2.6.22";

struct Memory {
    credential: Option<Credential>,
    models: Vec<AgentSourceModel>,
    catalog_source: String,
    error: Option<String>,
    credits: Option<AgentSourceCredits>,
}

pub struct CursorSource {
    memory: Mutex<Memory>,
}

impl CursorSource {
    pub fn new() -> Self {
        let mut memory = Memory {
            credential: None,
            models: Vec::new(),
            catalog_source: "none".into(),
            error: None,
            credits: None,
        };
        let _ = hydrate_from_disk(&mut memory);
        Self {
            memory: Mutex::new(memory),
        }
    }
}

impl Default for CursorSource {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSource for CursorSource {
    fn id(&self) -> &str {
        SOURCE_ID
    }

    fn title(&self) -> &str {
        TITLE
    }

    fn card(&self) -> AgentSourceCard {
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        card_from(&memory)
    }

    fn refresh(&self) -> Result<AgentSourceCard, String> {
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        if let Err(err) = load_credential(&mut memory.credential) {
            memory.error = Some(err);
            memory.models.clear();
            memory.catalog_source = "none".into();
            memory.credits = None;
            return Ok(card_from(&memory));
        }
        let Some(credential) = memory.credential.clone() else {
            memory.models.clear();
            memory.catalog_source = "none".into();
            memory.credits = None;
            memory.error = Some("未找到 Cursor 登录".into());
            return Ok(card_from(&memory));
        };
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        match refresh_blocking(&client, &credential) {
            Ok(outcome) => {
                memory.credential = Some(outcome.credential.clone());
                match outcome.models {
                    Ok(models) => {
                        memory.models = models;
                        memory.catalog_source = "live".into();
                        memory.error = None;
                        let _ = save_catalog_cache(&outcome.credential, &memory.models);
                    }
                    Err(err) => {
                        memory.error = Some(err);
                        apply_saved_catalog(&mut memory, &outcome.credential);
                    }
                }
                memory.credits = Some(outcome.credits.unwrap_or_else(|err| AgentSourceCredits {
                    error: Some(err),
                    ..AgentSourceCredits::default()
                }));
            }
            Err(err) => {
                memory.error = Some(err);
                memory.credits = None;
                apply_saved_catalog(&mut memory, &credential);
            }
        }
        Ok(card_from(&memory))
    }

    fn upstream_origin(&self) -> &'static str {
        AGENT_BASE
    }

    fn open_provider(&self, model_id: &str, client: Client) -> Result<Box<dyn AiProvider>, String> {
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        load_credential(&mut memory.credential)?;
        let credential = memory
            .credential
            .clone()
            .ok_or_else(|| "Cursor 未登录".to_string())?;
        drop(memory);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let credential = runtime.block_on(ensure_fresh(&client, &credential))?;
        Ok(Box::new(CursorProvider {
            credential,
            model_id: model_id.to_string(),
        }))
    }
}

fn card_from(memory: &Memory) -> AgentSourceCard {
    let signed_in = memory.credential.is_some();
    AgentSourceCard {
        id: SOURCE_ID.into(),
        title: TITLE.into(),
        signed_in,
        account: memory.credential.as_ref().map(|c| c.email.clone()),
        token_expires_at_ms: memory.credential.as_ref().map(|c| c.expires_at_ms),
        catalog_source: memory.catalog_source.clone(),
        error: memory.error.clone(),
        models: if signed_in {
            memory.models.clone()
        } else {
            Vec::new()
        },
        credits: if signed_in {
            memory.credits.clone()
        } else {
            None
        },
    }
}

fn apply_saved_catalog(memory: &mut Memory, credential: &Credential) {
    if let Some(saved) = load_catalog_cache(&credential.email) {
        memory.models = saved;
        memory.catalog_source = "saved".into();
    } else {
        memory.models.clear();
        memory.catalog_source = "none".into();
    }
}

fn hydrate_from_disk(memory: &mut Memory) {
    if let Err(err) = load_credential(&mut memory.credential) {
        memory.error = Some(err);
        return;
    }
    let Some(credential) = memory.credential.clone() else {
        return;
    };
    if let Some(saved) = load_catalog_cache(&credential.email) {
        memory.models = saved;
        memory.catalog_source = "saved".into();
    }
}

#[derive(Debug, Clone)]
struct Credential {
    access_token: String,
    refresh_token: String,
    expires_at_ms: i64,
    email: String,
    machine_id: String,
    mac_machine_id: String,
}

struct RefreshOutcome {
    credential: Credential,
    models: Result<Vec<AgentSourceModel>, String>,
    credits: Result<AgentSourceCredits, String>,
}

fn refresh_blocking(client: &Client, credential: &Credential) -> Result<RefreshOutcome, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let credential = ensure_fresh(client, credential).await?;
        let models = fetch_models(client, &credential).await;
        let credits = fetch_usage(client, &credential).await;
        Ok(RefreshOutcome {
            credential,
            models,
            credits,
        })
    })
}

fn state_db_path() -> Option<PathBuf> {
    if let Ok(override_path) = std::env::var("CURSOR_STATE_DB") {
        let path = PathBuf::from(override_path);
        if path.is_file() {
            return Some(path);
        }
    }
    let relative = Path::new("Cursor")
        .join("User")
        .join("globalStorage")
        .join("state.vscdb");
    if let Ok(appdata) = std::env::var("APPDATA") {
        let path = Path::new(&appdata).join(&relative);
        if path.is_file() {
            return Some(path);
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        for base in [
            Path::new(&home).join("Library").join("Application Support"),
            Path::new(&home).join(".config"),
        ] {
            let path = base.join(&relative);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    None
}

fn load_credential(slot: &mut Option<Credential>) -> Result<(), String> {
    let Some(path) = state_db_path() else {
        *slot = None;
        return Ok(());
    };
    let uri = format!(
        "file:{}?mode=ro&immutable=1",
        path.display().to_string().replace('\\', "/")
    );
    let conn = rusqlite::Connection::open_with_flags(
        &uri,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| format!("无法读取 Cursor 登录库: {e}"))?;
    let access = read_item(&conn, "cursorAuth/accessToken")?;
    let Some(access) = access.filter(|value| !value.is_empty()) else {
        *slot = None;
        return Ok(());
    };
    let refresh = read_item(&conn, "cursorAuth/refreshToken")?.unwrap_or_default();
    let email = read_item(&conn, "cursorAuth/cachedEmail")?
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "Cursor".into());
    let machine_id = read_item(&conn, "storage.serviceMachineId")?.unwrap_or_default();
    let mac_machine_id = read_item(&conn, "storage.macMachineId")?
        .filter(|value| !value.is_empty())
        .or(read_item(&conn, "telemetry.macMachineId")?.filter(|value| !value.is_empty()))
        .unwrap_or_default();
    *slot = Some(Credential {
        expires_at_ms: jwt_expiry_ms(&access),
        access_token: access,
        refresh_token: refresh,
        email,
        machine_id,
        mac_machine_id,
    });
    Ok(())
}

fn read_item(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
    let mut stmt = conn
        .prepare("SELECT value FROM ItemTable WHERE key = ?1")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params![key])
        .map_err(|e| e.to_string())?;
    let Some(row) = rows.next().map_err(|e| e.to_string())? else {
        return Ok(None);
    };
    let value: rusqlite::types::Value = row.get(0).map_err(|e| e.to_string())?;
    Ok(match value {
        rusqlite::types::Value::Text(text) => Some(text),
        rusqlite::types::Value::Blob(bytes) => String::from_utf8(bytes).ok(),
        _ => None,
    })
}

fn access_jwt(token: &str) -> &str {
    token
        .split_once("::")
        .map(|(_, jwt)| jwt)
        .filter(|jwt| !jwt.is_empty())
        .unwrap_or(token)
}

fn decode_jwt_payload(payload: &str) -> Option<Vec<u8>> {
    if let Ok(bytes) = URL_SAFE_NO_PAD.decode(payload) {
        return Some(bytes);
    }
    let mut padded = payload.to_string();
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    base64::engine::general_purpose::URL_SAFE
        .decode(padded)
        .ok()
}

fn jwt_expiry_ms(token: &str) -> i64 {
    let Some(payload) = access_jwt(token).split('.').nth(1) else {
        return 0;
    };
    let Some(bytes) = decode_jwt_payload(payload) else {
        return 0;
    };
    let Ok(json) = serde_json::from_slice::<Value>(&bytes) else {
        return 0;
    };
    json.get("exp")
        .and_then(|v| v.as_i64())
        .map(|seconds| seconds * 1000)
        .unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

async fn ensure_fresh(client: &Client, credential: &Credential) -> Result<Credential, String> {
    if credential.expires_at_ms > now_ms() + 60_000 && !credential.access_token.is_empty() {
        return Ok(credential.clone());
    }
    if credential.refresh_token.is_empty() {
        return Err("Cursor 登录已过期，请在桌面应用中重新登录".into());
    }
    let response = client
        .post(format!("{API_BASE}/oauth/token"))
        .json(&json!({
            "grant_type": "refresh_token",
            "client_id": AUTH_CLIENT_ID,
            "refresh_token": credential.refresh_token,
        }))
        .send()
        .await
        .map_err(|e| format!("刷新 Cursor 登录失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let body: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() || body.get("shouldLogout").and_then(|v| v.as_bool()) == Some(true) {
        return Err("Cursor 登录已失效，请在桌面应用中重新登录".into());
    }
    let access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if access.is_empty() {
        return Err("刷新 Cursor 登录没有返回 access_token".into());
    }
    let mut next = credential.clone();
    next.expires_at_ms = jwt_expiry_ms(&access);
    next.access_token = access;
    Ok(next)
}

async fn fetch_models(
    client: &Client,
    credential: &Credential,
) -> Result<Vec<AgentSourceModel>, String> {
    let document = post_json(client, credential, "/aiserver.v1.AiService/AvailableModels").await?;
    parse_models(&document)
}

pub(crate) fn parse_models(document: &Value) -> Result<Vec<AgentSourceModel>, String> {
    let rows = document
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "Cursor 目录里没有 models".to_string())?;
    let mut models = Vec::new();
    for row in rows {
        let id = row
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| row.get("serverModelName").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        let display = row
            .get("clientDisplayName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty() && *s != "default")
            .unwrap_or(if id == "default" { "Auto" } else { id.as_str() })
            .to_string();
        models.push(AgentSourceModel {
            id,
            name: display,
            ..AgentSourceModel::default()
        });
    }
    if models.is_empty() {
        return Err("Cursor 目录解析后没有可用模型".into());
    }
    Ok(models)
}

async fn fetch_usage(
    client: &Client,
    credential: &Credential,
) -> Result<AgentSourceCredits, String> {
    let usage = post_json(
        client,
        credential,
        "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
    )
    .await?;
    let plan = post_json(
        client,
        credential,
        "/aiserver.v1.DashboardService/GetPlanInfo",
    )
    .await
    .unwrap_or(Value::Null);
    parse_usage(&usage, &plan)
}

pub(crate) fn parse_usage(usage: &Value, plan: &Value) -> Result<AgentSourceCredits, String> {
    let plan_usage = usage
        .get("planUsage")
        .filter(|v| v.is_object())
        .ok_or_else(|| "Cursor 用量响应里没有 planUsage".to_string())?;
    let limit = plan_usage
        .get("limit")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let included = plan_usage
        .get("includedSpend")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    let remain_cents = (limit - included).max(0.0);
    let plan_name = plan
        .pointer("/planInfo/planName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("Cursor");
    let cycle = usage
        .get("billingCycleEnd")
        .and_then(|v| v.as_str())
        .and_then(|text| text.parse::<i64>().ok())
        .filter(|ms| *ms > 0)
        .map(|ms| {
            chrono::DateTime::from_timestamp_millis(ms)
                .map(|time| time.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| ms.to_string())
        });
    Ok(AgentSourceCredits {
        total: remain_cents / 100.0,
        packages: vec![AgentSourceCreditPackage {
            name: format!("{plan_name} 包含用量"),
            remain: remain_cents / 100.0,
            size: limit / 100.0,
            unlimited: false,
        }],
        cycle_reset_time: cycle,
        ..AgentSourceCredits::default()
    })
}

async fn post_json(client: &Client, credential: &Credential, path: &str) -> Result<Value, String> {
    let response = client
        .post(format!("{API_BASE}{path}"))
        .headers(api_headers(credential))
        .header("content-type", "application/json")
        .body("{}")
        .send()
        .await
        .map_err(|e| format!("请求 Cursor 失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Cursor 请求失败 ({status})"));
    }
    serde_json::from_str(&text).map_err(|e| format!("Cursor 响应不是 JSON: {e}"))
}

fn api_headers(credential: &Credential) -> reqwest::header::HeaderMap {
    let token = access_jwt(&credential.access_token);
    let request_id = random_uuid();
    let mut headers = reqwest::header::HeaderMap::new();
    insert_header(&mut headers, "authorization", &format!("Bearer {token}"));
    insert_header(&mut headers, "connect-protocol-version", "1");
    insert_header(&mut headers, "user-agent", "connect-es/1.6.1");
    insert_header(
        &mut headers,
        "x-cursor-checksum",
        &cursor_checksum_header(
            token,
            &credential.machine_id,
            &credential.mac_machine_id,
            now_ms(),
        ),
    );
    insert_header(&mut headers, "x-cursor-client-version", &client_version());
    insert_header(&mut headers, "x-cursor-client-type", "ide");
    insert_header(&mut headers, "x-cursor-client-os", client_os());
    insert_header(&mut headers, "x-cursor-client-arch", client_arch());
    insert_header(
        &mut headers,
        "x-cursor-client-os-version",
        &client_os_version(),
    );
    insert_header(&mut headers, "x-cursor-client-device-type", "desktop");
    insert_header(&mut headers, "x-cursor-timezone", "UTC");
    insert_header(&mut headers, "x-ghost-mode", "false");
    insert_header(&mut headers, "x-new-onboarding-completed", "false");
    insert_header(&mut headers, "x-session-id", &uuid_v5_dns(token));
    insert_header(&mut headers, "x-request-id", &request_id);
    insert_header(
        &mut headers,
        "x-amzn-trace-id",
        &format!("Root={request_id}"),
    );
    insert_header(&mut headers, "x-client-key", &sha256_hex(token.as_bytes()));
    insert_header(&mut headers, "x-cursor-config-version", &random_uuid());
    headers
}

fn insert_header(headers: &mut reqwest::header::HeaderMap, name: &'static str, value: &str) {
    let name = reqwest::header::HeaderName::from_static(name);
    let Ok(value) = reqwest::header::HeaderValue::from_str(value) else {
        return;
    };
    headers.insert(name, value);
}

fn client_os() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

fn client_arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}

fn client_os_version() -> String {
    if let Ok(version) = std::env::var("CURSOR_OS_VERSION") {
        if !version.is_empty() {
            return version;
        }
    }
    if cfg!(windows) {
        "10.0.0".into()
    } else {
        "unknown".into()
    }
}

fn client_version() -> String {
    if let Ok(version) = std::env::var("CURSOR_CLIENT_VERSION") {
        if !version.is_empty() {
            return version;
        }
    }
    for path in install_package_jsons() {
        if let Ok(text) = std::fs::read_to_string(path) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                if let Some(version) = json.get("version").and_then(|v| v.as_str()) {
                    if !version.is_empty() {
                        return version.to_string();
                    }
                }
            }
        }
    }
    FALLBACK_VERSION.into()
}

fn client_commit() -> String {
    if let Ok(commit) = std::env::var("CURSOR_CLIENT_COMMIT") {
        if !commit.is_empty() {
            return commit;
        }
    }
    for path in install_package_jsons() {
        let product = path.with_file_name("product.json");
        if let Ok(text) = std::fs::read_to_string(product) {
            if let Ok(json) = serde_json::from_str::<Value>(&text) {
                if let Some(commit) = json.get("commit").and_then(|v| v.as_str()) {
                    if !commit.is_empty() {
                        return commit.to_string();
                    }
                }
            }
        }
    }
    String::new()
}

fn install_package_jsons() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        paths.push(
            Path::new(&local)
                .join("Programs")
                .join("cursor")
                .join("resources")
                .join("app")
                .join("package.json"),
        );
    }
    paths
}

fn cache_path() -> Option<PathBuf> {
    let dir = omnipanel_store::ai_config_dir().ok()?.join("agent-sources");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("cursor.json"))
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCache {
    account_key: String,
    models: Vec<AgentSourceModel>,
}

fn save_catalog_cache(credential: &Credential, models: &[AgentSourceModel]) -> Result<(), String> {
    let path = cache_path().ok_or_else(|| "无法写入模型目录缓存".to_string())?;
    let payload = CatalogCache {
        account_key: credential.email.clone(),
        models: models.to_vec(),
    };
    std::fs::write(
        path,
        serde_json::to_string(&payload).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn load_catalog_cache(account: &str) -> Option<Vec<AgentSourceModel>> {
    let path = cache_path()?;
    let text = std::fs::read_to_string(path).ok()?;
    let parsed: CatalogCache = serde_json::from_str(&text).ok()?;
    if parsed.account_key != account || parsed.models.is_empty() {
        return None;
    }
    Some(parsed.models)
}

struct CursorProvider {
    credential: Credential,
    model_id: String,
}

#[async_trait]
impl AiProvider for CursorProvider {
    fn name(&self) -> &str {
        SOURCE_ID
    }

    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            id: self.model_id.clone(),
            name: self.model_id.clone(),
            provider: SOURCE_ID.into(),
            context_window: None,
        }]
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let mut stream = self.chat_stream(request).await?;
        let mut content = String::new();
        while let Some(event) = stream.next().await {
            if let StreamEvent::ContentDelta { text } = event? {
                content.push_str(&text);
            }
        }
        Ok(ChatResponse {
            message: ChatMessage {
                role: Role::Assistant,
                content,
                tool_call_id: None,
                tool_calls: None,
                name: None,
            },
            usage: Usage::default(),
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>> {
        let tools = request.tools.clone().unwrap_or_default();
        let token = access_jwt(&self.credential.access_token).to_string();
        let checksum = cursor_checksum_header(
            &token,
            &self.credential.machine_id,
            &self.credential.mac_machine_id,
            now_ms(),
        );
        let version = client_version();
        let commit = client_commit();
        let payload = build_chat_payload(&request, &self.model_id, &tools);
        let (tx, rx) = tokio::sync::mpsc::channel(16);
        tokio::spawn(async move {
            if let Err(err) = drive_chat_turn(
                token,
                checksum,
                version,
                commit,
                idempotent_encryption_key(&random_uuid()),
                payload,
                tools,
                tx.clone(),
            )
            .await
            {
                let _ = tx.send(Err(err)).await;
            }
        });
        Ok(Box::pin(tokio_stream::wrappers::ReceiverStream::new(rx)))
    }
}

fn agent_tls_config() -> std::sync::Arc<tokio_rustls::rustls::ClientConfig> {
    static CONFIG: std::sync::OnceLock<std::sync::Arc<tokio_rustls::rustls::ClientConfig>> =
        std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = tokio_rustls::rustls::RootCertStore::empty();
            roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
            let provider = tokio_rustls::rustls::crypto::ring::default_provider();
            let mut config =
                tokio_rustls::rustls::ClientConfig::builder_with_provider(provider.into())
                    .with_safe_default_protocol_versions()
                    .expect("rustls protocol versions")
                    .with_root_certificates(roots)
                    .with_no_client_auth();
            config.alpn_protocols = vec![b"h2".to_vec()];
            std::sync::Arc::new(config)
        })
        .clone()
}

fn agent_host() -> &'static str {
    AGENT_BASE
        .trim_start_matches("https://")
        .trim_end_matches('/')
}

fn chat_host() -> &'static str {
    API_BASE
        .trim_start_matches("https://")
        .trim_end_matches('/')
}

fn cursor_h2_request(
    host: &str,
    path: &str,
    token: &str,
    checksum: &str,
    client_version: &str,
    client_commit: &str,
    encryption_key: &str,
    idempotency_key: &str,
    session_id: &str,
    client_key: &str,
    content_type: &str,
) -> Result<http::Request<()>> {
    let request_id = random_uuid();
    let mut builder = http::Request::builder()
        .method(http::Method::POST)
        .uri(format!("https://{host}{path}"))
        .header("authorization", format!("Bearer {token}"))
        .header("connect-accept-encoding", "gzip")
        .header("connect-protocol-version", "1")
        .header("content-type", content_type)
        .header("user-agent", "connect-es/1.6.1")
        .header("x-cursor-checksum", checksum)
        .header("x-cursor-client-type", "ide")
        .header("x-cursor-client-version", client_version);
    if !client_commit.is_empty() {
        builder = builder.header("x-cursor-client-commit", client_commit);
    }
    builder
        .header("x-cursor-client-os", client_os())
        .header("x-cursor-client-arch", client_arch())
        .header("x-cursor-client-os-version", client_os_version())
        .header("x-cursor-client-device-type", "desktop")
        .header("x-cursor-timezone", "UTC")
        .header("x-ghost-mode", "false")
        .header("x-new-onboarding-completed", "false")
        .header("x-session-id", session_id)
        .header("x-request-id", request_id.clone())
        .header("x-idempotency-key", idempotency_key)
        .header("x-idempotent-encryption-key", encryption_key)
        .header("x-amzn-trace-id", format!("Root={request_id}"))
        .header("x-client-key", client_key)
        .body(())
        .map_err(|err| anyhow::anyhow!("Cursor 对话请求无效: {err}"))
}

async fn post_h2_unary(
    host: &str,
    request: http::Request<()>,
    body: Vec<u8>,
) -> Result<(http::StatusCode, Vec<u8>)> {
    let tcp = tokio::net::TcpStream::connect((host, 443))
        .await
        .map_err(|err| anyhow::anyhow!("连接 Cursor 失败: {err}"))?;
    tcp.set_nodelay(true).ok();
    let connector = tokio_rustls::TlsConnector::from(agent_tls_config());
    let server_name = tokio_rustls::rustls::pki_types::ServerName::try_from(host)
        .map_err(|_| anyhow::anyhow!("Cursor 主机名无效"))?
        .to_owned();
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|err| anyhow::anyhow!("Cursor TLS 失败: {err}"))?;
    let (send_request, connection) = h2::client::handshake(tls)
        .await
        .map_err(|err| anyhow::anyhow!("Cursor HTTP/2 握手失败: {err}"))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut send_request = send_request
        .ready()
        .await
        .map_err(|err| anyhow::anyhow!("Cursor HTTP/2 未就绪: {err}"))?;
    let mut request = request;
    if let Ok(len) = http::HeaderValue::from_str(&body.len().to_string()) {
        request
            .headers_mut()
            .insert(http::header::CONTENT_LENGTH, len);
    }
    let response = h2_unary(&mut send_request, request, body).await?;
    let status = response.status();
    let mut raw = Vec::new();
    let mut stream = response.into_body();
    while let Some(chunk) = stream.data().await.transpose().ok().flatten() {
        raw.extend_from_slice(&chunk);
        if raw.len() > 4096 {
            break;
        }
    }
    Ok((status, raw))
}

async fn h2_unary(
    send_request: &mut h2::client::SendRequest<bytes::Bytes>,
    request: http::Request<()>,
    body: Vec<u8>,
) -> Result<http::Response<h2::RecvStream>> {
    let (response, mut stream) = send_request
        .send_request(request, false)
        .map_err(|err| anyhow::anyhow!("Cursor 请求发送失败: {err}"))?;
    stream
        .send_data(bytes::Bytes::from(body), true)
        .map_err(|err| anyhow::anyhow!("Cursor 请求体发送失败: {err}"))?;
    tokio::time::timeout(Duration::from_secs(10), response)
        .await
        .map_err(|_| anyhow::anyhow!("Cursor 追加对话超时"))?
        .map_err(|err| anyhow::anyhow!("Cursor 请求失败: {err}"))
}

async fn drive_chat_turn(
    token: String,
    checksum: String,
    client_version: String,
    client_commit: String,
    encryption_key: String,
    payload: Vec<u8>,
    tools: Vec<crate::types::ToolDef>,
    tx: tokio::sync::mpsc::Sender<Result<StreamEvent>>,
) -> Result<()> {
    let host = chat_host();
    let tcp = tokio::net::TcpStream::connect((host, 443))
        .await
        .map_err(|err| anyhow::anyhow!("连接 Cursor 对话失败: {err}"))?;
    tcp.set_nodelay(true).ok();
    let connector = tokio_rustls::TlsConnector::from(agent_tls_config());
    let server_name = tokio_rustls::rustls::pki_types::ServerName::try_from(host)
        .map_err(|_| anyhow::anyhow!("Cursor 对话主机名无效"))?
        .to_owned();
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|err| anyhow::anyhow!("Cursor 对话 TLS 失败: {err}"))?;
    let (send_request, connection) = h2::client::handshake(tls)
        .await
        .map_err(|err| anyhow::anyhow!("Cursor 对话 HTTP/2 握手失败: {err}"))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut send_request = send_request
        .ready()
        .await
        .map_err(|err| anyhow::anyhow!("Cursor 对话 HTTP/2 未就绪: {err}"))?;
    let bidi_id = random_uuid();
    let idempotency_key = random_uuid();
    let session_id = uuid_v5_dns(&token);
    let client_key = sha256_hex(token.as_bytes());
    let opener = idempotent_chunk(&payload, &idempotency_key, 0);
    let sse_request = cursor_h2_request(
        host,
        CHAT_PATH,
        &token,
        &checksum,
        &client_version,
        &client_commit,
        &encryption_key,
        &idempotency_key,
        &session_id,
        &client_key,
        "application/connect+proto",
    )?;
    let (response, mut sse_send) = send_request
        .send_request(sse_request, false)
        .map_err(|err| anyhow::anyhow!("Cursor 对话发送失败: {err}"))?;
    sse_send
        .send_data(
            bytes::Bytes::from(connect_frame(&bidi_request_id(&bidi_id))),
            true,
        )
        .map_err(|err| anyhow::anyhow!("Cursor 对话发送失败: {err}"))?;
    let append = bidi_append(&bidi_id, 0, &encode_hex(&opener));
    let append_request = cursor_h2_request(
        host,
        BIDI_APPEND_PATH,
        &token,
        &checksum,
        &client_version,
        &client_commit,
        &encryption_key,
        &idempotency_key,
        &session_id,
        &client_key,
        "application/proto",
    )?;
    let append_host = host.to_string();
    let append_task =
        tokio::spawn(async move { post_h2_unary(&append_host, append_request, append).await });
    let reply_idempotency_key = idempotency_key.clone();
    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let mut seq = 1_u64;
    let sender = tokio::spawn(async move {
        let mut replies_closed = false;
        loop {
            let reply = tokio::select! {
                _ = &mut stop_rx => break,
                reply = reply_rx.recv(), if !replies_closed => reply,
            };
            let Some(reply) = reply else {
                replies_closed = true;
                continue;
            };
            let body = connect_frame(&bidi_append(&bidi_id, seq, &encode_hex(&reply)));
            seq += 1;
            let Ok(request) = cursor_h2_request(
                host,
                BIDI_APPEND_PATH,
                &token,
                &checksum,
                &client_version,
                &client_commit,
                &encryption_key,
                &reply_idempotency_key,
                &session_id,
                &client_key,
                "application/connect+proto",
            ) else {
                return;
            };
            if h2_unary(&mut send_request, request, body).await.is_err() {
                return;
            }
        }
    });

    let response = match tokio::time::timeout(Duration::from_secs(20), response).await {
        Ok(Ok(response)) => response,
        Ok(Err(err)) => return Err(anyhow::anyhow!("Cursor 对话失败: {err}")),
        Err(_) => {
            let append = append_task
                .await
                .unwrap_or_else(|err| Err(anyhow::anyhow!("Cursor 追加对话任务失败: {err}")));
            let detail = match append {
                Ok((status, raw)) => {
                    let message = cursor_error_text(&raw)
                        .unwrap_or_else(|| brief(&String::from_utf8_lossy(&raw)));
                    format!("{status} {message}")
                }
                Err(err) => err.to_string(),
            };
            return Err(anyhow::anyhow!("Cursor 对话响应超时，追加结果: {detail}"));
        }
    };
    let status = response.status();
    let mut body = response.into_body();
    let mut pending = Vec::new();
    let mut saw_text = false;
    let mut failed = false;
    let mut hold_for_schema = false;
    let started = tokio::time::Instant::now();
    let deadline = Duration::from_secs(45);
    loop {
        if started.elapsed() > deadline {
            break;
        }
        let budget = if hold_for_schema {
            hold_for_schema = false;
            Duration::from_secs(25)
        } else if saw_text {
            Duration::from_secs(6)
        } else {
            Duration::from_secs(60)
        };
        let next = match tokio::time::timeout(budget, body.data()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) | Err(_) => break,
        };
        let chunk = match next {
            Ok(chunk) => chunk,
            Err(err) => {
                failed = true;
                let _ = tx.send(Err(anyhow::anyhow!("Cursor 流中断: {err}"))).await;
                break;
            }
        };
        let _ = body.flow_control().release_capacity(chunk.len());
        pending.extend_from_slice(&chunk);
        if !forward_chat_events(
            &mut pending,
            &tools,
            &idempotency_key,
            &mut seq,
            &reply_tx,
            &mut saw_text,
            &mut hold_for_schema,
            &tx,
        )
        .await
        {
            failed = true;
            break;
        }
    }
    drop(reply_tx);
    let _ = stop_tx.send(());
    let _ = sender.await;
    let append_result = append_task
        .await
        .unwrap_or_else(|err| Err(anyhow::anyhow!("Cursor 追加对话任务失败: {err}")));
    if !saw_text {
        match append_result {
            Err(err) => {
                let _ = tx.send(Err(err)).await;
                return Ok(());
            }
            Ok((append_status, raw)) if !append_status.is_success() => {
                let message = cursor_error_text(&raw)
                    .unwrap_or_else(|| brief(&String::from_utf8_lossy(&raw)));
                let _ = tx
                    .send(Err(anyhow::anyhow!(
                        "Cursor 追加对话失败 {append_status}: {message}"
                    )))
                    .await;
                return Ok(());
            }
            _ => {}
        }
    }
    if failed {
        return Ok(());
    }
    if saw_text {
        let _ = tx
            .send(Ok(StreamEvent::Done {
                stop_reason: StopReason::EndTurn,
            }))
            .await;
    } else if status.is_success() {
        let _ = tx.send(Err(anyhow::anyhow!("Cursor 没有返回文本"))).await;
    } else {
        let message = cursor_error_text(&pending)
            .unwrap_or_else(|| brief(&String::from_utf8_lossy(&pending)));
        let _ = tx
            .send(Err(anyhow::anyhow!("Cursor 对话失败 {status}: {message}")))
            .await;
    }
    Ok(())
}

async fn forward_chat_events(
    pending: &mut Vec<u8>,
    tools: &[crate::types::ToolDef],
    idempotency_key: &str,
    seq: &mut u64,
    reply_tx: &tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    saw_text: &mut bool,
    hold_for_schema: &mut bool,
    tx: &tokio::sync::mpsc::Sender<Result<StreamEvent>>,
) -> bool {
    let (events, replies) = drain_chat_frames(pending, tools, idempotency_key, seq);
    if !replies.is_empty() {
        *hold_for_schema = true;
        for reply in replies {
            if reply_tx.send(reply).is_err() {
                return false;
            }
        }
    }
    for item in events {
        let stop = match &item {
            Ok(StreamEvent::ContentDelta { .. } | StreamEvent::ReasoningDelta { .. }) => {
                *saw_text = true;
                false
            }
            Ok(StreamEvent::ToolCall { .. }) => {
                *saw_text = true;
                true
            }
            Ok(StreamEvent::Done { .. }) | Err(_) => true,
            _ => false,
        };
        if tx
            .send(item.map_err(|err| anyhow::anyhow!(err)))
            .await
            .is_err()
        {
            return false;
        }
        if stop {
            return false;
        }
    }
    true
}

fn build_chat_payload(
    request: &ChatRequest,
    model_id: &str,
    tools: &[crate::types::ToolDef],
) -> Vec<u8> {
    let mut inner = Vec::new();
    for message in encode_chat_conversation(request) {
        proto_bytes(&mut inner, 1, &message);
    }
    let mut model = Vec::new();
    proto_string(&mut model, 1, model_id);
    proto_bytes(&mut inner, 5, &model);
    proto_varint_field(&mut inner, 22, 1);
    proto_string(&mut inner, 23, &random_uuid());
    proto_varint_field(&mut inner, 45, 1);
    if !tools.is_empty() {
        proto_varint_field(&mut inner, 27, 1);
        proto_varint_field(&mut inner, 29, TOOL_CALL_MCP as i64);
        proto_varint_field(&mut inner, 29, TOOL_GET_MCP as i64);
        proto_varint_field(&mut inner, 29, TOOL_TERMINAL as i64);
        proto_varint_field(&mut inner, 46, 2);
        for tool in encode_chat_mcp_tools(tools) {
            proto_bytes(&mut inner, 34, &tool);
        }
    }
    let mut wrapped = Vec::new();
    proto_bytes(&mut wrapped, 1, &inner);
    wrapped
}

fn encode_chat_mcp_tools(tools: &[crate::types::ToolDef]) -> Vec<Vec<u8>> {
    tools
        .iter()
        .map(|tool| {
            let mut item = Vec::new();
            proto_string(&mut item, 1, &tool.function.name);
            proto_string(&mut item, 2, &tool.function.description);
            let schema =
                serde_json::to_string(&tool.function.parameters).unwrap_or_else(|_| "{}".into());
            proto_string(&mut item, 3, &schema);
            proto_string(&mut item, 4, MCP_PROVIDER);
            item
        })
        .collect()
}

fn idempotent_chunk(inner: &[u8], key: &str, seq: u64) -> Vec<u8> {
    let mut chunk = Vec::new();
    proto_bytes(&mut chunk, 1, inner);
    proto_string(&mut chunk, 4, key);
    proto_varint_field(&mut chunk, 5, seq as i64);
    chunk
}

fn idempotent_encryption_key(seed: &str) -> String {
    let raw = Sha256::digest(seed.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(raw)
}

fn encode_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn bidi_request_id(id: &str) -> Vec<u8> {
    let mut message = Vec::new();
    proto_string(&mut message, 1, id);
    message
}

fn bidi_append(id: &str, seq: u64, data_hex: &str) -> Vec<u8> {
    let mut message = Vec::new();
    proto_string(&mut message, 1, data_hex);
    proto_bytes(&mut message, 2, &bidi_request_id(id));
    proto_varint_field(&mut message, 3, seq as i64);
    message
}

fn encode_chat_conversation(request: &ChatRequest) -> Vec<Vec<u8>> {
    let mut outputs = std::collections::HashMap::<String, (String, String)>::new();
    for message in &request.messages {
        if message.role != Role::Tool {
            continue;
        }
        let id = message
            .tool_call_id
            .clone()
            .unwrap_or_else(|| message.name.clone().unwrap_or_default());
        if id.is_empty() {
            continue;
        }
        outputs.insert(
            id,
            (
                message.name.clone().unwrap_or_default(),
                message.content.clone(),
            ),
        );
    }
    let mut system = String::new();
    let mut out = Vec::new();
    let mut used_system = false;
    for message in &request.messages {
        match message.role {
            Role::System => {
                let body = message.content.trim();
                if body.is_empty() {
                    continue;
                }
                if !system.is_empty() {
                    system.push_str("\n\n");
                }
                system.push_str(body);
            }
            Role::User => {
                let mut text = message.content.trim().to_string();
                if !used_system && !system.is_empty() {
                    text = format!("{system}\n\n{text}");
                    used_system = true;
                }
                if !text.is_empty() {
                    out.push(chat_turn(1, &text, &[]));
                }
            }
            Role::Assistant => {
                let mut results = Vec::new();
                if let Some(calls) = &message.tool_calls {
                    for call in calls {
                        let (name, content) = outputs
                            .get(&call.id)
                            .cloned()
                            .unwrap_or_else(|| (call.function.name.clone(), String::new()));
                        results.push(chat_tool_result(
                            &call.id,
                            &name,
                            &call.function.arguments,
                            &content,
                        ));
                    }
                }
                let text = message.content.trim();
                if text.is_empty() && results.is_empty() {
                    continue;
                }
                out.push(chat_turn(2, text, &results));
            }
            Role::Tool => {}
        }
    }
    if out.is_empty() && !system.is_empty() {
        out.push(chat_turn(1, &system, &[]));
    }
    out
}

fn chat_turn(kind: i64, text: &str, results: &[Vec<u8>]) -> Vec<u8> {
    let mut message = Vec::new();
    proto_string(&mut message, 1, text);
    proto_varint_field(&mut message, 2, kind);
    proto_string(&mut message, 13, &random_uuid());
    for result in results {
        proto_bytes(&mut message, 18, result);
    }
    message
}

fn chat_tool_result(id: &str, name: &str, args: &str, content: &str) -> Vec<u8> {
    let mut result = Vec::new();
    proto_string(&mut result, 1, id);
    proto_string(&mut result, 2, name);
    proto_string(&mut result, 4, args);
    proto_string(&mut result, 7, content);
    result
}

fn drain_chat_frames(
    pending: &mut Vec<u8>,
    tools: &[crate::types::ToolDef],
    idempotency_key: &str,
    seq: &mut u64,
) -> (Vec<Result<StreamEvent, String>>, Vec<Vec<u8>>) {
    let mut out = Vec::new();
    let mut replies = Vec::new();
    while pending.len() >= 5 {
        let flags = pending[0];
        let len = u32::from_be_bytes([pending[1], pending[2], pending[3], pending[4]]) as usize;
        if pending.len() < 5 + len {
            break;
        }
        let mut payload = pending[5..5 + len].to_vec();
        pending.drain(..5 + len);
        if flags & 0x01 != 0 {
            match gunzip_bytes(&payload) {
                Some(plain) => payload = plain,
                None => {
                    out.push(Err("Cursor 响应解压失败".into()));
                    continue;
                }
            }
        }
        if flags & 0x02 != 0 {
            if let Some(message) = cursor_error_text(&payload) {
                out.push(Err(message));
            } else if out.is_empty() && replies.is_empty() {
                out.push(Ok(StreamEvent::Done {
                    stop_reason: StopReason::EndTurn,
                }));
            }
            break;
        }
        let Some(body) = unwrap_chat_response(&payload) else {
            continue;
        };
        match decode_chat_payload(&body, tools) {
            ChatDecoded::Events(events) => out.extend(events),
            ChatDecoded::Reply(frame) => {
                replies.push(idempotent_chunk(&frame, idempotency_key, *seq));
                *seq += 1;
            }
        }
    }
    (out, replies)
}

enum ChatDecoded {
    Events(Vec<Result<StreamEvent, String>>),
    Reply(Vec<u8>),
}

fn unwrap_chat_response(payload: &[u8]) -> Option<Vec<u8>> {
    let mut chunk = None;
    let mut ack = false;
    for field in walk_proto(payload) {
        match field {
            ProtoField::Varint { field: 4, .. } => ack = true,
            ProtoField::Bytes { field: 1, value } => chunk = Some(value),
            _ => {}
        }
    }
    if ack {
        return chunk;
    }
    if let Some(value) = &chunk {
        let nested = walk_proto(value);
        let tool_enum = nested
            .iter()
            .any(|field| matches!(field, ProtoField::Varint { field: 1, .. }));
        let nested_message = nested
            .iter()
            .any(|field| matches!(field, ProtoField::Bytes { field: 1 | 2, .. }));
        if !tool_enum && nested_message {
            return Some(value.clone());
        }
    }
    Some(payload.to_vec())
}

fn decode_chat_payload(payload: &[u8], tools: &[crate::types::ToolDef]) -> ChatDecoded {
    let mut events = Vec::new();
    let mut call = None;
    for field in walk_proto(payload) {
        let ProtoField::Bytes { field, value } = field else {
            continue;
        };
        match field {
            2 => {
                if let Some(text) = proto_string_field(&value, 1) {
                    events.push(Ok(StreamEvent::ContentDelta { text }));
                }
                if let Some(thinking) = nested_string_field(&value, 25, 1) {
                    events.push(Ok(StreamEvent::ReasoningDelta { text: thinking }));
                }
            }
            1 => call = Some(value),
            _ => {}
        }
    }
    if let Some(call) = call {
        return decode_client_tool_call(&call, tools);
    }
    ChatDecoded::Events(events)
}

fn decode_client_tool_call(call: &[u8], tools: &[crate::types::ToolDef]) -> ChatDecoded {
    let mut tool = 0_u64;
    let mut call_id = String::new();
    let mut name = String::new();
    let mut mcp = None;
    let mut get_mcp = None;
    let mut terminal = None;
    for field in walk_proto(call) {
        match field {
            ProtoField::Varint { field: 1, value } => tool = value,
            ProtoField::Bytes { field: 3, value } => {
                call_id = String::from_utf8(value).unwrap_or_default();
            }
            ProtoField::Bytes { field: 9, value } => {
                name = String::from_utf8(value).unwrap_or_default();
            }
            ProtoField::Bytes { field: 62, value } => mcp = Some(value),
            ProtoField::Bytes { field: 72, value } => get_mcp = Some(value),
            ProtoField::Bytes { field: 23, value } => terminal = Some(value),
            _ => {}
        }
    }
    if tool == TOOL_GET_MCP {
        let args = get_mcp.unwrap_or_default();
        return ChatDecoded::Reply(mcp_schema_reply(&call_id, &args, tools));
    }
    if tool == TOOL_CALL_MCP {
        if let Some(args) = mcp.as_deref() {
            if let Some(event) = mcp_call_event(args, &call_id, &name) {
                return ChatDecoded::Events(vec![Ok(event)]);
            }
        }
    }
    if tool == TOOL_TERMINAL {
        if let Some(args) = terminal.as_deref() {
            if let Some(command) = proto_string_field(args, 1) {
                if tools
                    .iter()
                    .any(|tool| tool.function.name == "omni_terminal_exec")
                {
                    return ChatDecoded::Events(vec![Ok(StreamEvent::ToolCall {
                        id: if call_id.is_empty() {
                            random_uuid()
                        } else {
                            call_id
                        },
                        name: "omni_terminal_exec".into(),
                        arguments: serde_json::json!({ "command": command }).to_string(),
                    })]);
                }
            }
        }
    }
    if tool == 0 {
        return ChatDecoded::Events(Vec::new());
    }
    ChatDecoded::Events(vec![Err(
        "Cursor 试图调用自己的工具。这一轮只把 OmniPanel 工具交回编排执行".into(),
    )])
}

fn mcp_call_event(args: &[u8], call_id: &str, fallback_name: &str) -> Option<StreamEvent> {
    let mut tool_name = None;
    let mut tool_args = None;
    for field in walk_proto(args) {
        if let ProtoField::Bytes { field, value } = field {
            match field {
                2 => tool_name = String::from_utf8(value).ok(),
                3 => tool_args = Some(decode_protobuf_value(&value, 0)),
                _ => {}
            }
        }
    }
    let name = tool_name
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| fallback_name.to_string());
    if name.is_empty() {
        return None;
    }
    let arguments = tool_args
        .unwrap_or(serde_json::Value::Object(serde_json::Map::new()))
        .to_string();
    Some(StreamEvent::ToolCall {
        id: if call_id.is_empty() {
            random_uuid()
        } else {
            call_id.to_string()
        },
        name,
        arguments,
    })
}

fn mcp_schema_reply(call_id: &str, args: &[u8], tools: &[crate::types::ToolDef]) -> Vec<u8> {
    let mut server = None;
    let mut tool_name = None;
    let mut pattern = None;
    for field in walk_proto(args) {
        if let ProtoField::Bytes { field, value } = field {
            let Ok(text) = String::from_utf8(value) else {
                continue;
            };
            match field {
                1 => server = Some(text),
                2 => tool_name = Some(text),
                3 => pattern = Some(text),
                _ => {}
            }
        }
    }
    let listed: Vec<serde_json::Value> = tools
        .iter()
        .filter(|tool| {
            if let Some(server) = server.as_deref() {
                if !server.is_empty() && server != MCP_PROVIDER {
                    return false;
                }
            }
            if let Some(name) = tool_name.as_deref() {
                if !name.is_empty() && tool.function.name != name {
                    return false;
                }
            }
            if let Some(pattern) = pattern.as_deref() {
                if !pattern.is_empty() && !tool.function.name.contains(pattern) {
                    return false;
                }
            }
            true
        })
        .map(|tool| {
            serde_json::json!({
                "server": MCP_PROVIDER,
                "name": tool.function.name,
                "description": tool.function.description,
                "parameters": tool.function.parameters,
            })
        })
        .collect();
    let content = serde_json::to_string(&listed).unwrap_or_else(|_| "[]".into());
    let mut result = Vec::new();
    proto_string(&mut result, 1, &content);
    let mut message = Vec::new();
    proto_varint_field(&mut message, 1, TOOL_GET_MCP as i64);
    proto_string(&mut message, 35, call_id);
    proto_bytes(&mut message, 74, &result);
    let mut wrapped = Vec::new();
    proto_bytes(&mut wrapped, 2, &message);
    wrapped
}

fn proto_string_field(buf: &[u8], wanted: u64) -> Option<String> {
    for field in walk_proto(buf) {
        if let ProtoField::Bytes { field, value } = field {
            if field == wanted {
                let text = String::from_utf8(value).ok()?;
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
    }
    None
}

fn nested_string_field(buf: &[u8], outer: u64, inner: u64) -> Option<String> {
    for field in walk_proto(buf) {
        if let ProtoField::Bytes { field, value } = field {
            if field == outer {
                return proto_string_field(&value, inner);
            }
        }
    }
    None
}

struct AgentExecReply {
    tool_defs: Vec<Vec<u8>>,
    cwd: String,
}

#[allow(dead_code)]
async fn drive_agent_turn(
    token: String,
    client_version: String,
    frames: Vec<Vec<u8>>,
    exec: AgentExecReply,
    tx: tokio::sync::mpsc::Sender<Result<StreamEvent>>,
) -> Result<()> {
    let host = agent_host();
    let tcp = tokio::net::TcpStream::connect((host, 443))
        .await
        .map_err(|err| anyhow::anyhow!("连接 Cursor agent 失败: {err}"))?;
    tcp.set_nodelay(true).ok();
    let connector = tokio_rustls::TlsConnector::from(agent_tls_config());
    let server_name = tokio_rustls::rustls::pki_types::ServerName::try_from(host)
        .map_err(|_| anyhow::anyhow!("Cursor agent 主机名无效"))?
        .to_owned();
    let tls = connector
        .connect(server_name, tcp)
        .await
        .map_err(|err| anyhow::anyhow!("Cursor agent TLS 失败: {err}"))?;
    let (send_request, connection) = h2::client::handshake(tls)
        .await
        .map_err(|err| anyhow::anyhow!("Cursor agent HTTP/2 握手失败: {err}"))?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    let mut send_request = send_request
        .ready()
        .await
        .map_err(|err| anyhow::anyhow!("Cursor agent HTTP/2 未就绪: {err}"))?;
    let request_id = random_uuid();
    let request = http::Request::builder()
        .method(http::Method::POST)
        .uri(format!("https://{host}{AGENT_PATH}"))
        .header("authorization", format!("Bearer {token}"))
        .header("connect-accept-encoding", "gzip")
        .header("connect-protocol-version", "1")
        .header("content-type", "application/connect+proto")
        .header("user-agent", "connect-es/1.6.1")
        .header("x-cursor-client-type", "cli")
        .header("x-cursor-client-version", client_version)
        .header("x-ghost-mode", "true")
        .header("x-request-id", &request_id)
        .header("x-original-request-id", &request_id)
        .body(())
        .map_err(|err| anyhow::anyhow!("Cursor 对话请求无效: {err}"))?;
    // end_of_stream = false：请求体还要继续送 marker 和心跳。
    let (response, mut send_stream) = send_request
        .send_request(request, false)
        .map_err(|err| anyhow::anyhow!("Cursor 对话发送失败: {err}"))?;

    let (stop_tx, mut stop_rx) = tokio::sync::oneshot::channel::<()>();
    let (reply_tx, mut reply_rx) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
    let sender = tokio::spawn(async move {
        let mut replies_closed = false;
        for (index, frame) in frames.into_iter().enumerate() {
            if send_stream
                .send_data(bytes::Bytes::from(frame), false)
                .is_err()
            {
                return;
            }
            let pace = match index {
                0 => Duration::from_millis(1500),
                1 => Duration::from_millis(800),
                _ => Duration::from_millis(400),
            };
            let sleep = tokio::time::sleep(pace);
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut stop_rx => {
                        let _ = send_stream.send_data(bytes::Bytes::new(), true);
                        return;
                    }
                    reply = reply_rx.recv(), if !replies_closed => {
                        match reply {
                            Some(reply) => {
                                if send_stream
                                    .send_data(bytes::Bytes::from(reply), false)
                                    .is_err()
                                {
                                    return;
                                }
                            }
                            None => replies_closed = true,
                        }
                    }
                    _ = &mut sleep => break,
                }
            }
        }
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        ticker.tick().await;
        loop {
            tokio::select! {
                _ = &mut stop_rx => break,
                reply = reply_rx.recv(), if !replies_closed => {
                    match reply {
                        Some(reply) => {
                            if send_stream
                                .send_data(bytes::Bytes::from(reply), false)
                                .is_err()
                            {
                                return;
                            }
                        }
                        None => replies_closed = true,
                    }
                }
                _ = ticker.tick() => {
                    if send_stream
                        .send_data(bytes::Bytes::from(heartbeat_frame()), false)
                        .is_err()
                    {
                        return;
                    }
                }
            }
        }
        let _ = send_stream.send_data(bytes::Bytes::new(), true);
    });

    let response = response
        .await
        .map_err(|err| anyhow::anyhow!("Cursor 对话失败: {err}"))?;
    let status = response.status();
    let mut body = response.into_body();
    let mut pending = Vec::new();
    let mut saw_text = false;
    let mut failed = false;
    let mut hold_for_exec = false;
    loop {
        let budget = if hold_for_exec {
            hold_for_exec = false;
            Duration::from_secs(20)
        } else if saw_text {
            Duration::from_secs(4)
        } else {
            Duration::from_secs(60)
        };
        let next = match tokio::time::timeout(budget, body.data()).await {
            Ok(Some(chunk)) => chunk,
            Ok(None) | Err(_) => break,
        };
        let chunk = match next {
            Ok(chunk) => chunk,
            Err(err) => {
                failed = true;
                let _ = tx.send(Err(anyhow::anyhow!("Cursor 流中断: {err}"))).await;
                break;
            }
        };
        let _ = body.flow_control().release_capacity(chunk.len());
        pending.extend_from_slice(&chunk);
        if !forward_agent_events(
            &mut pending,
            &exec,
            &reply_tx,
            &mut saw_text,
            &mut hold_for_exec,
            &tx,
        )
        .await
        {
            failed = true;
            break;
        }
    }
    drop(reply_tx);
    let _ = stop_tx.send(());
    let _ = sender.await;
    if failed {
        return Ok(());
    }
    if saw_text {
        let _ = tx
            .send(Ok(StreamEvent::Done {
                stop_reason: StopReason::EndTurn,
            }))
            .await;
    } else if status.is_success() {
        let _ = tx.send(Err(anyhow::anyhow!("Cursor 没有返回文本"))).await;
    } else {
        let message = cursor_error_text(&pending)
            .unwrap_or_else(|| brief(&String::from_utf8_lossy(&pending)));
        let _ = tx
            .send(Err(anyhow::anyhow!("Cursor 对话失败 {status}: {message}")))
            .await;
    }
    Ok(())
}

async fn forward_agent_events(
    pending: &mut Vec<u8>,
    exec: &AgentExecReply,
    reply_tx: &tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    saw_text: &mut bool,
    hold_for_exec: &mut bool,
    tx: &tokio::sync::mpsc::Sender<Result<StreamEvent>>,
) -> bool {
    let (events, replies) = drain_agent_frames(pending, exec);
    if !replies.is_empty() {
        *hold_for_exec = true;
        for reply in replies {
            if reply_tx.send(reply).is_err() {
                return false;
            }
        }
    }
    for item in events {
        let stop = match &item {
            Ok(StreamEvent::ContentDelta { .. } | StreamEvent::ReasoningDelta { .. }) => {
                *saw_text = true;
                false
            }
            Ok(StreamEvent::ToolCall { .. }) => {
                *saw_text = true;
                true
            }
            Ok(StreamEvent::Done { .. }) | Err(_) => true,
            _ => false,
        };
        if stop && matches!(&item, Ok(StreamEvent::Done { .. })) && !*saw_text {
            let _ = tx.send(Err(anyhow::anyhow!("Cursor 没有返回文本"))).await;
            return false;
        }
        if tx
            .send(item.map_err(|err| anyhow::anyhow!(err)))
            .await
            .is_err()
        {
            return false;
        }
        if stop {
            return false;
        }
    }
    true
}

fn brief(text: &str) -> String {
    text.chars().take(180).collect()
}

#[allow(dead_code)]
fn agent_client_version() -> String {
    if let Ok(version) = std::env::var("CURSOR_AGENT_CLIENT_VERSION") {
        let version = version.trim();
        if !version.is_empty() {
            return version.to_string();
        }
    }
    CLI_CLIENT_VERSION.into()
}

#[allow(dead_code)]
fn agent_cwd() -> String {
    std::env::current_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| {
            if cfg!(windows) {
                "C:\\".into()
            } else {
                "/".into()
            }
        })
}

fn agent_shell() -> &'static str {
    if cfg!(windows) {
        "powershell"
    } else if cfg!(target_os = "macos") {
        "zsh"
    } else {
        "bash"
    }
}

fn agent_prompt(request: &ChatRequest) -> String {
    let mut context = String::new();
    let mut turns = Vec::new();
    for message in &request.messages {
        match message.role {
            Role::System => {
                let body = message.content.trim();
                if body.is_empty() {
                    continue;
                }
                if !context.is_empty() {
                    context.push('\n');
                }
                context.push_str(body);
            }
            Role::User => turns.push(format!("User:\n{}", message.content.trim())),
            Role::Assistant => {
                let mut text = message.content.trim().to_string();
                if let Some(calls) = &message.tool_calls {
                    for call in calls {
                        if !text.is_empty() {
                            text.push('\n');
                        }
                        text.push_str(&format!(
                            "调用工具 {}({})",
                            call.function.name, call.function.arguments
                        ));
                    }
                }
                if !text.is_empty() {
                    turns.push(format!("Assistant:\n{text}"));
                }
            }
            Role::Tool => {
                let name = message.name.as_deref().unwrap_or("tool");
                turns.push(format!("Tool {name}:\n{}", message.content.trim()));
            }
        }
    }
    let mut parts = Vec::new();
    if !context.is_empty() {
        parts.push(context);
    }
    if !turns.is_empty() {
        parts.push(turns.join("\n\n"));
    }
    parts.join("\n\n")
}

fn build_agent_frames(
    prompt: &str,
    model_id: &str,
    cwd: &str,
    mode: u64,
    tools: &[crate::types::ToolDef],
) -> Vec<Vec<u8>> {
    let conversation = random_uuid();
    let message_id = random_uuid();
    let mut inner = Vec::new();
    proto_string(&mut inner, 1, prompt);
    proto_string(&mut inner, 2, &message_id);
    proto_string(&mut inner, 3, "");
    proto_varint_field(&mut inner, 4, mode as i64);
    let mut messages = Vec::new();
    proto_bytes(&mut messages, 1, &inner);
    let mut action = Vec::new();
    proto_bytes(&mut action, 1, &messages);
    let mut run = Vec::new();
    proto_string(&mut run, 1, "");
    proto_bytes(&mut run, 2, &action);
    proto_bytes(&mut run, 4, &encode_mcp_tools(tools));
    proto_string(&mut run, 5, &conversation);
    proto_bytes(&mut run, 9, &encode_model_meta(model_id));
    proto_varint_field(&mut run, 12, 0);
    let mut default_model = Vec::new();
    proto_string(&mut default_model, 1, "default");
    proto_bytes(&mut run, 14, &default_model);
    proto_bytes(&mut run, 14, &encode_model_meta(model_id));
    proto_string(&mut run, 16, &conversation);
    let mut frame0 = Vec::new();
    proto_bytes(&mut frame0, 1, &run);

    let mut env = Vec::new();
    proto_string(&mut env, 1, client_os());
    proto_string(&mut env, 2, cwd);
    proto_string(&mut env, 3, agent_shell());
    proto_string(&mut env, 10, "UTC");
    proto_string(&mut env, 11, cwd);
    proto_varint_field(&mut env, 14, 1);
    proto_varint_field(&mut env, 16, 1);
    proto_varint_field(&mut env, 19, 0);
    proto_varint_field(&mut env, 20, 0);
    proto_string(&mut env, 21, cwd);
    proto_varint_field(&mut env, 22, 0);
    let mut env_wrap = Vec::new();
    proto_bytes(&mut env_wrap, 4, &env);
    let mut env_mid = Vec::new();
    proto_bytes(&mut env_mid, 1, &env_wrap);
    let mut env_outer = Vec::new();
    proto_bytes(&mut env_outer, 1, &env_mid);
    let mut context = Vec::new();
    proto_bytes(&mut context, 10, &env_outer);
    let mut frame1 = Vec::new();
    proto_bytes(&mut frame1, 2, &context);

    let mut frames = vec![connect_frame(&frame0), connect_frame(&frame1)];
    let mut marker = Vec::new();
    proto_string(&mut marker, 1, "");
    let mut wrapped = Vec::new();
    proto_bytes(&mut wrapped, 5, &marker);
    frames.push(connect_frame(&wrapped));
    let mut empty = Vec::new();
    proto_string(&mut empty, 3, "");
    let mut wrapped = Vec::new();
    proto_bytes(&mut wrapped, 3, &empty);
    frames.push(connect_frame(&wrapped));
    for index in 1_i64..=8 {
        let mut marker = Vec::new();
        proto_varint_field(&mut marker, 1, index);
        proto_string(&mut marker, 3, "");
        let mut wrapped = Vec::new();
        proto_bytes(&mut wrapped, 3, &marker);
        frames.push(connect_frame(&wrapped));
    }
    frames
}

fn mcp_tool_bodies(tools: &[crate::types::ToolDef]) -> Vec<Vec<u8>> {
    tools
        .iter()
        .map(|tool| {
            let mut def = Vec::new();
            proto_string(&mut def, 1, &tool.function.name);
            proto_string(&mut def, 2, &tool.function.description);
            proto_bytes(
                &mut def,
                3,
                &encode_protobuf_value(&tool.function.parameters, 0),
            );
            proto_string(&mut def, 4, MCP_PROVIDER);
            proto_string(&mut def, 5, &tool.function.name);
            if let Ok(schema) = serde_json::to_string(&tool.function.parameters) {
                proto_string(&mut def, 6, &schema);
            }
            def
        })
        .collect()
}

fn encode_mcp_tools(tools: &[crate::types::ToolDef]) -> Vec<u8> {
    let mut out = Vec::new();
    for def in mcp_tool_bodies(tools) {
        proto_bytes(&mut out, 1, &def);
    }
    out
}

fn encode_protobuf_value(value: &serde_json::Value, depth: usize) -> Vec<u8> {
    if depth >= 32 {
        let mut out = Vec::new();
        proto_varint_field(&mut out, 1, 0);
        return out;
    }
    match value {
        serde_json::Value::Null => {
            let mut out = Vec::new();
            proto_varint_field(&mut out, 1, 0);
            out
        }
        serde_json::Value::Bool(flag) => {
            let mut out = Vec::new();
            proto_varint_field(&mut out, 4, i64::from(*flag));
            out
        }
        serde_json::Value::Number(number) => {
            let mut out = Vec::new();
            proto_double(&mut out, 2, number.as_f64().unwrap_or(0.0));
            out
        }
        serde_json::Value::String(text) => {
            let mut out = Vec::new();
            proto_string(&mut out, 3, text);
            out
        }
        serde_json::Value::Array(items) => {
            let mut list = Vec::new();
            for item in items {
                proto_bytes(&mut list, 1, &encode_protobuf_value(item, depth + 1));
            }
            let mut out = Vec::new();
            proto_bytes(&mut out, 6, &list);
            out
        }
        serde_json::Value::Object(map) => {
            let mut fields = Vec::new();
            for (key, val) in map {
                let mut entry = Vec::new();
                proto_string(&mut entry, 1, key);
                proto_bytes(&mut entry, 2, &encode_protobuf_value(val, depth + 1));
                proto_bytes(&mut fields, 1, &entry);
            }
            let mut out = Vec::new();
            proto_bytes(&mut out, 5, &fields);
            out
        }
    }
}

fn encode_model_meta(model_id: &str) -> Vec<u8> {
    let mut meta = Vec::new();
    proto_string(&mut meta, 1, model_id);
    let mut fast = Vec::new();
    proto_string(&mut fast, 1, "fast");
    proto_string(&mut fast, 2, "false");
    proto_bytes(&mut meta, 3, &fast);
    meta
}

fn heartbeat_frame() -> Vec<u8> {
    let mut payload = Vec::new();
    proto_bytes(&mut payload, 7, b"");
    connect_frame(&payload)
}

fn connect_frame(payload: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(5 + payload.len());
    body.push(0);
    body.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    body.extend_from_slice(payload);
    body
}

fn drain_agent_frames(
    pending: &mut Vec<u8>,
    exec: &AgentExecReply,
) -> (Vec<Result<StreamEvent, String>>, Vec<Vec<u8>>) {
    let mut out = Vec::new();
    let mut replies = Vec::new();
    while pending.len() >= 5 {
        let flags = pending[0];
        let len = u32::from_be_bytes([pending[1], pending[2], pending[3], pending[4]]) as usize;
        if pending.len() < 5 + len {
            break;
        }
        let mut payload = pending[5..5 + len].to_vec();
        pending.drain(..5 + len);
        if flags & 0x01 != 0 {
            match gunzip_bytes(&payload) {
                Some(plain) => payload = plain,
                None => {
                    out.push(Err("Cursor 响应解压失败".into()));
                    continue;
                }
            }
        }
        if flags & 0x02 != 0 {
            if let Some(message) = cursor_error_text(&payload) {
                out.push(Err(message));
            } else {
                out.push(Ok(StreamEvent::Done {
                    stop_reason: StopReason::EndTurn,
                }));
            }
            break;
        }
        let exec_replies = exec_reply_frames(&payload, exec);
        if !exec_replies.is_empty() {
            replies.extend(exec_replies);
            continue;
        }
        if let Some(call) = bridged_tool_call(&payload) {
            out.push(Ok(call));
            break;
        }
        if let Some(call) = interaction_tool_call(&payload) {
            let stop = call.is_err() || matches!(call, Ok(StreamEvent::ToolCall { .. }));
            out.push(call);
            if stop {
                break;
            }
        }
        if let Some(message) = native_tool_error(&payload) {
            out.push(Err(message));
            break;
        }
        if let Some(text) = nested_text(&payload, 4) {
            out.push(Ok(StreamEvent::ReasoningDelta { text }));
        }
        if let Some(text) = nested_text(&payload, 1) {
            out.push(Ok(StreamEvent::ContentDelta { text }));
        }
    }
    (out, replies)
}

/// 服务端在真正的 `mcp_args` 之前，会先用 exec 10 / 36 问工作区和 MCP 是否连上。
/// 不回这两帧，模型只会在正文里说「先去查工具定义」。
fn exec_reply_frames(payload: &[u8], exec: &AgentExecReply) -> Vec<Vec<u8>> {
    let mut frames = Vec::new();
    for (field, wire, value) in decode_proto(payload) {
        if field == 2 && wire == 2 {
            if let Some(frame) = exec_client_frame(&value, exec) {
                frames.push(connect_frame(&frame));
            }
        }
    }
    frames
}

fn exec_client_frame(exec_message: &[u8], reply: &AgentExecReply) -> Option<Vec<u8>> {
    let mut id = 0_u64;
    let mut exec_id = String::new();
    let mut kind = None;
    let mut kind_body = Vec::new();
    for field in walk_proto(exec_message) {
        match field {
            ProtoField::Varint { field: 1, value } => id = value,
            ProtoField::Bytes { field: 15, value } => {
                exec_id = String::from_utf8(value).unwrap_or_default();
            }
            ProtoField::Bytes { field: 10, value } => {
                kind = Some(10);
                kind_body = value;
            }
            ProtoField::Bytes { field: 36, value } => {
                kind = Some(36);
                kind_body = value;
            }
            _ => {}
        }
    }
    let kind = kind?;
    let result = match kind {
        10 => request_context_result(reply),
        36 => mcp_state_result(&kind_body, reply),
        _ => return None,
    };
    let mut message = Vec::new();
    proto_varint_field(&mut message, 1, id as i64);
    if !exec_id.is_empty() {
        proto_string(&mut message, 15, &exec_id);
    }
    proto_bytes(&mut message, kind, &result);
    let mut client = Vec::new();
    proto_bytes(&mut client, 2, &message);
    Some(client)
}

fn request_context_result(reply: &AgentExecReply) -> Vec<u8> {
    let mut env = Vec::new();
    proto_string(&mut env, 1, client_os());
    proto_string(&mut env, 2, &reply.cwd);
    proto_string(&mut env, 3, agent_shell());
    proto_string(&mut env, 10, "UTC");
    proto_string(&mut env, 11, &reply.cwd);
    let mut context = Vec::new();
    proto_bytes(&mut context, 4, &env);
    for def in &reply.tool_defs {
        proto_bytes(&mut context, 7, def);
    }
    let mut success = Vec::new();
    proto_bytes(&mut success, 1, &context);
    let mut result = Vec::new();
    proto_bytes(&mut result, 1, &success);
    result
}

fn mcp_state_result(args: &[u8], reply: &AgentExecReply) -> Vec<u8> {
    let mut wanted = Vec::new();
    for field in walk_proto(args) {
        if let ProtoField::Bytes { field: 1, value } = field {
            if let Ok(id) = String::from_utf8(value) {
                if !id.is_empty() {
                    wanted.push(id);
                }
            }
        }
    }
    let include = wanted.is_empty() || wanted.iter().any(|id| id == MCP_PROVIDER);
    let mut success = Vec::new();
    if include {
        let mut server = Vec::new();
        proto_string(&mut server, 1, MCP_PROVIDER);
        proto_string(&mut server, 2, MCP_PROVIDER);
        for def in &reply.tool_defs {
            proto_bytes(&mut server, 5, def);
        }
        proto_string(&mut server, 7, "connected");
        proto_bytes(&mut success, 1, &server);
    }
    let mut result = Vec::new();
    proto_bytes(&mut result, 1, &success);
    result
}

enum ProtoField {
    Varint { field: u64, value: u64 },
    Bytes { field: u64, value: Vec<u8> },
}

fn walk_proto(data: &[u8]) -> Vec<ProtoField> {
    let mut fields = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let Some((tag, next)) = read_varint(data, pos) else {
            break;
        };
        pos = next;
        let field = tag >> 3;
        let wire = (tag & 7) as u8;
        match wire {
            0 => {
                let Some((value, next)) = read_varint(data, pos) else {
                    break;
                };
                pos = next;
                fields.push(ProtoField::Varint { field, value });
            }
            2 => {
                let Some((len, next)) = read_varint(data, pos) else {
                    break;
                };
                pos = next;
                let end = pos + len as usize;
                if end > data.len() {
                    break;
                }
                fields.push(ProtoField::Bytes {
                    field,
                    value: data[pos..end].to_vec(),
                });
                pos = end;
            }
            1 => pos += 8,
            5 => pos += 4,
            _ => break,
        }
    }
    fields
}

fn nested_text(payload: &[u8], mid_field: u64) -> Option<String> {
    for (field, wire, value) in decode_proto(payload) {
        if field != 1 || wire != 2 {
            continue;
        }
        for (field, wire, value) in decode_proto(&value) {
            if field != mid_field || wire != 2 {
                continue;
            }
            for (field, wire, value) in decode_proto(&value) {
                if field == 1 && wire == 2 {
                    if let Ok(text) = String::from_utf8(value) {
                        if !text.is_empty() {
                            return Some(text);
                        }
                    }
                }
            }
        }
    }
    None
}

/// `InteractionUpdate` 里的 MCP 工具。Cursor 有时不走 exec 11，而走
/// `ToolCallStarted` / `ToolCallCompleted`（字段 2 / 3）里的 `McpToolCall`。
fn interaction_tool_call(payload: &[u8]) -> Option<Result<StreamEvent, String>> {
    for (field, wire, value) in decode_proto(payload) {
        if field != 1 || wire != 2 {
            continue;
        }
        for (update_field, update_wire, update) in decode_proto(&value) {
            if update_wire == 2 && matches!(update_field, 2 | 3 | 7) {
                return tool_call_update(&update);
            }
        }
    }
    None
}

fn tool_call_update(update: &[u8]) -> Option<Result<StreamEvent, String>> {
    let mut call_id = None;
    let mut tool = None;
    for (field, wire, value) in decode_proto(update) {
        if wire != 2 {
            continue;
        }
        match field {
            1 => call_id = String::from_utf8(value).ok().filter(|id| !id.is_empty()),
            2 => tool = Some(value),
            _ => {}
        }
    }
    decode_advertised_tool(tool.as_deref()?, call_id)
}

fn decode_advertised_tool(
    tool: &[u8],
    call_id: Option<String>,
) -> Option<Result<StreamEvent, String>> {
    let mut tool_call_id = call_id;
    let mut mcp = None;
    let mut builtin = false;
    for (field, wire, value) in decode_proto(tool) {
        if wire != 2 {
            continue;
        }
        match field {
            15 => mcp = Some(value),
            57 => {
                if let Ok(id) = String::from_utf8(value) {
                    if !id.is_empty() {
                        tool_call_id = Some(id);
                    }
                }
            }
            // 服务端已经把这次调用判成无效参数，结果在帧里，不用再当成要我们执行的工具。
            44 => {}
            _ => builtin = true,
        }
    }
    if let Some(mcp) = mcp {
        for (field, wire, value) in decode_proto(&mcp) {
            if field == 1 && wire == 2 {
                let mut event = decode_mcp_args(&value)?;
                if let (StreamEvent::ToolCall { id, .. }, Some(call_id)) =
                    (&mut event, tool_call_id)
                {
                    if !decode_mcp_args_has_id(&value) {
                        *id = call_id;
                    }
                }
                return Some(Ok(event));
            }
        }
        return None;
    }
    if builtin {
        return Some(Err(
            "Cursor 试图调用自己的工具。这一轮只取文本，工具仍由 OmniPanel 执行".into(),
        ));
    }
    None
}

fn decode_mcp_args_has_id(buf: &[u8]) -> bool {
    decode_proto(buf).into_iter().any(|(field, wire, value)| {
        field == 3 && wire == 2 && !value.is_empty() && value.len() <= 512
    })
}

fn bridged_tool_call(payload: &[u8]) -> Option<StreamEvent> {
    for (field, wire, value) in decode_proto(payload) {
        if field != 2 || wire != 2 {
            continue;
        }
        for (inner_field, inner_wire, inner) in decode_proto(&value) {
            if inner_field == 11 && inner_wire == 2 {
                return decode_mcp_args(&inner);
            }
        }
    }
    None
}

fn decode_mcp_args(buf: &[u8]) -> Option<StreamEvent> {
    let mut name = None;
    let mut tool_name = None;
    let mut tool_call_id = None;
    let mut args = serde_json::Map::new();
    for (field, wire, value) in decode_proto(buf) {
        if wire != 2 {
            continue;
        }
        match field {
            1 => name = String::from_utf8(value).ok(),
            5 => tool_name = String::from_utf8(value).ok(),
            3 => {
                tool_call_id = String::from_utf8(value)
                    .ok()
                    .filter(|id| !id.is_empty() && id.len() <= 512);
            }
            2 => {
                let mut key = None;
                let mut raw = None;
                for (entry_field, entry_wire, entry) in decode_proto(&value) {
                    if entry_wire != 2 {
                        continue;
                    }
                    match entry_field {
                        1 => key = String::from_utf8(entry).ok(),
                        2 => raw = Some(entry),
                        _ => {}
                    }
                }
                if let (Some(key), Some(raw)) = (key, raw) {
                    args.insert(key, decode_protobuf_value(&raw, 0));
                }
            }
            _ => {}
        }
    }
    let name = tool_name.or(name)?;
    Some(StreamEvent::ToolCall {
        id: tool_call_id.unwrap_or_else(random_uuid),
        name,
        arguments: serde_json::Value::Object(args).to_string(),
    })
}

fn decode_protobuf_value(buf: &[u8], depth: usize) -> serde_json::Value {
    if depth >= 32 {
        return serde_json::Value::Null;
    }
    let Some((tag, rest)) = read_varint_slice(buf) else {
        return serde_json::Value::Null;
    };
    let field = tag >> 3;
    let wire = (tag & 7) as u8;
    match (field, wire) {
        (1, 0) => serde_json::Value::Null,
        (2, 1) => rest
            .get(..8)
            .and_then(|bytes| bytes.try_into().ok())
            .map(f64::from_le_bytes)
            .and_then(serde_json::Number::from_f64)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        (3, 2) => read_varint_slice(rest)
            .and_then(|(len, body)| body.get(..usize::try_from(len).ok()?))
            .map(|text| serde_json::Value::String(String::from_utf8_lossy(text).into_owned()))
            .unwrap_or(serde_json::Value::Null),
        (4, 0) => read_varint_slice(rest)
            .map(|(value, _)| serde_json::Value::Bool(value != 0))
            .unwrap_or(serde_json::Value::Null),
        (5, 2) => read_varint_slice(rest)
            .and_then(|(len, body)| body.get(..usize::try_from(len).ok()?))
            .map(|body| decode_protobuf_struct(body, depth + 1))
            .unwrap_or(serde_json::Value::Null),
        (6, 2) => read_varint_slice(rest)
            .and_then(|(len, body)| body.get(..usize::try_from(len).ok()?))
            .map(|body| decode_protobuf_list(body, depth + 1))
            .unwrap_or(serde_json::Value::Null),
        _ => serde_json::Value::Null,
    }
}

fn decode_protobuf_struct(buf: &[u8], depth: usize) -> serde_json::Value {
    let mut map = serde_json::Map::new();
    for (field, wire, value) in decode_proto(buf) {
        if field != 1 || wire != 2 {
            continue;
        }
        let mut key = None;
        let mut raw = None;
        for (entry_field, entry_wire, entry) in decode_proto(&value) {
            if entry_wire != 2 {
                continue;
            }
            match entry_field {
                1 => key = String::from_utf8(entry).ok(),
                2 => raw = Some(entry),
                _ => {}
            }
        }
        if let (Some(key), Some(raw)) = (key, raw) {
            map.insert(key, decode_protobuf_value(&raw, depth));
        }
    }
    serde_json::Value::Object(map)
}

fn decode_protobuf_list(buf: &[u8], depth: usize) -> serde_json::Value {
    let mut items = Vec::new();
    for (field, wire, value) in decode_proto(buf) {
        if field == 1 && wire == 2 {
            items.push(decode_protobuf_value(&value, depth));
        }
    }
    serde_json::Value::Array(items)
}

fn read_varint_slice(mut buf: &[u8]) -> Option<(u64, &[u8])> {
    let mut value = 0_u64;
    let mut shift = 0;
    while !buf.is_empty() && shift < 64 {
        let byte = buf[0];
        buf = &buf[1..];
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, buf));
        }
        shift += 7;
    }
    None
}

fn native_tool_error(payload: &[u8]) -> Option<String> {
    for (field, wire, value) in decode_proto(payload) {
        if field != 2 || wire != 2 {
            continue;
        }
        for (inner_field, inner_wire, inner) in decode_proto(&value) {
            // 10 是工作区上下文，36 是 MCP 连接状态，都在 exec_reply_frames 里回答。
            if inner_field == 11 || inner_field == 10 || inner_field == 36 {
                continue;
            }
            if inner_wire == 2 && contains_tool_id(&inner) {
                return Some(
                    "Cursor 试图调用自己的工具。这一轮只取文本，工具仍由 OmniPanel 执行".into(),
                );
            }
        }
    }
    None
}

fn contains_tool_id(buf: &[u8]) -> bool {
    decode_proto(buf)
        .into_iter()
        .any(|(_, wire, value)| wire == 2 && value.len() <= 512 && value.starts_with(b"tool_"))
}

fn cursor_error_text(payload: &[u8]) -> Option<String> {
    let text = std::str::from_utf8(payload).ok()?.trim();
    if text.is_empty() || text == "{}" {
        return None;
    }
    let json: Value = serde_json::from_str(text).ok()?;
    let err = json.get("error")?;
    match (
        find_json_string(err, "title"),
        find_json_string(err, "detail"),
    ) {
        (Some(title), Some(detail)) if detail != title => {
            return Some(format!("{title}: {detail}"));
        }
        (Some(title), _) => return Some(title),
        (None, Some(detail)) => return Some(detail),
        _ => {}
    }
    err.get("message")
        .and_then(|value| value.as_str())
        .filter(|message| !message.is_empty() && *message != "Error")
        .map(str::to_string)
        .or_else(|| {
            err.get("code")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .or_else(|| Some("Cursor 拒绝了这次对话".into()))
}

fn find_json_string(value: &Value, key: &str) -> Option<String> {
    match value {
        Value::Object(map) => {
            if let Some(text) = map.get(key).and_then(|item| item.as_str()) {
                if !text.is_empty() {
                    return Some(text.to_string());
                }
            }
            map.values().find_map(|item| find_json_string(item, key))
        }
        Value::Array(items) => items.iter().find_map(|item| find_json_string(item, key)),
        _ => None,
    }
}

fn gunzip_bytes(data: &[u8]) -> Option<Vec<u8>> {
    let mut decoder = flate2::read::GzDecoder::new(data);
    let mut out = Vec::new();
    decoder.read_to_end(&mut out).ok()?;
    Some(out)
}

fn proto_string(out: &mut Vec<u8>, field: u64, value: &str) {
    proto_bytes(out, field, value.as_bytes());
}

fn proto_bytes(out: &mut Vec<u8>, field: u64, value: &[u8]) {
    proto_varint(out, (field << 3) | 2);
    proto_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

fn proto_double(out: &mut Vec<u8>, field: u64, value: f64) {
    proto_varint(out, (field << 3) | 1);
    out.extend_from_slice(&value.to_le_bytes());
}

fn proto_varint_field(out: &mut Vec<u8>, field: u64, value: i64) {
    proto_varint(out, (field << 3) | 0);
    proto_varint(out, value as u64);
}

fn proto_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let mut byte = (value & 0x7f) as u8;
        value >>= 7;
        if value != 0 {
            byte |= 0x80;
        }
        out.push(byte);
        if value == 0 {
            break;
        }
    }
}

fn decode_proto(data: &[u8]) -> Vec<(u64, u8, Vec<u8>)> {
    let mut fields = Vec::new();
    let mut pos = 0;
    while pos < data.len() {
        let Some((tag, next)) = read_varint(data, pos) else {
            break;
        };
        pos = next;
        let field = tag >> 3;
        let wire = (tag & 7) as u8;
        match wire {
            0 => {
                let Some((_, next)) = read_varint(data, pos) else {
                    break;
                };
                pos = next;
            }
            2 => {
                let Some((len, next)) = read_varint(data, pos) else {
                    break;
                };
                pos = next;
                let end = pos + len as usize;
                if end > data.len() {
                    break;
                }
                fields.push((field, wire, data[pos..end].to_vec()));
                pos = end;
            }
            1 => pos += 8,
            5 => pos += 4,
            _ => break,
        }
    }
    fields
}

fn read_varint(data: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let mut value = 0_u64;
    let mut shift = 0;
    while pos < data.len() && shift < 64 {
        let byte = data[pos];
        pos += 1;
        value |= u64::from(byte & 0x7f) << shift;
        if byte & 0x80 == 0 {
            return Some((value, pos));
        }
        shift += 7;
    }
    None
}

fn cursor_checksum_header(
    token: &str,
    machine_id: &str,
    mac_machine_id: &str,
    now_ms: i64,
) -> String {
    let base = cursor_checksum(token, machine_id, now_ms);
    if mac_machine_id.is_empty() {
        base
    } else {
        format!("{base}/{mac_machine_id}")
    }
}

pub(crate) fn cursor_checksum(token: &str, machine_id: &str, now_ms: i64) -> String {
    let machine_id = if machine_id.is_empty() {
        sha256_hex(format!("{token}machineId").as_bytes())
    } else {
        machine_id.to_string()
    };
    let timestamp = (now_ms / 1_000_000) as u64;
    let mut bytes = [
        ((timestamp >> 40) & 255) as u8,
        ((timestamp >> 32) & 255) as u8,
        ((timestamp >> 24) & 255) as u8,
        ((timestamp >> 16) & 255) as u8,
        ((timestamp >> 8) & 255) as u8,
        (timestamp & 255) as u8,
    ];
    let mut rolling = 165_u8;
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = ((*byte) ^ rolling).wrapping_add(index as u8);
        rolling = *byte;
    }
    format!("{}{machine_id}", encode_base64url(&bytes))
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn uuid_v5_dns(name: &str) -> String {
    const NAMESPACE_DNS: [u8; 16] = [
        0x6b, 0xa7, 0xb8, 0x10, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30,
        0xc8,
    ];
    let mut hasher = sha1::Sha1::new();
    sha1::Digest::update(&mut hasher, NAMESPACE_DNS);
    sha1::Digest::update(&mut hasher, name.as_bytes());
    let hash = sha1::Digest::finalize(hasher);
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&hash[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format_uuid(&bytes)
}

fn random_uuid() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    let mixed = COUNTER.fetch_add(1, Ordering::Relaxed);
    let digest = Sha256::digest(format!("{mixed}-{}", now_ms()).as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format_uuid(&bytes)
}

fn format_uuid(bytes: &[u8; 16]) -> String {
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3],
        bytes[4],
        bytes[5],
        bytes[6],
        bytes[7],
        bytes[8],
        bytes[9],
        bytes[10],
        bytes[11],
        bytes[12],
        bytes[13],
        bytes[14],
        bytes[15]
    )
}

fn encode_base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::new();
    let mut index = 0;
    while index < bytes.len() {
        let a = bytes[index];
        let b = if index + 1 < bytes.len() {
            bytes[index + 1]
        } else {
            0
        };
        let c = if index + 2 < bytes.len() {
            bytes[index + 2]
        } else {
            0
        };
        out.push(ALPHABET[(a >> 2) as usize] as char);
        out.push(ALPHABET[(((a & 3) << 4) | (b >> 4)) as usize] as char);
        if index + 1 < bytes.len() {
            out.push(ALPHABET[(((b & 15) << 2) | (c >> 6)) as usize] as char);
        }
        if index + 2 < bytes.len() {
            out.push(ALPHABET[(c & 63) as usize] as char);
        }
        index += 3;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_use_display_name_and_server_id() {
        let document = json!({
            "models": [
                { "name": "default", "clientDisplayName": "default", "serverModelName": "default" },
                { "name": "composer-2.5", "clientDisplayName": "Composer 2.5", "serverModelName": "composer-2.5-server" },
                { "name": "" }
            ]
        });
        let models = parse_models(&document).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "default");
        assert_eq!(models[0].name, "Auto");
        assert_eq!(models[1].id, "composer-2.5");
        assert_eq!(models[1].name, "Composer 2.5");
    }

    #[test]
    fn usage_is_remaining_included_dollars() {
        let usage = json!({
            "billingCycleEnd": "1791248689000",
            "planUsage": { "limit": 40000, "includedSpend": 10000 }
        });
        let plan = json!({ "planInfo": { "planName": "Ultra" } });
        let credits = parse_usage(&usage, &plan).unwrap();
        assert_eq!(credits.total, 300.0);
        assert_eq!(credits.packages[0].name, "Ultra 包含用量");
        assert_eq!(credits.packages[0].size, 400.0);
        assert!(credits.cycle_reset_time.is_some());
    }

    #[test]
    fn checksum_matches_cursor_obfuscation() {
        assert_eq!(
            cursor_checksum("ignored", "machine", 1_700_000_000_000),
            "paaotEjtmachine"
        );
    }

    #[test]
    fn session_id_is_uuid_v5() {
        assert_eq!(
            uuid_v5_dns("python.org"),
            "886313e1-3b8a-5372-9b90-0c9aee199e5d"
        );
    }

    fn sample_request(messages: Vec<ChatMessage>) -> ChatRequest {
        ChatRequest {
            model: "grok-4.7".into(),
            messages,
            stream: true,
            tools: None,
            temperature: None,
            max_tokens: None,
            enable_thinking: None,
            reasoning_effort: None,
        }
    }

    fn message(role: Role, content: &str) -> ChatMessage {
        ChatMessage {
            role,
            content: content.into(),
            tool_call_id: None,
            tool_calls: None,
            name: None,
        }
    }

    #[test]
    fn agent_frames_are_uncompressed_and_carry_prompt() {
        let frames = build_agent_frames("PROMPT_MARKER", "MODEL_MARKER", "C:\\work", ASK_MODE, &[]);
        assert_eq!(frames.len(), 12);
        for frame in &frames {
            assert_eq!(frame[0], 0);
            let len = u32::from_be_bytes([frame[1], frame[2], frame[3], frame[4]]) as usize;
            assert_eq!(len + 5, frame.len());
        }
        let hay = String::from_utf8_lossy(&frames[0]);
        assert!(hay.contains("PROMPT_MARKER"));
        assert!(hay.contains("MODEL_MARKER"));
        let agent = build_agent_frames("PROMPT_MARKER", "MODEL_MARKER", "C:\\work", 1, &[]);
        assert_ne!(frames[0], agent[0]);
    }

    #[test]
    fn agent_prompt_keeps_tool_policy_and_skips_empty_assistant() {
        let policy = crate::prompts::tool_routing_policy();
        let prompt = agent_prompt(&sample_request(vec![
            message(
                Role::System,
                &format!("{policy}\n\nCurrent working directory: C:\\work"),
            ),
            message(Role::User, "上一问"),
            message(Role::Assistant, "   "),
            message(Role::User, "现在几点了"),
        ]));
        assert!(prompt.contains("omni_terminal_exec"));
        assert!(prompt.contains("Current working directory: C:\\work"));
        assert!(prompt.contains("User:\n上一问"));
        assert!(prompt.contains("User:\n现在几点了"));
        assert!(!prompt.contains("不要调用工具"));
        assert!(!prompt.contains("Assistant:"));
    }

    #[test]
    fn agent_frames_advertise_omnipanel_tools() {
        let tool = crate::types::ToolDef {
            tool_type: "function".into(),
            function: crate::types::FunctionDef {
                name: "omni_terminal_exec".into(),
                description: "在当前终端执行命令".into(),
                parameters: json!({"type": "object", "properties": {"command": {"type": "string"}}}),
            },
        };
        let frames = build_agent_frames("hi", "m", "C:\\work", ASK_MODE, &[tool]);
        let hay = String::from_utf8_lossy(&frames[0]);
        assert!(hay.contains("omni_terminal_exec"));
        assert!(hay.contains("omnipanel"));
        let empty = build_agent_frames("hi", "m", "C:\\work", ASK_MODE, &[]);
        assert_ne!(frames[0], empty[0]);
    }

    #[test]
    fn agent_frame_reads_answer_reasoning_and_error_title() {
        let answer = {
            let leaf = {
                let mut leaf = Vec::new();
                proto_string(&mut leaf, 1, "你好");
                leaf
            };
            let mut mid = Vec::new();
            proto_bytes(&mut mid, 1, &leaf);
            let mut top = Vec::new();
            proto_bytes(&mut top, 1, &mid);
            connect_frame(&top)
        };
        let reasoning = {
            let leaf = {
                let mut leaf = Vec::new();
                proto_string(&mut leaf, 1, "先想一下");
                leaf
            };
            let mut mid = Vec::new();
            proto_bytes(&mut mid, 4, &leaf);
            let mut top = Vec::new();
            proto_bytes(&mut top, 1, &mid);
            connect_frame(&top)
        };
        let mut pending = answer;
        pending.extend(reasoning);
        let events = drain_events(&mut pending);
        assert!(pending.is_empty());
        assert!(matches!(
            &events[0],
            Ok(StreamEvent::ContentDelta { text }) if text == "你好"
        ));
        assert!(matches!(
            &events[1],
            Ok(StreamEvent::ReasoningDelta { text }) if text == "先想一下"
        ));

        let error = br#"{"error":{"code":"resource_exhausted","message":"Error","details":[{"debug":{"details":{"title":"Update Required"}}}]}}"#;
        let mut framed = Vec::new();
        framed.push(2);
        framed.extend_from_slice(&(error.len() as u32).to_be_bytes());
        framed.extend_from_slice(error);
        let events = drain_events(&mut framed);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].as_ref().unwrap_err(), "Update Required");
    }

    #[test]
    fn agent_frame_bridges_omnipanel_tool_and_rejects_builtin() {
        let mut args = Vec::new();
        proto_string(&mut args, 5, "omni_terminal_exec");
        proto_string(&mut args, 3, "call-1");
        let mut entry = Vec::new();
        proto_string(&mut entry, 1, "command");
        let mut value = Vec::new();
        proto_string(&mut value, 3, "date");
        proto_bytes(&mut entry, 2, &value);
        proto_bytes(&mut args, 2, &entry);
        let mut exec = Vec::new();
        proto_bytes(&mut exec, 11, &args);
        let mut payload = Vec::new();
        proto_bytes(&mut payload, 2, &exec);
        let mut framed = connect_frame(&payload);
        let events = drain_events(&mut framed);
        assert!(matches!(
            &events[0],
            Ok(StreamEvent::ToolCall { id, name, arguments })
                if id == "call-1" && name == "omni_terminal_exec" && arguments.contains("date")
        ));

        let mut builtin = Vec::new();
        proto_string(&mut builtin, 2, "tool_builtin");
        let mut exec = Vec::new();
        proto_bytes(&mut exec, 7, &builtin);
        let mut payload = Vec::new();
        proto_bytes(&mut payload, 2, &exec);
        let mut framed = connect_frame(&payload);
        let events = drain_events(&mut framed);
        assert!(events[0].as_ref().unwrap_err().contains("只取文本"));
    }

    fn drain_events(pending: &mut Vec<u8>) -> Vec<Result<StreamEvent, String>> {
        drain_agent_frames(
            pending,
            &AgentExecReply {
                tool_defs: Vec::new(),
                cwd: "C:\\work".into(),
            },
        )
        .0
    }

    #[test]
    fn mcp_state_reply_lists_connected_omnipanel_tools() {
        let tool = crate::types::ToolDef {
            tool_type: "function".into(),
            function: crate::types::FunctionDef {
                name: "omni_terminal_exec".into(),
                description: "在当前终端执行命令".into(),
                parameters: json!({"type": "object"}),
            },
        };
        let reply = AgentExecReply {
            tool_defs: mcp_tool_bodies(&[tool]),
            cwd: "C:\\work".into(),
        };
        let mut args = Vec::new();
        proto_string(&mut args, 1, MCP_PROVIDER);
        let mut exec = Vec::new();
        proto_varint_field(&mut exec, 1, 7);
        proto_string(&mut exec, 15, "exec-1");
        proto_bytes(&mut exec, 36, &args);
        let mut payload = Vec::new();
        proto_bytes(&mut payload, 2, &exec);
        let mut framed = connect_frame(&payload);
        let (events, replies) = drain_agent_frames(&mut framed, &reply);
        assert!(events.is_empty());
        assert_eq!(replies.len(), 1);
        let hay = String::from_utf8_lossy(&replies[0]);
        assert!(hay.contains("exec-1"));
        assert!(hay.contains(MCP_PROVIDER));
        assert!(hay.contains("omni_terminal_exec"));
        assert!(hay.contains("connected"));
    }

    #[test]
    fn interaction_update_bridges_mcp_tool_call() {
        let mut args = Vec::new();
        proto_string(&mut args, 5, "omni_terminal_exec");
        let mut command = Vec::new();
        proto_string(&mut command, 3, "date");
        let mut entry = Vec::new();
        proto_string(&mut entry, 1, "command");
        proto_bytes(&mut entry, 2, &command);
        proto_bytes(&mut args, 2, &entry);
        let mut mcp = Vec::new();
        proto_bytes(&mut mcp, 1, &args);
        let mut tool = Vec::new();
        proto_bytes(&mut tool, 15, &mcp);
        let mut started = Vec::new();
        proto_string(&mut started, 1, "call-started");
        proto_bytes(&mut started, 2, &tool);
        let mut update = Vec::new();
        proto_bytes(&mut update, 2, &started);
        let mut payload = Vec::new();
        proto_bytes(&mut payload, 1, &update);
        let mut framed = connect_frame(&payload);
        let events = drain_events(&mut framed);
        assert!(matches!(
            &events[0],
            Ok(StreamEvent::ToolCall { id, name, arguments })
                if id == "call-started" && name == "omni_terminal_exec" && arguments.contains("date")
        ));
    }

    fn sample_tool() -> crate::types::ToolDef {
        crate::types::ToolDef {
            tool_type: "function".into(),
            function: crate::types::FunctionDef {
                name: "omni_terminal_exec".into(),
                description: "在当前终端执行命令".into(),
                parameters: json!({"type": "object", "properties": {"command": {"type": "string"}}}),
            },
        }
    }

    #[test]
    fn chat_payload_lists_omnipanel_tools_and_keeps_tool_output() {
        let mut request = sample_request(vec![
            message(Role::System, "使用 omni_terminal_exec"),
            message(Role::User, "现在几点了"),
            message(Role::Assistant, ""),
            message(Role::User, "再看一次"),
        ]);
        request.messages[2].tool_calls = Some(vec![crate::types::ToolCall {
            id: "call-1".into(),
            call_type: "function".into(),
            function: crate::types::FunctionCall {
                name: "omni_terminal_exec".into(),
                arguments: "{\"command\":\"date\"}".into(),
            },
        }]);
        request.messages.insert(
            3,
            ChatMessage {
                role: Role::Tool,
                content: "Thu Oct 8".into(),
                tool_call_id: Some("call-1".into()),
                tool_calls: None,
                name: Some("omni_terminal_exec".into()),
            },
        );
        let tool = sample_tool();
        let payload = build_chat_payload(&request, "grok-4.7", &[tool]);
        let hay = String::from_utf8_lossy(&payload);
        assert!(hay.contains("omni_terminal_exec"));
        assert!(hay.contains(MCP_PROVIDER));
        assert!(hay.contains("grok-4.7"));
        assert!(hay.contains("现在几点了"));
        assert!(hay.contains("Thu Oct 8"));
        assert!(hay.contains("使用 omni_terminal_exec"));
    }

    #[test]
    fn chat_frame_bridges_mcp_call_and_answers_schema_lookup() {
        let tool = sample_tool();
        let mut mcp = Vec::new();
        proto_string(&mut mcp, 2, "omni_terminal_exec");
        proto_bytes(
            &mut mcp,
            3,
            &encode_protobuf_value(&json!({"command": "date"}), 0),
        );
        let mut call = Vec::new();
        proto_varint_field(&mut call, 1, TOOL_CALL_MCP as i64);
        proto_string(&mut call, 3, "call-1");
        proto_bytes(&mut call, 62, &mcp);
        let mut payload = Vec::new();
        proto_bytes(&mut payload, 1, &call);
        let mut framed = connect_frame(&payload);
        let mut seq = 1_u64;
        let (events, replies) = drain_chat_frames(&mut framed, &[tool.clone()], "turn", &mut seq);
        assert!(replies.is_empty());
        assert!(matches!(
            &events[0],
            Ok(StreamEvent::ToolCall { id, name, arguments })
                if id == "call-1" && name == "omni_terminal_exec" && arguments.contains("date")
        ));

        let mut lookup = Vec::new();
        proto_string(&mut lookup, 2, "omni_terminal_exec");
        let mut call = Vec::new();
        proto_varint_field(&mut call, 1, TOOL_GET_MCP as i64);
        proto_string(&mut call, 3, "lookup-1");
        proto_bytes(&mut call, 72, &lookup);
        let mut payload = Vec::new();
        proto_bytes(&mut payload, 1, &call);
        let mut framed = connect_frame(&payload);
        let mut seq = 1_u64;
        let (events, replies) = drain_chat_frames(&mut framed, &[tool], "turn", &mut seq);
        assert!(events.is_empty());
        let hay = String::from_utf8_lossy(&replies[0]);
        assert!(hay.contains("lookup-1"));
        assert!(hay.contains("omni_terminal_exec"));
    }
}
