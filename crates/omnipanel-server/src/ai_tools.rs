//! P3 AI 工具执行下沉（Web 端服务端自执）。
//!
//! 桌面端 `RegistryToolExecutor` 把工具分为三类：
//! - **Native**（知识库 / skill / 标签 / 资源档案 / web 搜索 / load_skill / list_*_connections）：
//!   由 `omnipanel-mcp::ToolRegistry::execute_isolated` 后端直执；
//! - **UiDelegated**（终端 / 数据库 / Docker / 文件等）：桌面端挂起等前端 dispatchTool 回传。
//! - **ExternalMcp**：外部 MCP 服务桥接。
//!
//! Web 端是无界面进程，没有浏览器前端可以回传结果，因此 P3 把「服务端已具备等价能力」的
//! UiDelegated 工具下沉为**服务端自执**（复用本 crate 已有的 IPC 命令实现，全部基于
//! `omnipanel-ssh` / `omnipanel-db` / `omnipanel-docker` 领域 crate，与桌面端共用同一套逻辑）：
//!
//! - `omni_ssh_exec` / `omni_ssh_create_run_script` / `omni_ssh_get_stats`：复用
//!   `omnipanel-ssh::SshSession::exec_capture` / `create_run_script` / `collect_stats`；
//! - `omni_docker_*`：复用 `crate::docker` / `crate::docker_ops` 的服务端实现；
//! - `omni_database_*`：复用 `crate::db` 的服务端实现；
//! - `omni_files_*`：复用 `crate::files` 的服务端实现；
//! - Native 工具：直接复用 `ToolRegistry::execute_isolated`。
//!
//! 纯 UI 工具（`omni_plan_*` / `omni_ask_user` / `omni_workspace_*` /
//! `omni_spawn_sub_conversations` / `omni_orchestration_ssh_fleet_health`）依赖浏览器交互
//! （todolist / 澄清表单 / 子会话 UI），Web 端返回明确错误，由模型自行降级。
//!
//! 安全边界（诚实说明）：
//! - 危险操作（`omni_docker_container_action` 的 kill/remove、`omni_files_write` 覆盖等）
//!   在 Web 端**直接执行、不弹审批**——这是 Web「服务器版控制台」的固有语义
//!   （部署方对该进程即拥有全部权限）；建议生产部署时用 `--api-key` + 反向代理 TLS 保护。

use std::sync::Arc;

use async_trait::async_trait;
use omnipanel_ai::ToolExecutor;
use omnipanel_ai::types::ToolDef;
use omnipanel_mcp::ToolRegistry;
use omnipanel_ssh::SshConfig;
use serde::Deserialize;

use crate::state::ServerState;

/// Native 工具（`ToolRegistry::execute_isolated` 直执）与 UI 依赖工具的白名单，
/// 用于 Web 端工具面过滤（避免注入后必然失败的纯 UI 工具）。
const UI_ONLY_TOOLS: &[&str] = &[
    "omni_plan_create",
    "omni_plan_add_step",
    "omni_plan_update_step",
    "omni_ask_user",
    "omni_terminal_exec",
    "omni_workspace_create",
    "omni_workspace_switch",
    "omni_workspace_list_resources",
    "omni_workspace_add_resources",
    "omni_workspace_remove_resources",
    "omni_orchestration_ssh_fleet_health",
    "omni_spawn_sub_conversations",
];

/// 过滤 Web 端不可用的工具（纯 UI 依赖）。返回 `(保留列表, 过滤掉的工具名)`。
pub fn filter_web_tools(defs: Vec<ToolDef>) -> (Vec<ToolDef>, Vec<String>) {
    let mut kept = Vec::with_capacity(defs.len());
    let mut dropped = Vec::new();
    for def in defs {
        if UI_ONLY_TOOLS.contains(&def.function.name.as_str()) {
            dropped.push(def.function.name);
        } else {
            kept.push(def);
        }
    }
    (kept, dropped)
}

/// 从存储中按连接 id 解析 SSH 配置（复用 `crate::state::resolve_ssh_config`）。
async fn ssh_config_by_id(state: &ServerState, id: &str) -> Result<SshConfig, String> {
    let conn = {
        let storage = state.storage.lock().await;
        storage
            .get_connection(id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("SSH 连接不存在: {id}"))?
    };
    if conn.kind != omnipanel_store::ConnectionKind::Ssh {
        return Err(format!("连接 {id} 不是 SSH 类型"));
    }
    crate::state::resolve_ssh_config(&conn).map_err(|e| e.to_string())
}

/// 建立无 shell 的 SSH 会话（复用 `SshSession::connect_no_shell`，与 Docker SSH 适配器同构）。
async fn ssh_exec_session(
    state: &ServerState,
    id: &str,
) -> Result<Arc<omnipanel_ssh::SshSession>, String> {
    // 优先复用已有交互 SSH 会话（存在时）
    if let Some(session) = state.ssh_sessions.lock().await.get(id) {
        return Ok(session.clone());
    }
    // 复用 Docker SSH 会话池
    if let Some(session) = state.docker_ssh_sessions.lock().await.get(id) {
        return Ok(session.clone());
    }
    // 否则新建独立 exec 会话（不缓存，命令结束后由调用方释放）
    let config = ssh_config_by_id(state, id).await?;
    let session = omnipanel_ssh::SshSession::connect_no_shell(config)
        .await
        .map_err(|e| e.to_string())?;
    Ok(Arc::new(session))
}

/// `omni_ssh_exec` 参数（与 spec schema 对齐）。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshExecArgs {
    resource_id: String,
    command: String,
}

/// `omni_ssh_create_run_script` 参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshCreateRunScriptArgs {
    resource_id: String,
    name: String,
    content: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

/// `omni_ssh_get_stats` 参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SshGetStatsArgs {
    resource_id: String,
}

/// `omni_files_list` 参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesListArgs {
    connection_id: String,
    path: String,
    #[serde(default)]
    search: Option<String>,
}

/// `omni_files_read` 参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesReadArgs {
    connection_id: String,
    path: String,
    #[serde(default)]
    max_bytes: Option<i64>,
}

/// `omni_files_write` 参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesWriteArgs {
    connection_id: String,
    path: String,
    content: String,
    #[serde(default)]
    append: Option<bool>,
}

/// `omni_files_search` 参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FilesSearchArgs {
    connection_id: String,
    query: String,
    #[serde(default)]
    path: Option<String>,
}

/// `omni_docker_*` 公共参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DockerArgs {
    connection_id: String,
    #[serde(default)]
    container_id: Option<String>,
    #[serde(default)]
    filter: Option<String>,
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    tail: Option<i64>,
}

/// `omni_database_*` 参数。
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DbArgs {
    connection_name: String,
    #[serde(default)]
    database_name: Option<String>,
    #[serde(default)]
    table_name: Option<String>,
    #[serde(default)]
    sql: Option<String>,
}

/// Web 端服务端自执 ToolExecutor。
///
/// 与桌面端 `RegistryToolExecutor` 的分工差异：
/// - Native 工具：完全一致（`ToolRegistry::execute_isolated`）；
/// - 服务端可自执的 UiDelegated 工具（SSH / Docker / DB / Files）：直接调用本 crate 命令，
///   不经浏览器回传；
/// - 纯 UI 工具：返回明确错误；
/// - 外部 MCP：默认需审批（`state.mcp_external_require_approval`，默认 true）。
///   - 关闭审批：服务端直接 `call_service_tool` 自执；
///   - 开启审批：注册 pending 通道，经 WS 事件通知浏览器弹出审批，
///     浏览器 `ai_chat_tool_result` 回传 `approved` 后执行/拒绝。
pub struct ServerToolExecutor<'a> {
    state: &'a ServerState,
    /// 与本次请求 `tools_mode.module_filter` 一致；执行期二次校验，防止模型越权调用。
    module_filter: Option<String>,
    /// 当前对话 id（审批通道 key 前缀）。
    conversation_id: String,
}

impl<'a> ServerToolExecutor<'a> {
    pub fn new(state: &'a ServerState, module_filter: Option<String>) -> Self {
        Self {
            state,
            module_filter,
            conversation_id: String::new(),
        }
    }

    /// 绑定会话 id（审批通道 key 用 `conversation_id:tool_call_id`）。
    pub fn with_conversation(mut self, conversation_id: String) -> Self {
        self.conversation_id = conversation_id;
        self
    }

    /// 外部 MCP 工具需审批：注册 pending 通道并等待浏览器 `ai_chat_tool_result` 回传。
    /// 审批通过后才真正 `call_service_tool`；拒绝/超时返回明确错误。
    async fn execute_external_with_approval(
        &self,
        tool_call_id: &str,
        service_id: &str,
        tool_name: &str,
        args: serde_json::Value,
    ) -> (String, bool) {
        let key = format!("{}:{}", self.conversation_id, tool_call_id);
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.state
            .pending_internal_tool_results
            .lock()
            .await
            .insert(key.clone(), tx);

        // 经 WS 事件总线广播审批请求，前端据此弹出审批（对齐桌面端 ToolCallUpdate::Pending
        // 语义；浏览器收到后调 ai_chat_tool_result）。
        self.state.bus.emit(
            "tool-approval-required",
            serde_json::json!({
                "conversationId": self.conversation_id,
                "toolCallId": tool_call_id,
                "toolName": format!("{service_id}::{tool_name}"),
                "arguments": args,
            }),
        );

        match tokio::time::timeout(std::time::Duration::from_secs(300), rx).await {
            Ok(Ok((_result, true))) => {
                // 审批通过 → 服务端自执
                let manager = match self.state.ensure_mcp_manager().await {
                    Some(m) => m,
                    None => {
                        return (
                            format!(
                                "Error: 外部 MCP 管理器不可用（无法调用 {service_id}::{tool_name}）"
                            ),
                            false,
                        );
                    }
                };
                let manager = manager.lock().await;
                match manager.call_service_tool(service_id, tool_name, args).await {
                    Ok(outcome) => (outcome.content.clone(), !outcome.is_error),
                    Err(err) => (format!("Error: {err}"), false),
                }
            }
            Ok(Ok((result, false))) => (result, false), // 用户拒绝：回传拒绝理由
            Ok(Err(_)) => ("工具响应通道已关闭".to_string(), false),
            Err(_) => {
                self.state
                    .pending_internal_tool_results
                    .lock()
                    .await
                    .remove(&key);
                ("外部工具审批超时（300s）".to_string(), false)
            }
        }
    }
}

/// 模块隔离校验（与桌面端 `ensure_tool_allowed_by_module_filter` 等价）。
fn ensure_tool_allowed(
    state: &ServerState,
    name: &str,
    filter: Option<&str>,
) -> Result<(), String> {
    let _ = state;
    let Some(filter) = filter.filter(|f| !f.is_empty() && *f != "master") else {
        return Ok(());
    };
    if omnipanel_store::builtin_tool_is_cross_module(name) {
        return Ok(());
    }
    match omnipanel_store::builtin_tool_module_key(name) {
        Some(key) if key == filter => Ok(()),
        Some(key) => Err(format!(
            "工具 {name} 属于模块 {key}，当前 Agent 仅允许模块 {filter}"
        )),
        None => Err(format!("工具 {name} 不在当前模块 ({filter}) 的允许范围内")),
    }
}

#[async_trait]
impl<'a> ToolExecutor for ServerToolExecutor<'a> {
    async fn execute(&self, _tool_call_id: &str, name: &str, arguments: &str) -> (String, bool) {
        if let Err(err) = ensure_tool_allowed(&self.state, name, self.module_filter.as_deref()) {
            return (format!("Error: {err}"), false);
        }

        let args: serde_json::Value =
            serde_json::from_str(arguments).unwrap_or_else(|_| serde_json::json!({}));

        // Native 工具：与桌面端完全一致的 execute_isolated（知识库 / skill / 标签 / web / resource）
        if ToolRegistry::is_native_tool(name) {
            return match ToolRegistry::execute_isolated(
                self.state.storage.clone(),
                name,
                args,
                None, // Web 端暂不配置 HTTP 代理（桌面端走 ProxyConfig）
            )
            .await
            {
                Ok(pair) => pair,
                Err(err) => (format!("Error: {err}"), false),
            };
        }

        // P4：外部 MCP 工具（`extmcp::{service_id}::{tool_name}`）→ McpManager 桥接执行
        if let Some((service_id, tool_name)) =
            omnipanel_mcp::external::parse_registry_tool_name(name)
        {
            // P5：审批开关。默认需审批（与桌面端一致），浏览器 `ai_chat_tool_result` 回传。
            if self
                .state
                .mcp_external_require_approval
                .load(std::sync::atomic::Ordering::Relaxed)
            {
                return self
                    .execute_external_with_approval(_tool_call_id, &service_id, &tool_name, args)
                    .await;
            }
            // 关闭审批：服务端直接自执
            let manager = match self.state.ensure_mcp_manager().await {
                Some(m) => m,
                None => {
                    return (
                        format!("Error: 外部 MCP 管理器不可用（无法调用 {name}）"),
                        false,
                    );
                }
            };
            let manager = manager.lock().await;
            let outcome = manager
                .call_service_tool(&service_id, &tool_name, args)
                .await;
            return match outcome {
                Ok(result) => (result.content.clone(), !result.is_error),
                Err(err) => (format!("Error: {err}"), false),
            };
        }

        // 纯 UI 工具：明确报错，让模型降级为文本/其它工具。
        if UI_ONLY_TOOLS.contains(&name) {
            return (
                format!(
                    "Error: 工具 {name} 依赖浏览器 UI（待办/澄清表单/子会话），Web 端不可用，\
                     请改用可自执的工具或直接给出结论。"
                ),
                false,
            );
        }

        // 服务端自执的 UiDelegated 工具
        let result = match name {
            /* ---------- SSH ---------- */
            "omni_ssh_exec" => match serde_json::from_value::<SshExecArgs>(args) {
                Ok(a) => ssh_exec(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_ssh_create_run_script" => {
                match serde_json::from_value::<SshCreateRunScriptArgs>(args) {
                    Ok(a) => ssh_create_run_script(&self.state, &a).await,
                    Err(e) => Err(format!("参数解析失败: {e}")),
                }
            }
            "omni_ssh_get_stats" => match serde_json::from_value::<SshGetStatsArgs>(args) {
                Ok(a) => ssh_get_stats(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            /* ---------- Docker ---------- */
            "omni_docker_list_containers" => match serde_json::from_value::<DockerArgs>(args) {
                Ok(a) => docker_list_containers(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_docker_container_logs" => match serde_json::from_value::<DockerArgs>(args) {
                Ok(a) => docker_container_logs(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_docker_inspect_container" => match serde_json::from_value::<DockerArgs>(args) {
                Ok(a) => docker_inspect_container(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_docker_container_action" => match serde_json::from_value::<DockerArgs>(args) {
                Ok(a) => docker_container_action(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_docker_exec" => match serde_json::from_value::<DockerArgs>(args) {
                Ok(a) => docker_exec(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            /* ---------- Database ---------- */
            "omni_database_get_databases_from_connection" => {
                match serde_json::from_value::<DbArgs>(args) {
                    Ok(a) => db_list_databases(&self.state, &a).await,
                    Err(e) => Err(format!("参数解析失败: {e}")),
                }
            }
            "omni_database_get_tables_from_database" => {
                match serde_json::from_value::<DbArgs>(args) {
                    Ok(a) => db_list_tables(&self.state, &a).await,
                    Err(e) => Err(format!("参数解析失败: {e}")),
                }
            }
            "omni_database_get_table_info" => match serde_json::from_value::<DbArgs>(args) {
                Ok(a) => db_table_info(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_database_execute_sql" => match serde_json::from_value::<DbArgs>(args) {
                Ok(a) => db_execute_sql(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            /* ---------- Files ---------- */
            "omni_files_list" => match serde_json::from_value::<FilesListArgs>(args) {
                Ok(a) => files_list(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_files_read" => match serde_json::from_value::<FilesReadArgs>(args) {
                Ok(a) => files_read(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_files_write" => match serde_json::from_value::<FilesWriteArgs>(args) {
                Ok(a) => files_write(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            "omni_files_search" => match serde_json::from_value::<FilesSearchArgs>(args) {
                Ok(a) => files_search(&self.state, &a).await,
                Err(e) => Err(format!("参数解析失败: {e}")),
            },
            /* ---------- 未覆盖 ---------- */
            other => Err(format!(
                "Web 端暂不支持工具 {other}（UiDelegated 且无服务端自执实现）"
            )),
        };

        match result {
            Ok(text) => (text, true),
            Err(err) => (format!("Error: {err}"), false),
        }
    }
}

/* ---------------- SSH 自执实现 ---------------- */

async fn ssh_exec(state: &ServerState, args: &SshExecArgs) -> Result<String, String> {
    let session = ssh_exec_session(state, &args.resource_id).await?;
    let output = session
        .exec_capture(&args.command)
        .await
        .map_err(|e| e.to_string())?;
    let mut text = String::new();
    if !output.stdout.is_empty() {
        text.push_str(&output.stdout);
    }
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&output.stderr);
    }
    if output.exit_code != 0 {
        text.push_str(&format!("\n[exit code: {}]", output.exit_code));
    }
    if text.trim().is_empty() {
        text = "(无输出)".to_string();
    }
    Ok(text)
}

async fn ssh_create_run_script(
    state: &ServerState,
    args: &SshCreateRunScriptArgs,
) -> Result<String, String> {
    let session = ssh_exec_session(state, &args.resource_id).await?;
    let _timeout = args.timeout_secs.unwrap_or(120).min(600);
    let result = session
        .create_run_script(&args.name, &args.content, &args.args)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_string_pretty(&serde_json::json!({
        "remotePath": result.remote_path,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "exitCode": result.exit_code,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

async fn ssh_get_stats(state: &ServerState, args: &SshGetStatsArgs) -> Result<String, String> {
    // 与 omnipanel-mcp::ssh_tools::get_stats 相同的采集命令（外部 OmniMCP / Web 自执共用
    // 同一输出形态：原始命令输出 + exitCode，模型可读）。
    let session = ssh_exec_session(state, &args.resource_id).await?;
    let stats_cmd = concat!(
        "echo '===UNAME==='; uname -a 2>/dev/null || ver;",
        "echo '===UPTIME==='; uptime 2>/dev/null;",
        "echo '===LOADAVG==='; cat /proc/loadavg 2>/dev/null;",
        "echo '===MEM==='; free -m 2>/dev/null;",
        "echo '===DISK==='; df -h 2>/dev/null | head -20;",
        "echo '===CPU==='; top -bn1 2>/dev/null | head -20 || top -l 1 2>/dev/null | head -20;",
        "echo '===END==='",
    );
    let output = session
        .exec_capture(stats_cmd)
        .await
        .map_err(|e| e.to_string())?;
    Ok(serde_json::to_string(&serde_json::json!({
        "resourceId": args.resource_id,
        "note": "Web 服务端自执（原始命令输出）",
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exit_code,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/* ---------------- Docker 自执实现 ---------------- */

async fn docker_list_containers(state: &ServerState, args: &DockerArgs) -> Result<String, String> {
    let list = crate::docker::docker_list_containers(
        state,
        args.connection_id.clone(),
        args.filter.clone(),
    )
    .await?;
    Ok(serde_json::to_string_pretty(&list).unwrap_or_else(|_| "[]".to_string()))
}

async fn docker_container_logs(state: &ServerState, args: &DockerArgs) -> Result<String, String> {
    let container_id = args
        .container_id
        .clone()
        .ok_or_else(|| "缺少 container_id".to_string())?;
    let tail = args.tail.unwrap_or(200).max(0) as i32;
    let logs = crate::docker_ops::docker_container_logs(
        state,
        args.connection_id.clone(),
        container_id,
        tail,
        None,
    )
    .await?;
    Ok(serde_json::to_string_pretty(&logs).unwrap_or_else(|_| "[]".to_string()))
}

async fn docker_inspect_container(
    state: &ServerState,
    args: &DockerArgs,
) -> Result<String, String> {
    let container_id = args
        .container_id
        .clone()
        .ok_or_else(|| "缺少 container_id".to_string())?;
    let info = crate::docker_ops::docker_inspect_container(
        state,
        args.connection_id.clone(),
        container_id,
    )
    .await?;
    Ok(serde_json::to_string_pretty(&info).unwrap_or_else(|_| "{}".to_string()))
}

async fn docker_container_action(state: &ServerState, args: &DockerArgs) -> Result<String, String> {
    let container_id = args
        .container_id
        .clone()
        .ok_or_else(|| "缺少 container_id".to_string())?;
    let action = args
        .action
        .clone()
        .ok_or_else(|| "缺少 action".to_string())?;
    crate::docker_ops::docker_container_action(
        state,
        args.connection_id.clone(),
        container_id,
        action,
    )
    .await?;
    Ok("ok".to_string())
}

async fn docker_exec(state: &ServerState, args: &DockerArgs) -> Result<String, String> {
    let container_id = args
        .container_id
        .clone()
        .ok_or_else(|| "缺少 container_id".to_string())?;
    let command = args
        .command
        .clone()
        .ok_or_else(|| "缺少 command".to_string())?;
    let out = crate::docker_ops::docker_exec_command(
        state,
        args.connection_id.clone(),
        container_id,
        command,
    )
    .await?;
    let mut text = String::new();
    if !out.stdout.is_empty() {
        text.push_str(&out.stdout);
    }
    if !out.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&out.stderr);
    }
    if out.exit_code != 0 {
        text.push_str(&format!("\n[exit code: {}]", out.exit_code));
    }
    if text.trim().is_empty() {
        text = "(无输出)".to_string();
    }
    Ok(text)
}

/* ---------------- Database 自执实现 ---------------- */

/// 按连接名解析 DbConnectionConfig（`omni_database_*` 用连接名而非 id）。
async fn db_config_by_name(
    state: &ServerState,
    name: &str,
) -> Result<omnipanel_store::DbConnectionConfig, String> {
    let list = state.db_connections.list().map_err(|e| e.to_string())?;
    list.into_iter()
        .find(|c| c.name == name || c.id == name)
        .ok_or_else(|| format!("数据库连接不存在: {name}"))
}

async fn db_list_databases(state: &ServerState, args: &DbArgs) -> Result<String, String> {
    let conn = db_config_by_name(state, &args.connection_name).await?;
    let dbs = crate::db::db_list_databases(state, conn).await?;
    Ok(serde_json::to_string_pretty(&dbs).unwrap_or_else(|_| "[]".to_string()))
}

async fn db_list_tables(state: &ServerState, args: &DbArgs) -> Result<String, String> {
    let conn = db_config_by_name(state, &args.connection_name).await?;
    let tables = crate::db::db_list_tables(state, conn, args.database_name.clone()).await?;
    Ok(serde_json::to_string_pretty(&tables).unwrap_or_else(|_| "[]".to_string()))
}

async fn db_table_info(state: &ServerState, args: &DbArgs) -> Result<String, String> {
    let conn = db_config_by_name(state, &args.connection_name).await?;
    let table = args
        .table_name
        .clone()
        .ok_or_else(|| "缺少 table_name".to_string())?;
    let info = crate::db::db_preview_table(state, conn, table, 200, 0, None, None).await?;
    Ok(serde_json::to_string_pretty(&info).unwrap_or_else(|_| "{}".to_string()))
}

async fn db_execute_sql(state: &ServerState, args: &DbArgs) -> Result<String, String> {
    let conn = db_config_by_name(state, &args.connection_name).await?;
    let sql = args.sql.clone().ok_or_else(|| "缺少 sql".to_string())?;
    let result = crate::db::db_execute_query(
        state,
        conn,
        sql,
        format!("ai-tool-{}", std::process::id()),
        Some(500),
        None,
    )
    .await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string()))
}

/* ---------------- Files 自执实现 ---------------- */

async fn files_list(state: &ServerState, args: &FilesListArgs) -> Result<String, String> {
    let result = crate::files::file_list_dir(
        state,
        args.connection_id.clone(),
        args.path.clone(),
        args.search.clone(),
        None,
    )
    .await?;
    Ok(serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".to_string()))
}

async fn files_read(state: &ServerState, args: &FilesReadArgs) -> Result<String, String> {
    let max_bytes = args
        .max_bytes
        .unwrap_or(512 * 1024)
        .clamp(0, 8 * 1024 * 1024) as f64;
    let data = crate::files::file_read_file(
        state,
        args.connection_id.clone(),
        args.path.clone(),
        max_bytes,
    )
    .await?;
    // 与桌面端 omni_files_read 语义一致：文本解码（二进制以替换字符呈现）
    Ok(String::from_utf8_lossy(&data).into_owned())
}

async fn files_write(state: &ServerState, args: &FilesWriteArgs) -> Result<String, String> {
    let data = args.content.as_bytes().to_vec();
    if args.append.unwrap_or(false) {
        // append：读旧内容 + 新内容
        let existing = crate::files::file_read_file(
            state,
            args.connection_id.clone(),
            args.path.clone(),
            (512 * 1024 * 1024) as f64,
        )
        .await
        .unwrap_or_default();
        let mut merged = existing;
        merged.extend_from_slice(&data);
        crate::files::file_upload_file(
            state,
            args.connection_id.clone(),
            args.path.clone(),
            merged,
        )
        .await?;
    } else {
        crate::files::file_upload_file(state, args.connection_id.clone(), args.path.clone(), data)
            .await?;
    }
    Ok("ok".to_string())
}

async fn files_search(state: &ServerState, args: &FilesSearchArgs) -> Result<String, String> {
    let start = args.path.clone().unwrap_or_default();
    let list = crate::files::file_list_dir(
        state,
        args.connection_id.clone(),
        start,
        Some(args.query.clone()),
        None,
    )
    .await?;
    Ok(serde_json::to_string_pretty(&list).unwrap_or_else(|_| "{}".to_string()))
}
