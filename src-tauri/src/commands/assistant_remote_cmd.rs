//! 助手端远程命令：订阅 DB / 文件 / Docker / 终端命令，本机执行后回传 `assistant.command.result`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use chrono::{DateTime, Utc};
use futures_util::StreamExt;
use omnipanel_assistant::AuthContext;
use omnipanel_error::{ErrorCode, OmniError};
use serde::Deserialize;
use serde::Serialize;
use serde_json::{Value, json};
use specta::Type;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::commands::assistant_chat::build_auth_long;
use crate::commands::database::{
    db_introspect_table, db_list_databases, db_list_tables, db_preview_table,
};
use crate::commands::docker::{docker_list_compose_projects, docker_list_containers};
use crate::commands::file_manager::file_list_dir;
use crate::commands::ssh::pool_session;
use crate::state::{AppState, ProxyConfig};

const RESULT_MAX_BYTES: usize = 64 * 1024;
/// exec 单字段（stdout/stderr）最大字节，避免结果包超限
const EXEC_STREAM_MAX_BYTES: usize = 24 * 1024;
/// 远程 exec 默认/上下限超时（毫秒）
const EXEC_DEFAULT_TIMEOUT_MS: u64 = 30_000;
const EXEC_MIN_TIMEOUT_MS: u64 = 1_000;
const EXEC_MAX_TIMEOUT_MS: u64 = 120_000;
/// openOrFocus 等待前端打开并回传同步数据
const OPEN_OR_FOCUS_WAIT_MS: u64 = 20_000;
/// 忽略连接时回放的过旧命令（秒）
const FRESH_SECS: i64 = 120;
/// 远程预览默认行数
const PREVIEW_DEFAULT_LIMIT: u32 = 50;
const PREVIEW_MAX_LIMIT: u32 = 100;
/// 与 Docker 模块本机连接 id 对齐；快照里可能仍写 `__local__`
const DOCKER_LOCAL_CONNECTION_ID: &str = "docker-local";

const REMOTE_CMD_EVENTS: &str =
    "client.db.command,client.files.command,client.docker.command,client.terminal.command";

type TerminalCmdReplyTx = oneshot::Sender<Result<Value, String>>;

fn terminal_cmd_pending() -> &'static Mutex<HashMap<String, TerminalCmdReplyTx>> {
    static PENDING: OnceLock<Mutex<HashMap<String, TerminalCmdReplyTx>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 前端 `listen(assistant-terminal-open-or-focus)` 的 payload。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTerminalOpenOrFocusEvent {
    pub request_id: String,
    pub connection_id: String,
    pub op: String,
}

/// 前端打开终端后回传同步结果。
#[derive(Debug, Clone, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTerminalCmdReplyRequest {
    pub request_id: String,
    pub ok: bool,
    /// 任意 JSON 结果；以字符串传输规避 specta 对 Value 的递归内联展开。
    #[serde(default)]
    pub result_json: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[tauri::command]
#[specta::specta]
pub async fn assistant_terminal_cmd_reply(
    req: AssistantTerminalCmdReplyRequest,
) -> Result<(), OmniError> {
    let request_id = req.request_id.trim().to_string();
    if request_id.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "缺少 requestId"));
    }
    let tx = {
        let mut map = terminal_cmd_pending()
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "pending lock poisoned"))?;
        map.remove(&request_id)
    };
    let Some(tx) = tx else {
        tracing::warn!(%request_id, "terminal cmd reply 无对应 pending（可能已超时）");
        return Ok(());
    };
    let payload = if req.ok {
        let parsed = match req.result_json.as_deref() {
            None | Some("") => Ok(json!({})),
            Some(text) => serde_json::from_str::<Value>(text).map_err(|e| {
                OmniError::new(ErrorCode::InvalidInput, format!("resultJson 非法: {e}"))
            }),
        };
        match parsed {
            Ok(value) => Ok(value),
            Err(err) => return Err(err),
        }
    } else {
        Err(req.error.unwrap_or_else(|| "前端打开终端失败".to_string()))
    };
    let _ = tx.send(payload);
    Ok(())
}

/// 与聊天收件箱共用 stop 标志，随登录启停。
pub async fn run_remote_cmd_loop(
    app: AppHandle,
    proxy: ProxyConfig,
    token: String,
    device_id: String,
    stop: Arc<AtomicBool>,
) {
    let mut backoff_ms: u64 = 1_000;
    let mut seen: std::collections::VecDeque<String> =
        std::collections::VecDeque::with_capacity(64);
    let started_at = Utc::now().timestamp();

    while !stop.load(Ordering::SeqCst) {
        let auth = match build_auth_long(&proxy, &token, &device_id).await {
            Ok(a) => a,
            Err(err) => {
                tracing::warn!(error = %err, "远程命令通道鉴权失败");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
                continue;
            }
        };

        match listen_remote_cmd_sse(&app, &auth, &stop, &mut seen, started_at).await {
            Ok(()) => {
                backoff_ms = 1_000;
            }
            Err(err) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(error = %err, "远程命令 SSE 断开，将重连");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
            }
        }
    }
}

async fn listen_remote_cmd_sse(
    app: &AppHandle,
    auth: &AuthContext,
    stop: &AtomicBool,
    seen: &mut std::collections::VecDeque<String>,
    started_at: i64,
) -> Result<(), OmniError> {
    let url = format!(
        "{}/api/notify/wait?events={}",
        auth.api_base.trim_end_matches('/'),
        urlencoding_encode(REMOTE_CMD_EVENTS),
    );
    tracing::info!(%url, "远程命令 SSE 连接中");
    let resp = auth
        .http
        .get(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .header("X-Device-Public-Key", &auth.device_public_key)
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "连接远程命令通道失败").with_cause(e.to_string())
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("远程命令等待失败 (HTTP {status})"),
        )
        .with_cause(body));
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();
    let mut event_name = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    while let Some(chunk) = stream.next().await {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let bytes = chunk.map_err(|e| {
            OmniError::new(ErrorCode::Io, "读取远程命令流失败").with_cause(e.to_string())
        })?;
        buffer.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(idx) = buffer.find('\n') {
            let mut line = buffer[..idx].to_string();
            buffer.drain(..=idx);
            if line.ends_with('\r') {
                line.pop();
            }

            if line.is_empty() {
                let data = data_lines.join("\n");
                let name = if event_name.is_empty() {
                    "message".to_string()
                } else {
                    std::mem::take(&mut event_name)
                };
                data_lines.clear();

                match name.as_str() {
                    "ping" => {}
                    "fail" => {
                        return Err(OmniError::new(
                            ErrorCode::Connection,
                            if data.is_empty() {
                                "远程命令通道失败".to_string()
                            } else {
                                data
                            },
                        ));
                    }
                    "notify" | "message" => {
                        if data.trim().is_empty() {
                            continue;
                        }
                        if let Err(err) =
                            handle_remote_envelope(app, auth, &data, seen, started_at).await
                        {
                            tracing::warn!(error = %err, "处理远程命令失败");
                        }
                    }
                    _ => {}
                }
                continue;
            }

            if let Some(rest) = line.strip_prefix("event:") {
                event_name = rest.trim().to_string();
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }
    }

    Err(OmniError::new(ErrorCode::Timeout, "远程命令等待通道已结束"))
}

async fn handle_remote_envelope(
    app: &AppHandle,
    auth: &AuthContext,
    raw: &str,
    seen: &mut std::collections::VecDeque<String>,
    started_at: i64,
) -> Result<(), OmniError> {
    let env: Value = serde_json::from_str(raw).map_err(|e| {
        OmniError::new(ErrorCode::InvalidInput, "无法解析通知").with_cause(e.to_string())
    })?;

    let event = env
        .get("event")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let is_db = event == "client.db.command";
    let is_files = event == "client.files.command" || event == "client.files.list";
    let is_docker = event == "client.docker.command";
    let is_terminal = event == "client.terminal.command";
    if !is_db && !is_files && !is_docker && !is_terminal {
        return Ok(());
    }

    let request_id = env
        .get("requestId")
        .or_else(|| env.get("request_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if request_id.is_empty() {
        tracing::warn!(%event, "远程命令缺少 requestId，忽略");
        return Ok(());
    }
    if seen.iter().any(|id| id == &request_id) {
        return Ok(());
    }
    seen.push_back(request_id.clone());
    while seen.len() > 64 {
        seen.pop_front();
    }

    let published_at = env
        .get("publishedAt")
        .or_else(|| env.get("published_at"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if !is_fresh_enough(published_at, started_at) {
        tracing::info!(%request_id, %event, "忽略过期的远程命令回放");
        return Ok(());
    }

    let payload = env.get("payload").cloned().unwrap_or(json!({}));
    let source = env.get("source").cloned().unwrap_or(json!({}));
    let op = payload_str(&payload, &["op"]);
    let connection_id = payload_str(&payload, &["connectionId", "connection_id"]);

    tracing::info!(%request_id, %event, %op, %connection_id, "执行远程命令");

    let (ok, result, error) = if is_db {
        let database = payload_str(&payload, &["database"]);
        let table = payload_str(&payload, &["table"]);
        let limit = payload_u32(&payload, &["limit"]).unwrap_or(PREVIEW_DEFAULT_LIMIT);
        match execute_db_op(app, &op, &connection_id, &database, &table, limit).await {
            Ok(v) => (true, Some(v), None),
            Err(e) => (false, None, Some(e)),
        }
    } else if is_files {
        let path = payload_str(&payload, &["path"]);
        let token = payload_str(&payload, &["continuationToken", "continuation_token"]);
        match execute_files_op(app, &op, &connection_id, &path, &token).await {
            Ok(v) => (true, Some(v), None),
            Err(e) => (false, None, Some(e)),
        }
    } else if is_docker {
        let filter = payload_str(&payload, &["filter"]);
        let project = payload_str(&payload, &["project"]);
        match execute_docker_op(app, &op, &connection_id, &filter, &project).await {
            Ok(v) => (true, Some(v), None),
            Err(e) => (false, None, Some(e)),
        }
    } else {
        let command = payload_str(&payload, &["command", "cmd"]);
        let timeout_ms = payload_u32(&payload, &["timeoutMs", "timeout_ms"])
            .map(|v| v as u64)
            .unwrap_or(EXEC_DEFAULT_TIMEOUT_MS)
            .clamp(EXEC_MIN_TIMEOUT_MS, EXEC_MAX_TIMEOUT_MS);
        match execute_terminal_op(app, &op, &connection_id, &request_id, &command, timeout_ms).await
        {
            Ok(v) => (true, Some(v), None),
            Err(e) => (false, None, Some(e)),
        }
    };

    let mut result_payload = json!({
        "requestId": request_id,
        "request_id": request_id,
        "ok": ok,
        "op": op,
        "event": event,
    });
    if let Some(v) = result {
        result_payload["result"] = truncate_result(v);
    }
    if let Some(err) = error {
        result_payload["error"] = json!(err);
    }

    let target_app = source
        .get("appId")
        .or_else(|| source.get("app_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("omni-assistant");
    let target_device = source
        .get("deviceId")
        .or_else(|| source.get("device_id"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    publish_command_result(auth, &request_id, target_app, target_device, result_payload).await
}

async fn execute_files_op(
    app: &AppHandle,
    op: &str,
    connection_id: &str,
    path: &str,
    continuation_token: &str,
) -> Result<Value, String> {
    if connection_id.trim().is_empty() {
        return Err("缺少 connectionId".into());
    }
    match op {
        "listDir" | "list" | "" => {
            let state = app
                .try_state::<AppState>()
                .ok_or_else(|| "应用状态不可用".to_string())?;
            let dir = if path.trim().is_empty() {
                "/".to_string()
            } else {
                path.trim().to_string()
            };
            let token = if continuation_token.trim().is_empty() {
                None
            } else {
                Some(continuation_token.trim().to_string())
            };
            let result = file_list_dir(
                state.clone(),
                connection_id.trim().to_string(),
                dir,
                None,
                token,
            )
            .await
            .map_err(|e| e.to_string())?;
            serde_json::to_value(result).map_err(|e| e.to_string())
        }
        other => Err(format!("不支持的 files op: {other}")),
    }
}

/// 终端：openOrFocus 通知前端；exec 在 Rust 连接池一次性执行。
async fn execute_terminal_op(
    app: &AppHandle,
    op: &str,
    connection_id: &str,
    request_id: &str,
    command: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    if connection_id.trim().is_empty() {
        return Err("缺少 connectionId".into());
    }
    let op_norm = match op.trim() {
        "" | "openOrFocus" | "open" | "connect" => "openOrFocus",
        "exec" | "execute" | "run" => "exec",
        other => return Err(format!("不支持的 terminal op: {other}")),
    };

    if op_norm == "openOrFocus" {
        let (tx, rx) = oneshot::channel::<Result<Value, String>>();
        {
            let mut map = terminal_cmd_pending()
                .lock()
                .map_err(|_| "pending lock poisoned".to_string())?;
            if let Some(old) = map.insert(request_id.to_string(), tx) {
                let _ = old.send(Err("被更新的 openOrFocus 请求取代".into()));
            }
        }
        let payload = AssistantTerminalOpenOrFocusEvent {
            request_id: request_id.to_string(),
            connection_id: connection_id.trim().to_string(),
            op: op_norm.to_string(),
        };
        if let Err(e) = app.emit("assistant-terminal-open-or-focus", payload) {
            let mut map = terminal_cmd_pending()
                .lock()
                .map_err(|_| "pending lock poisoned".to_string())?;
            map.remove(request_id);
            return Err(format!("通知前端打开终端失败: {e}"));
        }
        match tokio::time::timeout(Duration::from_millis(OPEN_OR_FOCUS_WAIT_MS), rx).await {
            Ok(Ok(Ok(v))) => return Ok(v),
            Ok(Ok(Err(e))) => return Err(e),
            Ok(Err(_)) => {
                return Err("前端打开终端回传通道已关闭".into());
            }
            Err(_) => {
                let mut map = terminal_cmd_pending()
                    .lock()
                    .map_err(|_| "pending lock poisoned".to_string())?;
                map.remove(request_id);
                return Err(format!(
                    "等待前端打开终端超时（{}ms）",
                    OPEN_OR_FOCUS_WAIT_MS
                ));
            }
        }
    }

    let cmd = command.trim();
    if cmd.is_empty() {
        return Err("命令不能为空".into());
    }
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "应用状态不可用".to_string())?;
    let session = pool_session(&*state, connection_id.trim())
        .await
        .map_err(|e| e.to_string())?;
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), session.exec_capture(cmd))
        .await
        .map_err(|_| format!("命令执行超时（{}ms）", timeout_ms))?
        .map_err(|e| e.to_string())?;

    let (stdout, stdout_cut) = truncate_exec_stream(&output.stdout);
    let (stderr, stderr_cut) = truncate_exec_stream(&output.stderr);
    Ok(json!({
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": output.exit_code,
        "exit_code": output.exit_code,
        "truncated": stdout_cut || stderr_cut,
        "op": op_norm,
        "connectionId": connection_id.trim(),
    }))
}

fn truncate_exec_stream(raw: &str) -> (String, bool) {
    if raw.len() <= EXEC_STREAM_MAX_BYTES {
        return (raw.to_string(), false);
    }
    let mut end = EXEC_STREAM_MAX_BYTES;
    while end > 0 && !raw.is_char_boundary(end) {
        end -= 1;
    }
    (format!("{}…", &raw[..end]), true)
}

async fn execute_docker_op(
    app: &AppHandle,
    op: &str,
    connection_id: &str,
    filter: &str,
    project: &str,
) -> Result<Value, String> {
    if connection_id.trim().is_empty() {
        return Err("缺少 connectionId".into());
    }
    let conn_id = normalize_docker_connection_id(connection_id.trim());
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "应用状态不可用".to_string())?;

    match op {
        "listContainers" => {
            let filter_opt = if filter.trim().is_empty() {
                None
            } else {
                Some(filter.trim().to_string())
            };
            let list = docker_list_containers(state.clone(), conn_id, filter_opt)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "containers": list }))
        }
        "listComposeProjects" => {
            let list = docker_list_compose_projects(state.clone(), conn_id)
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "projects": list }))
        }
        "listComposeServices" => {
            if project.trim().is_empty() {
                return Err("缺少 project".into());
            }
            let list = docker_list_compose_projects(state.clone(), conn_id)
                .await
                .map_err(|e| e.to_string())?;
            let hit = list
                .into_iter()
                .find(|p| p.name == project.trim())
                .ok_or_else(|| format!("未找到 Compose 项目: {}", project.trim()))?;
            Ok(json!({
                "project": hit.name,
                "services": hit.services,
                "serviceCount": hit.service_count,
                "containerCount": hit.container_count,
                "runningContainerCount": hit.running_container_count,
            }))
        }
        other => Err(format!("不支持的 docker op: {other}")),
    }
}

fn normalize_docker_connection_id(id: &str) -> String {
    if id == "__local__" || id == "local" {
        DOCKER_LOCAL_CONNECTION_ID.to_string()
    } else {
        id.to_string()
    }
}

/// 对 notify wait 的 events 查询做最小编码（逗号保留为字面量，由服务端按逗号拆分）。
fn urlencoding_encode(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' | ',' => out.push(ch),
            _ => {
                for b in ch.to_string().as_bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            }
        }
    }
    out
}

async fn execute_db_op(
    app: &AppHandle,
    op: &str,
    connection_id: &str,
    database: &str,
    table: &str,
    limit: u32,
) -> Result<Value, String> {
    if connection_id.trim().is_empty() {
        return Err("缺少 connectionId".into());
    }
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "应用状态不可用".to_string())?;
    let conn = state
        .db_connections
        .get_with_secret(connection_id.trim())
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "连接不存在".to_string())?;
    if !conn.enabled {
        return Err("连接已禁用".into());
    }

    match op {
        "listDatabases" => {
            let names = db_list_databases(conn).await?;
            Ok(json!({ "names": names }))
        }
        "listTables" => {
            let schema = if database.trim().is_empty() {
                None
            } else {
                Some(database.trim().to_string())
            };
            let names = db_list_tables(conn, schema).await?;
            Ok(json!({ "names": names }))
        }
        "introspectTable" => {
            let schema = if database.trim().is_empty() {
                None
            } else {
                Some(database.trim().to_string())
            };
            if table.trim().is_empty() {
                return Err("缺少 table".into());
            }
            let details = db_introspect_table(conn, schema, table.trim().to_string()).await?;
            serde_json::to_value(details).map_err(|e| e.to_string())
        }
        "previewTable" => {
            if table.trim().is_empty() {
                return Err("缺少 table".into());
            }
            let mut conn = conn;
            if !database.trim().is_empty() {
                conn.database = database.trim().to_string();
            }
            let lim = limit.clamp(1, PREVIEW_MAX_LIMIT);
            let info = db_preview_table(conn, table.trim().to_string(), lim, 0, None, None).await?;
            serde_json::to_value(info).map_err(|e| e.to_string())
        }
        other => Err(format!("不支持的 op: {other}")),
    }
}

async fn publish_command_result(
    auth: &AuthContext,
    request_id: &str,
    target_app: &str,
    target_device: &str,
    payload: Value,
) -> Result<(), OmniError> {
    let url = format!("{}/api/notify", auth.api_base.trim_end_matches('/'));
    let body = json!({
        "event": "assistant.command.result",
        "request_id": request_id,
        "target": {
            "role": "assistant",
            "app_id": target_app,
            "device_id": target_device,
        },
        "payload": payload,
    });
    let resp = auth
        .http
        .post(&url)
        .header("Authorization", format!("Bearer {}", auth.access_token))
        .header("X-App-Id", &auth.app_id)
        .header("X-Device-Id", &auth.device_id)
        .header("X-Device-Public-Key", &auth.device_public_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "回传命令结果失败").with_cause(e.to_string())
        })?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("回传命令结果失败 (HTTP {status})"),
        )
        .with_cause(text));
    }
    Ok(())
}

fn truncate_result(v: Value) -> Value {
    let Ok(raw) = serde_json::to_vec(&v) else {
        return v;
    };
    if raw.len() <= RESULT_MAX_BYTES {
        return v;
    }
    if let Some(names) = v.get("names").and_then(|n| n.as_array()) {
        let mut kept = Vec::new();
        let mut size = 64usize;
        for name in names {
            let s = name.as_str().unwrap_or("").to_string();
            size += s.len() + 4;
            if size > RESULT_MAX_BYTES {
                break;
            }
            kept.push(s);
        }
        return json!({
            "names": kept,
            "truncated": true,
            "total": names.len(),
        });
    }
    for key in ["containers", "projects", "entries", "services"] {
        if let Some(arr) = v.get(key).and_then(|n| n.as_array()) {
            let mut kept = Vec::new();
            let mut size = 128usize;
            for item in arr {
                let Ok(bytes) = serde_json::to_vec(item) else {
                    continue;
                };
                size += bytes.len() + 2;
                if size > RESULT_MAX_BYTES {
                    break;
                }
                kept.push(item.clone());
            }
            let mut out = v.clone();
            if let Some(obj) = out.as_object_mut() {
                obj.insert(key.to_string(), json!(kept));
                obj.insert("truncated".into(), json!(true));
                obj.insert("total".into(), json!(arr.len()));
            }
            return out;
        }
    }
    json!({
        "error": "结果过大已省略",
        "truncated": true,
    })
}

fn payload_str(payload: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = payload.get(*k).and_then(|v| v.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return t.to_string();
            }
        }
    }
    String::new()
}

fn payload_u32(payload: &Value, keys: &[&str]) -> Option<u32> {
    for k in keys {
        if let Some(n) = payload.get(*k).and_then(|v| v.as_u64()) {
            return Some(n as u32);
        }
        if let Some(s) = payload.get(*k).and_then(|v| v.as_str()) {
            if let Ok(n) = s.trim().parse::<u32>() {
                return Some(n);
            }
        }
    }
    None
}

fn is_fresh_enough(published_at: &str, started_at: i64) -> bool {
    let raw = published_at.trim();
    if raw.is_empty() {
        return false;
    }
    let Ok(dt) = DateTime::parse_from_rfc3339(raw) else {
        return true;
    };
    let ts = dt.timestamp();
    let now = Utc::now().timestamp();
    if ts + FRESH_SECS < now {
        return false;
    }
    if ts + 5 < started_at {
        return false;
    }
    true
}
