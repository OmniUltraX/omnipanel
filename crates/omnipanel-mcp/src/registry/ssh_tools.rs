//! SSH MCP 工具 — OmniMCP 外部路径直连后端实现。
//!
//! 内部 AI 路径下，`omni_ssh_*` 工具是 UiDelegated（走前端连接池）；
//! 但外部 OmniMCP 客户端无法访问前端的连接池，故此处提供"一次性连接"
//! 后端实现：从 storage 读取 SSH 连接配置 → `SshSession::connect_no_shell`
//! → exec_capture → 关闭会话。
//!
//! 性能权衡：每次调用都重新建立 SSH 连接，不缓存。外部 MCP 调用频率
//! 远低于内部 AI 工具，且避免引入连接池生命周期管理。如果未来需要
//! 高频外部调用，可考虑在此处引入短时缓存。

use std::sync::Arc;
use std::time::Duration;

use omnipanel_ssh::{ssh_config_from_json, ExecOutput, SshSession};
use omnipanel_store::{ConnectionKind, Storage, Vault};
use serde_json::Value;
use tokio::sync::Mutex;

/// 一次性 SSH 命令执行超时（秒）。
const SSH_EXEC_TIMEOUT_SECS: u64 = 60;

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少必填参数: {key}"))
}

/// 按 resource_id 从 storage 加载 SSH 连接配置并解析为 SshConfig。
fn resolve_ssh_config(storage: &Storage, resource_id: &str) -> Result<(String, omnipanel_ssh::SshConfig), String> {
    let conn = storage
        .get_connection(resource_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("SSH 连接不存在：{resource_id}"))?;
    if conn.kind != ConnectionKind::Ssh {
        return Err(format!("连接 {resource_id} 不是 SSH 类型"));
    }
    let secret = conn
        .credential_ref
        .as_deref()
        .and_then(|r| Vault::get(r).ok());
    let config = ssh_config_from_json(&conn.config, secret.as_deref())
        .map_err(|e| format!("SSH 配置解析失败: {}", e.user_message()))?;
    Ok((conn.name, config))
}

/// 在一次性 SSH 会话上执行命令，返回 stdout/stderr/exit_code。
pub async fn exec_command(args: Value, storage: Arc<Mutex<Storage>>) -> Result<String, String> {
    let resource_id = require_str(&args, "resource_id")?;
    let command = require_str(&args, "command")?;

    let (conn_name, ssh_config) = {
        let storage = storage.lock().await;
        resolve_ssh_config(&storage, &resource_id)?
    };

    let session = tokio::time::timeout(
        Duration::from_secs(SSH_EXEC_TIMEOUT_SECS),
        SshSession::connect_no_shell(ssh_config),
    )
    .await
    .map_err(|_| format!("SSH 连接超时（{SSH_EXEC_TIMEOUT_SECS}s）"))?
    .map_err(|e| format!("SSH 连接失败: {}", e.user_message()))?;

    let output: ExecOutput = tokio::time::timeout(
        Duration::from_secs(SSH_EXEC_TIMEOUT_SECS),
        session.exec_capture(&command),
    )
    .await
    .map_err(|_| format!("SSH 命令执行超时（{SSH_EXEC_TIMEOUT_SECS}s）"))?
    .map_err(|e| format!("SSH 命令执行失败: {}", e.user_message()))?;

    // 主动断开，释放 russh 资源
    session.disconnect().await;

    Ok(serde_json::to_string(&serde_json::json!({
        "resourceId": resource_id,
        "connectionName": conn_name,
        "command": command,
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exit_code,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 在一次性 SSH 会话上拉取系统指标。复用 `ssh_pool::fetch_stats` 的底层
/// 采集逻辑代价较大（需 ssh_pool AppState），此处采取简化策略：执行
/// `top -bn1` / `free -m` / `df -h` / `uptime` 等通用命令，由 AI 自行解析。
///
/// 与内部 UiDelegated 路径（`ssh_pool_fetch_stats` 返回结构化 HostSystemStats）
/// 不同：外部路径返回原始命令输出文本，供外部 Agent 自行解读。
pub async fn get_stats(args: Value, storage: Arc<Mutex<Storage>>) -> Result<String, String> {
    let resource_id = require_str(&args, "resource_id")?;

    let (conn_name, ssh_config) = {
        let storage = storage.lock().await;
        resolve_ssh_config(&storage, &resource_id)?
    };

    let session = tokio::time::timeout(
        Duration::from_secs(SSH_EXEC_TIMEOUT_SECS),
        SshSession::connect_no_shell(ssh_config),
    )
    .await
    .map_err(|_| format!("SSH 连接超时（{SSH_EXEC_TIMEOUT_SECS}s）"))?
    .map_err(|e| format!("SSH 连接失败: {}", e.user_message()))?;

    // 一次性 exec 多条命令，减少往返。命令选择兼容 Linux 通用发行版。
    // uname -a / uptime / free -m / df -h / top -bn1（前 20 行）/ cat /proc/loadavg
    let stats_cmd = concat!(
        "echo '===UNAME==='; uname -a 2>/dev/null || ver;", // Windows 兼容（极少 SSH 到 Windows）
        "echo '===UPTIME==='; uptime 2>/dev/null;",
        "echo '===LOADAVG==='; cat /proc/loadavg 2>/dev/null;",
        "echo '===MEM==='; free -m 2>/dev/null;",
        "echo '===DISK==='; df -h 2>/dev/null | head -20;",
        "echo '===CPU==='; top -bn1 2>/dev/null | head -20 || top -l 1 2>/dev/null | head -20;",
        "echo '===END==='",
    );

    let output: ExecOutput = tokio::time::timeout(
        Duration::from_secs(SSH_EXEC_TIMEOUT_SECS),
        session.exec_capture(stats_cmd),
    )
    .await
    .map_err(|_| format!("SSH stats 采集超时（{SSH_EXEC_TIMEOUT_SECS}s）"))?
    .map_err(|e| format!("SSH stats 采集失败: {}", e.user_message()))?;

    session.disconnect().await;

    Ok(serde_json::to_string(&serde_json::json!({
        "resourceId": resource_id,
        "connectionName": conn_name,
        "note": "外部 OmniMCP 路径返回原始命令输出；内部 AI 路径走 ssh_pool_fetch_stats 返回结构化 HostSystemStats。",
        "stdout": output.stdout,
        "stderr": output.stderr,
        "exitCode": output.exit_code,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}
