//! WebSocket 事件订阅：浏览器 `listen(event, handler)` 的 Web 实现。
//!
//! 连接建立后持续把 [`EventBus`] 广播的事件转成 WS 文本帧：
//! `{ "event": "<topic>", "payload": <payload> }`。
//! 前端 shim 收到后按 `event` 字段分发给对应 topic 的 handler。

use axum::extract::{
    Query, State, WebSocketUpgrade,
    ws::{Message, WebSocket},
};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use tokio::sync::broadcast;

use crate::bus::{Event, forward_events_to_ws};
use crate::server::AppCtx;

/// `GET /ipc/events?token=...` 的 query 参数（API Key 经 query 传递，
/// 因为浏览器 WebSocket API 无法自定义 header）。
#[derive(Debug, Deserialize)]
pub struct EventsQuery {
    pub token: Option<String>,
}

/// 升级 `GET /ipc/events` 为 WebSocket，并开始转发事件流。
pub async fn ws_events(
    ws: WebSocketUpgrade,
    State(ctx): State<AppCtx>,
    Query(query): Query<EventsQuery>,
) -> Response {
    if let Some(ref expected) = ctx.api_key {
        let token = query.token.as_deref().unwrap_or("");
        if token != expected {
            return axum::http::StatusCode::UNAUTHORIZED.into_response();
        }
    }
    ws.on_upgrade(move |socket| handle_socket(socket, ctx))
}

async fn handle_socket(socket: WebSocket, ctx: AppCtx) {
    let (tx, mut rx) = socket.split();
    let bus = ctx.state.bus.clone();
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
