//! Agent 来源宿主管线。
//!
//! 插件（`kind = agent`）只声明来源。登录态、目录和补全由宿主调用，
//! 对话、工具与审批留在 `InternalOrchestrator`。token 留在宿主进程。
//!
//! 后续来源实现 [`AgentSource`] 并 [`AgentSourceRegistry::register`]。
//! 选择器里的 backend id 是 `http:{source_id}::{model_id}`，前端快照不带密钥。

mod cursor;
mod workbuddy;

use std::sync::{Arc, Mutex, OnceLock};

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::provider::AiProvider;

pub use cursor::CursorSource;
pub use workbuddy::WorkBuddySource;

/// 选择器里的一条模型。不含密钥。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceModel {
    pub id: String,
    pub name: String,
    /// 消耗比例，如 `0.79x`。目录没有该字段时为空。
    #[serde(default)]
    pub credits: Option<String>,
    /// 上游促销标签，如「限时免费」。`/v3/config` 往往不带，有则展示。
    #[serde(default)]
    pub badges: Vec<String>,
}

/// 一张额度包。`unlimited` 为真时 `remain` / `size` 不是余额。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceCreditPackage {
    pub name: String,
    pub remain: f64,
    pub size: f64,
    #[serde(default)]
    pub unlimited: bool,
}

/// 账号余额。`error` 有值时不要把 `total == 0` 当成真实余额。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceCredits {
    pub total: f64,
    #[serde(default)]
    pub unlimited: bool,
    #[serde(default)]
    pub packages: Vec<AgentSourceCreditPackage>,
    #[serde(default)]
    pub cycle_reset_time: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

/// 设置卡片与选择器共用的状态。不含 token。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSourceCard {
    pub id: String,
    pub title: String,
    pub signed_in: bool,
    pub account: Option<String>,
    pub token_expires_at_ms: Option<i64>,
    pub catalog_source: String,
    pub error: Option<String>,
    pub models: Vec<AgentSourceModel>,
    #[serde(default)]
    pub credits: Option<AgentSourceCredits>,
}

/// 一家上游。实现放在宿主进程，不把密钥交进 QuickJS / WASM。
pub trait AgentSource: Send + Sync {
    fn id(&self) -> &str;
    fn title(&self) -> &str;
    fn card(&self) -> AgentSourceCard;
    fn refresh(&self) -> Result<AgentSourceCard, String>;
    /// 代理客户端要按这个源站地址创建。
    fn upstream_origin(&self) -> &'static str;
    /// 为一次编排打开推理提供者。`client` 由宿主按代理配置创建。
    fn open_provider(&self, model_id: &str, client: Client) -> Result<Box<dyn AiProvider>, String>;
}

#[derive(Default)]
pub struct AgentSourceRegistry {
    sources: Vec<Arc<dyn AgentSource>>,
}

impl AgentSourceRegistry {
    pub fn register(&mut self, source: Arc<dyn AgentSource>) {
        if let Some(existing) = self.sources.iter_mut().find(|s| s.id() == source.id()) {
            *existing = source;
            return;
        }
        self.sources.push(source);
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentSource>> {
        self.sources.iter().find(|s| s.id() == id).cloned()
    }

    pub fn cards(&self) -> Vec<AgentSourceCard> {
        self.sources.iter().map(|s| s.card()).collect()
    }

    pub fn refresh(&self, id: &str) -> Result<AgentSourceCard, String> {
        self.get(id)
            .ok_or_else(|| format!("未知 Agent 来源: {id}"))?
            .refresh()
    }

    pub fn open_provider(
        &self,
        id: &str,
        model_id: &str,
        client: Client,
    ) -> Result<Option<Box<dyn AiProvider>>, String> {
        let Some(source) = self.get(id) else {
            return Ok(None);
        };
        source.open_provider(model_id, client).map(Some)
    }
}

fn registry_slot() -> &'static Mutex<AgentSourceRegistry> {
    static REGISTRY: OnceLock<Mutex<AgentSourceRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = AgentSourceRegistry::default();
        registry.register(Arc::new(WorkBuddySource::new()));
        registry.register(Arc::new(CursorSource::new()));
        Mutex::new(registry)
    })
}

pub fn agent_source_registry() -> std::sync::MutexGuard<'static, AgentSourceRegistry> {
    registry_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
