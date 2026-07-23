mod database;
mod docker;
mod files;
mod knowledge;
mod protocol;
mod server;
mod tasks;
mod terminal;

use omnipanel_error::OmniResult;
use serde_json::Value;

use crate::types::{AssistantSnapshotModules, ModuleSection};

pub use database::DatabaseCollector;
pub use docker::DockerCollector;
pub use files::FilesCollector;
pub use knowledge::KnowledgeCollector;
pub use protocol::ProtocolCollector;
pub use server::ServerCollector;
pub use tasks::TasksCollector;
pub use terminal::TerminalCollector;

/// Tauri 命令层注入的只读采集输入（已尽量脱敏；Collector 内再做一次 strip）。
#[derive(Debug, Clone, Default)]
pub struct CollectContext {
    pub client_device_id: String,
    pub bind_id: Option<String>,
    /// 账号 user id（用于 object key）；未知时可空
    pub user_id: Option<String>,
    /// 终端主机（SSH 等）脱敏条目
    pub terminal_hosts: Vec<Value>,
    pub database_connections: Vec<Value>,
    pub docker_instances: Vec<Value>,
    pub file_connections: Vec<Value>,
    pub server_panels: Vec<Value>,
    pub knowledge_documents: Vec<Value>,
    pub protocol_requests: Vec<Value>,
    pub recent_tasks: Vec<Value>,
}

pub trait MetadataCollector: Send + Sync {
    fn module_id(&self) -> &'static str;
    fn collect(&self, ctx: &CollectContext) -> OmniResult<ModuleSection>;
}

pub struct ModuleCollectResult {
    pub module_id: &'static str,
    pub section: ModuleSection,
}

pub fn default_collectors() -> Vec<Box<dyn MetadataCollector>> {
    vec![
        Box::new(TerminalCollector),
        Box::new(DatabaseCollector),
        Box::new(DockerCollector),
        Box::new(FilesCollector),
        Box::new(ServerCollector),
        Box::new(KnowledgeCollector),
        Box::new(ProtocolCollector),
        Box::new(TasksCollector),
    ]
}

/// 运行全部 collector；单模块失败写入 section.error，不影响其它模块。
pub fn assemble_modules(
    collectors: &[Box<dyn MetadataCollector>],
    ctx: &CollectContext,
) -> AssistantSnapshotModules {
    let mut modules = AssistantSnapshotModules::default();
    for collector in collectors {
        let section = match collector.collect(ctx) {
            Ok(section) => section,
            Err(err) => ModuleSection::from_error(err.user_message()),
        };
        match collector.module_id() {
            "terminal" => modules.terminal = section,
            "database" => modules.database = section,
            "docker" => modules.docker = section,
            "files" => modules.files = section,
            "server" => modules.server = section,
            "knowledge" => modules.knowledge = section,
            "protocol" => modules.protocol = section,
            "tasks" => modules.tasks = section,
            other => {
                tracing::warn!(module = other, "unknown assistant collector module_id");
            }
        }
    }
    modules
}
