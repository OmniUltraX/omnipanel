//! Docker MCP 工具 — OmniMCP 外部路径直连后端实现。
//!
//! 内部 AI 路径下，`omni_docker_*` 工具是 UiDelegated（走前端 adapter）；
//! 但外部 OmniMCP 客户端无法访问前端的 adapter / ssh_pool，故此处提供
//! "一次性连接" 后端实现：从 storage 读取 Docker 连接配置 → 构造 adapter
//! → 调用方法 → 释放资源。
//!
//! 实现路径：
//! - Local Engine: `LocalDockerAdapter::connect()`
//! - Remote Engine: `LocalDockerAdapter::connect_remote_http/https`
//! - SSH Engine: 一次性 `SshSession::connect_no_shell` → `SshDockerAdapter::new`
//! - 1Panel: `OnePanelAdapter::new(OnePanelClient::new(...), ...)`
//!
//! 性能权衡：每次调用都重新建立连接（与 ssh_tools.rs 同策略）。外部 MCP
//! 调用频率远低于内部 AI 工具，且避免引入连接池生命周期管理。

use std::sync::Arc;
use std::time::Duration;

use omnipanel_docker::{
    ContainerFilter, DockerAdapter, DockerConnectionSource, DockerContainerAction,
    DockerLogQuery, LocalDockerAdapter, OnePanelAdapter, OnePanelClient, SshDockerAdapter,
};
use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::{ssh_config_from_json, SshConfig, SshSession};
use omnipanel_store::{ConnectionKind, Storage, Vault};
use serde::Deserialize;
use serde_json::Value;
use tokio::sync::Mutex;

/// 一次性 Docker 操作超时（秒）。
const DOCKER_OP_TIMEOUT_SECS: u64 = 60;

fn require_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少必填参数: {key}"))
}

fn optional_str(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
}

/// 解析自 `Connection.config`（kind=docker）的 Docker 连接配置。
/// 与 `src-tauri/src/commands/docker/mod.rs` 的 `DockerConnectionConfig` 保持一致。
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DockerConnectionConfig {
    source: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    #[serde(default)]
    tls: Option<bool>,
    #[serde(default)]
    ca_cert: Option<String>,
    #[serde(default)]
    client_cert: Option<String>,
    #[serde(default)]
    client_key: Option<String>,
    ssh: Option<SshConfig>,
    bound_ssh_connection_id: Option<String>,
    #[serde(default)]
    onepanel: Option<OnePanelConfigDto>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OnePanelConfigDto {
    base_url: String,
    api_key: String,
    #[serde(default)]
    insecure: bool,
}

/// 已解析的 Docker 操作目标（与 Tauri 侧 `DockerTarget` 对应，但简化为枚举适配器）。
enum DockerTarget {
    Local(LocalDockerAdapter),
    Ssh(SshDockerAdapter, Arc<SshSession>),
    OnePanel(OnePanelAdapter),
}

/// 从 storage 同步读取 Docker 连接配置（不建立任何连接）。
///
/// 返回 `(conn_name, parsed_config, source)`，由调用方在释放 storage 锁后
/// 再根据 source 建立实际连接（避免 `&Storage` 跨 `.await`）。
fn load_docker_config(
    storage: &Storage,
    connection_id: &str,
) -> Result<(String, DockerConnectionConfig, DockerConnectionSource), String> {
    let conn = storage
        .get_connection(connection_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("Docker 连接不存在: {connection_id}"))?;
    if conn.kind != ConnectionKind::Docker {
        return Err(format!("连接 {connection_id} 不是 Docker 类型"));
    }
    let cfg: DockerConnectionConfig =
        serde_json::from_str(&conn.config).unwrap_or_default();
    let source = cfg
        .source
        .as_deref()
        .map(DockerConnectionSource::parse)
        .unwrap_or(DockerConnectionSource::LocalEngine);
    Ok((conn.name, cfg, source))
}

/// 同步解析 Docker SSH 连接的 SshConfig：
/// - 若 `bound_ssh_connection_id` 设置，从 storage 加载该 SSH 连接的配置；
/// - 否则使用 docker 配置内嵌的 `ssh` 字段。
fn resolve_ssh_config_for_docker(
    storage: &Storage,
    cfg: &DockerConnectionConfig,
) -> Result<SshConfig, String> {
    if let Some(bound_id) = cfg.bound_ssh_connection_id.as_deref().filter(|s| !s.trim().is_empty()) {
        let ssh_conn = storage
            .get_connection(bound_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("绑定的 SSH 连接不存在: {bound_id}"))?;
        if ssh_conn.kind != ConnectionKind::Ssh {
            return Err(format!("绑定连接 {bound_id} 不是 SSH 类型"));
        }
        let secret = ssh_conn
            .credential_ref
            .as_deref()
            .and_then(|r| Vault::get(r).ok());
        return ssh_config_from_json(&ssh_conn.config, secret.as_deref())
            .map_err(|e| format!("SSH 配置解析失败: {}", e.user_message()));
    }
    cfg.ssh
        .clone()
        .ok_or_else(|| "ssh-engine 类型缺少 Docker SSH 配置且未绑定 SSH 连接".to_string())
}

/// 在已释放 storage 锁后，根据已加载的配置构造 Docker target。
async fn build_target(
    connection_id: &str,
    conn_name: String,
    cfg: DockerConnectionConfig,
    source: DockerConnectionSource,
    storage: Arc<Mutex<Storage>>,
) -> Result<(String, DockerTarget), String> {
    let target = match source {
        DockerConnectionSource::LocalEngine => {
            let adapter = LocalDockerAdapter::connect()
                .map_err(|e| format!("连接本地 Docker Engine 失败: {}", e.user_message()))?;
            DockerTarget::Local(adapter)
        }
        DockerConnectionSource::RemoteEngine => {
            let host = cfg.host.as_deref().ok_or_else(|| {
                "remote-engine 类型缺少 Docker host 配置".to_string()
            })?;
            let port = cfg.port.unwrap_or(if cfg.tls.unwrap_or(true) { 2376 } else { 2375 });
            let adapter = if cfg.tls.unwrap_or(true) {
                LocalDockerAdapter::connect_remote_https(
                    host,
                    port,
                    cfg.ca_cert.as_deref(),
                    cfg.client_cert.as_deref(),
                    cfg.client_key.as_deref(),
                )
                .map_err(|e| format!("连接远程 Docker Engine (TLS) 失败: {}", e.user_message()))?
            } else {
                LocalDockerAdapter::connect_remote_http(host, port)
                    .map_err(|e| format!("连接远程 Docker Engine (HTTP) 失败: {}", e.user_message()))?
            };
            DockerTarget::Local(adapter)
        }
        DockerConnectionSource::SshEngine => {
            let ssh_config = {
                let storage = storage.lock().await;
                resolve_ssh_config_for_docker(&storage, &cfg)?
            };
            let session = tokio::time::timeout(
                Duration::from_secs(DOCKER_OP_TIMEOUT_SECS),
                SshSession::connect_no_shell(ssh_config),
            )
            .await
            .map_err(|_| format!("SSH 连接超时（{DOCKER_OP_TIMEOUT_SECS}s）"))?
            .map_err(|e| format!("SSH 连接失败: {}", e.user_message()))?;
            let session_arc = Arc::new(session);
            let adapter = SshDockerAdapter::new(session_arc.clone());
            DockerTarget::Ssh(adapter, session_arc)
        }
        DockerConnectionSource::OnePanel | DockerConnectionSource::PanelAdapter => {
            let panel = cfg.onepanel.as_ref().ok_or_else(|| {
                "onepanel 类型缺少 Docker 1Panel 配置".to_string()
            })?;
            let client = OnePanelClient::new(&panel.base_url, &panel.api_key, panel.insecure);
            let adapter = OnePanelAdapter::new(client, connection_id.to_string());
            DockerTarget::OnePanel(adapter)
        }
    };
    Ok((conn_name, target))
}

/// 加载配置 + 建立目标（统一入口，调用方仅传入 `Arc<Mutex<Storage>>`）。
async fn resolve_target(
    storage: Arc<Mutex<Storage>>,
    connection_id: &str,
) -> Result<(String, DockerTarget), String> {
    if connection_id == "docker-local" {
        let adapter = LocalDockerAdapter::connect()
            .map_err(|e| format!("连接本地 Docker Engine 失败: {}", e.user_message()))?;
        return Ok(("docker-local".to_string(), DockerTarget::Local(adapter)));
    }
    let (conn_name, cfg, source) = {
        let storage = storage.lock().await;
        load_docker_config(&storage, connection_id)?
    };
    build_target(connection_id, conn_name, cfg, source, storage).await
}

/// 列出指定 Docker 连接下的容器。
pub async fn list_containers(
    args: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let filter_str = optional_str(&args, "filter");
    if let Some(ref f) = filter_str {
        if !["all", "running", "stopped"].contains(&f.as_str()) {
            return Err(format!("未知 filter: {f}（应为 all/running/stopped）"));
        }
    }
    let filter = ContainerFilter::parse(filter_str.as_deref());

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let containers = match target {
        DockerTarget::Local(adapter) => {
            with_timeout(adapter.list_containers(filter), DOCKER_OP_TIMEOUT_SECS).await?
        }
        DockerTarget::Ssh(adapter, session) => {
            let result = with_timeout(adapter.list_containers(filter), DOCKER_OP_TIMEOUT_SECS).await;
            session.disconnect().await;
            result?
        }
        DockerTarget::OnePanel(adapter) => {
            with_timeout(adapter.list_containers(filter), DOCKER_OP_TIMEOUT_SECS).await?
        }
    };

    let simplified: Vec<Value> = containers
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "name": c.name,
                "image": c.image,
                "state": c.state,
                "statusText": c.status_text,
                "running": c.running,
                "ports": c.ports.iter().map(|p| {
                    if let Some(public) = p.public_port {
                        format!("{}:{}->{}/{}", p.ip.as_deref().unwrap_or("0.0.0.0"), public, p.private_port, p.protocol)
                    } else {
                        format!("{}/{}", p.private_port, p.protocol)
                    }
                }).collect::<Vec<_>>(),
                "networks": c.networks,
                "ipAddress": c.ip_address,
                "composeProject": c.compose_project,
                "composeService": c.compose_service,
            })
        })
        .collect();

    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "filter": filter_str.unwrap_or_else(|| "all".to_string()),
        "count": simplified.len(),
        "containers": simplified,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 拉取容器日志。
pub async fn container_logs(
    args: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let container_id = require_str(&args, "container_id")?;
    let tail = args
        .get("tail")
        .and_then(|v| v.as_i64())
        .filter(|n| *n > 0)
        .unwrap_or(200);
    let since = optional_str(&args, "since");

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let query = DockerLogQuery {
        tail,
        since,
    };

    let logs = match target {
        DockerTarget::Local(adapter) => {
            with_timeout(adapter.container_logs(&container_id, &query), DOCKER_OP_TIMEOUT_SECS)
                .await?
        }
        DockerTarget::Ssh(adapter, session) => {
            let result = with_timeout(
                adapter.container_logs(&container_id, &query),
                DOCKER_OP_TIMEOUT_SECS,
            )
            .await;
            session.disconnect().await;
            result?
        }
        DockerTarget::OnePanel(adapter) => {
            with_timeout(adapter.container_logs(&container_id, &query), DOCKER_OP_TIMEOUT_SECS)
                .await?
        }
    };

    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "containerId": container_id,
        "tail": tail,
        "count": logs.len(),
        "logs": logs,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 查看容器详情。
pub async fn inspect_container(
    args: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let container_id = require_str(&args, "container_id")?;

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let detail = match target {
        DockerTarget::Local(adapter) => {
            with_timeout(adapter.inspect_container(&container_id), DOCKER_OP_TIMEOUT_SECS).await?
        }
        DockerTarget::Ssh(adapter, session) => {
            let result =
                with_timeout(adapter.inspect_container(&container_id), DOCKER_OP_TIMEOUT_SECS)
                    .await;
            session.disconnect().await;
            result?
        }
        DockerTarget::OnePanel(adapter) => {
            with_timeout(adapter.inspect_container(&container_id), DOCKER_OP_TIMEOUT_SECS).await?
        }
    };

    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "containerId": container_id,
        "name": detail.summary.name,
        "image": detail.summary.image,
        "state": detail.summary.state,
        "statusText": detail.summary.status_text,
        "running": detail.summary.running,
        "command": detail.command,
        "restartPolicy": detail.restart_policy,
        "exitCode": detail.exit_code,
        "env": detail.env,
        "mounts": detail.mounts,
        "networks": detail.networks,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 执行容器生命周期动作。
pub async fn container_action(
    args: Value,
    storage: Arc<Mutex<Storage>>,
) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let container_id = require_str(&args, "container_id")?;
    let action_str = require_str(&args, "action")?;
    let action = DockerContainerAction::parse(&action_str).ok_or_else(|| {
        format!(
            "未知 action: {action_str}（应为 start/stop/restart/kill/pause/unpause/remove）"
        )
    })?;

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let result = match target {
        DockerTarget::Local(adapter) => {
            with_timeout(adapter.container_action(&container_id, action), DOCKER_OP_TIMEOUT_SECS)
                .await
        }
        DockerTarget::Ssh(adapter, session) => {
            let r = with_timeout(adapter.container_action(&container_id, action), DOCKER_OP_TIMEOUT_SECS).await;
            session.disconnect().await;
            r
        }
        DockerTarget::OnePanel(adapter) => {
            with_timeout(adapter.container_action(&container_id, action), DOCKER_OP_TIMEOUT_SECS)
                .await
        }
    };

    result?;

    let is_destructive = action.is_destructive();
    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "containerId": container_id,
        "action": action_str,
        "applied": true,
        "note": if is_destructive {
            format!("已执行危险动作 {action_str}；该操作已被 audit log 记录")
        } else {
            format!("容器 {action_str} 操作已下发")
        },
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 在容器内执行非交互式命令。
///
/// - Local / Remote Engine: `LocalDockerAdapter::exec_one_shot`
/// - SSH: 直接在 SSH session 上 `docker exec <container> sh -c '...'`
/// - 1Panel: 不支持
pub async fn exec(args: Value, storage: Arc<Mutex<Storage>>) -> Result<String, String> {
    let connection_id = require_str(&args, "connection_id")?;
    let container_id = require_str(&args, "container_id")?;
    let command = require_str(&args, "command")?;

    // 简单 shell-injection 防护
    if command.contains("&&") || command.contains("||") || command.contains(';') {
        return Err("command 不支持复合命令（; / && / ||），请单条执行或写入脚本后调用".to_string());
    }

    let (conn_name, target) = resolve_target(storage, &connection_id).await?;

    let (stdout, stderr, exit_code) = match target {
        DockerTarget::Local(adapter) => {
            let cmd = vec!["sh".to_string(), "-c".to_string(), command.clone()];
            let out = with_timeout(adapter.exec_one_shot(&container_id, cmd), DOCKER_OP_TIMEOUT_SECS)
                .await?;
            (out.stdout, out.stderr, out.exit_code)
        }
        DockerTarget::Ssh(_adapter, session) => {
            // SSH 路径：直接走 docker exec CLI，不通过 SshDockerAdapter（adapter 未暴露 exec_one_shot）
            let docker_cmd = format!(
                "docker exec --tty=false {container_id} sh -c {cmd:?}",
                cmd = command
            );
            let output = match with_timeout(session.exec_capture(&docker_cmd), DOCKER_OP_TIMEOUT_SECS).await {
                Ok(o) => o,
                Err(e) => {
                    session.disconnect().await;
                    return Err(e);
                }
            };
            session.disconnect().await;
            (output.stdout, output.stderr, output.exit_code as i64)
        }
        DockerTarget::OnePanel(_) => {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "1Panel 连接暂不支持一次性 exec；请在宿主机 SSH 终端执行",
            )
            .user_message()
            .to_string());
        }
    };

    Ok(serde_json::to_string(&serde_json::json!({
        "connectionId": connection_id,
        "connectionName": conn_name,
        "containerId": container_id,
        "command": command,
        "stdout": stdout,
        "stderr": stderr,
        "exitCode": exit_code,
    }))
    .unwrap_or_else(|_| "{}".to_string()))
}

/// 包装 future 加超时，统一错误转换为 String。
async fn with_timeout<F, T>(fut: F, secs: u64) -> Result<T, String>
where
    F: std::future::Future<Output = Result<T, OmniError>>,
{
    tokio::time::timeout(Duration::from_secs(secs), fut)
        .await
        .map_err(|_| format!("Docker 操作超时（{secs}s）"))?
        .map_err(|e| e.user_message().to_string())
}
