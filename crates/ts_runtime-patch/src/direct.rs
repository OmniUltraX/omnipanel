//! Direct UDP transport actor.
//!
//! This is an involved wrapper around a [`UdpSocket`] to make it function as an underlay transport.
//! Technically, it's actually two sockets, an IPv4 and an IPv6 (if available). Both are bound
//! to the unspecified address for their network type (`0.0.0.0` or `::`), and the socket to use to
//! send a packet is determined by its address type.
//!
//! The primary function of this actor is just to bridge UDP tx/rx to its dataplane queues. But
//! also, because it's the actor that holds the UDP socket(s) (and hence knows the ports each is
//! bound on), it's additionally responsible for reporting this node's UDP endpoints on the bus (the
//! control actor reports these to control, and the path discovery actor uses this to set its
//! `CallMeMaybe` endpoints). It just aggregates the netmon and stun discovered addresses to
//! (combining the netmon addresses with the local port) to make this report.
//!
//! No disco concerns are directly handled by this actor; these are done in [`disco`][crate::disco]
//! (incoming `CallMeMaybe` and `Ping`s from peers) and [`path_discoverer`][crate::path_discoverer]
//! (PD for outgoing traffic). Other parts of the system can trigger underlay packets to be sent
//! by this actor directly via [`dataplane::SendUnderlay`][crate::dataplane::SendUnderlay] (only to
//! be used when absolutely necessary, i.e. disco).

use std::{
    borrow::Borrow,
    collections::HashMap,
    io,
    io::ErrorKind,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    sync::{Arc, Mutex},
    time::Duration,
};

use bytes::BytesMut;
use futures::Stream;
use futures_util::StreamExt;
use itertools::Itertools;
use kameo::{
    actor::ActorRef,
    message::{Context, Message, StreamMessage},
};
use stun_rs::attributes::stun::XorMappedAddress;
use tokio::net::UdpSocket;
use tokio::sync::oneshot;
use tokio_stream::wrappers::UnboundedReceiverStream;
use ts_bart::RoutingTable;
use ts_control::{Endpoint, EndpointType};
use ts_dataplane::async_tokio::{FromUnderlay, ToUnderlay, Tx};
use ts_packet::PacketMut;
use ts_transport::{DynEndpoint, UnderlayTransportId};

use crate::{
    dataplane::DataplaneActor,
    disco::SendDisco,
    env::Env,
    netmon,
    peer_tracker::{PeerDb, PeerState},
    stunner::StunServers,
};

pub struct DirectActor {
    transport_id: UnderlayTransportId,

    sock4: Arc<UdpSocket>,
    sock6: Option<Arc<UdpSocket>>,

    tx: Tx<FromUnderlay>,

    peers: Arc<PeerDb>,

    stun_addr: Option<SocketAddr>,
    stun_servers: Vec<SocketAddr>,
    stun_wait: Arc<Mutex<HashMap<[u8; 12], oneshot::Sender<SocketAddr>>>>,
    probe_running: bool,
    pinned_ifindex: Option<u32>,
    addrs_v4: Vec<Endpoint>,
    addrs_v6: Vec<Endpoint>,

    reachable: ts_bart::Table<()>,

    env: Env,
}

#[derive(Clone, Debug)]
pub struct NewEndpoints(pub Arc<[Endpoint]>);

struct UdpRx(io::Result<HashMap<SocketAddr, Vec<PacketMut>>>);
struct UdpTx(ToUnderlay);

impl DirectActor {
    async fn publish_endpoints(&self) -> Result<(), crate::Error> {
        self.env
            .publish(NewEndpoints(
                self.addrs_v4
                    .iter()
                    .copied()
                    .chain(self.addrs_v6.iter().copied())
                    .chain(self.stun_addr.into_iter().map(|addr| Endpoint {
                        endpoint: addr,
                        ty: EndpointType::Stun,
                    }))
                    .collect(),
            ))
            .await
    }

    fn sock(&self, ipv4: bool) -> Option<&UdpSocket> {
        if ipv4 {
            Some(self.sock4.as_ref())
        } else {
            self.sock6.as_deref()
        }
    }
}

impl kameo::Actor for DirectActor {
    type Args = Env;
    type Error = crate::Error;

    async fn on_start(env: Self::Args, slf: ActorRef<Self>) -> Result<Self, Self::Error> {
        let (id, rx, tx) = env
            .ask::<DataplaneActor, _>(None, crate::dataplane::NewUnderlayTransport, true)
            .await?;

        let sock4 = UdpSocket::bind("0.0.0.0:0").await.unwrap();
        ignore_udp_connreset(&sock4);
        let sock4 = Arc::new(sock4);
        tracing::debug!(transport_id = ?id, local_addr = %sock4.local_addr().unwrap(), "direct udp4 socket bound");

        let stun_wait = Arc::new(Mutex::new(HashMap::new()));
        slf.attach_stream(udp_rx(sock4.clone(), stun_wait.clone()).boxed(), (), ());

        let sock6 = UdpSocket::bind("[::]:0").await.ok().map(|sock| {
            ignore_udp_connreset(&sock);
            Arc::new(sock)
        });
        if let Some(sock6) = sock6.as_ref() {
            tracing::debug!(transport_id = ?id, local_addr = %sock6.local_addr().unwrap(), "direct udp6 socket bound");
            slf.attach_stream(udp_rx(sock6.clone(), stun_wait.clone()).boxed(), (), ());
        } else {
            tracing::debug!("could not bind ipv6 direct");
        }

        slf.attach_stream(UnboundedReceiverStream::new(rx).map(UdpTx), (), ());

        env.subscribe::<Arc<PeerState>>(&slf).await?;
        env.subscribe::<StunServers>(&slf).await?;
        env.subscribe::<Arc<netmon::State>>(&slf).await?;
        env.subscribe::<SendDisco>(&slf).await?;

        env.register(None, &slf).await?;

        Ok(Self {
            transport_id: id,
            sock4,
            sock6,
            env,
            peers: Default::default(),
            stun_addr: None,
            stun_servers: vec![],
            stun_wait,
            probe_running: false,
            pinned_ifindex: None,
            addrs_v4: vec![],
            addrs_v6: vec![],
            reachable: Default::default(),
            tx,
        })
    }
}

fn udp_rx(
    sock: impl Borrow<UdpSocket>,
    stun_wait: Arc<Mutex<HashMap<[u8; 12], oneshot::Sender<SocketAddr>>>>,
) -> impl Stream<Item = UdpRx> {
    // Required capacity to receive a UDP datagram. Any smaller and data may technically be dropped
    // with a large MTU or a large fragmented packet. We keep the buffer capacity topped off to this
    // size each time we try a receive in the loop below.
    const REQUIRED_CAPACITY: usize = u16::MAX as _;

    let buf = BytesMut::zeroed(REQUIRED_CAPACITY);

    futures_util::stream::try_unfold(
        (sock, buf, stun_wait),
        async |(sock, mut buf, stun_wait)| {
            let mut v = vec![];

            // Batch receive: wait until any packets are available from the socket, then try
            // to read as many as possible until we exhaust the underlying buffer and see a wouldblock.
            {
                let sock = sock.borrow();
                sock.readable().await?;

                loop {
                    if buf.len() < REQUIRED_CAPACITY {
                        buf.resize(REQUIRED_CAPACITY, 0);
                    }

                    let (n, who) = match sock.try_recv_from(&mut buf) {
                        Ok((n, who)) => (n, who),
                        Err(e) if e.kind() == ErrorKind::WouldBlock => {
                            break;
                        }
                        // Windows turns an ICMP unreachable from an earlier send into
                        // WSAECONNRESET on the next receive. The socket is still open;
                        // ending the stream here kills hole-punching and leaves traffic on DERP.
                        Err(e) if e.kind() == ErrorKind::ConnectionReset => {
                            break;
                        }
                        Err(e) => return Err(e),
                    };

                    if take_stun_reply(&stun_wait, &buf[..n]) {
                        continue;
                    }

                    let pkt_buf = buf.split_to(n);
                    v.push((who, PacketMut::from(pkt_buf)));
                }
            };

            tracing::trace!(n_pkts = v.len(), "udp rx batch");

            Ok(Some((
                v.into_iter().into_group_map(),
                (sock, buf, stun_wait),
            )))
        },
    )
    .map(UdpRx)
}

impl Message<Arc<PeerState>> for DirectActor {
    type Reply = ();

    async fn handle(&mut self, msg: Arc<PeerState>, _ctx: &mut Context<Self, Self::Reply>) {
        self.peers = msg.peers.clone();
    }
}

impl Message<SendDisco> for DirectActor {
    type Reply = ();

    async fn handle(
        &mut self,
        SendDisco { ep, buf }: SendDisco,
        _ctx: &mut Context<Self, Self::Reply>,
    ) {
        let Some(ep) = ep.as_udp() else {
            return;
        };

        let Some(sock) = self.sock(ep.is_ipv4()) else {
            tracing::trace!(?ep, "can't send disco, no ipv6");
            return;
        };

        if let Err(e) = sock.send_to(&buf, ep).await {
            tracing::warn!(?ep, error = %e, ?sock, "sending disco msg");
        } else {
            tracing::trace!(?ep, "sent disco msg");
        }
    }
}

const CGNAT_RANGE: ipnet::Ipv4Net = ipnet::Ipv4Net::new_assert(Ipv4Addr::new(100, 64, 0, 0), 10);
const TS_IP6_ULA: ipnet::Ipv6Net =
    ipnet::Ipv6Net::new_assert(Ipv6Addr::new(0xfd7a, 0x115c, 0xa1e0, 0, 0, 0, 0, 0), 48);

fn tunnel_name(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    [
        "mihomo",
        "clash",
        "wintun",
        "wireguard",
        "tailscale",
        "zerotier",
        "tun",
        "vpn",
        "sing-box",
        "singbox",
        "vethernet",
        "hyper-v",
        "vmware",
        "virtualbox",
        "wsl",
        "docker",
        "npcap",
        "loopback",
        "bluetooth",
    ]
    .iter()
    .any(|needle| n.contains(needle))
}

fn iface_rank(name: &str) -> u8 {
    let n = name.to_ascii_lowercase();
    if n.contains("wlan") || n.contains("wi-fi") || n.contains("wifi") || n.contains("无线") {
        0
    } else if n.contains("ethernet") || n.contains("以太网") {
        1
    } else {
        2
    }
}

fn physical_ifindex(state: &netmon::State) -> Option<u32> {
    let mut best: Option<(u8, u32)> = None;
    for (id, iface) in &state.interfaces {
        if !iface.up || tunnel_name(&iface.name) {
            continue;
        }
        let has_v4 = state.addrs.get(id).is_some_and(|addrs| {
            addrs.keys().any(|net| {
                matches!(net.addr(), IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() && !v4.is_unspecified())
            })
        });
        if !has_v4 {
            continue;
        }
        let Some(index) = luid_to_index(id.value()) else {
            continue;
        };
        let rank = iface_rank(&iface.name);
        if best.is_none_or(|(prev, _)| rank < prev) {
            best = Some((rank, index));
        }
    }
    best.map(|(_, index)| index)
}

fn pin_v4_to_physical(sock: &UdpSocket, state: &netmon::State) -> Option<u32> {
    let index = physical_ifindex(state)?;
    set_unicast_if(sock, index).then_some(index)
}

#[cfg(windows)]
fn luid_to_index(luid: u64) -> Option<u32> {
    #[link(name = "iphlpapi")]
    unsafe extern "system" {
        fn ConvertInterfaceLuidToIndex(luid: *const u64, index: *mut u32) -> u32;
    }
    let mut index = 0u32;
    let rc = unsafe { ConvertInterfaceLuidToIndex(&luid, &mut index) };
    (rc == 0 && index != 0).then_some(index)
}

#[cfg(not(windows))]
fn luid_to_index(_luid: u64) -> Option<u32> {
    None
}

#[cfg(windows)]
fn set_unicast_if(sock: &UdpSocket, index: u32) -> bool {
    use std::os::windows::io::AsRawSocket;

    #[link(name = "ws2_32")]
    unsafe extern "system" {
        fn setsockopt(s: usize, level: i32, opt: i32, val: *const u8, len: i32) -> i32;
    }
    let be = index.to_be_bytes();
    let rc = unsafe { setsockopt(sock.as_raw_socket() as usize, 0, 31, be.as_ptr(), 4) };
    if rc != 0 {
        tracing::error!(rc, index, "绑定物理网卡失败");
        false
    } else {
        true
    }
}

#[cfg(not(windows))]
fn set_unicast_if(_sock: &UdpSocket, _index: u32) -> bool {
    false
}

fn is_tailscale(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => CGNAT_RANGE.contains(v4),
        IpAddr::V6(v6) => TS_IP6_ULA.contains(v6),
    }
}

impl Message<Arc<netmon::State>> for DirectActor {
    type Reply = ();

    async fn handle(&mut self, msg: Arc<netmon::State>, ctx: &mut Context<Self, Self::Reply>) {
        self.addrs_v4.clear();
        self.addrs_v6.clear();
        self.reachable.clear();

        if let Some(index) = pin_v4_to_physical(&self.sock4, &msg)
            && self.pinned_ifindex != Some(index)
        {
            self.pinned_ifindex = Some(index);
            // The previous mapping was learned on the default route, which may be a
            // userspace proxy. Drop it and probe again from the physical NIC.
            self.stun_addr = None;
            self.probe_running = false;
            tracing::error!(index, "组网 UDP 改走物理网卡");
            self.kick_stun(ctx.actor_ref().clone());
        }

        for (id, addr) in msg.up_addrs() {
            if msg
                .interfaces
                .get(&id)
                .is_some_and(|iface| tunnel_name(&iface.name))
            {
                continue;
            }
            let ip = addr.addr();

            let invalid = match ip {
                IpAddr::V4(v4) => {
                    v4.is_broadcast()
                        || v4.is_loopback()
                        || v4.is_unspecified()
                        || v4.is_documentation()
                        || v4.is_multicast()
                }
                IpAddr::V6(v6) => v6.is_multicast() || v6.is_unspecified() || v6.is_loopback(),
            };

            if invalid {
                continue;
            }

            // NOTE(npry): this might be overly defensive -- while it probably makes sense to avoid
            // nesting our traffic through a VPN tun device if possible, this does cut off a
            // potential connectivity path, and we don't actually know for sure that it's tailscale.
            // Notionally, it's better to connect through another tailnet (via tailscaled) or a
            // 3rd-party VPN than not at all, but it may also make debugging horrible and this is
            // likely an edge case, so skip for the time being.
            if is_tailscale(&ip) {
                continue;
            }

            let Some(port) = self
                .sock(ip.is_ipv4())
                .map(|x| x.local_addr().unwrap().port())
            else {
                continue;
            };

            let sockaddr = SocketAddr::new(ip, port);

            let ty = match ip {
                IpAddr::V4(x) => {
                    if x.is_link_local() || x.is_private() {
                        EndpointType::Local
                    } else {
                        EndpointType::Unknown
                    }
                }
                IpAddr::V6(x) => {
                    if x.is_unique_local() || x.is_unicast_link_local() {
                        EndpointType::Local
                    } else {
                        EndpointType::Unknown
                    }
                }
            };

            let ep = Endpoint {
                ty,
                endpoint: sockaddr,
            };

            if ep.endpoint.is_ipv4() {
                self.addrs_v4.push(ep);
            } else if self.sock6.is_some() {
                self.addrs_v6.push(ep);
            }

            self.reachable.insert(addr, ());
        }

        self.publish_endpoints().await.unwrap()
    }
}

#[derive(Clone, Copy)]
struct StunMapped(SocketAddr);

#[derive(Clone, Copy)]
struct ProbeFinished;

impl Message<StunServers> for DirectActor {
    type Reply = ();

    async fn handle(
        &mut self,
        StunServers(servers): StunServers,
        ctx: &mut Context<Self, Self::Reply>,
    ) {
        self.stun_servers = servers.to_vec();
        self.kick_stun(ctx.actor_ref().clone());
    }
}

impl DirectActor {
    fn kick_stun(&mut self, slf: ActorRef<Self>) {
        if self.probe_running || self.stun_servers.is_empty() {
            return;
        }
        self.probe_running = true;
        let sock4 = self.sock4.clone();
        let sock6 = self.sock6.clone();
        let wait = self.stun_wait.clone();
        let servers = self.stun_servers.clone();
        tokio::spawn(async move {
            let mut tried = 0u32;
            let mut hit = false;
            for server in servers.into_iter().take(8) {
                let sock = if server.is_ipv4() {
                    Some(sock4.clone())
                } else {
                    sock6.clone()
                };
                let Some(sock) = sock else {
                    continue;
                };
                tried += 1;
                if let Some(addr) = probe_mapped(&sock, server, &wait).await {
                    hit = true;
                    let _ = slf.tell(StunMapped(addr)).await;
                    break;
                }
            }
            if !hit {
                tracing::error!(
                    tried,
                    seen = STUN_SEEN.swap(0, std::sync::atomic::Ordering::Relaxed),
                    matched = STUN_MATCHED.swap(0, std::sync::atomic::Ordering::Relaxed),
                    "组网 STUN 没有回包"
                );
            } else {
                STUN_SEEN.swap(0, std::sync::atomic::Ordering::Relaxed);
                STUN_MATCHED.swap(0, std::sync::atomic::Ordering::Relaxed);
            }
            let _ = slf.tell(ProbeFinished).await;
        });
    }
}

impl Message<StunMapped> for DirectActor {
    type Reply = ();

    async fn handle(
        &mut self,
        StunMapped(addr): StunMapped,
        _ctx: &mut Context<Self, Self::Reply>,
    ) {
        if self.stun_addr == Some(addr) {
            return;
        }
        self.stun_addr = Some(addr);
        tracing::error!("组网已学到公网映射");
        self.publish_endpoints().await.unwrap();
    }
}

impl Message<ProbeFinished> for DirectActor {
    type Reply = ();

    async fn handle(&mut self, _: ProbeFinished, _ctx: &mut Context<Self, Self::Reply>) {
        self.probe_running = false;
    }
}

impl Message<StreamMessage<UdpTx, (), ()>> for DirectActor {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: StreamMessage<UdpTx, (), ()>,
        ctx: &mut Context<Self, Self::Reply>,
    ) {
        let (ep_info, pkts) = match msg {
            StreamMessage::Next(msg) => msg.0,
            StreamMessage::Finished(_) => {
                tracing::warn!("udp tx stream shut down, closing");
                ctx.stop();
                return;
            }
            _ => return,
        };

        if pkts.is_empty() {
            return;
        }

        let Some(addr) = ep_info.as_udp() else {
            tracing::warn!(?ep_info, "invalid endpoint info for udp direct");
            return;
        };

        let Some(sock) = self.sock(addr.is_ipv4()) else {
            tracing::debug!("trying to send ipv6 traffic without ipv6 connectivity");
            return;
        };

        tracing::trace!(?ep_info, selected_addr = %addr, n_pkts = pkts.len(), "udp tx batch");

        for pkt in pkts {
            if let Err(e) = sock.send_to(&pkt, addr).await {
                tracing::error!(error = %e, "sending packet");
            }
        }
    }
}

impl Message<StreamMessage<UdpRx, (), ()>> for DirectActor {
    type Reply = ();

    async fn handle(
        &mut self,
        msg: StreamMessage<UdpRx, (), ()>,
        _ctx: &mut Context<Self, Self::Reply>,
    ) {
        let msg = match msg {
            StreamMessage::Next(msg) => msg.0,
            StreamMessage::Finished(_) => {
                tracing::warn!("udp rx stream shut down, closing");
                return;
            }
            _ => return,
        };

        const ACCEPTABLE_ERR: &[io::ErrorKind] = {
            use io::ErrorKind::*;
            &[
                NetworkDown,
                NetworkUnreachable,
                HostUnreachable,
                TimedOut,
                ConnectionReset,
            ]
        };

        match msg {
            Ok(mp) => {
                for (ep, pkts) in mp {
                    tracing::trace!(who = %ep, n_pkts = pkts.len(), "udp rx batch (by sender)");

                    self.tx
                        .send((self.transport_id, DynEndpoint::udp(ep), pkts))
                        .unwrap();
                }
            }
            Err(e) if ACCEPTABLE_ERR.contains(&e.kind()) => {
                tracing::error!(error = %e, "udp receive error");
            }
            Err(e) => {
                tracing::error!(error = %e, "unrecoverable error, die");
                panic!()
            }
        }
    }
}

/// Windows reports ICMP unreachable as WSAECONNRESET on the next UDP read and
/// then keeps the socket in that state. Direct discovery dies if that error is fatal.
#[cfg(windows)]
fn ignore_udp_connreset(sock: &UdpSocket) {
    use std::os::windows::io::AsRawSocket;

    const SIO_UDP_CONNRESET: u32 = 0x9800_000C;
    #[link(name = "ws2_32")]
    unsafe extern "system" {
        fn WSAIoctl(
            s: usize,
            code: u32,
            in_buf: *const u8,
            in_len: u32,
            out_buf: *mut u8,
            out_len: u32,
            returned: *mut u32,
            overlapped: *mut core::ffi::c_void,
            completion: *mut core::ffi::c_void,
        ) -> i32;
    }

    let flag = 0u32.to_ne_bytes();
    let mut returned = 0u32;
    let rc = unsafe {
        WSAIoctl(
            sock.as_raw_socket() as usize,
            SIO_UDP_CONNRESET,
            flag.as_ptr(),
            4,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        tracing::error!(rc, error = %err, "关闭 UDP 连接重置失败");
    }
}

#[cfg(not(windows))]
fn ignore_udp_connreset(_sock: &UdpSocket) {}

static STUN_SEEN: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
static STUN_MATCHED: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

fn take_stun_reply(
    wait: &Mutex<HashMap<[u8; 12], oneshot::Sender<SocketAddr>>>,
    packet: &[u8],
) -> bool {
    if packet.len() >= 8 && packet[4..8] == [0x21, 0x12, 0xA4, 0x42] {
        STUN_SEEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }
    let Some((txn, mapped)) = stun_mapped(packet) else {
        return false;
    };
    if let Some(tx) = wait
        .lock()
        .unwrap_or_else(|err| err.into_inner())
        .remove(&txn)
    {
        STUN_MATCHED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let _ = tx.send(mapped);
    }
    true
}

fn stun_mapped(packet: &[u8]) -> Option<([u8; 12], SocketAddr)> {
    if packet.len() < 20 || packet[4..8] != [0x21, 0x12, 0xA4, 0x42] {
        return None;
    }
    let (msg, _) = stun_rs::MessageDecoderBuilder::default()
        .build()
        .decode(packet)
        .ok()?;
    let mapped = msg
        .get::<XorMappedAddress>()?
        .as_xor_mapped_address()
        .ok()?;
    let txn = packet[8..20].try_into().ok()?;
    Some((txn, *mapped.socket_address()))
}

async fn probe_mapped(
    sock: &UdpSocket,
    server: SocketAddr,
    wait: &Mutex<HashMap<[u8; 12], oneshot::Sender<SocketAddr>>>,
) -> Option<SocketAddr> {
    // Bare binding request. Servers answer this; a fingerprint attribute is optional
    // and some ignore a request when that checksum does not match.
    let txn: [u8; 12] = rand::random();
    let mut buf = [0u8; 20];
    buf[1] = 0x01;
    buf[4] = 0x21;
    buf[5] = 0x12;
    buf[6] = 0xA4;
    buf[7] = 0x42;
    buf[8..20].copy_from_slice(&txn);
    let (tx, rx) = oneshot::channel();
    wait.lock()
        .unwrap_or_else(|err| err.into_inner())
        .insert(txn, tx);
    if sock.send_to(&buf, server).await.is_err() {
        wait.lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(&txn);
        return None;
    }
    match tokio::time::timeout(Duration::from_secs(3), rx).await {
        Ok(Ok(addr)) => Some(addr),
        _ => {
            wait.lock()
                .unwrap_or_else(|err| err.into_inner())
                .remove(&txn);
            None
        }
    }
}
