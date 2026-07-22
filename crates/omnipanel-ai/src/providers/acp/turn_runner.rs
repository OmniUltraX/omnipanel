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
    /// Content hold prevents leaking half-JSON `tool_calls` to the event
    /// stream. It should be enabled when `client_tools` is active AND the
    /// prompt might produce tool calls (i.e. it's not a pure tool-result
    /// continuation, or it explicitly expects a tool retry).
    pub fn should_hold_content(
        client_tools: bool,
        is_tool_continuation: bool,
        expects_tool_retry: bool,
    ) -> bool {
        client_tools && (!is_tool_continuation || expects_tool_retry)
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
    /// Returns `None` if the buffer is empty, whitespace-only, or looks like
    /// pending tool-call JSON (which should not be leaked to the UI as plain
    /// content).
    pub fn drain_held_content(buffer: &Arc<StdMutex<String>>) -> Option<String> {
        use crate::providers::acp::looks_like_pending_tool_calls_json;

        let text = buffer.lock().map(|g| g.clone()).unwrap_or_default();
        if text.trim().is_empty() || looks_like_pending_tool_calls_json(&text) {
            return None;
        }
        Some(text)
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

        // client_tools + not continuation → hold (first prompt, might produce tool calls)
        assert!(AcpRoundRunner::should_hold_content(true, false, false));

        // client_tools + continuation + no retry → don't hold (pure result feedback)
        assert!(!AcpRoundRunner::should_hold_content(true, true, false));

        // client_tools + continuation + retry → hold (might produce new tool calls)
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
}
