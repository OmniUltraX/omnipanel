//! Reusable ACP turn-running primitives.
//!
//! Extracted from the Tauri command layer (`run_acp_internal_turn`) so that
//! both the internal chat (multi-round tool loop in `ai_chat.rs`) and the
//! gateway (single-round per OpenAI request in `router.rs`) can share the
//! same ACP prompt mechanics without duplicating the spawn + channel +
//! `PromptOptions` wiring.

use std::sync::Arc;
use std::sync::Mutex as StdMutex;

use tokio::sync::mpsc::UnboundedReceiver;
use tokio::task::JoinHandle;

use crate::ir::{StopReason, StreamEvent};
use crate::providers::acp::{AcpManager, PromptOptions};

/// Holds the ACP manager and session ID needed to run prompt rounds.
///
/// Create once per conversation; each call to [`start_round`](Self::start_round)
/// runs one ACP prompt and returns an event stream + join handle.
///
/// # Usage pattern
///
/// ```ignore
/// let runner = AcpRoundRunner::new(manager, session_id);
/// let (mut rx, handle) = runner.start_round(&prompt, true, Some(buf));
/// while let Some(event) = rx.recv().await {
///     // handle events (forward to UI, extract tool calls, etc.)
/// }
/// let stop_reason = handle.await??;
/// ```
pub struct AcpRoundRunner {
    manager: Arc<AcpManager>,
    session_id: String,
}

impl AcpRoundRunner {
    pub fn new(manager: Arc<AcpManager>, session_id: String) -> Self {
        Self { manager, session_id }
    }

    pub fn manager(&self) -> &Arc<AcpManager> {
        &self.manager
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Start a single ACP prompt round.
    ///
    /// Returns:
    /// - [`UnboundedReceiver<StreamEvent>`]: the event stream to drain
    /// - [`JoinHandle<Result<StopReason, String>>`]: await **after** draining
    ///   `rx` to completion to collect the stop reason (or error)
    ///
    /// The caller MUST drain `rx` before awaiting the join handle — the prompt
    /// task sends events into the channel and will stall if the buffer fills
    /// up (though the unbounded channel won't block, dropping events is still
    /// incorrect).
    pub fn start_round(
        &self,
        prompt_text: &str,
        client_tools: bool,
        content_buffer: Option<Arc<StdMutex<String>>>,
        suppress_all_native: bool,
    ) -> (
        UnboundedReceiver<StreamEvent>,
        JoinHandle<Result<StopReason, String>>,
    ) {
        let content_hold = content_buffer.is_some();
        let prompt_options = PromptOptions {
            client_tools,
            emit_done: false,
            content_hold,
            content_buffer,
            suppress_all_native,
        };

        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
        let manager = self.manager.clone();
        let session_id = self.session_id.clone();
        let prompt_text = prompt_text.to_string();

        let handle = tokio::spawn(async move {
            manager
                .prompt(&session_id, &prompt_text, tx, prompt_options)
                .await
                .map_err(|e| e.to_string())
        });

        (rx, handle)
    }

    /// Decide whether content should be held (buffered) for this round.
    ///
    /// Always hold when `client_tools` is active — including tool-result
    /// continuations — so multi-step agents can emit another `tool_calls`
    /// JSON without leaking half-JSON into the UI. The streaming gate still
    /// opens immediately for confirmed plain text.
    pub fn should_hold_content(
        client_tools: bool,
        _is_tool_continuation: bool,
        _expects_tool_retry: bool,
    ) -> bool {
        client_tools
    }

    /// Create a content buffer if `hold` is true.
    pub fn maybe_content_buffer(hold: bool) -> Option<Arc<StdMutex<String>>> {
        if hold {
            Some(Arc::new(StdMutex::new(String::new())))
        } else {
            None
        }
    }

    /// Drain a held content buffer and return text that should be emitted as
    /// [`StreamEvent::ContentDelta`].
    ///
    /// Returns the plain-text prefix only. Embedded / pending `tool_calls`
    /// JSON is left in the buffer for the caller to parse and is never
    /// leaked as content.
    pub fn drain_held_content(buffer: &Arc<StdMutex<String>>) -> Option<String> {
        use crate::providers::acp::client_tools::split_plain_prefix_and_tool_json;

        let text = buffer.lock().map(|g| g.clone()).unwrap_or_default();
        let (plain, json) = split_plain_prefix_and_tool_json(&text);
        if let Ok(mut guard) = buffer.lock() {
            *guard = json.unwrap_or_default();
        }
        let plain = plain.trim().to_string();
        if plain.is_empty() {
            None
        } else {
            Some(plain)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn should_hold_content_logic() {
        // No client_tools → never hold
        assert!(!AcpRoundRunner::should_hold_content(false, false, false));
        assert!(!AcpRoundRunner::should_hold_content(false, true, false));

        // client_tools → always hold (including continuations / multi-step tools)
        assert!(AcpRoundRunner::should_hold_content(true, false, false));
        assert!(AcpRoundRunner::should_hold_content(true, true, false));
        assert!(AcpRoundRunner::should_hold_content(true, true, true));
    }

    #[test]
    fn drain_held_content_skips_tool_json() {
        let buf = Arc::new(StdMutex::new(
            r#"{"tool_calls":[{"id":"tc1","name":"terminal","arguments":{"command":"ls"}}]}"#.to_string(),
        ));
        assert!(AcpRoundRunner::drain_held_content(&buf).is_none());
    }

    #[test]
    fn drain_held_content_returns_plain_text() {
        let buf = Arc::new(StdMutex::new("Hello, world!".to_string()));
        assert_eq!(
            AcpRoundRunner::drain_held_content(&buf).as_deref(),
            Some("Hello, world!")
        );
    }

    #[test]
    fn drain_held_content_skips_empty() {
        let buf = Arc::new(StdMutex::new("   \n\t  ".to_string()));
        assert!(AcpRoundRunner::drain_held_content(&buf).is_none());
    }

    #[test]
    fn drain_held_content_splits_mixed_plain_and_json() {
        let buf = Arc::new(StdMutex::new(
            "好的，我来查\n{\"tool_calls\":[{\"id\":\"c1\",\"type\":\"function\",\"function\":{\"name\":\"omni_terminal_run_terminal_command\",\"arguments\":\"{}\"}}]}".to_string(),
        ));
        assert_eq!(
            AcpRoundRunner::drain_held_content(&buf).as_deref(),
            Some("好的，我来查")
        );
        let left = buf.lock().unwrap().clone();
        assert!(left.contains("\"tool_calls\""));
    }
}
