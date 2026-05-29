use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{Emitter, State};

use crate::state::AppState;
use omnipanel_core::terminal::{Terminal, TerminalConfig};

static TERMINAL_COUNTER: AtomicU64 = AtomicU64::new(1);

#[tauri::command]
pub async fn create_terminal(
    state: State<'_, AppState>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let id = format!("term-{}", TERMINAL_COUNTER.fetch_add(1, Ordering::Relaxed));

    let config = TerminalConfig {
        cols,
        rows,
        ..Default::default()
    };
    let mut session = Terminal::new(config)
        .map_err(|e| format!("Failed to spawn terminal: {e}"))?;

    // Take the reader and spawn a background thread to forward output via events.
    // Events survive React remounts unlike Tauri Channels.
    let reader = session
        .take_reader()
        .ok_or_else(|| "Failed to take PTY reader".to_string())?;

    let session_id = id.clone();
    let app_handle = state.app_handle.clone();

    std::thread::spawn(move || {
        use std::io::Read;
        let mut reader = reader;
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF
                Ok(n) => {
                    if app_handle
                        .emit(
                            "terminal-output",
                            serde_json::json!({
                                "session_id": session_id,
                                "data": &buf[..n],
                            }),
                        )
                        .is_err()
                    {
                        break;
                    }
                }
                Err(_) => {
                    let _ = app_handle.emit(
                        "terminal-event",
                        serde_json::json!({
                            "session_id": session_id,
                            "event": "exited"
                        }),
                    );
                    break;
                }
            }
        }
    });

    let mut sessions = state.terminal_sessions.lock().await;
    sessions.insert(id.clone(), session);

    Ok(id)
}

#[tauri::command]
pub async fn write_terminal(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let mut sessions = state.terminal_sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("Terminal session {id} not found"))?;

    session
        .write(&data)
        .map_err(|e| format!("Failed to write to terminal: {e}"))
}

#[tauri::command]
pub async fn resize_terminal(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let mut sessions = state.terminal_sessions.lock().await;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("Terminal session {id} not found"))?;

    session
        .resize(cols, rows)
        .map_err(|e| format!("Failed to resize terminal: {e}"))
}

#[tauri::command]
pub async fn close_terminal(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let mut sessions = state.terminal_sessions.lock().await;
    if let Some(mut session) = sessions.remove(&id) {
        session
            .kill()
            .map_err(|e| format!("Failed to kill terminal: {e}"))?;
    }
    Ok(())
}
