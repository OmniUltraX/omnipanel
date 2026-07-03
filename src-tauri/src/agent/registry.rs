use std::collections::HashMap;
use std::sync::Arc;

use omnipanel_ai::providers::acp::AcpManager;
use tauri::AppHandle;
use tokio::sync::Mutex;

use crate::commands::acp::{connect_agent, AgentLaunchSpec};
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
        let key = agent_kind.to_ascii_lowercase();
        {
            let map = self.managers.lock().await;
            if let Some(m) = map.get(&key) {
                if m.is_connected() {
                    return Ok(m.clone());
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

        connect_agent(
            app,
            state,
            AgentLaunchSpec {
                binary,
                args,
                cwd: None,
                display_command: format!("{agent_kind}-agent"),
            },
        )
        .await?;

        let manager = {
            let acp = state.acp_state.lock().await;
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
    detect_all_agents_sync()
        .into_iter()
        .find(|s| agent_kind_key(s.kind) == key)
        .ok_or_else(|| format!("未找到 Agent: {agent_kind}"))
}
