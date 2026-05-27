use std::collections::HashMap;
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::sync::Mutex;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

/// WebSocket connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsConfig {
    pub url: String,
    pub headers: HashMap<String, String>,
}

/// WebSocket message for IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WsMessage {
    pub direction: String, // "in" or "out"
    pub data: String,
    pub msg_type: String, // "text", "binary", "ping", "pong"
    pub timestamp: String,
}

/// A connected WebSocket session.
pub struct WsSession {
    write_tx: mpsc::UnboundedSender<String>,
    _task: tokio::task::JoinHandle<()>,
}

impl WsSession {
    /// Connect to a WebSocket server and return a session handle.
    /// Received messages are forwarded via the `on_message` channel.
    pub async fn connect(
        config: WsConfig,
        on_message: mpsc::UnboundedSender<WsMessage>,
    ) -> Result<Self, String> {
        let mut request = config
            .url
            .into_client_request()
            .map_err(|e| format!("Invalid WebSocket URL: {e}"))?;

        // Add custom headers
        for (key, value) in &config.headers {
            request
                .headers_mut()
                .insert(
                    key.parse::<tokio_tungstenite::tungstenite::http::HeaderName>()
                        .map_err(|e| format!("Invalid header name {key}: {e}"))?,
                    value
                        .parse::<tokio_tungstenite::tungstenite::http::HeaderValue>()
                        .map_err(|e| format!("Invalid header value for {key}: {e}"))?,
                );
        }

        let (ws_stream, _) = connect_async(request)
            .await
            .map_err(|e| format!("WebSocket connect failed: {e}"))?;

        let (mut write, mut read) = ws_stream.split();
        let (write_tx, mut write_rx) = mpsc::unbounded_channel::<String>();

        // Task: forward outgoing messages from channel to WebSocket
        let send_task = tokio::spawn(async move {
            while let Some(text) = write_rx.recv().await {
                if write.send(Message::Text(text.into())).await.is_err() {
                    break;
                }
            }
        });

        // Task: read incoming WebSocket messages and forward to channel
        let recv_task = {
            let on_message = on_message.clone();
            tokio::spawn(async move {
                while let Some(result) = StreamExt::next(&mut read).await {
                    match result {
                        Ok(Message::Text(text)) => {
                            let msg = WsMessage {
                                direction: "in".to_string(),
                                data: text.to_string(),
                                msg_type: "text".to_string(),
                                timestamp: chrono_now(),
                            };
                            let _ = on_message.send(msg);
                        }
                        Ok(Message::Binary(bin)) => {
                            let msg = WsMessage {
                                direction: "in".to_string(),
                                data: hex::encode(bin.as_ref()),
                                msg_type: "binary".to_string(),
                                timestamp: chrono_now(),
                            };
                            let _ = on_message.send(msg);
                        }
                        Ok(Message::Ping(data)) => {
                            let msg = WsMessage {
                                direction: "in".to_string(),
                                data: String::from_utf8_lossy(data.as_ref()).to_string(),
                                msg_type: "ping".to_string(),
                                timestamp: chrono_now(),
                            };
                            let _ = on_message.send(msg);
                        }
                        Ok(Message::Pong(data)) => {
                            let msg = WsMessage {
                                direction: "in".to_string(),
                                data: String::from_utf8_lossy(data.as_ref()).to_string(),
                                msg_type: "pong".to_string(),
                                timestamp: chrono_now(),
                            };
                            let _ = on_message.send(msg);
                        }
                        Ok(Message::Close(_)) => break,
                        Err(_) => break,
                        _ => {}
                    }
                }
            })
        };

        // Combine tasks
        let task = tokio::spawn(async move {
            tokio::select! {
                _ = send_task => {},
                _ = recv_task => {},
            }
        });

        Ok(Self {
            write_tx,
            _task: task,
        })
    }

    /// Send a text message through the WebSocket.
    pub fn send_text(&self, text: String) -> Result<(), String> {
        self.write_tx
            .send(text)
            .map_err(|e| format!("Send failed: {e}"))
    }

    /// Send binary data through the WebSocket (hex-encoded).
    pub fn send_binary_hex(&self, hex_data: &str) -> Result<(), String> {
        let data = hex::decode(hex_data).map_err(|e| format!("Invalid hex data: {e}"))?;
        // For binary, we need to go through the write channel differently
        // For now, send as text with hex encoding
        self.write_tx
            .send(String::from_utf8_lossy(&data).to_string())
            .map_err(|e| format!("Send failed: {e}"))
    }

    /// Send a ping message.
    pub fn send_ping(&self) -> Result<(), String> {
        // Ping is handled at the protocol level by tungstenite
        // We send an empty text message as a keep-alive
        self.write_tx
            .send(String::new())
            .map_err(|e| format!("Ping failed: {e}"))
    }
}

/// Shared state for all WebSocket sessions.
pub type WsSessions = Arc<Mutex<HashMap<String, WsSession>>>;

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() % 86400;
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}
