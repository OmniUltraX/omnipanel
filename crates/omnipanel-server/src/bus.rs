//! 事件总线：Web 端替代 Tauri `app.emit_all` 的统一事件通道。
//!
//! 事件经 WebSocket 广播给所有订阅的浏览器连接，事件名就是订阅 topic
//! （与 `frontend/src/ipc/events.ts` 的常量一一对应，也支持动态事件名：
//! Docker 日志/stats 流、镜像 pull/push/build 进度、文件传输进度等）。
//!
//! ## Channel 帧
//!
//! 桌面端 Channel（单次 invoke 绑定的回调，如 `ai_chat_stream`、`docker_pull_image`
//! 的 progress_channel）在 Web 端用「请求内联 channel_id」表达：
//! 请求携带 `channel_id`，后端把回调帧以 `{ channel_id, payload }` 形式广播，
//! 前端 `core-web.Channel` 按 id 分发到 `onmessage`。

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
    pub name: String,
    pub payload: serde_json::Value,
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
        let (tx, _) = broadcast::channel(2048);
        Self { tx }
    }

    /// 广播事件到所有订阅连接。
    pub fn publish(&self, event: Event) {
        let _ = self.tx.send(event);
    }

    /// 按事件名广播任意 JSON 负载（动态事件，如 `docker-log`、进度 channel）。
    pub fn emit(&self, name: &str, payload: serde_json::Value) {
        self.publish(Event {
            name: name.to_string(),
            payload,
        });
    }

    /// 会话输出（base64）→ `terminal-output` 事件。
    pub fn emit_terminal_output(&self, session_id: &str, base64_data: String) {
        self.emit(
            "terminal-output",
            serde_json::json!({
                "type": "terminal-output",
                "session_id": session_id,
                "data": base64_data,
            }),
        );
    }

    /// 会话生命周期 → `terminal-event` 事件。
    pub fn emit_terminal_event(&self, session_id: &str, event: SessionEvent) {
        self.emit(
            "terminal-event",
            serde_json::json!({
                "type": "terminal-event",
                "session_id": session_id,
                "event": match event {
                    SessionEvent::Exited => "exited",
                },
            }),
        );
    }

    /// Channel 回调帧：`{ channel_id, payload }`，前端 `core-web.Channel` 按 id 分发。
    pub fn emit_channel(&self, channel_id: &str, payload: serde_json::Value) {
        self.emit(
            "@channel",
            serde_json::json!({ "channelId": channel_id, "payload": payload }),
        );
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
            "event": event.name,
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
    by_event: HashMap<String, usize>,
}

#[allow(dead_code)]
impl SubscriberRegistry {
    fn new() -> Self {
        Self {
            by_event: HashMap::new(),
        }
    }
}
