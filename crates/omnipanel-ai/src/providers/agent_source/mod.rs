//! Agent 来源宿主管线。
//!
//! 官方与第三方来源都是 sidecar 进程（协议见 `docs/plugins/sidecar-agent.md`）。
//! 宿主只负责拉起进程，并把一轮对话事件交回 `InternalOrchestrator`。
//! token 留在 sidecar 进程内存，不进宿主，也不进 QuickJS / WASM。
//!
//! 选择器里的 backend id 是 `http:{source_id}::{model_id}`，前端快照不带密钥。

mod sidecar;

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, OnceLock};

use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider::AiProvider;

pub use sidecar::{InstalledAgentSidecar, sync_installed_agent_sidecars};

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
    #[serde(default)]
    pub account: Option<String>,
    #[serde(default)]
    pub token_expires_at_ms: Option<i64>,
    #[serde(default)]
    pub catalog_source: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub models: Vec<AgentSourceModel>,
    #[serde(default)]
    pub credits: Option<AgentSourceCredits>,
}

/// 一家上游。实现在 sidecar 进程里；宿主只保留拉起与事件翻译。
pub trait AgentSource: Send + Sync {
    fn id(&self) -> &str;
    fn title(&self) -> &str;
    fn card(&self) -> AgentSourceCard;
    fn refresh(&self) -> Result<AgentSourceCard, String>;
    /// 代理客户端要按这个源站地址创建。sidecar 进程内自己建客户端。
    fn upstream_origin(&self) -> &'static str;
    /// 宿主在 `open_provider` 之前写入本次对话要用的代理。进程内来源忽略。
    fn set_request_proxy(&self, _proxy: &Value) {}
    /// 为一次编排打开推理提供者。`client` 由调用方按代理配置创建；
    /// 宿主侧 sidecar 包装忽略它，把代理交给子进程。
    fn open_provider(&self, model_id: &str, client: Client) -> Result<Box<dyn AiProvider>, String>;
}

#[derive(Default)]
pub struct AgentSourceRegistry {
    sources: Vec<Arc<dyn AgentSource>>,
    pinned: Vec<String>,
}

impl AgentSourceRegistry {
    pub fn register(&mut self, source: Arc<dyn AgentSource>) {
        if let Some(existing) = self
            .sources
            .iter_mut()
            .find(|item| item.id() == source.id())
        {
            *existing = source;
            return;
        }
        self.sources.push(source);
    }

    fn register_pinned(&mut self, source: Arc<dyn AgentSource>) {
        let id = source.id().to_string();
        if !self.pinned.iter().any(|pinned| pinned == &id) {
            self.pinned.push(id);
        }
        self.register(source);
    }

    /// 用已安装插件替换非官方来源。官方 Cursor / WorkBuddy 不被覆盖。
    pub fn sync_unpinned(&mut self, incoming: Vec<Arc<dyn AgentSource>>) {
        let pinned: BTreeSet<String> = self.pinned.iter().cloned().collect();
        let incoming_ids: BTreeSet<String> = incoming
            .iter()
            .map(|source| source.id().to_string())
            .collect();
        self.sources
            .retain(|source| pinned.contains(source.id()) || incoming_ids.contains(source.id()));
        for source in incoming {
            let id = source.id().to_string();
            if pinned.contains(&id) || self.get(&id).is_some() {
                continue;
            }
            self.register(source);
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentSource>> {
        self.sources
            .iter()
            .find(|source| source.id() == id)
            .cloned()
    }

    pub fn cards(&self) -> Vec<AgentSourceCard> {
        self.sources.iter().map(|source| source.card()).collect()
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
        proxy: Value,
    ) -> Result<Option<Box<dyn AiProvider>>, String> {
        let Some(source) = self.get(id) else {
            return Ok(None);
        };
        source.set_request_proxy(&proxy);
        let client = Client::builder().build().map_err(|err| err.to_string())?;
        source.open_provider(model_id, client).map(Some)
    }
}

fn registry_slot() -> &'static Mutex<AgentSourceRegistry> {
    static REGISTRY: OnceLock<Mutex<AgentSourceRegistry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = AgentSourceRegistry::default();
        registry.register_pinned(Arc::new(sidecar::SidecarSource::workbuddy()));
        registry.register_pinned(Arc::new(sidecar::SidecarSource::cursor()));
        registry.register_pinned(Arc::new(sidecar::SidecarSource::trae()));
        registry.register_pinned(Arc::new(sidecar::SidecarSource::trae_global()));
        Mutex::new(registry)
    })
}

pub fn agent_source_registry() -> std::sync::MutexGuard<'static, AgentSourceRegistry> {
    registry_slot()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
