//! WebSocket 事件订阅：浏览器 `listen(event, handler)` 的 Web 实现。
//!
//! 连接建立后持续把 [`EventBus`] 广播的事件转成 WS 文本帧：
//! `{ "event": "<topic>", "payload": <payload> }`。
//! 前端 shim 收到后按 `event` 字段分发给对应 topic 的 handler。

use axum::extract::{
    State, WebSocketUpgrade,
    ws::{Message, WebSocket},
};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use tokio::sync::broadcast;

use crate::bus::{Event, forward_events_to_ws};
use crate::server::AppCtx;

/// 升级 `GET /ipc/events` 为 WebSocket，并开始转发事件流。
pub async fn ws_events(
    ws: WebSocketUpgrade,
    State(ctx): State<AppCtx>,
    headers: axum::http::HeaderMap,
) -> Response {
    if !crate::web_auth::origin_allowed(&headers) {
        return axum::http::StatusCode::FORBIDDEN.into_response();
    }
    if !ctx.auth.authorized(&headers) {
        return axum::http::StatusCode::UNAUTHORIZED.into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(socket, ctx, headers))
}

async fn handle_socket(socket: WebSocket, ctx: AppCtx, headers: axum::http::HeaderMap) {
    let (tx, mut rx) = socket.split();
    let bus = ctx.state.bus.clone();
    let events_rx: broadcast::Receiver<Event> = bus.subscribe();

    // 事件转发任务：从广播订阅写往 WS。
    let forward = tokio::spawn(async move {
        forward_events_to_ws(events_rx, tx).await;
    });

    // 读取循环：消费客户端帧（心跳/关闭），异常即断开。
    let mut auth_check = tokio::time::interval(std::time::Duration::from_secs(30));
    loop {
        let msg = tokio::select! {
            message = rx.next() => match message { Some(Ok(msg)) => msg, _ => break },
            _ = auth_check.tick() => { if !ctx.auth.authorized(&headers) { break; } continue; }
        };
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
