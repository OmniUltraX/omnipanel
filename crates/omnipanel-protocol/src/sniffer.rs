use omnipanel_error::{OmniError, OmniResult};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// 网络接口信息。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
pub struct NetworkInterface {
    pub name: String,
    pub description: String,
    pub addresses: Vec<String>,
}

/// 捕获的数据包。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SnifferPacket {
    #[specta(type = f64)]
    pub id: u64,
    pub timestamp: String,
    pub src_ip: String,
    pub dst_ip: String,
    pub protocol: String,
    pub src_port: Option<u16>,
    pub dst_port: Option<u16>,
    #[specta(type = f64)]
    pub length: u32,
    pub payload_hex: String,
}

/// 抓包会话。
pub struct SnifferSession {
    pub interface: String,
    pub filter: String,
    pub packets: Vec<SnifferPacket>,
    pub running: bool,
    pub started_at: String,
}

impl SnifferSession {
    pub fn new(interface: &str, filter: &str) -> Self {
        Self {
            interface: interface.to_string(),
            filter: filter.to_string(),
            packets: Vec::new(),
            running: true,
            started_at: chrono_now(),
        }
    }

    pub fn add_packet(&mut self, pkt: SnifferPacket) {
        self.packets.push(pkt);
        if self.packets.len() > 10000 {
            self.packets.remove(0);
        }
    }

    pub fn stop(&mut self) {
        self.running = false;
    }
}

/// 抓包统计信息。
#[derive(Debug, Clone, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub capture_id: String,
    pub iface: String,
    pub filter: String,
    pub running: bool,
    #[specta(type = f64)]
    pub packet_count: usize,
    pub started_at: String,
}

pub type SnifferSessions = Arc<Mutex<HashMap<String, SnifferSession>>>;

/// 列出可用网络接口 (stub)。
pub async fn list_interfaces() -> Vec<NetworkInterface> {
    vec![
        NetworkInterface {
            name: "eth0".to_string(),
            description: "Ethernet Adapter".to_string(),
            addresses: vec!["192.168.1.100".to_string()],
        },
        NetworkInterface {
            name: "lo".to_string(),
            description: "Loopback".to_string(),
            addresses: vec!["127.0.0.1".to_string()],
        },
        NetworkInterface {
            name: "wlan0".to_string(),
            description: "Wi-Fi Adapter".to_string(),
            addresses: vec!["192.168.1.101".to_string()],
        },
    ]
}

/// 生成模拟数据包。
pub fn generate_sample_packets(count: usize) -> Vec<SnifferPacket> {
    let protocols = ["TCP", "UDP", "ICMP", "HTTP", "DNS", "TLS"];
    let ips = [
        "192.168.1.1",
        "192.168.1.100",
        "10.0.0.1",
        "172.16.0.5",
        "8.8.8.8",
    ];
    let ports = [80, 443, 22, 53, 8080, 3306, 5432];

    (0..count)
        .map(|i| {
            let proto = protocols[i % protocols.len()];
            let src_ip = ips[i % ips.len()].to_string();
            let dst_ip = ips[(i + 2) % ips.len()].to_string();
            let (src_port, dst_port) =
                if proto == "TCP" || proto == "UDP" || proto == "HTTP" || proto == "TLS" {
                    (
                        Some(ports[i % ports.len()]),
                        Some(ports[(i + 1) % ports.len()]),
                    )
                } else {
                    (None, None)
                };
            SnifferPacket {
                id: i as u64 + 1,
                timestamp: format!("12:{:02}:{:02}.{:03}", i / 60, i % 60, i * 7 % 1000),
                src_ip,
                dst_ip,
                protocol: proto.to_string(),
                src_port,
                dst_port,
                length: 64 + (i as u32 * 17 % 1400),
                payload_hex: format!(
                    "4500{:04x}0000400040{:02x}",
                    64 + i,
                    if proto == "TCP" { 6 } else { 17 }
                ),
            }
        })
        .collect()
}

fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() % 86400;
    let hours = secs / 3600;
    let minutes = (secs % 3600) / 60;
    let seconds = secs % 60;
    format!("{hours:02}:{minutes:02}:{seconds:02}")
}

/// 列出可用网络接口 (async wrapper)。

/// 开始抓包。
pub async fn start_capture(
    sessions: &SnifferSessions,
    interface: String,
    filter: String,
) -> OmniResult<String> {
    let id = format!(
        "sniffer-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    );
    let mut session = SnifferSession::new(&interface, &filter);
    // Add some sample packets for demo
    let samples = generate_sample_packets(50);
    for pkt in samples {
        session.add_packet(pkt);
    }
    sessions.lock().await.insert(id.clone(), session);
    Ok(id)
}

/// 停止抓包。
pub async fn stop_capture(sessions: &SnifferSessions, capture_id: &str) -> OmniResult<()> {
    let mut sessions = sessions.lock().await;
    let session = sessions
        .get_mut(capture_id)
        .ok_or_else(|| OmniError::not_found("Capture not found"))?;
    session.stop();
    Ok(())
}

/// 获取已捕获的数据包。
pub async fn get_packets(
    sessions: &SnifferSessions,
    capture_id: &str,
    limit: Option<usize>,
) -> OmniResult<Vec<SnifferPacket>> {
    let sessions = sessions.lock().await;
    let session = sessions
        .get(capture_id)
        .ok_or_else(|| OmniError::not_found("Capture not found"))?;
    let limit = limit.unwrap_or(100);
    let start = if session.packets.len() > limit {
        session.packets.len() - limit
    } else {
        0
    };
    Ok(session.packets[start..].to_vec())
}

/// 获取抓包统计。
pub async fn get_stats(
    sessions: &SnifferSessions,
    capture_id: &str,
) -> OmniResult<CaptureStats> {
    let sessions = sessions.lock().await;
    let session = sessions
        .get(capture_id)
        .ok_or_else(|| OmniError::not_found("Capture not found"))?;
    Ok(CaptureStats {
        capture_id: capture_id.to_string(),
        iface: session.interface.clone(),
        filter: session.filter.clone(),
        running: session.running,
        packet_count: session.packets.len(),
        started_at: session.started_at.clone(),
    })
}
