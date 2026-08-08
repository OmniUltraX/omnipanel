//! `/ipc/invoke` 分发：把 HTTP 请求映射为命令调用（等价于 Tauri `invoke`）。
//!
//! P0 覆盖本地终端链路，其余命令后续按模块渐进接入。

use serde::Deserialize;
use serde::Serialize;

use crate::terminal::ServerState;

/// `POST /ipc/invoke` 请求体。
#[derive(Debug, Deserialize)]
pub struct InvokeRequest {
    pub cmd: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// `POST /ipc/invoke` 响应体（成功/失败统一 JSON，前端 shim 据此 resolve/reject）。
#[derive(Debug, Serialize)]
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

/// 分发单条命令。未知命令返回错误（与 Tauri `invoke` 未知命令报错一致）。
pub async fn dispatch(state: &ServerState, req: InvokeRequest) -> InvokeResponse<serde_json::Value> {
    let args = req.args;
    match req.cmd.as_str() {
        "create_terminal" => {
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            let shell = args
                .get("shell")
                .filter(|v| !v.is_null())
                .and_then(|v| serde_json::from_value(v.clone()).ok());
            match state.create_terminal(cols, rows, shell).await {
                Ok(id) => InvokeResponse::ok(serde_json::json!(id)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "write_terminal" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let data: Vec<u8> = args
                .get("data")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|n| n.as_u64()).map(|n| n as u8).collect())
                .unwrap_or_default();
            match state.write_terminal(&id, &data).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "resize_terminal" => {
            let id = get_str(&args, "id").unwrap_or_default();
            let cols = get_u16(&args, "cols").unwrap_or(120);
            let rows = get_u16(&args, "rows").unwrap_or(40);
            match state.resize_terminal(&id, cols, rows).await {
                Ok(()) => InvokeResponse::ok(serde_json::json!(null)),
                Err(e) => InvokeResponse::err(e),
            }
        }
        "close_terminal" => {
            let id = get_str(&args, "id").unwrap_or_default();
            state.close_terminal(&id).await;
            InvokeResponse::ok(serde_json::json!(null))
        }
        "terminal_snapshot" => {
            let id = get_str(&args, "id").unwrap_or_default();
            InvokeResponse::ok(serde_json::json!(state.terminal_snapshot(&id)))
        }
        "list_shells" => {
            let json = state
                .list_shells()
                .map(|shells| serde_json::to_value(shells).unwrap_or(serde_json::json!([])))
                .unwrap_or(serde_json::json!([]));
            InvokeResponse::ok(json)
        }
        other => InvokeResponse::err(format!("unknown command: {other}")),
    }
}

fn get_str(args: &serde_json::Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

fn get_u16(args: &serde_json::Value, key: &str) -> Option<u16> {
    args.get(key).and_then(|v| v.as_u64()).map(|n| n as u16)
}
