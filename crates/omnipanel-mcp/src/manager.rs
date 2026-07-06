use std::collections::HashMap;
use std::sync::Arc;

use anyhow::Context;
use rmcp::transport::{
    streamable_http_server::{
        session::local::LocalSessionManager, tower::StreamableHttpService,
        StreamableHttpServerConfig,
    },
};
use tokio::process::Child;
use tokio::sync::Mutex;

use omnipanel_store::Storage;

use crate::builtin::OmniMcpHandler;
use crate::omni_module::omni_tool_module_key;
use crate::process::stdio_command;
use crate::registry::{external, native, RegisteredTool, ToolExecutionKind, ToolRegistry};
use crate::store::{
    delete_custom_service, load_services_file, set_service_enabled, upsert_custom_service,
};
use crate::types::{
    McpServiceConfig, McpServiceRuntimeStatus, McpServiceView, McpServicesFile, McpTransport,
    BUILTIN_MCP_ENDPOINT, BUILTIN_MCP_PORT, BUILTIN_SERVICE_ID, BUILTIN_SERVICE_NAME,
    OMNI_MODULE_MASTER,
};
use omnipanel_ai::types::ToolDef;

struct BuiltinServerRuntime {
    endpoint: String,
    shutdown: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

struct StdioServiceRuntime {
    child: Child,
}

pub struct McpManager {
    file: McpServicesFile,
    builtin: Option<BuiltinServerRuntime>,
    stdio_runtimes: HashMap<String, StdioServiceRuntime>,
    storage: Arc<Mutex<Storage>>,
    pub tool_registry: ToolRegistry,
}

impl McpManager {
    pub async fn bootstrap(storage: Arc<Mutex<Storage>>) -> anyhow::Result<Self> {
        let file = load_services_file().map_err(|e| anyhow::anyhow!(e.to_string()))?;
        let mut manager = Self {
            file,
            builtin: None,
            stdio_runtimes: HashMap::new(),
            storage: storage.clone(),
            tool_registry: ToolRegistry::new(storage),
        };
        manager.start_builtin().await?;
        manager.sync_custom_services().await?;
        Ok(manager)
    }

    pub fn list_services(&self) -> Vec<McpServiceView> {
        let mut views = Vec::with_capacity(self.file.services.len() + 1);
        views.push(self.builtin_view());
        for service in &self.file.services {
            views.push(self.custom_view(service));
        }
        views
    }

    /// 聚合已启用且运行中的**非内置**外部 MCP 服务工具，供内部编排 ToolRegistry 注入。
    pub async fn list_external_registry_tools(&self) -> Result<Vec<RegisteredTool>, String> {
        let mut out = Vec::new();
        for service in self.list_services() {
            if service.builtin || !service.enabled {
                continue;
            }
            if service.status != McpServiceRuntimeStatus::Running {
                continue;
            }
            let tools = self
                .list_service_tools(&service.id)
                .await
                .map_err(|e| e.to_string())?;
            for tool in tools {
                let schema = tool.input_schema.unwrap_or_else(|| {
                    serde_json::json!({
                        "type": "object",
                        "properties": {}
                    })
                });
                let desc = tool
                    .description
                    .filter(|d| !d.trim().is_empty())
                    .unwrap_or_else(|| format!("外部 MCP 工具（{}）", service.name));
                out.push(RegisteredTool {
                    name: external::registry_tool_name(&service.id, &tool.name),
                    module_key: "external_mcp".to_string(),
                    description: desc,
                    input_schema: schema,
                    kind: ToolExecutionKind::ExternalMcp,
                    mcp_service_id: Some(service.id.clone()),
                    mcp_tool_name: Some(tool.name),
                });
            }
        }
        Ok(out)
    }

    /// 内置 omni_* + 外部 MCP 工具合并为内部编排可用的 ToolDef 列表。
    pub async fn to_internal_tool_defs(
        &self,
        module_filter: Option<&str>,
    ) -> Result<Vec<ToolDef>, String> {
        let mut defs = self
            .tool_registry
            .to_tool_defs(module_filter)
            .await?;
        let external = self.list_external_registry_tools().await?;
        defs.extend(
            external
                .into_iter()
                .map(ToolRegistry::registered_to_tool_def),
        );
        defs.push(Self::load_skill_tool_def());
        Ok(defs)
    }

    fn load_skill_tool_def() -> ToolDef {
        ToolDef {
            tool_type: "function".to_string(),
            function: omnipanel_ai::types::FunctionDef {
                name: "load_skill".to_string(),
                description: "加载指定 Skill 的完整 SKILL.md 正文（渐进式披露）".to_string(),
                parameters: native::input_schema_for("load_skill"),
            },
        }
    }

    pub async fn upsert_service(&mut self, service: McpServiceConfig) -> anyhow::Result<McpServiceView> {
        let saved = upsert_custom_service(&mut self.file, service)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        self.sync_custom_services().await?;
        Ok(self.custom_view(&saved))
    }

    pub async fn delete_service(&mut self, id: &str) -> anyhow::Result<()> {
        self.stop_stdio_service(id).await;
        delete_custom_service(&mut self.file, id).map_err(|e| anyhow::anyhow!(e.to_string()))?;
        Ok(())
    }

    pub async fn set_enabled(&mut self, id: &str, enabled: bool) -> anyhow::Result<McpServiceView> {
        let saved = set_service_enabled(&mut self.file, id, enabled)
            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        self.sync_custom_services().await?;
        Ok(self.custom_view(&saved))
    }

    pub async fn set_service_running(&mut self, id: &str, running: bool) -> anyhow::Result<McpServiceView> {
        if id == BUILTIN_SERVICE_ID {
            if running {
                if self.builtin.is_none() {
                    self.start_builtin().await?;
                }
            } else {
                self.stop_builtin().await?;
            }
            return Ok(self.builtin_view());
        }

        if running {
            self.set_enabled(id, true).await
        } else {
            self.set_enabled(id, false).await
        }
    }

    async fn stop_builtin(&mut self) -> anyhow::Result<()> {
        if let Some(runtime) = self.builtin.take() {
            let _ = runtime.shutdown.send(true);
            let _ = runtime.task.await;
        }
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn restart_service(&mut self, id: &str) -> anyhow::Result<McpServiceView> {
        if id == BUILTIN_SERVICE_ID {
            self.restart_builtin().await?;
            return Ok(self.builtin_view());
        }
        self.stop_stdio_service(id).await;
        self.sync_custom_services().await?;
        let service = self
            .file
            .services
            .iter()
            .find(|s| s.id == id)
            .context("MCP 服务不存在")?;
        Ok(self.custom_view(service))
    }

    pub async fn call_service_tool(
        &self,
        id: &str,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> anyhow::Result<crate::types::McpToolCallResult> {
        use crate::types::McpServiceRuntimeStatus;

        if id == BUILTIN_SERVICE_ID {
            {
                let storage = self.storage.lock().await;
                if !storage.mcp_tool_is_exposed_available(tool_name).unwrap_or(false) {
                    anyhow::bail!("MCP 工具不可用: {tool_name}");
                }
            }
            let endpoint = self
                .builtin
                .as_ref()
                .map(|b| b.endpoint.clone())
                .context("OmniMCP 未运行")?;
            return crate::client::call_tool_http_for_module(
                &endpoint,
                omni_tool_module_key(tool_name),
                tool_name,
                arguments,
            )
            .await;
        }

        let service = self
            .file
            .services
            .iter()
            .find(|s| s.id == id)
            .context("MCP 服务不存在")?;

        let view = self.custom_view(service);
        if view.status != McpServiceRuntimeStatus::Running {
            anyhow::bail!("MCP 服务未运行，无法调用工具");
        }

        match &service.transport {
            McpTransport::Sse { config } => {
                let url = view.endpoint.as_deref().unwrap_or(config.url.as_str());
                crate::client::call_tool_http(url, tool_name, arguments).await
            }
            McpTransport::Stdio { config } => {
                crate::client::call_tool_stdio(config, tool_name, arguments).await
            }
        }
    }

    pub async fn list_service_tools(&self, id: &str) -> anyhow::Result<Vec<crate::types::McpToolInfo>> {
        use crate::types::McpServiceRuntimeStatus;

        if id == BUILTIN_SERVICE_ID {
            let endpoint = self
                .builtin
                .as_ref()
                .map(|b| b.endpoint.clone())
                .context("OmniMCP 未运行")?;
            let mut tools =
                crate::client::list_tools_http_for_module(&endpoint, Some(OMNI_MODULE_MASTER))
                    .await?;
            let storage = self.storage.lock().await;
            tools.retain(|tool| storage.mcp_tool_is_exposed_available(&tool.name).unwrap_or(false));
            return Ok(tools);
        }

        let service = self
            .file
            .services
            .iter()
            .find(|s| s.id == id)
            .context("MCP 服务不存在")?;

        let view = self.custom_view(service);
        if view.status != McpServiceRuntimeStatus::Running {
            anyhow::bail!("MCP 服务未运行，无法获取工具列表");
        }

        match &service.transport {
            McpTransport::Sse { config } => {
                let url = view.endpoint.as_deref().unwrap_or(config.url.as_str());
                crate::client::list_tools_http(url).await
            }
            McpTransport::Stdio { config } => crate::client::list_tools_stdio(config).await,
        }
    }

    async fn restart_builtin(&mut self) -> anyhow::Result<()> {
        if let Some(runtime) = self.builtin.take() {
            let _ = runtime.shutdown.send(true);
            let _ = runtime.task.await;
        }
        self.start_builtin().await
    }

    async fn start_builtin(&mut self) -> anyhow::Result<()> {
        let bind_addr = format!("127.0.0.1:{BUILTIN_MCP_PORT}");
        let listener = tokio::net::TcpListener::bind(&bind_addr)
            .await
            .with_context(|| format!("绑定 OmniMCP 端口 {bind_addr} 失败"))?;
        let endpoint = BUILTIN_MCP_ENDPOINT.to_string();

        let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
        let storage = self.storage.clone();
        let service = StreamableHttpService::new(
            move || Ok(OmniMcpHandler::new(storage.clone())),
            LocalSessionManager::default().into(),
            StreamableHttpServerConfig::default(),
        );
        let router = axum::Router::new()
            .nest_service("/mcp", service)
            .layer(
                tower_http::cors::CorsLayer::new()
                    .allow_origin(tower_http::cors::Any)
                    .allow_methods(tower_http::cors::Any)
                    .allow_headers(tower_http::cors::Any),
            );

        let task = tokio::spawn(async move {
            let serve = axum::serve(listener, router);
            tokio::select! {
                result = serve => {
                    if let Err(err) = result {
                        tracing::error!(error = %err, "OmniMCP HTTP 服务异常退出");
                    }
                }
                _ = wait_for_shutdown(shutdown_rx) => {
                    tracing::info!("OmniMCP HTTP 服务已停止");
                }
            }
        });

        tracing::info!(endpoint = %endpoint, "OmniMCP 内置 MCP 服务已启动");
        self.builtin = Some(BuiltinServerRuntime {
            endpoint,
            shutdown: shutdown_tx,
            task,
        });
        Ok(())
    }

    async fn sync_custom_services(&mut self) -> anyhow::Result<()> {
        let enabled_ids: Vec<String> = self
            .file
            .services
            .iter()
            .filter(|s| s.enabled)
            .map(|s| s.id.clone())
            .collect();

        let running_ids: Vec<String> = self.stdio_runtimes.keys().cloned().collect();
        for id in running_ids {
            if !enabled_ids.contains(&id) {
                self.stop_stdio_service(&id).await;
            }
        }

        for service in self.file.services.clone() {
            if !service.enabled {
                continue;
            }
            if let McpTransport::Stdio { .. } = &service.transport {
                if !self.stdio_runtimes.contains_key(&service.id) {
                    if let Err(err) = self.start_stdio_service(&service).await {
                        tracing::warn!(
                            service_id = %service.id,
                            error = %err,
                            "启动自定义 stdio MCP 服务失败"
                        );
                    }
                }
            }
        }
        Ok(())
    }

    async fn start_stdio_service(&mut self, service: &McpServiceConfig) -> anyhow::Result<()> {
        let McpTransport::Stdio { config } = &service.transport else {
            return Ok(());
        };

        let mut command = stdio_command(config);
        command.stdin(std::process::Stdio::piped());
        command.stdout(std::process::Stdio::piped());
        command.stderr(std::process::Stdio::piped());
        command.kill_on_drop(true);

        let mut child = command.spawn().context("spawn MCP stdio 进程失败")?;
        let stderr = child.stderr.take();
        if let Some(mut stderr) = stderr {
            let service_name = service.name.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut buf = Vec::new();
                let _ = stderr.read_to_end(&mut buf).await;
                if !buf.is_empty() {
                    tracing::debug!(
                        service = %service_name,
                        stderr = %String::from_utf8_lossy(&buf),
                        "MCP stdio 进程 stderr"
                    );
                }
            });
        }

        self.stdio_runtimes
            .insert(service.id.clone(), StdioServiceRuntime { child });
        Ok(())
    }

    async fn stop_stdio_service(&mut self, id: &str) {
        if let Some(mut runtime) = self.stdio_runtimes.remove(id) {
            let _ = runtime.child.start_kill();
            let _ = runtime.child.wait().await;
        }
    }

    fn builtin_view(&self) -> McpServiceView {
        let (status, endpoint) = if self.builtin.is_some() {
            (
                McpServiceRuntimeStatus::Running,
                self.builtin.as_ref().map(|b| b.endpoint.clone()),
            )
        } else {
            (McpServiceRuntimeStatus::Stopped, None)
        };

        McpServiceView {
            id: BUILTIN_SERVICE_ID.to_string(),
            name: BUILTIN_SERVICE_NAME.to_string(),
            enabled: true,
            builtin: true,
            transport: McpTransport::Sse {
                config: crate::types::McpSseTransport {
                    url: endpoint.clone().unwrap_or_default(),
                },
            },
            created_at: 0,
            status,
            endpoint,
            error_message: None,
        }
    }

    fn custom_view(&self, service: &McpServiceConfig) -> McpServiceView {
        let (status, endpoint, error_message) = match &service.transport {
            McpTransport::Stdio { .. } => {
                if !service.enabled {
                    (McpServiceRuntimeStatus::Stopped, None, None)
                } else if self.stdio_runtimes.contains_key(&service.id) {
                    (McpServiceRuntimeStatus::Running, None, None)
                } else {
                    (
                        McpServiceRuntimeStatus::Error,
                        None,
                        Some("stdio 进程未运行".to_string()),
                    )
                }
            }
            McpTransport::Sse { config } => {
                if !service.enabled {
                    (McpServiceRuntimeStatus::Stopped, Some(config.url.clone()), None)
                } else {
                    (
                        McpServiceRuntimeStatus::Running,
                        Some(config.url.clone()),
                        None,
                    )
                }
            }
        };

        McpServiceView {
            id: service.id.clone(),
            name: service.name.clone(),
            enabled: service.enabled,
            builtin: false,
            transport: service.transport.clone(),
            created_at: service.created_at,
            status,
            endpoint,
            error_message,
        }
    }
}

async fn wait_for_shutdown(mut rx: tokio::sync::watch::Receiver<bool>) {
    while !*rx.borrow() {
        if rx.changed().await.is_err() {
            break;
        }
    }
}

pub type SharedMcpManager = std::sync::Arc<Mutex<McpManager>>;
