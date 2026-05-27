use std::sync::atomic::{AtomicU64, Ordering};

use tauri::ipc::Channel;
use tauri::{Emitter, State};

use crate::state::AppState;
use crate::terminal::{LocalSession, TerminalSession, detect_shell};

static TERM_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Return the detected shell name and type for the current platform.
#[tauri::command]
pub async fn get_shell_type() -> Result<(String, String), String> {
    let (name, kind) = detect_shell();
    let kind_str = match kind {
        crate::terminal::ShellKind::Bash => "bash",
        crate::terminal::ShellKind::Zsh => "zsh",
        crate::terminal::ShellKind::PowerShell => "powershell",
        crate::terminal::ShellKind::PowerShell5 => "powershell5",
        crate::terminal::ShellKind::Fish => "fish",
        crate::terminal::ShellKind::Cmd => "cmd",
    };
    Ok((name, kind_str.to_string()))
}

#[tauri::command]
pub async fn create_terminal(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
    working_dir: Option<String>,
    on_output: Channel<Vec<u8>>,
) -> Result<String, String> {
    let id = format!("term-{}", TERM_COUNTER.fetch_add(1, Ordering::Relaxed));

    let mut session = LocalSession::spawn(id.clone(), cols, rows, working_dir.as_deref())
        .map_err(|e| format!("Failed to create terminal: {e}"))?;

    // Take the reader out and spawn an async task to forward output.
    let reader = session
        .take_reader()
        .ok_or_else(|| "Reader already taken".to_string())?;

    let session_id = id.clone();
    let app_handle = state.app_handle.clone();

    tokio::task::spawn_blocking(move || {
        use std::io::Read;
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF — process exited
                Ok(n) => {
                    if on_output.send(buf[..n].to_vec()).is_err() {
                        break; // frontend dropped the channel
                    }
                }
                Err(_) => break,
            }
        }
        // Notify frontend that the session exited.
        let _ = app_handle.emit(
            "terminal-event",
            serde_json::json!({
                "session_id": session_id,
                "event": "exited"
            }),
        );
    });

    state
        .terminals
        .lock()
        .await
        .insert(id.clone(), TerminalSession::Local(session));

    tracing::info!("Created terminal {id} ({cols}x{rows})");
    Ok(id)
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().await;
    let session = terminals
        .get_mut(&id)
        .ok_or_else(|| format!("Terminal {id} not found"))?;
    session
        .write(&data)
        .map_err(|e| format!("Write failed: {e}"))
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().await;
    let session = terminals
        .get_mut(&id)
        .ok_or_else(|| format!("Terminal {id} not found"))?;
    session
        .resize(cols, rows)
        .map_err(|e| format!("Resize failed: {e}"))
}

#[tauri::command]
pub async fn close_terminal(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut terminals = state.terminals.lock().await;
    if let Some(mut session) = terminals.remove(&id) {
        let _ = session.kill();
        tracing::info!("Closed terminal {id}");
        Ok(())
    } else {
        Err(format!("Terminal {id} not found"))
    }
}
