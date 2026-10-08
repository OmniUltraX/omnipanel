//! 本机 Docker 分享到指定团队。默认关闭，不写入模块快照。
//! 其他成员看到的是「某人 · 某设备的 Docker」，操作经 mesh 打到这台机器的 Engine。
//! 设备离线或开关关闭时不可用。

use std::path::PathBuf;
use std::sync::Mutex;

use omnipanel_docker::{DockerConnectionInfo, DockerConnectionSource, DockerConnectionStatus};
use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

use crate::mesh_relay::{connect_team_peer, read_json_line, write_json_line};
use crate::state::AppState;

const FILE_NAME: &str = "docker-team-share.json";
const PREFIX: &str = "docker-mesh:";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ShareFile {
    #[serde(default)]
    team_ids: Vec<i64>,
    #[serde(default)]
    owner_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DockerSharePeer {
    pub device_id: String,
    pub device_name: String,
}

static FILE_LOCK: Mutex<()> = Mutex::new(());

fn share_path(app: &AppHandle) -> Result<PathBuf, OmniError> {
    let dir = app.path().app_data_dir().map_err(|e| {
        OmniError::new(ErrorCode::Storage, "无法定位应用数据目录").with_cause(e.to_string())
    })?;
    Ok(dir.join(FILE_NAME))
}

fn load_file(app: &AppHandle) -> ShareFile {
    let Ok(path) = share_path(app) else {
        return ShareFile::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return ShareFile::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_file(app: &AppHandle, file: &ShareFile) -> Result<(), OmniError> {
    let path = share_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            OmniError::new(ErrorCode::Storage, "创建分享配置目录失败").with_cause(e.to_string())
        })?;
    }
    let text = serde_json::to_string_pretty(file).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化 Docker 分享配置失败").with_cause(e.to_string())
    })?;
    std::fs::write(path, text).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "保存 Docker 分享配置失败").with_cause(e.to_string())
    })
}

pub(crate) fn team_share_enabled(app: &AppHandle, team_id: i64) -> bool {
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    load_file(app).team_ids.contains(&team_id)
}

pub fn mesh_docker_connection_id(team_id: i64, device_id: &str) -> String {
    format!("{PREFIX}{team_id}:{device_id}")
}

pub fn parse_mesh_docker_connection_id(id: &str) -> Option<(i64, String)> {
    let rest = id.strip_prefix(PREFIX)?;
    let (team, device) = rest.split_once(':')?;
    let team_id = team.parse::<i64>().ok().filter(|id| *id > 0)?;
    let device_id = device.trim();
    if device_id.is_empty() {
        return None;
    }
    Some((team_id, device_id.to_string()))
}

#[tauri::command]
#[specta::specta]
pub async fn docker_local_team_share_get(
    state: State<'_, AppState>,
    team_id: i64,
) -> Result<bool, OmniError> {
    Ok(team_share_enabled(&state.app_handle, team_id))
}

#[tauri::command]
#[specta::specta]
pub async fn docker_local_team_share_set(
    state: State<'_, AppState>,
    team_id: i64,
    enabled: bool,
    owner_name: Option<String>,
) -> Result<(), OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut file = load_file(&state.app_handle);
    file.team_ids.retain(|id| *id != team_id);
    if enabled {
        file.team_ids.push(team_id);
    }
    if let Some(name) = owner_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        file.owner_name = name;
    }
    save_file(&state.app_handle, &file)
}

#[tauri::command]
#[specta::specta]
pub async fn docker_query_shared_engines(
    _state: State<'_, AppState>,
    team_id: i64,
    peers: Vec<DockerSharePeer>,
) -> Result<Vec<DockerConnectionInfo>, OmniError> {
    if team_id <= 0 {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for peer in peers {
        let device_id = peer.device_id.trim().to_string();
        if device_id.is_empty() {
            continue;
        }
        let info = query_one(team_id, &device_id, peer.device_name.trim()).await;
        if let Some(info) = info {
            out.push(info);
        }
    }
    Ok(out)
}

async fn query_one(
    team_id: i64,
    device_id: &str,
    fallback_name: &str,
) -> Option<DockerConnectionInfo> {
    let mut stream = connect_team_peer(team_id, device_id).await.ok()?;
    let req = serde_json::json!({
        "v": 1,
        "op": "docker-share-status",
        "teamId": team_id,
    });
    write_json_line(&mut stream, &req).await.ok()?;
    let resp = read_json_line(&mut stream).await.ok()?;
    if resp.get("ok").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    if resp.get("enabled").and_then(|v| v.as_bool()) != Some(true) {
        return None;
    }
    let device_name = resp
        .get("deviceName")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_name);
    let owner = resp
        .get("ownerName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let name = if owner.is_empty() {
        format!("{device_name} 的 Docker")
    } else {
        format!("{owner} · {device_name} 的 Docker")
    };
    Some(DockerConnectionInfo {
        connection_id: mesh_docker_connection_id(team_id, device_id),
        name,
        source: DockerConnectionSource::RemoteEngine,
        status: DockerConnectionStatus::Online,
        host_label: "团队共享 · 本机 Engine".to_string(),
        environment: "team".to_string(),
        engine_version: None,
        api_version: None,
        containers_running: 0,
        containers_total: 0,
        warning_message: None,
        bound_ssh_connection_id: None,
    })
}

pub(crate) async fn local_docker_port(team_id: i64, device_id: &str) -> Result<u16, OmniError> {
    ensure_docker_forward(team_id, device_id).await
}

async fn ensure_docker_forward(team_id: i64, origin: &str) -> Result<u16, OmniError> {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use tokio::net::TcpListener;
    use tokio::sync::Mutex as AsyncMutex;

    #[derive(Clone, PartialEq, Eq, Hash)]
    struct Key {
        team_id: i64,
        origin: String,
    }
    static PORTS: OnceLock<AsyncMutex<HashMap<Key, u16>>> = OnceLock::new();
    let ports = PORTS.get_or_init(|| AsyncMutex::new(HashMap::new()));
    let key = Key {
        team_id,
        origin: origin.to_string(),
    };
    let mut guard = ports.lock().await;
    if let Some(port) = guard.get(&key).copied() {
        return Ok(port);
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "Docker 跳板监听失败").with_cause(e.to_string())
    })?;
    let port = listener
        .local_addr()
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "读取 Docker 跳板端口失败")
                .with_cause(e.to_string())
        })?
        .port();
    guard.insert(key, port);
    drop(guard);
    let origin = origin.to_string();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((mut inbound, _)) => {
                    let origin = origin.clone();
                    tokio::spawn(async move {
                        if let Ok(mut upstream) = open_docker_proxy(team_id, &origin).await {
                            let _ =
                                tokio::io::copy_bidirectional(&mut inbound, &mut upstream).await;
                        }
                    });
                }
                Err(_) => {
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    });
    Ok(port)
}

async fn open_docker_proxy(
    team_id: i64,
    origin: &str,
) -> Result<tailscale::netstack::TcpStream, OmniError> {
    let mut stream = connect_team_peer(team_id, origin).await?;
    let req = serde_json::json!({
        "v": 1,
        "op": "docker-proxy",
        "teamId": team_id,
    });
    write_json_line(&mut stream, &req).await?;
    let resp = read_json_line(&mut stream).await?;
    if resp.get("ok").and_then(|v| v.as_bool()) == Some(true) {
        return Ok(stream);
    }
    Err(OmniError::new(
        ErrorCode::Connection,
        resp.get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("对方未分享 Docker")
            .to_string(),
    ))
}

pub(crate) async fn handle_docker_mesh_op(
    app: &AppHandle,
    mut stream: tailscale::netstack::TcpStream,
    expected_team_id: i64,
    value: &serde_json::Value,
) -> Result<(), OmniError> {
    let team_id = value.get("teamId").and_then(|v| v.as_i64()).unwrap_or(0);
    let op = value.get("op").and_then(|v| v.as_str()).unwrap_or("");
    if team_id != expected_team_id || !team_share_enabled(app, team_id) {
        write_mesh(
            &mut stream,
            &serde_json::json!({ "ok": false, "enabled": false, "error": "docker share off" }),
        )
        .await?;
        return Ok(());
    }
    if op == "docker-share-status" {
        let file = {
            let _guard = FILE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            load_file(app)
        };
        write_mesh(
            &mut stream,
            &serde_json::json!({
                "ok": true,
                "enabled": true,
                "deviceName": crate::commands::auth::current_device_name(),
                "ownerName": file.owner_name,
            }),
        )
        .await?;
        return Ok(());
    }
    if op == "docker-proxy" {
        match open_local_engine().await {
            Ok(mut engine) => {
                write_mesh(&mut stream, &serde_json::json!({ "ok": true })).await?;
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut engine).await;
            }
            Err(e) => {
                write_mesh(&mut stream, &serde_json::json!({ "ok": false, "error": e })).await?;
            }
        }
        return Ok(());
    }
    write_mesh(
        &mut stream,
        &serde_json::json!({ "ok": false, "error": "unsupported docker op" }),
    )
    .await?;
    Ok(())
}

async fn write_mesh(
    stream: &mut tailscale::netstack::TcpStream,
    value: &serde_json::Value,
) -> Result<(), OmniError> {
    let mut line = serde_json::to_vec(value).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化 Docker 分享响应失败").with_cause(e.to_string())
    })?;
    line.push(b'\n');
    stream.write_all(&line).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 Docker 分享响应失败").with_cause(e.to_string())
    })?;
    stream.flush().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 Docker 分享响应失败").with_cause(e.to_string())
    })?;
    Ok(())
}

async fn open_local_engine() -> Result<EnginePipe, String> {
    #[cfg(windows)]
    {
        let pipe = tokio::net::windows::named_pipe::ClientOptions::new()
            .open(r"\\.\pipe\docker_engine")
            .map_err(|e| format!("打开 Docker 管道失败: {e}"))?;
        return Ok(EnginePipe::Windows(pipe));
    }
    #[cfg(not(windows))]
    {
        let candidates = ["/var/run/docker.sock", "/run/docker.sock"];
        for path in candidates {
            if let Ok(sock) = tokio::net::UnixStream::connect(path).await {
                return Ok(EnginePipe::Unix(sock));
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            let desktop = std::path::PathBuf::from(home).join(".docker/run/docker.sock");
            if let Ok(sock) = tokio::net::UnixStream::connect(desktop).await {
                return Ok(EnginePipe::Unix(sock));
            }
        }
        Err("找不到本机 Docker socket".to_string())
    }
}

enum EnginePipe {
    #[cfg(windows)]
    Windows(tokio::net::windows::named_pipe::NamedPipeClient),
    #[cfg(not(windows))]
    Unix(tokio::net::UnixStream),
}

impl AsyncRead for EnginePipe {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(windows)]
            EnginePipe::Windows(pipe) => std::pin::Pin::new(pipe).poll_read(cx, buf),
            #[cfg(not(windows))]
            EnginePipe::Unix(sock) => std::pin::Pin::new(sock).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for EnginePipe {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            #[cfg(windows)]
            EnginePipe::Windows(pipe) => std::pin::Pin::new(pipe).poll_write(cx, buf),
            #[cfg(not(windows))]
            EnginePipe::Unix(sock) => std::pin::Pin::new(sock).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(windows)]
            EnginePipe::Windows(pipe) => std::pin::Pin::new(pipe).poll_flush(cx),
            #[cfg(not(windows))]
            EnginePipe::Unix(sock) => std::pin::Pin::new(sock).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            #[cfg(windows)]
            EnginePipe::Windows(pipe) => std::pin::Pin::new(pipe).poll_shutdown(cx),
            #[cfg(not(windows))]
            EnginePipe::Unix(sock) => std::pin::Pin::new(sock).poll_shutdown(cx),
        }
    }
}
