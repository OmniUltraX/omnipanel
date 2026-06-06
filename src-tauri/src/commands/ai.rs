use serde::{Deserialize, Serialize};
use tauri::{State, ipc::Channel};

use crate::state::AppState;
use omnipanel_ai::ir::StreamEvent;
use omnipanel_ai::types::{ChatMessage, ChatRequest, ModelInfo, Role};

#[derive(Serialize, Deserialize)]
pub struct ProviderInfo {
    pub id: String,
    pub name: String,
    pub models: Vec<ModelInfo>,
}

/// Send a message to the current AI provider and stream back events.
///
/// When `history` is provided, those messages are prepended to the request so the
/// LLM sees the full multi-turn conversation.  If `history` is `None` (or empty)
/// the request falls back to a single-message payload (backward compatible).
#[tauri::command]
pub async fn ai_send_message(
    state: State<'_, AppState>,
    _conversation_id: String,
    content: String,
    on_event: Channel<StreamEvent>,
    history: Option<Vec<ChatMessage>>,
) -> Result<(), String> {
    let provider_name = state
        .current_provider
        .lock()
        .await
        .clone()
        .ok_or("No AI provider selected")?;

    let model = state
        .current_model
        .lock()
        .await
        .clone()
        .ok_or("No AI model selected")?;

    let registry = state.ai_registry.lock().await;
    let provider = registry
        .get(&provider_name)
        .ok_or_else(|| format!("Provider '{}' not found", provider_name))?;

    // Build the message list: conversation history (if any) + the new user message
    let mut messages: Vec<ChatMessage> = history.unwrap_or_default();
    messages.push(ChatMessage {
        role: Role::User,
        content,
        tool_call_id: None,
        tool_calls: None,
        name: None,
    });

    let request = ChatRequest {
        model,
        messages,
        stream: true,
        tools: None,
        temperature: None,
        max_tokens: None,
    };

    let mut stream = provider
        .chat_stream(request)
        .await
        .map_err(|e| e.to_string())?;

    use futures::StreamExt;
    while let Some(event) = stream.next().await {
        match event {
            Ok(evt) => {
                let _ = on_event.send(evt);
            }
            Err(e) => {
                let _ = on_event.send(StreamEvent::Error {
                    message: e.to_string(),
                });
                break;
            }
        }
    }

    Ok(())
}

/// List all available models from all registered providers.
#[tauri::command]
pub async fn ai_list_models(state: State<'_, AppState>) -> Result<Vec<ModelInfo>, String> {
    let registry = state.ai_registry.lock().await;
    Ok(registry.all_models())
}

/// Set the active AI provider and model.
#[tauri::command]
pub async fn ai_set_provider(
    state: State<'_, AppState>,
    provider_id: String,
    model_id: String,
) -> Result<(), String> {
    let registry = state.ai_registry.lock().await;
    if registry.get(&provider_id).is_none() {
        return Err(format!("Provider '{}' not found", provider_id));
    }
    drop(registry);

    *state.current_provider.lock().await = Some(provider_id);
    *state.current_model.lock().await = Some(model_id);
    Ok(())
}

/// List all registered providers with their models.
#[tauri::command]
pub async fn ai_list_providers(state: State<'_, AppState>) -> Result<Vec<ProviderInfo>, String> {
    let registry = state.ai_registry.lock().await;
    let providers: Vec<ProviderInfo> = registry
        .list()
        .into_iter()
        .map(|name| ProviderInfo {
            id: name.to_string(),
            name: name.to_string(),
            models: registry.get(name).map(|p| p.models()).unwrap_or_default(),
        })
        .collect();
    Ok(providers)
}

/// Add an ACP CLI agent as a provider.
#[tauri::command]
pub async fn ai_add_acp_agent(
    state: State<'_, AppState>,
    binary_path: String,
    name: String,
) -> Result<(), String> {
    use omnipanel_ai::providers::acp::AcpProvider;
    use omnipanel_ai::providers::acp::types::AcpProfile;

    let mut provider = AcpProvider::new(&name, &binary_path, vec![], AcpProfile::ClientTools, None);

    provider
        .initialize()
        .await
        .map_err(|e| format!("Failed to initialize ACP agent: {}", e))?;

    let mut registry = state.ai_registry.lock().await;
    registry.register(Box::new(provider));

    Ok(())
}

/// Get the current active provider and model.
#[tauri::command]
pub async fn ai_get_active(state: State<'_, AppState>) -> Result<Option<(String, String)>, String> {
    let provider = state.current_provider.lock().await.clone();
    let model = state.current_model.lock().await.clone();
    match (provider, model) {
        (Some(p), Some(m)) => Ok(Some((p, m))),
        _ => Ok(None),
    }
}
