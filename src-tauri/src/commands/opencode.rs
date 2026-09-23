use crate::commands::agents;
use omnipanel_ai::providers::opencode::{
    OPS_AGENT_ID, OpenCodeAgentInfo, OpenCodeChatMessage, OpenCodeClient, OpenCodeMessagePart,
    OpenCodeSessionInfo, OpenCodeTokenUsage, OpenCodeToolCall, ensure_opencode_service,
    omnipanel_opencode_ops_dir, stop_opencode_serve, sync_omnimcp_into_opencode_config,
};

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeInstallStatus {
    /// 是否检测到 OpenCode CLI。
    pub installed: bool,
    /// 解析到的可执行文件路径。
    pub executable_path: Option<String>,
    /// `opencode --version` 输出（若可用）。
    pub version: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeSessionDto {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub directory: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeToolCallDto {
    pub id: String,
    pub name: String,
    pub arguments: String,
    pub result: Option<String>,
    /// `pending` | `running` | `completed` | `failed`
    pub status: String,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum OpenCodeMessagePartDto {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    #[serde(rename = "tool-call")]
    ToolCall {
        id: String,
        name: String,
        arguments: String,
        result: Option<String>,
        status: String,
    },
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeTokenUsageDto {
    pub input: u32,
    pub output: u32,
    pub reasoning: u32,
    pub cache_read: u32,
    pub cache_write: u32,
    pub total: Option<u32>,
    /// OpenCode `tokenTotal`（input+output+reasoning+cache）
    pub context_total: u32,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeMessageDto {
    pub id: String,
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub parts: Option<Vec<OpenCodeMessagePartDto>>,
    pub tool_calls: Option<Vec<OpenCodeToolCallDto>>,
    pub created_at: i64,
    pub tokens: Option<OpenCodeTokenUsageDto>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub context_limit: Option<u32>,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeMcpSyncResult {
    /// 写入的配置文件路径。
    pub path: String,
    /// 本次写入的 OmniMCP URL。
    pub mcp_url: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeAgentDto {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// `primary` | `subagent` | `all`
    pub mode: String,
    pub hidden: bool,
    pub color: Option<String>,
}

fn agent_to_dto(a: OpenCodeAgentInfo) -> OpenCodeAgentDto {
    OpenCodeAgentDto {
        id: a.id,
        name: a.name,
        description: a.description,
        mode: a.mode,
        hidden: a.hidden,
        color: a.color,
    }
}

fn opencode_binary() -> Option<std::path::PathBuf> {
    crate::commands::providers::cli_provider_list()
        .ok()
        .and_then(|list| {
            list.into_iter()
                .find(|p| p.id == "opencode")
                .and_then(|p| p.binary)
                .map(std::path::PathBuf::from)
        })
}

async fn opencode_client() -> Result<OpenCodeClient, String> {
    let endpoint = ensure_opencode_service(opencode_binary().as_deref()).await?;
    Ok(OpenCodeClient::new(endpoint))
}

fn session_to_dto(s: OpenCodeSessionInfo) -> OpenCodeSessionDto {
    OpenCodeSessionDto {
        id: s.id,
        title: s.title,
        updated_at: s.updated_at,
        directory: s.directory,
    }
}

fn message_to_dto(m: OpenCodeChatMessage) -> OpenCodeMessageDto {
    OpenCodeMessageDto {
        id: m.id,
        role: m.role,
        content: m.content,
        reasoning: m.reasoning,
        parts: m.parts.map(|parts| parts.into_iter().map(part_to_dto).collect()),
        tool_calls: m
            .tool_calls
            .map(|calls| calls.into_iter().map(tool_call_to_dto).collect()),
        created_at: m.created_at,
        tokens: m.tokens.map(token_usage_to_dto),
        provider_id: m.provider_id,
        model_id: m.model_id,
        context_limit: m.context_limit,
    }
}

fn token_usage_to_dto(t: OpenCodeTokenUsage) -> OpenCodeTokenUsageDto {
    let context_total = t.context_total();
    OpenCodeTokenUsageDto {
        input: t.input,
        output: t.output,
        reasoning: t.reasoning,
        cache_read: t.cache_read,
        cache_write: t.cache_write,
        total: t.total,
        context_total,
    }
}

fn tool_call_to_dto(t: OpenCodeToolCall) -> OpenCodeToolCallDto {
    OpenCodeToolCallDto {
        id: t.id,
        name: t.name,
        arguments: t.arguments,
        result: t.result,
        status: t.status,
    }
}

fn part_to_dto(p: OpenCodeMessagePart) -> OpenCodeMessagePartDto {
    match p {
        OpenCodeMessagePart::Text { text } => OpenCodeMessagePartDto::Text { text },
        OpenCodeMessagePart::Reasoning { text } => OpenCodeMessagePartDto::Reasoning { text },
        OpenCodeMessagePart::ToolCall {
            id,
            name,
            arguments,
            result,
            status,
        } => OpenCodeMessagePartDto::ToolCall {
            id,
            name,
            arguments,
            result,
            status,
        },
    }
}

fn omnimcp_url() -> String {
    omnipanel_mcp::builtin_mcp_endpoint()
}

fn sync_omnimcp_config(enabled: bool) -> Result<(OpenCodeMcpSyncResult, bool), String> {
    let mcp_url = omnimcp_url();
    let outcome = sync_omnimcp_into_opencode_config(&mcp_url, enabled)?;
    tracing::info!(
        path = %outcome.path.display(),
        workspace = %outcome.workspace_dir.display(),
        mcp_url = %mcp_url,
        enabled,
        changed = outcome.changed,
        "已同步 OpenCode 工作区配置（OmniMCP 仅项目级 + 运维智能体）"
    );
    Ok((
        OpenCodeMcpSyncResult {
            path: outcome.path.display().to_string(),
            mcp_url,
            enabled,
        },
        outcome.changed,
    ))
}

/// OpenCode 会话默认 cwd：OmniPanel ops 工作区（含项目级 OmniMCP，不污染其它仓库）。
fn opencode_session_cwd(directory: Option<String>) -> Result<String, String> {
    if let Some(dir) = directory.filter(|s| !s.trim().is_empty()) {
        return Ok(dir);
    }
    let ops = omnipanel_opencode_ops_dir()?;
    std::fs::create_dir_all(&ops)
        .map_err(|e| format!("创建 OpenCode 工作区失败 {}: {e}", ops.display()))?;
    Ok(ops.to_string_lossy().into_owned())
}

/// 检测本机是否已安装 OpenCode CLI。
#[tauri::command]
#[specta::specta]
pub async fn detect_opencode_install() -> Result<OpenCodeInstallStatus, omnipanel_error::OmniError>
{
    Ok(agents::detect_opencode_for_legacy())
}

/// 确保 OpenCode HTTP 服务可用（`opencode serve`），并初始化隔离工作区。
///
/// 初始化顺序：
/// 1. 从全局 `~/.config/opencode/opencode.json` 剥离 omnipanel MCP（其它项目不可见）
/// 2. 写入 `~/.config/omnipanel/opencode-ops/`（OmniMCP + tool_output + compaction + omnipanel-ops 智能体）
/// 3. 配置有变更则重启 serve
#[tauri::command]
#[specta::specta]
pub async fn opencode_ensure_service() -> Result<(), String> {
    let mut config_changed = false;
    match sync_omnimcp_config(true) {
        Ok((_, changed)) => config_changed = changed,
        Err(err) => {
            tracing::warn!(error = %err, "同步 OpenCode 工作区配置失败");
        }
    }
    if config_changed {
        tracing::info!(
            agent = OPS_AGENT_ID,
            "OpenCode 工作区配置已变更 → 重启 serve 以加载项目级 MCP / 智能体"
        );
        stop_opencode_serve();
    }
    let _ = ensure_opencode_service(opencode_binary().as_deref()).await?;
    Ok(())
}

/// 停止 OmniPanel 拉起的 `opencode serve`，并在工作区配置中禁用 OmniMCP。
#[tauri::command]
#[specta::specta]
pub async fn opencode_stop_service() -> Result<(), String> {
    stop_opencode_serve();
    if let Err(err) = sync_omnimcp_config(false) {
        tracing::warn!(error = %err, "禁用 OpenCode 工作区 OmniMCP 失败");
    }
    Ok(())
}

/// 手动同步：全局剥离 OmniMCP + 写入 ops 工作区配置。
#[tauri::command]
#[specta::specta]
pub async fn opencode_sync_omnimcp_config(enabled: bool) -> Result<OpenCodeMcpSyncResult, String> {
    sync_omnimcp_config(enabled).map(|(result, _)| result)
}

/// 列出 OpenCode 会话。
#[tauri::command]
#[specta::specta]
pub async fn opencode_list_sessions() -> Result<Vec<OpenCodeSessionDto>, String> {
    let client = opencode_client().await?;
    let mut sessions = client.list_sessions().await?;
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(sessions.into_iter().map(session_to_dto).collect())
}

/// 新建 OpenCode 会话。`model` 形如 `providerID/modelID`。
///
/// 未指定 `directory` 时使用 OmniPanel ops 工作区（含项目级 OmniMCP 与运维智能体）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_create_session(
    directory: Option<String>,
    model: Option<String>,
) -> Result<OpenCodeSessionDto, String> {
    let client = opencode_client().await?;
    let cwd = opencode_session_cwd(directory)?;
    let model_pair = model.as_deref().and_then(|raw| {
        let raw = raw.trim();
        let (provider, model_id) = raw.split_once('/')?;
        if provider.is_empty() || model_id.is_empty() {
            None
        } else {
            Some((provider.to_string(), model_id.to_string()))
        }
    });
    let model_ref = model_pair.as_ref().map(|(p, m)| (p.as_str(), m.as_str()));
    let created = client.create_session(&cwd, model_ref).await?;
    // 默认切到运维智能体（工作区 default_agent 也会指向它；这里显式再设一次更稳）
    if let Err(err) = client.switch_session_agent(&created.id, OPS_AGENT_ID).await {
        tracing::warn!(
            session = %created.id,
            error = %err,
            "切换到 {OPS_AGENT_ID} 失败（会话仍可用）"
        );
    }
    Ok(session_to_dto(created))
}

/// 删除 OpenCode 会话。
#[tauri::command]
#[specta::specta]
pub async fn opencode_delete_session(session_id: String) -> Result<(), String> {
    let client = opencode_client().await?;
    client.delete_session(&session_id).await
}

/// 拉取 OpenCode 会话消息（旧→新）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_get_messages(session_id: String) -> Result<Vec<OpenCodeMessageDto>, String> {
    let client = opencode_client().await?;
    let msgs = client.get_session_messages(&session_id).await?;
    Ok(msgs.into_iter().map(message_to_dto).collect())
}

/// 列出 OpenCode Agent（`GET /api/agent`）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_list_agents() -> Result<Vec<OpenCodeAgentDto>, String> {
    let client = opencode_client().await?;
    let agents = client.list_agents().await?;
    Ok(agents.into_iter().map(agent_to_dto).collect())
}

/// 获取单个 OpenCode Agent（`GET /api/agent/{agentID}`）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_get_agent(agent_id: String) -> Result<OpenCodeAgentDto, String> {
    let client = opencode_client().await?;
    let agent = client.get_agent(&agent_id).await?;
    Ok(agent_to_dto(agent))
}

/// 切换会话后续回合使用的 Agent（`POST /api/session/{id}/agent`）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_switch_session_agent(
    session_id: String,
    agent: String,
) -> Result<(), String> {
    let client = opencode_client().await?;
    client.switch_session_agent(&session_id, &agent).await
}

/// 回复 OpenCode 澄清提问（`answers`：每题一组选中的 label）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_reply_question(
    session_id: String,
    request_id: String,
    answers: Vec<Vec<String>>,
) -> Result<(), String> {
    let client = opencode_client().await?;
    client
        .reply_question(&session_id, &request_id, &answers)
        .await
}

/// 拒绝 / 跳过 OpenCode 澄清提问。
#[tauri::command]
#[specta::specta]
pub async fn opencode_reject_question(
    session_id: String,
    request_id: String,
) -> Result<(), String> {
    let client = opencode_client().await?;
    client.reject_question(&session_id, &request_id).await
}

/// 回复 OpenCode V2 Form（`answer`：field key → string | string[] | bool | number）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_reply_form(
    session_id: String,
    form_id: String,
    answer: serde_json::Map<String, serde_json::Value>,
) -> Result<(), String> {
    let client = opencode_client().await?;
    client.reply_form(&session_id, &form_id, &answer).await
}

/// 取消 / 跳过 OpenCode V2 Form。
#[tauri::command]
#[specta::specta]
pub async fn opencode_cancel_form(session_id: String, form_id: String) -> Result<(), String> {
    let client = opencode_client().await?;
    client.cancel_form(&session_id, &form_id).await
}

/// 回复 OpenCode 权限请求（`decision`: once | always | reject）。
#[tauri::command]
#[specta::specta]
pub async fn opencode_reply_permission(
    session_id: String,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    let client = opencode_client().await?;
    client
        .reply_permission(&session_id, &request_id, &decision)
        .await
}
