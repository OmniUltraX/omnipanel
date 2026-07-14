//! Docker 命令桥接：connection
use super::*;

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_list_connections(
    state: State<'_, AppState>,
) -> Result<Vec<DockerConnectionInfo>, OmniError> {
    let mut out = Vec::new();

    let local_status = local_engine_status().await;
    if local_status.installed {
        out.push(DockerConnectionInfo {
            connection_id: LOCAL_CONNECTION_ID.to_string(),
            name: "本地 Docker".to_string(),
            source: DockerConnectionSource::LocalEngine,
            status: if local_status.running {
                DockerConnectionStatus::Online
            } else {
                DockerConnectionStatus::Offline
            },
            host_label: "本地 Engine".to_string(),
            environment: "local".to_string(),
            engine_version: None,
            api_version: None,
            containers_running: 0,
            containers_total: 0,
            warning_message: None,
            bound_ssh_connection_id: None,
        });
    }

    let stored = {
        let storage = state.storage.lock().await;
        storage.list_connections_by_kind(omnipanel_store::ConnectionKind::Docker)?
    };

    for conn in stored {
        let cfg: DockerConnectionConfig = serde_json::from_str(&conn.config).unwrap_or_default();
        let source = cfg
            .source
            .as_deref()
            .map(DockerConnectionSource::parse)
            .unwrap_or(DockerConnectionSource::LocalEngine);
        let host_label = cfg
            .host
            .or_else(|| cfg.ssh.as_ref().map(|s| format!("{}@{}", s.user, s.host)))
            .or_else(|| cfg.onepanel.as_ref().map(|p| p.base_url.clone()))
            .unwrap_or_else(|| conn.name.clone());
        let warning_message = match source {
            DockerConnectionSource::OnePanel => {
                Some("1Panel 面板模式：容器 / 镜像 exec / 镜像 push-pull / build".to_string())
            }
            _ => None,
        };
        out.push(DockerConnectionInfo {
            connection_id: conn.id,
            name: conn.name,
            source,
            status: DockerConnectionStatus::Offline,
            host_label,
            environment: conn.env_tag,
            engine_version: None,
            api_version: None,
            containers_running: 0,
            containers_total: 0,
            warning_message,
            bound_ssh_connection_id: cfg.bound_ssh_connection_id,
        });
    }

    Ok(out)
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_probe_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerProbe, OmniError> {
    with_adapter(&state, &connection_id, |a| async move { a.probe().await }).await
}

#[tauri::command]
#[specta::specta]
pub async fn docker_reset_ssh_session(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), OmniError> {
    close_docker_exec_for_connection(&state, &connection_id).await;
    invalidate_docker_ssh(&state, &connection_id).await;
    Ok(())
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_get_local_engine_status() -> Result<DockerLocalEngineStatus, OmniError> {
    Ok(local_engine_status().await)
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_start_local_engine() -> Result<(), OmniError> {
    start_local_engine()
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_get_overview(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerOverview, OmniError> {
    with_adapter(
        &state,
        &connection_id,
        |a| async move { a.overview().await },
    )
    .await
}

pub(crate) async fn connection_is_remote_engine(
    state: &AppState,
    connection_id: &str,
) -> Result<bool, OmniError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Ok(false);
    }
    let conn = {
        let storage = state.storage.lock().await;
        storage.get_connection(connection_id)?
    }
    .ok_or_else(|| {
        OmniError::new(
            ErrorCode::NotFound,
            format!("Docker 连接 {connection_id} 不存在"),
        )
    })?;
    let cfg: DockerConnectionConfig = serde_json::from_str(&conn.config).unwrap_or_default();
    Ok(
        cfg.source
            .as_deref()
            .map(DockerConnectionSource::parse)
            == Some(DockerConnectionSource::RemoteEngine),
    )
}

/// 读取 Docker daemon.json 配置。
#[tauri::command]
#[specta::specta]
pub async fn docker_read_daemon_config(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerDaemonConfigFile, OmniError> {
    if connection_is_remote_engine(&state, &connection_id).await? {
        return Ok(remote_engine_daemon_config());
    }
    resolve_adapter(&state, &connection_id)
        .await?
        .read_daemon_config()
        .await
}

/// 写入 Docker daemon.json 配置。
#[tauri::command]
#[specta::specta]
pub async fn docker_write_daemon_config(
    state: State<'_, AppState>,
    connection_id: String,
    content: String,
) -> Result<(), OmniError> {
    if connection_is_remote_engine(&state, &connection_id).await? {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "远程 Engine 连接不支持编辑 daemon.json",
        ));
    }
    resolve_adapter(&state, &connection_id)
        .await?
        .write_daemon_config(&content)
        .await
}

/// 重启 Docker 守护进程 / 服务。
#[tauri::command]
#[specta::specta]
pub async fn docker_restart_daemon(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<(), OmniError> {
    if connection_is_remote_engine(&state, &connection_id).await? {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "远程 Engine 连接不支持重启 Docker 服务",
        ));
    }
    if connection_id == LOCAL_CONNECTION_ID {
        return restart_local_engine();
    }
    resolve_adapter(&state, &connection_id)
        .await?
        .restart_docker_daemon()
        .await
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_get_system_disk_usage(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<DockerSystemDiskUsage, OmniError> {
    resolve_adapter(&state, &connection_id)
        .await?
        .system_disk_usage()
        .await
}
