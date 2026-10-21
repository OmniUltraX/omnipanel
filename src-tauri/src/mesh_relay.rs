//! 内网资源经添加设备转发。
//!
//! 公网地址直接拨。内网地址（RFC1918、回环、链路本地、IPv6 ULA）不先直连：
//! 两个局域网可以有同一个 192.168.1.10。成员连到添加设备的 tailnet 地址，
//! 由那台设备拨真正的目标。Tailscale 不负责网段路由。
//! 添加设备离线或已离开该内网时，资源不可达，不改找其他成员。

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, OnceLock};

use omnipanel_error::{ErrorCode, OmniError};
use omnipanel_ssh::with_ssh_dial;
use omnipanel_store::{active_team_scope, creator_device_name, origin_device_id};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex;
use tracing::warn;

use crate::commands::auth::{current_device_id, current_device_name};
use crate::commands::mesh::{MESH_LISTEN_PORT, mesh_hostname};

static DEVICES: OnceLock<Arc<Mutex<HashMap<i64, Arc<tailscale::Device>>>>> = OnceLock::new();

#[derive(Clone, PartialEq, Eq, Hash)]
struct ForwardKey {
    team_id: i64,
    origin: String,
    host: String,
    port: u16,
}

static FORWARDS: OnceLock<Mutex<HashMap<ForwardKey, u16>>> = OnceLock::new();

pub(crate) fn mesh_devices() -> &'static Arc<Mutex<HashMap<i64, Arc<tailscale::Device>>>> {
    DEVICES.get_or_init(|| Arc::new(Mutex::new(HashMap::new())))
}

fn forwards() -> &'static Mutex<HashMap<ForwardKey, u16>> {
    FORWARDS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub(crate) async fn register_mesh_device(team_id: i64, device: Arc<tailscale::Device>) {
    mesh_devices().lock().await.insert(team_id, device);
}

pub(crate) async fn unregister_mesh_device(team_id: i64) {
    mesh_devices().lock().await.remove(&team_id);
}

pub(crate) async fn clear_mesh_devices() {
    mesh_devices().lock().await.clear();
}

/// 只允许把流量转到内网地址，避免这台设备变成公网代理。
/// Tailscale CGNAT（100.64.0.0/10）不算内网跳板目标。
pub(crate) fn is_intranet_host(host: &str) -> bool {
    let Ok(ip) = host.trim().parse::<IpAddr>() else {
        return false;
    };
    match ip {
        IpAddr::V4(v4) => is_v4_intranet(v4),
        IpAddr::V6(v6) => is_v6_intranet(v6),
    }
}

fn is_v4_intranet(ip: Ipv4Addr) -> bool {
    if ip.is_loopback() || ip.is_link_local() {
        return true;
    }
    let o = ip.octets();
    if o[0] == 10 {
        return true;
    }
    if o[0] == 172 && (16..=31).contains(&o[1]) {
        return true;
    }
    if o[0] == 192 && o[1] == 168 {
        return true;
    }
    false
}

fn is_v6_intranet(ip: Ipv6Addr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    let o = ip.octets();
    if o[0] == 0xfe && (o[1] & 0xc0) == 0x80 {
        return true;
    }
    (o[0] & 0xfe) == 0xfc
}

fn active_team_id() -> Option<i64> {
    let scope = active_team_scope();
    scope.parse::<i64>().ok().filter(|id| *id > 0)
}

/// 决定实际拨号地址。直接拨时返回原来的 host/port。
pub(crate) async fn rewrite_dial(
    host: &str,
    port: u16,
    tags: &[String],
) -> Result<(String, u16), OmniError> {
    let host = host.trim();
    if host.is_empty() || !is_intranet_host(host) {
        return Ok((host.to_string(), port));
    }
    let Some(team_id) = active_team_id() else {
        return Ok((host.to_string(), port));
    };

    let self_id = current_device_id().unwrap_or_default();
    if let Some(origin) = origin_device_id(tags) {
        if !self_id.is_empty() && origin == self_id {
            return Ok((host.to_string(), port));
        }
        let local_port = ensure_forward(team_id, &origin, host, port).await?;
        return Ok(("127.0.0.1".to_string(), local_port));
    }

    if let Some(creator) = creator_device_name(tags) {
        if creator.eq_ignore_ascii_case(current_device_name().trim()) {
            return Ok((host.to_string(), port));
        }
        return Err(OmniError::new(
            ErrorCode::Connection,
            "内网资源还没有绑定创建设备，请在添加它的那台设备上重新保存一次",
        ));
    }

    Err(OmniError::new(
        ErrorCode::Connection,
        "内网资源缺少创建设备标记，无法经添加设备转发",
    ))
}

/// SSH 拨号：逻辑主机名不变，TCP 走跳板监听。
pub(crate) async fn ssh_connect_rewritten<F: std::future::Future>(
    host: &str,
    port: u16,
    tags: &[String],
    connect: F,
) -> Result<F::Output, OmniError> {
    let (dial_host, dial_port) = rewrite_dial(host, port, tags).await?;
    if dial_host == host.trim() && dial_port == port {
        Ok(connect.await)
    } else {
        Ok(with_ssh_dial(dial_host, dial_port, connect).await)
    }
}

async fn ensure_forward(
    team_id: i64,
    origin: &str,
    host: &str,
    port: u16,
) -> Result<u16, OmniError> {
    let key = ForwardKey {
        team_id,
        origin: origin.to_string(),
        host: host.to_string(),
        port,
    };
    let mut guard = forwards().lock().await;
    if let Some(local_port) = guard.get(&key).copied() {
        return Ok(local_port);
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| {
        OmniError::new(ErrorCode::Connection, "跳板本地监听失败").with_cause(e.to_string())
    })?;
    let local_port = listener
        .local_addr()
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "读取跳板端口失败").with_cause(e.to_string())
        })?
        .port();
    guard.insert(key, local_port);
    drop(guard);

    let origin = origin.to_string();
    let host = host.to_string();
    tokio::spawn(async move {
        loop {
            match listener.accept().await {
                Ok((inbound, _)) => {
                    let origin = origin.clone();
                    let host = host.clone();
                    tokio::spawn(async move {
                        if let Err(e) = splice_one(inbound, team_id, &origin, &host, port).await {
                            warn!(error = %e, team_id, "内网跳板转发失败");
                        }
                    });
                }
                Err(e) => {
                    warn!(error = %e, "跳板本地 accept 失败");
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    });
    Ok(local_port)
}

async fn splice_one(
    mut inbound: TcpStream,
    team_id: i64,
    origin: &str,
    host: &str,
    port: u16,
) -> Result<(), OmniError> {
    let mut upstream = open_tcp_relay(team_id, origin, host, port).await?;
    let _ = tokio::io::copy_bidirectional(&mut inbound, &mut upstream).await;
    Ok(())
}

pub(crate) async fn connect_team_peer(
    team_id: i64,
    origin: &str,
) -> Result<tailscale::netstack::TcpStream, OmniError> {
    let device = {
        let map = mesh_devices().lock().await;
        map.get(&team_id)
            .cloned()
            .ok_or_else(|| OmniError::new(ErrorCode::Connection, "本机尚未加入该团队 mesh"))?
    };
    let hostname = mesh_hostname(origin);
    let peer = device
        .peer_by_name(&hostname)
        .await
        .map_err(|e| {
            OmniError::new(ErrorCode::Connection, "查找添加设备失败").with_cause(e.to_string())
        })?
        .ok_or_else(|| OmniError::new(ErrorCode::Connection, "添加该资源的设备不在线"))?;
    let ip = node_ip(&peer)
        .ok_or_else(|| OmniError::new(ErrorCode::Connection, "添加设备没有 tailnet 地址"))?;
    let remote = SocketAddr::new(ip, MESH_LISTEN_PORT);
    tokio::time::timeout(
        std::time::Duration::from_secs(12),
        device.tcp_connect(remote),
    )
    .await
    .map_err(|_| OmniError::new(ErrorCode::Timeout, "连接添加设备超时"))?
    .map_err(|e| {
        OmniError::new(ErrorCode::Connection, "连接添加设备失败").with_cause(e.to_string())
    })
}

async fn open_tcp_relay(
    team_id: i64,
    origin: &str,
    host: &str,
    port: u16,
) -> Result<tailscale::netstack::TcpStream, OmniError> {
    let mut stream = connect_team_peer(team_id, origin).await?;
    let req = serde_json::json!({
        "v": 1,
        "op": "tcp-relay",
        "teamId": team_id,
        "host": host,
        "port": port,
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
            .filter(|s| !s.is_empty())
            .unwrap_or("添加设备拒绝转发")
            .to_string(),
    ))
}

pub(crate) async fn write_json_line(
    stream: &mut tailscale::netstack::TcpStream,
    value: &serde_json::Value,
) -> Result<(), OmniError> {
    let line = serde_json::to_string(value).map_err(|e| {
        OmniError::new(ErrorCode::Internal, "序列化 mesh 请求失败").with_cause(e.to_string())
    })?;
    stream.write_all(line.as_bytes()).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 mesh 请求失败").with_cause(e.to_string())
    })?;
    stream.write_all(b"\n").await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 mesh 请求失败").with_cause(e.to_string())
    })?;
    stream.flush().await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "写入 mesh 请求失败").with_cause(e.to_string())
    })?;
    Ok(())
}

pub(crate) async fn read_json_line(
    stream: &mut tailscale::netstack::TcpStream,
) -> Result<serde_json::Value, OmniError> {
    let resp = read_line_exact(stream).await.map_err(|e| {
        OmniError::new(ErrorCode::Io, "读取 mesh 响应失败").with_cause(e.to_string())
    })?;
    serde_json::from_str(resp.trim())
        .map_err(|e| OmniError::new(ErrorCode::Internal, "mesh 响应无效").with_cause(e.to_string()))
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

async fn read_line_exact<R: AsyncReadExt + Unpin>(stream: &mut R) -> io::Result<String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let n = stream.read(&mut byte).await?;
        if n == 0 {
            break;
        }
        line.push(byte[0]);
        if byte[0] == b'\n' || line.len() > 8192 {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

#[cfg(test)]
mod tests {
    use super::is_intranet_host;

    #[test]
    fn classifies_intranet_without_cgnat() {
        assert!(is_intranet_host("10.1.2.3"));
        assert!(is_intranet_host("172.16.0.1"));
        assert!(is_intranet_host("172.31.255.255"));
        assert!(!is_intranet_host("172.32.0.1"));
        assert!(is_intranet_host("192.168.1.10"));
        assert!(is_intranet_host("127.0.0.1"));
        assert!(is_intranet_host("169.254.1.1"));
        assert!(!is_intranet_host("100.64.0.1"));
        assert!(!is_intranet_host("8.8.8.8"));
        assert!(!is_intranet_host("db.internal"));
        assert!(is_intranet_host("::1"));
        assert!(is_intranet_host("fd00::1"));
        assert!(is_intranet_host("fe80::1"));
        assert!(!is_intranet_host("2001:4860:4860::8888"));
    }
}
