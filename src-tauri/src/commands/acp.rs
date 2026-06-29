use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::Mutex;

use omnipanel_ai::ir::{StopReason, StreamEvent, ToolStatus};
use omnipanel_ai::providers::acp::AcpManager;
use omnipanel_mcp::{McpServiceRuntimeStatus, McpTransport};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AcpStatus {
    pub connected: bool,
    pub agent_name: Option<String>,
    pub executable: Option<String>,
}

#[derive(Debug, Clone, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionOption {
    pub option_id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Type)]
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
        #[specta(type = f64)]
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

/// Agent 启动时读取的 LLM 配置（由 OmniPanel 写入 app_data_dir/acp-agent-config.json）。
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
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

fn agent_config_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位 app_data_dir: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("创建数据目录失败: {e}"))?;
    Ok(dir.join("acp-agent-config.json"))
}

static AGENT_CONFIG_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn write_agent_config_file(app: &AppHandle, config: &AcpAgentConfigFile) -> Result<PathBuf, String> {
    let _guard = AGENT_CONFIG_WRITE_LOCK
        .lock()
        .map_err(|e| format!("配置写入锁异常: {e}"))?;

    let path = agent_config_path(app)?;
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
    let parts: Vec<String> = trimmed.split_whitespace().map(String::from).collect();
    let binary = parts[0].clone();
    let args = parts.into_iter().skip(1).collect();
    Ok((binary, args))
}

fn default_cwd() -> String {
    env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| ".".to_string())
}

fn resolve_repo_agent_dir() -> Option<PathBuf> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let agent_dir = manifest.join("../agent");
    if agent_dir.join("index.ts").exists() {
        return agent_dir.canonicalize().ok();
    }
    None
}

struct AgentLaunchSpec {
    binary: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    display_command: String,
}

fn resolve_default_agent_launch(app: &AppHandle) -> Option<AgentLaunchSpec> {
    let agent_dir = resolve_repo_agent_dir().or_else(|| {
        app.path().resource_dir().ok().and_then(|resource_dir| {
            let bundled = resource_dir.join("agent");
            if bundled.join("index.ts").exists() {
                Some(bundled)
            } else {
                None
            }
        })
    })?;
    let agent_dir = agent_dir.canonicalize().ok()?;
    Some(AgentLaunchSpec {
        binary: "node".to_string(),
        args: vec![
            "--import".to_string(),
            "tsx".to_string(),
            "index.ts".to_string(),
        ],
        cwd: Some(agent_dir.clone()),
        display_command: format!(
            "node --import tsx index.ts  (cwd: {})",
            agent_dir.display()
        ),
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

fn resolve_default_agent_command(app: &AppHandle) -> Option<String> {
    resolve_default_agent_launch(app).map(|spec| spec.display_command)
}

async fn build_mcp_servers(state: &AppState) -> Vec<serde_json::Value> {
    let manager = state.mcp_manager.lock().await;
    let mut servers = Vec::new();

    for service in manager.list_services() {
        if !service.enabled {
            continue;
        }
        match &service.transport {
            McpTransport::Stdio { config } => {
                servers.push(serde_json::json!({
                    "name": service.name,
                    "command": config.command,
                    "args": config.args,
                    "env": config.env.iter().map(|(k, v)| {
                        serde_json::json!({ "name": k, "value": v })
                    }).collect::<Vec<_>>(),
                }));
            }
            McpTransport::Sse { config } => {
                if service.builtin && service.status != McpServiceRuntimeStatus::Running {
                    continue;
                }
                let url = service
                    .endpoint
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .or_else(|| {
                        if config.url.trim().is_empty() {
                            None
                        } else {
                            Some(config.url.as_str())
                        }
                    });
                let Some(url) = url else { continue };
                // OmniMCP 与 rmcp StreamableHttp 均走 HTTP 传输，非 legacy SSE。
                servers.push(serde_json::json!({
                    "type": "http",
                    "name": service.name,
                    "url": url,
                    "headers": [],
                }));
            }
        }
    }

    servers
}

fn stream_event_to_acp(event: StreamEvent) -> Option<AcpStreamEvent> {
    match event {
        StreamEvent::ContentDelta { text } if text.is_empty() => None,
        StreamEvent::ContentDelta { text } => Some(AcpStreamEvent::ContentDelta { text }),
        StreamEvent::ReasoningDelta { text } => Some(AcpStreamEvent::ReasoningDelta { text }),
        StreamEvent::ToolCall { id, name, arguments } => Some(AcpStreamEvent::ToolCall {
            id,
            name,
            arguments,
        }),
        StreamEvent::ToolCallUpdate { id, status, result } => Some(AcpStreamEvent::ToolCallUpdate {
            id,
            status: tool_status_str(status),
            result,
        }),
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

#[tauri::command]
#[specta::specta]
pub async fn acp_save_agent_config(
    app: AppHandle,
    state: State<'_, AppState>,
    config: AcpAgentConfigInput,
) -> Result<String, String> {
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

    let mcp_servers = build_mcp_servers(&state).await;

    let file = AcpAgentConfigFile {
        version: 2,
        model: model.to_string(),
        api_key: api_key.to_string(),
        base_url: base_url.to_string(),
        api_standard: api_standard.to_string(),
        mcp_servers,
    };

    let path = write_agent_config_file(&app, &file)?;
    Ok(path.to_string_lossy().into_owned())
}

async fn connect_agent(
    app: &AppHandle,
    state: &State<'_, AppState>,
    spec: AgentLaunchSpec,
) -> Result<AcpStatus, String> {
    let config_path = agent_config_path(app)?;
    // 外部 Agent（Cursor / OpenCode / Qwen）使用各自 CLI 鉴权，不依赖配置文件。
    let spawn_env = if config_path.exists() {
        build_spawn_env(&config_path)
    } else {
        HashMap::new()
    };
    let spawn_cwd = spec.cwd.as_ref().map(|p| p.to_string_lossy().into_owned());
    let mut acp = state.acp_state.lock().await;

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

#[tauri::command]
#[specta::specta]
pub async fn acp_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    command_line: String,
) -> Result<AcpStatus, String> {
    let (binary, args) = parse_command_line(&command_line)?;
    let cwd = infer_spawn_cwd(&args);
    connect_agent(
        &app,
        &state,
        AgentLaunchSpec {
            binary,
            args,
            cwd,
            display_command: command_line,
        },
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn acp_connect_default(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AcpStatus, String> {
    let spec = resolve_default_agent_launch(&app)
        .ok_or_else(|| "未找到默认 agent/index.ts，请在 agent 目录执行 npm install".to_string())?;
    connect_agent(&app, &state, spec).await
}

#[tauri::command]
#[specta::specta]
pub fn acp_get_default_command(app: AppHandle) -> Result<String, String> {
    resolve_default_agent_command(&app)
        .ok_or_else(|| "未找到内置 agent/index.ts".to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn acp_disconnect(state: State<'_, AppState>) -> Result<AcpStatus, String> {
    let mut acp = state.acp_state.lock().await;
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

#[tauri::command]
#[specta::specta]
pub async fn acp_get_status(state: State<'_, AppState>) -> Result<AcpStatus, String> {
    let acp = state.acp_state.lock().await;
    Ok(AcpStatus {
        connected: acp.manager.is_some(),
        agent_name: acp.agent_name.clone(),
        executable: acp.executable.clone(),
    })
}

#[tauri::command]
#[specta::specta]
pub async fn acp_prompt(
    state: State<'_, AppState>,
    conversation_id: String,
    user_text: String,
    cwd: Option<String>,
    on_event: Channel<AcpStreamEvent>,
) -> Result<(), String> {
    let cwd = cwd.filter(|s| !s.trim().is_empty()).unwrap_or_else(default_cwd);
    let mcp_servers = build_mcp_servers(&state).await;

    let session_id = {
        let acp = state.acp_state.lock().await;
        let manager = acp
            .manager
            .as_ref()
            .ok_or_else(|| "ACP agent 未连接，请先在设置中配置并连接".to_string())?
            .clone();
        manager
            .ensure_session(&conversation_id, &cwd, mcp_servers)
            .await
            .map_err(|e| e.to_string())?
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();

    let manager = {
        let acp = state.acp_state.lock().await;
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
                .prompt(&session_id, &user_text, tx)
                .await
                .map_err(|e| e.to_string())
        })
    };

    while let Some(event) = rx.recv().await {
        let is_terminal = matches!(&event, StreamEvent::Done { .. } | StreamEvent::Error { .. });
        if let Some(mapped) = stream_event_to_acp(event) {
            if on_event.send(mapped).is_err() {
                break;
            }
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

#[tauri::command]
#[specta::specta]
pub async fn acp_cancel(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let acp = state.acp_state.lock().await;
    let manager = acp
        .manager
        .as_ref()
        .ok_or_else(|| "ACP agent 未连接".to_string())?;
    manager
        .cancel_prompt(&conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub async fn acp_respond_permission(
    state: State<'_, AppState>,
    request_id: f64,
    option_id: String,
) -> Result<(), String> {
    let request_id = request_id as u64;
    let acp = state.acp_state.lock().await;
    let manager = acp
        .manager
        .as_ref()
        .ok_or_else(|| "ACP agent 未连接".to_string())?;
    manager
        .respond_permission(request_id, &option_id)
        .await
        .map_err(|e| e.to_string())
}
