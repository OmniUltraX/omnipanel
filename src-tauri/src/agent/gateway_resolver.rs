//! Gateway ↔ Tauri bridge: implements `AcpResolver` by wrapping `AgentRegistry`
//! + `AcpState`, allowing the gateway crate to resolve CLI/ACP agents without
//! depending on `src-tauri`.

use std::sync::Arc;

use omnipanel_gateway::{AcpResolver, CliBackendInfo};
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

use crate::agent::AgentRegistry;
use crate::commands::acp::AcpState;
use crate::commands::agents::{agent_kind_key, detect_all_agents_sync, AgentKind};

/// Concrete `AcpResolver` backed by the Tauri `AgentRegistry` + `AcpState`.
///
/// Created in `ai_gateway_configure` and passed to `spawn_gateway` so the
/// gateway can resolve CLI backends (Cursor / OpenCode / Qwen / OmniAgent)
/// for the `/v1/chat/completions` and `/v1/models` endpoints.
pub struct GatewayAcpResolver {
    app_handle: AppHandle,
    agent_registry: Arc<AgentRegistry>,
    acp_state: Arc<Mutex<AcpState>>,
}

impl GatewayAcpResolver {
    pub fn new(
        app_handle: AppHandle,
        agent_registry: Arc<AgentRegistry>,
        acp_state: Arc<Mutex<AcpState>>,
    ) -> Self {
        Self {
            app_handle,
            agent_registry,
            acp_state,
        }
    }
}

#[async_trait::async_trait]
impl AcpResolver for GatewayAcpResolver {
    async fn resolve(
        &self,
        agent_kind: &str,
        conversation_id: &str,
        model_id: Option<&str>,
        cwd: &str,
    ) -> Result<(Arc<omnipanel_ai::providers::acp::AcpManager>, String), String> {
        let manager = self
            .agent_registry
            .get_or_connect_for_gateway(&self.app_handle, &self.acp_state, agent_kind)
            .await?;

        // "default" / "auto" / empty → None (use agent's configured model)
        let normalized_model = model_id
            .map(|m| m.trim().to_string())
            .filter(|m| !m.is_empty() && m != "default" && m != "auto");

        let session_id = manager
            .ensure_session(
                conversation_id,
                cwd,
                Vec::new(), // no MCP servers for gateway path
                normalized_model.as_deref(),
            )
            .await
            .map_err(|e| e.to_string())?;

        Ok((manager, session_id))
    }

    fn list_cli_backends(&self) -> Vec<CliBackendInfo> {
        let resource_dir = self.app_handle.path().resource_dir().ok();
        let agents = detect_all_agents_sync(resource_dir);

        agents
            .into_iter()
            .filter(|a| a.installed)
            .map(|a| {
                let provider_id = agent_kind_key(a.kind).to_string();
                let display_name = match a.kind {
                    AgentKind::Cursor => "Cursor",
                    AgentKind::Opencode => "OpenCode",
                    AgentKind::Qwen => "Qwen",
                    AgentKind::Omniagent => "OmniAgent",
                }
                .to_string();
                // List a "default" model; the agent will use its configured model.
                // Users can also specify any model name (e.g. `cli:cursor::gpt-4o`)
                // and the ACP agent will attempt to set it.
                let models = vec!["default".to_string()];
                CliBackendInfo {
                    provider_id,
                    display_name,
                    models,
                }
            })
            .collect()
    }
}
