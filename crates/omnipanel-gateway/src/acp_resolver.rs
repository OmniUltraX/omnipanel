//! Gateway ↔ Tauri bridge for CLI/ACP backend resolution.
//!
//! The gateway crate cannot depend on `src-tauri` (where `AgentRegistry` lives),
//! so we define a trait here that the Tauri layer implements. The gateway calls
//! `resolve()` to obtain an `AcpManager` + session_id for a given agent_kind,
//! and `list_cli_backends()` to enumerate available CLI models for `/v1/models`.

use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_ai::providers::acp::AcpManager;
use serde::{Deserialize, Serialize};

/// Information about a CLI backend for `/v1/models` listing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CliBackendInfo {
    /// e.g. `"cursor"`, `"opencode"`, `"qwen"`
    pub provider_id: String,
    /// e.g. `"Cursor"`, `"OpenCode"`
    pub display_name: String,
    /// Available model names
    pub models: Vec<String>,
}

/// Resolves ACP agents for the gateway's CLI backend path.
///
/// Implemented by the Tauri layer (`GatewayAcpResolver` in `src-tauri`) which
/// wraps `AgentRegistry::get_or_connect` + `AcpManager::ensure_session`.
#[async_trait]
pub trait AcpResolver: Send + Sync + 'static {
    /// Get or connect an ACP agent, and ensure a session for the conversation.
    ///
    /// Returns `(manager, session_id)`.
    async fn resolve(
        &self,
        agent_kind: &str,
        conversation_id: &str,
        model_id: Option<&str>,
        cwd: &str,
    ) -> Result<(Arc<AcpManager>, String), String>;

    /// List available CLI backends for `/v1/models`.
    fn list_cli_backends(&self) -> Vec<CliBackendInfo>;
}
