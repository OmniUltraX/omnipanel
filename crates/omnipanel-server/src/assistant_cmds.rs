//! 助手端同步：采集本机脱敏元数据并上传 OSS；聊天收件（latest / fetch / inbox）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use omnipanel_assistant::{
    chat_index_from_notify_json, fetch_chat_latest, fetch_oss_sts, get_object_bytes,
    parse_inbound_chat_message, push_snapshot, sanitize_assistant_conversation_meta,
    sanitize_connection_meta, sanitize_db_connection_meta, sanitize_http_request_meta,
    sanitize_knowledge_meta, sanitize_task_meta, sanitize_terminal_session_meta,
    upload_object_bytes, AuthContext, ChatLatestIndex, CollectContext, OssUploadResult,
    PushOptions, PushSnapshotResult,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_store::{load_database_connections, ConnectionKind};
use serde::{Deserialize, Serialize};
use specta::Type;

use crate::auth_cmds::{auth_device_identity, auth_get_me};
use crate::bus::EventBus;
use crate::http_client::{build_http_client_for_url, proxy_config};
use crate::state::ServerState;

const AUTH_API_BASE: &str = "https://mp.99.protected.fun";
const CLIENT_APP_ID: &str = "omni-client";
/// 会话列表快照条数上限（按 updatedAt 新→旧）。
const ASSISTANT_CONVERSATION_SNAPSHOT_LIMIT: usize = 50;
/// SSE 长连接：避免 reqwest 默认超时打断 wait。
const SSE_HTTP_TIMEOUT: Duration = Duration::from_secs(6 * 3600);
const ASSISTANT_CHAT_INBOUND_EVENT: &str = "assistant-chat-inbound";

/// 前端 `listen(ASSISTANT_CHAT_INBOUND)` 的 payload。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantChatContextItem {
    pub kind: String,
    pub id: String,
    pub label: String,
}

/// 前端 `listen(ASSISTANT_CHAT_INBOUND)` 的 payload。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantChatAskUserAnswer {
    pub form_id: String,
    pub tool_call_id: String,
    /// `answered` | `skipped`
    pub status: String,
    /// answers 对象的 JSON 字符串
    pub answers_json: String,
}

/// 前端 `listen(ASSISTANT_CHAT_INBOUND)` 的 payload。
#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantChatInboundEvent {
    pub message_id: String,
    pub object_key: String,
    pub created_at: String,
    pub text: String,
    /// 助手端当前选中的会话 id；空则回退客户端当前 Dock 会话。
    #[serde(default)]
    pub session_id: String,
    /// 助手端选中的询问对象（注入 Composer 上下文）。
    #[serde(default)]
    pub contexts: Vec<AssistantChatContextItem>,
    /// 澄清表单答案（快通道）；有值时即使 text 为空也推送。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ask_user: Option<AssistantChatAskUserAnswer>,
}

struct ChatInboxRuntime {
    stop: Arc<AtomicBool>,
}

static CHAT_INBOX: Mutex<Option<ChatInboxRuntime>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantConversationSnapshotItem {
    pub id: String,
    pub title: String,
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub model_selection_id: Option<String>,
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub message_count: u32,
    pub created_at: f64,
    pub updated_at: f64,
    #[serde(default)]
    pub parent_conversation_id: Option<String>,
    #[serde(default)]
    pub root_conversation_id: Option<String>,
    #[serde(default)]
    pub pinned_workspace_id: Option<String>,
    #[serde(default)]
    pub linked_terminal_session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTerminalSessionSnapshotItem {
    pub id: String,
    pub title: String,
    /// local | remote
    pub session_type: String,
    pub resource_id: String,
    #[serde(default)]
    pub shell_label: String,
    #[serde(default)]
    pub cwd: String,
    /// active | suspended | ended
    #[serde(default)]
    pub lifecycle: String,
    /// connected | connecting | disconnected | error 等
    #[serde(default)]
    pub status: String,
    pub created_at: f64,
    pub updated_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantPushRequest {
    pub token: String,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub bind_id: Option<String>,
    /// 前端注入的 AI 会话列表元数据（不含消息正文）。
    #[serde(default)]
    pub conversations: Vec<AssistantConversationSnapshotItem>,
    /// 前端注入的终端会话列表（与 AI 会话分离）。
    #[serde(default)]
    pub terminal_sessions: Vec<AssistantTerminalSessionSnapshotItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantUploadTextRequest {
    pub token: String,
    /// OSS object key，如 `omniminiapp/agent_chat_message/.../0.txt`（会去掉桶名前缀）。
    pub object_key: String,
    pub contents: String,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AssistantUploadTextResult {
    pub object_key: String,
    pub etag: Option<String>,
    pub bytes: f64,
}

/// 推送客户端元数据快照到 OSS（`dry_run=true` 时只组装不上传）。
pub async fn assistant_push_snapshot(
    state: &crate::state::ServerState,
    request: AssistantPushRequest,
) -> Result<PushSnapshotResult, OmniError> {
    if request.token.trim().is_empty() && !request.dry_run {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法同步到助手端",
        ));
    }

    let identity = auth_device_identity().await?;
    let user_id = if request.token.trim().is_empty() {
        None
    } else {
        auth_get_me(request.token.clone()).await
            .ok()
            .map(|me| me.id.to_string())
    };

    let ctx = build_collect_context(
        &state,
        &identity.device_id,
        user_id,
        request.bind_id,
        &request.conversations,
        &request.terminal_sessions,
    )
    .await?;

    if request.dry_run {
        return push_snapshot(
            ctx,
            None,
            PushOptions {
                dry_run: true,
                object_key_override: None,
            },
        )
        .await;
    }

    let auth = build_auth_context(&request.token, &identity.device_id).await?;

    push_snapshot(
        ctx,
        Some(&auth),
        PushOptions {
            dry_run: false,
            object_key_override: None,
        },
    )
    .await
}

/// 使用现有助手 STS，将文本写入 OSS（聊天记录分片等）。
pub async fn assistant_upload_oss_text(
    _state: &crate::state::ServerState,
    request: AssistantUploadTextRequest,
) -> Result<AssistantUploadTextResult, OmniError> {
    if request.token.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::Auth,
            "未登录，无法上传到 OSS",
        ));
    }
    if request.object_key.trim().is_empty() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "object_key 不能为空",
        ));
    }

    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&request.token, &identity.device_id).await?;
    let sts = fetch_oss_sts(&auth).await?;
    let uploaded: OssUploadResult = upload_object_bytes(
        &auth.http,
        &sts,
        &request.object_key,
        request.contents.as_bytes(),
        "text/plain; charset=utf-8",
    )
    .await?;

    Ok(AssistantUploadTextResult {
        object_key: uploaded.object_key,
        etag: uploaded.etag,
        bytes: uploaded.bytes as f64,
    })
}

/// 读取最近一条聊天索引（无则 `null`）。
///
/// 底层 `fetch_chat_latest` 已改为始终 `None`（改由 notify SSE 推送）；
/// 仍保留真实 HTTP 鉴权路径，供 Web 轮询客户端调用，禁止 soft_degrade 空壳。
pub async fn assistant_chat_latest(token: String) -> Result<Option<ChatLatestIndex>, OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&token, &identity.device_id).await?;
    fetch_chat_latest(&auth).await
}

/// 按 object key 拉取 OSS 正文并解析为可展示文本。
pub async fn assistant_chat_fetch_object(
    token: String,
    object_key: String,
) -> Result<AssistantChatInboundEvent, OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }
    if object_key.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "object_key 不能为空"));
    }
    let identity = auth_device_identity().await?;
    let auth = build_auth_context(&token, &identity.device_id).await?;
    load_inbound_from_key(&auth, object_key.trim(), "", "", "").await
}

/// 启动收件箱：先拉 latest，再挂 SSE `/api/notify/wait`；新消息经 EventBus 推送。
///
/// Web 等价路径：用 EventBus（WS `/ipc/events`）替代 Tauri AppHandle emit。
pub async fn assistant_chat_inbox_start(
    state: &ServerState,
    token: String,
) -> Result<(), OmniError> {
    if token.trim().is_empty() {
        return Err(OmniError::new(ErrorCode::Auth, "未登录"));
    }

    let stop = Arc::new(AtomicBool::new(false));
    {
        let mut guard = CHAT_INBOX
            .lock()
            .map_err(|_| OmniError::new(ErrorCode::Internal, "聊天收件箱锁失败"))?;
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
        *guard = Some(ChatInboxRuntime {
            stop: Arc::clone(&stop),
        });
    }

    let identity = auth_device_identity().await?;
    let device_id = identity.device_id.clone();
    let bus = state.bus.clone();

    tokio::spawn(async move {
        run_chat_inbox_loop(bus, token, device_id, stop).await;
    });

    Ok(())
}

/// 停止收件箱 SSE 循环。
pub async fn assistant_chat_inbox_stop() -> Result<(), OmniError> {
    if let Ok(mut guard) = CHAT_INBOX.lock() {
        if let Some(prev) = guard.take() {
            prev.stop.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

pub(crate) async fn build_auth_context(
    token: &str,
    device_id: &str,
) -> Result<AuthContext, OmniError> {
    let proxy_config = proxy_config();
    let http = build_http_client_for_url(AUTH_API_BASE, &proxy_config, Duration::from_secs(30))
        .map_err(|e| OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e))?;

    Ok(AuthContext {
        api_base: AUTH_API_BASE.to_string(),
        access_token: token.to_string(),
        app_id: CLIENT_APP_ID.to_string(),
        device_id: device_id.to_string(),
        device_public_key: String::new(),
        http,
    })
}

async fn build_auth_long(token: &str, device_id: &str) -> Result<AuthContext, OmniError> {
    let proxy = proxy_config();
    let http = build_http_client_for_url(AUTH_API_BASE, &proxy, SSE_HTTP_TIMEOUT).map_err(|e| {
        OmniError::new(ErrorCode::Connection, "创建 HTTP 客户端失败").with_cause(e)
    })?;
    Ok(AuthContext {
        api_base: AUTH_API_BASE.to_string(),
        access_token: token.to_string(),
        app_id: CLIENT_APP_ID.to_string(),
        device_id: device_id.to_string(),
        device_public_key: String::new(),
        http,
    })
}

fn is_benign_sse_disconnect(cause: &str) -> bool {
    let lower = cause.to_ascii_lowercase();
    lower.contains("decoding response body")
        || lower.contains("connection reset")
        || lower.contains("connection closed")
        || lower.contains("broken pipe")
        || lower.contains("unexpected eof")
        || lower.contains("error sending request")
}

async fn load_inbound_from_key(
    auth: &AuthContext,
    object_key: &str,
    message_id: &str,
    created_at: &str,
    session_id_hint: &str,
) -> Result<AssistantChatInboundEvent, OmniError> {
    let sts = fetch_oss_sts(auth).await?;
    let bytes = get_object_bytes(&auth.http, &sts, object_key).await?;
    let raw = String::from_utf8_lossy(&bytes);
    let parsed = parse_inbound_chat_message(&raw);
    let session_id = if !parsed.session_id.trim().is_empty() {
        parsed.session_id
    } else {
        session_id_hint.trim().to_string()
    };
    Ok(AssistantChatInboundEvent {
        message_id: if message_id.is_empty() {
            object_key.to_string()
        } else {
            message_id.to_string()
        },
        object_key: object_key.to_string(),
        created_at: created_at.to_string(),
        text: parsed.text,
        session_id,
        contexts: parsed
            .contexts
            .into_iter()
            .map(|c| AssistantChatContextItem {
                kind: c.kind,
                id: c.id,
                label: c.label,
            })
            .collect(),
        ask_user: parsed.ask_user.map(|a| AssistantChatAskUserAnswer {
            form_id: a.form_id,
            tool_call_id: a.tool_call_id,
            status: a.status,
            answers_json: a.answers_json,
        }),
    })
}

fn emit_inbound(bus: &EventBus, event: AssistantChatInboundEvent) {
    let has_ask = event.ask_user.is_some();
    if event.text.trim().is_empty() && !has_ask {
        tracing::warn!(
            object_key = %event.object_key,
            "助手聊天 OSS 对象无可展示文本，跳过"
        );
        return;
    }
    match serde_json::to_value(&event) {
        Ok(payload) => {
            bus.emit(ASSISTANT_CHAT_INBOUND_EVENT, payload);
        }
        Err(err) => {
            tracing::warn!(error = %err, "序列化助手聊天入站事件失败");
        }
    }
}

async fn handle_index(bus: &EventBus, auth: &AuthContext, index: ChatLatestIndex) {
    match load_inbound_from_key(
        auth,
        &index.object_key,
        &index.message_id,
        &index.created_at,
        &index.session_id,
    )
    .await
    {
        Ok(event) => emit_inbound(bus, event),
        Err(err) => {
            tracing::warn!(
                object_key = %index.object_key,
                error = %err,
                "拉取助手聊天 OSS 对象失败"
            );
        }
    }
}

async fn run_chat_inbox_loop(
    bus: EventBus,
    token: String,
    device_id: String,
    stop: Arc<AtomicBool>,
) {
    let mut backoff_ms: u64 = 1_000;
    let mut last_dedupe = String::new();

    // 启动时先拉 latest，避免错过 SSE 连接前的消息
    if let Ok(auth) = build_auth_long(&token, &device_id).await {
        match fetch_chat_latest(&auth).await {
            Ok(Some(index)) => {
                last_dedupe = index.dedupe_key();
                handle_index(&bus, &auth, index).await;
            }
            Ok(None) => {}
            Err(err) => {
                tracing::warn!(error = %err, "启动时读取聊天 latest 失败");
            }
        }
    }

    while !stop.load(Ordering::SeqCst) {
        let auth = match build_auth_long(&token, &device_id).await {
            Ok(a) => a,
            Err(err) => {
                tracing::warn!(error = %err, "聊天收件箱鉴权客户端创建失败");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
                continue;
            }
        };

        match listen_chat_sse(&bus, &auth, &stop, &mut last_dedupe).await {
            Ok(()) => {
                backoff_ms = 1_000;
            }
            Err(err) => {
                if stop.load(Ordering::SeqCst) {
                    break;
                }
                tracing::warn!(error = %err, "聊天收件箱 SSE 断开，将重连");
                tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
                backoff_ms = (backoff_ms * 2).min(30_000);
            }
        }
    }
}

async fn listen_chat_sse(
    bus: &EventBus,
    auth: &AuthContext,
    stop: &AtomicBool,
    last_dedupe: &mut String,
) -> Result<(), OmniError> {
    let url = format!(
        "{}/api/notify/wait?events=assistant.chat.message",
        auth.api_base.trim_end_matches('/'),
    );
    tracing::info!(%url, "聊天收件箱 SSE 连接中");
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
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "聊天等待通道已断开")
            } else {
                OmniError::new(ErrorCode::Connection, "连接聊天等待通道失败").with_cause(cause)
            }
        })?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(OmniError::new(
            ErrorCode::Connection,
            format!("聊天等待失败 (HTTP {status})"),
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
            let cause = e.to_string();
            if is_benign_sse_disconnect(&cause) {
                OmniError::new(ErrorCode::Timeout, "聊天等待通道已断开")
            } else {
                OmniError::new(ErrorCode::Io, "读取聊天等待流失败").with_cause(cause)
            }
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
                                "聊天等待通道失败".to_string()
                            } else {
                                data
                            },
                        ));
                    }
                    // 通用总线事件名 notify；兼容旧 message
                    "notify" | "message" => {
                        if data.trim().is_empty() {
                            continue;
                        }
                        let index: ChatLatestIndex = match chat_index_from_notify_json(&data)
                            .or_else(|_| ChatLatestIndex::parse_json(&data))
                        {
                            Ok(v) => v,
                            Err(e) => {
                                tracing::warn!(
                                    error = %e,
                                    data = %data,
                                    "跳过无法解析的聊天 notify 事件"
                                );
                                continue;
                            }
                        };
                        if index.object_key.trim().is_empty() {
                            continue;
                        }
                        let key = index.dedupe_key();
                        if !key.is_empty() && key == *last_dedupe {
                            continue;
                        }
                        if !key.is_empty() {
                            *last_dedupe = key;
                        }
                        tracing::info!(
                            message_id = %index.message_id,
                            object_key = %index.object_key,
                            "收到助手聊天通知，开始拉 OSS"
                        );
                        handle_index(bus, auth, index).await;
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

    Err(OmniError::new(ErrorCode::Timeout, "聊天等待通道已结束"))
}

fn enum_wire_str<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

async fn build_collect_context(
    state: &crate::state::ServerState,
    client_device_id: &str,
    user_id: Option<String>,
    bind_id: Option<String>,
    conversations: &[AssistantConversationSnapshotItem],
    terminal_sessions: &[AssistantTerminalSessionSnapshotItem],
) -> Result<CollectContext, OmniError> {
    let storage = state.storage.lock().await;

    let ssh = storage.list_connections_by_kind(ConnectionKind::Ssh)?;
    let docker = storage.list_connections_by_kind(ConnectionKind::Docker)?;
    let files = storage.list_connections_by_kind(ConnectionKind::File)?;
    let panels = storage.list_connections_by_kind(ConnectionKind::Panel)?;
    let knowledge = storage.list_knowledge(None, None)?;
    let http_requests = storage.http_list_requests(None)?;
    let tasks = storage.task_list(None, 5)?;

    drop(storage);

    let db_connections = load_database_connections().unwrap_or_default();

    let mut docker_instances: Vec<_> = docker
        .iter()
        .map(|c| {
            sanitize_connection_meta(
                &c.id,
                c.kind.as_str(),
                &c.name,
                &c.group,
                &c.env_tag,
                &c.tags,
                &c.config,
            )
        })
        .collect();
    if !docker_instances
        .iter()
        .any(|v| v.get("id").and_then(|x| x.as_str()) == Some("docker-local"))
    {
        docker_instances.insert(
            0,
            serde_json::json!({
                "id": "docker-local",
                "kind": "docker",
                "name": "Local Docker",
                "group": "",
                "envTag": "dev",
                "tags": [],
                "config": { "source": "local" }
            }),
        );
    }

    let mut file_connections: Vec<_> = files
        .iter()
        .map(|c| {
            sanitize_connection_meta(
                &c.id,
                c.kind.as_str(),
                &c.name,
                &c.group,
                &c.env_tag,
                &c.tags,
                &c.config,
            )
        })
        .collect();
    if !file_connections
        .iter()
        .any(|v| v.get("id").and_then(|x| x.as_str()) == Some("__local__"))
    {
        file_connections.insert(
            0,
            serde_json::json!({
                "id": "__local__",
                "kind": "file",
                "name": "本机文件",
                "group": "",
                "envTag": "dev",
                "tags": [],
                "config": { "protocol": "local" }
            }),
        );
    }

    Ok(CollectContext {
        client_device_id: client_device_id.to_string(),
        bind_id,
        user_id,
        terminal_hosts: ssh
            .iter()
            .map(|c| {
                sanitize_connection_meta(
                    &c.id,
                    c.kind.as_str(),
                    &c.name,
                    &c.group,
                    &c.env_tag,
                    &c.tags,
                    &c.config,
                )
            })
            .collect(),
        terminal_sessions: {
            let mut ranked: Vec<_> = terminal_sessions.iter().collect();
            ranked.sort_by(|a, b| {
                b.updated_at
                    .partial_cmp(&a.updated_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            ranked
                .into_iter()
                .take(ASSISTANT_CONVERSATION_SNAPSHOT_LIMIT)
                .map(|s| {
                    sanitize_terminal_session_meta(
                        &s.id,
                        &s.title,
                        &s.session_type,
                        &s.resource_id,
                        &s.shell_label,
                        &s.cwd,
                        &s.lifecycle,
                        &s.status,
                        s.created_at as i64,
                        s.updated_at as i64,
                    )
                })
                .collect()
        },
        database_connections: db_connections
            .iter()
            .map(|c| {
                sanitize_db_connection_meta(
                    &c.id,
                    &c.name,
                    &c.db_type,
                    &c.host,
                    c.port,
                    &c.user,
                    &c.database,
                    c.ssl,
                    &c.status,
                    c.enabled,
                )
            })
            .collect(),
        docker_instances,
        file_connections,
        server_panels: panels
            .iter()
            .map(|c| {
                sanitize_connection_meta(
                    &c.id,
                    c.kind.as_str(),
                    &c.name,
                    &c.group,
                    &c.env_tag,
                    &c.tags,
                    &c.config,
                )
            })
            .collect(),
        knowledge_documents: knowledge
            .iter()
            .map(|e| {
                sanitize_knowledge_meta(
                    &e.id,
                    &e.kind,
                    &e.title,
                    &e.tags,
                    &e.risk_level,
                    &e.source,
                    &e.env_tag,
                    &e.language,
                    &e.node_type,
                    &e.parent_id,
                    &e.resource_type,
                    &e.resource_id,
                    e.updated_at,
                )
            })
            .collect(),
        protocol_requests: http_requests
            .iter()
            .map(|r| {
                sanitize_http_request_meta(
                    &r.id,
                    &r.name,
                    &r.method,
                    &r.url,
                    r.collection_id.as_deref(),
                    r.environment_id.as_deref(),
                    r.updated_at,
                )
            })
            .collect(),
        recent_tasks: tasks
            .iter()
            .map(|t| {
                sanitize_task_meta(
                    &t.id,
                    &enum_wire_str(&t.task_type),
                    &t.title,
                    &t.resource_id,
                    &t.resource_name,
                    &t.env_tag,
                    &enum_wire_str(&t.risk),
                    &enum_wire_str(&t.status),
                    &enum_wire_str(&t.source),
                    t.updated_at,
                )
            })
            .collect(),
        assistant_conversations: {
            let mut ranked: Vec<_> = conversations.iter().collect();
            ranked.sort_by(|a, b| {
                b.updated_at
                    .partial_cmp(&a.updated_at)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            ranked
                .into_iter()
                .take(ASSISTANT_CONVERSATION_SNAPSHOT_LIMIT)
                .map(|c| {
                    sanitize_assistant_conversation_meta(
                        &c.id,
                        &c.title,
                        &c.provider,
                        &c.model,
                        c.model_selection_id.as_deref(),
                        c.agent_id.as_deref(),
                        c.message_count,
                        c.created_at as i64,
                        c.updated_at as i64,
                        c.parent_conversation_id.as_deref(),
                        c.root_conversation_id.as_deref(),
                        c.pinned_workspace_id.as_deref(),
                        c.linked_terminal_session_id.as_deref(),
                    )
                })
                .collect()
        },
        ai_models: Vec::new(),
    })
}
