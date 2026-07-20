//! Docker 命令桥接：exec
use super::*;

/// 一次性 exec 的结构化输出（与 `omnipanel_docker::DockerOneShotExecOutput` 对齐）。
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerExecOneShotOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i64,
}

/// 在容器内非交互式执行命令（一次性 capture stdout/stderr/exit_code）。
///
/// 与 `docker_create_exec_session` 区别：
/// - 后者创建交互式 PTY 会话（适合用户终端 attach）；
/// - 本命令一次性执行并返回结构化结果，适合 AI 工具调用、批处理脚本。
///
/// 实现路径：
/// - Local/Remote Engine：`LocalDockerAdapter::exec_one_shot`（bollard exec API，tty=false）；
/// - SSH：SSH session 上 `docker exec <container> <cmd>` via `exec_capture`；
/// - 1Panel：暂不支持（返回 InvalidInput 错误）。
#[tauri::command]
#[specta::specta]
pub async fn docker_exec_command(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    command: String,
) -> Result<DockerExecOneShotOutput, OmniError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(OmniError::new(ErrorCode::InvalidInput, "command 不能为空"));
    }
    // 简单 shell-injection 防护：禁止 ;、&&、||、`、$() 跨命令拼接。
    // 如需复杂脚本，建议 AI 在容器内先 `cat > /tmp/x.sh <<EOF ... EOF` 再 `sh /tmp/x.sh`。
    if trimmed.contains("&&") || trimmed.contains("||") || trimmed.contains(';') {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            "command 不支持复合命令（; / && / ||），请单条执行或写入脚本后调用",
        ));
    }

    let target = resolve_target(&state, &connection_id).await?;

    match target {
        DockerTarget::Local => {
            let local = LocalDockerAdapter::connect()?;
            let cmd = vec!["sh".to_string(), "-c".to_string(), trimmed.to_string()];
            let out = local.exec_one_shot(&container_id, cmd).await?;
            Ok(DockerExecOneShotOutput {
                stdout: out.stdout,
                stderr: out.stderr,
                exit_code: out.exit_code,
            })
        }
        DockerTarget::Remote(docker) => {
            let local = LocalDockerAdapter::with_docker(docker);
            let cmd = vec!["sh".to_string(), "-c".to_string(), trimmed.to_string()];
            let out = local.exec_one_shot(&container_id, cmd).await?;
            Ok(DockerExecOneShotOutput {
                stdout: out.stdout,
                stderr: out.stderr,
                exit_code: out.exit_code,
            })
        }
        DockerTarget::Ssh(session) => {
            // SSH 上 Docker：直接 `docker exec <container> sh -c '...'`
            let docker_cmd = format!(
                "docker exec --tty=false {container_id} sh -c {cmd:?}",
                cmd = trimmed
            );
            let output = session.exec_capture(&docker_cmd).await?;
            Ok(DockerExecOneShotOutput {
                stdout: output.stdout,
                stderr: output.stderr,
                exit_code: output.exit_code as i64,
            })
        }
        DockerTarget::OnePanel(_) => Err(OmniError::new(
            ErrorCode::InvalidInput,
            "1Panel 连接暂不支持一次性 exec；请在宿主机 SSH 终端执行",
        )),
    }
}

/// 在容器内创建交互式 exec 会话
pub(crate) async fn close_docker_exec_for_container(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
) {
    loop {
        let next = {
            let mut map = state.docker_exec_sessions.lock().await;
            let key = map
                .iter()
                .find(|(_, entry)| {
                    entry.connection_id == connection_id && entry.container_id == container_id
                })
                .map(|(id, _)| id.clone());
            key.and_then(|id| map.remove(&id))
        };
        match next {
            Some(entry) => drop(entry),
            None => break,
        }
    }
}

/// 本地 Docker 容器 exec：分配 PTY；SSH 引擎走远程 shell 通道
pub(crate) async fn close_docker_exec_for_connection(state: &AppState, connection_id: &str) {
    loop {
        let next = {
            let mut map = state.docker_exec_sessions.lock().await;
            let key = map
                .iter()
                .find(|(_, entry)| entry.connection_id == connection_id)
                .map(|(id, _)| id.clone());
            key.and_then(|id| map.remove(&id))
        };
        match next {
            Some(entry) => drop(entry),
            None => break,
        }
    }
}

pub(crate) fn exec_shell_candidates(requested: Option<String>, image: Option<&str>) -> Vec<String> {
    if let Some(s) = requested.filter(|s| !s.trim().is_empty()) {
        return vec![s.trim().to_string()];
    }
    let image_lower = image.unwrap_or("").to_lowercase();
    let mut shells = vec!["/bin/sh".to_string(), "sh".to_string()];
    if image_lower.contains("alpine") || image_lower.contains("busybox") {
        shells.extend(["/bin/ash", "ash"].map(str::to_string));
    }
    shells.extend(["/bin/bash", "bash"].map(str::to_string));
    shells
}

pub(crate) fn is_exec_shell_missing_text(text: &str) -> bool {
    let msg = text.to_lowercase();
    msg.contains("executable file not found")
        || msg.contains("no such file or directory")
        || msg.contains(": not found")
        || (msg.contains("oci runtime exec failed")
            && (msg.contains("not found") || msg.contains("stat /bin/")))
}

pub(crate) fn is_exec_shell_missing(err: &OmniError) -> bool {
    is_exec_shell_missing_text(&format!(
        "{}{}",
        err.message,
        err.cause.as_deref().unwrap_or("")
    ))
}

pub(crate) fn prepend_exec_output(
    first: Vec<u8>,
    rest: omnipanel_docker::DockerExecOutput,
) -> omnipanel_docker::DockerExecOutput {
    Box::pin(futures::stream::once(async move { Ok(first) }).chain(rest))
}

pub(crate) async fn close_exec_session(session: omnipanel_docker::DockerExecSession) {
    let _ = session.close().await;
}

/// 创建 exec 并窥探首包输出：Docker API 可能在 shell 不存在时仍返回 Attached，
/// 实际 OCI 错误会写入终端流，需在此检测并触发 shell 回退。
pub(crate) async fn create_exec_with_shell_probe(
    target: &DockerTarget,
    container_id: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> Result<
    (
        omnipanel_docker::DockerExecSession,
        omnipanel_docker::DockerExecOutput,
    ),
    OmniError,
> {
    let (session, mut output) = create_exec_for_target(target, container_id, shell, cols, rows).await?;

    let peek = tokio::time::timeout(
        std::time::Duration::from_millis(1200),
        output.next(),
    )
    .await;

    match peek {
        Ok(Some(Ok(bytes))) if is_exec_shell_missing_text(&String::from_utf8_lossy(&bytes)) => {
            close_exec_session(session).await;
            Err(OmniError::new(
                ErrorCode::Internal,
                format!("容器内不存在 shell：{shell}"),
            )
            .with_cause(String::from_utf8_lossy(&bytes).into_owned()))
        }
        Ok(Some(Ok(bytes))) => Ok((session, prepend_exec_output(bytes, output))),
        Ok(Some(Err(err))) => {
            close_exec_session(session).await;
            Err(err)
        }
        Ok(None) | Err(_) => Ok((session, output)),
    }
}

pub(crate) async fn resolve_exec_shells(
    state: &AppState,
    connection_id: &str,
    container_id: &str,
    shell: Option<String>,
) -> Result<Vec<String>, OmniError> {
    if shell.as_ref().is_some_and(|s| !s.trim().is_empty()) {
        return Ok(vec![shell.unwrap().trim().to_string()]);
    }
    let image = match resolve_adapter(state, connection_id).await {
        Ok(adapter) => adapter
            .inspect_container(container_id)
            .await
            .ok()
            .map(|d| d.summary.image),
        Err(_) => None,
    };
    Ok(exec_shell_candidates(None, image.as_deref()))
}

pub(crate) async fn create_exec_for_target(
    target: &DockerTarget,
    container_id: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> Result<
    (
        omnipanel_docker::DockerExecSession,
        omnipanel_docker::DockerExecOutput,
    ),
    OmniError,
> {
    match target {
        DockerTarget::Local => {
            let adapter = LocalDockerAdapter::connect()?;
            adapter
                .create_exec(container_id, vec![shell.to_string()], cols, rows)
                .await
        }
        DockerTarget::Remote(docker) => {
            let adapter = LocalDockerAdapter::with_docker(docker.clone());
            adapter
                .create_exec(container_id, vec![shell.to_string()], cols, rows)
                .await
        }
        DockerTarget::Ssh(ssh_session) => {
            omnipanel_docker::ssh::create_exec(ssh_session, container_id, shell, cols, rows).await
        }
        DockerTarget::OnePanel(adapter) => {
            adapter
                .create_container_exec(container_id, shell, cols, rows)
                .await
        }
    }
}

/// Create container interactive terminal session. Returns sessionId;
/// output is emitted via `terminal-output` events for xterm binding.
#[tauri::command]
#[specta::specta]
pub async fn docker_create_exec_session(
    state: State<'_, AppState>,
    connection_id: String,
    container_id: String,
    shell: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, OmniError> {
    let shells = resolve_exec_shells(&state, &connection_id, &container_id, shell).await?;
    close_docker_exec_for_container(&state, &connection_id, &container_id).await;
    let mut exec_pair: Option<(omnipanel_docker::DockerExecSession, _)> = None;
    let mut last_err: Option<OmniError> = None;

    'attempts: for attempt in 0..2 {
        let target = resolve_target(&state, &connection_id).await?;
        for shell_str in &shells {
            match tokio::time::timeout(
                std::time::Duration::from_secs(10),
                create_exec_with_shell_probe(&target, &container_id, shell_str, cols, rows),
            )
            .await
            {
                Err(_) => {
                    last_err = Some(OmniError::new(
                        ErrorCode::Ssh,
                        format!("进入容器终端超时：{shell_str}"),
                    ));
                    continue;
                }
                Ok(result) => match result {
                    Ok(pair) => {
                        exec_pair = Some(pair);
                        break 'attempts;
                    }
                    Err(err) if is_exec_shell_missing(&err) => {
                        last_err = Some(err);
                        continue;
                    }
                    Err(err) if attempt == 0 && is_ssh_session_recoverable(&err) => {
                        invalidate_docker_ssh(&state, &connection_id).await;
                        last_err = Some(err);
                        break;
                    }
                    Err(err) => return Err(err),
                },
            }
        }
        if exec_pair.is_some() {
            break;
        }
    }

    let (session, mut output) = exec_pair.ok_or_else(|| {
        last_err
            .unwrap_or_else(|| OmniError::new(ErrorCode::Ssh, "无法在容器内启动交互 shell，请尝试 bash/sh"))
    })?;

    let session_id = format!(
        "docker-exec-{}",
        EXEC_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    state.docker_exec_sessions.lock().await.insert(
        session_id.clone(),
        DockerExecSessionEntry {
            session,
            connection_id: connection_id.clone(),
            container_id: container_id.clone(),
        },
    );

    let app = state.app_handle.clone();
    let sid = session_id.clone();
    let sessions = state.docker_exec_sessions.clone();
    tokio::spawn(async move {
        while let Some(item) = output.next().await {
            match item {
                Ok(bytes) => {
                    let _ = app.emit(
                        "terminal-output",
                        serde_json::json!({ "session_id": sid, "data": STANDARD.encode(&bytes) }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(
            "terminal-event",
            serde_json::json!({ "session_id": sid, "event": "exited" }),
        );
        if let Some(entry) = sessions.lock().await.remove(&sid) {
            drop(entry);
        }
    });

    Ok(session_id)
}

/// 宿主机交互终端会话 id 标记（复用 docker_exec_* write/resize/close）。
const HOST_SHELL_SESSION_MARKER: &str = "__host__";

/// 在 Docker 连接对应的宿主机上打开交互 shell（SSH / 1Panel；本地 Engine 走本机终端）。
#[tauri::command]
#[specta::specta]
pub async fn docker_create_host_shell_session(
    state: State<'_, AppState>,
    connection_id: String,
    cols: u16,
    rows: u16,
) -> Result<String, OmniError> {
    close_docker_exec_for_container(&state, &connection_id, HOST_SHELL_SESSION_MARKER).await;

    let mut exec_pair: Option<(omnipanel_docker::DockerExecSession, _)> = None;
    let mut last_err: Option<OmniError> = None;

    for attempt in 0..2 {
        let target = resolve_target(&state, &connection_id).await?;
        let result = match &target {
            DockerTarget::Ssh(ssh_session) => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    omnipanel_docker::ssh::create_host_shell(ssh_session, cols, rows),
                )
                .await
            }
            DockerTarget::Local | DockerTarget::Remote(_) => {
                return Err(OmniError::new(
                    ErrorCode::InvalidInput,
                    "本地 / 远程 Engine 连接请使用本机终端；宿主机 Docker shell 仅支持 SSH / 1Panel",
                ));
            }
            DockerTarget::OnePanel(adapter) => {
                tokio::time::timeout(
                    std::time::Duration::from_secs(15),
                    adapter.create_host_shell(cols, rows),
                )
                .await
            }
        };

        match result {
            Err(_) => {
                last_err = Some(OmniError::new(ErrorCode::Ssh, "打开宿主机终端超时"));
            }
            Ok(Ok(pair)) => {
                exec_pair = Some(pair);
                break;
            }
            Ok(Err(err)) if attempt == 0 && is_ssh_session_recoverable(&err) => {
                invalidate_docker_ssh(&state, &connection_id).await;
                last_err = Some(err);
            }
            Ok(Err(err)) => return Err(err),
        }
    }

    let (session, mut output) = exec_pair.ok_or_else(|| {
        last_err.unwrap_or_else(|| OmniError::new(ErrorCode::Ssh, "无法打开宿主机交互 shell"))
    })?;

    let session_id = format!(
        "docker-host-{}",
        EXEC_SESSION_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    state.docker_exec_sessions.lock().await.insert(
        session_id.clone(),
        DockerExecSessionEntry {
            session,
            connection_id: connection_id.clone(),
            container_id: HOST_SHELL_SESSION_MARKER.to_string(),
        },
    );

    let app = state.app_handle.clone();
    let sid = session_id.clone();
    let sessions = state.docker_exec_sessions.clone();
    tokio::spawn(async move {
        while let Some(item) = output.next().await {
            match item {
                Ok(bytes) => {
                    let _ = app.emit(
                        "terminal-output",
                        serde_json::json!({
                            "session_id": sid,
                            "data": STANDARD.encode(bytes),
                        }),
                    );
                }
                Err(_) => break,
            }
        }
        let _ = app.emit(
            "terminal-event",
            serde_json::json!({ "session_id": sid, "event": "exited" }),
        );
        if let Some(entry) = sessions.lock().await.remove(&sid) {
            drop(entry);
        }
    });

    Ok(session_id)
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_exec_write(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), OmniError> {
    let sessions = state.docker_exec_sessions.lock().await;
    let entry = sessions
        .get(&session_id)
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, format!("容器终端会话 {session_id} 不存在")))?;
    entry.session.write(&data).await
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_exec_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), OmniError> {
    let sessions = state.docker_exec_sessions.lock().await;
    if let Some(entry) = sessions.get(&session_id) {
        entry.session.resize(cols, rows).await?;
    }
    Ok(())
}

/// 卷详情（`docker volume inspect`）。
#[tauri::command]
#[specta::specta]
pub async fn docker_exec_close(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), OmniError> {
    if let Some(entry) = state.docker_exec_sessions.lock().await.remove(&session_id) {
        drop(entry);
    }
    Ok(())
}
