pub mod client;
pub mod translate;
pub mod types;

use anyhow::{bail, Result};
use async_trait::async_trait;
use futures::{Stream, StreamExt};
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio_stream::wrappers::ReceiverStream;

use crate::ir::{StopReason, StreamEvent};
use crate::provider::AiProvider;
use crate::providers::acp::client::AcpClient;
use crate::providers::acp::translate::translate_session_update;
use crate::providers::acp::types::*;
use crate::types::{ChatMessage, ChatRequest, ChatResponse, ModelInfo, Role, Usage};

/// ACP Provider — wraps a CLI coding agent (Claude Code, Cursor, etc.)
/// as a standard AiProvider.
///
/// The ACP agent runs as a long-lived subprocess communicating via
/// JSON-RPC 2.0 over stdio. Session updates are translated into
/// IR StreamEvents using the same pattern as cli-agent-gateway.
pub struct AcpProvider {
    agent_name: String,
    provider_name: String,
    binary_path: String,
    args: Vec<String>,
    profile: AcpProfile,
    client: Arc<Mutex<AcpClient>>,
    sessions: Arc<Mutex<HashMap<String, String>>>, // conversation_id -> sessionId
    models: Vec<ModelInfo>,
    workspace: Option<String>,
}

impl AcpProvider {
    pub fn new(
        agent_name: &str,
        binary_path: &str,
        args: Vec<String>,
        profile: AcpProfile,
        workspace: Option<String>,
    ) -> Self {
        Self {
            agent_name: agent_name.to_string(),
            provider_name: format!("acp:{}", agent_name),
            binary_path: binary_path.to_string(),
            args: args.clone(),
            profile,
            client: Arc::new(Mutex::new(AcpClient::new(binary_path, args))),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            models: Vec::new(),
            workspace,
        }
    }

    /// Initialize the ACP connection: spawn agent, run handshake.
    pub async fn initialize(&mut self) -> Result<()> {
        let mut client = self.client.lock().await;
        client.ensure_running().await?;

        // ACP initialize handshake
        let init_params = InitializeParams {
            protocol_version: 1,
            client_info: ClientInfo {
                name: "omnipanel".to_string(),
                version: "0.1.0".to_string(),
            },
            capabilities: ClientCapabilities {},
        };

        let result = client
            .request(
                "initialize",
                Some(serde_json::to_value(&init_params)?),
            )
            .await?;

        let init_result: InitializeResult = serde_json::from_value(result)?;

        tracing::info!(
            "ACP agent '{}' initialized (v{})",
            init_result.agent_info.name,
            init_result.agent_info.version
        );

        // Extract models from agent capabilities
        if let Some(model_names) = init_result.agent_capabilities.models {
            self.models = model_names
                .iter()
                .map(|m| ModelInfo {
                    id: format!("{}/{}", self.agent_name, m),
                    name: m.clone(),
                    provider: format!("acp:{}", self.agent_name),
                    context_window: None,
                })
                .collect();
        }

        // Authenticate if needed
        if let Some(auth_methods) = init_result.auth_methods {
            if !auth_methods.is_empty() {
                let _ = client
                    .request(
                        "authenticate",
                        Some(serde_json::to_value(&AuthenticateParams {
                            method_id: auth_methods[0].id.clone(),
                        })?),
                    )
                    .await;
            }
        }

        // Install notification handler for session/update
        let (tx, _rx) = tokio::sync::mpsc::channel::<StreamEvent>(256);
        // Note: In production, this tx would be wired to the active stream
        // For now we set up the handler structure

        Ok(())
    }

    /// Get or create an ACP session for a conversation.
    async fn get_or_create_session(&self, conversation_id: &str) -> Result<String> {
        let mut sessions = self.sessions.lock().await;
        if let Some(sid) = sessions.get(conversation_id) {
            return Ok(sid.clone());
        }

        let client = self.client.lock().await;
        let result = client
            .request(
                "session/new",
                Some(serde_json::to_value(&SessionNewParams {
                    cwd: self.workspace.clone(),
                })?),
            )
            .await?;

        let new_result: SessionNewResult = serde_json::from_value(result)?;
        let session_id = new_result.session_id;

        sessions.insert(conversation_id.to_string(), session_id.clone());
        Ok(session_id)
    }
}

#[async_trait]
impl AiProvider for AcpProvider {
    fn name(&self) -> &str {
        &self.provider_name
    }

    fn models(&self) -> Vec<ModelInfo> {
        self.models.clone()
    }

    async fn chat(&self, request: ChatRequest) -> Result<ChatResponse> {
        // For non-streaming, collect all stream events
        let mut stream = self.chat_stream(request).await?;
        let mut content = String::new();
        let mut usage = Usage::default();

        while let Some(event) = stream.next().await {
            match event? {
                StreamEvent::ContentDelta { text } => content.push_str(&text),
                StreamEvent::Usage {
                    input_tokens,
                    output_tokens,
                } => {
                    usage.input_tokens = input_tokens;
                    usage.output_tokens = output_tokens;
                }
                StreamEvent::Done { .. } => break,
                StreamEvent::Error { message } => bail!("ACP error: {}", message),
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
            usage,
        })
    }

    async fn chat_stream(
        &self,
        request: ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamEvent>> + Send>>> {
        // Ensure the agent is running
        {
            let client = self.client.lock().await;
            if !client.is_running() {
                bail!("ACP agent not initialized. Call initialize() first.");
            }
        }

        // Get or create session
        let conversation_id = format!("conv_{}", request.messages.len()); // simplified
        let session_id = self.get_or_create_session(&conversation_id).await?;

        // Set model if specified
        {
            let client = self.client.lock().await;
            let _ = client
                .notify(
                    "session/set_model",
                    Some(serde_json::to_value(&SessionSetModelParams {
                        session_id: session_id.clone(),
                        model: request.model.clone(),
                    })?),
                )
                .await;
        }

        // Build the prompt from message history
        let prompt = request
            .messages
            .iter()
            .filter(|m| m.role == Role::User || m.role == Role::Assistant)
            .map(|m| {
                let role_prefix = match m.role {
                    Role::User => "User",
                    Role::Assistant => "Assistant",
                    _ => "",
                };
                format!("{}: {}", role_prefix, m.content)
            })
            .collect::<Vec<_>>()
            .join("\n\n");

        // Create a channel for streaming events
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<StreamEvent>>(64);

        // Install notification handler that translates ACP events → StreamEvents
        let event_tx = tx.clone();
        let profile = self.profile;
        {
            let client = self.client.lock().await;
            client
                .set_notification_handler(Arc::new(move |method, params| {
                    if method == "session/update" {
                        if let Ok(update) =
                            serde_json::from_value::<SessionUpdateParams>(params.clone())
                        {
                            let events = translate_session_update(&update.session_update);
                            for event in events {
                                let _ = event_tx.blocking_send(Ok(event));
                            }
                        }
                    }
                }))
                .await;

            // Install permission handler based on profile
            let perm_tx = tx.clone();
            client
                .set_server_request_handler(Arc::new(move |_id, method, params| {
                    if method == "session/request_permission" {
                        let (outcome, emit_to_client) = profile.decide_permission();
                        if emit_to_client {
                            // Forward tool call to client
                            if let Ok(perm) =
                                serde_json::from_value::<RequestPermissionParams>(params.clone())
                            {
                                let _ = perm_tx.blocking_send(Ok(StreamEvent::ToolCall {
                                    id: perm.permission.id,
                                    name: perm.permission.tool,
                                    arguments: serde_json::to_string(&perm.permission.arguments)
                                        .unwrap_or_default(),
                                }));
                            }
                        }
                        Some(
                            serde_json::to_value(&PermissionResponse { outcome })
                                .unwrap_or_default(),
                        )
                    } else {
                        None
                    }
                }))
                .await;
        }

        // Send the prompt (non-blocking, stream events arrive via notification handler)
        let client = self.client.clone();
        let sid = session_id.clone();
        tokio::spawn(async move {
            let client = client.lock().await;
            let result = client
                .request(
                    "session/prompt",
                    Some(
                        serde_json::to_value(&SessionPromptParams {
                            session_id: sid,
                            prompt,
                        })
                        .unwrap(),
                    ),
                )
                .await;

            match result {
                Ok(val) => {
                    let prompt_result: PromptResult =
                        serde_json::from_value(val).unwrap_or(PromptResult {
                            stop_reason: None,
                        });
                    let stop = match prompt_result.stop_reason.as_deref() {
                        Some("tool_use") => StopReason::ToolUse,
                        Some("max_tokens") => StopReason::MaxTokens,
                        Some("error") => StopReason::Error,
                        _ => StopReason::EndTurn,
                    };
                    let _ = tx.send(Ok(StreamEvent::Done { stop_reason: stop })).await;
                }
                Err(e) => {
                    let _ = tx
                        .send(Err(anyhow::anyhow!("ACP prompt error: {}", e)))
                        .await;
                }
            }
        });

        Ok(Box::pin(ReceiverStream::new(rx)))
    }
}
