//! WorkBuddy 国内版（Windows 优先）：读桌面登录文件、解开 5.6 信封、拉目录、翻译对话。
//!
//! 协议移植自 dsh-workbuddy-connect（MIT）对 workbuddy2api 的上游说明。
//! 只覆盖国内版。未登录时不给出可选模型。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use anyhow::{Result, bail};
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use futures::{Stream, StreamExt};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use omnipanel_ai::AiProvider;
use omnipanel_ai::StreamEvent;
use omnipanel_ai::providers::openai::parse_sse_line;
use omnipanel_ai::{ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, Usage};

use omnipanel_ai::{
    AgentSource, AgentSourceCard, AgentSourceCreditPackage, AgentSourceCredits, AgentSourceModel,
};

pub const SOURCE_ID: &str = "workbuddy";
const TITLE: &str = "WorkBuddy";
const CN_CHAT_BASE: &str = "https://copilot.tencent.com";
const CN_BILLING_BASE: &str = "https://www.codebuddy.cn";
const CLIENT_UA: &str = "CLI/2.63.2 CodeBuddy/2.63.2";
const CLIENT_VERSION: &str = "2.63.2";
const HELPER_SCRIPT: &str = "process.stdout.write(String(process._linkedBinding(\"electron_browser_workbuddy_storage\").loggerGet()))";
const AUTH_REL: &[&str] = &[
    "CodeBuddyExtension",
    "Data",
    "Public",
    "auth",
    "workbuddy-desktop.info",
];

struct Memory {
    credential: Option<Credential>,
    models: Vec<AgentSourceModel>,
    catalog_source: String,
    error: Option<String>,
    credits: Option<AgentSourceCredits>,
}

pub struct WorkBuddySource {
    memory: Mutex<Memory>,
}

impl WorkBuddySource {
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

impl Default for WorkBuddySource {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSource for WorkBuddySource {
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
            memory.error = Some("未找到 WorkBuddy 登录文件".into());
            return Ok(card_from(&memory));
        };
        let client = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        match refresh_upstream_blocking(&client, &credential) {
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
        "https://copilot.tencent.com"
    }

    fn open_provider(&self, model_id: &str, client: Client) -> Result<Box<dyn AiProvider>, String> {
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        load_credential(&mut memory.credential).map_err(|e| e)?;
        let credential = memory
            .credential
            .clone()
            .ok_or_else(|| "WorkBuddy 未登录".to_string())?;
        let credential = match ensure_fresh_blocking(&client, &credential) {
            Ok(next) => {
                memory.credential = Some(next.clone());
                next
            }
            Err(err) => return Err(err),
        };
        drop(memory);
        Ok(Box::new(WorkBuddyProvider {
            credential,
            client,
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
        account: memory.credential.as_ref().map(account_label),
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
    if let Some(saved) = load_catalog_cache(&account_key(credential)) {
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
    if let Some(saved) = load_catalog_cache(&account_key(&credential)) {
        memory.models = saved;
        memory.catalog_source = "saved".into();
    }
}

#[derive(Debug, Clone)]
struct Credential {
    access_token: String,
    refresh_token: String,
    expires_at_ms: i64,
    domain: String,
    uid: String,
    enterprise_id: Option<String>,
    nickname: Option<String>,
}

fn account_key(credential: &Credential) -> String {
    if !credential.uid.is_empty() {
        credential.uid.clone()
    } else if let Some(name) = credential.nickname.as_ref().filter(|s| !s.is_empty()) {
        name.clone()
    } else {
        "default".into()
    }
}

fn account_label(credential: &Credential) -> String {
    credential
        .nickname
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| account_key(credential))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn load_credential(slot: &mut Option<Credential>) -> Result<(), String> {
    if slot.is_some() {
        return Ok(());
    }
    let Some(path) = auth_file_path() else {
        return Ok(());
    };
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取登录文件失败: {e}"))?;
    let parsed = parse_auth_document(&text).map_err(|e| e.to_string())?;
    *slot = parsed;
    Ok(())
}

fn auth_file_path() -> Option<PathBuf> {
    if let Some(from_env) = std::env::var("WORKBUDDY_AUTH_FILE")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        let path = PathBuf::from(from_env);
        if path.is_file() {
            return Some(path);
        }
    }
    for root in [
        std::env::var("LOCALAPPDATA").ok(),
        std::env::var("APPDATA").ok(),
    ]
    .into_iter()
    .flatten()
    {
        if root.trim().is_empty() {
            continue;
        }
        let mut path = PathBuf::from(root);
        for seg in AUTH_REL {
            path.push(seg);
        }
        if path.is_file() {
            return Some(path);
        }
    }
    None
}

fn parse_auth_document(text: &str) -> Result<Option<Credential>> {
    let document: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    if !document.is_object() {
        return Ok(None);
    }
    let auth = document
        .get("auth")
        .filter(|v| v.is_object())
        .unwrap_or(&document);
    let identity = document
        .get("account")
        .filter(|v| v.is_object())
        .unwrap_or(auth);
    let access = match auth.get("accessToken") {
        Some(Value::String(token)) if !token.is_empty() => token.clone(),
        Some(Value::Object(_)) => {
            let opened = unwrap_encrypted_document(&document)?;
            return parse_auth_document(&opened);
        }
        _ => return Ok(None),
    };
    let refresh = auth
        .get("refreshToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(Some(Credential {
        access_token: access,
        refresh_token: refresh,
        expires_at_ms: expiry_to_ms(auth.get("expiresAt").and_then(|v| v.as_i64()).unwrap_or(0)),
        domain: auth
            .get("domain")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        uid: identity
            .get("uid")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        enterprise_id: identity
            .get("enterpriseId")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        nickname: identity
            .get("nickname")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    }))
}

fn expiry_to_ms(value: i64) -> i64 {
    if value <= 0 {
        0
    } else if value > 1_000_000_000_000 {
        value
    } else {
        value * 1000
    }
}

fn unwrap_encrypted_document(document: &Value) -> Result<String> {
    let auth = document
        .get("auth")
        .filter(|v| v.is_object())
        .unwrap_or(document);
    let mut rebuilt = document.clone();
    let target = if rebuilt.get("auth").is_some_and(|v| v.is_object()) {
        rebuilt.get_mut("auth").unwrap()
    } else {
        &mut rebuilt
    };
    let key = protector_key()?;
    for field in ["accessToken", "refreshToken"] {
        let Some(value) = auth.get(field) else {
            continue;
        };
        if value.is_string() {
            continue;
        }
        let plain = open_wrapped_field(&key, value)
            .ok_or_else(|| anyhow::anyhow!("无法解开 WorkBuddy 加密字段 {field}"))?;
        target[field] = Value::String(plain);
    }
    Ok(rebuilt.to_string())
}

fn open_wrapped_field(key: &[u8], value: &Value) -> Option<String> {
    if value.get("$wbEncrypted")?.as_i64()? != 1 {
        return None;
    }
    let envelope_b64 = value.get("envelope")?.as_str()?;
    let raw = B64.decode(envelope_b64).ok()?;
    let envelope: Value = serde_json::from_slice(&raw).ok()?;
    let suite = envelope.get("suite")?.as_u64()? as u32;
    let key_id = envelope.get("keyId")?.as_str()?.to_string();
    let nonce = B64.decode(envelope.get("nonce")?.as_str()?).ok()?;
    let auth_tag = B64.decode(envelope.get("authTag")?.as_str()?).ok()?;
    let mut ciphertext = B64.decode(envelope.get("ciphertext")?.as_str()?).ok()?;
    ciphertext.extend_from_slice(&auth_tag);
    let cipher = Aes256Gcm::new_from_slice(key).ok()?;
    let aad = authenticated_context_aad(&key_id, suite);
    let plain = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: &aad,
            },
        )
        .ok()?;
    String::from_utf8(plain).ok()
}

fn authenticated_context_aad(key_id: &str, suite: u32) -> Vec<u8> {
    fn length_prefixed(value: &str) -> Vec<u8> {
        let bytes = value.as_bytes();
        let mut out = (bytes.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(bytes);
        out
    }
    let mut out = b"WB-AAD\0".to_vec();
    out.push(1);
    out.extend(length_prefixed("WBEV1"));
    out.extend(length_prefixed("sym-v1"));
    out.extend_from_slice(&suite.to_be_bytes());
    out.extend(length_prefixed(key_id));
    out.push(2);
    out.push(0);
    out.push(0);
    out
}

fn protector_key() -> Result<Vec<u8>> {
    let payload = spawn_key_helper()?;
    let parsed: Value = serde_json::from_str(payload.trim())?;
    if parsed.get("version").and_then(|v| v.as_i64()) != Some(1) {
        bail!("WorkBuddy 保护密钥格式无法识别");
    }
    let secret = parsed
        .get("atRestSecretKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow::anyhow!("WorkBuddy 保护密钥缺失"))?;
    let decoded = B64.decode(secret)?;
    if decoded.len() != 32 || decoded.iter().all(|b| *b == 0) {
        bail!("WorkBuddy 保护密钥无效");
    }
    Ok(Sha256::digest(secret.as_bytes()).to_vec())
}

fn spawn_key_helper() -> Result<String> {
    let exe = electron_path().ok_or_else(|| {
        anyhow::anyhow!(
            "找不到 WorkBuddy.exe。可设置 WORKBUDDY_ELECTRON_BIN 指向安装目录中的 WorkBuddy.exe"
        )
    })?;
    let output = std::process::Command::new(&exe)
        .arg("-e")
        .arg(HELPER_SCRIPT)
        .env("ELECTRON_RUN_AS_NODE", "1")
        .output()
        .map_err(|e| anyhow::anyhow!("无法启动 WorkBuddy 解密程序: {e}"))?;
    if !output.status.success() {
        bail!(
            "WorkBuddy 解密程序退出码 {}",
            output.status.code().unwrap_or(-1)
        );
    }
    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        bail!("WorkBuddy 解密程序没有返回保护密钥");
    }
    Ok(text)
}

fn electron_path() -> Option<PathBuf> {
    if let Some(from_env) = std::env::var("WORKBUDDY_ELECTRON_BIN")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        let path = PathBuf::from(from_env);
        if path.is_file() {
            return Some(path);
        }
    }
    let local = std::env::var("LOCALAPPDATA").ok()?;
    let path = Path::new(&local)
        .join("Programs")
        .join("WorkBuddy")
        .join("WorkBuddy.exe");
    path.is_file().then_some(path)
}

fn cache_path() -> Option<PathBuf> {
    let dir = omnipanel_store::ai_config_dir().ok()?.join("agent-sources");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("workbuddy.json"))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCache {
    account_key: String,
    models: Vec<AgentSourceModel>,
}

fn save_catalog_cache(credential: &Credential, models: &[AgentSourceModel]) -> Result<(), String> {
    let path = cache_path().ok_or_else(|| "无法写入模型目录缓存".to_string())?;
    let payload = CatalogCache {
        account_key: account_key(credential),
        models: models.to_vec(),
    };
    let text = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| e.to_string())
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

struct UpstreamRefresh {
    credential: Credential,
    models: Result<Vec<AgentSourceModel>, String>,
    credits: Result<AgentSourceCredits, String>,
}

fn refresh_upstream_blocking(
    client: &Client,
    credential: &Credential,
) -> Result<UpstreamRefresh, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(async {
        let credential = ensure_fresh(client, credential).await?;
        let models = fetch_models(client, &credential).await;
        let credits = fetch_credits(client, &credential).await;
        Ok(UpstreamRefresh {
            credential,
            models,
            credits,
        })
    })
}

fn ensure_fresh_blocking(client: &Client, credential: &Credential) -> Result<Credential, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?;
    runtime.block_on(ensure_fresh(client, credential))
}

async fn ensure_fresh(client: &Client, credential: &Credential) -> Result<Credential, String> {
    if credential.expires_at_ms > now_ms() + 60_000 && !credential.access_token.is_empty() {
        return Ok(credential.clone());
    }
    if credential.refresh_token.is_empty() {
        return Err("WorkBuddy 登录已过期，请在桌面 App 中重新登录".into());
    }
    refresh_token(client, credential).await
}

async fn refresh_token(client: &Client, credential: &Credential) -> Result<Credential, String> {
    let response = client
        .post(format!("{CN_CHAT_BASE}/v2/plugin/auth/token/refresh"))
        .headers(refresh_headers(credential))
        .send()
        .await
        .map_err(|e| format!("刷新登录失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let envelope: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() || envelope.get("code").and_then(|v| v.as_i64()) != Some(0) {
        return Err(format!("刷新登录被拒绝: {text}"));
    }
    let data = envelope.get("data").cloned().unwrap_or(Value::Null);
    let access = data
        .get("accessToken")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if access.is_empty() {
        return Err("刷新登录没有返回 accessToken".into());
    }
    let mut next = credential.clone();
    next.access_token = access;
    if let Some(refresh) = data.get("refreshToken").and_then(|v| v.as_str()) {
        if !refresh.is_empty() {
            next.refresh_token = refresh.to_string();
        }
    }
    if let Some(expires) = data.get("expiresIn").and_then(|v| v.as_i64()) {
        if expires > 0 {
            next.expires_at_ms = now_ms() + expires * 1000;
        }
    }
    Ok(next)
}

async fn fetch_models(
    client: &Client,
    credential: &Credential,
) -> Result<Vec<AgentSourceModel>, String> {
    let response = client
        .get(format!("{CN_CHAT_BASE}/v3/config"))
        .bearer_auth(&credential.access_token)
        .header("Accept", "application/json")
        .header("Origin", "https://www.codebuddy.cn")
        .header("Referer", "https://www.codebuddy.cn/")
        .header("User-Agent", CLIENT_UA)
        .send()
        .await
        .map_err(|e| format!("拉取模型目录失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("模型目录请求失败 ({status}): {text}"));
    }
    let document: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let data = if document.get("data").is_some_and(|v| v.is_object()) {
        document.get("data").cloned().unwrap_or(Value::Null)
    } else {
        document
    };
    parse_cli_catalog(&data).map_err(|e| e.to_string())
}

pub(crate) fn parse_cli_catalog(data: &Value) -> Result<Vec<AgentSourceModel>> {
    let agents = data.get("agents").and_then(|v| v.as_array());
    let cli_ids = agents.and_then(|agents| {
        agents.iter().find_map(|agent| {
            if agent.get("name").and_then(|v| v.as_str()) != Some("cli") {
                return None;
            }
            agent.get("models").and_then(|v| v.as_array()).map(|ids| {
                ids.iter()
                    .filter_map(|id| id.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            })
        })
    });
    let Some(cli_ids) = cli_ids.filter(|ids| !ids.is_empty()) else {
        bail!("WorkBuddy 目录里没有 CLI 可用模型");
    };
    let raw_models = data
        .get("models")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut models = Vec::new();
    for id in cli_ids {
        let Some(row) = raw_models
            .iter()
            .find(|row| row.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        else {
            continue;
        };
        if row.get("disabled").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let input = row
            .get("maxInputTokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let output = row
            .get("maxOutputTokens")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if input <= 0 || output <= 0 {
            continue;
        }
        let name = row
            .get("name")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or(id.as_str())
            .to_string();
        let credits = row.get("credits").and_then(credits_value);
        let badges = badge_labels(row.get("tags"));
        models.push(AgentSourceModel {
            id,
            name,
            credits,
            badges,
        });
    }
    if models.is_empty() {
        bail!("WorkBuddy 目录解析后没有可用模型");
    }
    Ok(models)
}

fn refresh_headers(credential: &Credential) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        "Accept",
        "application/json, text/plain, */*".parse().unwrap(),
    );
    headers.insert("X-Requested-With", "XMLHttpRequest".parse().unwrap());
    headers.insert("Origin", "https://www.codebuddy.cn".parse().unwrap());
    headers.insert("Referer", "https://www.codebuddy.cn/".parse().unwrap());
    headers.insert("User-Agent", CLIENT_UA.parse().unwrap());
    headers.insert(
        "X-Refresh-Token",
        credential
            .refresh_token
            .parse()
            .unwrap_or(reqwest::header::HeaderValue::from_static("")),
    );
    headers.insert("X-Auth-Refresh-Source", "workbuddy".parse().unwrap());
    if let Some(enterprise) = credential.enterprise_id.as_ref() {
        if let Ok(value) = enterprise.parse() {
            headers.insert("X-Enterprise-Id", value);
        }
    }
    headers
}

fn chat_headers(credential: &Credential) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {}", credential.access_token)
            .parse()
            .unwrap_or(reqwest::header::HeaderValue::from_static("")),
    );
    headers.insert(
        reqwest::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    headers.insert(
        "Accept",
        "application/json, text/plain, */*".parse().unwrap(),
    );
    headers.insert("X-Requested-With", "XMLHttpRequest".parse().unwrap());
    headers.insert("Origin", "https://www.codebuddy.cn".parse().unwrap());
    headers.insert("Referer", "https://www.codebuddy.cn/".parse().unwrap());
    headers.insert("User-Agent", CLIENT_UA.parse().unwrap());
    headers.insert("X-IDE-Type", "WorkBuddy".parse().unwrap());
    headers.insert("X-IDE-Name", "WorkBuddy".parse().unwrap());
    headers.insert("X-IDE-Version", CLIENT_VERSION.parse().unwrap());
    headers.insert("X-Product", "SaaS".parse().unwrap());
    if credential.uid.is_empty() {
        headers.insert("X-No-User-Id", "1".parse().unwrap());
    } else if let Ok(value) = credential.uid.parse() {
        headers.insert("X-User-Id", value);
    }
    if credential.enterprise_id.as_deref().unwrap_or("").is_empty() {
        headers.insert("X-No-Enterprise-Id", "1".parse().unwrap());
    } else if let Some(Ok(value)) = credential.enterprise_id.as_ref().map(|s| s.parse()) {
        headers.insert("X-Enterprise-Id", value);
    }
    if credential.domain.is_empty() {
        headers.insert("X-No-Department-Info", "1".parse().unwrap());
    } else if let Ok(value) = credential.domain.parse() {
        headers.insert("X-Domain", value);
    }
    headers
}

const CN_BILLING_RESOURCE: &str = "/v2/billing/meter/get-user-resource";
const CN_BILLING_ENTERPRISE: &str = "/v2/billing/meter/get-enterprise-user-usage";

async fn fetch_credits(
    client: &Client,
    credential: &Credential,
) -> Result<AgentSourceCredits, String> {
    if credential
        .enterprise_id
        .as_ref()
        .is_some_and(|id| !id.is_empty())
    {
        fetch_enterprise_credits(client, credential).await
    } else {
        fetch_personal_credits(client, credential).await
    }
}

async fn fetch_personal_credits(
    client: &Client,
    credential: &Credential,
) -> Result<AgentSourceCredits, String> {
    let now = chrono::Local::now();
    let end = now + chrono::Duration::days(365 * 101);
    let fmt = "%Y-%m-%d %H:%M:%S";
    let body = json!({
        "PageNumber": 1,
        "PageSize": 100,
        "ProductCode": "p_tcaca",
        "Status": [0, 3],
        "PackageEndTimeRangeBegin": now.format(fmt).to_string(),
        "PackageEndTimeRangeEnd": end.format(fmt).to_string(),
    });
    let envelope = post_billing(client, credential, CN_BILLING_RESOURCE, body).await?;
    parse_personal_credits(&envelope)
}

async fn fetch_enterprise_credits(
    client: &Client,
    credential: &Credential,
) -> Result<AgentSourceCredits, String> {
    let envelope = post_billing(client, credential, CN_BILLING_ENTERPRISE, json!({})).await?;
    parse_enterprise_credits(&envelope)
}

async fn post_billing(
    client: &Client,
    credential: &Credential,
    path: &str,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .post(format!("{CN_BILLING_BASE}{path}"))
        .headers(chat_headers(credential))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("读取余额失败: {e}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let envelope: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    let code = envelope.get("code").and_then(|v| v.as_i64());
    if !status.is_success() || code != Some(0) {
        return Err(billing_error(status, &envelope));
    }
    Ok(envelope)
}

fn billing_error(status: reqwest::StatusCode, envelope: &Value) -> String {
    let detail = envelope
        .get("msg")
        .or_else(|| envelope.get("message"))
        .and_then(|v| v.as_str())
        .filter(|text| !text.is_empty())
        .unwrap_or("上游没有返回可识别的余额");
    format!("读取余额失败 ({status}): {}", brief(detail))
}

fn brief(text: &str) -> String {
    let trimmed = text.trim();
    let mut out = String::new();
    for (index, ch) in trimmed.chars().enumerate() {
        if index >= 180 {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

pub(crate) fn parse_personal_credits(envelope: &Value) -> Result<AgentSourceCredits, String> {
    let accounts =
        personal_accounts(envelope).ok_or_else(|| "余额响应里没有套餐列表".to_string())?;
    let mut packages = Vec::new();
    let mut total = 0.0;
    for account in accounts {
        let size = number_field(account, "CycleCapacitySize");
        let cycle_remain = number_field(account, "CycleCapacityRemain");
        let cycle_used = number_field(account, "CycleCapacityUsed");
        let capacity_remain = number_field(account, "CapacityRemain");
        let mut remain = if size > 0.0 {
            cycle_remain
        } else if cycle_remain > 0.0 || cycle_used > 0.0 {
            cycle_remain
        } else {
            capacity_remain
        };
        if remain < 0.0 {
            remain = 0.0;
        }
        total += remain;
        let name = account
            .get("PackageName")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .unwrap_or("套餐")
            .to_string();
        let package_size = if size > 0.0 {
            size
        } else {
            number_field(account, "CapacitySize")
        };
        packages.push(AgentSourceCreditPackage {
            name,
            remain,
            size: package_size,
            unlimited: false,
        });
    }
    Ok(AgentSourceCredits {
        total,
        packages,
        ..AgentSourceCredits::default()
    })
}

fn personal_accounts(envelope: &Value) -> Option<&Vec<Value>> {
    const PATHS: &[&[&str]] = &[
        &["data", "Response", "Data", "Accounts"],
        &["Response", "Data", "Accounts"],
        &["data", "Data", "Accounts"],
        &["Data", "Accounts"],
    ];
    PATHS
        .iter()
        .find_map(|path| dig(envelope, path)?.as_array())
}

pub(crate) fn parse_enterprise_credits(envelope: &Value) -> Result<AgentSourceCredits, String> {
    let mut objects = Vec::new();
    collect_objects(envelope, &mut objects);
    let mut limit = None;
    let mut used = None;
    let mut reset = None;
    for object in objects {
        let candidate =
            json_f64(object.get("limitNum")).or_else(|| json_f64(object.get("limit_num")));
        let Some(candidate) = candidate else {
            continue;
        };
        limit = Some(candidate);
        used = json_f64(object.get("credit")).or_else(|| json_f64(object.get("used_num")));
        reset = object
            .get("cycleResetTime")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        break;
    }
    let Some(limit) = limit else {
        return Err("企业余额响应里没有 limitNum / limit_num".into());
    };
    if limit == -1.0 {
        return Ok(AgentSourceCredits {
            unlimited: true,
            cycle_reset_time: reset,
            ..AgentSourceCredits::default()
        });
    }
    let Some(used) = used else {
        return Err("企业余额响应有额度上限，但没有 credit / used_num".into());
    };
    let remain = (limit - used).max(0.0);
    Ok(AgentSourceCredits {
        total: remain,
        packages: vec![AgentSourceCreditPackage {
            name: "企业额度".into(),
            remain,
            size: limit,
            unlimited: false,
        }],
        cycle_reset_time: reset,
        ..AgentSourceCredits::default()
    })
}

fn collect_objects<'a>(value: &'a Value, out: &mut Vec<&'a serde_json::Map<String, Value>>) {
    let Some(object) = value.as_object() else {
        return;
    };
    out.push(object);
    for key in ["data", "Response", "Data"] {
        if let Some(child) = object.get(key) {
            collect_objects(child, out);
        }
    }
}

fn dig<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for key in path {
        current = current.get(*key)?;
    }
    Some(current)
}

fn number_field(value: &Value, key: &str) -> f64 {
    json_f64(value.get(key)).unwrap_or(0.0)
}

fn json_f64(value: Option<&Value>) -> Option<f64> {
    let value = value?;
    if let Some(number) = value.as_f64() {
        return Some(number);
    }
    value.as_str().and_then(|text| text.parse().ok())
}

/// 把上游 `x0.79` / `x0.79 credits` 收成选择器上的 `0.79x`。
pub(crate) fn display_multiplier(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.eq_ignore_ascii_case("credit")
        || trimmed.eq_ignore_ascii_case("credits")
    {
        return None;
    }
    let bare = trim_credits_suffix(trimmed);
    if bare.is_empty() {
        return None;
    }
    let lower = bare.to_ascii_lowercase();
    if lower.ends_with('x') && !lower.starts_with('x') {
        return Some(bare.to_string());
    }
    let number = bare.trim_start_matches(['x', 'X']);
    if number.is_empty() {
        return None;
    }
    Some(format!("{number}x"))
}

fn trim_credits_suffix(input: &str) -> &str {
    let lower = input.to_ascii_lowercase();
    for suffix in [" credits", " credit"] {
        if let Some(stripped) = lower.strip_suffix(suffix) {
            return input[..stripped.len()].trim();
        }
    }
    input
}

fn credits_value(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => display_multiplier(text),
        Value::Number(number) => number.as_f64().map(|n| format!("{n}x")),
        _ => None,
    }
}

fn badge_labels(tags: Option<&Value>) -> Vec<String> {
    let Some(list) = tags.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut badges = Vec::new();
    for tag in list {
        let Some(text) = tag.as_str() else {
            continue;
        };
        let Some(rest) = strip_badge_prefix(text) else {
            continue;
        };
        let label = rest.split(':').next().unwrap_or(rest).trim();
        if label.is_empty() || badges.iter().any(|item| item == label) {
            continue;
        }
        badges.push(label.to_string());
    }
    badges
}

fn strip_badge_prefix(text: &str) -> Option<&str> {
    const PREFIX: &str = "badge:";
    if text.len() >= PREFIX.len() && text[..PREFIX.len()].eq_ignore_ascii_case(PREFIX) {
        Some(&text[PREFIX.len()..])
    } else {
        None
    }
}

struct WorkBuddyProvider {
    credential: Credential,
    client: Client,
    model_id: String,
}

impl WorkBuddyProvider {
    fn body(&self, request: &ChatRequest) -> Value {
        let mut messages = Vec::new();
        for message in &request.messages {
            messages.push(message_json(message));
        }
        let mut body = json!({
            "model": self.model_id,
            "messages": messages,
            "stream": true,
        });
        if let Some(temperature) = request.temperature {
            body["temperature"] = json!(temperature);
        }
        if let Some(max_tokens) = request.max_tokens {
            body["max_tokens"] = json!(max_tokens);
        }
        if let Some(tools) = &request.tools {
            body["tools"] = serde_json::to_value(tools).unwrap_or(Value::Null);
        }
        body
    }
}

fn message_json(message: &ChatMessage) -> Value {
    let role = match message.role {
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
        Role::System => "system",
    };
    let mut value = json!({
        "role": role,
        "content": message.content,
    });
    if let Some(id) = &message.tool_call_id {
        value["tool_call_id"] = json!(id);
    }
    if let Some(calls) = &message.tool_calls {
        value["tool_calls"] = serde_json::to_value(calls).unwrap_or(Value::Null);
    }
    value
}

#[async_trait]
impl AiProvider for WorkBuddyProvider {
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
        let url = format!("{CN_CHAT_BASE}/v2/chat/completions");
        let response = self
            .client
            .post(url)
            .headers(chat_headers(&self.credential))
            .json(&self.body(&request))
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            bail!("WorkBuddy 对话失败 {status}: {text}");
        }
        let stream = response.bytes_stream();
        let buffer = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
        let flush_buffer = buffer.clone();
        let event_stream = stream
            .flat_map(move |chunk| {
                let events = match chunk {
                    Ok(bytes) => {
                        let mut buf = buffer.lock().unwrap();
                        buf.push_str(&String::from_utf8_lossy(&bytes));
                        let mut events = Vec::new();
                        while let Some(pos) = buf.find('\n') {
                            let line: String = buf.drain(..=pos).collect();
                            parse_sse_line(line.trim(), &mut events);
                        }
                        events
                    }
                    Err(err) => vec![Err(anyhow::anyhow!("Stream error: {err}"))],
                };
                futures::stream::iter(events)
            })
            .chain(
                futures::stream::once(async move {
                    let mut buf = flush_buffer.lock().unwrap();
                    std::mem::take(&mut *buf)
                })
                .flat_map(|leftover| {
                    let mut events = Vec::new();
                    let trimmed = leftover.trim();
                    if !trimmed.is_empty() {
                        parse_sse_line(trimmed, &mut events);
                    }
                    futures::stream::iter(events)
                }),
            );
        Ok(Box::pin(event_stream))
    }
}

use std::pin::Pin;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expiry_seconds_become_millis() {
        assert_eq!(expiry_to_ms(1_700_000_000), 1_700_000_000_000);
        assert_eq!(expiry_to_ms(1_700_000_000_000), 1_700_000_000_000);
        assert_eq!(expiry_to_ms(0), 0);
    }

    #[test]
    fn plaintext_auth_reads_nested_account() {
        let text = r#"{"auth":{"accessToken":"atk","refreshToken":"rtk","expiresAt":1700000000,"domain":"d"},"account":{"uid":"u1","nickname":"Ada"}}"#;
        let credential = parse_auth_document(text).unwrap().unwrap();
        assert_eq!(credential.access_token, "atk");
        assert_eq!(credential.nickname.as_deref(), Some("Ada"));
        assert_eq!(account_key(&credential), "u1");
    }

    #[test]
    fn catalog_keeps_cli_rows_only() {
        let data = json!({
            "agents": [{ "name": "cli", "models": ["keep", "drop", "off"] }],
            "models": [
                { "id": "keep", "name": "Keep", "maxInputTokens": 8, "maxOutputTokens": 4 },
                { "id": "drop", "name": "Drop", "maxInputTokens": 0, "maxOutputTokens": 4 },
                { "id": "off", "name": "Off", "disabled": true, "maxInputTokens": 8, "maxOutputTokens": 4 },
                { "id": "other", "name": "Other", "maxInputTokens": 8, "maxOutputTokens": 4 }
            ]
        });
        let models = parse_cli_catalog(&data).unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "keep");
        assert_eq!(models[0].name, "Keep");
        assert_eq!(models[0].credits.as_deref(), None);
        assert!(models[0].badges.is_empty());
    }

    #[test]
    fn catalog_keeps_multiplier_and_badge() {
        let data = json!({
            "agents": [{ "name": "cli", "models": ["keep"] }],
            "models": [{
                "id": "keep",
                "name": "Keep",
                "maxInputTokens": 8,
                "maxOutputTokens": 4,
                "credits": "x0.79 credits",
                "tags": ["badge:限时免费", "other"]
            }]
        });
        let models = parse_cli_catalog(&data).unwrap();
        assert_eq!(models[0].credits.as_deref(), Some("0.79x"));
        assert_eq!(models[0].badges, vec!["限时免费".to_string()]);
    }

    #[test]
    fn multiplier_drops_unit_word() {
        assert_eq!(display_multiplier("x0.79").as_deref(), Some("0.79x"));
        assert_eq!(
            display_multiplier("x0.00 credits").as_deref(),
            Some("0.00x")
        );
        assert_eq!(display_multiplier("0.65x").as_deref(), Some("0.65x"));
        assert_eq!(display_multiplier("credits"), None);
        assert_eq!(display_multiplier("  "), None);
    }

    #[test]
    fn personal_credits_sum_packages() {
        let envelope = json!({
            "code": 0,
            "data": {
                "Response": {
                    "Data": {
                        "Accounts": [
                            {
                                "PackageName": "月度",
                                "CycleCapacitySize": 100,
                                "CycleCapacityRemain": 40,
                                "CycleCapacityUsed": 60
                            },
                            {
                                "PackageName": "加油包",
                                "CycleCapacitySize": 0,
                                "CapacityRemain": 12,
                                "CapacitySize": 20
                            }
                        ]
                    }
                }
            }
        });
        let credits = parse_personal_credits(&envelope).unwrap();
        assert_eq!(credits.total, 52.0);
        assert_eq!(credits.packages.len(), 2);
        assert_eq!(credits.packages[1].remain, 12.0);
        assert!(credits.error.is_none());
    }

    #[test]
    fn personal_credits_reject_missing_accounts() {
        let envelope = json!({ "code": 0, "data": {} });
        assert!(parse_personal_credits(&envelope).is_err());
    }

    #[test]
    fn enterprise_unlimited_is_not_zero() {
        let envelope = json!({
            "code": 0,
            "data": { "limitNum": -1, "cycleResetTime": "2026-10-01 00:00:00" }
        });
        let credits = parse_enterprise_credits(&envelope).unwrap();
        assert!(credits.unlimited);
        assert!(credits.packages.is_empty());
        assert_eq!(
            credits.cycle_reset_time.as_deref(),
            Some("2026-10-01 00:00:00")
        );
    }

    #[test]
    fn enterprise_remain_is_limit_minus_used() {
        let envelope = json!({
            "code": 0,
            "data": { "limit_num": 100, "used_num": 30 }
        });
        let credits = parse_enterprise_credits(&envelope).unwrap();
        assert!(!credits.unlimited);
        assert_eq!(credits.total, 70.0);
        assert_eq!(credits.packages[0].size, 100.0);
    }

    #[test]
    fn envelope_roundtrip_matches_aad() {
        let secret = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
        let key = Sha256::digest(secret.as_bytes());
        let key_id = hex_prefix(&Sha256::digest(key.as_slice()));
        let nonce = [7u8; 12];
        let aad = authenticated_context_aad(&key_id, 1);
        let cipher = Aes256Gcm::new_from_slice(key.as_slice()).unwrap();
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: b"atk",
                    aad: &aad,
                },
            )
            .unwrap();
        let (body, tag) = ciphertext.split_at(ciphertext.len() - 16);
        let wrapped = json!({
            "$wbEncrypted": 1,
            "envelope": B64.encode(serde_json::to_vec(&json!({
                "suite": 1,
                "keyId": key_id,
                "nonce": B64.encode(nonce),
                "authTag": B64.encode(tag),
                "ciphertext": B64.encode(body),
            })).unwrap()),
        });
        assert_eq!(
            open_wrapped_field(key.as_slice(), &wrapped).as_deref(),
            Some("atk")
        );
    }

    fn hex_prefix(bytes: &[u8]) -> String {
        const HEX: &[u8; 16] = b"0123456789abcdef";
        bytes
            .iter()
            .take(8)
            .flat_map(|b| {
                [
                    HEX[(b >> 4) as usize] as char,
                    HEX[(b & 0xf) as usize] as char,
                ]
            })
            .collect()
    }
}
