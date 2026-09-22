use crate::commands::agents;
use omnipanel_ai::providers::opencode::{
    OpenCodeAgentInfo, OpenCodeChatMessage, OpenCodeClient, OpenCodeSessionInfo,
    ensure_opencode_service, sync_omnimcp_into_opencode_config,
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
pub struct OpenCodeMessageDto {
    pub id: String,
    pub role: String,
    pub content: String,
    pub reasoning: Option<String>,
    pub created_at: i64,
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
        created_at: m.created_at,
    }
}

fn omnimcp_url() -> String {
    omnipanel_mcp::builtin_mcp_endpoint()
}

fn sync_omnimcp_config(enabled: bool) -> Result<OpenCodeMcpSyncResult, String> {
    let mcp_url = omnimcp_url();
    let path = sync_omnimcp_into_opencode_config(&mcp_url, enabled)?;
    tracing::info!(
        path = %path.display(),
        mcp_url = %mcp_url,
        enabled,
        "已同步 OmniMCP 到 OpenCode 配置"
    );
    Ok(OpenCodeMcpSyncResult {
        path: path.display().to_string(),
        mcp_url,
        enabled,
    })
}

/// 检测本机是否已安装 OpenCode CLI。
#[tauri::command]
#[specta::specta]
pub async fn detect_opencode_install() -> Result<OpenCodeInstallStatus, omnipanel_error::OmniError>
{
    Ok(agents::detect_opencode_for_legacy())
}

/// 确保 OpenCode HTTP 服务可用（`opencode serve`），并写入 OmniMCP 到 opencode.json。
#[tauri::command]
#[specta::specta]
pub async fn opencode_ensure_service() -> Result<(), String> {
    let _ = ensure_opencode_service(opencode_binary().as_deref()).await?;
    // 配置写入失败不阻断服务启动（用户仍可手动配）
    if let Err(err) = sync_omnimcp_config(true) {
        tracing::warn!(error = %err, "同步 OmniMCP → OpenCode 配置失败");
    }
    Ok(())
}

/// 停止 OmniPanel 拉起的 `opencode serve`，并在 opencode.json 中禁用 OmniMCP 条目。
#[tauri::command]
#[specta::specta]
pub async fn opencode_stop_service() -> Result<(), String> {
    omnipanel_ai::providers::opencode::stop_opencode_serve();
    if let Err(err) = sync_omnimcp_config(false) {
        tracing::warn!(error = %err, "禁用 OpenCode 中 OmniMCP 条目失败");
    }
    Ok(())
}

/// 手动将 OmniMCP 合并进 `~/.config/opencode/opencode.json`。
#[tauri::command]
#[specta::specta]
pub async fn opencode_sync_omnimcp_config(enabled: bool) -> Result<OpenCodeMcpSyncResult, String> {
    sync_omnimcp_config(enabled)
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
#[tauri::command]
#[specta::specta]
pub async fn opencode_create_session(
    directory: Option<String>,
    model: Option<String>,
) -> Result<OpenCodeSessionDto, String> {
    let client = opencode_client().await?;
    let cwd = directory
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(crate::commands::acp::default_cwd);
    let model_pair = model.as_deref().and_then(|raw| {
        let raw = raw.trim();
        let (provider, model_id) = raw.split_once('/')?;
        if provider.is_empty() || model_id.is_empty() {
            None
        } else {
            Some((provider.to_string(), model_id.to_string()))
        }
    });
    let model_ref = model_pair
        .as_ref()
        .map(|(p, m)| (p.as_str(), m.as_str()));
    let created = client.create_session(&cwd, model_ref).await?;
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
