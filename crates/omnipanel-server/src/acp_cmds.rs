//! ACP Agent 连接与对话（Web IPC）。
//!
//! 自 `src-tauri/src/commands/acp.rs` 移植：用 [`EventBus`](crate::bus::EventBus) 替代
//! `AppHandle::emit` / Tauri `Channel`；配置文件写入 `omnipanel_store::ai_config_dir()`。
//!
//! ## `ServerState` 依赖
//! `terminal::ServerState` 需包含 `pub acp: tokio::sync::Mutex<AcpState>` 字段（由父任务接线）。

use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use omnipanel_ai::ir::{StopReason, StreamEvent, ToolStatus};
use omnipanel_ai::providers::acp::{AcpManager, PromptOptions};
use serde::{Deserialize, Serialize};

use crate::bus::EventBus;
use crate::state::ServerState;

/// ACP 流式事件名（WebSocket 订阅 topic）。
pub const ACP_STREAM_EVENT: &str = "acp-stream";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpStatus {
    pub connected: bool,
    pub agent_name: Option<String>,
    pub executable: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpStreamEvent {
    ContentDelta {
        text: String,
    },
    ReasoningDelta {
        text: String,
    },
    ToolCall {
        id: String,
        name: String,
        arguments: String,
    },
    ToolCallUpdate {
        id: String,
        status: String,
        result: Option<String>,
    },
    PermissionRequest {
        #[serde(rename = "requestId")]
        request_id: u64,
        tool_call_id: String,
        title: String,
        raw_input: String,
        options: Vec<AcpPermissionOption>,
    },
    Done {
        stop_reason: String,
    },
    Error {
        message: String,
    },
}

/// Agent 启动时读取的 LLM 配置（写入 `~/.omnipd/ai/acp-agent-config.json`）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentConfigInput {
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub api_standard: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AcpAgentConfigFile {
    #[serde(default = "default_agent_config_version")]
    pub version: u32,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub api_standard: String,
    #[serde(default)]
    pub mcp_servers: Vec<serde_json::Value>,
}

fn default_agent_config_version() -> u32 {
    2
}

pub const OMNIAGENT_CONFIG_ENV: &str = "OMNIAGENT_CONFIG";
const ACP_AGENT_CONFIG_FILE: &str = "acp-agent-config.json";

fn agent_config_path() -> Result<PathBuf, String> {
    let dir = omnipanel_store::ai_config_dir().map_err(|e| format!("无法定位 ai 配置目录: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join(ACP_AGENT_CONFIG_FILE))
}

static AGENT_CONFIG_WRITE_LOCK: LazyLock<StdMutex<()>> = LazyLock::new(|| StdMutex::new(()));

fn write_agent_config_file(config: &AcpAgentConfigFile) -> Result<PathBuf, String> {
    let _guard = AGENT_CONFIG_WRITE_LOCK
        .lock()
        .map_err(|e| format!("配置写入锁异常: {e}"))?;

    let path = agent_config_path()?;
    let json = serde_json::to_string_pretty(config)
        .map_err(|e| format!("序列化 acp-agent-config.json 失败: {e}"))?;
    fs::write(&path, json.as_bytes())
        .map_err(|e| format!("写入配置文件失败 ({}): {e}", path.display()))?;
    Ok(path)
}

fn build_spawn_env(config_path: &PathBuf) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert(
        OMNIAGENT_CONFIG_ENV.to_string(),
        config_path.to_string_lossy().into_owned(),
    );
    env
}

pub struct AcpState {
    pub manager: Option<Arc<AcpManager>>,
    pub agent_name: Option<String>,
    pub executable: Option<String>,
    pub args: Vec<String>,
}

impl Default for AcpState {
    fn default() -> Self {
        Self {
            manager: None,
            agent_name: None,
            executable: None,
            args: Vec::new(),
        }
    }
}

fn parse_command_line(command_line: &str) -> Result<(String, Vec<String>), String> {
    let trimmed = command_line.trim();
    if trimmed.is_empty() {
        return Err("ACP 可执行命令不能为空".to_string());
    }
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut chars = trimmed.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !in_double => {
                in_single = !in_single;
            }
            '"' if !in_single => {
                in_double = !in_double;
            }
            ' ' | '\t' if !in_single && !in_double => {
                if !current.is_empty() {
                    parts.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    if parts.is_empty() {
        return Err("ACP 可执行命令不能为空".to_string());
    }
    let binary = parts.remove(0);
    Ok((binary, parts))
}

pub fn default_cwd() -> String {
    env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

pub struct AgentLaunchSpec {
    pub binary: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub display_command: String,
}

/// 开发态：优先仓库根 `agent/`，其次同级 `omniagent/`。
fn resolve_repo_agent_dir() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    for relative in ["../../agent", "../../../omniagent"] {
        let agent_dir = manifest.join(relative);
        if agent_dir.join("index.ts").exists() {
            return agent_dir.canonicalize().ok();
        }
    }
    None
}

fn resolve_default_agent_launch() -> Option<AgentLaunchSpec> {
    let agent_dir = resolve_repo_agent_dir()?;
    let agent_dir = agent_dir.canonicalize().ok()?;
    Some(AgentLaunchSpec {
        binary: "node".to_string(),
        args: vec![
            "--import".to_string(),
            "tsx".to_string(),
            "index.ts".to_string(),
        ],
        cwd: Some(agent_dir.clone()),
        display_command: format!("node --import tsx index.ts  (cwd: {})", agent_dir.display()),
    })
}

fn infer_spawn_cwd(args: &[String]) -> Option<PathBuf> {
    for arg in args.iter().rev() {
        let path = PathBuf::from(arg);
        if path.file_name().and_then(|name| name.to_str()) == Some("index.ts") {
            if path.is_absolute() {
                if let Some(parent) = path.parent() {
                    if parent.exists() {
                        return Some(parent.to_path_buf());
                    }
                }
            } else if let Some(agent_dir) = resolve_repo_agent_dir() {
                return Some(agent_dir);
            }
        }
    }
    resolve_repo_agent_dir()
}

fn resolve_default_agent_command() -> Option<String> {
    resolve_default_agent_launch().map(|spec| spec.display_command)
}

fn stream_event_to_acp(event: StreamEvent) -> Option<AcpStreamEvent> {
    match event {
        StreamEvent::ContentDelta { text } if text.is_empty() => None,
        StreamEvent::ContentDelta { text } => Some(AcpStreamEvent::ContentDelta { text }),
        StreamEvent::ReasoningDelta { text } => Some(AcpStreamEvent::ReasoningDelta { text }),
        StreamEvent::ToolCall {
            id,
            name,
            arguments,
        } => Some(AcpStreamEvent::ToolCall {
            id,
            name,
            arguments,
        }),
        StreamEvent::ToolCallUpdate { id, status, result } => {
            Some(AcpStreamEvent::ToolCallUpdate {
                id,
                status: tool_status_str(status),
                result,
            })
        }
        StreamEvent::PermissionRequest {
            request_id,
            tool_call_id,
            title,
            raw_input,
            options,
        } => Some(AcpStreamEvent::PermissionRequest {
            request_id,
            tool_call_id,
            title,
            raw_input,
            options: options
                .into_iter()
                .map(|(option_id, name)| AcpPermissionOption { option_id, name })
                .collect(),
        }),
        StreamEvent::Usage { .. } => None,
        StreamEvent::Done { stop_reason } => Some(AcpStreamEvent::Done {
            stop_reason: stop_reason_str(stop_reason),
        }),
        StreamEvent::Error { message } => Some(AcpStreamEvent::Error { message }),
    }
}

fn tool_status_str(status: ToolStatus) -> String {
    match status {
        ToolStatus::Pending => "pending".to_string(),
        ToolStatus::Running => "running".to_string(),
        ToolStatus::Completed => "completed".to_string(),
        ToolStatus::Failed => "failed".to_string(),
    }
}

fn stop_reason_str(reason: StopReason) -> String {
    match reason {
        StopReason::EndTurn => "end_turn".to_string(),
        StopReason::ToolUse => "tool_use".to_string(),
        StopReason::MaxTokens => "max_tokens".to_string(),
        StopReason::Error => "error".to_string(),
        StopReason::Cancelled => "cancelled".to_string(),
        StopReason::Refusal => "refusal".to_string(),
    }
}

fn emit_acp_stream(
    bus: &EventBus,
    conversation_id: &str,
    channel_id: Option<&str>,
    event: &AcpStreamEvent,
) {
    let payload = match serde_json::to_value(event) {
        Ok(v) => v,
        Err(_) => return,
    };
    bus.emit(
        ACP_STREAM_EVENT,
        serde_json::json!({
            "conversationId": conversation_id,
            "event": payload,
        }),
    );
    if let Some(ch) = channel_id {
        bus.emit_channel(ch, payload);
    }
}

pub async fn acp_save_agent_config(config: AcpAgentConfigInput) -> Result<String, String> {
    let model = config.model.trim();
    let api_key = config.api_key.trim();
    let base_url = config.base_url.trim().trim_end_matches('/');
    let api_standard = config.api_standard.trim();

    if model.is_empty() {
        return Err("模型名称不能为空".to_string());
    }
    if api_key.is_empty() {
        return Err("API Key 不能为空".to_string());
    }
    if base_url.is_empty() {
        return Err("Base URL 不能为空".to_string());
    }
    if api_standard != "openai" && api_standard != "anthropic" {
        return Err("apiStandard 必须为 openai 或 anthropic".to_string());
    }

    let file = AcpAgentConfigFile {
        version: 2,
        model: model.to_string(),
        api_key: api_key.to_string(),
        base_url: base_url.to_string(),
        api_standard: api_standard.to_string(),
        mcp_servers: Vec::new(),
    };

    let path = write_agent_config_file(&file)?;
    Ok(path.to_string_lossy().into_owned())
}

pub async fn connect_agent(
    state: &ServerState,
    spec: AgentLaunchSpec,
) -> Result<AcpStatus, String> {
    connect_agent_with_acp_state(&state.acp, spec).await
}

/// 直接接收 `acp` 互斥体，供 Gateway 等不持有完整 `ServerState` 的调用方使用。
pub async fn connect_agent_with_acp_state(
    acp_state: &tokio::sync::Mutex<AcpState>,
    spec: AgentLaunchSpec,
) -> Result<AcpStatus, String> {
    let config_path = agent_config_path()?;
    let spawn_env = if config_path.exists() {
        build_spawn_env(&config_path)
    } else {
        HashMap::new()
    };
    let spawn_cwd = spec.cwd.as_ref().map(|p| p.to_string_lossy().into_owned());
    let mut acp = acp_state.lock().await;

    if let Some(ref manager) = acp.manager {
        manager.disconnect().await.map_err(|e| e.to_string())?;
    }

    let manager = Arc::new(AcpManager::new(
        &spec.binary,
        spec.args.clone(),
        spawn_env,
        spawn_cwd,
    ));
    tokio::time::timeout(std::time::Duration::from_secs(20), manager.connect())
        .await
        .map_err(|_| "连接 ACP Agent 超时（20s），请检查 node 与 agent 配置".to_string())?
        .map_err(|e| e.to_string())?;

    let agent_name = manager.agent_name().await;
    acp.manager = Some(manager);
    acp.agent_name = agent_name.clone();
    acp.executable = Some(spec.display_command.clone());
    acp.args = spec.args;

    Ok(AcpStatus {
        connected: true,
        agent_name,
        executable: Some(spec.display_command),
    })
}

pub async fn acp_connect(state: &ServerState, command_line: String) -> Result<AcpStatus, String> {
    let (binary, args) = parse_command_line(&command_line)?;
    let cwd = infer_spawn_cwd(&args);
    connect_agent(
        state,
        AgentLaunchSpec {
            binary,
            args,
            cwd,
            display_command: command_line,
        },
    )
    .await
}

pub async fn acp_connect_default(state: &ServerState) -> Result<AcpStatus, String> {
    let spec = resolve_default_agent_launch()
        .ok_or_else(|| "未找到默认 agent/index.ts，请在 agent 目录执行 npm install".to_string())?;
    connect_agent(state, spec).await
}

pub fn acp_get_default_command() -> Result<String, String> {
    resolve_default_agent_command().ok_or_else(|| "未找到内置 agent/index.ts".to_string())
}

pub async fn acp_disconnect(state: &ServerState) -> Result<AcpStatus, String> {
    let mut acp = state.acp.lock().await;
    if let Some(ref manager) = acp.manager {
        manager.disconnect().await.map_err(|e| e.to_string())?;
    }
    acp.manager = None;
    acp.agent_name = None;
    acp.executable = None;
    acp.args.clear();
    Ok(AcpStatus {
        connected: false,
        agent_name: None,
        executable: None,
    })
}

pub async fn acp_get_status(state: &ServerState) -> Result<AcpStatus, String> {
    let acp = state.acp.lock().await;
    Ok(AcpStatus {
        connected: acp.manager.is_some(),
        agent_name: acp.agent_name.clone(),
        executable: acp.executable.clone(),
    })
}

/// `acp_prompt` 请求参数（Web 端 `onEvent` 序列化为 channel id 字符串）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptArgs {
    pub conversation_id: String,
    pub user_text: String,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default, rename = "onEvent")]
    pub channel_id: Option<String>,
}

pub async fn acp_prompt(state: &ServerState, args: AcpPromptArgs) -> Result<(), String> {
    acp_prompt_inner(
        state,
        args.conversation_id,
        args.user_text,
        args.cwd,
        args.channel_id,
    )
    .await
}

pub async fn acp_prompt_inner(
    state: &ServerState,
    conversation_id: String,
    user_text: String,
    cwd: Option<String>,
    channel_id: Option<String>,
) -> Result<(), String> {
    let cwd = cwd
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(default_cwd);
    let mcp_servers: Vec<serde_json::Value> = Vec::new();
    let bus = state.bus.clone();
    let channel_ref = channel_id.as_deref();

    let session_id = {
        let acp = state.acp.lock().await;
        let manager = acp
            .manager
            .as_ref()
            .ok_or_else(|| "ACP agent 未连接，请先在设置中配置并连接".to_string())?
            .clone();
        manager
            .ensure_session(&conversation_id, &cwd, mcp_servers, None)
            .await
            .map_err(|e| e.to_string())?
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();

    let manager = {
        let acp = state.acp.lock().await;
        acp.manager
            .as_ref()
            .ok_or_else(|| "ACP agent 未连接".to_string())?
            .clone()
    };

    let prompt_handle = {
        let session_id = session_id.clone();
        let user_text = user_text.clone();
        tokio::spawn(async move {
            manager
                .prompt(&session_id, &user_text, tx, PromptOptions::default())
                .await
                .map_err(|e| e.to_string())
        })
    };

    while let Some(event) = rx.recv().await {
        let is_terminal = matches!(&event, StreamEvent::Done { .. } | StreamEvent::Error { .. });
        if let Some(mapped) = stream_event_to_acp(event) {
            emit_acp_stream(&bus, &conversation_id, channel_ref, &mapped);
        }
        if is_terminal {
            break;
        }
    }

    prompt_handle
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e)?;
    Ok(())
}

pub async fn acp_cancel(state: &ServerState, conversation_id: String) -> Result<(), String> {
    let acp = state.acp.lock().await;
    let manager = acp
        .manager
        .as_ref()
        .ok_or_else(|| "ACP agent 未连接".to_string())?;
    manager
        .cancel_prompt(&conversation_id)
        .await
        .map_err(|e| e.to_string())
}

pub async fn acp_respond_permission(
    state: &ServerState,
    request_id: f64,
    option_id: String,
) -> Result<(), String> {
    let request_id = request_id as u64;
    let acp = state.acp.lock().await;
    let manager = acp
        .manager
        .as_ref()
        .ok_or_else(|| "ACP agent 未连接".to_string())?;
    manager
        .respond_permission(request_id, &option_id)
        .await
        .map_err(|e| e.to_string())
}
