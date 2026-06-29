pub mod client;
pub mod translate;
pub mod types;

use anyhow::{Result, bail};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Mutex;

use crate::ir::{StopReason, StreamEvent};
use crate::providers::acp::client::AcpClient;
use crate::providers::acp::translate::translate_update_value;
use crate::providers::acp::types::*;

/// Manages a long-lived ACP agent subprocess and conversation sessions.
pub struct AcpManager {
    client: Arc<AcpClient>,
    initialized: AtomicBool,
    agent_name: Mutex<Option<String>>,
    conversation_sessions: Mutex<HashMap<String, String>>,
}

impl AcpManager {
    pub fn new(
        binary_path: &str,
        args: Vec<String>,
        spawn_env: HashMap<String, String>,
        spawn_cwd: Option<String>,
    ) -> Self {
        Self {
            client: Arc::new(AcpClient::new(
                binary_path,
                args,
                spawn_env,
                spawn_cwd,
            )),
            initialized: AtomicBool::new(false),
            agent_name: Mutex::new(None),
            conversation_sessions: Mutex::new(HashMap::new()),
        }
    }

    pub async fn agent_name(&self) -> Option<String> {
        self.agent_name.lock().await.clone()
    }

    pub fn is_connected(&self) -> bool {
        self.initialized.load(Ordering::SeqCst)
    }

    pub async fn connect(self: &Arc<Self>) -> Result<()> {
        self.client.ensure_running().await?;

        let init_params = InitializeParams {
            protocol_version: 1,
            client_info: ClientInfo {
                name: "omnipanel".to_string(),
                version: "0.1.0".to_string(),
            },
            capabilities: ClientCapabilities {},
        };

        let result = self
            .client
            .request(
                "initialize",
                Some(serde_json::to_value(&init_params)?),
            )
            .await?;

        let init_result: InitializeResult = serde_json::from_value(result)?;
        *self.agent_name.lock().await = Some(init_result.agent_info.name.clone());
        self.initialized.store(true, Ordering::SeqCst);

        tracing::info!(
            "ACP agent '{}' initialized (protocol v{})",
            init_result.agent_info.name,
            init_result.agent_info.version
        );

        Ok(())
    }

    pub async fn disconnect(self: &Arc<Self>) -> Result<()> {
        self.client.kill().await;
        self.initialized.store(false, Ordering::SeqCst);
        *self.agent_name.lock().await = None;
        self.conversation_sessions.lock().await.clear();
        Ok(())
    }

    pub async fn ensure_session(
        &self,
        conversation_id: &str,
        cwd: &str,
        mcp_servers: Vec<serde_json::Value>,
    ) -> Result<String> {
        {
            let sessions = self.conversation_sessions.lock().await;
            if let Some(sid) = sessions.get(conversation_id) {
                return Ok(sid.clone());
            }
        }

        let params = SessionNewParams {
            cwd: cwd.to_string(),
            mcp_servers,
        };

        let result = self
            .client
            .request(
                "session/new",
                Some(serde_json::to_value(&params)?),
            )
            .await?;

        let new_result: SessionNewResult = serde_json::from_value(result)?;
        self.conversation_sessions
            .lock()
            .await
            .insert(conversation_id.to_string(), new_result.session_id.clone());
        Ok(new_result.session_id)
    }

    pub async fn cancel_prompt(&self, conversation_id: &str) -> Result<()> {
        let session_id = self
            .conversation_sessions
            .lock()
            .await
            .get(conversation_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("No ACP session for conversation"))?;

        self.client
            .notify(
                "session/cancel",
                Some(serde_json::to_value(&SessionCancelParams { session_id })?),
            )
            .await
    }

    pub async fn respond_permission(&self, request_id: u64, option_id: &str) -> Result<()> {
        let response = JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: request_id,
            result: Some(serde_json::json!({
                "outcome": {
                    "outcome": "selected",
                    "optionId": option_id,
                }
            })),
            error: None,
        };
        self.client.write_response(response).await
    }

    /// Run a prompt turn, forwarding ACP events to `event_tx`.
    pub async fn prompt(
        &self,
        session_id: &str,
        user_text: &str,
        event_tx: tokio::sync::mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<StopReason> {
        if !self.initialized.load(Ordering::SeqCst) {
            bail!("ACP agent not connected");
        }

        let prompt = vec![ContentBlock {
            block_type: "text".to_string(),
            text: Some(user_text.to_string()),
        }];

        let client = self.client.clone();

        {
            let event_tx_updates = event_tx.clone();
            self.client
                .set_notification_handler(Arc::new(move |method, params| {
                    if method != "session/update" {
                        return;
                    }
                    if let Ok(notif) =
                        serde_json::from_value::<SessionUpdateNotification>(params.clone())
                    {
                        for event in translate_session_update_from_notif(&notif) {
                            if event_tx_updates.send(event).is_err() {
                                break;
                            }
                        }
                    }
                }))
                .await;

            let event_tx_perm = event_tx.clone();
            self.client
                .set_server_request_handler(Arc::new(move |id, method, params| {
                    if method != "session/request_permission" {
                        return None;
                    }
                    let Ok(perm) =
                        serde_json::from_value::<RequestPermissionParams>(params.clone())
                    else {
                        return None;
                    };
                    let tool_call_id = perm
                        .tool_call
                        .get("toolCallId")
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string();
                    let title = perm
                        .tool_call
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("tool")
                        .to_string();
                    let raw_input = perm
                        .tool_call
                        .get("rawInput")
                        .map(|v| serde_json::to_string(v).unwrap_or_default())
                        .unwrap_or_else(|| "{}".to_string());
                    let options: Vec<(String, String)> = perm
                        .options
                        .iter()
                        .map(|o| (o.option_id.clone(), o.name.clone()))
                        .collect();

                    let _ = event_tx_perm.send(StreamEvent::PermissionRequest {
                        request_id: id,
                        tool_call_id,
                        title,
                        raw_input,
                        options,
                    });
                    None
                }))
                .await;
        }

        let sid = session_id.to_string();
        let client_bg = client.clone();
        let (done_tx, done_rx) = tokio::sync::oneshot::channel::<Result<StopReason>>();

        tokio::spawn(async move {
            let result = async {
                let val = client_bg
                    .request(
                        "session/prompt",
                        Some(serde_json::to_value(&SessionPromptParams {
                            session_id: sid,
                            prompt,
                        })?),
                    )
                    .await?;
                let prompt_result: PromptResult = serde_json::from_value(val)?;
                Ok(parse_stop_reason(prompt_result.stop_reason.as_deref()))
            }
            .await;

            let _ = done_tx.send(result);
        });

        match done_rx.await {
            Ok(Ok(stop)) => {
                let _ = event_tx.send(StreamEvent::Done {
                    stop_reason: stop.clone(),
                });
                self.client.clear_handlers().await;
                Ok(stop)
            }
            Ok(Err(e)) => {
                let _ = event_tx.send(StreamEvent::Error {
                    message: e.to_string(),
                });
                self.client.clear_handlers().await;
                Err(e)
            }
            Err(_) => {
                self.client.clear_handlers().await;
                bail!("ACP prompt task dropped")
            }
        }
    }
}

fn translate_session_update_from_notif(notif: &SessionUpdateNotification) -> Vec<StreamEvent> {
    translate_update_value(&notif.update)
}

fn parse_stop_reason(raw: Option<&str>) -> StopReason {
    match raw {
        Some("cancelled") => StopReason::Cancelled,
        Some("refusal") => StopReason::Refusal,
        Some("max_tokens") => StopReason::MaxTokens,
        Some("error") => StopReason::Error,
        _ => StopReason::EndTurn,
    }
}
