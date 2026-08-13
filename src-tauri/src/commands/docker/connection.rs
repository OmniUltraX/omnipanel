//! Docker 命令桥接：connection
use super::*;
use futures::future::join_all;
use std::time::Duration;

/// 列表探测超时：避免单个不可达主机拖死侧栏加载。
const LIST_PROBE_TIMEOUT: Duration = Duration::from_secs(8);

/// 编辑 Docker 连接表单：从 Vault 取回面板 API Key（列表 / config 永不存明文）。
#[tauri::command]
#[specta::specta]
pub async fn docker_get_connection_secret(
    state: State<'_, AppState>,
    id: String,
) -> Result<String, OmniError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(OmniError::invalid_input("连接 id 为空"));
    }
    let conn = {
        let storage = state.storage.lock().await;
        storage.get_connection(id)?
    }
    .ok_or_else(|| OmniError::not_found(format!("Docker 连接 {id} 不存在")))?;

    if !matches!(conn.kind, omnipanel_store::ConnectionKind::Docker) {
        return Err(OmniError::invalid_input("连接不是 Docker 类型"));
    }

    let cfg: DockerConnectionConfig = serde_json::from_str(&conn.config).unwrap_or_default();
    let source = cfg
        .source
        .as_deref()
        .map(DockerConnectionSource::parse)
        .unwrap_or(DockerConnectionSource::LocalEngine);

    let vault_key = match source {
        DockerConnectionSource::OnePanel => format!("docker-onepanel-{id}"),
        DockerConnectionSource::PanelAdapter => format!("docker-btpanel-{id}"),
        _ => {
            return Err(OmniError::invalid_input(
                "仅 1Panel / 宝塔连接支持回显 API Key",
            ));
        }
    };

    if let Ok(key) = Vault::get(&vault_key) {
        let key = key.trim();
        if !key.is_empty() {
            return Ok(key.to_string());
        }
    }
    // 仅接受面板 API Key 引用；勿回退到 docker-ssh-password（会把 SSH 密码当成 API Key）
    if let Some(r) = conn.credential_ref.as_deref() {
        if r == vault_key || r.starts_with("docker-btpanel-") || r.starts_with("docker-onepanel-")
        {
            if let Ok(key) = Vault::get(r) {
                let key = key.trim();
                if !key.is_empty() {
                    return Ok(key.to_string());
                }
            }
        }
    }
    Ok(String::new())
}

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
            .or_else(|| cfg.btpanel.as_ref().map(|p| p.base_url.clone()))
            .unwrap_or_else(|| conn.name.clone());
        let warning_message = match source {
            DockerConnectionSource::OnePanel => {
                Some("1Panel 面板模式：容器 / 镜像 exec / 镜像 push-pull / build".to_string())
            }
            DockerConnectionSource::PanelAdapter => {
                Some("宝塔面板模式：容器列表与启停 / 镜像 / 网络 / 卷 / Compose 项目".to_string())
            }
            _ => None,
        };
        out.push(DockerConnectionInfo {
            connection_id: conn.id,
            name: conn.name,
            source,
            // 占位；下方并行 probe 回填真实状态
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

    // 并行探测各实例，回填 status / 版本信息（侧栏 topbar-tab-dot 依赖此字段）
    // 注意：此处不走 with_adapter 重试——宝塔鉴权失败再打会加速封禁
    let probe_results = join_all(out.iter().map(|info| {
        let connection_id = info.connection_id.clone();
        async {
            let probed = tokio::time::timeout(LIST_PROBE_TIMEOUT, async {
                let adapter = resolve_adapter(&state, &connection_id).await?;
                adapter.probe().await
            })
            .await;
            match probed {
                Ok(Ok(probe)) => Some((connection_id, probe)),
                Ok(Err(_)) | Err(_) => None,
            }
        }
    }))
    .await;

    for (connection_id, probe) in probe_results.into_iter().flatten() {
        let Some(info) = out
            .iter_mut()
            .find(|item| item.connection_id == connection_id)
        else {
            continue;
        };
        info.status = probe.status;
        if info.engine_version.is_none() {
            info.engine_version = probe.engine_version;
        }
        if info.api_version.is_none() {
            info.api_version = probe.api_version;
        }
        if info.warning_message.is_none() {
            info.warning_message = probe.warning_message;
        }
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
