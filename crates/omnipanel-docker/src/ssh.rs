//! SSH 宿主机 Docker 适配器：复用现有 [`SshSession`]，读数据走 `curl --unix-socket /var/run/docker.sock`，
//! 写操作与 exec/流式日志等仍调用远端 `docker` CLI。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use async_trait::async_trait;
use futures::Stream;
use omnipanel_error::{ErrorCode, OmniError, OmniResult};
use omnipanel_ssh::{SshPtySession, SshSession, SshStreamHandle, StreamChunk};
use tokio::sync::mpsc;

use crate::compose::{ComposeContainerRow, aggregate_compose};
use crate::local::{map_system_data_usage, to_container_detail, to_container_summary, to_image_summaries};
use crate::local::{DockerExecOutput, DockerExecSession};
use crate::model::*;
use crate::ssh_docker_api::{classify_docker_api_error, url_path_segment, SshDockerApi};
use crate::{ContainerFilter, DockerAdapter};

/// SSH 宿主机 Docker 适配器：持有一个可复用的 `SshSession`（由命令层缓存于会话池），
/// 每次操作在独立 exec channel 上调用远端 `docker` CLI。
pub struct SshDockerAdapter {
    session: Arc<SshSession>,
}

impl SshDockerAdapter {
    pub fn new(session: Arc<SshSession>) -> Self {
        Self { session }
    }
}

#[async_trait]
impl DockerAdapter for SshDockerAdapter {
    async fn probe(&self) -> OmniResult<DockerProbe> {
        probe(&*self.session).await
    }
    async fn overview(&self) -> OmniResult<DockerOverview> {
        overview(&*self.session).await
    }
    async fn list_containers(
        &self,
        filter: ContainerFilter,
    ) -> OmniResult<Vec<DockerContainerSummary>> {
        list_containers(&*self.session, filter).await
    }
    async fn inspect_container(&self, id: &str) -> OmniResult<DockerContainerDetail> {
        inspect_container(&*self.session, id).await
    }
    async fn container_action(&self, id: &str, action: DockerContainerAction) -> OmniResult<()> {
        container_action(&*self.session, id, action).await
    }
    async fn create_container(&self, req: &DockerCreateContainerRequest) -> OmniResult<String> {
        create_container(&*self.session, req).await
    }
    async fn container_logs(&self, id: &str, query: &DockerLogQuery) -> OmniResult<Vec<DockerLogLine>> {
        container_logs(&*self.session, id, query).await
    }
    async fn clear_container_logs(&self, id: &str) -> OmniResult<()> {
        clear_container_logs(&*self.session, id).await
    }
    async fn list_container_log_infos(&self) -> OmniResult<Vec<DockerContainerLogInfo>> {
        list_container_log_infos(&*self.session).await
    }
    async fn list_images(&self) -> OmniResult<Vec<DockerImageSummary>> {
        list_images(&*self.session).await
    }
    async fn remove_image(&self, id: &str, force: bool) -> OmniResult<()> {
        remove_image(&*self.session, id, force).await
    }
    async fn prune_images(&self) -> OmniResult<DockerPruneResult> {
        prune_images(&*self.session).await
    }
    async fn search_images(
        &self,
        term: &str,
        limit: u32,
    ) -> OmniResult<DockerImageSearchPage> {
        search_images(&*self.session, term, limit).await
    }
    async fn inspect_image(&self, id: &str) -> OmniResult<DockerImageDetail> {
        inspect_image(&*self.session, id).await
    }
    async fn image_history(&self, id: &str) -> OmniResult<Vec<DockerImageHistoryLayer>> {
        image_history(&*self.session, id).await
    }
    async fn list_compose_projects(&self) -> OmniResult<Vec<DockerComposeProject>> {
        list_compose_projects(&*self.session).await
    }
    async fn pull_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        pull_image(&*self.session, image, progress).await
    }
    async fn push_image(
        &self,
        image: &str,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerPullResult> {
        push_image(&*self.session, image, progress).await
    }
    async fn tag_image(&self, source: &str, target: &str) -> OmniResult<()> {
        tag_image(&*self.session, source, target).await
    }
    async fn build_image(
        &self,
        ctx: &DockerBuildContext,
        progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
    ) -> OmniResult<DockerBuildResult> {
        build_image(&*self.session, ctx, progress).await
    }
    async fn compose_action(
        &self,
        action: DockerComposeAction,
        req: &DockerComposeRequest,
    ) -> OmniResult<DockerComposeResult> {
        compose_action(&*self.session, action, req).await
    }
    async fn read_compose_project_files(
        &self,
        req: &DockerComposeReadFilesRequest,
    ) -> OmniResult<DockerComposeProjectFiles> {
        crate::compose_files::read_ssh_compose_project_files(&*self.session, req).await
    }
    async fn write_compose_project_files(
        &self,
        req: &DockerComposeWriteFilesRequest,
    ) -> OmniResult<()> {
        crate::compose_files::write_ssh_compose_project_files(&*self.session, req).await
    }
    async fn read_daemon_config(&self) -> OmniResult<DockerDaemonConfigFile> {
        crate::daemon_config::read_ssh_daemon_config(&*self.session).await
    }
    async fn write_daemon_config(&self, content: &str) -> OmniResult<()> {
        crate::daemon_config::write_ssh_daemon_config(&*self.session, content).await
    }
    async fn restart_docker_daemon(&self) -> OmniResult<()> {
        crate::daemon_config::restart_ssh_docker_daemon(&*self.session).await
    }
    async fn list_container_stats(
        &self,
        container_ids: Option<&[String]>,
    ) -> OmniResult<Vec<DockerContainerStats>> {
        list_container_stats(&*self.session, container_ids).await
    }
    async fn stream_stats(
        &self,
        container_id: &str,
        stop: Arc<std::sync::atomic::AtomicBool>,
        sink: Box<dyn FnMut(DockerContainerStats) + Send>,
    ) -> OmniResult<()> {
        stream_stats(&*self.session, container_id, stop, sink).await
    }
    async fn list_networks(&self) -> OmniResult<Vec<DockerNetworkSummary>> {
        list_networks(&*self.session).await
    }
    async fn create_network(&self, req: &DockerCreateNetworkRequest) -> OmniResult<String> {
        create_network(&*self.session, req).await
    }
    async fn remove_network(&self, name: &str) -> OmniResult<()> {
        remove_network(&*self.session, name).await
    }
    async fn prune_networks(&self) -> OmniResult<DockerPruneResult> {
        prune_networks(&*self.session).await
    }
    async fn connect_container_to_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        connect_container_to_network(&*self.session, network, container_id).await
    }
    async fn disconnect_container_from_network(
        &self,
        network: &str,
        container_id: &str,
    ) -> OmniResult<()> {
        disconnect_container_from_network(&*self.session, network, container_id).await
    }
    async fn inspect_network(&self, id: &str) -> OmniResult<DockerNetworkDetail> {
        inspect_network(&*self.session, id).await
    }
    async fn list_volumes(&self) -> OmniResult<Vec<DockerVolumeSummary>> {
        list_volumes(&*self.session).await
    }
    async fn create_volume(&self, req: &DockerCreateVolumeRequest) -> OmniResult<String> {
        create_volume(&*self.session, req).await
    }
    async fn remove_volume(&self, name: &str, force: bool) -> OmniResult<()> {
        remove_volume(&*self.session, name, force).await
    }
    async fn inspect_volume(&self, name: &str) -> OmniResult<DockerVolumeDetail> {
        inspect_volume(&*self.session, name).await
    }
    async fn prune_volumes(&self) -> OmniResult<DockerPruneVolumesResult> {
        prune_volumes(&*self.session).await
    }
    async fn system_disk_usage(&self) -> OmniResult<DockerSystemDiskUsage> {
        system_disk_usage(&*self.session).await
    }
    async fn prune_build_cache(&self) -> OmniResult<DockerPruneResult> {
        prune_build_cache(&*self.session).await
    }
    async fn list_container_dir(
        &self,
        container_id: &str,
        path: &str,
    ) -> OmniResult<Vec<DockerFileEntry>> {
        list_container_dir(&*self.session, container_id, path).await
    }
    async fn read_container_file(
        &self,
        container_id: &str,
        path: &str,
        max_bytes: i64,
    ) -> OmniResult<Vec<u8>> {
        read_container_file(&*self.session, container_id, path, max_bytes).await
    }
    async fn write_container_file(
        &self,
        container_id: &str,
        path: &str,
        data: Vec<u8>,
    ) -> OmniResult<()> {
        write_container_file(&*self.session, container_id, path, data).await
    }
    async fn list_volume_dir(
        &self,
        volume_name: &str,
        path: &str,
    ) -> OmniResult<Vec<DockerFileEntry>> {
        let detail = inspect_volume(&*self.session, volume_name).await?;
        crate::volume_files::list_ssh_volume_dir(&*self.session, &detail.mountpoint, path).await
    }
    async fn read_volume_file(
        &self,
        volume_name: &str,
        path: &str,
        max_bytes: i64,
    ) -> OmniResult<Vec<u8>> {
        let detail = inspect_volume(&*self.session, volume_name).await?;
        crate::volume_files::read_ssh_volume_file(
            &*self.session,
            &detail.mountpoint,
            path,
            max_bytes,
        )
        .await
    }

    // ── Swarm ──
    async fn swarm_init(
        &self,
        listen_addr: Option<&str>,
        advertise_addr: Option<&str>,
    ) -> OmniResult<String> {
        swarm_init(&*self.session, listen_addr, advertise_addr).await
    }
    async fn swarm_join(
        &self,
        remote_addrs: Vec<String>,
        token: &str,
        listen_addr: Option<&str>,
    ) -> OmniResult<()> {
        swarm_join(&*self.session, remote_addrs, token, listen_addr).await
    }
    async fn swarm_leave(&self, force: bool) -> OmniResult<()> {
        swarm_leave(&*self.session, force).await
    }
    async fn swarm_inspect(&self) -> OmniResult<serde_json::Value> {
        swarm_inspect(&*self.session).await
    }
    async fn service_list(&self) -> OmniResult<Vec<DockerServiceSummary>> {
        service_list(&*self.session).await
    }
    async fn service_create(&self, req: &DockerCreateServiceRequest) -> OmniResult<String> {
        service_create(&*self.session, req).await
    }
    async fn service_update(
        &self,
        id: &str,
        replicas: Option<u64>,
        image: Option<&str>,
    ) -> OmniResult<()> {
        service_update(&*self.session, id, replicas, image).await
    }
    async fn service_remove(&self, id: &str) -> OmniResult<()> {
        service_remove(&*self.session, id).await
    }
    async fn service_logs(&self, id: &str, tail: Option<&str>) -> OmniResult<String> {
        service_logs(&*self.session, id, tail).await
    }
    async fn node_list(&self) -> OmniResult<Vec<DockerNodeSummary>> {
        node_list(&*self.session).await
    }
    async fn node_inspect(&self, id: &str) -> OmniResult<serde_json::Value> {
        node_inspect(&*self.session, id).await
    }
    async fn node_update(
        &self,
        id: &str,
        availability: Option<&str>,
        labels: Option<Vec<DockerKeyValue>>,
    ) -> OmniResult<()> {
        node_update(&*self.session, id, availability, labels).await
    }
    async fn node_remove(&self, id: &str, force: bool) -> OmniResult<()> {
        node_remove(&*self.session, id, force).await
    }
    async fn stack_deploy(
        &self,
        name: &str,
        compose_content: &str,
        env: Option<Vec<String>>,
    ) -> OmniResult<()> {
        stack_deploy(&*self.session, name, compose_content, env).await
    }
    async fn stack_list(&self) -> OmniResult<Vec<DockerStackSummary>> {
        stack_list(&*self.session).await
    }
    async fn stack_remove(&self, name: &str) -> OmniResult<()> {
        stack_remove(&*self.session, name).await
    }
    async fn stack_services(&self, name: &str) -> OmniResult<Vec<DockerServiceSummary>> {
        stack_services(&*self.session, name).await
    }
}

/// 探测远端 Docker 可用性与版本（Engine API `/version`）。
pub async fn probe(session: &SshSession) -> OmniResult<DockerProbe> {
    let api = SshDockerApi::new(session);
    match api.get_json::<serde_json::Value>("/version").await {
        Ok(v) => Ok(DockerProbe {
            status: DockerConnectionStatus::Online,
            engine_version: v
                .get("Version")
                .and_then(|x| x.as_str())
                .map(str::to_string),
            api_version: v
                .get("ApiVersion")
                .and_then(|x| x.as_str())
                .map(str::to_string),
            capabilities: DockerCapabilities::ssh_engine(),
            warning_message: None,
        }),
        Err(e) => {
            let detail = format!("{}{}", e.message, e.cause.as_deref().unwrap_or(""));
            let (status, msg) = classify_docker_api_error(&detail);
            Ok(DockerProbe {
                status,
                engine_version: None,
                api_version: None,
                capabilities: DockerCapabilities::ssh_engine(),
                warning_message: Some(msg),
            })
        }
    }
}

/// 远端总览统计。
pub async fn overview(session: &SshSession) -> OmniResult<DockerOverview> {
    let containers = list_containers(session, ContainerFilter::All).await?;
    let running = containers.iter().filter(|c| c.running).count() as u32;
    let total = containers.len() as u32;
    let images = list_images(session)
        .await
        .map(|i| i.len() as u32)
        .unwrap_or(0);
    let version = probe(session).await.ok().and_then(|p| p.engine_version);
    Ok(DockerOverview {
        capabilities: DockerCapabilities::ssh_engine(),
        summary: DockerResourceSummary {
            containers_total: total,
            containers_running: running,
            containers_stopped: total - running,
            images,
        },
        engine_version: version,
        warning_message: None,
    })
}

/// 远端容器列表（Engine API `GET /containers/json`）。
pub async fn list_containers(
    session: &SshSession,
    filter: ContainerFilter,
) -> OmniResult<Vec<DockerContainerSummary>> {
    let api = SshDockerApi::new(session);
    let path = if filter.include_all() {
        "/containers/json?all=1"
    } else {
        "/containers/json"
    };
    let raw: Vec<bollard::models::ContainerSummary> = api.get_json(path).await?;
    let mut result = Vec::with_capacity(raw.len());
    for item in raw {
        let summary = to_container_summary(item);
        if filter.matches(summary.running) {
            result.push(summary);
        }
    }
    Ok(result)
}

/// 远端容器详情（Engine API `GET /containers/{id}/json`）。
pub async fn inspect_container(
    session: &SshSession,
    id: &str,
) -> OmniResult<DockerContainerDetail> {
    let api = SshDockerApi::new(session);
    let path = format!("/containers/{}/json", url_path_segment(id));
    let raw: bollard::models::ContainerInspectResponse = api.get_json(&path).await?;
    Ok(to_container_detail(raw))
}

/// 远端容器生命周期动作。
pub async fn container_action(
    session: &SshSession,
    id: &str,
    action: DockerContainerAction,
) -> OmniResult<()> {
    let cmd = format!("docker {} {}", action.cli_verb(), shell_quote(id));
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端容器操作失败")?;
    Ok(())
}

/// 远端创建容器（通过 SSH exec 调用 docker create）。
pub async fn create_container(
    session: &SshSession,
    req: &DockerCreateContainerRequest,
) -> OmniResult<String> {
    let mut cmd = vec!["docker create".to_string()];
    if let Some(ref name) = req.name {
        cmd.push(format!("--name {}", shell_quote(name)));
    }
    for port in &req.ports {
        cmd.push(format!("-p {}", shell_quote(port)));
    }
    for vol in &req.volumes {
        cmd.push(format!("-v {}", shell_quote(vol)));
    }
    for env in &req.env {
        cmd.push(format!("-e {}", shell_quote(env)));
    }
    if let Some(ref net) = req.network {
        cmd.push(format!("--network {}", shell_quote(net)));
    }
    if let Some(ref policy) = req.restart_policy {
        cmd.push(format!("--restart {}", shell_quote(policy)));
    }
    if req.auto_remove {
        cmd.push("--rm".to_string());
    }
    cmd.push(shell_quote(&req.image));
    if let Some(ref args) = req.cmd {
        for arg in args {
            cmd.push(shell_quote(arg));
        }
    }
    let full_cmd = cmd.join(" ");
    let out = session.exec_capture(&full_cmd).await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("创建容器失败", &out.stderr));
    }
    let id = out.stdout.trim().to_string();
    if id.is_empty() {
        return Err(docker_cli_error("创建容器失败：无输出 ID", &out.stderr));
    }
    Ok(id)
}

/// 远端容器日志（一次性 tail）。
pub async fn container_logs(
    session: &SshSession,
    id: &str,
    query: &DockerLogQuery,
) -> OmniResult<Vec<DockerLogLine>> {
    let tail = query.tail_or_default();
    let since_arg = query
        .since_for_docker_cli()
        .map(|s| format!(" --since {s}"))
        .unwrap_or_default();
    let cmd = format!(
        "docker logs --tail {tail}{since_arg} {}",
        shell_quote(id)
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("获取远端容器日志失败", &out.stderr));
    }
    let mut lines = Vec::new();
    for (stream, text) in [("stdout", &out.stdout), ("stderr", &out.stderr)] {
        for line in text.lines() {
            lines.push(DockerLogLine {
                stream: stream.to_string(),
                message: line.to_string(),
            });
        }
    }
    Ok(lines)
}

/// 清空远端容器日志文件。
pub async fn clear_container_logs(session: &SshSession, id: &str) -> OmniResult<()> {
    let cmd = format!(
        "log=$(docker inspect -f '{{{{.LogPath}}}}' {}); \
         if [ -z \"$log\" ] || [ ! -e \"$log\" ]; then exit 2; fi; \
         : > \"$log\"",
        shell_quote(id)
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("清空远端容器日志失败", &out.stderr));
    }
    Ok(())
}

/// 列出远端全部容器的日志路径与文件大小。
pub async fn list_container_log_infos(
    session: &SshSession,
) -> OmniResult<Vec<DockerContainerLogInfo>> {
    // 一次 shell：批量 inspect LogPath，再对存在的路径 `stat -c %s`
    let cmd = r#"
ids=$(docker ps -aq 2>/dev/null)
if [ -z "$ids" ]; then exit 0; fi
docker inspect -f '{{.Id}}|{{.Name}}|{{.LogPath}}' $ids 2>/dev/null | while IFS='|' read -r id name path; do
  name=${name#/}
  size=""
  if [ -n "$path" ] && [ -e "$path" ]; then
    size=$(stat -c %s -- "$path" 2>/dev/null || true)
  fi
  printf '%s\t%s\t%s\t%s\n' "$id" "$name" "$path" "$size"
done
"#;
    let out = session.exec_capture(cmd).await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("远端列出容器日志信息失败", &out.stderr));
    }
    let mut infos = Vec::new();
    for line in out.stdout.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(4, '\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let size_bytes = parts
            .get(3)
            .and_then(|s| {
                let s = s.trim();
                if s.is_empty() {
                    None
                } else {
                    s.parse::<i64>().ok()
                }
            });
        infos.push(DockerContainerLogInfo {
            container_id: parts[0].to_string(),
            name: parts[1].trim_start_matches('/').to_string(),
            log_path: parts[2].to_string(),
            size_bytes,
        });
    }
    Ok(infos)
}

/// 远端镜像搜索：优先用 daemon.json 的 registry-mirrors（本机 HTTP 访问镜像站），
/// 避免 SSH 宿主机直连 Docker Hub 超时。
pub async fn search_images(
    session: &SshSession,
    term: &str,
    limit: u32,
) -> OmniResult<DockerImageSearchPage> {
    let term = term.trim();
    if term.is_empty() {
        return Ok(DockerImageSearchPage::default());
    }
    let limit = limit.max(1).min(100);
    let daemon = crate::daemon_config::read_ssh_daemon_config(session)
        .await
        .ok();
    let daemon_json = daemon.as_ref().map(|d| d.content.as_str()).unwrap_or("{}");

    crate::image_search::search_images_prefer_mirrors(daemon_json, term, limit, || async {
        let cmd = format!(
            "docker search --limit {} --format '{{{{json .}}}}' {}",
            limit,
            shell_quote(term)
        );
        let out =
            tokio::time::timeout(std::time::Duration::from_secs(20), session.exec_capture(&cmd))
                .await
                .map_err(|_| {
                    OmniError::new(
                        ErrorCode::Timeout,
                        "远端搜索镜像超时，请在 daemon.json 配置可用的 registry-mirrors",
                    )
                })??;
        if out.exit_code != 0 {
            return Err(docker_cli_error("远端搜索镜像失败", &out.stderr));
        }
        Ok(crate::local::parse_docker_search_json_lines(
            &out.stdout, limit,
        ))
    })
    .await
}

/// 远端宿主机交互 shell（用于直接执行 `docker` CLI，而不是 `docker exec` 进容器）。
/// 依次尝试 login shell / bash / sh。
pub async fn create_host_shell(
    session: &SshSession,
    cols: u16,
    rows: u16,
) -> OmniResult<(DockerExecSession, DockerExecOutput)> {
    let candidates = [
        "bash -l",
        "bash",
        "sh -l",
        "sh",
        // 部分环境仅装了 zsh / ash
        "zsh -l",
        "zsh",
        "ash",
    ];
    let mut last_err: Option<OmniError> = None;
    for cmd in candidates {
        match create_exec_with_cmd(session, cmd, cols, rows).await {
            Ok(pair) => return Ok(pair),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        OmniError::new(
            ErrorCode::Ssh,
            "无法在远端宿主机启动交互 shell（已尝试 bash/sh/zsh）",
        )
    }))
}

/// 远端容器交互终端：在独立 PTY exec channel 上跑 `docker exec -it`，
/// 把远端 PTY 输出通过 stream 推回前端命令层；返回的 `DockerExecSession::Ssh`
/// 复用 `SshPtySession` 的 write/resize/close，与本地 bollard exec 行为对齐。
pub async fn create_exec(
    session: &SshSession,
    container_id: &str,
    shell: &str,
    cols: u16,
    rows: u16,
) -> OmniResult<(DockerExecSession, DockerExecOutput)> {
    let cmd_interactive = format!(
        "docker exec -it {} {}",
        shell_quote(container_id),
        shell_quote(shell)
    );
    match create_exec_with_cmd(session, &cmd_interactive, cols, rows).await {
        Ok(pair) => Ok(pair),
        Err(err) if is_docker_exec_tty_error(&err) => {
            let cmd_stdin = format!(
                "docker exec -i {} {}",
                shell_quote(container_id),
                shell_quote(shell)
            );
            create_exec_with_cmd(session, &cmd_stdin, cols, rows).await
        }
        Err(err) => Err(err),
    }
}

fn is_docker_exec_tty_error(err: &OmniError) -> bool {
    let msg = format!("{}{}", err.message, err.cause.as_deref().unwrap_or(""));
    msg.contains("not a TTY")
        || msg.contains("input device is not a TTY")
        || msg.contains("cannot enable tty mode")
        || msg.contains("the TTY")
}

async fn create_exec_with_cmd(
    session: &SshSession,
    cmd: &str,
    cols: u16,
    rows: u16,
) -> OmniResult<(DockerExecSession, DockerExecOutput)> {
    let (tx, rx) = mpsc::unbounded_channel::<StreamChunk>();
    let pty: SshPtySession = session.exec_pty(cmd, cols, rows, tx).await?;
    let output: DockerExecOutput = Box::pin(rx_to_output_stream(rx));
    Ok((DockerExecSession::Ssh(pty), output))
}

/// 把 `StreamChunk` mpsc 接收端转成命令层期望的 `OmniResult<Vec<u8>>` 流。
/// 错误通过 `StreamChunk::Stderr` 表达；`Exit` / `Closed` 终止流。
fn rx_to_output_stream(
    mut rx: mpsc::UnboundedReceiver<StreamChunk>,
) -> impl Stream<Item = OmniResult<Vec<u8>>> + Send {
    async_stream::stream! {
        while let Some(chunk) = rx.recv().await {
            match chunk {
                StreamChunk::Stdout(b) | StreamChunk::Stderr(b) => yield Ok(b),
                StreamChunk::Exit(_) | StreamChunk::Closed => break,
            }
        }
    }
}

/// 远端容器日志流式跟随。在独立 SSH exec channel 上跑 `docker logs -f`，
/// 行级解析后通过 `emit` 回调推送给调用方。`stop` 置位时主动关闭远端命令。
pub async fn stream_logs<F>(
    session: &SshSession,
    id: &str,
    query: &DockerLogQuery,
    follow: bool,
    stop: Arc<AtomicBool>,
    mut emit: F,
) -> OmniResult<()>
where
    F: FnMut(DockerLogLine) + Send,
{
    let tail = query.tail_or_default();
    let since_arg = query
        .since_for_docker_cli()
        .map(|s| format!(" --since {s}"))
        .unwrap_or_default();
    let cmd = if follow {
        format!(
            "docker logs -f --tail {tail}{since_arg} {}",
            shell_quote(id)
        )
    } else {
        // 非 follow 走一次性路径，保持与本地行为一致。
        let lines = container_logs(session, id, query).await?;
        lines.into_iter().for_each(&mut emit);
        return Ok(());
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<StreamChunk>();
    let mut handle: SshStreamHandle = session.exec_stream(&cmd, tx).await?;

    let mut line_buf: Vec<u8> = Vec::new();
    loop {
        tokio::select! {
            chunk = rx.recv() => {
                match chunk {
                    Some(StreamChunk::Stdout(bytes)) => {
                        push_bytes(&mut line_buf, &bytes, "stdout", &mut emit);
                    }
                    Some(StreamChunk::Stderr(bytes)) => {
                        push_bytes(&mut line_buf, &bytes, "stderr", &mut emit);
                    }
                    Some(StreamChunk::Exit(_)) | Some(StreamChunk::Closed) | None => {
                        // 末尾残留行（如远端最后一行未换行）也提交。
                        if !line_buf.is_empty() {
                            emit(DockerLogLine {
                                stream: "stdout".to_string(),
                                message: String::from_utf8_lossy(&line_buf).into_owned(),
                            });
                            line_buf.clear();
                        }
                        break;
                    }
                }
            }
            _ = wait_stop(&stop) => {
                handle.signal_stop();
                break;
            }
        }
    }
    // 给后台任务一个干净的退出窗口。
    handle.stop().await;
    Ok(())
}

async fn wait_stop(stop: &AtomicBool) {
    loop {
        if stop.load(Ordering::Relaxed) {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
}

/// 行级解析：把字节追加到缓冲，遇 `\n` 提交一行；尾随 `\r` 忽略。
fn push_bytes<F>(buf: &mut Vec<u8>, bytes: &[u8], stream: &str, emit: &mut F)
where
    F: FnMut(DockerLogLine) + Send,
{
    for &b in bytes {
        if b == b'\n' {
            let line = String::from_utf8_lossy(buf).into_owned();
            buf.clear();
            emit(DockerLogLine {
                stream: stream.to_string(),
                message: line,
            });
        } else if b != b'\r' {
            buf.push(b);
        }
    }
}

/// 远端镜像列表（Engine API `GET /images/json`）。
pub async fn list_images(session: &SshSession) -> OmniResult<Vec<DockerImageSummary>> {
    let api = SshDockerApi::new(session);
    let raw: Vec<bollard::models::ImageSummary> = api.get_json("/images/json").await?;
    Ok(raw.into_iter().flat_map(to_image_summaries).collect())
}

/// 删除远端镜像。
pub async fn remove_image(session: &SshSession, id: &str, force: bool) -> OmniResult<()> {
    let flag = if force { "-f " } else { "" };
    let cmd = format!("docker rmi {flag}{}", shell_quote(id));
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("删除远端镜像失败")?;
    Ok(())
}

/// 清理远端悬空镜像。
pub async fn prune_images(session: &SshSession) -> OmniResult<DockerPruneResult> {
    let out = session.exec_capture("docker image prune -f").await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("清理远端镜像失败", &out.stderr));
    }
    Ok(DockerPruneResult {
        deleted: out
            .stdout
            .lines()
            .filter(|l| l.starts_with("deleted:") || l.starts_with("untagged:"))
            .map(|l| l.to_string())
            .collect(),
        freed_space_bytes: parse_reclaimed_space(&out.stdout),
    })
}

/// 远端镜像详情（Engine API `GET /images/{id}/json`）。
pub async fn inspect_image(session: &SshSession, id: &str) -> OmniResult<DockerImageDetail> {
    let api = SshDockerApi::new(session);
    let path = format!("/images/{}/json", url_path_segment(id));
    let raw: bollard::models::ImageInspect = api.get_json(&path).await?;
    map_image_inspect(raw, id)
}

fn map_image_inspect(raw: bollard::models::ImageInspect, id: &str) -> OmniResult<DockerImageDetail> {
    let cfg = raw.config.clone().unwrap_or_default();
    let env = cfg.env.clone().unwrap_or_default();
    let labels_map = cfg.labels.clone().unwrap_or_default();
    let exposed = cfg.exposed_ports.clone().unwrap_or_default();
    let volumes = cfg.volumes.clone().unwrap_or_default();
    let config = DockerImageConfig {
        env,
        cmd: cfg.cmd.clone().map(|v| v.join(" ")),
        entrypoint: cfg.entrypoint.clone().map(|v| v.join(" ")),
        working_dir: cfg.working_dir.clone(),
        user: cfg.user.clone(),
        exposed_ports: exposed,
        labels: labels_map
            .into_iter()
            .map(|(k, v)| DockerKeyValue { key: k, value: v })
            .collect(),
        volumes,
    };
    Ok(DockerImageDetail {
        id: raw.id.clone().unwrap_or_else(|| id.to_string()),
        repo_tags: raw.repo_tags.clone().unwrap_or_default(),
        architecture: raw.architecture,
        os: raw.os,
        driver: None,
        created_at: parse_iso_to_unix_ms(raw.created.as_deref()),
        size_bytes: raw.size.unwrap_or(0),
        author: raw.author,
        comment: raw.comment,
        config,
        history: Vec::new(),
    })
}

/// 远端镜像历史（Engine API `GET /images/{id}/history`）。
pub async fn image_history(
    session: &SshSession,
    id: &str,
) -> OmniResult<Vec<DockerImageHistoryLayer>> {
    let api = SshDockerApi::new(session);
    let path = format!("/images/{}/history", url_path_segment(id));
    let raw: Vec<bollard::models::ImageHistoryResponseItem> = api.get_json(&path).await?;
    Ok(raw
        .into_iter()
        .map(|h| DockerImageHistoryLayer {
            id: h.id,
            created_at: h.created.saturating_mul(1000),
            created_by: h.created_by,
            size_bytes: h.size,
            comment: h.comment,
            tags: h.tags,
        })
        .collect())
}

/// 远端 Compose 项目识别（基于 Engine API 容器列表 labels）。
pub async fn list_compose_projects(session: &SshSession) -> OmniResult<Vec<DockerComposeProject>> {
    let api = SshDockerApi::new(session);
    let raw: Vec<bollard::models::ContainerSummary> =
        api.get_json("/containers/json?all=1").await?;
    let mut rows = Vec::new();
    for item in raw {
        let labels = item.labels.clone().unwrap_or_default();
        let Some(project) = labels.get("com.docker.compose.project") else {
            continue;
        };
        rows.push(ComposeContainerRow {
            project: project.clone(),
            service: labels
                .get("com.docker.compose.service")
                .cloned()
                .unwrap_or_else(|| "default".to_string()),
            working_dir: labels
                .get("com.docker.compose.project.working_dir")
                .cloned(),
            config_files: labels
                .get("com.docker.compose.project.config_files")
                .cloned(),
            image: item.image.unwrap_or_default(),
            running: item
                .state
                .as_ref()
                .map(|s| format!("{s:?}").to_lowercase())
                == Some("running".to_string()),
        });
    }
    Ok(aggregate_compose(rows))
}

/// 远端镜像拉取（`docker pull`）。进度通过可选的 `progress` 回调实时上报（每行作为一段）。
/// 返回时把 `image:tag` 解析回字段，便于前端展示。
pub async fn pull_image(
    session: &SshSession,
    image: &str,
    progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
) -> OmniResult<DockerPullResult> {
    let (name, tag) = split_image_ref(image);
    let cmd = format!(
        "docker pull -a {} 2>&1 || true",
        shell_quote(&format!("{name}:{tag}"))
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 && out.stdout.trim().is_empty() {
        return Err(docker_cli_error("远端拉取镜像失败", &out.stderr));
    }
    if let Some(cb) = progress.as_ref() {
        for line in out.stdout.lines() {
            if line.trim().is_empty() {
                continue;
            }
            cb(DockerImageProgress {
                id: String::new(),
                status: line.trim().to_string(),
                progress: None,
                detail: None,
            });
        }
    }
    Ok(DockerPullResult {
        image: name.to_string(),
        tag: tag.to_string(),
        digest: None,
    })
}

/// 远端镜像推送（`docker push`）。进度通过可选的 `progress` 回调实时上报。
pub async fn push_image(
    session: &SshSession,
    image: &str,
    progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
) -> OmniResult<DockerPullResult> {
    let (name, tag) = split_image_ref(image);
    let cmd = format!(
        "docker push {} 2>&1 || true",
        shell_quote(&format!("{name}:{tag}"))
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 && out.stdout.trim().is_empty() {
        return Err(docker_cli_error("远端推送镜像失败", &out.stderr));
    }
    if let Some(cb) = progress.as_ref() {
        for line in out.stdout.lines() {
            if line.trim().is_empty() {
                continue;
            }
            cb(DockerImageProgress {
                id: String::new(),
                status: line.trim().to_string(),
                progress: None,
                detail: None,
            });
        }
    }
    Ok(DockerPullResult {
        image: name.to_string(),
        tag: tag.to_string(),
        digest: None,
    })
}

/// 远端镜像打 tag（`docker tag source target`）。
pub async fn tag_image(session: &SshSession, source: &str, target: &str) -> OmniResult<()> {
    let cmd = format!("docker tag {} {}", shell_quote(source), shell_quote(target));
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端镜像 tag 失败")?;
    Ok(())
}

/// 远端 Dockerfile 构建：本地打包 tar → SFTP 上传到临时路径 → `docker build`。
pub async fn build_image(
    session: &SshSession,
    ctx: &DockerBuildContext,
    progress: Option<Box<dyn Fn(DockerImageProgress) + Send + Sync>>,
) -> OmniResult<DockerBuildResult> {
    let context_dir = std::path::PathBuf::from(&ctx.context_dir);
    if !context_dir.is_dir() {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("构建目录不存在：{}", ctx.context_dir),
        ));
    }
    // 1) 本地打包 tar
    let mut tar = tar::Builder::new(Vec::<u8>::new());
    for entry in walkdir::WalkDir::new(&context_dir).follow_links(false) {
        let entry = entry.map_err(|e| {
            OmniError::new(ErrorCode::Internal, "扫描构建目录失败").with_cause(e.to_string())
        })?;
        let path = entry.path();
        let rel = path.strip_prefix(&context_dir).unwrap_or(path);
        if rel.as_os_str().is_empty() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| {
            OmniError::new(ErrorCode::Internal, "读取元数据失败").with_cause(e.to_string())
        })?;
        if meta.is_file() {
            tar.append_path_with_name(path, rel).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "打包 tar 失败").with_cause(e.to_string())
            })?;
        } else if meta.is_dir() {
            tar.append_dir(rel, path).map_err(|e| {
                OmniError::new(ErrorCode::Internal, "打包目录失败").with_cause(e.to_string())
            })?;
        }
    }
    let tar_bytes = tar.into_inner().map_err(|e| {
        OmniError::new(ErrorCode::Internal, "打包 tar 失败").with_cause(e.to_string())
    })?;

    // 2) SFTP 上传
    let remote_tmp = format!("/tmp/omnipanel-build-{}.tar", uuid_like());
    session
        .sftp_upload(&remote_tmp, &tar_bytes)
        .await
        .map_err(|e| e.with_cause("上传构建上下文失败"))?;

    // 3) docker build
    let dockerfile = ctx
        .dockerfile
        .as_deref()
        .unwrap_or("Dockerfile")
        .to_string();
    let mut args = vec![
        "build".to_string(),
        "-t".to_string(),
        shell_quote(&ctx.tag),
        "-f".to_string(),
        shell_quote(&dockerfile),
    ];
    for a in &ctx.build_args {
        args.push("--build-arg".to_string());
        args.push(shell_quote(a));
    }
    args.push(remote_tmp.clone());
    let cmd = format!("docker {}", args.join(" "));
    let out = session
        .exec_capture(&cmd)
        .await
        .map_err(|e| e.with_cause("执行 docker build 失败"))?;
    // 清理临时文件
    let _ = session
        .exec_capture(&format!("rm -f {}", shell_quote(&remote_tmp)))
        .await;
    if out.exit_code != 0 {
        return Err(docker_cli_error("远端 docker build 失败", &out.stderr));
    }
    if let Some(cb) = progress.as_ref() {
        for line in out.stdout.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            cb(DockerImageProgress {
                id: String::new(),
                status: line.to_string(),
                progress: None,
                detail: None,
            });
        }
    }
    Ok(DockerBuildResult {
        tag: ctx.tag.clone(),
        image_id: None,
    })
}

/// 生成 8 字符短随机 id（用于临时文件命名）。非加密安全，仅用于区分并发构建。
fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let v = nanos as u64 ^ (std::process::id() as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{:x}", v & 0xFFFF_FFFF)
}

/// SSH 宿主机批量拉取容器 stats（`docker stats --no-stream`）。
pub async fn list_container_stats(
    session: &SshSession,
    container_ids: Option<&[String]>,
) -> OmniResult<Vec<DockerContainerStats>> {
    crate::stats::list_via_ssh_cli(session, container_ids).await
}

/// 远端容器 stats 流：调用 `docker stats --no-trunc --format '{{json .}}' <id>`，
/// 按行解析 JSON，回调 `sink` 持续推送。本实现把 `docker stats` 当作流式命令
/// 处理（`--no-trunc` 保证 JSON 完整），依赖 exec_stream 提供的行级流。
pub async fn stream_stats(
    session: &SshSession,
    container_id: &str,
    stop: Arc<std::sync::atomic::AtomicBool>,
    mut sink: Box<dyn FnMut(DockerContainerStats) + Send>,
) -> OmniResult<()> {
    use std::sync::atomic::Ordering;
    use tokio::sync::mpsc;
    let cmd = format!(
        "docker stats --no-trunc --format {} {}",
        shell_quote("'{{json .}}'"),
        shell_quote(container_id)
    );
    let (tx, mut rx) = mpsc::unbounded_channel::<omnipanel_ssh::StreamChunk>();
    let mut handle: omnipanel_ssh::SshStreamHandle = session.exec_stream(&cmd, tx).await?;

    let mut line_buf: Vec<u8> = Vec::new();
    let mut stop_interval = tokio::time::interval(std::time::Duration::from_millis(200));
    stop_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = stop_interval.tick() => {
                if stop.load(Ordering::Relaxed) {
                    handle.signal_stop();
                    break;
                }
            }
            chunk = rx.recv() => {
                match chunk {
                    Some(omnipanel_ssh::StreamChunk::Stdout(bytes)) => {
                        for &b in &bytes {
                            if b == b'\n' {
                                let line = String::from_utf8_lossy(&line_buf).into_owned();
                                line_buf.clear();
                                let trimmed = line.trim();
                                if !trimmed.is_empty() {
                                    if let Ok(stats) = crate::stats::parse_cli_line(trimmed) {
                                        sink(stats);
                                    }
                                }
                            } else if b != b'\r' {
                                line_buf.push(b);
                            }
                        }
                    }
                    Some(omnipanel_ssh::StreamChunk::Stderr(_)) => {}
                    Some(omnipanel_ssh::StreamChunk::Exit(_))
                    | Some(omnipanel_ssh::StreamChunk::Closed)
                    | None => break,
                }
            }
        }
    }
    // 等待后台任务退出
    handle.stop().await;
    Ok(())
}

/// 远端 Compose 生命周期（up/down/restart/pull/logs）。
pub async fn compose_action(
    session: &SshSession,
    action: DockerComposeAction,
    req: &DockerComposeRequest,
) -> OmniResult<DockerComposeResult> {
    let sub = match action {
        DockerComposeAction::Up => "up",
        DockerComposeAction::Stop => "stop",
        DockerComposeAction::Down => "down",
        DockerComposeAction::Restart => "restart",
        DockerComposeAction::Rebuild => "up",
        DockerComposeAction::Pull => "pull",
        DockerComposeAction::Logs => "logs",
    };
    // `-p` / `-f` 为 compose 全局选项，必须放在子命令之前。
    let mut args: Vec<String> = vec!["compose".to_string()];
    args.push("-p".to_string());
    args.push(shell_quote(&req.project));
    if let Some(cf) = &req.config_file {
        args.push("-f".to_string());
        args.push(shell_quote(cf));
    }
    args.push(sub.to_string());
    match action {
        DockerComposeAction::Up => {
            if req.detached {
                args.push("-d".to_string());
            }
        }
        DockerComposeAction::Rebuild => {
            args.push("-d".to_string());
            args.push("--build".to_string());
            args.push("--force-recreate".to_string());
        }
        DockerComposeAction::Logs => {
            args.push("--tail".to_string());
            args.push("200".to_string());
        }
        _ => {}
    }
    for svc in &req.services {
        args.push(shell_quote(svc));
    }
    let docker_cmd = format!("docker {}", args.join(" "));
    let cmd = if let Some(wd) = req.working_dir.as_deref().filter(|value| !value.trim().is_empty()) {
        format!("cd {} && {}", shell_quote(wd), docker_cmd)
    } else {
        docker_cmd
    };
    let out = session.exec_capture(&cmd).await?;
    let excerpt = |s: &str| -> String {
        if s.len() <= 8 * 1024 {
            s.to_string()
        } else {
            let cut = 8 * 1024;
            format!("{}…[truncated]", &s[..cut])
        }
    };
    Ok(DockerComposeResult {
        action,
        project: req.project.clone(),
        stdout_excerpt: excerpt(&out.stdout),
        stderr_excerpt: excerpt(&out.stderr),
        exit_code: out.exit_code,
    })
}

/// 拆分 `repo:tag`，无 `:` 时 tag 默认为 "latest"。
fn split_image_ref(image: &str) -> (&str, &str) {
    match image.rsplit_once(':') {
        Some((repo, tag)) => (repo, tag),
        None => (image, "latest"),
    }
}

// ---------------------------------------------------------------------------
// 解析与工具
// ---------------------------------------------------------------------------

/// 人类可读尺寸（docker SI，1000 进制）转字节。如 `142MB`、`1.2GB`、`0B`。
fn human_size_to_bytes(text: &str) -> i64 {
    let t = text.trim();
    if t.is_empty() || t == "N/A" {
        return 0;
    }
    let split = t.find(|c: char| c.is_ascii_alphabetic()).unwrap_or(t.len());
    let (num, unit) = t.split_at(split);
    let value: f64 = num.trim().parse().unwrap_or(0.0);
    let multiplier = match unit.trim().to_uppercase().as_str() {
        "B" | "" => 1.0,
        "KB" => 1_000.0,
        "MB" => 1_000_000.0,
        "GB" => 1_000_000_000.0,
        "TB" => 1_000_000_000_000.0,
        // 兼容二进制单位写法
        "KIB" => 1_024.0,
        "MIB" => 1_048_576.0,
        "GIB" => 1_073_741_824.0,
        _ => 1.0,
    };
    (value * multiplier) as i64
}

/// 解析 docker CLI 输出的 ISO-8601 时间为 Unix 毫秒；解析失败返回 0。
fn parse_iso_to_unix_ms(s: Option<&str>) -> i64 {
    let Some(text) = s else { return 0 };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return 0;
    }
    use chrono::DateTime;
    if let Ok(dt) = DateTime::parse_from_rfc3339(trimmed) {
        return dt.timestamp_millis();
    }
    if let Ok(dt) = DateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S%.f%z") {
        return dt.timestamp_millis();
    }
    0
}

/// 从 `docker image prune` 输出解析释放空间。
fn parse_reclaimed_space(text: &str) -> i64 {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("Total reclaimed space:"))
        .map(|s| human_size_to_bytes(s.trim()))
        .unwrap_or(0)
}

/// 把远端错误文本归类为可定位的连接/权限错误。
fn classify_docker_error(detail: &str) -> (DockerConnectionStatus, String) {
    let lower = detail.to_lowercase();
    if lower.contains("command not found") || lower.contains("not found") {
        (
            DockerConnectionStatus::Offline,
            "远端未安装 docker 或不在 PATH 中".to_string(),
        )
    } else if lower.contains("permission denied") || lower.contains("dial unix") {
        (
            DockerConnectionStatus::Degraded,
            "当前用户无权访问 Docker（需加入 docker 组或使用 sudo）".to_string(),
        )
    } else if lower.contains("cannot connect") || lower.contains("is the docker daemon running") {
        (
            DockerConnectionStatus::Offline,
            "远端 Docker 守护进程未运行".to_string(),
        )
    } else {
        (
            DockerConnectionStatus::Degraded,
            format!("Docker 探测失败：{}", detail.trim()),
        )
    }
}

fn docker_cli_error(context: &str, stderr: &str) -> OmniError {
    let (_, msg) = classify_docker_error(stderr);
    OmniError::new(ErrorCode::Internal, context.to_string()).with_cause(msg)
}

/// 极简 shell 单引号转义，避免容器 id/名称中的特殊字符。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_human_sizes() {
        assert_eq!(human_size_to_bytes("0B"), 0);
        assert_eq!(human_size_to_bytes("142MB"), 142_000_000);
        assert_eq!(human_size_to_bytes("1.2GB"), 1_200_000_000);
        assert_eq!(human_size_to_bytes("N/A"), 0);
    }

    #[test]
    fn parses_reclaimed_space() {
        let text = "Deleted Images:\nuntagged: foo\n\nTotal reclaimed space: 1.2GB\n";
        assert_eq!(parse_reclaimed_space(text), 1_200_000_000);
    }

    #[test]
    fn classifies_permission_error() {
        let (status, _msg) = classify_docker_error("Got permission denied while trying to connect");
        assert_eq!(status, DockerConnectionStatus::Degraded);
    }
}

// -------- 网络 --------

pub async fn list_networks(session: &SshSession) -> OmniResult<Vec<DockerNetworkSummary>> {
    let api = SshDockerApi::new(session);
    let raw: Vec<bollard::models::NetworkSummary> = api.get_json("/networks").await?;
    Ok(raw
        .into_iter()
        .map(|n| {
            let (ipv4_subnet, ipv4_gateway) =
                crate::local::first_ipv4_from_ipam(n.ipam.as_ref());
            DockerNetworkSummary {
                id: n.id.unwrap_or_default(),
                name: n.name.unwrap_or_default(),
                driver: n.driver.unwrap_or_default(),
                scope: n.scope.unwrap_or_default(),
                internal: n.internal.unwrap_or(false),
                created_at: 0,
                ipv4_subnet,
                ipv4_gateway,
            }
        })
        .collect())
}

pub async fn create_network(
    session: &SshSession,
    req: &DockerCreateNetworkRequest,
) -> OmniResult<String> {
    let mut args: Vec<String> = vec!["network".to_string(), "create".to_string()];
    if let Some(driver) = &req.driver {
        args.push("--driver".to_string());
        args.push(shell_quote(driver));
    }
    if req.internal {
        args.push("--internal".to_string());
    }
    if let Some(subnet) = &req.subnet {
        args.push("--subnet".to_string());
        args.push(shell_quote(subnet));
    }
    args.push(shell_quote(&req.name));
    let cmd = format!("docker {}", args.join(" "));
    let out = session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端创建网络失败")?;
    Ok(out.stdout.trim().to_string())
}

pub async fn remove_network(session: &SshSession, name: &str) -> OmniResult<()> {
    let cmd = format!("docker network rm {}", shell_quote(name));
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端删除网络失败")?;
    Ok(())
}

pub async fn prune_networks(session: &SshSession) -> OmniResult<DockerPruneResult> {
    let out = session.exec_capture("docker network prune -f").await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("远端清理网络失败", &out.stderr));
    }
    let deleted: Vec<String> = out
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect();
    let freed = parse_docker_reclaimed(&out.stderr)
        .or_else(|| parse_docker_reclaimed(&out.stdout))
        .unwrap_or(0);
    Ok(DockerPruneResult {
        deleted,
        freed_space_bytes: freed,
    })
}

pub async fn connect_container_to_network(
    session: &SshSession,
    network: &str,
    container_id: &str,
) -> OmniResult<()> {
    let cmd = format!(
        "docker network connect {} {}",
        shell_quote(network),
        shell_quote(container_id)
    );
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端连接网络失败")?;
    Ok(())
}

pub async fn disconnect_container_from_network(
    session: &SshSession,
    network: &str,
    container_id: &str,
) -> OmniResult<()> {
    let cmd = format!(
        "docker network disconnect {} {}",
        shell_quote(network),
        shell_quote(container_id)
    );
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端断开网络失败")?;
    Ok(())
}

/// 远端网络详情（Engine API `GET /networks/{id}`）。
pub async fn inspect_network(session: &SshSession, id: &str) -> OmniResult<DockerNetworkDetail> {
    let api = SshDockerApi::new(session);
    let path = format!("/networks/{}", url_path_segment(id));
    let raw: bollard::models::NetworkInspect = api.get_json(&path).await?;
    let subnets = raw
        .ipam
        .as_ref()
        .and_then(|i| i.config.clone())
        .unwrap_or_default()
        .into_iter()
        .map(|c| DockerNetworkSubnet {
            subnet: c.subnet,
            gateway: c.gateway,
            ip_range: c.ip_range,
        })
        .collect();
    let containers = raw
        .containers
        .unwrap_or_default()
        .into_iter()
        .map(|(id, c)| DockerNetworkContainer {
            container_id: id,
            name: c.name.unwrap_or_default(),
            endpoint_id: c.endpoint_id,
            mac_address: c.mac_address,
            ipv4_address: c.ipv4_address,
            ipv6_address: c.ipv6_address,
        })
        .collect();
    let labels = raw
        .labels
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| DockerKeyValue { key: k, value: v })
        .collect();
    let options = raw
        .options
        .unwrap_or_default()
        .into_iter()
        .map(|(k, v)| DockerKeyValue { key: k, value: v })
        .collect();
    Ok(DockerNetworkDetail {
        id: raw.id.unwrap_or_else(|| id.to_string()),
        name: raw.name.unwrap_or_default(),
        driver: raw.driver.unwrap_or_default(),
        scope: raw.scope.unwrap_or_default(),
        internal: raw.internal.unwrap_or(false),
        enable_ipv6: raw.enable_ipv6.unwrap_or(false),
        created_at: parse_iso_to_unix_ms(raw.created.as_deref()),
        subnets,
        containers,
        labels,
        options,
    })
}

// -------- 卷 --------

pub async fn list_volumes(session: &SshSession) -> OmniResult<Vec<DockerVolumeSummary>> {
    let api = SshDockerApi::new(session);
    let raw: bollard::models::VolumeListResponse = api.get_json("/volumes").await?;
    Ok(raw
        .volumes
        .unwrap_or_default()
        .into_iter()
        .map(|v| DockerVolumeSummary {
            name: v.name.clone(),
            driver: v.driver.clone(),
            mountpoint: v.mountpoint.clone(),
            created_at: 0,
            size_bytes: -1,
            in_use: false,
        })
        .collect())
}

pub async fn create_volume(
    session: &SshSession,
    req: &DockerCreateVolumeRequest,
) -> OmniResult<String> {
    let mut args: Vec<String> = vec![
        "volume".to_string(),
        "create".to_string(),
        shell_quote(&req.name),
    ];
    if let Some(driver) = &req.driver {
        args.insert(2, "--driver".to_string());
        args.insert(3, shell_quote(driver));
    }
    for (k, v) in &req.labels {
        args.push("--label".to_string());
        args.push(shell_quote(&format!("{k}={v}")));
    }
    let cmd = format!("docker {}", args.join(" "));
    let out = session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端创建卷失败")?;
    Ok(out.stdout.trim().to_string())
}

pub async fn remove_volume(session: &SshSession, name: &str, force: bool) -> OmniResult<()> {
    let flag = if force { " -f" } else { "" };
    let cmd = format!("docker volume rm{flag} {}", shell_quote(name));
    session
        .exec_capture(&cmd)
        .await?
        .ok_or_err("远端删除卷失败")?;
    Ok(())
}

/// 远端卷详情（Engine API `GET /volumes/{name}`）。
pub async fn inspect_volume(session: &SshSession, name: &str) -> OmniResult<DockerVolumeDetail> {
    let api = SshDockerApi::new(session);
    let path = format!("/volumes/{}", url_path_segment(name));
    let raw: bollard::models::Volume = api.get_json(&path).await?;
    let labels = raw
        .labels
        .into_iter()
        .map(|(k, v)| DockerKeyValue { key: k, value: v })
        .collect();
    let options = raw
        .options
        .into_iter()
        .map(|(k, v)| DockerKeyValue { key: k, value: v })
        .collect();
    let (size_bytes, reference_count) = raw
        .usage_data
        .as_ref()
        .map(|u| (u.size, u.ref_count))
        .unwrap_or((-1, 0));
    let scope = match raw.scope {
        Some(bollard::models::VolumeScopeEnum::LOCAL) => "local",
        Some(bollard::models::VolumeScopeEnum::GLOBAL) => "global",
        _ => "local",
    }
    .to_string();
    Ok(DockerVolumeDetail {
        name: raw.name,
        driver: raw.driver,
        mountpoint: raw.mountpoint,
        scope,
        created_at: parse_iso_to_unix_ms(raw.created_at.as_deref()),
        labels,
        options,
        size_bytes,
        reference_count,
    })
}

pub async fn prune_volumes(session: &SshSession) -> OmniResult<DockerPruneVolumesResult> {
    let out = session.exec_capture("docker volume prune -f").await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("远端清理卷失败", &out.stderr));
    }
    // `docker volume prune -f` 的 stdout 会列出删除的卷名。
    let deleted: Vec<String> = out
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect();
    // 解析 `Total reclaimed space: 1.23MB` 之类的输出。
    let freed = parse_docker_reclaimed(&out.stderr)
        .or_else(|| parse_docker_reclaimed(&out.stdout))
        .unwrap_or(0);
    Ok(DockerPruneVolumesResult {
        deleted,
        freed_space_bytes: freed,
    })
}

pub async fn system_disk_usage(session: &SshSession) -> OmniResult<DockerSystemDiskUsage> {
    let api = SshDockerApi::new(session);
    let raw: bollard::models::SystemDataUsageResponse = api.get_json("/system/df").await?;
    Ok(map_system_data_usage(raw))
}

pub async fn prune_build_cache(session: &SshSession) -> OmniResult<DockerPruneResult> {
    let out = session.exec_capture("docker builder prune -f").await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error("远端清理构建缓存失败", &out.stderr));
    }
    let deleted: Vec<String> = out
        .stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|s| s.trim().to_string())
        .collect();
    let freed = parse_docker_reclaimed(&out.stderr)
        .or_else(|| parse_docker_reclaimed(&out.stdout))
        .unwrap_or(0);
    Ok(DockerPruneResult {
        deleted,
        freed_space_bytes: freed,
    })
}

fn parse_docker_reclaimed(text: &str) -> Option<i64> {
    // 例：`Total reclaimed space: 1.23MB` 或 `reclaimed space: 1.2kB`
    let lower = text.to_lowercase();
    let idx = lower.find("reclaimed")?;
    let rest = &text[idx..];
    let colon = rest.find(':')?;
    let after = rest[colon + 1..].trim();
    let token = after.split_whitespace().next()?;
    Some(human_size_to_bytes(token))
}

// -------- 容器内文件 --------
// 目录列表走 `docker exec ls`（禁止 docker cp 整树：对 `/` 会复制整个文件系统以致一直「加载中」）。
// 单文件读写仍走 `docker cp`。

pub async fn list_container_dir(
    session: &SshSession,
    container_id: &str,
    path: &str,
) -> OmniResult<Vec<DockerFileEntry>> {
    let path = crate::container_dir_ls::normalize_container_dir_path(path);
    let cmd = format!(
        "docker exec {} ls -lan -- {}",
        shell_quote(container_id),
        shell_quote(path),
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        return Err(docker_cli_error(
            "列出容器内目录失败",
            if out.stderr.trim().is_empty() {
                &out.stdout
            } else {
                &out.stderr
            },
        ));
    }
    Ok(crate::container_dir_ls::parse_ls_lan_output(&out.stdout))
}

pub async fn read_container_file(
    session: &SshSession,
    container_id: &str,
    path: &str,
    max_bytes: i64,
) -> OmniResult<Vec<u8>> {
    let remote_tmp = format!("/tmp/omnipanel-cp-{}.bin", uuid_like());
    let cmd = format!(
        "docker cp {}:{} {} && cat {}",
        container_id,
        shell_quote(path),
        shell_quote(&remote_tmp),
        shell_quote(&remote_tmp)
    );
    let out = session.exec_capture(&cmd).await?;
    if out.exit_code != 0 {
        let _ = session
            .exec_capture(&format!("rm -f {}", shell_quote(&remote_tmp)))
            .await;
        return Err(docker_cli_error("读取容器内文件失败", &out.stderr));
    }
    let read = session
        .sftp_download(&remote_tmp)
        .await
        .map_err(|e| e.with_cause("下载容器文件到 Tauri 主机失败"))?;
    let _ = session
        .exec_capture(&format!("rm -f {}", shell_quote(&remote_tmp)))
        .await;
    if max_bytes > 0 && (read.len() as i64) > max_bytes {
        return Err(OmniError::new(
            ErrorCode::InvalidInput,
            format!("文件超过 {} 字节限制", max_bytes),
        ));
    }
    Ok(read)
}

pub async fn write_container_file(
    session: &SshSession,
    container_id: &str,
    path: &str,
    data: Vec<u8>,
) -> OmniResult<()> {
    // 上传到远端临时文件，再用 `docker cp` 复制进容器。
    let remote_tmp = format!("/tmp/omnipanel-cp-{}.bin", uuid_like());
    session
        .sftp_upload(&remote_tmp, &data)
        .await
        .map_err(|e| e.with_cause("上传到远端临时文件失败"))?;
    let cmd = format!(
        "docker cp {} {}:{}",
        shell_quote(&remote_tmp),
        container_id,
        shell_quote(path)
    );
    let out = session.exec_capture(&cmd).await;
    let _ = session
        .exec_capture(&format!("rm -f {}", shell_quote(&remote_tmp)))
        .await;
    out?.ok_or_err("写入容器内文件失败")?;
    Ok(())
}

// ── Swarm (docker swarm / service / node / stack) ────────────────────────

pub async fn swarm_init(
    session: &SshSession,
    listen_addr: Option<&str>,
    advertise_addr: Option<&str>,
) -> OmniResult<String> {
    let listen = listen_addr.unwrap_or("0.0.0.0:2377");
    let mut cmd = format!("docker swarm init --listen-addr {}", shell_quote(listen));
    if let Some(adv) = advertise_addr {
        cmd.push_str(&format!(" --advertise-addr {}", shell_quote(adv)));
    }
    let out = session.exec_capture(&cmd).await?;
    let out = out.ok_or_err("初始化 Swarm 失败")?;
    Ok(out.stdout.trim().to_string())
}

pub async fn swarm_join(
    session: &SshSession,
    remote_addrs: Vec<String>,
    token: &str,
    listen_addr: Option<&str>,
) -> OmniResult<()> {
    let listen = listen_addr.unwrap_or("0.0.0.0:2377");
    let addrs = remote_addrs.join(",");
    let cmd = format!(
        "docker swarm join --listen-addr {} --token {} {}",
        shell_quote(listen),
        shell_quote(token),
        shell_quote(&addrs)
    );
    let out = session.exec_capture(&cmd).await?;
    let _out = out.ok_or_err("加入 Swarm 失败")?;
    Ok(())
}

pub async fn swarm_leave(session: &SshSession, force: bool) -> OmniResult<()> {
    let cmd = if force {
        "docker swarm leave --force"
    } else {
        "docker swarm leave"
    };
    let out = session.exec_capture(cmd).await?;
    let _out = out.ok_or_err("离开 Swarm 失败")?;
    Ok(())
}

pub async fn swarm_inspect(session: &SshSession) -> OmniResult<serde_json::Value> {
    let out = session
        .exec_capture("docker info --format '{{json .Swarm}}'")
        .await?;
    let out = out.ok_or_err("查看 Swarm 信息失败")?;
    serde_json::from_str(&out.stdout).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析 Swarm 信息失败").with_cause(e.to_string())
    })
}

pub async fn service_list(session: &SshSession) -> OmniResult<Vec<DockerServiceSummary>> {
    let fmt = "{{.ID}}\t{{.Name}}\t{{.Image}}\t{{.Mode}}\t{{.Replicas}}\t{{.Ports}}\t{{.CreatedAt}}\t{{.UpdatedAt}}";
    let out = session
        .exec_capture(&format!("docker service ls --format '{}'", fmt))
        .await?;
    let out = out.ok_or_err("列出服务失败")?;
    let mut services = Vec::new();
    for line in out.stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 8 {
            let replicas_str = parts[4].split('/').next().unwrap_or("0");
            services.push(DockerServiceSummary {
                id: parts[0].to_string(),
                name: parts[1].to_string(),
                image: parts[2].to_string(),
                mode: parts[3].to_string(),
                replicas: replicas_str.parse::<u64>().unwrap_or(0),
                running_replicas: replicas_str.parse::<u64>().unwrap_or(0),
                ports: parts[5]
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                created_at: parts[6].to_string(),
                updated_at: parts[7].to_string(),
            });
        }
    }
    Ok(services)
}

pub async fn service_create(
    session: &SshSession,
    req: &DockerCreateServiceRequest,
) -> OmniResult<String> {
    let mut cmd = format!(
        "docker service create --name {} --replicas {}",
        shell_quote(&req.name),
        req.replicas
    );
    for port in &req.ports {
        cmd.push_str(&format!(" -p {}", shell_quote(port)));
    }
    for env in &req.env {
        cmd.push_str(&format!(" -e {}", shell_quote(env)));
    }
    for net in &req.networks {
        cmd.push_str(&format!(" --network {}", shell_quote(net)));
    }
    if let Some(c) = &req.command {
        cmd.push_str(&format!(" -- {}", shell_quote(c)));
    }
    cmd.push(' ');
    cmd.push_str(&shell_quote(&req.image));
    let out = session.exec_capture(&cmd).await?;
    let out = out.ok_or_err("创建服务失败")?;
    Ok(out.stdout.trim().to_string())
}

pub async fn service_update(
    session: &SshSession,
    id: &str,
    replicas: Option<u64>,
    image: Option<&str>,
) -> OmniResult<()> {
    let mut cmd = String::from("docker service update");
    if let Some(r) = replicas {
        cmd.push_str(&format!(" --replicas {}", r));
    }
    if let Some(img) = image {
        cmd.push_str(&format!(" --image {}", shell_quote(img)));
    }
    cmd.push(' ');
    cmd.push_str(&shell_quote(id));
    let out = session.exec_capture(&cmd).await?;
    let _out = out.ok_or_err("更新服务失败")?;
    Ok(())
}

pub async fn service_remove(session: &SshSession, id: &str) -> OmniResult<()> {
    let out = session
        .exec_capture(&format!("docker service rm {}", shell_quote(id)))
        .await?;
    let _out = out.ok_or_err("删除服务失败")?;
    Ok(())
}

pub async fn service_logs(
    session: &SshSession,
    id: &str,
    tail: Option<&str>,
) -> OmniResult<String> {
    let tail_val = tail.unwrap_or("200");
    let cmd = format!(
        "docker service logs --tail {} {}",
        shell_quote(tail_val),
        shell_quote(id)
    );
    let out = session.exec_capture(&cmd).await?;
    let out = out.ok_or_err("服务日志获取失败")?;
    Ok(out.stdout)
}

pub async fn node_list(session: &SshSession) -> OmniResult<Vec<DockerNodeSummary>> {
    let fmt = "{{.ID}}\t{{.Hostname}}\t{{.Status}}\t{{.Availability}}\t{{.EngineVersion}}\t{{.ManagerStatus}}";
    let out = session
        .exec_capture(&format!("docker node ls --format '{}'", fmt))
        .await?;
    let out = out.ok_or_err("列出节点失败")?;
    let mut nodes = Vec::new();
    for line in out.stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 6 {
            let role = if parts[5].contains("Leader") || parts[5].contains("Reachable") {
                "manager"
            } else {
                "worker"
            };
            nodes.push(DockerNodeSummary {
                id: parts[0].to_string(),
                hostname: parts[1].to_string(),
                status: parts[2].to_string(),
                availability: parts[3].to_string(),
                role: role.to_string(),
                engine_version: parts[4].to_string(),
                addr: String::new(),
                labels: Vec::new(),
            });
        }
    }
    Ok(nodes)
}

pub async fn node_inspect(session: &SshSession, id: &str) -> OmniResult<serde_json::Value> {
    let out = session
        .exec_capture(&format!("docker node inspect {}", shell_quote(id)))
        .await?;
    let out = out.ok_or_err("查看节点失败")?;
    serde_json::from_str(&out.stdout).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "解析节点信息失败").with_cause(e.to_string())
    })
}

pub async fn node_update(
    session: &SshSession,
    id: &str,
    availability: Option<&str>,
    labels: Option<Vec<DockerKeyValue>>,
) -> OmniResult<()> {
    let mut cmd = String::from("docker node update");
    if let Some(avail) = availability {
        cmd.push_str(&format!(" --availability {}", shell_quote(avail)));
    }
    if let Some(lbls) = labels {
        for l in lbls {
            cmd.push_str(&format!(
                " --label-add {}={}",
                shell_quote(&l.key),
                shell_quote(&l.value)
            ));
        }
    }
    cmd.push(' ');
    cmd.push_str(&shell_quote(id));
    let out = session.exec_capture(&cmd).await?;
    let _out = out.ok_or_err("更新节点失败")?;
    Ok(())
}

pub async fn node_remove(session: &SshSession, id: &str, force: bool) -> OmniResult<()> {
    let cmd = if force {
        format!("docker node rm --force {}", shell_quote(id))
    } else {
        format!("docker node rm {}", shell_quote(id))
    };
    let out = session.exec_capture(&cmd).await?;
    let _out = out.ok_or_err("删除节点失败")?;
    Ok(())
}

pub async fn stack_deploy(
    session: &SshSession,
    name: &str,
    compose_content: &str,
    _env: Option<Vec<String>>,
) -> OmniResult<()> {
    let remote_path = format!("/tmp/omnipanel-stack-{}.yml", uuid_like());
    session
        .sftp_upload(&remote_path, compose_content.as_bytes())
        .await
        .map_err(|e| e.with_cause("上传 compose 文件失败"))?;
    let cmd = format!(
        "docker stack deploy -c {} {}",
        shell_quote(&remote_path),
        shell_quote(name)
    );
    let out = session.exec_capture(&cmd).await;
    let _ = session
        .exec_capture(&format!("rm -f {}", shell_quote(&remote_path)))
        .await;
    let _out = out?.ok_or_err("部署 Stack 失败")?;
    Ok(())
}

pub async fn stack_list(session: &SshSession) -> OmniResult<Vec<DockerStackSummary>> {
    let fmt = "{{.Name}}\t{{.Services}}\t{{.Orchestrator}}\t{{.Namespace}}";
    let out = session
        .exec_capture(&format!("docker stack ls --format '{}'", fmt))
        .await?;
    let out = out.ok_or_err("列出 Stack 失败")?;
    let mut stacks = Vec::new();
    for line in out.stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 4 {
            stacks.push(DockerStackSummary {
                name: parts[0].to_string(),
                services: parts[1].parse::<u32>().unwrap_or(0),
                orchestrator: parts[2].to_string(),
                namespace: parts[3].to_string(),
            });
        }
    }
    Ok(stacks)
}

pub async fn stack_remove(session: &SshSession, name: &str) -> OmniResult<()> {
    let out = session
        .exec_capture(&format!("docker stack rm {}", shell_quote(name)))
        .await?;
    let _out = out.ok_or_err("删除 Stack 失败")?;
    Ok(())
}

pub async fn stack_services(
    session: &SshSession,
    name: &str,
) -> OmniResult<Vec<DockerServiceSummary>> {
    let fmt = "{{.ID}}\t{{.Name}}\t{{.Image}}\t{{.Mode}}\t{{.Replicas}}\t{{.Ports}}\t{{.CreatedAt}}\t{{.UpdatedAt}}";
    let out = session
        .exec_capture(&format!(
            "docker stack services {} --format '{}'",
            shell_quote(name),
            fmt
        ))
        .await?;
    let out = out.ok_or_err("列出 Stack 服务失败")?;
    let mut services = Vec::new();
    for line in out.stdout.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 8 {
            let replicas_str = parts[4].split('/').next().unwrap_or("0");
            services.push(DockerServiceSummary {
                id: parts[0].to_string(),
                name: parts[1].to_string(),
                image: parts[2].to_string(),
                mode: parts[3].to_string(),
                replicas: replicas_str.parse::<u64>().unwrap_or(0),
                running_replicas: replicas_str.parse::<u64>().unwrap_or(0),
                ports: parts[5]
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect(),
                created_at: parts[6].to_string(),
                updated_at: parts[7].to_string(),
            });
        }
    }
    Ok(services)
}
