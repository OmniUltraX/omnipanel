use std::collections::HashMap;
use std::sync::Arc;

use omnipanel_ai::providers::acp::AcpManager;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::commands::acp::{connect_agent_with_acp_state, AgentLaunchSpec};
use crate::commands::agents::{agent_kind_key, detect_all_agents_sync, AgentInstallStatus};
use crate::state::AppState;

pub struct AgentRegistry {
    managers: Mutex<HashMap<String, Arc<AcpManager>>>,
}

impl Default for AgentRegistry {
    fn default() -> Self {
        Self {
            managers: Mutex::new(HashMap::new()),
        }
    }
}

impl AgentRegistry {
    pub async fn get_or_connect(
        &self,
        app: &AppHandle,
        state: &AppState,
        agent_kind: &str,
    ) -> Result<Arc<AcpManager>, String> {
        self.get_or_connect_inner(app, &state.acp_state, agent_kind).await
    }

    /// Gateway-friendly variant: takes `acp_state` directly instead of `&AppState`,
    /// allowing the `GatewayAcpResolver` to resolve agents without holding a
    /// reference to the full application state.
    pub async fn get_or_connect_for_gateway(
        &self,
        app: &AppHandle,
        acp_state: &Arc<Mutex<crate::commands::acp::AcpState>>,
        agent_kind: &str,
    ) -> Result<Arc<AcpManager>, String> {
        self.get_or_connect_inner(app, acp_state, agent_kind).await
    }

    async fn get_or_connect_inner(
        &self,
        app: &AppHandle,
        acp_state: &Arc<Mutex<crate::commands::acp::AcpState>>,
        agent_kind: &str,
    ) -> Result<Arc<AcpManager>, String> {
        let key = agent_kind.to_ascii_lowercase();

        // Fast path: return cached manager if still healthy.
        // We clone the Arc and check health outside the lock to avoid
        // blocking other callers during the `is_alive()` subprocess check.
        {
            let map = self.managers.lock().await;
            if let Some(m) = map.get(&key) {
                if m.is_connected() {
                    let candidate = m.clone();
                    drop(map);
                    if candidate.is_healthy().await {
                        return Ok(candidate);
                    }
                    // Subprocess died — evict from cache and reconnect.
                    tracing::warn!(
                        "ACP agent '{agent_kind}' subprocess is not healthy, reconnecting"
                    );
                    self.managers.lock().await.remove(&key);
                }
            }
        }

        let status = find_agent_status(agent_kind)?;
        let executable = status
            .executable_path
            .as_deref()
            .ok_or_else(|| format!("Agent {agent_kind} 未安装"))?;

        let mut args = status.launch_args.clone();
        let binary = if args.is_empty() {
            executable.to_string()
        } else {
            args.insert(0, executable.to_string());
            args.remove(0)
        };

        connect_agent_with_acp_state(
            app,
            acp_state,
            AgentLaunchSpec {
                binary,
                args,
                cwd: None,
                display_command: format!("{agent_kind}-agent"),
            },
        )
        .await?;

        let manager = {
            let acp = acp_state.lock().await;
            acp.manager
                .clone()
                .ok_or_else(|| "ACP 连接失败".to_string())?
        };

        self.managers
            .lock()
            .await
            .insert(key, manager.clone());

        Ok(manager)
    }
}

fn find_agent_status(agent_kind: &str) -> Result<AgentInstallStatus, String> {
    let key = agent_kind.to_ascii_lowercase();
    detect_all_agents_sync(None)
        .into_iter()
        .find(|s| agent_kind_key(s.kind) == key)
        .ok_or_else(|| format!("未找到 Agent: {agent_kind}"))
}
