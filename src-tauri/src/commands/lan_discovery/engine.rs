//! UDP responder（常驻）与 scanner（弹窗会话）。

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use omnipanel_error::OmniError;
use tauri::{AppHandle, Emitter};
use tauri::async_runtime::JoinHandle;
use tokio::net::UdpSocket;
use tokio::sync::{Mutex, Notify};
use tokio::time::{Duration, interval};

use crate::commands::auth::auth_device_identity;

use super::protocol::{
    self, CANDIDATE_PORTS, DiscoveryMessage, PEER_TTL_MS, PROBE_INTERVAL_MS, PeerRecord,
    prune_stale, should_ignore_announce, upsert_peer,
};
use super::{LanDiscoveryPeer, LanDiscoveryPeersEvent, LanDiscoveryStatus};

const EVENT_PEERS: &str = "lan-discovery-peers";
const EVENT_SHARE_OFFER: &str = "lan-discovery-share-offer";
const UDP_RECV_BUF: usize = 65536;

struct ResponderState {
    ok: bool,
    listen_port: Option<u16>,
    error: Option<String>,
}

struct ScannerInner {
    stop: Arc<Notify>,
    handle: Option<JoinHandle<()>>,
    peers: HashMap<String, PeerRecord>,
}

pub struct LanDiscoveryService {
    app: AppHandle,
    responder: Arc<Mutex<ResponderState>>,
    scanner: Arc<Mutex<ScannerInner>>,
}

impl LanDiscoveryService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            responder: Arc::new(Mutex::new(ResponderState {
                ok: false,
                listen_port: None,
                error: None,
            })),
            scanner: Arc::new(Mutex::new(ScannerInner {
                stop: Arc::new(Notify::new()),
                handle: None,
                peers: HashMap::new(),
            })),
        }
    }

    pub fn spawn_responder(self: &Self) {
        let app = self.app.clone();
        let responder = self.responder.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = run_responder(app, responder).await {
                tracing::warn!("局域网发现 responder 退出: {e}");
            }
        });
    }

    pub async fn start_scan(&self) -> Result<(), OmniError> {
        let mut guard = self.scanner.lock().await;
        if guard.handle.is_some() {
            return Ok(());
        }
        guard.peers.clear();
        let stop = Arc::new(Notify::new());
        guard.stop = stop.clone();
        let app = self.app.clone();
        let scanner = self.scanner.clone();
        let handle = tauri::async_runtime::spawn(async move {
            if let Err(e) = run_scanner(app, scanner, stop).await {
                tracing::warn!("局域网发现 scanner 结束: {e}");
            }
        });
        guard.handle = Some(handle);
        emit_peers(&self.app, &[]);
        Ok(())
    }

    pub async fn stop_scan(&self) {
        let mut guard = self.scanner.lock().await;
        guard.stop.notify_waiters();
        if let Some(handle) = guard.handle.take() {
            handle.abort();
        }
        guard.peers.clear();
        emit_peers(&self.app, &[]);
    }

    pub async fn list_peers(&self) -> Vec<LanDiscoveryPeer> {
        let guard = self.scanner.lock().await;
        peers_to_dto(&guard.peers)
    }

    pub async fn status(&self) -> LanDiscoveryStatus {
        let r = self.responder.lock().await;
        let scanning = self.scanner.lock().await.handle.is_some();
        LanDiscoveryStatus {
            responder_ok: r.ok,
            listen_port: r.listen_port,
            error: r.error.clone(),
            scanning,
        }
    }

    /// 向对端 IP 的候选端口单播分享面板 JSON。
    pub async fn share_panel(&self, peer_ip: &str, panel_json: &str) -> Result<(), OmniError> {
        let ip: IpAddr = peer_ip.parse().map_err(|_| {
            OmniError::new(omnipanel_error::ErrorCode::InvalidInput, "无效的对端 IP")
        })?;
        if panel_json.len() > 512 * 1024 {
            return Err(OmniError::new(
                omnipanel_error::ErrorCode::InvalidInput,
                "面板数据过大，无法分享",
            ));
        }
        let identity = auth_device_identity().await?;
        let bytes = protocol::encode_share_panel(&identity.device_id, panel_json).map_err(|e| {
            OmniError::internal(format!("序列化分享报文失败: {e}"))
        })?;
        let sock = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)))
            .await
            .map_err(|e| OmniError::internal(format!("绑定分享 socket 失败: {e}")))?;
        let mut sent = 0usize;
        for port in CANDIDATE_PORTS {
            let addr = SocketAddr::new(ip, port);
            match sock.send_to(&bytes, addr).await {
                Ok(_) => sent += 1,
                Err(e) => tracing::debug!(%addr, "分享发送失败: {e}"),
            }
        }
        if sent == 0 {
            return Err(OmniError::new(
                omnipanel_error::ErrorCode::Connection,
                "无法向对端发送分享数据",
            ));
        }
        Ok(())
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn peers_to_dto(map: &HashMap<String, PeerRecord>) -> Vec<LanDiscoveryPeer> {
    let mut list: Vec<_> = map
        .values()
        .map(|p| LanDiscoveryPeer {
            id: p.id.clone(),
            name: p.name.clone(),
            ip: p.ip.clone(),
            version: p.version.clone(),
            os: p.os.clone(),
            last_seen: p.last_seen_ms,
        })
        .collect();
    list.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    list
}

fn emit_peers(app: &AppHandle, peers: &[LanDiscoveryPeer]) {
    let _ = app.emit(
        EVENT_PEERS,
        LanDiscoveryPeersEvent {
            peers: peers.to_vec(),
        },
    );
}

fn local_ipv4_addrs() -> Vec<IpAddr> {
    let mut out = Vec::new();
    // 无额外 crate：通过 UDP connect 推断主出口地址
    if let Ok(sock) = std::net::UdpSocket::bind("0.0.0.0:0") {
        let _ = sock.connect("8.8.8.8:80");
        if let Ok(local) = sock.local_addr() {
            out.push(local.ip());
        }
    }
    out.push(IpAddr::V4(Ipv4Addr::LOCALHOST));
    out
}

/// 收集广播目标：全局广播 + 本机推断网段的定向广播（/24 近似）。
fn broadcast_targets() -> Vec<Ipv4Addr> {
    let mut targets = vec![Ipv4Addr::BROADCAST];
    for ip in local_ipv4_addrs() {
        if let IpAddr::V4(v4) = ip {
            if !v4.is_loopback() && !v4.is_unspecified() {
                let octets = v4.octets();
                targets.push(Ipv4Addr::new(octets[0], octets[1], octets[2], 255));
            }
        }
    }
    targets.sort();
    targets.dedup();
    targets
}

async fn bind_responder_socket() -> Result<(UdpSocket, u16), String> {
    let mut errors = Vec::new();
    for port in CANDIDATE_PORTS {
        let addr = SocketAddr::from((Ipv4Addr::UNSPECIFIED, port));
        match UdpSocket::bind(addr).await {
            Ok(sock) => {
                if let Err(e) = sock.set_broadcast(true) {
                    tracing::warn!("设置 UDP broadcast 失败: {e}");
                }
                return Ok((sock, port));
            }
            Err(e) => errors.push(format!("{port}: {e}")),
        }
    }
    Err(format!(
        "无法绑定发现端口 {}: {}",
        CANDIDATE_PORTS
            .iter()
            .map(|p| p.to_string())
            .collect::<Vec<_>>()
            .join("/"),
        errors.join("; ")
    ))
}

async fn run_responder(
    app: AppHandle,
    responder: Arc<Mutex<ResponderState>>,
) -> Result<(), String> {
    let identity = auth_device_identity()
        .await
        .map_err(|e| e.to_string())?;
    let version = env!("CARGO_PKG_VERSION").to_string();
    let announce = protocol::encode_announce(
        &identity.device_id,
        &identity.device_name,
        &version,
        &identity.os_type,
    )
    .map_err(|e| e.to_string())?;

    let (sock, _port) = match bind_responder_socket().await {
        Ok(v) => {
            let mut g = responder.lock().await;
            g.ok = true;
            g.listen_port = Some(v.1);
            g.error = None;
            tracing::info!(port = v.1, "局域网发现 responder 已监听");
            v
        }
        Err(e) => {
            let mut g = responder.lock().await;
            g.ok = false;
            g.listen_port = None;
            g.error = Some(e.clone());
            return Err(e);
        }
    };

    let sock = Arc::new(sock);
    let mut buf = vec![0u8; UDP_RECV_BUF];
    loop {
        let (n, src) = sock
            .recv_from(&mut buf)
            .await
            .map_err(|e| e.to_string())?;
        let Some(msg) = protocol::parse_message(&buf[..n]) else {
            continue;
        };
        match msg {
            DiscoveryMessage::Probe { id, .. } => {
                if id == identity.device_id {
                    continue;
                }
                if let Err(e) = sock.send_to(&announce, src).await {
                    tracing::debug!("发送 announce 失败: {e}");
                }
            }
            DiscoveryMessage::Announce { .. } => {}
            DiscoveryMessage::SharePanel {
                id,
                panel_json,
                ..
            } => {
                if id == identity.device_id {
                    continue;
                }
                let _ = app.emit(
                    EVENT_SHARE_OFFER,
                    super::LanDiscoveryShareOfferEvent {
                        from_id: id,
                        from_ip: src.ip().to_string(),
                        panel_json,
                    },
                );
            }
        }
    }
}

async fn run_scanner(
    app: AppHandle,
    scanner: Arc<Mutex<ScannerInner>>,
    stop: Arc<Notify>,
) -> Result<(), String> {
    let identity = auth_device_identity()
        .await
        .map_err(|e| e.to_string())?;
    let local_ips = local_ipv4_addrs();
    let probe = protocol::encode_probe(&identity.device_id).map_err(|e| e.to_string())?;

    let sock = UdpSocket::bind(SocketAddr::from((Ipv4Addr::UNSPECIFIED, 0)))
        .await
        .map_err(|e| e.to_string())?;
    sock.set_broadcast(true).map_err(|e| e.to_string())?;
    let sock = Arc::new(sock);

    let recv_sock = sock.clone();
    let scanner_recv = scanner.clone();
    let app_recv = app.clone();
    let local_id = identity.device_id.clone();
    let stop_recv = stop.clone();
    let recv_task = tauri::async_runtime::spawn(async move {
        let mut buf = vec![0u8; UDP_RECV_BUF];
        loop {
            tokio::select! {
                _ = stop_recv.notified() => break,
                result = recv_sock.recv_from(&mut buf) => {
                    let Ok((n, src)) = result else { continue };
                    let Some(msg) = protocol::parse_message(&buf[..n]) else { continue };
                    match msg {
                        DiscoveryMessage::Announce { id, name, version, os, .. } => {
                            if should_ignore_announce(&local_id, &local_ips, &id, src.ip()) {
                                continue;
                            }
                            let peer = PeerRecord {
                                id: id.clone(),
                                name,
                                ip: src.ip().to_string(),
                                version,
                                os,
                                last_seen_ms: now_ms(),
                            };
                            let mut g = scanner_recv.lock().await;
                            upsert_peer(&mut g.peers, peer);
                            let dto = peers_to_dto(&g.peers);
                            drop(g);
                            emit_peers(&app_recv, &dto);
                        }
                        DiscoveryMessage::SharePanel { id, panel_json, .. } => {
                            if id == local_id {
                                continue;
                            }
                            let _ = app_recv.emit(
                                EVENT_SHARE_OFFER,
                                super::LanDiscoveryShareOfferEvent {
                                    from_id: id,
                                    from_ip: src.ip().to_string(),
                                    panel_json,
                                },
                            );
                        }
                        DiscoveryMessage::Probe { .. } => {}
                    }
                }
            }
        }
    });

    let mut tick = interval(Duration::from_millis(PROBE_INTERVAL_MS));
    loop {
        tokio::select! {
            _ = stop.notified() => break,
            _ = tick.tick() => {
                // 过期清理
                {
                    let mut g = scanner.lock().await;
                    let changed = prune_stale(&mut g.peers, now_ms(), PEER_TTL_MS);
                    if changed {
                        let dto = peers_to_dto(&g.peers);
                        drop(g);
                        emit_peers(&app, &dto);
                    }
                }
                send_probes(&sock, &probe).await;
            }
        }
    }

    recv_task.abort();
    Ok(())
}

async fn send_probes(sock: &UdpSocket, probe: &[u8]) {
    for ip in broadcast_targets() {
        for port in CANDIDATE_PORTS {
            let addr = SocketAddr::from((ip, port));
            if let Err(e) = sock.send_to(probe, addr).await {
                tracing::debug!(%addr, "发送 probe 失败: {e}");
            }
        }
    }
}
