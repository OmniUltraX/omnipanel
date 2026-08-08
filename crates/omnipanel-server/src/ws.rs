//! WebSocket 事件订阅：浏览器 `listen(event, handler)` 的 Web 实现。
//!
//! 连接建立后持续把 [`EventBus`] 广播的事件转成 WS 文本帧：
//! `{ "event": "<topic>", "payload": <payload> }`。
//! 前端 shim 收到后按 `event` 字段分发给对应 topic 的 handler。

use axum::extract::{
    ws::{Message, WebSocket},
    State, WebSocketUpgrade,
};
use futures_util::StreamExt;
use std::sync::Arc;
use tokio::sync::broadcast;

use crate::bus::{forward_events_to_ws, Event};
use crate::terminal::ServerState;

/// 升级 `GET /ipc/events` 为 WebSocket，并开始转发事件流。
pub async fn ws_events(
    ws: WebSocketUpgrade,
    State(state): State<Arc<ServerState>>,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<ServerState>) {
    let (tx, mut rx) = socket.split();
    let bus = state.bus.clone();
    let events_rx: broadcast::Receiver<Event> = bus.subscribe();

    // 事件转发任务：从广播订阅写往 WS。
    let forward = tokio::spawn(async move {
        forward_events_to_ws(events_rx, tx).await;
    });

    // 读取循环：消费客户端帧（心跳/关闭），异常即断开。
    while let Some(Ok(msg)) = rx.next().await {
        match msg {
            Message::Close(_) => break,
            Message::Ping(p) => {
                // ping 响应在独立转发任务中较难携带，这里直接忽略（客户端一般不发 ping）；
                // 事件帧本身即心跳。
                let _ = p;
            }
            _ => {}
        }
    }
    forward.abort();
}
