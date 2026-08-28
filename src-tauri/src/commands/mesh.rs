//! 团队 mesh：进程内 tailscale-rs Device，同团队设备 TCP 互通。
//! 第一批业务：同步密钥走 :42424，失败由前端回退 HTTP 中继。

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use omnipanel_error::{ErrorCode, OmniError};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{Manager, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tracing::{info, warn};

use crate::commands::sync_team_key::sync_team_key_wrap_for_relay;
use crate::state::AppState;

pub const MESH_LISTEN_PORT: u16 = 42424;
const TS_RS_EXPERIMENT: &str = "this_is_unstable_software";

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MeshStatus {
    pub online: bool,
    #[specta(type = f64)]
    pub team_id: i64,
    pub hostname: String,
    pub ipv4: String,
    pub listen_port: u16,
}

pub struct MeshHandle {
    pub team_id: i64,
    pub hostname: String,
    pub ipv4: String,
    device: Arc<tailscale::Device>,
    listen_task: tokio::task::JoinHandle<()>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MeshSyncKeyRequest {
    v: Option<u32>,
    op: Option<String>,
    team_id: i64,
    request_id: String,
    ephemeral_pubkey: String,
    requester_device_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeshSyncKeyOk {
    ok: bool,
    wrapped_key: String,
    wrap_alg: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MeshSyncKeyErr {
    ok: bool,
    error: String,
}

pub fn ensure_tailscale_experiment() {
    const KEY: &str = "TS_RS_EXPERIMENT";
    match std::env::var(KEY) {
        Ok(v) if v == TS_RS_EXPERIMENT => {}
        _ => unsafe {
            std::env::set_var(KEY, TS_RS_EXPERIMENT);
        },
    }
}

/// 把 OmniPanel deviceId 收成 Headscale 主机名；与 omniserver `headscale.Hostname` 一致。
pub fn mesh_hostname(device_id: &str) -> String {
    let mut out = String::from("op-");
    let mut n = 0usize;
    for ch in device_id.trim().chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() {
            out.push(lower);
            n += 1;
            if n >= 48 {
                break;
            }
        }
    }
    if n == 0 {
        out.push_str("unknown");
    }
    out
}

#[tauri::command]
#[specta::specta]
pub async fn mesh_start(
    state: State<'_, AppState>,
    team_id: i64,
    auth_key: String,
    control_server_url: String,
    hostname: String,
) -> Result<MeshStatus, OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let auth_key = auth_key.trim().to_string();
    let control_server_url = control_server_url.trim().to_string();
    let hostname = {
        let h = hostname.trim().to_string();
        if h.is_empty() {
            mesh_hostname("")
        } else {
            h
        }
    };
    if auth_key.is_empty() || control_server_url.is_empty() {
        return Err(OmniError::invalid_input("mesh 入网凭证不完整"));
    }

    {
        let guard = state.mesh.lock().await;
        if let Some(cur) = guard.as_ref() {
            if cur.team_id == team_id && cur.hostname == hostname {
                return Ok(status_from(cur));
            }
        }
    }
    mesh_stop_inner(&state).await;

    ensure_tailscale_experiment();

    let dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| {
            OmniError::new(ErrorCode::Storage, "无法定位应用数据目录").with_cause(e.to_string())
        })?
        .join("mesh")
        .join(format!("team-{team_id}"));
    std::fs::create_dir_all(&dir).map_err(|e| {
        OmniError::new(ErrorCode::Storage, "创建 mesh 状态目录失败").with_cause(e.to_string())
    })?;
    let key_file = dir.join("tsrs_keys.json");

    let control_url = control_server_url.parse::<url::Url>().map_err(|e| {
        OmniError::invalid_input("Headscale 地址无效").with_cause(e.to_string())
    })?;

    let mut config = tailscale::Config::default_with_key_file(&key_file)
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "初始化 Tailscale 配置失败")
                .with_cause(e.to_string())
        })?;
    config.control_server_url = control_url;
    config.requested_hostname = Some(hostname.clone());
    config.ephemeral = true;
    config.client_name = Some("omnipanel".into());

    let device = tailscale::Device::new(&config, Some(auth_key))
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "加入团队 mesh 失败").with_cause(e.to_string())
        })?;

    let ipv4 = match tokio::time::timeout(Duration::from_secs(25), device.ipv4_addr()).await {
        Ok(Ok(ip)) => ip.to_string(),
        Ok(Err(e)) => {
            warn!(error = %e, "mesh 尚未拿到 IPv4");
            String::new()
        }
        Err(_) => {
            warn!("mesh 等待 IPv4 超时");
            String::new()
        }
    };

    let device = Arc::new(device);
    let listen_device = device.clone();
    let listen_team = team_id;
    let listen_task = tokio::spawn(async move {
        if let Err(e) = serve_sync_key(listen_device, listen_team).await {
            warn!(error = %e, team_id = listen_team, "mesh TCP 监听退出");
        }
    });

    info!(team_id, hostname = %hostname, ipv4 = %ipv4, "团队 mesh 已启动");
    let handle = MeshHandle {
        team_id,
        hostname,
        ipv4,
        device,
        listen_task,
    };
    let status = status_from(&handle);
    *state.mesh.lock().await = Some(handle);
    Ok(status)
}

#[tauri::command]
#[specta::specta]
pub async fn mesh_stop(state: State<'_, AppState>) -> Result<(), OmniError> {
    mesh_stop_inner(&state).await;
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn mesh_status(state: State<'_, AppState>) -> Result<MeshStatus, OmniError> {
    let guard = state.mesh.lock().await;
    match guard.as_ref() {
        Some(cur) => Ok(status_from(cur)),
        None => Ok(MeshStatus {
            online: false,
            team_id: 0,
            hostname: String::new(),
            ipv4: String::new(),
            listen_port: MESH_LISTEN_PORT,
        }),
    }
}

/// 向对端 hostname 请求封装后的团队同步密钥。
#[tauri::command]
#[specta::specta]
pub async fn mesh_request_sync_key(
    state: State<'_, AppState>,
    team_id: i64,
    peer_hostname: String,
    ephemeral_pubkey: String,
    request_id: String,
    requester_device_id: String,
) -> Result<String, OmniError> {
    if team_id <= 0 {
        return Err(OmniError::invalid_input("团队 ID 无效"));
    }
    let peer_hostname = peer_hostname.trim().to_string();
    if peer_hostname.is_empty() {
        return Err(OmniError::invalid_input("对端 hostname 无效"));
    }

    let device = {
        let guard = state.mesh.lock().await;
        let cur = guard.as_ref().ok_or_else(|| {
            OmniError::new(ErrorCode::Connection, "本机尚未加入团队 mesh")
        })?;
        if cur.team_id != team_id {
            return Err(OmniError::new(
                ErrorCode::InvalidInput,
                "当前 mesh 团队与请求不一致",
            ));
        }
        cur.device.clone()
    };

    let peer = device
        .peer_by_name(&peer_hostname)
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "查找 mesh 对端失败").with_cause(e.to_string())
        })?
        .ok_or_else(|| OmniError::new(ErrorCode::NotFound, "mesh 对端不在线"))?;

    let ip = node_ip(&peer).ok_or_else(|| {
        OmniError::new(ErrorCode::Connection, "对端没有 tailnet IP")
    })?;
    let remote = SocketAddr::new(ip, MESH_LISTEN_PORT);

    let req = serde_json::json!({
        "v": 1,
        "op": "sync-key",
        "teamId": team_id,
        "requestId": request_id.trim(),
        "ephemeralPubkey": ephemeral_pubkey.trim(),
        "requesterDeviceId": requester_device_id.trim(),
    });
    let line = serde_json::to_string(&req).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化 mesh 请求失败").with_cause(e.to_string())
    })?;

    let mut stream = tokio::time::timeout(Duration::from_secs(12), device.tcp_connect(remote))
        .await
        .map_err(|_| OmniError::new(ErrorCode::Timeout, "连接 mesh 对端超时"))?
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "连接 mesh 对端失败").with_cause(e.to_string())
        })?;

    tokio::time::timeout(Duration::from_secs(12), async {
        stream.write_all(line.as_bytes()).await?;
        stream.write_all(b"\n").await?;
        stream.flush().await?;
        let mut reader = BufReader::new(&mut stream);
        let mut resp = String::new();
        reader.read_line(&mut resp).await?;
        Ok::<String, std::io::Error>(resp)
    })
    .await
    .map_err(|_| OmniError::new(ErrorCode::Timeout, "等待 mesh 对端响应超时"))?
    .map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取 mesh 对端响应失败").with_cause(e.to_string())
    })
    .and_then(|resp| parse_wrapped_key(&resp))
}

async fn mesh_stop_inner(state: &AppState) {
    let Some(handle) = state.mesh.lock().await.take() else {
        return;
    };
    handle.listen_task.abort();
    let MeshHandle { device, hostname, team_id, .. } = handle;
    tokio::task::yield_now().await;
    if let Ok(dev) = Arc::try_unwrap(device) {
        let _ = tokio::time::timeout(
            Duration::from_secs(4),
            dev.shutdown(Some(Duration::from_secs(3))),
        )
        .await;
    }
    info!(team_id, hostname = %hostname, "团队 mesh 已停止");
}

fn status_from(handle: &MeshHandle) -> MeshStatus {
    MeshStatus {
        online: true,
        team_id: handle.team_id,
        hostname: handle.hostname.clone(),
        ipv4: handle.ipv4.clone(),
        listen_port: MESH_LISTEN_PORT,
    }
}

fn node_ip(peer: &tailscale::NodeInfo) -> Option<IpAddr> {
    let v4 = peer.tailnet_address.ipv4.addr();
    if !v4.is_unspecified() {
        return Some(IpAddr::V4(v4));
    }
    let v6 = peer.tailnet_address.ipv6.addr();
    if !v6.is_unspecified() {
        return Some(IpAddr::V6(v6));
    }
    None
}

fn parse_wrapped_key(resp: &str) -> Result<String, OmniError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Resp {
        ok: Option<bool>,
        wrapped_key: Option<String>,
        error: Option<String>,
    }
    let parsed: Resp = serde_json::from_str(resp.trim()).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "mesh 对端响应无效").with_cause(e.to_string())
    })?;
    if parsed.ok == Some(true) {
        let key = parsed.wrapped_key.unwrap_or_default();
        if key.trim().is_empty() {
            return Err(OmniError::new(ErrorCode::Internal, "mesh 对端未返回密钥"));
        }
        return Ok(key);
    }
    Err(OmniError::new(
        ErrorCode::Connection,
        parsed
            .error
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "mesh 对端拒绝传钥".to_string()),
    ))
}

async fn serve_sync_key(device: Arc<tailscale::Device>, team_id: i64) -> Result<(), OmniError> {
    let ip = device.ipv4_addr().await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "等待 mesh IPv4 失败").with_cause(e.to_string())
    })?;
    let bind = SocketAddr::new(IpAddr::V4(ip), MESH_LISTEN_PORT);
    let listener = device.tcp_listen(bind).await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "mesh TCP 监听失败").with_cause(e.to_string())
    })?;
    info!(%bind, team_id, "mesh TCP 已监听");
    loop {
        match listener.accept().await {
            Ok(stream) => {
                tokio::spawn(async move {
                    if let Err(e) = handle_sync_key_conn(stream, team_id).await {
                        warn!(error = %e, "mesh 传钥连接失败");
                    }
                });
            }
            Err(e) => {
                warn!(error = %e, "mesh accept 失败");
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    }
}

async fn handle_sync_key_conn(
    mut stream: tailscale::netstack::TcpStream,
    expected_team_id: i64,
) -> Result<(), OmniError> {
    let req = tokio::time::timeout(Duration::from_secs(10), async {
        let mut reader = BufReader::new(&mut stream);
        let mut line = String::new();
        reader.read_line(&mut line).await?;
        Ok::<String, std::io::Error>(line)
    })
    .await
    .map_err(|_| OmniError::new(ErrorCode::Timeout, "读取 mesh 请求超时"))?
    .map_err(|e| OmniError::new(ErrorCode::Io, "读取 mesh 请求失败").with_cause(e.to_string()))?;

    let parsed: MeshSyncKeyRequest = match serde_json::from_str(req.trim()) {
        Ok(v) => v,
        Err(e) => {
            write_json_line(
                &mut stream,
                &MeshSyncKeyErr {
                    ok: false,
                    error: format!("invalid json: {e}"),
                },
            )
            .await?;
            return Ok(());
        }
    };
    if parsed.op.as_deref().unwrap_or("sync-key") != "sync-key" {
        write_json_line(
            &mut stream,
            &MeshSyncKeyErr {
                ok: false,
                error: "unsupported op".into(),
            },
        )
        .await?;
        return Ok(());
    }
    if parsed.v.unwrap_or(1) != 1 {
        write_json_line(
            &mut stream,
            &MeshSyncKeyErr {
                ok: false,
                error: "unsupported version".into(),
            },
        )
        .await?;
        return Ok(());
    }
    if parsed.team_id != expected_team_id {
        write_json_line(
            &mut stream,
            &MeshSyncKeyErr {
                ok: false,
                error: "team mismatch".into(),
            },
        )
        .await?;
        return Ok(());
    }

    match sync_team_key_wrap_for_relay(
        parsed.team_id,
        parsed.ephemeral_pubkey,
        parsed.request_id,
        parsed.requester_device_id,
    ) {
        Ok(wrapped) => {
            write_json_line(
                &mut stream,
                &MeshSyncKeyOk {
                    ok: true,
                    wrapped_key: wrapped,
                    wrap_alg: omnipanel_store::WRAP_ALG.to_string(),
                },
            )
            .await?;
        }
        Err(e) => {
            write_json_line(
                &mut stream,
                &MeshSyncKeyErr {
                    ok: false,
                    error: e.message,
                },
            )
            .await?;
        }
    }
    Ok(())
}

async fn write_json_line<T: Serialize>(
    stream: &mut tailscale::netstack::TcpStream,
    value: &T,
) -> Result<(), OmniError> {
    let mut line = serde_json::to_vec(value).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化 mesh 响应失败").with_cause(e.to_string())
    })?;
    line.push(b'\n');
    stream.write_all(&line).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 mesh 响应失败").with_cause(e.to_string())
    })?;
    stream.flush().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "flush mesh 响应失败").with_cause(e.to_string())
    })?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::mesh_hostname;

    #[test]
    fn hostname_strips_and_prefixes() {
        assert_eq!(mesh_hostname(""), "op-unknown");
        assert_eq!(mesh_hostname("abc-DEF_12"), "op-abcdef12");
    }
}
