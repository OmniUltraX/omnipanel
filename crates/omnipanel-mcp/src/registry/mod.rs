pub mod external;
pub mod native;

use std::sync::Arc;

use omnipanel_ai::types::{FunctionDef, ToolDef};
use omnipanel_store::Storage;
use serde_json::Value;
use tokio::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolExecutionKind {
    /// 后端 Rust 直接执行（知识库等）。
    Native,
    /// 需要前端上下文执行（终端 / 数据库等），统一走 pending 回传通道，
    /// 由前端在 `AiRuntimeProvider` 的 dispatchTool 中分派。
    UiDelegated,
    /// 外部 MCP 服务提供的工具，由 McpManager 桥接调用。
    ExternalMcp,
}

#[derive(Debug, Clone)]
pub struct RegisteredTool {
    pub name: String,
    pub module_key: String,
    pub description: String,
    pub input_schema: Value,
    pub kind: ToolExecutionKind,
    /// 外部 MCP：`service_id` + 原始工具名。
    pub mcp_service_id: Option<String>,
    pub mcp_tool_name: Option<String>,
}

pub struct ToolRegistry {
    storage: Arc<Mutex<Storage>>,
}

impl ToolRegistry {
    pub fn new(storage: Arc<Mutex<Storage>>) -> Self {
        Self { storage }
    }

    /// 是否后端直执（Native）——取自 store 单一真相源。
    pub fn is_native_tool(name: &str) -> bool {
        omnipanel_store::builtin_tool_is_native(name)
    }

    /// 克隆 storage 句柄用于隔离执行（不持有 `McpManager` 锁）。
    pub fn storage_handle(&self) -> Arc<Mutex<Storage>> {
        self.storage.clone()
    }

    pub async fn list_enabled(&self, module_filter: Option<&str>) -> Result<Vec<RegisteredTool>, String> {
        let storage = self.storage.lock().await;
        let records = storage
            .mcp_tool_list()
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|r| r.internal_enabled && storage.mcp_tool_is_available(&r.tool_name).unwrap_or(false))
            .collect::<Vec<_>>();

        let mut tools = Vec::new();
        for record in records {
            if let Some(filter) = module_filter {
                if filter != "master" && record.module_key != filter {
                    continue;
                }
            }
            let kind = if Self::is_native_tool(&record.tool_name) {
                ToolExecutionKind::Native
            } else {
                ToolExecutionKind::UiDelegated
            };
            // schema 优先取 DB 持久化值（前端/模型共用同一份），解析失败回退 spec。
            let input_schema = serde_json::from_str::<Value>(&record.input_schema)
                .ok()
                .filter(|v| v.is_object())
                .unwrap_or_else(|| native::input_schema_for(&record.tool_name));
            tools.push(RegisteredTool {
                name: record.tool_name.clone(),
                module_key: record.module_key.clone(),
                description: record.description.clone(),
                input_schema,
                kind,
                mcp_service_id: None,
                mcp_tool_name: None,
            });
        }
        Ok(tools)
    }

    pub async fn to_tool_defs(&self, module_filter: Option<&str>) -> Result<Vec<ToolDef>, String> {
        Ok(self
            .list_enabled(module_filter)
            .await?
            .into_iter()
            .map(Self::registered_to_tool_def)
            .collect())
    }

    pub fn registered_to_tool_def(tool: RegisteredTool) -> ToolDef {
        ToolDef {
            tool_type: "function".to_string(),
            function: FunctionDef {
                name: tool.name,
                description: tool.description,
                parameters: tool.input_schema,
            },
        }
    }

    /// 在不持有 `McpManager` 锁的情况下执行 Native 工具（后端直执）。
    ///
    /// UiDelegated 工具（终端 / 数据库等）不再由后端执行，而是统一通过
    /// `pending_internal_tool_results` 挂起、由前端 dispatchTool 回传结果，
    /// 因此这里遇到 UiDelegated 工具直接返回错误（正常路径不会到达）。
    pub async fn execute_isolated(
        storage: Arc<Mutex<Storage>>,
        name: &str,
        arguments: Value,
    ) -> Result<(String, bool), String> {
        {
            let storage = storage.lock().await;
            if !storage.mcp_tool_is_available(name).unwrap_or(false) {
                return Err(format!("MCP 工具不可用: {name}"));
            }
        }

        if Self::is_native_tool(name) {
            return native::execute(name, arguments, storage).await;
        }

        if external::is_external_mcp_registry_name(name) {
            return Err(format!(
                "工具 {name} 为 ExternalMcp，应由 McpManager 桥接执行，不应走 execute_isolated"
            ));
        }

        Err(format!(
            "工具 {name} 为 UiDelegated，应由前端 dispatchTool 执行，不应在后端直执"
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use omnipanel_store::AppModuleStatus;

    fn registry_with_storage() -> (ToolRegistry, Arc<Mutex<Storage>>) {
        let storage = Arc::new(Mutex::new(Storage::open_in_memory().unwrap()));
        (ToolRegistry::new(storage.clone()), storage)
    }

    #[tokio::test]
    async fn list_enabled_carries_schema_and_kind() {
        let (registry, _s) = registry_with_storage();
        let tools = registry.list_enabled(None).await.unwrap();
        let term = tools
            .iter()
            .find(|t| t.name == "omni_terminal_run_terminal_command")
            .expect("terminal 工具应存在");
        assert_eq!(term.kind, ToolExecutionKind::UiDelegated);
        assert_eq!(
            term.input_schema
                .get("required")
                .and_then(|r| r.as_array())
                .map(|a| a.iter().any(|x| x.as_str() == Some("command"))),
            Some(true)
        );
        // load_skill 已纳入 registry（native）
        assert!(tools.iter().any(|t| t.name == "load_skill"));
    }

    #[tokio::test]
    async fn disabled_tool_is_excluded() {
        let (registry, storage) = registry_with_storage();
        storage
            .lock()
            .await
            .mcp_tool_set_internal_enabled("omni_terminal_run_terminal_command", false)
            .unwrap();
        let tools = registry.list_enabled(None).await.unwrap();
        assert!(!tools
            .iter()
            .any(|t| t.name == "omni_terminal_run_terminal_command"));
    }

    #[tokio::test]
    async fn closed_module_tools_are_excluded() {
        let (registry, storage) = registry_with_storage();
        storage
            .lock()
            .await
            .app_module_set_status("database", AppModuleStatus::Closed)
            .unwrap();
        let tools = registry.list_enabled(None).await.unwrap();
        assert!(!tools.iter().any(|t| t.module_key == "database"));
    }
}
