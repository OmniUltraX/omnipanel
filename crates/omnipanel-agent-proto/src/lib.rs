//! Agent sidecar 线协议。stdin/stdout 一行一条 JSON-RPC 2.0。
//!
//! 人话说明见 `docs/plugins/sidecar-agent.md`。冲突时以本文件为准。

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const PROTOCOL_VERSION: u64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RpcRequest {
    pub id: i64,
    pub method: String,
    pub params: Value,
}

#[derive(Debug)]
pub enum Incoming {
    Request(RpcRequest),
    Response { id: i64, result: Value },
    Failure { id: i64, message: String },
    ChatEvent { id: i64, event: Value },
}

pub enum ReadJson {
    Value(Value),
    Invalid(String),
    Eof,
}

pub fn read_json_line(reader: &mut impl BufRead) -> std::io::Result<ReadJson> {
    loop {
        let mut line = String::new();
        let n = reader.read_line(&mut line)?;
        if n == 0 {
            return Ok(ReadJson::Eof);
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(trimmed) {
            Ok(value) => return Ok(ReadJson::Value(value)),
            Err(err) => return Ok(ReadJson::Invalid(err.to_string())),
        }
    }
}

pub fn write_json_line(writer: &mut impl Write, value: &Value) -> std::io::Result<()> {
    serde_json::to_writer(&mut *writer, value).map_err(std::io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

pub fn request_value(id: i64, method: &str, params: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params,
    })
}

pub fn result_value(id: i64, result: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "result": result,
    })
}

pub fn error_value(id: i64, code: i64, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": { "code": code, "message": message },
    })
}

pub fn chat_event_value(id: i64, event: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "chat_event",
        "params": { "id": id, "event": event },
    })
}

pub fn parse_message(value: &Value) -> Result<Incoming, String> {
    let method = value
        .get("method")
        .and_then(Value::as_str)
        .map(str::to_string);
    if method.as_deref() == Some("chat_event") {
        let params = value.get("params").cloned().unwrap_or(Value::Null);
        let id = params
            .get("id")
            .and_then(Value::as_i64)
            .ok_or("chat_event 缺少 params.id")?;
        let event = params.get("event").cloned().unwrap_or(Value::Null);
        return Ok(Incoming::ChatEvent { id, event });
    }
    if let Some(message) = error_message(value.get("error")) {
        return Ok(Incoming::Failure {
            id: json_id(value),
            message,
        });
    }
    if let Some(result) = value.get("result") {
        return Ok(Incoming::Response {
            id: json_id(value),
            result: result.clone(),
        });
    }
    let Some(method) = method else {
        return Err("缺少 method / result / error".into());
    };
    Ok(Incoming::Request(RpcRequest {
        id: json_id(value),
        method,
        params: value.get("params").cloned().unwrap_or(Value::Null),
    }))
}

fn json_id(value: &Value) -> i64 {
    value.get("id").and_then(Value::as_i64).unwrap_or(0)
}

fn error_message(error: Option<&Value>) -> Option<String> {
    let error = error?;
    if error.is_null() {
        return None;
    }
    if let Some(text) = error.as_str() {
        return Some(text.to_string());
    }
    error
        .get("message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| Some(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chat_event_roundtrip() {
        let raw = chat_event_value(4, json!({"type": "content_delta", "text": "hi"}));
        match parse_message(&raw).unwrap() {
            Incoming::ChatEvent { id, event } => {
                assert_eq!(id, 4);
                assert_eq!(event["text"], "hi");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn error_object_is_failure() {
        let raw = error_value(3, -32000, "未登录");
        match parse_message(&raw).unwrap() {
            Incoming::Failure { id, message } => {
                assert_eq!(id, 3);
                assert_eq!(message, "未登录");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
