//! Docker 命令桥接：ssh_detect
use super::*;

/// Probe a remote SSH host for Docker daemon availability.
/// Returns Docker version info if found, or an error if Docker is not installed/running.
#[tauri::command]
#[specta::specta]
pub async fn docker_probe_ssh_docker(
    state: State<'_, AppState>,
    ssh_connection_id: String,
) -> Result<DockerAutoDetectResult, OmniError> {
    let session = state.ssh_pool.ensure_session(&ssh_connection_id).await?;
    Ok(probe_ssh_docker_session(&session).await)
}

/// Docker auto-detection result.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerAutoDetectResult {
    pub available: bool,
    pub version: Option<String>,
    pub os: Option<String>,
    pub containers: u32,
    pub images: u32,
    pub error: Option<String>,
}

/// List SSH connections available for Docker binding.
/// Returns connections that are in "connected" state in the SSH pool.
#[tauri::command]
#[specta::specta]
pub async fn docker_list_ssh_hosts(
    state: State<'_, AppState>,
) -> Result<Vec<SshHostInfo>, OmniError> {
    let connected_ids = state.ssh_pool.connected_ids().await;
    let storage = state.storage.lock().await;
    let mut hosts = Vec::new();

    for id in connected_ids {
        if let Ok(Some(conn)) = storage.get_connection(&id) {
            if let Ok(config) = serde_json::from_str::<omnipanel_ssh::SshConfig>(&conn.config) {
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

/// SSH host info for Docker connection binding.
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SshHostInfo {
    pub connection_id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

/// 通过 SSH 探测 Docker 是否可用
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerScanItemResult {
    pub ssh_connection_id: String,
    pub ssh_name: String,
    pub available: bool,
    pub probe: Option<DockerAutoDetectResult>,
    pub docker_connection_id: Option<String>,
    /// created | updated | unchanged | no_docker | failed
    pub action: String,
    pub error: Option<String>,
}

/// 自动探测并绑定 SSH 上的 Docker 引擎
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
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

pub(crate) fn find_docker_by_bound_ssh(
    connections: &[omnipanel_store::Connection],
    ssh_id: &str,
) -> Option<omnipanel_store::Connection> {
    connections
        .iter()
        .find(|conn| {
            let cfg: DockerConnectionConfig =
                serde_json::from_str(&conn.config).unwrap_or_default();
            cfg.bound_ssh_connection_id.as_deref() == Some(ssh_id)
        })
        .cloned()
}

pub(crate) fn build_ssh_engine_config_json(ssh_id: &str, ssh: &SshConfig) -> String {
    serde_json::json!({
        "source": "ssh-engine",
        "host": format!("{}@{}:{}", ssh.user, ssh.host, ssh.port),
        "boundSshConnectionId": ssh_id,
        "autoScanned": true,
        "ssh": ssh,
    })
    .to_string()
}

pub(crate) async fn probe_ssh_docker_session(session: &SshSession) -> DockerAutoDetectResult {
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
            error: Some(format!("Docker not available: {}", e)),
        },
    }
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_scan_ssh_docker_hosts(
    state: State<'_, AppState>,
    auto_save: bool,
) -> Result<DockerScanResult, OmniError> {
    let ssh_connections = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(omnipanel_store::ConnectionKind::Ssh)?
    };

    let existing_docker = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(omnipanel_store::ConnectionKind::Docker)?
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
        let ssh_config: SshConfig = match serde_json::from_str(&ssh_conn.config) {
            Ok(cfg) => cfg,
            Err(e) => {
                result.failed += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id.clone(),
                    ssh_name: ssh_conn.name.clone(),
                    available: false,
                    probe: None,
                    docker_connection_id: None,
                    action: "failed".to_string(),
                    error: Some(format!("SSH 连接失败: {e}")),
                });
                continue;
            }
        };

        let session = match state.ssh_pool.ensure_session(&ssh_conn.id).await {
            Ok(s) => s,
            Err(e) => {
                result.failed += 1;
                result.items.push(DockerScanItemResult {
                    ssh_connection_id: ssh_conn.id.clone(),
                    ssh_name: ssh_conn.name.clone(),
                    available: false,
                    probe: None,
                    docker_connection_id: None,
                    action: "failed".to_string(),
                    error: Some(e.to_string()),
                });
                continue;
            }
        };

        let probe = probe_ssh_docker_session(&session).await;
        if !probe.available {
            result.no_docker += 1;
            result.items.push(DockerScanItemResult {
                ssh_connection_id: ssh_conn.id.clone(),
                ssh_name: ssh_conn.name.clone(),
                available: false,
                probe: Some(probe),
                docker_connection_id: None,
                action: "no_docker".to_string(),
                error: None,
            });
            continue;
        }

        let mut action = "unchanged".to_string();
        let mut docker_connection_id: Option<String> = None;
        let mut error: Option<String> = None;

        if auto_save {
            let config_json = build_ssh_engine_config_json(&ssh_conn.id, &ssh_config);
            let existing = find_docker_by_bound_ssh(&existing_docker, &ssh_conn.id);
            let docker_name = format!("Docker - {}", ssh_conn.name);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or_default();

            let docker_conn = if let Some(existing) = existing {
                let mut conn = existing;
                if conn.config != config_json
                    || conn.name != docker_name
                    || conn.group != ssh_conn.group
                    || conn.env_tag != ssh_conn.env_tag
                {
                    conn.config = config_json;
                    conn.name = docker_name;
                    conn.group = ssh_conn.group.clone();
                    conn.env_tag = ssh_conn.env_tag.clone();
                    conn.updated_at = now;
                    action = "updated".to_string();
                } else {
                    action = "unchanged".to_string();
                }
                conn
            } else {
                action = "created".to_string();
                omnipanel_store::Connection {
                    id: format!("docker-bound-{}", ssh_conn.id),
                    kind: omnipanel_store::ConnectionKind::Docker,
                    name: docker_name,
                    group: ssh_conn.group.clone(),
                    env_tag: ssh_conn.env_tag.clone(),
                    tags: vec![],
                    config: config_json,
                    credential_ref: None,
                    created_at: now,
                    updated_at: now,
                }
            };

            docker_connection_id = Some(docker_conn.id.clone());
            match {
                let storage = state.storage.lock().await;
                storage.save_connection(&docker_conn)
            } {
                Ok(_) => match action.as_str() {
                    "created" => result.created += 1,
                    "updated" => result.updated += 1,
                    _ => result.unchanged += 1,
                },
                Err(e) => {
                    result.failed += 1;
                    action = "failed".to_string();
                    error = Some(e.to_string());
                }
            }
        } else {
            result.unchanged += 1;
        }

        result.items.push(DockerScanItemResult {
            ssh_connection_id: ssh_conn.id,
            ssh_name: ssh_conn.name,
            available: true,
            probe: Some(probe),
            docker_connection_id,
            action,
            error,
        });
    }

    Ok(result)
}
