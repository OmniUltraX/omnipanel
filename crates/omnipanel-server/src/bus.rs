//! 事件总线：Web 端替代 Tauri `app.emit_all` 的统一事件通道。
//!
//! 事件经 WebSocket 广播给所有订阅的浏览器连接，事件名就是订阅 topic
//! （与 `frontend/src/ipc/events.ts` 的常量一一对应）。

use std::collections::HashMap;

use axum::extract::ws::Message;
use futures_util::SinkExt;
use serde::Serialize;
use tokio::sync::broadcast;

/// 会话生命周期事件（`terminal-event` payload 的 `event` 字段）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionEvent {
    Exited,
}

/// 事件名称（与 `frontend/src/ipc/events.ts` 对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EventKind {
    TerminalOutput,
    TerminalEvent,
}

impl EventKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            EventKind::TerminalOutput => "terminal-output",
            EventKind::TerminalEvent => "terminal-event",
        }
    }
}

/// 事件负载（可直接序列化为前端 `listen` 收到的 payload）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum EventPayload {
    #[serde(rename = "terminal-output")]
    TerminalOutput { session_id: String, data: String },
    #[serde(rename = "terminal-event")]
    TerminalEvent { session_id: String, event: String },
}

/// 广播的事件条目。
#[derive(Debug, Clone)]
pub struct Event {
    pub kind: EventKind,
    pub payload: EventPayload,
}

/// 事件总线句柄：`publish` 广播事件，`subscribe` 建立 WS 订阅流。
#[derive(Clone)]
pub struct EventBus {
    tx: broadcast::Sender<Event>,
}

impl Default for EventBus {
    fn default() -> Self {
        Self::new()
    }
}

impl EventBus {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(512);
        Self { tx }
    }

    /// 广播事件到所有订阅连接。
    pub fn publish(&self, event: Event) {
        let _ = self.tx.send(event);
    }

    /// 会话输出（base64）→ `terminal-output` 事件。
    pub fn emit_terminal_output(&self, session_id: &str, base64_data: String) {
        self.publish(Event {
            kind: EventKind::TerminalOutput,
            payload: EventPayload::TerminalOutput {
                session_id: session_id.to_string(),
                data: base64_data,
            },
        });
    }

    /// 会话生命周期 → `terminal-event` 事件。
    pub fn emit_terminal_event(&self, session_id: &str, event: SessionEvent) {
        self.publish(Event {
            kind: EventKind::TerminalEvent,
            payload: EventPayload::TerminalEvent {
                session_id: session_id.to_string(),
                event: match event {
                    SessionEvent::Exited => "exited".to_string(),
                },
            },
        });
    }

    /// 订阅事件流（每个 WS 连接一个 receiver）。
    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}

/// 把事件流转写为 WS 文本帧。
pub async fn forward_events_to_ws(
    mut rx: broadcast::Receiver<Event>,
    mut sink: futures_util::stream::SplitSink<
        axum::extract::ws::WebSocket,
        axum::extract::ws::Message,
    >,
) {
    while let Ok(event) = rx.recv().await {
        let frame = match serde_json::to_string(&serde_json::json!({
            "event": event.kind.as_str(),
            "payload": event.payload,
        })) {
            Ok(json) => json,
            Err(_) => continue,
        };
        if sink.send(Message::Text(frame.into())).await.is_err() {
            break;
        }
    }
}

/// 活跃连接数（供 `/ipc/status` 展示，P0 仅统计 EventBus 订阅方数量级）。
pub fn active_subscriber_hint(bus: &EventBus) -> usize {
    // broadcast::Sender 本身不暴露订阅数，这里保留扩展点；
    // P0 用有界 receiver 池替代，见 ws.rs。
    let _ = bus;
    0
}

/// 预留：多连接订阅管理（后续可替换 broadcast，按 event 维度精确统计）。
#[allow(dead_code)]
struct SubscriberRegistry {
    by_event: HashMap<EventKind, usize>,
}

#[allow(dead_code)]
impl SubscriberRegistry {
    fn new() -> Self {
        Self {
            by_event: HashMap::new(),
        }
    }
}
