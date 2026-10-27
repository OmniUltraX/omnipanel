//! OpenCode Go 订阅：优先插件设置中的 API Key，否则读取本机 OpenCode CLI 的 `auth.json`。
//! 协议参考社区插件 [dsh-opencode-go](https://github.com/Duskriver/dsh-opencode-go)（MIT）。

use std::pin::Pin;
use std::sync::Mutex;
use std::time::Duration;

use anyhow::{Result, bail};
use async_trait::async_trait;
use futures::{Stream, StreamExt};
use reqwest::Client;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use omnipanel_ai::{
    AgentSource, AgentSourceCard, AgentSourceCreditPackage, AgentSourceCredits, AgentSourceModel,
    AiProvider, ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, StreamEvent, Usage,
};
use omnipanel_store::{Storage, Vault, meta_db_path, plugin_secret_ref};

use std::collections::HashMap;

use crate::local_opencode::{load_from_local_cli, local_opencode_present};
use crate::model_metadata::{WireApi, fetch_opencode_go_wire_apis};
use crate::wire_chat::{chat_stream_wire, resolve_wire_api, response_to_stream};

pub const SOURCE_ID: &str = "opencode-go";
const TITLE: &str = "OpenCode Go";
const PLUGIN_ID: &str = "omni.agent.opencode-go";
const DEFAULT_BASE_URL: &str = "https://opencode.ai/zen/go/v1";
const SECRET_API_KEY: &str = "config:apiKey";
const USER_AGENT: &str = "OmniPanel/1.0 (OpenCode Go agent)";

struct RuntimeConfig {
    api_key: String,
    base_url: String,
    account_label: String,
}

struct Memory {
    models: Vec<AgentSourceModel>,
    wire_apis: HashMap<String, WireApi>,
    catalog_source: String,
    error: Option<String>,
    credits: Option<AgentSourceCredits>,
    account: Option<String>,
}

pub struct OpencodeGoSource {
    memory: Mutex<Memory>,
}

impl OpencodeGoSource {
    pub fn new() -> Self {
        let memory = Memory {
            models: Vec::new(),
            wire_apis: HashMap::new(),
            catalog_source: "none".into(),
            error: None,
            credits: None,
            account: None,
        };
        let source = Self {
            memory: Mutex::new(memory),
        };
        if let Ok(client) = Client::builder().timeout(Duration::from_secs(60)).build() {
            let fresh = refresh_blocking(&client);
            *source.memory.lock().unwrap_or_else(|p| p.into_inner()) = fresh;
        }
        source
    }
}

impl Default for OpencodeGoSource {
    fn default() -> Self {
        Self::new()
    }
}

fn plugin_base_url_from_state() -> Option<String> {
    let path = meta_db_path().ok()?;
    let storage = Storage::open(&path, None).ok()?;
    let raw = storage.plugin_state_get(PLUGIN_ID).ok()?;
    let root: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    root.get("configuration")
        .and_then(|c| c.get("baseUrl"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
}

fn resolve_base_url(plugin_override: Option<String>, local_override: Option<String>) -> String {
    plugin_override
        .or(local_override)
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn load_runtime_config() -> Result<RuntimeConfig, String> {
    let plugin_base = plugin_base_url_from_state();
    let reference = plugin_secret_ref(PLUGIN_ID, SECRET_API_KEY).map_err(|e| e.to_string())?;
    if let Ok(api_key) = Vault::get(&reference) {
        let api_key = api_key.trim();
        if !api_key.is_empty() {
            return Ok(RuntimeConfig {
                api_key: api_key.to_string(),
                base_url: resolve_base_url(plugin_base, None),
                account_label: "OpenCode Go（插件设置）".into(),
            });
        }
    }
    if let Some(local) = load_from_local_cli() {
        return Ok(RuntimeConfig {
            api_key: local.api_key,
            base_url: resolve_base_url(plugin_base, local.base_url),
            account_label: "OpenCode Go（本机 CLI）".into(),
        });
    }
    if local_opencode_present() {
        Err(
            "本机已安装 OpenCode，但未在 auth.json 中找到 OpenCode Go 的 API Key；请在 OpenCode 里 /connect OpenCode Go，或在插件设置中填写 Key"
                .into(),
        )
    } else {
        Err(
            "未配置 API Key：在插件设置中填写，或安装 OpenCode CLI 并通过 /connect 保存 OpenCode Go 凭据"
                .into(),
        )
    }
}

fn auth_headers(
    api_key: &str,
    session_id: &str,
    accept: &'static str,
) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        reqwest::header::AUTHORIZATION,
        format!("Bearer {api_key}").parse().expect("authorization"),
    );
    headers.insert(reqwest::header::ACCEPT, accept.parse().expect("accept"));
    // 对话必须声明 event-stream，并拒绝 gzip。否则网关会把整段 SSE 缓冲完再返回，
    // 界面上就像不是流式，工具调用也要等生成结束才开始。
    if accept.contains("text/event-stream") {
        headers.insert(
            reqwest::header::ACCEPT_ENCODING,
            "identity".parse().expect("accept-encoding"),
        );
    }
    headers.insert(
        reqwest::header::USER_AGENT,
        USER_AGENT.parse().expect("user-agent"),
    );
    headers.insert(
        reqwest::header::HeaderName::from_static("x-opencode-session"),
        session_id.parse().expect("session"),
    );
    headers
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Option<Vec<ModelRow>>,
}

#[derive(Debug, Deserialize)]
struct ModelRow {
    id: String,
    #[serde(default)]
    name: Option<String>,
}

fn fetch_models(client: &Client, cfg: &RuntimeConfig) -> Result<Vec<AgentSourceModel>, String> {
    let url = format!("{}/models", cfg.base_url);
    let session = Uuid::new_v4().to_string();
    let api_key = cfg.api_key.clone();
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(async move {
            let response = client
                .get(&url)
                .headers(auth_headers(&api_key, &session, "application/json"))
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("拉取模型目录失败: {e}"))?;
            let status = response.status();
            if !status.is_success() {
                let text = response.text().await.unwrap_or_default();
                return Err(format!("模型目录 HTTP {status}: {text}"));
            }
            let body: ModelsResponse = response
                .json()
                .await
                .map_err(|e| format!("模型目录 JSON 无效: {e}"))?;
            let rows = body.data.unwrap_or_default();
            let models = rows
                .into_iter()
                .filter_map(|row| {
                    let id = row.id.trim();
                    if id.is_empty() {
                        return None;
                    }
                    let name = row
                        .name
                        .as_ref()
                        .map(|n| n.trim())
                        .filter(|n| !n.is_empty())
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| id.to_string());
                    Some(AgentSourceModel {
                        id: id.to_string(),
                        name,
                        credits: None,
                        badges: Vec::new(),
                    })
                })
                .collect::<Vec<_>>();
            if models.is_empty() {
                return Err("模型目录为空".into());
            }
            Ok(models)
        })
}

#[derive(Debug, Deserialize)]
struct UsageEnvelope {
    usage: Option<UsageBody>,
}

#[derive(Debug, Deserialize)]
struct UsageBody {
    rolling: Option<UsageWindow>,
    weekly: Option<UsageWindow>,
    monthly: Option<UsageWindow>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UsageWindow {
    percent: f64,
    #[serde(default)]
    resets_at: Option<String>,
}

fn window_package(label: &str, window: &UsageWindow) -> AgentSourceCreditPackage {
    let used = window.percent.clamp(0.0, 100.0);
    AgentSourceCreditPackage {
        name: label.to_string(),
        remain: 100.0 - used,
        size: 100.0,
        unlimited: false,
    }
}

fn fetch_usage(client: &Client, cfg: &RuntimeConfig) -> AgentSourceCredits {
    let url = format!("{}/usage", cfg.base_url);
    let session = Uuid::new_v4().to_string();
    let api_key = cfg.api_key.clone();
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(err) => {
            return AgentSourceCredits {
                error: Some(format!("运行时初始化失败: {err}")),
                ..AgentSourceCredits::default()
            };
        }
    };
    let envelope: UsageEnvelope = match runtime.block_on(async {
        let response = client
            .get(&url)
            .headers(auth_headers(&api_key, &session, "application/json"))
            .timeout(Duration::from_secs(15))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!("用量 HTTP {status}"));
        }
        response
            .json()
            .await
            .map_err(|e| format!("用量 JSON 无效: {e}"))
    }) {
        Ok(body) => body,
        Err(err) => {
            return AgentSourceCredits {
                error: Some(err),
                ..AgentSourceCredits::default()
            };
        }
    };
    let usage = match envelope.usage {
        Some(body) => body,
        None => {
            return AgentSourceCredits {
                error: Some("用量响应缺少 usage 字段".into()),
                ..AgentSourceCredits::default()
            };
        }
    };
    let mut packages = Vec::new();
    if let Some(w) = &usage.rolling {
        packages.push(window_package("5 小时", w));
    }
    if let Some(w) = &usage.weekly {
        packages.push(window_package("每周", w));
    }
    if let Some(w) = &usage.monthly {
        packages.push(window_package("每月", w));
    }
    let reset = usage
        .rolling
        .and_then(|w| w.resets_at.clone())
        .or_else(|| usage.weekly.and_then(|w| w.resets_at.clone()));
    AgentSourceCredits {
        total: 0.0,
        unlimited: false,
        packages,
        cycle_reset_time: reset,
        error: None,
    }
}

fn card_from(memory: &Memory, signed_in: bool) -> AgentSourceCard {
    AgentSourceCard {
        id: SOURCE_ID.into(),
        title: TITLE.into(),
        signed_in,
        account: if signed_in {
            memory
                .account
                .clone()
                .or_else(|| Some("OpenCode Go".into()))
        } else {
            None
        },
        token_expires_at_ms: None,
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

fn refresh_blocking(client: &Client) -> Memory {
    let mut memory = Memory {
        models: Vec::new(),
        wire_apis: HashMap::new(),
        catalog_source: "none".into(),
        error: None,
        credits: None,
        account: None,
    };
    memory.wire_apis = fetch_opencode_go_wire_apis(client).unwrap_or_default();
    match load_runtime_config() {
        Ok(cfg) => {
            memory.account = Some(cfg.account_label.clone());
            match fetch_models(client, &cfg) {
                Ok(models) => {
                    memory.models = models;
                    memory.catalog_source = "live".into();
                    memory.error = None;
                    memory.credits = Some(fetch_usage(client, &cfg));
                }
                Err(err) => {
                    memory.error = Some(err);
                    memory.credits = None;
                }
            }
        }
        Err(err) => {
            memory.error = Some(err);
            memory.account = None;
        }
    }
    memory
}

impl AgentSource for OpencodeGoSource {
    fn id(&self) -> &str {
        SOURCE_ID
    }

    fn title(&self) -> &str {
        TITLE
    }

    fn card(&self) -> AgentSourceCard {
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        let signed_in = load_runtime_config().is_ok();
        card_from(&memory, signed_in)
    }

    fn refresh(&self) -> Result<AgentSourceCard, String> {
        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        let fresh = refresh_blocking(&client);
        let signed_in = load_runtime_config().is_ok() && fresh.error.is_none();
        {
            let mut memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
            *memory = fresh;
        }
        let memory = self.memory.lock().unwrap_or_else(|p| p.into_inner());
        Ok(card_from(&memory, signed_in))
    }

    fn upstream_origin(&self) -> &'static str {
        DEFAULT_BASE_URL
    }

    fn open_provider(&self, model_id: &str, client: Client) -> Result<Box<dyn AiProvider>, String> {
        let cfg = load_runtime_config()?;
        let wire_apis = self
            .memory
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .wire_apis
            .clone();
        let wire = resolve_wire_api(model_id, &wire_apis);
        Ok(Box::new(OpencodeGoProvider {
            client,
            cfg,
            model_id: model_id.to_string(),
            session_id: Uuid::new_v4().to_string(),
            wire,
        }))
    }
}

struct OpencodeGoProvider {
    client: Client,
    cfg: RuntimeConfig,
    model_id: String,
    session_id: String,
    wire: WireApi,
}

fn message_to_json(message: &ChatMessage) -> Value {
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
impl AiProvider for OpencodeGoProvider {
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
            match event? {
                StreamEvent::ContentDelta { text } => content.push_str(&text),
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
            usage: Usage::default(),
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>> {
        let headers = auth_headers(
            &self.cfg.api_key,
            &self.session_id,
            "text/event-stream, application/json",
        );
        if self.wire != WireApi::OpenAiCompletions {
            return chat_stream_wire(
                self.wire,
                &self.client,
                headers,
                &self.cfg.base_url,
                &self.model_id,
                request,
            )
            .await;
        }
        let url = format!("{}/chat/completions", self.cfg.base_url);
        let mut body = json!({
            "model": self.model_id,
            "messages": request.messages.iter().map(message_to_json).collect::<Vec<_>>(),
            "stream": true,
        });
        if let Some(tools) = &request.tools {
            if !tools.is_empty() {
                body["tools"] = serde_json::to_value(tools).unwrap_or(json!([]));
            }
        }
        let response = self
            .client
            .post(&url)
            .headers(headers)
            .json(&body)
            .send()
            .await?;
        response_to_stream(
            response,
            std::sync::Arc::new(|line, events| {
                omnipanel_ai::providers::openai::parse_sse_line(line, events);
            }),
        )
        .await
    }
}
