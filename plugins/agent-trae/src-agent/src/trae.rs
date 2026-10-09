//! Trae Work 国内版与国际版。协议参照 dsh-connect-trae（MIT，Copyright 2026 LaoDing），
//! 按当前上游重写：目录合并多个 function，对话走 `llm_utils_chat`。
//! 上游 function 名仍是 `solo_work_*` 这一路，产品侧已经是 Trae Work。
//! 登录态只留在本进程内存，不写回 Trae 的 storage.json，也不进卡片。

use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use aes::cipher::{BlockDecryptMut, KeyIvInit};
use anyhow::{Result, bail};
use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::{STANDARD as B64, URL_SAFE_NO_PAD};
use cbc::Decryptor;
use futures::{Stream, StreamExt};
use reqwest::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256, Sha512};

use omnipanel_ai::{
    AgentSource, AgentSourceCard, AgentSourceCreditPackage, AgentSourceCredits, AgentSourceModel,
    AiProvider, ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, StopReason, StreamEvent,
    ToolDef, Usage,
};

type Aes128CbcDec = Decryptor<aes::Aes128>;

const APP_ID: &str = "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8";
const AUTH_KEY: &str = "iCubeAuthInfo://icube.cloudide";
const DEVICE_PREFIX: &str = "iCubeAuthInfo://icube-dc:";
const VERSION_CODE_FALLBACK: &str = "20260716";
const REFRESH_MARGIN_MS: i64 = 5 * 60 * 1000;
const CN_CHAT: &str = "https://trae-api-cn.mchost.guru";
const AI_CHAT: &str = "https://coresg-normal.trae.ai";
const CN_PAY: &str = "https://api.trae.cn";
const AI_PAY: &str = "https://growsg-normal.trae.ai";
const MODELS_PATH: &str = "/api/ide/v1/get_detail_param";
const CHAT_PATH: &str = "/api/agent/v3/llm_utils_chat";

const CN_FUNCTIONS: &[&str] = &[
    "solo_work_remote",
    "solo_work_lite",
    "solo_agent_remote",
    "chat_v3",
    "solo_coder",
];
const AI_FUNCTIONS: &[&str] = &[
    "solo_work_remote",
    "solo_work_lite",
    "solo_agent_remote",
    "chat_v3",
];

const SALT_A: [u8; 64] = [
    82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130,
    155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61,
    238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109,
    139, 209, 37,
];
const SALT_B: [u8; 64] = [
    31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25,
    181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200,
    235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33,
    12, 125,
];
const SALT_C: [u8; 64] = [
    191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127,
    101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110,
    131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149,
    168, 209,
];
const SALT_D: [u8; 64] = [
    246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42,
    254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87,
    142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134,
    76, 170,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TraeRegion {
    Cn,
    Ai,
}

impl TraeRegion {
    fn id(self) -> &'static str {
        match self {
            Self::Cn => "trae",
            Self::Ai => "trae-global",
        }
    }

    fn title(self) -> &'static str {
        match self {
            Self::Cn => "Trae",
            Self::Ai => "Trae 国际版",
        }
    }

    fn chat_base(self) -> &'static str {
        match self {
            Self::Cn => CN_CHAT,
            Self::Ai => AI_CHAT,
        }
    }

    fn pay_base(self) -> &'static str {
        match self {
            Self::Cn => CN_PAY,
            Self::Ai => AI_PAY,
        }
    }

    fn functions(self) -> &'static [&'static str] {
        match self {
            Self::Cn => CN_FUNCTIONS,
            Self::Ai => AI_FUNCTIONS,
        }
    }

    fn editions(self) -> &'static [Edition] {
        match self {
            Self::Cn => &[Edition::Cn, Edition::Solo],
            Self::Ai => &[Edition::Sg, Edition::SoloSg],
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Edition {
    Cn,
    Sg,
    Solo,
    SoloSg,
}

impl Edition {
    fn region_hint(self) -> TraeRegion {
        match self {
            Self::Sg | Self::SoloSg => TraeRegion::Ai,
            Self::Cn | Self::Solo => TraeRegion::Cn,
        }
    }

    fn windows_names(self) -> &'static [&'static str] {
        match self {
            Self::Cn => &["Trae CN", "trae-cn"],
            Self::Sg => &["Trae"],
            Self::Solo => &["TRAE SOLO CN", "trae-solo-cn"],
            Self::SoloSg => &["TRAE SOLO"],
        }
    }

    fn bundle_name(self) -> &'static str {
        match self {
            Self::Cn => "Trae CN",
            Self::Sg => "Trae",
            Self::Solo => "TRAE SOLO CN",
            Self::SoloSg => "TRAE SOLO",
        }
    }

    fn linux_names(self) -> &'static [&'static str] {
        match self {
            Self::Cn => &["trae-cn", "Trae CN", "trae", "Trae"],
            Self::Sg => &["trae", "Trae"],
            Self::Solo => &["trae-solo-cn", "TRAE SOLO CN"],
            Self::SoloSg => &["trae-solo", "TRAE SOLO"],
        }
    }

    fn refresh_path(self) -> &'static str {
        match self {
            Self::SoloSg => "/trae/api/v3/oauth/ExchangeToken",
            _ => "/cloudide/api/v3/trae/oauth/ExchangeToken",
        }
    }

    fn client_id(self) -> &'static str {
        match self {
            Self::SoloSg => "en1oxy7wnw8j9n",
            _ => "ono9krqynydwx5",
        }
    }

    fn sends_device_info(self) -> bool {
        matches!(self, Self::SoloSg)
    }
}

#[derive(Clone)]
struct Secrets {
    access_token: String,
    refresh_token: Option<String>,
    user_id: String,
    account_name: Option<String>,
    host: String,
    user_region: Option<String>,
    expires_at_ms: i64,
    edition: Edition,
    machine_id: String,
    device_id: String,
    app_version: Option<String>,
    build_version: Option<String>,
    modified_ms: i64,
}

impl Secrets {
    fn region(&self) -> TraeRegion {
        region_of(self.user_region.as_deref(), &self.host, self.edition)
    }

    fn account_key(&self) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.region().id().as_bytes());
        hasher.update(b"\0");
        hasher.update(self.user_id.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}

struct CatalogEntry {
    model: AgentSourceModel,
    function: String,
}

struct Memory {
    secrets: Option<Secrets>,
    entries: Vec<CatalogEntry>,
    catalog_source: String,
    error: Option<String>,
    credits: Option<AgentSourceCredits>,
}

pub struct TraeSource {
    region: TraeRegion,
    memory: Mutex<Memory>,
}

impl TraeSource {
    pub fn new(region: TraeRegion) -> Self {
        let mut memory = Memory {
            secrets: None,
            entries: Vec::new(),
            catalog_source: "none".into(),
            error: None,
            credits: None,
        };
        if let Err(err) = hydrate(&mut memory, region) {
            memory.error = Some(err);
        }
        Self {
            region,
            memory: Mutex::new(memory),
        }
    }
}

impl AgentSource for TraeSource {
    fn id(&self) -> &str {
        self.region.id()
    }

    fn title(&self) -> &str {
        self.region.title()
    }

    fn card(&self) -> AgentSourceCard {
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        card_from(&memory, self.region)
    }

    fn refresh(&self) -> Result<AgentSourceCard, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| err.to_string())?;
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        runtime.block_on(refresh_memory(&mut memory, self.region))?;
        Ok(card_from(&memory, self.region))
    }

    fn upstream_origin(&self) -> &'static str {
        self.region.chat_base()
    }

    fn open_provider(&self, model_id: &str, client: Client) -> Result<Box<dyn AiProvider>, String> {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|err| err.to_string())?;
        let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        if memory.secrets.is_none() {
            let _ = hydrate(&mut memory, self.region);
        }
        let Some(mut secrets) = memory.secrets.clone() else {
            return Err(format!("未找到 {} 登录", self.region.title()));
        };
        if let Err(err) = runtime.block_on(ensure_fresh(&client, &mut secrets)) {
            if token_expired(secrets.expires_at_ms) {
                return Err(err);
            }
        }
        memory.secrets = Some(secrets.clone());
        let function = memory
            .entries
            .iter()
            .find(|entry| entry.model.id == model_id)
            .map(|entry| entry.function.clone())
            .unwrap_or_else(|| self.region.functions()[0].to_string());
        drop(memory);
        Ok(Box::new(TraeProvider {
            region: self.region,
            secrets,
            client,
            model_id: model_id.to_string(),
            function,
        }))
    }
}

fn card_from(memory: &Memory, region: TraeRegion) -> AgentSourceCard {
    let signed_in = memory.secrets.is_some();
    AgentSourceCard {
        id: region.id().into(),
        title: region.title().into(),
        signed_in,
        account: memory
            .secrets
            .as_ref()
            .and_then(|item| item.account_name.clone()),
        token_expires_at_ms: memory.secrets.as_ref().and_then(|item| {
            if item.expires_at_ms > 0 {
                Some(item.expires_at_ms)
            } else {
                None
            }
        }),
        catalog_source: memory.catalog_source.clone(),
        error: memory.error.clone(),
        models: if signed_in {
            memory
                .entries
                .iter()
                .map(|entry| entry.model.clone())
                .collect()
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

fn hydrate(memory: &mut Memory, region: TraeRegion) -> Result<(), String> {
    match load_best(region)? {
        Some(secrets) => {
            if let Some(saved) = load_catalog_cache(region, &secrets.account_key()) {
                memory.entries = saved;
                memory.catalog_source = "saved".into();
            }
            memory.secrets = Some(secrets);
            Ok(())
        }
        None => Ok(()),
    }
}

async fn refresh_memory(memory: &mut Memory, region: TraeRegion) -> Result<(), String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(25))
        .build()
        .map_err(|err| err.to_string())?;
    let mut logins = load_logins(region)?;
    if logins.is_empty() {
        memory.secrets = None;
        memory.entries.clear();
        memory.catalog_source = "none".into();
        memory.credits = None;
        memory.error = Some(format!("未找到 {} 登录", region.title()));
        return Ok(());
    }
    logins.sort_by_key(|item| std::cmp::Reverse(item.modified_ms));
    let mut last_error = None;
    for mut secrets in logins {
        let _ = ensure_fresh(&client, &mut secrets).await;
        match fetch_models(&client, &secrets, region).await {
            Ok(entries) => {
                remember_catalog(memory, region, &secrets, entries);
                memory.credits = Some(fetch_credits(&client, &secrets, region).await);
                return Ok(());
            }
            Err(err) if is_auth_failure(&err) => {
                if force_refresh(&client, &mut secrets).await.is_ok() {
                    if let Ok(entries) = fetch_models(&client, &secrets, region).await {
                        remember_catalog(memory, region, &secrets, entries);
                        memory.credits = Some(fetch_credits(&client, &secrets, region).await);
                        return Ok(());
                    }
                }
                last_error = Some(
                    "Trae 登录未被接受。请先打开对应的 Trae 客户端，让它刷新登录后再试。".into(),
                );
            }
            Err(err) => last_error = Some(err),
        }
    }
    memory.error = last_error;
    apply_saved(memory, region);
    if let Some(secrets) = memory.secrets.clone() {
        memory.credits = Some(fetch_credits(&client, &secrets, region).await);
    }
    Ok(())
}

fn remember_catalog(
    memory: &mut Memory,
    region: TraeRegion,
    secrets: &Secrets,
    entries: Vec<CatalogEntry>,
) {
    memory.secrets = Some(secrets.clone());
    memory.entries = entries;
    memory.catalog_source = "live".into();
    memory.error = None;
    let _ = save_catalog_cache(region, &secrets.account_key(), &memory.entries);
}

fn apply_saved(memory: &mut Memory, region: TraeRegion) {
    let Some(secrets) = memory.secrets.clone() else {
        memory.entries.clear();
        memory.catalog_source = "none".into();
        return;
    };
    if let Some(saved) = load_catalog_cache(region, &secrets.account_key()) {
        memory.entries = saved;
        memory.catalog_source = "saved".into();
    } else if memory.entries.is_empty() {
        memory.catalog_source = "none".into();
    }
}

fn load_best(region: TraeRegion) -> Result<Option<Secrets>, String> {
    let mut logins = load_logins(region)?;
    logins.sort_by_key(|item| std::cmp::Reverse(item.modified_ms));
    Ok(logins.into_iter().next())
}

fn load_logins(region: TraeRegion) -> Result<Vec<Secrets>, String> {
    let mut found = Vec::new();
    let mut invalid: Option<String> = None;
    for edition in region.editions() {
        for path in desktop_storage_paths(*edition) {
            match read_desktop(&path, *edition) {
                Ok(Some(secrets)) if secrets.region() == region => found.push(secrets),
                Ok(Some(_)) | Ok(None) => {}
                Err(err) => invalid = Some(err),
            }
        }
    }
    if let Some(secrets) = read_cli(region)? {
        if secrets.region() == region {
            found.push(secrets);
        }
    }
    if found.is_empty() {
        if let Some(err) = invalid {
            return Err(err);
        }
    }
    Ok(found)
}

fn desktop_storage_paths(edition: Edition) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if cfg!(windows) {
        if let Ok(appdata) = std::env::var("APPDATA") {
            roots.push(PathBuf::from(appdata));
        }
        if let Some(home) = home_dir() {
            let roaming = home.join("AppData").join("Roaming");
            if !roots.iter().any(|item| item == &roaming) {
                roots.push(roaming);
            }
        }
        roots
            .into_iter()
            .flat_map(|root| {
                edition.windows_names().iter().map(move |name| {
                    root.join(name)
                        .join("User")
                        .join("globalStorage")
                        .join("storage.json")
                })
            })
            .collect()
    } else if cfg!(target_os = "macos") {
        let Some(home) = home_dir() else {
            return Vec::new();
        };
        vec![
            home.join("Library")
                .join("Application Support")
                .join(edition.bundle_name())
                .join("User")
                .join("globalStorage")
                .join("storage.json"),
        ]
    } else {
        let root = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .map(PathBuf::from)
            .or_else(|| home_dir().map(|home| home.join(".config")));
        let Some(root) = root else {
            return Vec::new();
        };
        edition
            .linux_names()
            .iter()
            .map(|name| {
                root.join(name)
                    .join("User")
                    .join("globalStorage")
                    .join("storage.json")
            })
            .collect()
    }
}

fn read_desktop(path: &Path, edition: Edition) -> Result<Option<Secrets>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    let text =
        std::fs::read_to_string(path).map_err(|err| format!("读取 Trae 登录文件失败: {err}"))?;
    let mut secrets = parse_storage_document(&text, edition)?;
    secrets.modified_ms = file_modified_ms(path);
    if secrets.app_version.is_none() {
        secrets.app_version = read_app_version(edition);
    }
    Ok(Some(secrets))
}

fn read_cli(region: TraeRegion) -> Result<Option<Secrets>, String> {
    let Some(home) = home_dir() else {
        return Ok(None);
    };
    let dir_name = match region {
        TraeRegion::Cn => ".trae-cn",
        TraeRegion::Ai => ".trae",
    };
    let home = home.join(dir_name);
    let token_path = home.join("trae-jwt-token");
    if !token_path.is_file() {
        return Ok(None);
    }
    let text = std::fs::read_to_string(&token_path)
        .map_err(|err| format!("读取 Trae CLI 登录失败: {err}"))?;
    let mut secrets = parse_cli_token(&text, region)?;
    secrets.modified_ms = file_modified_ms(&token_path);
    secrets.app_version = read_json_file(&home.join("builtin").join("ide_version.json"))
        .and_then(|doc| non_empty(doc.get("version")));
    if let Some(device) = read_json_file(&home.join("argv.json"))
        .and_then(|doc| non_empty(doc.get("crash-reporter-id")))
    {
        secrets.device_id = device;
    }
    Ok(Some(secrets))
}

fn read_app_version(edition: Edition) -> Option<String> {
    for path in product_json_paths(edition) {
        if let Some(version) =
            read_json_file(&path).and_then(|doc| non_empty(doc.get("appVersion")))
        {
            return Some(version);
        }
    }
    None
}

fn product_json_paths(edition: Edition) -> Vec<PathBuf> {
    if cfg!(windows) {
        let mut roots = Vec::new();
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            roots.push(PathBuf::from(local));
        }
        if let Some(home) = home_dir() {
            let local = home.join("AppData").join("Local");
            if !roots.iter().any(|item| item == &local) {
                roots.push(local);
            }
        }
        roots
            .into_iter()
            .flat_map(|root| {
                edition.windows_names().iter().map(move |name| {
                    root.join("Programs")
                        .join(name)
                        .join("resources")
                        .join("app")
                        .join("product.json")
                })
            })
            .collect()
    } else if cfg!(target_os = "macos") {
        vec![
            PathBuf::from("/Applications")
                .join(format!("{}.app", edition.bundle_name()))
                .join("Contents")
                .join("Resources")
                .join("app")
                .join("product.json"),
        ]
    } else {
        Vec::new()
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn parse_storage_document(text: &str, edition: Edition) -> Result<Secrets, String> {
    let document: Map<String, Value> =
        serde_json::from_str(text).map_err(|_| "Trae 登录文件不是 JSON".to_string())?;
    let raw = document
        .get(AUTH_KEY)
        .and_then(Value::as_str)
        .ok_or_else(|| "Trae 登录文件里没有可用登录态".to_string())?;
    let auth = parse_auth_value(raw)?;
    let machine_id = non_empty(document.get("telemetry.machineId"))
        .ok_or_else(|| "Trae 登录文件里没有机器标识".to_string())?;
    let device_id = device_center_id(&document).unwrap_or_else(|| {
        non_empty(document.get("telemetry.devDeviceId")).unwrap_or_else(|| {
            let mut hasher = Sha256::new();
            hasher.update(machine_id.as_bytes());
            format!("{:x}", hasher.finalize())[..32].to_string()
        })
    });
    let mut secrets = secrets_from_auth(&auth, edition)?;
    secrets.machine_id = machine_id;
    secrets.device_id = device_id;
    secrets.build_version = non_empty(document.get("iCubeLastVersion"));
    Ok(secrets)
}

fn device_center_id(document: &Map<String, Value>) -> Option<String> {
    let mut ids = document
        .keys()
        .filter(|key| key.starts_with(DEVICE_PREFIX))
        .map(|key| key[DEVICE_PREFIX.len()..].trim().to_string())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    if ids.len() == 1 { ids.pop() } else { None }
}

fn parse_auth_value(value: &str) -> Result<Value, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Trae 登录内容为空".into());
    }
    let plaintext = if trimmed.starts_with('{') {
        trimmed.to_string()
    } else {
        decrypt_storage_value(trimmed)?
    };
    serde_json::from_str(&plaintext).map_err(|_| "Trae 登录内容不是 JSON".to_string())
}

fn secrets_from_auth(auth: &Value, edition: Edition) -> Result<Secrets, String> {
    let access_token = non_empty(auth.get("token"))
        .or_else(|| non_empty(auth.get("accessToken")))
        .ok_or_else(|| "Trae 登录里没有 token".to_string())?;
    let account = auth.get("account").cloned().unwrap_or(Value::Null);
    Ok(Secrets {
        access_token,
        refresh_token: non_empty(auth.get("refreshToken")),
        user_id: non_empty(auth.get("userId")).unwrap_or_default(),
        account_name: non_empty(account.get("username")),
        host: non_empty(auth.get("host")).unwrap_or_default(),
        user_region: user_region_claim(auth.get("userRegion")),
        expires_at_ms: time_to_ms(auth.get("expiredAt").or_else(|| auth.get("expiresAt"))),
        edition,
        machine_id: String::new(),
        device_id: String::new(),
        app_version: None,
        build_version: None,
        modified_ms: 0,
    })
}

fn parse_cli_token(text: &str, region: TraeRegion) -> Result<Secrets, String> {
    let trimmed = text.trim();
    let token = if trimmed.starts_with('{') {
        let envelope: Value =
            serde_json::from_str(trimmed).map_err(|_| "Trae CLI 登录不是 JSON".to_string())?;
        non_empty(envelope.get("token"))
            .or_else(|| non_empty(envelope.get("accessToken")))
            .or_else(|| non_empty(envelope.get("jwt")))
            .ok_or_else(|| "Trae CLI 登录里没有 token".to_string())?
    } else {
        trimmed.to_string()
    };
    let mut parts = token.split('.');
    let (_header, payload, signature) = match (parts.next(), parts.next(), parts.next()) {
        (Some(header), Some(payload), Some(signature))
            if !header.is_empty()
                && !payload.is_empty()
                && !signature.is_empty()
                && parts.next().is_none() =>
        {
            (header, payload, signature)
        }
        _ => return Err("Trae CLI 登录不是 JWT".into()),
    };
    let _ = signature;
    let bytes = URL_SAFE_NO_PAD
        .decode(payload)
        .or_else(|_| B64.decode(payload))
        .map_err(|_| "Trae CLI 登录无法解码".to_string())?;
    let claims: Value =
        serde_json::from_slice(&bytes).map_err(|_| "Trae CLI 登录载荷不是 JSON".to_string())?;
    let user_id = non_empty(claims.get("data").and_then(|data| data.get("user_id")))
        .ok_or_else(|| "Trae CLI 登录里没有用户标识".to_string())?;
    let expires_at_ms = claims
        .get("exp")
        .and_then(Value::as_i64)
        .filter(|exp| *exp > 0)
        .map(|exp| exp.saturating_mul(1000))
        .unwrap_or(0);
    let edition = match region {
        TraeRegion::Cn => Edition::Cn,
        TraeRegion::Ai => Edition::Sg,
    };
    let host = match region {
        TraeRegion::Cn => CN_PAY,
        TraeRegion::Ai => AI_PAY,
    };
    let machine_seed = format!("trae-cli-machine\0{user_id}");
    let mut hasher = Sha256::new();
    hasher.update(machine_seed.as_bytes());
    Ok(Secrets {
        access_token: token,
        refresh_token: None,
        user_id,
        account_name: None,
        host: host.into(),
        user_region: None,
        expires_at_ms,
        edition,
        machine_id: format!("{:x}", hasher.finalize()),
        device_id: String::new(),
        app_version: None,
        build_version: None,
        modified_ms: 0,
    })
}

fn file_modified_ms(path: &Path) -> i64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn decrypt_storage_value(encoded: &str) -> Result<String, String> {
    let buffer = B64
        .decode(encoded.trim())
        .map_err(|_| "Trae 登录密文无法解码".to_string())?;
    if buffer.len() <= 102 {
        return Err("Trae 登录密文过短".into());
    }
    let header = &buffer[..6];
    let salt = if header == [0x74, 0x63, 0x05, 0x10, 0x00, 0x00] {
        xor_salt(&SALT_A, &SALT_B)
    } else if header == [18, 57, 32, 32, 2, 3] {
        xor_salt(&SALT_C, &SALT_D)
    } else {
        return Err("不认识的 Trae 登录加密格式".into());
    };
    let random = &buffer[6..38];
    let mut encrypted = buffer[38..].to_vec();
    if encrypted.len() % 16 != 0 {
        return Err("Trae 登录密文长度不正确".into());
    }
    let mut first = Sha512::new();
    first.update(random);
    let first = first.finalize();
    let mut derived = Sha512::new();
    derived.update(first);
    derived.update(salt);
    let derived = derived.finalize();
    let plain = Aes128CbcDec::new_from_slices(&derived[..16], &derived[16..32])
        .map_err(|err| err.to_string())?
        .decrypt_padded_mut::<cbc::cipher::block_padding::Pkcs7>(&mut encrypted)
        .map_err(|_| "Trae 登录解密失败".to_string())?;
    if plain.len() < 64 {
        return Err("Trae 登录明文过短".into());
    }
    let expected = &plain[..64];
    let plaintext = &plain[64..];
    let mut actual = Sha512::new();
    actual.update(plaintext);
    if actual.finalize().as_slice() != expected {
        return Err("Trae 登录校验失败".into());
    }
    String::from_utf8(plaintext.to_vec()).map_err(|_| "Trae 登录明文不是文本".to_string())
}

fn xor_salt(left: &[u8; 64], right: &[u8; 64]) -> [u8; 64] {
    let mut out = [0u8; 64];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = left[index] ^ right[index];
    }
    out
}

fn region_of(user_region: Option<&str>, host: &str, edition: Edition) -> TraeRegion {
    if let Some(region) = user_region.and_then(region_of_claim) {
        return region;
    }
    if let Some(region) = region_of_host(host) {
        return region;
    }
    edition.region_hint()
}

fn region_of_claim(value: &str) -> Option<TraeRegion> {
    match value.trim().to_ascii_lowercase().as_str() {
        "cn" => Some(TraeRegion::Cn),
        "sg" | "ai" => Some(TraeRegion::Ai),
        _ => None,
    }
}

fn region_of_host(host: &str) -> Option<TraeRegion> {
    let host = host.trim();
    if host.is_empty() {
        return None;
    }
    let hostname = host
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if hostname == "trae.ai" || hostname.ends_with(".trae.ai") {
        Some(TraeRegion::Ai)
    } else if hostname == "trae.cn"
        || hostname.ends_with(".trae.cn")
        || hostname.ends_with(".trae.com.cn")
    {
        Some(TraeRegion::Cn)
    } else {
        None
    }
}

fn user_region_claim(value: Option<&Value>) -> Option<String> {
    let value = value?;
    let raw = if value.is_object() {
        value.get("region")?
    } else {
        value
    };
    non_empty(Some(raw))
}

fn non_empty(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

fn time_to_ms(value: Option<&Value>) -> i64 {
    let Some(value) = value else {
        return 0;
    };
    if let Some(number) = value.as_i64() {
        return if number > 1_000_000_000_000 {
            number
        } else if number > 0 {
            number.saturating_mul(1000)
        } else {
            0
        };
    }
    if let Some(text) = value.as_str() {
        if let Ok(number) = text.trim().parse::<i64>() {
            return time_to_ms(Some(&Value::from(number)));
        }
    }
    0
}

fn token_expired(expires_at_ms: i64) -> bool {
    expires_at_ms > 0 && now_ms() >= expires_at_ms
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

fn read_json_file(path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

async fn ensure_fresh(client: &Client, secrets: &mut Secrets) -> Result<(), String> {
    if secrets.refresh_token.is_none() || secrets.host.trim().is_empty() {
        return Ok(());
    }
    if secrets.expires_at_ms == 0 || now_ms() + REFRESH_MARGIN_MS < secrets.expires_at_ms {
        return Ok(());
    }
    let mut body = json!({
        "ClientID": secrets.edition.client_id(),
        "ClientSecret": "-",
        "RefreshToken": secrets.refresh_token,
        "UserID": secrets.user_id,
    });
    if secrets.edition.sends_device_info() {
        body["DeviceInfo"] = json!({
            "DeviceID": secrets.device_id,
            "MachineID": secrets.machine_id,
            "PlatformCode": "SOLO_PC",
            "DeviceType": "PC",
        });
    }
    let url = format!(
        "{}{}",
        secrets.host.trim_end_matches('/'),
        secrets.edition.refresh_path()
    );
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|err| format!("Trae 登录刷新失败: {err}"))?;
    if !response.status().is_success() {
        return Err(format!("Trae 登录刷新失败 {}", response.status()));
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "Trae 登录刷新结果无法解析".to_string())?;
    let result = payload.get("Result").cloned().unwrap_or(Value::Null);
    let access_token = non_empty(result.get("Token"))
        .ok_or_else(|| "Trae 登录刷新没有返回新登录态".to_string())?;
    let expires_at_ms = match result.get("TokenExpireAt") {
        Some(Value::Number(number)) => number.as_i64().unwrap_or(0),
        Some(Value::String(text)) => text.parse::<i64>().unwrap_or(0),
        _ => 0,
    };
    if expires_at_ms <= 0 {
        return Err("Trae 登录刷新没有返回有效期".into());
    }
    secrets.access_token = access_token;
    if let Some(refresh) = non_empty(result.get("RefreshToken")) {
        secrets.refresh_token = Some(refresh);
    }
    secrets.expires_at_ms = expires_at_ms;
    Ok(())
}

async fn force_refresh(client: &Client, secrets: &mut Secrets) -> Result<(), String> {
    secrets.expires_at_ms = now_ms();
    ensure_fresh(client, secrets).await
}

fn is_auth_failure(message: &str) -> bool {
    message.contains("401") || message.contains("403")
}

async fn fetch_models(
    client: &Client,
    secrets: &Secrets,
    region: TraeRegion,
) -> Result<Vec<CatalogEntry>, String> {
    let mut entries = Vec::new();
    let mut failures = Vec::new();
    for function in region.functions() {
        let body = json!({
            "function": function,
            "config_names": null,
            "need_prompt": false,
            "current_config_info": null,
            "poly_prompt": true,
            "mode_type": null,
            "agent_type": null,
        });
        match post_json(
            client,
            secrets,
            &format!("{}{MODELS_PATH}", region.chat_base()),
            &body,
            true,
        )
        .await
        {
            Ok(document) => {
                let list = document
                    .get("config_info_list")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                collect_models(&list, function, &mut entries);
            }
            Err(err) => failures.push(format!("{function}: {err}")),
        }
    }
    if entries.is_empty() {
        let detail = if failures.is_empty() {
            "目录为空".to_string()
        } else {
            failures.join("; ")
        };
        return Err(format!("Trae 模型目录获取失败（{detail}）"));
    }
    Ok(entries)
}

fn collect_models(list: &[Value], function: &str, entries: &mut Vec<CatalogEntry>) {
    for item in list {
        let Some(id) = non_empty(item.get("config_name")) else {
            continue;
        };
        if entries.iter().any(|entry| entry.model.id == id) {
            continue;
        }
        let display = item.get("display_config").cloned().unwrap_or(Value::Null);
        let name = non_empty(display.get("display_name")).unwrap_or_else(|| id.clone());
        let credits = wire_multiplier(item).and_then(format_multiplier);
        entries.push(CatalogEntry {
            model: AgentSourceModel {
                id,
                name,
                credits,
                badges: Vec::new(),
            },
            function: function.to_string(),
        });
    }
}

fn wire_multiplier(config: &Value) -> Option<f64> {
    let raw = config.get("display_contact_config")?.as_str()?;
    let parsed: Value = serde_json::from_str(raw).ok()?;
    let consumption = parsed.get("consumption_rate")?;
    if consumption.get("enable") != Some(&Value::Bool(true)) {
        return None;
    }
    let rate = consumption.get("data")?.get("rate")?.as_f64()?;
    (rate.is_finite() && rate > 0.0).then_some(rate)
}

fn format_multiplier(rate: f64) -> Option<String> {
    if !rate.is_finite() || rate <= 0.0 {
        return None;
    }
    let text = format!("{rate:.4}");
    let trimmed = text.trim_end_matches('0').trim_end_matches('.');
    Some(format!("{trimmed}x"))
}

async fn fetch_credits(
    client: &Client,
    secrets: &Secrets,
    region: TraeRegion,
) -> AgentSourceCredits {
    match region {
        TraeRegion::Cn => {
            let warning = maybe_claim(client, secrets).await.err();
            let mut credits = match usage_snapshot(client, secrets).await {
                Ok(credits) => credits,
                Err(err) => AgentSourceCredits {
                    error: Some(err),
                    ..AgentSourceCredits::default()
                },
            };
            if credits.error.is_none() {
                if let Some(warning) = warning {
                    credits.error = Some(warning);
                }
            }
            credits
        }
        TraeRegion::Ai => match pay_status(client, secrets).await {
            Ok(credits) => credits,
            Err(err) => AgentSourceCredits {
                error: Some(err),
                ..AgentSourceCredits::default()
            },
        },
    }
}

async fn maybe_claim(client: &Client, secrets: &Secrets) -> Result<(), String> {
    let status = post_pay(
        client,
        secrets,
        "/trae/api/v2/ug/checkin_credits/status",
        &json!({}),
        true,
    )
    .await?;
    let enabled = status.get("enable") != Some(&Value::Bool(false));
    let checked_in = status.get("checked_in") == Some(&Value::Bool(true));
    let did_checked_in = status.get("did_checked_in") == Some(&Value::Bool(true));
    if !should_claim(enabled, checked_in, did_checked_in) {
        return Ok(());
    }
    let claim = post_pay(
        client,
        secrets,
        "/trae/api/v2/ug/checkin_credits/claim",
        &json!({}),
        true,
    )
    .await?;
    let code = claim.get("code").and_then(Value::as_i64).unwrap_or(0);
    if claim_is_quiet(code) {
        return Ok(());
    }
    let message = claim
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("签到未成功");
    Err(format!("签到未领取：{}", redact(message)))
}

fn should_claim(enabled: bool, checked_in: bool, did_checked_in: bool) -> bool {
    enabled && !checked_in && !did_checked_in
}

fn claim_is_quiet(code: i64) -> bool {
    code == 0 || code == 9095
}

async fn usage_snapshot(client: &Client, secrets: &Secrets) -> Result<AgentSourceCredits, String> {
    let payload = post_pay(
        client,
        secrets,
        "/trae/api/v2/pay/web_user_ent_usage",
        &json!({ "require_usage": true }),
        false,
    )
    .await?;
    Ok(parse_usage_snapshot(&payload))
}

fn parse_usage_snapshot(payload: &Value) -> AgentSourceCredits {
    let summary = payload.get("usage_summary").cloned().unwrap_or(Value::Null);
    let total_amount = summary
        .get("total_amount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let consumed = summary
        .get("consumed_amount")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let mut remain = (total_amount - consumed).max(0.0);
    let mut packages = Vec::new();
    if let Some(list) = payload
        .get("user_entitlement_pack_list")
        .and_then(Value::as_array)
    {
        for pack in list {
            let quota = pack_quota(pack);
            let consumed_credits = pack
                .get("usage")
                .and_then(|usage| usage.get("credits_amount"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0);
            let size = quota.unwrap_or(0.0);
            let left = if let Some(limit) = quota {
                (limit - consumed_credits).max(0.0)
            } else {
                0.0
            };
            packages.push(AgentSourceCreditPackage {
                name: non_empty(pack.get("display_desc")).unwrap_or_else(|| "积分包".into()),
                remain: left,
                size,
                unlimited: false,
            });
        }
    }
    if remain == 0.0 {
        remain = packages.iter().map(|item| item.remain).sum();
    }
    AgentSourceCredits {
        total: remain,
        unlimited: false,
        packages,
        cycle_reset_time: None,
        error: None,
    }
}

fn pack_quota(pack: &Value) -> Option<f64> {
    let base = pack.get("entitlement_base_info")?;
    let extra = base
        .get("product_extra")
        .and_then(|extra| extra.get("package_extra"))
        .and_then(|extra| extra.get("quota"))
        .and_then(|quota| quota.get("credits_limit"))
        .and_then(Value::as_f64);
    extra.or_else(|| {
        base.get("quota")
            .and_then(|quota| quota.get("credits_limit"))
            .and_then(Value::as_f64)
    })
}

async fn pay_status(client: &Client, secrets: &Secrets) -> Result<AgentSourceCredits, String> {
    let payload = post_pay(
        client,
        secrets,
        "/trae/api/v1/pay/ide_user_pay_status",
        &json!({}),
        false,
    )
    .await?;
    let identity = payload
        .get("user_pay_identity")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let name = non_empty(payload.get("user_pay_identity_str")).unwrap_or_else(|| {
        if identity > 0 {
            "已订阅".into()
        } else {
            "Free".into()
        }
    });
    let paid = identity > 0 || payload.get("has_package") == Some(&Value::Bool(true));
    Ok(AgentSourceCredits {
        total: 0.0,
        unlimited: paid,
        packages: vec![AgentSourceCreditPackage {
            name,
            remain: 0.0,
            size: 0.0,
            unlimited: paid,
        }],
        cycle_reset_time: None,
        error: None,
    })
}

async fn post_pay(
    client: &Client,
    secrets: &Secrets,
    path: &str,
    body: &Value,
    with_device: bool,
) -> Result<Value, String> {
    let region = secrets.region();
    let origin = match region {
        TraeRegion::Cn => "https://www.trae.cn",
        TraeRegion::Ai => "https://www.trae.ai",
    };
    let mut headers = vec![
        (
            "Authorization",
            format!("Cloud-IDE-JWT {}", secrets.access_token),
        ),
        ("Content-Type", "application/json".into()),
        ("User-Agent", "Mozilla/5.0".into()),
        ("Origin", origin.into()),
        ("Referer", format!("{origin}/")),
    ];
    if with_device && !secrets.device_id.is_empty() {
        headers.push(("x-device-id", secrets.device_id.clone()));
    }
    let response = client
        .post(format!("{}{path}", region.pay_base()))
        .headers(header_map(&headers))
        .json(body)
        .send()
        .await
        .map_err(|err| format!("Trae 账户接口失败: {err}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("Trae 账户接口失败 {status}"));
    }
    serde_json::from_str(&text).map_err(|_| "Trae 账户接口结果无法解析".to_string())
}

async fn post_json(
    client: &Client,
    secrets: &Secrets,
    url: &str,
    body: &Value,
    accept_json: bool,
) -> Result<Value, String> {
    let response = client
        .post(url)
        .headers(trae_headers(secrets, accept_json))
        .json(body)
        .send()
        .await
        .map_err(|err| redact(&err.to_string()))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(format!("{status}"));
        }
        return Err(format!("{status} {}", redact(&text)));
    }
    serde_json::from_str(&text).map_err(|_| "Trae 目录结果无法解析".to_string())
}

fn trae_headers(secrets: &Secrets, accept_json: bool) -> HeaderMap {
    let trace = trace_id();
    let version_code = normalize_version_code(secrets.build_version.as_deref());
    let mut pairs = vec![
        (
            "Authorization",
            format!("Cloud-IDE-JWT {}", secrets.access_token),
        ),
        ("X-Ide-Token", secrets.access_token.clone()),
        ("x-plugin-channel", "icube-ai".into()),
        (
            "User-Agent",
            format!(
                "Trae/{}",
                secrets
                    .app_version
                    .clone()
                    .or_else(|| secrets.build_version.clone())
                    .unwrap_or_else(|| "unknown".into())
            ),
        ),
        ("x-app-id", APP_ID.into()),
        ("x-machine-id", secrets.machine_id.clone()),
        ("x-device-id", secrets.device_id.clone()),
        ("x-device-type", device_type().into()),
        ("x-os-version", os_label().into()),
        ("x-app-version-code", version_code.clone()),
        ("x-ide-version-code", version_code),
        ("x-ide-version-type", "stable".into()),
        ("x-custom-trace-id", trace.clone()),
        (
            "x-flow-traceparent",
            format!("04-{trace}-{}-01", &trace[..16]),
        ),
        ("request-traffic-type", "prod".into()),
        ("Content-Type", "application/json".into()),
    ];
    if let Some(version) = &secrets.app_version {
        pairs.push(("x-app-version", version.clone()));
        pairs.push(("x-ide-version", version.clone()));
    }
    if accept_json {
        pairs.push(("Accept", "application/json".into()));
    } else {
        pairs.push(("X-Cloudide-Token", secrets.access_token.clone()));
        pairs.push(("x-uid", secrets.user_id.clone()));
        pairs.push(("x-request-id", trace.clone()));
        pairs.push(("x-trae-request-id", trace));
        pairs.push(("Accept", "text/event-stream".into()));
    }
    header_map(&pairs)
}

fn header_map(pairs: &[(&str, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in pairs {
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let Ok(value) = HeaderValue::from_str(value) else {
            continue;
        };
        map.insert(name, value);
    }
    map
}

fn normalize_version_code(build_version: Option<&str>) -> String {
    match build_version.map(str::trim).filter(|text| !text.is_empty()) {
        Some(text) if text.chars().all(|ch| ch.is_ascii_digit()) => text.to_string(),
        _ => VERSION_CODE_FALLBACK.into(),
    }
}

fn device_type() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "mac"
    } else {
        "linux"
    }
}

fn os_label() -> String {
    if cfg!(windows) {
        "Windows".into()
    } else if cfg!(target_os = "macos") {
        "macOS".into()
    } else {
        "linux".into()
    }
}

fn trace_id() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mixed = now ^ ((std::process::id() as u128) << 64);
    format!("{mixed:032x}")
}

fn redact(text: &str) -> String {
    let cut = text.find("eyJ").unwrap_or(text.len());
    let mut snippet: String = text[..cut]
        .chars()
        .filter(|ch| !ch.is_control())
        .take(180)
        .collect();
    if cut < text.len() {
        snippet.push('…');
    }
    snippet
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedModel {
    id: String,
    name: String,
    #[serde(default)]
    credits: Option<String>,
    #[serde(default)]
    function: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogCache {
    account_key: String,
    models: Vec<CachedModel>,
}

fn cache_path(region: TraeRegion) -> Option<PathBuf> {
    let dir = omnipanel_store::ai_config_dir().ok()?.join("agent-sources");
    std::fs::create_dir_all(&dir).ok()?;
    let name = match region {
        TraeRegion::Cn => "trae.json",
        TraeRegion::Ai => "trae-global.json",
    };
    Some(dir.join(name))
}

fn save_catalog_cache(
    region: TraeRegion,
    account_key: &str,
    entries: &[CatalogEntry],
) -> Result<(), String> {
    let path = cache_path(region).ok_or_else(|| "无法写入模型目录缓存".to_string())?;
    let payload = CatalogCache {
        account_key: account_key.to_string(),
        models: entries
            .iter()
            .map(|entry| CachedModel {
                id: entry.model.id.clone(),
                name: entry.model.name.clone(),
                credits: entry.model.credits.clone(),
                function: entry.function.clone(),
            })
            .collect(),
    };
    let text = serde_json::to_string(&payload).map_err(|err| err.to_string())?;
    std::fs::write(path, text).map_err(|err| err.to_string())
}

fn load_catalog_cache(region: TraeRegion, account_key: &str) -> Option<Vec<CatalogEntry>> {
    let text = std::fs::read_to_string(cache_path(region)?).ok()?;
    let parsed: CatalogCache = serde_json::from_str(&text).ok()?;
    if parsed.account_key != account_key || parsed.models.is_empty() {
        return None;
    }
    Some(
        parsed
            .models
            .into_iter()
            .map(|item| CatalogEntry {
                function: if item.function.is_empty() {
                    region.functions()[0].to_string()
                } else {
                    item.function
                },
                model: AgentSourceModel {
                    id: item.id,
                    name: item.name,
                    credits: item.credits,
                    badges: Vec::new(),
                },
            })
            .collect(),
    )
}

struct TraeProvider {
    region: TraeRegion,
    secrets: Secrets,
    client: Client,
    model_id: String,
    function: String,
}

fn chat_body(request: &ChatRequest, model_id: &str, function: &str) -> Result<Value> {
    let mut body = json!({
        "messages": messages_json(&request.messages)?,
        "model": model_id,
        "config_name": model_id,
        "function": function,
        "stream": true,
    });
    if let Some(tools) = &request.tools {
        body["tools"] = tools_json(tools);
    }
    if let Some(effort) = &request.reasoning_effort {
        body["reasoning_effort"] = json!(effort);
    }
    Ok(body)
}

fn messages_json(messages: &[ChatMessage]) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    for message in messages {
        let role = match message.role {
            Role::System => "system",
            Role::User => "user",
            Role::Assistant => "assistant",
            Role::Tool => "tool",
        };
        let mut value = json!({ "role": role });
        if message.role == Role::Tool {
            let Some(id) = message.tool_call_id.as_ref().filter(|id| !id.is_empty()) else {
                bail!("Trae 工具结果缺少 tool_call_id");
            };
            value["tool_call_id"] = json!(id);
        }
        if !message.content.is_empty() || message.role != Role::Assistant {
            value["content"] = json!([{ "type": "text", "text": message.content }]);
        }
        if let Some(calls) = &message.tool_calls {
            value["tool_calls"] = Value::Array(
                calls
                    .iter()
                    .map(|call| {
                        json!({
                            "id": call.id,
                            "type": call.call_type,
                            "function_call": {
                                "name": call.function.name,
                                "arguments": call.function.arguments,
                            }
                        })
                    })
                    .collect(),
            );
        }
        out.push(value);
    }
    Ok(out)
}

fn tools_json(tools: &[ToolDef]) -> Value {
    Value::Array(
        tools
            .iter()
            .map(|tool| {
                let parameters = if tool.function.parameters.is_object()
                    || tool.function.parameters.is_array()
                {
                    Value::String(tool.function.parameters.to_string())
                } else {
                    tool.function.parameters.clone()
                };
                json!({
                    "type": tool.tool_type,
                    "function": {
                        "name": tool.function.name,
                        "description": tool.function.description,
                        "parameters": parameters,
                    }
                })
            })
            .collect(),
    )
}

struct PendingTool {
    id: String,
    name: String,
    arguments: String,
    emitted: bool,
}

struct Decoder {
    buffer: String,
    event: Option<String>,
    data: Vec<String>,
    saw_tool: bool,
    finished: bool,
    pending_tools: Vec<PendingTool>,
}

impl Decoder {
    fn new() -> Self {
        Self {
            buffer: String::new(),
            event: None,
            data: Vec::new(),
            saw_tool: false,
            finished: false,
            pending_tools: Vec::new(),
        }
    }

    fn push(&mut self, chunk: &str) -> Vec<StreamEvent> {
        self.buffer.push_str(chunk);
        let mut events = Vec::new();
        while let Some(pos) = self.buffer.find(['\n', '\r']) {
            let line: String = self.buffer.drain(..=pos).collect();
            let line = line.trim_end_matches(['\n', '\r']);
            if let Some(event) = self.consume_line(line) {
                events.extend(event);
            }
        }
        events
    }

    fn finish(&mut self) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        if !self.buffer.is_empty() {
            let line = std::mem::take(&mut self.buffer);
            if let Some(event) = self.consume_line(line.trim_end_matches(['\n', '\r'])) {
                events.extend(event);
            }
        }
        if let Some(event) = self.dispatch() {
            events.extend(event);
        }
        if !self.finished {
            events.extend(self.done(None));
        }
        events
    }

    fn consume_line(&mut self, line: &str) -> Option<Vec<StreamEvent>> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (line, ""),
        };
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<Vec<StreamEvent>> {
        if self.data.is_empty() {
            self.event = None;
            return None;
        }
        let event_name = self.event.take();
        let data = std::mem::take(&mut self.data).join("\n");
        Some(self.decode(event_name.as_deref(), &data))
    }

    fn decode(&mut self, event: Option<&str>, data: &str) -> Vec<StreamEvent> {
        if data == "[DONE]" {
            return self.done(None);
        }
        let Ok(payload) = serde_json::from_str::<Value>(data) else {
            return Vec::new();
        };
        if event == Some("error") || is_error_payload(event, &payload) {
            let message = payload
                .get("message")
                .or_else(|| payload.get("msg"))
                .and_then(Value::as_str)
                .unwrap_or("Trae 对话失败");
            return self.fail(&redact(message));
        }
        if event == Some("token_usage") {
            let input = as_u32(payload.get("prompt_tokens")).unwrap_or(0);
            let output = as_u32(payload.get("completion_tokens")).unwrap_or(0);
            if input == 0 && output == 0 {
                return Vec::new();
            }
            return vec![StreamEvent::Usage {
                input_tokens: input,
                output_tokens: output,
            }];
        }
        if event == Some("done")
            || (payload
                .get("finish_reason")
                .and_then(Value::as_str)
                .is_some()
                && payload.get("response").is_none())
        {
            return self.done(payload.get("finish_reason").and_then(Value::as_str));
        }
        if event == Some("output")
            || payload.get("response").is_some()
            || payload.get("reasoning_content").is_some()
        {
            let mut events = Vec::new();
            if let Some(text) = payload.get("reasoning_content").and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(StreamEvent::ReasoningDelta {
                        text: text.to_string(),
                    });
                }
            }
            if let Some(text) = payload.get("response").and_then(Value::as_str) {
                if !text.is_empty() {
                    events.push(StreamEvent::ContentDelta {
                        text: text.to_string(),
                    });
                }
            }
            if let Some(calls) = payload.get("tool_calls") {
                events.extend(self.absorb_tools(calls));
            }
            return events;
        }
        if let Some(calls) = payload.get("tool_calls") {
            return self.absorb_tools(calls);
        }
        Vec::new()
    }

    /// Trae 把 `arguments` 拆成多段。名字往往只在第一段出现，后面只追加 JSON 碎片。
    /// 拼成完整 JSON 再交给宿主，避免终端拿到 `{"` 后空等超时。
    fn absorb_tools(&mut self, calls: &Value) -> Vec<StreamEvent> {
        let Some(list) = calls.as_array() else {
            return Vec::new();
        };
        for (index, call) in list.iter().enumerate() {
            let function = call
                .get("function_call")
                .or_else(|| call.get("function"))
                .cloned()
                .unwrap_or(Value::Null);
            let name = non_empty(function.get("name")).unwrap_or_default();
            let arguments = match function.get("arguments") {
                Some(Value::String(text)) => text.clone(),
                Some(value) if !value.is_null() => value.to_string(),
                _ => String::new(),
            };
            let id = non_empty(call.get("id")).unwrap_or_default();
            if let Some(slot) = self.tool_slot(&id, index, name.is_empty()) {
                if slot.name.is_empty() {
                    slot.name = name;
                }
                merge_tool_arguments(&mut slot.arguments, &arguments);
            } else if !name.is_empty() || !arguments.is_empty() {
                self.pending_tools.push(PendingTool {
                    id: if id.is_empty() {
                        format!("trae-tool-{index}")
                    } else {
                        id
                    },
                    name,
                    arguments,
                    emitted: false,
                });
            }
        }
        self.flush_tools(false)
    }

    fn tool_slot(&mut self, id: &str, index: usize, args_only: bool) -> Option<&mut PendingTool> {
        if !id.is_empty() {
            if let Some(pos) = self.pending_tools.iter().position(|tool| tool.id == id) {
                return Some(&mut self.pending_tools[pos]);
            }
        }
        let fallback = format!("trae-tool-{index}");
        if let Some(pos) = self
            .pending_tools
            .iter()
            .position(|tool| tool.id == fallback)
        {
            return Some(&mut self.pending_tools[pos]);
        }
        if args_only {
            return self
                .pending_tools
                .iter_mut()
                .rev()
                .find(|tool| !tool.emitted);
        }
        None
    }

    fn flush_tools(&mut self, force: bool) -> Vec<StreamEvent> {
        let mut events = Vec::new();
        for tool in &mut self.pending_tools {
            if tool.emitted || tool.name.is_empty() {
                continue;
            }
            if !force && !tool_arguments_complete(&tool.arguments) {
                continue;
            }
            tool.emitted = true;
            self.saw_tool = true;
            events.push(StreamEvent::ToolCall {
                id: tool.id.clone(),
                name: tool.name.clone(),
                arguments: tool.arguments.clone(),
            });
        }
        events
    }

    fn done(&mut self, finish_reason: Option<&str>) -> Vec<StreamEvent> {
        if self.finished {
            return Vec::new();
        }
        let mut events = self.flush_tools(true);
        self.finished = true;
        let stop_reason =
            if self.saw_tool || matches!(finish_reason, Some("tool_calls" | "tool_use")) {
                StopReason::ToolUse
            } else if finish_reason == Some("length") {
                StopReason::MaxTokens
            } else {
                StopReason::EndTurn
            };
        events.push(StreamEvent::Done { stop_reason });
        events
    }

    fn fail(&mut self, message: &str) -> Vec<StreamEvent> {
        if self.finished {
            return Vec::new();
        }
        self.finished = true;
        vec![
            StreamEvent::Error {
                message: message.to_string(),
            },
            StreamEvent::Done {
                stop_reason: StopReason::Error,
            },
        ]
    }
}

fn merge_tool_arguments(current: &mut String, incoming: &str) {
    if incoming.is_empty() {
        return;
    }
    if current.is_empty() || incoming.starts_with(current.as_str()) {
        *current = incoming.to_string();
        return;
    }
    if current.starts_with(incoming) {
        return;
    }
    current.push_str(incoming);
}

fn tool_arguments_complete(arguments: &str) -> bool {
    let trimmed = arguments.trim();
    if !trimmed.starts_with('{') && !trimmed.starts_with('[') {
        return false;
    }
    serde_json::from_str::<Value>(trimmed)
        .ok()
        .is_some_and(|value| value.is_object() || value.is_array())
}

fn is_error_payload(event: Option<&str>, payload: &Value) -> bool {
    if event == Some("token_usage") || event == Some("done") || event == Some("output") {
        return false;
    }
    let code = payload.get("code").and_then(Value::as_i64).unwrap_or(0);
    code != 0
        && payload.get("response").is_none()
        && payload.get("message").and_then(Value::as_str).is_some()
}

fn as_u32(value: Option<&Value>) -> Option<u32> {
    let value = value?;
    value
        .as_u64()
        .and_then(|number| u32::try_from(number).ok())
        .or_else(|| {
            value.as_f64().and_then(|number| {
                if number >= 0.0 && number <= u32::MAX as f64 {
                    Some(number as u32)
                } else {
                    None
                }
            })
        })
}

#[async_trait]
impl AiProvider for TraeProvider {
    fn name(&self) -> &str {
        self.region.id()
    }

    fn models(&self) -> Vec<ModelInfo> {
        vec![ModelInfo {
            id: self.model_id.clone(),
            name: self.model_id.clone(),
            provider: self.region.id().into(),
            context_window: None,
        }]
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        let mut stream = self.chat_stream(request).await?;
        let mut content = String::new();
        let mut usage = Usage::default();
        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::ContentDelta { text } => content.push_str(&text),
                StreamEvent::Usage {
                    input_tokens,
                    output_tokens,
                } => {
                    usage.input_tokens = input_tokens;
                    usage.output_tokens = output_tokens;
                }
                StreamEvent::Error { message } => bail!(message),
                _ => {}
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
            usage,
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>> {
        let body = chat_body(&request, &self.model_id, &self.function)?;
        let response = self
            .client
            .post(format!("{}{CHAT_PATH}", self.region.chat_base()))
            .headers(trae_headers(&self.secrets, false))
            .json(&body)
            .send()
            .await?;
        if !response.status().is_success() {
            let status = response.status();
            let text = response.text().await.unwrap_or_default();
            bail!("Trae 对话失败 {status}: {}", redact(&text));
        }
        let decoder = Arc::new(Mutex::new(Decoder::new()));
        let stream_decoder = decoder.clone();
        let finish_decoder = decoder;
        let event_stream = response
            .bytes_stream()
            .flat_map(move |chunk| {
                let events = match chunk {
                    Ok(bytes) => {
                        let mut decoder = stream_decoder.lock().unwrap_or_else(|p| p.into_inner());
                        decoder
                            .push(&String::from_utf8_lossy(&bytes))
                            .into_iter()
                            .map(Ok)
                            .collect::<Vec<_>>()
                    }
                    Err(err) => vec![Ok(StreamEvent::Error {
                        message: format!("Trae 流中断: {err}"),
                    })],
                };
                futures::stream::iter(events)
            })
            .chain(
                futures::stream::once(async move {
                    let mut decoder = finish_decoder.lock().unwrap_or_else(|p| p.into_inner());
                    decoder.finish()
                })
                .flat_map(|events| futures::stream::iter(events.into_iter().map(Ok))),
            );
        Ok(Box::pin(event_stream))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnipanel_ai::{FunctionCall, FunctionDef, ToolCall};

    #[test]
    fn plaintext_storage_reads_cn_account() {
        let text = r#"{
            "iCubeAuthInfo://icube.cloudide": "{\"token\":\"atk\",\"userId\":\"u1\",\"host\":\"https://api.trae.cn\",\"expiredAt\":1700000000000,\"refreshToken\":\"rtk\",\"userRegion\":{\"region\":\"CN\"},\"account\":{\"username\":\"ada\"}}",
            "telemetry.machineId": "machine-1",
            "iCubeAuthInfo://icube-dc:device-9": {}
        }"#;
        let secrets = parse_storage_document(text, Edition::Cn).unwrap();
        assert_eq!(secrets.access_token, "atk");
        assert_eq!(secrets.user_id, "u1");
        assert_eq!(secrets.account_name.as_deref(), Some("ada"));
        assert_eq!(secrets.machine_id, "machine-1");
        assert_eq!(secrets.device_id, "device-9");
        assert_eq!(secrets.region(), TraeRegion::Cn);
        assert_eq!(secrets.expires_at_ms, 1_700_000_000_000);
    }

    #[test]
    fn host_suffix_routes_international_credential() {
        assert_eq!(
            region_of(None, "https://coresg-normal.trae.ai", Edition::Cn),
            TraeRegion::Ai
        );
        assert_eq!(
            region_of(Some("sg"), "https://api.trae.cn", Edition::Cn),
            TraeRegion::Ai
        );
        assert_eq!(region_of(None, "", Edition::Solo), TraeRegion::Cn);
    }

    #[test]
    fn dotted_build_version_uses_numeric_fallback() {
        assert_eq!(
            normalize_version_code(Some("2.3.76922")),
            VERSION_CODE_FALLBACK
        );
        assert_eq!(normalize_version_code(Some("20260716")), "20260716");
        assert_eq!(normalize_version_code(None), VERSION_CODE_FALLBACK);
    }

    #[test]
    fn short_ciphertext_is_rejected() {
        assert!(decrypt_storage_value("YQ==").is_err());
    }

    #[test]
    fn first_directory_function_owns_the_model() {
        let mut entries = Vec::new();
        let row = json!({
            "config_name": "glm-5.2",
            "display_config": { "display_name": "GLM-5.2" },
            "display_contact_config": "{\"consumption_rate\":{\"enable\":true,\"data\":{\"rate\":0.79}}}"
        });
        collect_models(&[row.clone()], "solo_work_remote", &mut entries);
        collect_models(&[row], "solo_work_lite", &mut entries);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].function, "solo_work_remote");
        assert_eq!(entries[0].model.credits.as_deref(), Some("0.79x"));
        assert_eq!(entries[0].model.name, "GLM-5.2");
    }

    #[test]
    fn disabled_rate_is_not_shown() {
        let row = json!({
            "config_name": "gpt",
            "display_contact_config": "{\"consumption_rate\":{\"enable\":false,\"data\":{\"rate\":1}}}"
        });
        let mut entries = Vec::new();
        collect_models(std::slice::from_ref(&row), "chat_v3", &mut entries);
        assert!(entries[0].model.credits.is_none());
    }

    #[test]
    fn chat_body_rewrites_tools_and_roles() {
        let request = ChatRequest {
            model: "glm-5.2".into(),
            messages: vec![
                ChatMessage {
                    role: Role::Assistant,
                    content: String::new(),
                    tool_call_id: None,
                    name: None,
                    tool_calls: Some(vec![ToolCall {
                        id: "call-1".into(),
                        call_type: "function".into(),
                        function: FunctionCall {
                            name: "omni_terminal_exec".into(),
                            arguments: "{\"cmd\":\"Get-Date\"}".into(),
                        },
                    }]),
                },
                ChatMessage {
                    role: Role::Tool,
                    content: "ok".into(),
                    tool_call_id: Some("call-1".into()),
                    tool_calls: None,
                    name: None,
                },
            ],
            stream: true,
            tools: Some(vec![ToolDef {
                tool_type: "function".into(),
                function: FunctionDef {
                    name: "omni_terminal_exec".into(),
                    description: "run".into(),
                    parameters: json!({ "type": "object" }),
                },
            }]),
            temperature: None,
            max_tokens: None,
            enable_thinking: None,
            reasoning_effort: Some("high".into()),
        };
        let body = chat_body(&request, "glm-5.2", "solo_work_remote").unwrap();
        assert_eq!(body["function"], "solo_work_remote");
        assert_eq!(body["config_name"], "glm-5.2");
        assert!(body["tools"][0]["function"]["parameters"].is_string());
        assert!(body["messages"][0].get("content").is_none());
        assert_eq!(
            body["messages"][0]["tool_calls"][0]["function_call"]["name"],
            "omni_terminal_exec"
        );
        assert!(
            body["messages"][0]["tool_calls"][0]
                .get("function")
                .is_none()
        );
        assert_eq!(body["messages"][1]["content"][0]["text"], "ok");
    }

    #[test]
    fn output_event_becomes_text_reasoning_and_tool() {
        let mut decoder = Decoder::new();
        let raw = "event: output\ndata: {\"response\":\"你好\",\"reasoning_content\":\"想\",\"tool_calls\":[{\"id\":\"c1\",\"function_call\":{\"name\":\"lookup\",\"arguments\":{\"q\":1}}}]}\n\n";
        let events = decoder.push(raw);
        assert!(matches!(events[0], StreamEvent::ReasoningDelta { .. }));
        assert!(matches!(events[1], StreamEvent::ContentDelta { .. }));
        match &events[2] {
            StreamEvent::ToolCall {
                name, arguments, ..
            } => {
                assert_eq!(name, "lookup");
                assert!(arguments.contains("\"q\""));
            }
            other => panic!("unexpected {other:?}"),
        }
        let done = decoder.finish();
        assert!(matches!(
            done[0],
            StreamEvent::Done {
                stop_reason: StopReason::ToolUse
            }
        ));
    }

    #[test]
    fn tool_argument_fragments_are_joined_before_emit() {
        let mut decoder = Decoder::new();
        let first = decoder.push(
            "event: output\ndata: {\"tool_calls\":[{\"id\":\"c1\",\"function_call\":{\"name\":\"omni_terminal_exec\",\"arguments\":\"{\\\"\"}}]}\n\n",
        );
        assert!(first.is_empty());
        let second = decoder.push(
            "event: output\ndata: {\"tool_calls\":[{\"id\":\"c1\",\"function_call\":{\"arguments\":\"command\\\":\\\"Get-Date\\\"}\"}}]}\n\n",
        );
        match second.as_slice() {
            [StreamEvent::ToolCall { name, arguments, .. }] => {
                assert_eq!(name, "omni_terminal_exec");
                assert_eq!(arguments, "{\"command\":\"Get-Date\"}");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn error_event_stops_the_turn() {
        let mut decoder = Decoder::new();
        let events = decoder
            .push("event: error\ndata: {\"code\":4001,\"message\":\"param is invalid\"}\n\n");
        assert!(matches!(events[0], StreamEvent::Error { .. }));
        assert!(matches!(
            events[1],
            StreamEvent::Done {
                stop_reason: StopReason::Error
            }
        ));
        assert!(decoder.finish().is_empty());
    }

    #[test]
    fn checkin_runs_once_per_device_day() {
        assert!(should_claim(true, false, false));
        assert!(!should_claim(true, true, false));
        assert!(!should_claim(true, false, true));
        assert!(!should_claim(false, false, false));
        assert!(claim_is_quiet(0));
        assert!(claim_is_quiet(9095));
        assert!(!claim_is_quiet(9004));
    }

    #[test]
    fn usage_snapshot_uses_remaining_credits() {
        let payload = json!({
            "usage_summary": { "total_amount": 100, "consumed_amount": 40 },
            "user_entitlement_pack_list": [{
                "display_desc": "签到",
                "entitlement_base_info": { "quota": { "credits_limit": 20 } },
                "usage": { "credits_amount": 5 }
            }]
        });
        let credits = parse_usage_snapshot(&payload);
        assert_eq!(credits.total, 60.0);
        assert_eq!(credits.packages[0].remain, 15.0);
        assert!(credits.error.is_none());
    }
}
