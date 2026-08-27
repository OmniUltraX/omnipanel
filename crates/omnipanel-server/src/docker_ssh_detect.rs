//! Docker SSH 宿主机探测 / 扫描（自桌面端 docker/ssh_detect.rs 移植）。

use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::SshConfig;
use omnipanel_store::ConnectionKind;
use serde::{Deserialize, Serialize};

use crate::monitoring::ensure_ssh_session;
use crate::state::resolve_ssh_config;
use crate::terminal::ServerState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerAutoDetectResult {
    pub available: bool,
    pub version: Option<String>,
    pub os: Option<String>,
    pub containers: u32,
    pub images: u32,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostInfo {
    pub connection_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerScanItemResult {
    pub ssh_connection_id: String,
    pub ssh_name: String,
    pub available: bool,
    pub probe: Option<DockerAutoDetectResult>,
    pub docker_connection_id: Option<String>,
    pub action: String,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerScanResult {
    pub scanned: u32,
    pub created: u32,
    pub updated: u32,
    pub unchanged: u32,
    pub no_docker: u32,
    pub failed: u32,
    pub items: Vec<DockerScanItemResult>,
}

async fn probe_ssh_docker_session(session: &omnipanel_ssh::SshSession) -> DockerAutoDetectResult {
    let version_output = session
        .exec_command("docker version --format '{{.Server.Version}}' 2>/dev/null")
        .await;
    let info_output = session
        .exec_command(
            "docker info --format '{{.OperatingSystem}}|{{.ServerVersion}}|{{.Containers}}|{{.Images}}' 2>/dev/null",
        )
        .await;

    match (version_output, info_output) {
        (Ok(version), Ok(info)) => {
            let parts: Vec<&str> = info.split('|').collect();
            DockerAutoDetectResult {
                available: true,
                version: Some(version.trim().to_string()),
                os: parts.first().map(|s| s.to_string()),
                containers: parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0),
                images: parts.get(3).and_then(|s| s.parse().ok()).unwrap_or(0),
                error: None,
            }
        }
        (_, Err(e)) | (Err(e), _) => DockerAutoDetectResult {
            available: false,
            version: None,
            os: None,
            containers: 0,
            images: 0,
            error: Some(format!("Docker not available: {e}")),
        },
    }
}

pub async fn docker_probe_ssh_docker(
    state: &ServerState,
    ssh_connection_id: String,
) -> OmniResult<DockerAutoDetectResult> {
    let (session, _) = ensure_ssh_session(state, &ssh_connection_id).await?;
    Ok(probe_ssh_docker_session(&session).await)
}

pub async fn docker_list_ssh_hosts(state: &ServerState) -> OmniResult<Vec<SshHostInfo>> {
    let active = crate::ssh_ops::ssh_pool_get_active_sessions(state).await?;
    let storage = state.storage.lock().await;
    let mut hosts = Vec::new();
    for id in active {
        if let Ok(Some(conn)) = storage.get_connection(&id) {
            if let Ok(config) = serde_json::from_str::<SshConfig>(&conn.config) {
                hosts.push(SshHostInfo {
                    connection_id: conn.id,
                    name: conn.name,
                    host: config.host,
                    port: config.port,
                    user: config.user,
                });
            }
        }
    }
    Ok(hosts)
}

fn find_docker_by_bound_ssh(
    connections: &[omnipanel_store::Connection],
    ssh_id: &str,
) -> Option<omnipanel_store::Connection> {
    connections
        .iter()
        .find(|conn| {
            let cfg: serde_json::Value = serde_json::from_str(&conn.config).unwrap_or_default();
            cfg.get("boundSshConnectionId").and_then(|v| v.as_str()) == Some(ssh_id)
        })
        .cloned()
}

pub async fn docker_scan_ssh_docker_hosts(
    state: &ServerState,
    auto_save: bool,
) -> OmniResult<DockerScanResult> {
    let ssh_connections = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(ConnectionKind::Ssh)?
    };
    let existing_docker = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(ConnectionKind::Docker)?
    };

    let mut result = DockerScanResult {
        scanned: ssh_connections.len() as u32,
        created: 0,
        updated: 0,
        unchanged: 0,
        no_docker: 0,
        failed: 0,
        items: Vec::new(),
    };

    for ssh_conn in ssh_connections {
        let ssh_config = match resolve_ssh_config(&ssh_conn) {
            Ok(c) => c,
            Err(e) => {
                result.failed += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id.clone(),
                    ssh_name: ssh_conn.name.clone(),
                    available: false,
                    probe: None,
                    docker_connection_id: None,
                    action: "failed".into(),
                    error: Some(e.to_string()),
                });
                continue;
            }
        };

        let probe = match ensure_ssh_session(state, &ssh_conn.id).await {
            Ok((session, _)) => probe_ssh_docker_session(&session).await,
            Err(e) => {
                result.failed += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id.clone(),
                    ssh_name: ssh_conn.name.clone(),
                    available: false,
                    probe: None,
                    docker_connection_id: None,
                    action: "failed".into(),
                    error: Some(e.to_string()),
                });
                continue;
            }
        };

        if !probe.available {
            result.no_docker += 1;
            result.items.push(DockerScanItemResult {
                ssh_connection_id: ssh_conn.id.clone(),
                ssh_name: ssh_conn.name.clone(),
                available: false,
                probe: Some(probe),
                docker_connection_id: None,
                action: "no_docker".into(),
                error: None,
            });
            continue;
        }

        let existing = find_docker_by_bound_ssh(&existing_docker, &ssh_conn.id);
        if let Some(existing) = existing {
            result.unchanged += 1;
            result.items.push(DockerScanItemResult {
                ssh_connection_id: ssh_conn.id.clone(),
                ssh_name: ssh_conn.name.clone(),
                available: true,
                probe: Some(probe),
                docker_connection_id: Some(existing.id),
                action: "unchanged".into(),
                error: None,
            });
            continue;
        }

        if !auto_save {
            result.items.push(DockerScanItemResult {
                ssh_connection_id: ssh_conn.id.clone(),
                ssh_name: ssh_conn.name.clone(),
                available: true,
                probe: Some(probe),
                docker_connection_id: None,
                action: "unchanged".into(),
                error: None,
            });
            continue;
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let id = format!("docker-bound-{}", ssh_conn.id);
        let config = serde_json::json!({
            "source": "ssh-engine",
            "host": format!("{}@{}:{}", ssh_config.user, ssh_config.host, ssh_config.port),
            "boundSshConnectionId": ssh_conn.id,
            "autoScanned": true,
            "ssh": ssh_config,
        })
        .to_string();

        let conn = omnipanel_store::Connection {
            id: id.clone(),
            kind: ConnectionKind::Docker,
            name: format!("Docker - {}", ssh_conn.name),
            group: ssh_conn.group.clone(),
            env_tag: ssh_conn.env_tag.clone(),
            tags: vec![],
            config,
            credential_ref: None,
            created_at: now,
            updated_at: now,
        };

        match state.storage.lock().await.save_connection(&conn) {
            Ok(()) => {
                result.created += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id,
                    ssh_name: ssh_conn.name,
                    available: true,
                    probe: Some(probe),
                    docker_connection_id: Some(id),
                    action: "created".into(),
                    error: None,
                });
            }
            Err(e) => {
                result.failed += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id,
                    ssh_name: ssh_conn.name,
                    available: true,
                    probe: Some(probe),
                    docker_connection_id: None,
                    action: "failed".into(),
                    error: Some(e.to_string()),
                });
            }
        }
    }

    Ok(result)
}

/// DNS 解析主机名（无持久缓存版）。
pub async fn resolve_host(host: String) -> OmniResult<Vec<String>> {
    use std::net::ToSocketAddrs;

    let trimmed = host.trim().to_lowercase();
    if trimmed.is_empty() {
        return Err(OmniError::invalid_input("host 为空"));
    }

    let is_ip = trimmed
        .chars()
        .all(|c| c.is_ascii_digit() || c == '.' || c == ':');
    if is_ip {
        return Ok(vec![trimmed]);
    }

    let addrs: Vec<String> = tokio::task::spawn_blocking({
        let host = trimmed.clone();
        move || {
            (host.as_str(), 0)
                .to_socket_addrs()
                .ok()
                .into_iter()
                .flatten()
                .map(|sa| sa.ip().to_string())
                .collect::<Vec<_>>()
        }
    })
    .await
    .map_err(|e| OmniError::new(ErrorCode::Internal, format!("DNS 解析任务失败: {e}")))?;

    if addrs.is_empty() {
        return Err(OmniError::new(
            ErrorCode::NotFound,
            format!("无法解析主机: {trimmed}"),
        ));
    }
    Ok(addrs)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub enabled: bool,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
}

pub async fn get_proxy_config() -> OmniResult<ProxyConfig> {
    Ok(ProxyConfig {
        enabled: false,
        protocol: "http".into(),
        host: String::new(),
        port: 0,
        username: String::new(),
        password: String::new(),
    })
}
