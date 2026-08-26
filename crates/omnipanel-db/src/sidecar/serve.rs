//! Sidecar 服务端：读 stdin 一行 JSON-RPC，调本进程内的引擎驱动。

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use crate::sidecar::protocol::{
    canonical_rpc_method, encode_query_result, CountParams, CreateDatabaseParams, ExecuteParams,
    HandshakeResult, PreviewParams, RpcRequest, RpcResponse, PROTOCOL_VERSION,
};
use crate::sidecar::serve_extra::{engine_connect, engine_name, EngineSession};

pub async fn serve_stdio() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    if let Err(err) = serve(stdin, stdout).await {
        eprintln!("[engine-sidecar] {err}");
    }
}

pub async fn serve<R, W>(reader: R, mut writer: W) -> Result<(), String>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    let mut driver: Option<Box<dyn EngineSession>> = None;

    while let Some(line) = lines
        .next_line()
        .await
        .map_err(|e| format!("读 stdin 失败: {e}"))?
    {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let request: RpcRequest = match serde_json::from_str(trimmed) {
            Ok(req) => req,
            Err(err) => {
                write_response(
                    &mut writer,
                    &RpcResponse::err(0, format!("请求不是合法 JSON-RPC: {err}")),
                )
                .await?;
                continue;
            }
        };
        let response = dispatch(&mut driver, request).await;
        write_response(&mut writer, &response).await?;
        if response
            .result
            .as_ref()
            .and_then(|v| v.get("bye"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            break;
        }
    }
    Ok(())
}

async fn dispatch(
    driver: &mut Option<Box<dyn EngineSession>>,
    request: RpcRequest,
) -> RpcResponse {
    let id = request.id;
    match handle(driver, &request.method, request.params).await {
        Ok(result) => RpcResponse::ok(id, result),
        Err(message) => RpcResponse::err(id, message),
    }
}

async fn handle(
    driver: &mut Option<Box<dyn EngineSession>>,
    method: &str,
    params: Value,
) -> Result<Value, String> {
    let method = canonical_rpc_method(method);
    match method {
        "handshake" => Ok(serde_json::to_value(HandshakeResult {
            protocol_version: PROTOCOL_VERSION,
            engine: engine_name().into(),
            capabilities: vec![
                "connect".into(),
                "query".into(),
                "preview".into(),
                "metadata".into(),
                "extra".into(),
            ],
        })
        .unwrap_or(Value::Null)),
        "connect" => {
            let connected = engine_connect(params).await?;
            *driver = Some(connected);
            Ok(json!({ "ok": true }))
        }
        "disconnect" => {
            *driver = None;
            Ok(json!({ "ok": true, "bye": true }))
        }
        other => {
            let Some(active) = driver.as_ref() else {
                return Err("尚未 connect".into());
            };
            match other {
                "version" => Ok(json!(active.version().await.map_err(|e| e.to_string())?)),
                "list_tables" => Ok(json!(active.list_tables().await.map_err(|e| e.to_string())?)),
                "execute" => {
                    let spec: ExecuteParams = serde_json::from_value(params)
                        .map_err(|e| format!("execute 参数非法: {e}"))?;
                    let result = active.execute(&spec.sql).await.map_err(|e| e.to_string())?;
                    Ok(encode_query_result(&result))
                }
                "preview" => {
                    let spec: PreviewParams = serde_json::from_value(params)
                        .map_err(|e| format!("preview 参数非法: {e}"))?;
                    let result = active
                        .preview(
                            &spec.table,
                            spec.limit,
                            spec.offset,
                            spec.order_by.as_deref(),
                            spec.where_clause.as_deref(),
                        )
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(encode_query_result(&result))
                }
                "count" => {
                    let spec: CountParams = serde_json::from_value(params)
                        .map_err(|e| format!("count 参数非法: {e}"))?;
                    let n = active
                        .count(&spec.table, spec.where_clause.as_deref())
                        .await
                        .map_err(|e| e.to_string())?;
                    Ok(json!(n))
                }
                "create_database" => {
                    let spec: CreateDatabaseParams = serde_json::from_value(params)
                        .map_err(|e| format!("create_database 参数非法: {e}"))?;
                    active
                        .handle_extra(
                            "create_database",
                            serde_json::to_value(spec).unwrap_or(Value::Null),
                        )
                        .await
                }
                "describe_table" | "list_databases" | "list_schemas" | "show_create_table" => {
                    active.handle_extra(other, params).await
                }
                unknown => active.handle_extra(unknown, params).await,
            }
        }
    }
}

async fn write_response<W: tokio::io::AsyncWrite + Unpin>(
    writer: &mut W,
    response: &RpcResponse,
) -> Result<(), String> {
    let mut line = serde_json::to_string(response).map_err(|e| format!("序列化失败: {e}"))?;
    line.push('\n');
    writer
        .write_all(line.as_bytes())
        .await
        .map_err(|e| format!("写 stdout 失败: {e}"))?;
    writer
        .flush()
        .await
        .map_err(|e| format!("flush stdout 失败: {e}"))?;
    Ok(())
}
