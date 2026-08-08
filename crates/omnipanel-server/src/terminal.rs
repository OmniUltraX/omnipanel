//! 本地终端会话管理（Web 版）。
//!
//! 复刻 `src-tauri/src/commands/terminal.rs` 的 P0 子集：`create_terminal` /
//! `write_terminal` / `resize_terminal` / `close_terminal` / `terminal_snapshot` /
//! `list_shells`。输出经 [`EventBus`](crate::bus::EventBus) 广播，替代 Tauri `app.emit`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use omnipanel_core::output_buffer;
use omnipanel_core::terminal::{list_available_shells, ShellInfo, ShellSpec, Terminal, TerminalConfig};
use serde::Deserialize;
use tokio::sync::Mutex;

use crate::bus::{EventBus, SessionEvent};

static TERMINAL_COUNTER: AtomicU64 = AtomicU64::new(1);

/// Web 服务端持有的会话状态（P0 仅终端；后续按模块扩展）。
pub struct ServerState {
    /// 终端会话表。
    pub terminal_sessions: Mutex<HashMap<String, Terminal>>,
    /// 输出 scrollback 缓冲（与桌面端共用实现）。
    pub output_buffers: omnipanel_core::output_buffer::OutputBuffers,
    /// 事件总线（WS 广播）。
    pub bus: EventBus,
}

impl Default for ServerState {
    fn default() -> Self {
        Self::new()
    }
}

impl ServerState {
    pub fn new() -> Self {
        Self {
            terminal_sessions: Mutex::new(HashMap::new()),
            output_buffers: output_buffer::new_buffers(),
            bus: EventBus::new(),
        }
    }

    /// 创建本地终端（本地 PTY），输出经事件总线广播。
    pub async fn create_terminal(
        &self,
        cols: u16,
        rows: u16,
        shell: Option<ShellSpec>,
    ) -> Result<String, String> {
        let id = format!("term-{}", TERMINAL_COUNTER.fetch_add(1, Ordering::Relaxed));

        let config = TerminalConfig {
            cols,
            rows,
            shell,
            ..Default::default()
        };
        let mut session =
            Terminal::new(config).map_err(|e| format!("Failed to spawn terminal: {e}"))?;

        // 与桌面端一致：取 reader 后由后台线程转发输出到事件总线。
        let reader = session
            .take_reader()
            .ok_or_else(|| "Failed to take PTY reader".to_string())?;

        let session_id = id.clone();
        let buffers = self.output_buffers.clone();
        let bus = self.bus.clone();

        std::thread::spawn(move || {
            use std::io::Read;
            let mut reader = reader;
            // 64KB 读缓冲：大输出场景（如 cat 大文件）下单次 read 可吞下整个
            // conpty 默认 64KB 管道缓冲（与桌面端保持一致）。
            let mut buf = [0u8; 65536];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break, // EOF
                    Ok(n) => {
                        let chunk = &buf[..n];
                        output_buffer::append(&buffers, &session_id, chunk);
                        bus.emit_terminal_output(&session_id, STANDARD.encode(chunk));
                    }
                    Err(_) => {
                        bus.emit_terminal_event(&session_id, SessionEvent::Exited);
                        break;
                    }
                }
            }
        });

        self.terminal_sessions.lock().await.insert(id.clone(), session);
        Ok(id)
    }

    /// 写入终端输入。
    pub async fn write_terminal(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let mut sessions = self.terminal_sessions.lock().await;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("Terminal session {id} not found"))?;
        session
            .write(data)
            .map_err(|e| format!("Failed to write to terminal: {e}"))
    }

    /// 调整终端尺寸。
    pub async fn resize_terminal(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let mut sessions = self.terminal_sessions.lock().await;
        let session = sessions
            .get_mut(id)
            .ok_or_else(|| format!("Terminal session {id} not found"))?;
        session
            .resize(cols, rows)
            .map_err(|e| format!("Failed to resize terminal: {e}"))
    }

    /// 关闭终端会话并清理缓冲。
    pub async fn close_terminal(&self, id: &str) {
        let mut sessions = self.terminal_sessions.lock().await;
        if let Some(mut session) = sessions.remove(id) {
            let _ = session.kill();
        }
        output_buffer::remove(&self.output_buffers, id);
    }

    /// 会话当前 scrollback 快照（base64），前端重连/remount 时重建屏幕。
    pub fn terminal_snapshot(&self, id: &str) -> String {
        let bytes = output_buffer::snapshot(&self.output_buffers, id).unwrap_or_default();
        STANDARD.encode(bytes)
    }

    /// 枚举当前系统可用的本地 shell。
    pub fn list_shells(&self) -> Result<Vec<ShellInfo>, String> {
        Ok(list_available_shells())
    }
}

/// `POST /ipc/invoke` 请求体（供 ipc.rs 使用）。
#[derive(Debug, Deserialize)]
pub struct InvokeRequest {
    pub cmd: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// `POST /ipc/invoke` 响应体（供 ipc.rs 使用）。
#[derive(Debug, serde::Serialize)]
pub struct InvokeResponse<T> {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl InvokeResponse<serde_json::Value> {
    pub fn ok(data: serde_json::Value) -> Self {
        Self {
            ok: true,
            data: Some(data),
            error: None,
        }
    }

    pub fn err(msg: impl Into<String>) -> Self {
        Self {
            ok: false,
            data: None,
            error: Some(msg.into()),
        }
    }
}
