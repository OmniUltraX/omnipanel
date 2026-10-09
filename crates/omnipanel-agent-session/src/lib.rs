//! Agent sidecar 进程内的服务端。官方插件与第三方进程都走这里，或按同一份 JSON 自己实现。

use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

use futures::StreamExt;
use omnipanel_agent_proto::{
    PROTOCOL_VERSION, ReadJson, error_value, parse_message, read_json_line, result_value,
    write_json_line,
};
use omnipanel_ai::{AgentSource, ChatRequest, StreamEvent};
use omnipanel_protocol::proxy::{ProxyConfig, build_http_client_for_url};
use serde::Deserialize;
use serde_json::{Value, json};

pub fn serve(source: Arc<dyn AgentSource>) -> std::io::Result<()> {
    let stdin = std::io::stdin();
    let stdout = std::io::stdout();
    serve_io(source, stdin.lock(), stdout)
}

pub fn serve_io(
    source: Arc<dyn AgentSource>,
    mut reader: impl BufRead,
    mut writer: impl Write,
) -> std::io::Result<()> {
    // current_thread：chat 里会 tokio::spawn，但不能要求外层 future 是 Send
    //（stdout 借用跨不过多线程 runtime）。
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(std::io::Error::other)?;
    loop {
        match read_json_line(&mut reader)? {
            ReadJson::Eof => return Ok(()),
            ReadJson::Invalid(message) => {
                write_json_line(&mut writer, &error_value(0, -32700, &message))?;
            }
            ReadJson::Value(value) => match parse_message(&value) {
                Ok(omnipanel_agent_proto::Incoming::Request(request)) => {
                    dispatch(&source, &runtime, &mut writer, request)?;
                }
                Ok(_) => {
                    write_json_line(&mut writer, &error_value(0, -32600, "sidecar 只接受请求"))?;
                }
                Err(message) => {
                    write_json_line(&mut writer, &error_value(0, -32600, &message))?;
                }
            },
        }
    }
}

fn dispatch(
    source: &Arc<dyn AgentSource>,
    runtime: &tokio::runtime::Runtime,
    writer: &mut impl Write,
    request: omnipanel_agent_proto::RpcRequest,
) -> std::io::Result<()> {
    let id = request.id;
    let outcome = match request.method.as_str() {
        "handshake" => Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "engine": source.id(),
            "capabilities": ["status", "catalog", "chat"],
        })),
        "status" => serde_json::to_value(source.card()).map_err(|err| err.to_string()),
        "catalog" => source
            .refresh()
            .and_then(|card| serde_json::to_value(card).map_err(|err| err.to_string())),
        "chat" => return handle_chat(source, runtime, writer, id, &request.params),
        other => Err(format!("未知方法: {other}")),
    };
    match outcome {
        Ok(result) => write_json_line(writer, &result_value(id, result)),
        Err(message) => write_json_line(writer, &error_value(id, -32000, &message)),
    }
}

fn handle_chat(
    source: &Arc<dyn AgentSource>,
    runtime: &tokio::runtime::Runtime,
    writer: &mut impl Write,
    id: i64,
    params: &Value,
) -> std::io::Result<()> {
    let request = match params.get("request").cloned() {
        Some(value) => match serde_json::from_value::<ChatRequest>(value) {
            Ok(request) => request,
            Err(err) => {
                return write_json_line(
                    writer,
                    &error_value(id, -32602, &format!("chat.request 无法解析: {err}")),
                );
            }
        },
        None => {
            return write_json_line(writer, &error_value(id, -32602, "chat 缺少 request"));
        }
    };
    let model = params
        .get("model")
        .and_then(Value::as_str)
        .filter(|model| !model.is_empty())
        .unwrap_or(request.model.as_str())
        .to_string();
    let proxy_value = params.get("proxy").cloned().unwrap_or(Value::Null);
    let client = match build_client(source.upstream_origin(), &proxy_value) {
        Ok(client) => client,
        Err(message) => return write_json_line(writer, &error_value(id, -32000, &message)),
    };
    // open_provider 里可能自己 block_on（刷新 token）。必须在外层 runtime 之外调用。
    let provider = match source.open_provider(&model, client) {
        Ok(provider) => provider,
        Err(message) => return write_json_line(writer, &error_value(id, -32000, &message)),
    };
    let mut stream = match runtime.block_on(provider.chat_stream(request)) {
        Ok(stream) => stream,
        Err(err) => {
            return write_json_line(writer, &error_value(id, -32000, &err.to_string()));
        }
    };
    let pump = runtime.block_on(async {
        while let Some(item) = stream.next().await {
            let event = match item {
                Ok(event) => event,
                Err(err) => StreamEvent::Error {
                    message: err.to_string(),
                },
            };
            let failed = matches!(event, StreamEvent::Error { .. });
            let value = serde_json::to_value(&event)
                .unwrap_or_else(|err| json!({"type": "error", "message": err.to_string()}));
            if let Err(err) =
                write_json_line(writer, &omnipanel_agent_proto::chat_event_value(id, value))
            {
                return Err(err);
            }
            if failed {
                break;
            }
        }
        Ok(())
    });
    pump?;
    write_json_line(writer, &result_value(id, json!({"ok": true})))
}

fn build_client(origin: &str, proxy: &Value) -> Result<reqwest::Client, String> {
    let proxy = proxy_config(proxy)?;
    build_http_client_for_url(origin, &proxy, Duration::from_secs(300))
        .map_err(|err| err.to_string())
}

#[derive(Debug, Deserialize)]
#[serde(default)]
struct LenientProxy {
    enabled: bool,
    protocol: String,
    host: String,
    port: u16,
    username: String,
    password: String,
}

impl Default for LenientProxy {
    fn default() -> Self {
        Self {
            enabled: false,
            protocol: String::new(),
            host: String::new(),
            port: 0,
            username: String::new(),
            password: String::new(),
        }
    }
}

fn proxy_config(value: &Value) -> Result<ProxyConfig, String> {
    if value.is_null() {
        return Ok(ProxyConfig::default());
    }
    let parsed: LenientProxy =
        serde_json::from_value(value.clone()).map_err(|err| format!("proxy 无法解析: {err}"))?;
    let protocol = if parsed.protocol.trim().is_empty() {
        "http".to_string()
    } else {
        parsed.protocol
    };
    Ok(ProxyConfig {
        enabled: parsed.enabled,
        protocol,
        host: parsed.host,
        port: parsed.port,
        username: parsed.username,
        password: parsed.password,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::pin::Pin;

    use async_trait::async_trait;
    use futures::Stream;
    use omnipanel_ai::{AgentSourceCard, AiProvider, ChatResponse, ModelInfo, StopReason};
    use serde_json::json;

    struct FakeSource;

    impl AgentSource for FakeSource {
        fn id(&self) -> &str {
            "echo"
        }
        fn title(&self) -> &str {
            "Echo"
        }
        fn card(&self) -> AgentSourceCard {
            AgentSourceCard {
                id: "echo".into(),
                title: "Echo".into(),
                signed_in: true,
                account: Some("demo".into()),
                token_expires_at_ms: None,
                catalog_source: "live".into(),
                error: None,
                models: Vec::new(),
                credits: None,
            }
        }
        fn refresh(&self) -> Result<AgentSourceCard, String> {
            Ok(self.card())
        }
        fn upstream_origin(&self) -> &'static str {
            "https://example.com"
        }
        fn open_provider(
            &self,
            _model_id: &str,
            _client: reqwest::Client,
        ) -> Result<Box<dyn AiProvider>, String> {
            Ok(Box::new(FakeProvider))
        }
    }

    struct FakeProvider;

    #[async_trait]
    impl AiProvider for FakeProvider {
        fn name(&self) -> &str {
            "echo"
        }
        fn models(&self) -> Vec<ModelInfo> {
            Vec::new()
        }
        async fn chat(&self, _request: ChatRequest) -> anyhow::Result<ChatResponse> {
            anyhow::bail!("unused")
        }
        async fn chat_stream(
            &self,
            _request: ChatRequest,
        ) -> anyhow::Result<Pin<Box<dyn Stream<Item = anyhow::Result<StreamEvent>> + Send>>>
        {
            let events = vec![
                Ok(StreamEvent::ContentDelta {
                    text: "hello".into(),
                }),
                Ok(StreamEvent::Done {
                    stop_reason: StopReason::EndTurn,
                }),
            ];
            Ok(Box::pin(futures::stream::iter(events)))
        }
    }

    #[test]
    fn handshake_status_and_chat() {
        let input = format!(
            "{}\n{}\n{}\n",
            request_json(1, "handshake", json!({})),
            request_json(2, "status", json!({})),
            request_json(
                3,
                "chat",
                json!({
                    "model": "echo-1",
                    "request": {"model": "echo-1", "messages": [{"role": "user", "content": "hi"}], "stream": true},
                    "proxy": null
                })
            )
        );
        let mut output = Vec::new();
        serve_io(
            Arc::new(FakeSource),
            Cursor::new(input.into_bytes()),
            &mut output,
        )
        .unwrap();
        let text = String::from_utf8(output).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line.trim()).unwrap())
            .collect();
        assert_eq!(lines[0]["result"]["protocolVersion"], 1);
        assert_eq!(lines[0]["result"]["engine"], "echo");
        assert_eq!(lines[1]["result"]["signedIn"], true);
        assert!(lines.iter().any(|line| line["method"] == "chat_event"
            && line["params"]["event"]["type"] == "content_delta"));
        assert_eq!(lines.last().unwrap()["id"], 3);
        assert_eq!(lines.last().unwrap()["result"]["ok"], true);
    }

    fn request_json(id: i64, method: &str, params: Value) -> String {
        omnipanel_agent_proto::request_value(id, method, params).to_string()
    }
}
